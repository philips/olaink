/**
 * HTTP long-poll transport using `fetch`.
 *
 * Server contract:
 *   POST /v1/hello { username, deviceType, client }
 *     -> 200 { ok, username, token } | 409 { ok:false, error:'username_taken' }
 *   POST /v1/send { username, token, msgs: Envelope[] }
 *     -> 200 { ok:true } | 401 | 404 (unknown/expired user)
 *   POST /v1/poll { username, token, waitMs }
 *     -> 200 { in: Envelope[] }  (held open server-side until events or waitMs)
 *
 * The transport registers (hello), retries with a fresh username on
 * `username_taken`, then runs a poll loop for inbound traffic and a queued
 * flush path for outbound traffic. Network failures back off exponentially
 * and re-register when the server has forgotten us (404) or the token is
 * rejected (401).
 */

import {
  type Envelope,
  makeEnvelope,
} from '../envelope.ts';
import {
  type HelloPayload,
  type WelcomePayload,
  ProtocolError,
  decodeEnvelopes,
  isWelcomePayload,
} from '../messages.ts';
import { generateUniqueUsername, isValidUsername } from '../username.ts';
import {
  type FetchLike,
  type Transport,
  type TransportState,
  type TransportStats,
  type Unsubscribe,
} from './types.ts';

export interface HttpPollOptions {
  baseUrl: string;
  /** Desired username; regenerated automatically if taken. */
  username: string;
  deviceType: number;
  client: string;
  fetchImpl?: FetchLike;
  /** How long the server should hold each poll (ms). */
  waitMs?: number;
  /** Overall timeout per HTTP request (ms). */
  requestTimeoutMs?: number;
  /** Initial reconnect backoff (ms); doubles up to maxBackoffMs. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Server forgetting us after this idle triggers re-registration. */
  now?: () => number;
}

const DEFAULT_WAIT_MS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 8_000;

interface HelloResponseBody {
  ok: boolean;
  username?: string;
  token?: string;
  error?: string;
}

interface PollResponseBody {
  in?: unknown;
}

export class HttpPollTransport implements Transport {
  readonly kind = 'http-poll' as const;

  private readonly opts: Required<Pick<HttpPollOptions, 'waitMs' | 'requestTimeoutMs' | 'initialBackoffMs' | 'maxBackoffMs'>> &
    HttpPollOptions;
  private readonly fetchImpl: FetchLike;

  private state: TransportState = 'idle';
  private registeredName: string | null = null;
  private token: string | null = null;
  private outbox: Envelope[] = [];
  private flushing = false;
  private started = false;
  private closed = false;
  private backoffMs: number;
  private pollAbort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private readonly messageCbs = new Set<(env: Envelope) => void>();
  private readonly stateCbs = new Set<(s: TransportState) => void>();
  private readonly counters: TransportStats = {
    sent: 0,
    received: 0,
    polls: 0,
    lastError: null,
  };

  constructor(opts: HttpPollOptions) {
    this.opts = {
      waitMs: opts.waitMs ?? DEFAULT_WAIT_MS,
      requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      initialBackoffMs: opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
      maxBackoffMs: opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      ...opts,
    };
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.backoffMs = this.opts.initialBackoffMs;
  }

  username(): string | null {
    return this.registeredName;
  }

  setUsername(username: string): void {
    // Only meaningful before registration completes.
    if (this.registeredName === null && this.token === null) {
      this.opts.username = username;
    }
  }

  stats(): TransportStats {
    return { ...this.counters };
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.register();
  }

  send(env: Envelope): void {
    if (this.closed) return;
    this.outbox.push(env);
    void this.flush();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pollAbort?.abort();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.setState('closed');
  }

  onMessage(cb: (env: Envelope) => void): Unsubscribe {
    this.messageCbs.add(cb);
    return () => this.messageCbs.delete(cb);
  }

  onStateChange(cb: (s: TransportState) => void): Unsubscribe {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }

  // -----------------------------------------------------------------------

  private setState(s: TransportState): void {
    if (this.state === s || this.closed) return;
    this.state = s;
    for (const cb of this.stateCbs) cb(s);
  }

  private scheduleBackoff(what: () => void): void {
    if (this.closed) return;
    this.setState('backoff');
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs);
    this.timer = setTimeout(what, delay);
  }

  private resetBackoff(): void {
    this.backoffMs = this.opts.initialBackoffMs;
  }

  private async request(
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; json: unknown } | null> {
    const controller = new AbortController();
    const handle = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let json: unknown = null;
      const text = await res.text();
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: res.status, json };
    } catch (err) {
      this.counters.lastError = (err as Error).message;
      return null;
    } finally {
      clearTimeout(handle);
    }
  }

  /** Register via /v1/hello; regenerate username on collision. */
  private async register(): Promise<void> {
    if (this.closed) return;
    this.setState('connecting');

    let candidate = this.opts.username;
    if (!isValidUsername(candidate)) {
      candidate = generateUniqueUsername([]);
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.closed) return;
      const payload: HelloPayload = {
        username: candidate,
        deviceType: this.opts.deviceType,
        client: this.opts.client,
      };
      const res = await this.request('/v1/hello', payload, 10_000);
      if (res === null) {
        this.scheduleBackoff(() => void this.register());
        return;
      }
      const body = res.json as HelloResponseBody | null;
      if (res.status === 200 && body?.ok === true && typeof body.token === 'string') {
        this.registeredName = body.username ?? candidate;
        this.token = body.token;
        this.resetBackoff();
        this.setState('connected');

        const welcome = makeEnvelope('server', 'welcome', {
          username: this.registeredName,
          token: this.token,
          serverTime: Date.now(),
          features: [],
        } satisfies WelcomePayload);
        for (const cb of this.messageCbs) cb(welcome);

        void this.pollLoop();
        void this.flush();
        return;
      }
      if (res.status === 409 && body?.error === 'username_taken') {
        candidate = generateUniqueUsername([candidate]);
        continue;
      }
      // Other errors: back off and retry registration later.
      this.scheduleBackoff(() => void this.register());
      return;
    }
    // Exhausted username attempts (practically impossible).
    this.scheduleBackoff(() => void this.register());
  }

  private async pollLoop(): Promise<void> {
    while (!this.closed && this.token !== null) {
      const res = await this.request(
        '/v1/poll',
        { username: this.registeredName, token: this.token, waitMs: this.opts.waitMs },
        this.opts.waitMs + 15_000,
      );
      if (this.closed) return;
      if (res === null) {
        this.pollAbort?.abort();
        this.scheduleBackoff(() => void this.recover());
        return;
      }
      if (res.status === 401 || res.status === 404) {
        // Server forgot us or rejected the token: re-register.
        this.token = null;
        this.scheduleBackoff(() => void this.register());
        return;
      }
      if (res.status !== 200) {
        this.scheduleBackoff(() => void this.recover());
        return;
      }
      this.counters.polls++;
      this.resetBackoff();
      if (this.state !== 'connected') this.setState('connected');

      const body = res.json as PollResponseBody | null;
      const inbound = body?.in;
      if (Array.isArray(inbound)) {
        for (const raw of inbound) {
          try {
            const envs = decodeEnvelopes(JSON.stringify([raw]));
            for (const env of envs) {
              this.counters.received++;
              for (const cb of this.messageCbs) cb(env);
            }
          } catch (err) {
            if (err instanceof ProtocolError) continue; // skip malformed
            throw err;
          }
        }
      }
    }
  }

  /** Re-enter the poll loop (assumes we are registered). */
  private async recover(): Promise<void> {
    if (this.closed) return;
    if (this.token === null) {
      await this.register();
      return;
    }
    await this.pollLoop();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.closed || this.token === null) return;
    if (this.outbox.length === 0) return;
    this.flushing = true;
    try {
      while (this.outbox.length > 0 && !this.closed && this.token !== null) {
        const batch = this.outbox;
        this.outbox = [];
        const res = await this.request(
          '/v1/send',
          { username: this.registeredName, token: this.token, msgs: batch },
          15_000,
        );
        if (res === null) {
          // Network error: put the batch back and retry after backoff.
          this.outbox = [...batch, ...this.outbox];
          this.scheduleBackoff(() => void this.flush());
          return;
        }
        if (res.status !== 200) {
          this.outbox = [...batch, ...this.outbox];
          if (res.status === 401 || res.status === 404) {
            this.token = null;
            this.scheduleBackoff(() => void this.register());
          } else {
            this.scheduleBackoff(() => void this.flush());
          }
          return;
        }
        this.counters.sent += batch.length;
      }
    } finally {
      this.flushing = false;
    }
  }
}
