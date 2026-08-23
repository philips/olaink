/**
 * User + session registry with long-poll delivery queues.
 *
 * Semantics (v1):
 *  - Every real user owns a session named after themselves; they start as
 *    its sole member. Joining another user's session moves them there.
 *  - `echo` is a virtual participant: never has a UserRec, never expires,
 *    joins/leaves like any username.
 *  - Re-hello with an existing username replaces the token and keeps session
 *    membership (private-network convenience: quick reconnects keep identity).
 *  - Users expire after USER_TTL_MS without a poll; expiry removes them from
 *    their session and broadcasts the new session state.
 */

import { randomBytes } from 'node:crypto';
import type { Envelope } from '@wrtn/protocol';
import { RESERVED_NAMES } from '@wrtn/protocol';

export const ECHO = 'echo';
/** Server-side test bot: generates pages on demand (POST /v1/test/swaptest/page). */
export const SWAPTEST = 'swaptest';
export const USER_TTL_MS = 60_000;
export const SWEEP_INTERVAL_MS = 5_000;
/** Per-recipient cap on buffered page.send envelopes (oldest dropped). */
export const MAX_PAGE_MAILBOX = 50;

export interface SessionMember {
  username: string;
  virtual: boolean;
}

export interface Session {
  owner: string;
  members: Set<string>;
}

export class UserRec {
  username: string;
  token: string;
  deviceType: number;
  client: string;
  lastSeen: number;
  inbox: Envelope[] = [];
  waiter: {
    resolve: (batch: Envelope[]) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(username: string, token: string, deviceType: number, client: string, now: number) {
    this.username = username;
    this.token = token;
    this.deviceType = deviceType;
    this.client = client;
    this.lastSeen = now;
  }
}

export interface RegistryEvents {
  /**
   * Called when a user's session membership changes so the router can
   * broadcast session.state envelopes. Receives the session's members after
   * the change plus the user who caused it (may have just left).
   */
  onSessionChanged: (session: Session, actor: string) => void;
}

export interface RegistryOptions {
  /** Per-recipient page mailbox cap (test override). */
  maxPageMailbox?: number;
}

export class Registry {
  private readonly users = new Map<string, UserRec>();
  private readonly sessions = new Map<string, Session>();
  /**
   * Page mailbox, keyed by recipient username. Deliberately NOT on UserRec:
   * a page addressed to a user survives that user's TTL expiry / disconnect,
   * so they can pull it when they next connect (issue #2).
   */
  private readonly pageMailboxes = new Map<string, Envelope[]>();
  private readonly maxPageMailbox: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly events: RegistryEvents,
    private now: () => number = Date.now,
    opts: RegistryOptions = {},
  ) {
    this.maxPageMailbox = opts.maxPageMailbox ?? MAX_PAGE_MAILBOX;
  }

  // -- users -------------------------------------------------------------

  /** Register or re-register. Returns the record (fresh or refreshed). */
  hello(username: string, deviceType: number, client: string): UserRec {
    const existing = this.users.get(username);
    let rec: UserRec;
    if (existing) {
      // The old connection's pending long-poll is now stale (its token is
      // about to rotate). Settle it with whatever it already queued so it
      // can never swallow deliveries destined for the new connection.
      if (existing.waiter) {
        clearTimeout(existing.waiter.timer);
        const w = existing.waiter;
        existing.waiter = null;
        w.resolve(existing.inbox);
        existing.inbox = [];
      }
      existing.token = randomBytes(16).toString('hex');
      existing.deviceType = deviceType;
      existing.client = client;
      existing.lastSeen = this.now();
      rec = existing;
    } else {
      rec = new UserRec(username, randomBytes(16).toString('hex'), deviceType, client, this.now());
      this.users.set(username, rec);
      this.ensureSession(username);
    }
    // Pages buffered while they were offline come due on (re)connect.
    this.flushPageMailbox(username);
    return rec;
  }

  authenticate(username: string, token: string): UserRec | null {
    const rec = this.users.get(username);
    if (!rec || rec.token !== token) return null;
    rec.lastSeen = this.now();
    return rec;
  }

  getUser(username: string): UserRec | null {
    return this.users.get(username) ?? null;
  }

  isVirtual(username: string): boolean {
    return !this.users.has(username);
  }

  peers(): Array<{
    username: string;
    deviceType: number;
    client: string;
    lastSeen: number;
    idleMs: number;
    session: string[];
    inbox: number;
    pages: number;
  }> {
    const now = this.now();
    return [...this.users.values()].map((u) => ({
      username: u.username,
      deviceType: u.deviceType,
      client: u.client,
      lastSeen: u.lastSeen,
      idleMs: now - u.lastSeen,
      session: [...(this.sessions.get(u.username)?.members ?? [])],
      inbox: u.inbox.length,
      pages: this.pageMailboxSize(u.username),
    }));
  }

  get onlineUsernames(): string[] {
    return [...this.users.keys()];
  }

  dropUser(username: string): void {
    const rec = this.users.get(username);
    if (!rec) return;
    this.users.delete(username);
    this.leaveSession(username, { silent: false, resolo: false });
    if (rec.waiter) {
      clearTimeout(rec.waiter.timer);
      rec.waiter.resolve([]);
      rec.waiter = null;
    }
  }

  // -- sessions ----------------------------------------------------------

  private ensureSession(owner: string): Session {
    let s = this.sessions.get(owner);
    if (!s) {
      s = { owner, members: new Set([owner]) };
      this.sessions.set(owner, s);
    }
    return s;
  }

  sessionOf(username: string): Session | null {
    for (const s of this.sessions.values()) {
      if (s.members.has(username)) return s;
    }
    return null;
  }

  sessionState(s: Session): SessionMember[] {
    return [...s.members].map((m) => ({
      username: m,
      virtual: m === ECHO || !this.users.has(m),
    }));
  }

  joinSession(username: string, owner: string): Session {
    const target = this.ensureSession(owner);
    if (target.members.has(username)) return target;
    this.leaveSession(username, { silent: false, resolo: false });
    target.members.add(username);
    this.events.onSessionChanged(target, username);
    return target;
  }

  leaveSession(username: string, opts: { silent: boolean; resolo?: boolean }): void {
    const current = this.sessionOf(username);
    if (current) {
      current.members.delete(username);

      if (current.members.size === 0) {
        this.sessions.delete(current.owner);
        if (opts.silent === false) this.events.onSessionChanged(current, username);
      } else if (current.owner === username) {
        // Owner left with members remaining: promote the first real member.
        // If only virtual members remain (echo), the session dissolves.
        const heir = [...current.members].find((m) => this.users.has(m));
        this.sessions.delete(current.owner);
        if (heir === undefined) {
          current.members.clear();
        } else {
          current.owner = heir;
          this.sessions.set(heir, current);
        }
        if (opts.silent === false) this.events.onSessionChanged(current, username);
      } else {
        if (opts.silent === false) this.events.onSessionChanged(current, username);
      }
    }

    // Leaving returns a still-online user to their own solo session.
    if (opts.resolo !== false && this.users.has(username)) {
      const solo = this.ensureSession(username);
      if (opts.silent === false) this.events.onSessionChanged(solo, username);
    }
  }

  // -- page mailbox (issue #2) -------------------------------------------

  /**
   * Buffer a page.send for `to`. If `to` is online it is also delivered
   * immediately; the mailbox copy stays until acked or evicted by the cap.
   */
  queuePage(to: string, env: Envelope): void {
    let box = this.pageMailboxes.get(to);
    if (!box) {
      box = [];
      this.pageMailboxes.set(to, box);
    }
    box.push(env);
    if (box.length > this.maxPageMailbox) {
      box.splice(0, box.length - this.maxPageMailbox);
    }
    if (this.users.has(to)) this.deliver(to, env);
  }

  /** Hand the whole mailbox to a (re)connected user. */
  flushPageMailbox(username: string): void {
    const box = this.pageMailboxes.get(username);
    if (!box || box.length === 0) return;
    for (const env of box) this.deliver(username, env);
  }

  /** Remove acked page envelopes; returns how many were still buffered. */
  ackPages(username: string, ids: Iterable<string>): number {
    const box = this.pageMailboxes.get(username);
    if (!box) return 0;
    const idSet = new Set(ids);
    const before = box.length;
    for (let i = box.length - 1; i >= 0; i--) {
      if (idSet.has(box[i]!.id)) box.splice(i, 1);
    }
    if (box.length === 0) this.pageMailboxes.delete(username);
    return before - box.length;
  }

  pageMailboxSize(username: string): number {
    return this.pageMailboxes.get(username)?.length ?? 0;
  }

  // -- delivery ----------------------------------------------------------

  /** Queue an envelope for a user; flushes a waiting poll immediately. */
  deliver(username: string, env: Envelope): void {
    const rec = this.users.get(username);
    if (!rec) return;
    if (rec.waiter) {
      // Batch with anything already in the inbox (rare) then wake the poll.
      const batch = [...rec.inbox, env];
      rec.inbox = [];
      clearTimeout(rec.waiter.timer);
      const w = rec.waiter;
      rec.waiter = null;
      w.resolve(batch);
      return;
    }
    rec.inbox.push(env);
  }

  deliverMany(usernames: Iterable<string>, env: Envelope): void {
    for (const u of usernames) this.deliver(u, env);
  }

  /** Long-poll: returns queued envelopes, waiting up to waitMs for more. */
  async poll(username: string, waitMs: number): Promise<Envelope[]> {
    const rec = this.users.get(username);
    if (!rec) return [];
    if (rec.inbox.length > 0) {
      const batch = rec.inbox;
      rec.inbox = [];
      return batch;
    }
    if (waitMs <= 0) return [];
    // One outstanding waiter per user; a second concurrent poll gets [].
    if (rec.waiter) return [];
    return new Promise<Envelope[]>((resolve) => {
      const timer = setTimeout(() => {
        rec.waiter = null;
        const batch = rec.inbox;
        rec.inbox = [];
        resolve(batch);
      }, waitMs);
      rec.waiter = { resolve, timer };
    });
  }

  // -- expiry ------------------------------------------------------------

  startSweeper(): void {
    if (this.sweepTimer !== null) return;
    const timer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    // DOM lib types this as number; Node gives Timeout with unref.
    (timer as unknown as NodeJS.Timeout).unref?.();
    this.sweepTimer = timer;
  }

  stopSweeper(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  sweepExpired(): string[] {
    const cutoff = this.now() - USER_TTL_MS;
    const expired: string[] = [];
    for (const rec of this.users.values()) {
      if (rec.lastSeen < cutoff) expired.push(rec.username);
    }
    for (const name of expired) this.dropUser(name);
    return expired;
  }
}

export { RESERVED_NAMES };
