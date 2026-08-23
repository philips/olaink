import { describe, expect, it } from 'vitest';
import type { Envelope, PageSendPayload } from '@wrtn/protocol';
import { makeEnvelope } from '@wrtn/protocol';
import { MAX_PAGE_MAILBOX, Registry, SWAPTEST } from './registry.ts';
import { Router } from './router.ts';
import { generateSwapTestPage } from './swapTest.ts';

interface Harness {
  registry: Registry;
  router: Router;
  hello: (name: string) => void;
  handle: (from: string, env: Envelope) => void;
  drain: (name: string) => Envelope[];
}

function harness(now: () => number = Date.now, opts?: { maxPageMailbox?: number }): Harness {
  const registry = new Registry(
    {
      onSessionChanged: (session) => {
        router.broadcastSessionState(session);
      },
    },
    now,
    opts,
  );
  const router = new Router({ registry });
  return {
    registry,
    router,
    hello: (name) => {
      registry.hello(name, 4, 'test');
    },
    handle: (from, env) => router.handle(from, env),
    drain: (name) => {
      const rec = registry.getUser(name);
      if (!rec) return [];
      const batch = rec.inbox;
      rec.inbox = [];
      return batch;
    },
  };
}

function pageEnv(pts: number[] = [0.1, 0.1, 0.2, 0.2]): Envelope {
  return makeEnvelope('alice', 'page.send', {
    to: 'bob',
    elements: [
      {
        kind: 'stroke',
        stroke: { sid: 'e1', penColor: 0, penType: 10, thickness: 300, pts },
      },
    ],
  });
}

describe('registry page mailbox', () => {
  it('queuePage delivers immediately to an online user AND keeps a copy', () => {
    const h = harness();
    h.hello('bob');
    const env = pageEnv();
    h.registry.queuePage('bob', env);
    expect(h.drain('bob')).toContainEqual(env); // immediate delivery
    expect(h.registry.pageMailboxSize('bob')).toBe(1); // still buffered
  });

  it('queuePage to an offline user buffers; their hello flushes the mailbox', () => {
    const h = harness();
    h.hello('alice');
    const env1 = pageEnv([0, 0, 0.1, 0.1]);
    const env2 = pageEnv([0.2, 0.2, 0.3, 0.3]);
    h.registry.queuePage('bob', env1);
    h.registry.queuePage('bob', env2);
    expect(h.registry.pageMailboxSize('bob')).toBe(2);

    h.hello('bob'); // reconnect / first connect
    const msgs = h.drain('bob');
    const pages = msgs.filter((e) => e.type === 'page.send');
    expect(pages.map((e) => e.id)).toEqual([env1.id, env2.id]); // in order
    expect(h.registry.pageMailboxSize('bob')).toBe(2); // still buffered until ack
  });

  it('ackPages removes only the acked envelopes', () => {
    const h = harness();
    h.hello('bob');
    const env1 = pageEnv();
    const env2 = pageEnv([0.3, 0.3, 0.4, 0.4]);
    h.registry.queuePage('bob', env1);
    h.registry.queuePage('bob', env2);

    const removed = h.registry.ackPages('bob', [env2.id]);
    expect(removed).toBe(1);
    expect(h.registry.pageMailboxSize('bob')).toBe(1);
    // Unknown / already-acked ids remove nothing.
    expect(h.registry.ackPages('bob', [env2.id, 'nope'])).toBe(0);
    expect(h.registry.pageMailboxSize('bob')).toBe(1);

    expect(h.registry.ackPages('bob', [env1.id])).toBe(1);
    expect(h.registry.pageMailboxSize('bob')).toBe(0);
  });

  it('caps the mailbox, dropping the oldest pages first', () => {
    const h = harness(Date.now, { maxPageMailbox: 3 });
    // Queue while the recipient is offline: no immediate deliveries.
    const envs = [1, 2, 3, 4, 5].map((i) => pageEnv([i / 10, 0, (i + 1) / 10, 0]));
    for (const e of envs) h.registry.queuePage('bob', e);
    expect(h.registry.pageMailboxSize('bob')).toBe(3);

    h.hello('bob'); // reconnect: the three newest come due
    const pages = h.drain('bob').filter((e) => e.type === 'page.send');
    expect(pages.map((e) => e.id)).toEqual([envs[2]!.id, envs[3]!.id, envs[4]!.id]);
  });

  it('survives user expiry: a swept user still gets their pages on reconnect', () => {
    let t = 1000;
    const h = harness(() => t);
    h.hello('alice');
    h.hello('bob');
    const env = pageEnv();
    h.registry.queuePage('bob', env);
    h.drain('bob'); // consume the immediate delivery

    t += 61_000;
    expect(h.registry.sweepExpired()).toContain('bob'); // bob expired
    expect(h.registry.pageMailboxSize('bob')).toBe(1); // mailbox survives

    h.hello('bob'); // back online
    const pages = h.drain('bob').filter((e) => e.type === 'page.send');
    expect(pages.map((e) => e.id)).toEqual([env.id]);
  });

  it('peers() reports buffered page counts', () => {
    const h = harness();
    h.hello('alice');
    h.hello('bob');
    h.registry.queuePage('bob', pageEnv());
    h.registry.queuePage('bob', pageEnv());
    const peer = h.registry.peers().find((p) => p.username === 'bob')!;
    expect(peer.pages).toBe(2);
    const alice = h.registry.peers().find((p) => p.username === 'alice')!;
    expect(alice.pages).toBe(0);
  });

  it('exposes a sane default mailbox cap', () => {
    expect(MAX_PAGE_MAILBOX).toBeGreaterThan(10);
  });

  it('re-hello while a long-poll is in flight delivers the flushed page to the new connection', async () => {
    const h = harness();
    h.hello('bob');
    const env = pageEnv();
    h.registry.queuePage('bob', env);
    // Connection 1 takes the immediate delivery, then long-polls.
    expect(h.drain('bob')).toHaveLength(1);
    const stalePoll = h.registry.poll('bob', 5_000);
    // Connection 2 re-hellos while connection 1's poll is still in flight.
    // The mailbox flush must not be swallowed by the stale poll's waiter.
    h.hello('bob');
    const fresh = await h.registry.poll('bob', 0);
    const stale = await stalePoll; // settled by the re-hello, not the 5s timeout
    expect(fresh.filter((e) => e.id === env.id)).toHaveLength(1);
    expect(stale.filter((e) => e.id === env.id)).toHaveLength(0);
  });
});

describe('router page.send / pages.ack', () => {
  it('routes a page.send to the recipient (mailbox + immediate delivery), stamped from', () => {
    const h = harness();
    h.hello('alice');
    h.hello('bob');
    h.handle('alice', pageEnv());
    const msgs = h.drain('bob');
    const page = msgs.find((e) => e.type === 'page.send');
    expect(page).toBeDefined();
    expect(page!.from).toBe('alice');
    expect(h.registry.pageMailboxSize('bob')).toBe(1);
    // Sender does not get a copy.
    expect(h.drain('alice').filter((e) => e.type === 'page.send')).toEqual([]);
  });

  it('rejects page.send to reserved recipients with bad_payload', () => {
    const h = harness();
    h.hello('alice');
    for (const bad of ['server', 'echo', 'swaptest']) {
      h.handle(
        'alice',
        makeEnvelope('alice', 'page.send', {
          to: bad,
          elements: [
            {
              kind: 'stroke',
              stroke: { sid: 'e1', penColor: 0, penType: 10, thickness: 300, pts: [0, 0, 0.1, 0.1] },
            },
          ],
        }),
      );
      const err = h.drain('alice').find((e) => e.type === 'error');
      expect((err?.payload as { code: string }).code).toBe('bad_payload');
    }
    expect(h.registry.pageMailboxSize('echo')).toBe(0);
  });

  it('pages.ack from the recipient clears their mailbox', () => {
    const h = harness();
    h.hello('alice');
    h.hello('bob');
    h.handle('alice', pageEnv());
    // The server stamps the page id: ack the id of the delivered envelope.
    const delivered = h.drain('bob').find((e) => e.type === 'page.send')!;
    expect(h.registry.pageMailboxSize('bob')).toBe(1);

    h.handle('bob', makeEnvelope('bob', 'pages.ack', { pageIds: [delivered.id] }));
    expect(h.registry.pageMailboxSize('bob')).toBe(0);
  });

  it('routePageSend lets the swaptest bot send pages like a real user', () => {
    const h = harness();
    h.hello('bob');
    const elements = generateSwapTestPage(() => 0.5);
    const env = h.router.routePageSend(SWAPTEST, { to: 'bob', elements });
    const page = h.drain('bob').find((e) => e.type === 'page.send');
    expect(page?.from).toBe(SWAPTEST);
    expect(page?.id).toBe(env.id);
    expect((page!.payload as PageSendPayload).elements.length).toBeGreaterThan(0);
  });

  it('swaptest can be invited into a session like echo', () => {
    const h = harness();
    h.hello('alice');
    h.handle('alice', makeEnvelope('alice', 'session.add', { target: SWAPTEST }));
    const msgs = h.drain('alice');
    expect(msgs.find((e) => e.type === 'error')).toBeUndefined();
    const state = msgs.find((e) => e.type === 'session.state');
    const members = (state!.payload as { members: { username: string; virtual: boolean }[] }).members;
    expect(members).toContainEqual({ username: SWAPTEST, virtual: true });
    expect(members).toContainEqual({ username: 'alice', virtual: false });
  });

  it('joining a swaptest-owned session does not error', () => {
    const h = harness();
    h.hello('alice');
    h.handle('alice', makeEnvelope('alice', 'join', { owner: SWAPTEST }));
    expect(h.drain('alice').find((e) => e.type === 'error')).toBeUndefined();
  });
});

describe('generateSwapTestPage', () => {
  it('produces a plausible page with normalized points', () => {
    const els = generateSwapTestPage(() => 0.5);
    expect(els.length).toBeGreaterThanOrEqual(3);
    for (const el of els) {
      expect(el.kind).toBe('stroke');
      if (el.kind !== 'stroke') continue;
      expect(el.stroke.pts.length).toBeGreaterThanOrEqual(12);
      expect(el.stroke.pts.length % 2).toBe(0);
      for (const n of el.stroke.pts) {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is deterministic for a seeded source', () => {
    const a = generateSwapTestPage(() => 0.25);
    const b = generateSwapTestPage(() => 0.25);
    expect(a).toEqual(b);
  });
});
