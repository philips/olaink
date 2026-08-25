import { describe, expect, it } from 'vitest';
import type { Envelope } from '@olaink/protocol';
import { makeEnvelope } from '@olaink/protocol';
import { Registry } from './registry.ts';
import { Router } from './router.ts';

function harness(now: () => number = Date.now) {
  const registry = new Registry(now);
  const router = new Router({ registry });
  const drain = (name: string): Envelope[] => {
    const rec = registry.getUser(name);
    if (!rec) return [];
    const batch = rec.inbox;
    rec.inbox = [];
    return batch;
  };
  return { registry, router, hello: (name: string) => registry.hello(name, 4, 'test'), drain };
}

describe('registry', () => {
  it('rotates tokens on re-hello', () => {
    const h = harness();
    const firstToken = h.hello('alice').token;
    const second = h.hello('alice');
    expect(second.token).not.toBe(firstToken);
  });

  it('authenticates only active users with their current token', () => {
    const h = harness();
    const rec = h.hello('alice');
    expect(h.registry.authenticate('alice', rec.token)).not.toBeNull();
    expect(h.registry.authenticate('alice', 'wrong')).toBeNull();
  });

  it('expires users without discarding their page mailboxes', () => {
    let time = 1_000;
    const h = harness(() => time);
    const rec = h.hello('alice');
    h.registry.queuePage('alice', makeEnvelope('bob', 'page.send', { to: 'alice', elements: [] }));
    time += 61_000;
    expect(h.registry.sweepExpired()).toEqual(['alice']);
    expect(h.registry.getUser('alice')).toBeNull();
    h.registry.hello('alice', 4, 'test');
    expect(h.drain('alice')).toHaveLength(1);
    void rec;
  });
});

describe('router', () => {
  it('answers pings', () => {
    const h = harness();
    h.hello('alice');
    h.router.handle('alice', makeEnvelope('alice', 'ping', { t: 42 }));
    expect(h.drain('alice')[0]?.payload).toEqual({ t: 42, serverNow: expect.any(Number) });
  });

  it('routes a page directly to an online recipient and stamps the sender', () => {
    const h = harness();
    h.hello('alice');
    h.hello('bob');
    h.router.handle('alice', makeEnvelope('forged', 'page.send', { to: 'bob', elements: [] }));
    const page = h.drain('bob')[0]!;
    expect(page.type).toBe('page.send');
    expect(page.from).toBe('alice');
    expect(h.registry.pageMailboxSize('bob')).toBe(1);
  });

  it('rejects malformed or reserved-recipient pages', () => {
    const h = harness();
    h.hello('alice');
    h.router.handle('alice', makeEnvelope('alice', 'page.send', { to: 'server', elements: [] }));
    expect(h.drain('alice')[0]?.type).toBe('error');
  });

  it('acks only the recipient mailbox', () => {
    const h = harness();
    h.hello('alice');
    h.hello('bob');
    const page = h.router.routePageSend('alice', { to: 'bob', elements: [] });
    h.router.handle('bob', makeEnvelope('bob', 'pages.ack', { pageIds: [page.id] }));
    expect(h.registry.pageMailboxSize('bob')).toBe(0);
  });
});
