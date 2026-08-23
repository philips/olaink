import { describe, expect, it, vi } from 'vitest';
import { makeEnvelope } from '../envelope.ts';
import { HttpPollTransport } from './httpPoll.ts';

/**
 * In-memory fake of the server's HTTP surface for transport tests.
 * Models: /v1/hello, /v1/send, /v1/poll (with immediate or staged replies).
 */
class FakeServer {
  public readonly requests: { path: string; body: any }[] = [];
  public users = new Map<string, { token: string }>();
  public inbound: Map<string, string[]> = new Map(); // username -> queued wire msgs
  public failNext: 'network' | null = null;
  public helloStatus = 200;
  public takenNames = new Set<string>();

  fetch = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    this.requests.push({ path, body });

    if (this.failNext === 'network') {
      this.failNext = null;
      throw new Error('simulated network failure');
    }

    if (path === '/v1/hello') {
      if (this.takenNames.has(body.username) || this.users.has(body.username)) {
        return new Response(JSON.stringify({ ok: false, error: 'username_taken' }), {
          status: 409,
        });
      }
      const token = `tok-${body.username}`;
      this.users.set(body.username, { token });
      return new Response(JSON.stringify({ ok: true, username: body.username, token }), {
        status: 200,
      });
    }

    if (path === '/v1/send') {
      const user = this.users.get(body.username);
      if (!user || user.token !== body.token) {
        return new Response(JSON.stringify({ ok: false }), { status: 404 });
      }
      for (const msg of body.msgs as { from: string }[]) {
        this.enqueue(msg.from, msg);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (path === '/v1/poll') {
      const user = this.users.get(body.username);
      if (!user || user.token !== body.token) {
        return new Response(JSON.stringify({ in: [] }), { status: 404 });
      }
      // Yield through a macrotask so the transport's poll loop cannot starve
      // the event loop while tests drive it with setImmediate-based flushes.
      await new Promise((resolve) => setTimeout(resolve, 1));
      const pending = this.inbound.get(body.username) ?? [];
      this.inbound.set(body.username, []);
      return new Response(JSON.stringify({ in: pending }), { status: 200 });
    }

    return new Response('not found', { status: 404 });
  };

  /** Deliver an envelope object to a user's poll queue. */
  deliver(username: string, env: unknown): void {
    this.enqueue(username, env);
  }

  private enqueue(username: string, env: unknown): void {
    const q = this.inbound.get(username) ?? [];
    q.push(env as any);
    this.inbound.set(username, q);
  }
}

function flush(rounds = 10, msPerRound = 3): Promise<void> {
  // Settle async work that involves real timers (fake-server poll sleeps,
  // reconnect backoffs). Each round waits a few real milliseconds so pending
  // timers fire, then yields.
  return new Promise((resolve) => {
    let n = 0;
    const step = () => (n++ < rounds ? setTimeout(step, msPerRound) : resolve());
    setTimeout(step, msPerRound);
  });
}

describe('HttpPollTransport', () => {
  it('registers via hello and emits a synthetic welcome', async () => {
    const server = new FakeServer();
    const t = new HttpPollTransport({
      baseUrl: 'http://srv',
      username: 'quiet-otter-7',
      deviceType: 4,
      client: 'test',
      fetchImpl: server.fetch,
      waitMs: 1,
    });

    const received: unknown[] = [];
    t.onMessage((env) => received.push(env));
    t.start();
    await flush();

    expect(t.username()).toBe('quiet-otter-7');
    const welcome = received.find((e: any) => e.type === 'welcome');
    expect(welcome).toBeDefined();
    expect((welcome as any).payload.username).toBe('quiet-otter-7');
    t.close();
  });

  it('regenerates the username on 409 username_taken', async () => {
    const server = new FakeServer();
    server.takenNames.add('bold-falcon-1');

    const t = new HttpPollTransport({
      baseUrl: 'http://srv',
      username: 'bold-falcon-1',
      deviceType: 4,
      client: 'test',
      fetchImpl: server.fetch,
      waitMs: 1,
    });
    t.start();
    await flush();

    expect(t.username()).not.toBe('bold-falcon-1');
    expect(t.username()).toBeTruthy();
    t.close();
  });

  it('sends envelopes through /v1/send', async () => {
    const server = new FakeServer();
    const t = new HttpPollTransport({
      baseUrl: 'http://srv',
      username: 'a',
      deviceType: 4,
      client: 'test',
      fetchImpl: server.fetch,
      waitMs: 1,
    });
    t.start();
    await flush();

    t.send(makeEnvelope(t.username()!, 'ping', { t: 123 }));
    await flush();

    const send = server.requests.find((r) => r.path === '/v1/send');
    expect(send).toBeDefined();
    expect(send!.body.msgs).toHaveLength(1);
    expect(send!.body.msgs[0].type).toBe('ping');
    expect(t.stats().sent).toBe(1);
    t.close();
  });

  it('receives envelopes via polling', async () => {
    const server = new FakeServer();
    const t = new HttpPollTransport({
      baseUrl: 'http://srv',
      username: 'b',
      deviceType: 4,
      client: 'test',
      fetchImpl: server.fetch,
      waitMs: 1,
    });
    const received: any[] = [];
    t.onMessage((env) => received.push(env));
    t.start();
    await flush();

    server.deliver('b', makeEnvelope('swaptest', 'page.send', { to: 'b', elements: [] }));
    await flush();

    const page = received.find((e) => e.type === 'page.send');
    expect(page).toBeDefined();
    expect(page.from).toBe('swaptest');
    expect(t.stats().received).toBeGreaterThan(0);
    t.close();
  });

  it('re-queues outbound messages on network failure and retries', async () => {
    const server = new FakeServer();
    const t = new HttpPollTransport({
      baseUrl: 'http://srv',
      username: 'c',
      deviceType: 4,
      client: 'test',
      fetchImpl: server.fetch,
      waitMs: 1,
      initialBackoffMs: 1,
    });
    t.start();
    await flush();

    server.failNext = 'network';
    t.send(makeEnvelope('c', 'ping', { t: 1 }));
    await flush();
    await flush();

    const sends = server.requests.filter((r) => r.path === '/v1/send');
    expect(sends.length).toBeGreaterThanOrEqual(2); // failed one retried
    expect(t.stats().sent).toBe(1);
    t.close();
  });

  it('re-registers when the server forgets it (404 poll)', async () => {
    const server = new FakeServer();
    const t = new HttpPollTransport({
      baseUrl: 'http://srv',
      username: 'd',
      deviceType: 4,
      client: 'test',
      fetchImpl: server.fetch,
      waitMs: 1,
      initialBackoffMs: 1,
    });
    const states: string[] = [];
    t.onStateChange((s) => states.push(s));
    t.start();
    await flush();

    server.users.delete('d'); // server restart simulation
    await flush();
    await flush();

    expect(server.users.has('d')).toBe(true); // re-registered
    const hellos = server.requests.filter((r) => r.path === '/v1/hello');
    expect(hellos.length).toBeGreaterThanOrEqual(2);
    t.close();
  });

  it('rejects an invalid initial username by generating a valid one', async () => {
    const server = new FakeServer();
    const t = new HttpPollTransport({
      baseUrl: 'http://srv',
      username: 'INVALID NAME',
      deviceType: 4,
      client: 'test',
      fetchImpl: server.fetch,
      waitMs: 1,
    });
    t.start();
    await flush();

    expect(t.username()).toMatch(/^[a-z0-9-]+$/);
    t.close();
  });
});
