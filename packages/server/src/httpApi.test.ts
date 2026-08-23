import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnvelope } from '@wrtn/protocol';
import { WrtnServer } from './httpApi.ts';

let server: WrtnServer;
let baseUrl: string;

beforeAll(async () => {
  server = new WrtnServer();
  await server.listen({ port: 0, host: '127.0.0.1' });
  const addr = server.address()!;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await server.close();
});

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function flush(times = 6): Promise<void> {
  return new Promise((resolve) => {
    let n = 0;
    const step = () => (n++ < times ? setTimeout(step, 3) : resolve());
    setTimeout(step, 3);
  });
}

describe('HTTP API', () => {
  it('healthz responds ok', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('hello validates usernames', async () => {
    const bad = await post('/v1/hello', { username: 'Bad Name', deviceType: 4, client: 't' });
    expect(bad.status).toBe(400);
    const reserved = await post('/v1/hello', { username: 'echo', deviceType: 4, client: 't' });
    expect(reserved.status).toBe(400);
  });

  it('send/poll reject bad auth', async () => {
    const a = await post('/v1/send', { username: 'x', token: 'y', msgs: [] });
    expect(a.status).toBe(401);
    const b = await post('/v1/poll', { username: 'x', token: 'y', waitMs: 0 });
    expect(b.status).toBe(401);
  });

  it('full echo round-trip over HTTP', async () => {
    const hello = await post('/v1/hello', {
      username: 'amber-otter-1',
      deviceType: 4,
      client: 'it',
    });
    expect(hello.status).toBe(200);
    const { username, token } = hello.json;

    // Background poll so deliveries land in the inbox during the test.
    const pollPromise = post('/v1/poll', { username, token, waitMs: 300 });

    await post('/v1/send', {
      username,
      token,
      msgs: [makeEnvelope(username, 'session.add', { target: 'echo' })],
    });
    const first = await pollPromise;
    expect(first.status).toBe(200);
    // Long-poll resolves on the first delivery (session.state) by design;
    // the echo strokes arrive in a subsequent poll.

    await post('/v1/send', {
      username,
      token,
      msgs: [
        makeEnvelope(username, 'strokes', {
          strokes: [
            {
              sid: 'e1',
              page: 0,
              layer: 0,
              penColor: 0,
              penType: 10,
              thickness: 300,
              pts: [0.1, 0.2, 0.3, 0.4],
              prs: [10, 20],
            },
          ],
        }),
      ],
    });

    const poll = await post('/v1/poll', { username, token, waitMs: 300 });
    expect(poll.status).toBe(200);
    const types = poll.json.in.map((e: any) => e.type);
    expect(types).toContain('strokes');

    const echoStrokes = poll.json.in.find((e: any) => e.from === 'echo');
    expect(echoStrokes.payload.strokes[0].pts).toEqual([0.1 + 0.025, 0.2 + 0.025, 0.3 + 0.025, 0.4 + 0.025]);
  });

  it('long-poll holds until a message arrives, then returns immediately', async () => {
    const h = await post('/v1/hello', { username: 'bold-falcon-2', deviceType: 4, client: 'it' });
    const { username, token } = h.json;

    const started = Date.now();
    const pollPromise = post('/v1/poll', { username, token, waitMs: 2000 }).then((r) => ({
      took: Date.now() - started,
      ...r,
    }));

    // Nothing queued yet: wait a bit, then deliver via ping.
    await flush(3);
    await post('/v1/send', {
      username,
      token,
      msgs: [makeEnvelope(username, 'ping', { t: 7 })],
    });

    const result = await pollPromise;
    expect(result.status).toBe(200);
    expect(result.took).toBeLessThan(1900); // did not wait the full 2s
    expect(result.json.in.map((e: any) => e.type)).toContain('pong');
  });

  describe('swaptest page endpoint (issue #2)', () => {
    it('generates a page and delivers it to the recipient on connect', async () => {
      const to = 'quiet-lark-9';
      // Recipient is offline when the page is sent: it must be buffered.
      const gen = await post('/v1/test/swaptest/page', { to });
      expect(gen.status).toBe(200);
      expect(gen.json.ok).toBe(true);
      expect(gen.json.to).toBe(to);
      expect(gen.json.elements).toBeGreaterThan(0);
      expect(gen.json.pageId).toBeTruthy();

      const h = await post('/v1/hello', { username: to, deviceType: 4, client: 'it' });
      const { username, token } = h.json;
      const poll = await post('/v1/poll', { username, token, waitMs: 200 });
      const page = poll.json.in.find((e: any) => e.type === 'page.send');
      expect(page).toBeDefined();
      expect(page.from).toBe('swaptest');
      expect(page.id).toBe(gen.json.pageId);
      expect(page.payload.to).toBe(to);
      expect(page.payload.elements.length).toBeGreaterThan(0);
      for (const el of page.payload.elements) {
        expect(el.kind).toBe('stroke');
        expect(el.stroke.pts.length % 2).toBe(0);
      }

      // Acking clears the server-side mailbox (visible via /v1/peers).
      const ack = await post('/v1/send', {
        username,
        token,
        msgs: [makeEnvelope(username, 'pages.ack', { pageIds: [gen.json.pageId] })],
      });
      expect(ack.status).toBe(200);
      const peersRes = await fetch(`${baseUrl}/v1/peers`);
      const peersJson = await peersRes.json();
      const me = peersJson.peers.find((p: any) => p.username === to);
      expect(me.pages).toBe(0);
    });

    it('rejects invalid recipients', async () => {
      expect((await post('/v1/test/swaptest/page', { to: 'echo' })).status).toBe(400);
      expect((await post('/v1/test/swaptest/page', { to: 'Not A User' })).status).toBe(400);
      expect((await post('/v1/test/swaptest/page', {})).status).toBe(400);
    });

    it('delivers immediately when the recipient is online', async () => {
      const to = 'brisk-mole-3';
      const h = await post('/v1/hello', { username: to, deviceType: 4, client: 'it' });
      const { username, token } = h.json;
      const pollPromise = post('/v1/poll', { username, token, waitMs: 500 });
      await flush(3);
      const gen = await post('/v1/test/swaptest/page', { to });
      expect(gen.status).toBe(200);
      const poll = await pollPromise;
      const page = poll.json.in.find((e: any) => e.type === 'page.send');
      expect(page?.from).toBe('swaptest');
      expect(page?.id).toBe(gen.json.pageId);
    });
  });
});
