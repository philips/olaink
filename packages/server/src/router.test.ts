import { describe, expect, it } from 'vitest';
import type { Envelope } from '@wrtn/protocol';
import type { ErrorPayload, SessionStatePayload, StrokesPayload } from '@wrtn/protocol';
import { makeEnvelope } from '@wrtn/protocol';
import { ECHO, Registry } from './registry.ts';
import { Router } from './router.ts';

interface Harness {
  registry: Registry;
  router: Router;
  hello: (name: string) => void;
  handle: (from: string, env: Envelope) => void;
  drain: (name: string) => Envelope[];
}

function harness(now: () => number = Date.now): Harness {
  const registry = new Registry(
    {
      onSessionChanged: (session) => {
        router.broadcastSessionState(session);
      },
    },
    now,
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

function strokesEnv(pts: number[] = [100, 100, 200, 200]): Envelope {
  return makeEnvelope('x', 'strokes', {
    strokes: [
      { sid: 's1', page: 0, layer: 0, penColor: 0, penType: 10, thickness: 300, pts },
    ],
  });
}

describe('registry', () => {
  it('hello creates a user with a solo session', () => {
    const h = harness();
    const rec = h.registry.hello('alice', 4, 'test');
    expect(rec.token).toBeTruthy();
    const session = h.registry.sessionOf('alice');
    expect(session?.owner).toBe('alice');
    expect([...session!.members]).toEqual(['alice']);
  });

  it('re-hello keeps session membership but rotates the token', () => {
    const h = harness();
    h.registry.hello('alice', 4, 'test');
    h.hello('bob');
    h.handle('alice', makeEnvelope('alice', 'session.add', { target: 'bob' }));
    const before = h.registry.sessionOf('alice');
    const tok1 = h.registry.getUser('alice')!.token;
    const a2 = h.registry.hello('alice', 4, 'test2');
    expect(a2.token).not.toBe(tok1);
    expect(h.registry.sessionOf('alice')).toBe(before); // same session object
  });

  it('authenticate rejects bad tokens and unknown users', () => {
    const h = harness();
    h.hello('alice');
    const rec = h.registry.getUser('alice')!;
    expect(h.registry.authenticate('alice', rec.token)).not.toBeNull();
    expect(h.registry.authenticate('alice', 'wrong')).toBeNull();
    expect(h.registry.authenticate('nobody', 'x')).toBeNull();
  });

  it('poll returns queued envelopes immediately', async () => {
    const h = harness();
    h.hello('alice');
    h.registry.deliver('alice', makeEnvelope('server', 'ping', { t: 1 }));
    const batch = await h.registry.poll('alice', 0);
    expect(batch).toHaveLength(1);
    expect(batch[0]!.type).toBe('ping');
    // Queue is empty now.
    expect(await h.registry.poll('alice', 0)).toEqual([]);
  });

  it('poll waits and receives an envelope delivered mid-wait', async () => {
    const h = harness();
    h.hello('alice');
    const waiting = h.registry.poll('alice', 500);
    setTimeout(() => h.registry.deliver('alice', makeEnvelope('server', 'pong', { t: 2, serverNow: 3 })), 10);
    const batch = await waiting;
    expect(batch.map((e) => e.type)).toEqual(['pong']);
  });

  it('expired users are swept and removed from sessions', () => {
    let t = 1000;
    const h = harness(() => t);
    h.hello('alice');
    h.hello('bob');
    h.handle('alice', makeEnvelope('alice', 'session.add', { target: 'bob' }));

    t += 61_000; // bob never polls after hello... alice neither
    const expired = h.registry.sweepExpired();
    expect(expired.sort()).toEqual(['alice', 'bob']);
    expect(h.registry.getUser('alice')).toBeNull();
    expect(h.registry.sessionOf('echo')).toBeNull();
  });

  it('expiry broadcasts session.state to survivors', () => {
    let t = 1000;
    const h = harness(() => t);
    h.hello('alice');
    h.hello('bob');
    h.handle('alice', makeEnvelope('alice', 'session.add', { target: 'bob' }));
    h.drain('alice');
    h.drain('bob');

    // Alice keeps polling; bob goes silent.
    t += 61_000;
    h.registry.authenticate('alice', h.registry.getUser('alice')!.token);
    const expired = h.registry.sweepExpired();
    expect(expired).toEqual(['bob']);
    const aliceMsgs = h.drain('alice');
    const state = aliceMsgs.find((e) => e.type === 'session.state');
    expect(state).toBeDefined();
    expect(state!.payload).toEqual({
      owner: 'alice',
      members: [{ username: 'alice', virtual: false }],
    });
  });
});

describe('router', () => {
  it('ping replies pong with serverNow', () => {
    const h = harness();
    h.hello('alice');
    h.handle('alice', makeEnvelope('alice', 'ping', { t: 42 }));
    const msgs = h.drain('alice');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.type).toBe('pong');
    expect(msgs[0]!.payload).toEqual({ t: 42, serverNow: expect.any(Number) });
  });

  it('join connects two users into one session; both see session.state', () => {
    const h = harness();
    h.hello('alice');
    h.hello('bob');
    h.handle('bob', makeEnvelope('bob', 'join', { owner: 'alice' }));

    const bobMsgs = h.drain('bob');
    const aliceMsgs = h.drain('alice');
    // Bob first gets a leave-broadcast for his own solo session (harmless),
    // then the joined session state.
    const expected = {
      owner: 'alice',
      members: [
        { username: 'alice', virtual: false },
        { username: 'bob', virtual: false },
      ],
    };
    const bobState = bobMsgs.filter((e) => e.type === 'session.state');
    expect(bobState.at(-1)?.payload).toEqual(expected);
    expect(aliceMsgs.find((e) => e.type === 'session.state')?.payload).toEqual(expected);
    expect(h.registry.sessionOf('bob')?.owner).toBe('alice');
  });

  it('session.add by any member pulls a third user in', () => {
    const h = harness();
    h.hello('alice');
    h.hello('bob');
    h.hello('carol');
    h.handle('bob', makeEnvelope('bob', 'join', { owner: 'alice' }));
    h.drain('alice');
    h.drain('bob');
    h.drain('carol');

    h.handle('bob', makeEnvelope('bob', 'session.add', { target: 'carol' }));
    for (const who of ['alice', 'bob', 'carol']) {
      const state = h.drain(who).find((e) => e.type === 'session.state');
      expect((state?.payload as SessionStatePayload).members).toHaveLength(3);
    }
  });

  it('session.add of an unknown user returns user_not_found', () => {
    const h = harness();
    h.hello('alice');
    h.handle('alice', makeEnvelope('alice', 'session.add', { target: 'ghost' }));
    const err = h.drain('alice').find((e) => e.type === 'error');
    expect((err?.payload as ErrorPayload).code).toBe('user_not_found');
  });

  it('join of an unknown owner returns user_not_found', () => {
    const h = harness();
    h.hello('alice');
    h.handle('alice', makeEnvelope('alice', 'join', { owner: 'ghost' }));
    const err = h.drain('alice').find((e) => e.type === 'error');
    expect((err?.payload as ErrorPayload).code).toBe('user_not_found');
  });

  it('strokes route to session members but not the sender', () => {
    const h = harness();
    h.hello('alice');
    h.hello('bob');
    h.handle('bob', makeEnvelope('bob', 'join', { owner: 'alice' }));
    h.drain('alice');
    h.drain('bob');

    h.handle('alice', strokesEnv());
    const bobMsgs = h.drain('bob');
    const strokes = bobMsgs.find((e) => e.type === 'strokes');
    expect(strokes).toBeDefined();
    expect(strokes!.from).toBe('alice'); // from is stamped by the server
    expect((strokes!.payload as StrokesPayload).strokes[0]!.pts).toEqual([100, 100, 200, 200]);
    expect(h.drain('alice')).toEqual([]); // sender does not get its own strokes
  });

  it('session.leave returns the user to a solo session', () => {
    const h = harness();
    h.hello('alice');
    h.hello('bob');
    h.handle('bob', makeEnvelope('bob', 'join', { owner: 'alice' }));
    h.drain('alice');
    h.drain('bob');

    h.handle('bob', makeEnvelope('bob', 'session.leave', {}));
    expect(h.registry.sessionOf('bob')?.owner).toBe('bob');
    expect([...h.registry.sessionOf('bob')!.members]).toEqual(['bob']);
    const state = h.drain('alice').find((e) => e.type === 'session.state');
    expect((state?.payload as SessionStatePayload).members).toEqual([
      { username: 'alice', virtual: false },
    ]);
    const bobState = h.drain('bob').find((e) => e.type === 'session.state');
    expect(bobState?.payload).toEqual({
      owner: 'bob',
      members: [{ username: 'bob', virtual: false }],
    });
  });

  it('owner leaving promotes an heir', () => {
    const h = harness();
    h.hello('alice');
    h.hello('bob');
    h.handle('bob', makeEnvelope('bob', 'join', { owner: 'alice' }));
    h.drain('alice');
    h.drain('bob');

    h.handle('alice', makeEnvelope('alice', 'session.leave', {}));
    expect(h.registry.sessionOf('bob')?.owner).toBe('bob');
    const state = h.drain('bob').find((e) => e.type === 'session.state');
    expect(state?.payload).toEqual({
      owner: 'bob',
      members: [{ username: 'bob', virtual: false }],
    });
  });
});

describe('echo user', () => {
  it('echo joins like a user and echoes strokes back with offset + recolor', () => {
    const h = harness();
    h.hello('alice');
    h.handle('alice', makeEnvelope('alice', 'session.add', { target: ECHO }));
    const state = h.drain('alice').find((e) => e.type === 'session.state');
    expect((state?.payload as SessionStatePayload).members).toContainEqual({
      username: 'echo',
      virtual: true,
    });

    h.handle('alice', strokesEnv([10, 20, 30, 40]));
    const reply = h.drain('alice').find((e) => e.type === 'strokes');
    expect(reply?.from).toBe('echo');
    const s = (reply!.payload as StrokesPayload).strokes[0]!;
    expect(s.pts).toEqual([10 + 384, 20 + 384, 30 + 384, 40 + 384]);
    expect(s.penColor).toBe(0x9d);
    expect(s.sid).toBe('s1-echo');
  });

  it('echo replies go to all real members including the original sender', () => {
    const h = harness();
    h.hello('alice');
    h.hello('bob');
    h.handle('bob', makeEnvelope('bob', 'join', { owner: 'alice' }));
    h.handle('alice', makeEnvelope('alice', 'session.add', { target: ECHO }));
    h.drain('alice');
    h.drain('bob');

    h.handle('bob', strokesEnv());
    for (const who of ['alice', 'bob']) {
      const echoReply = h.drain(who).find((e) => e.from === 'echo');
      expect(echoReply).toBeDefined();
    }
  });
});
