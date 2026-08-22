import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpPollTransport } from '@wrtn/protocol';
import { StubDevice } from '@wrtn/sn-stub';
import { WrtnServer } from '@wrtn/server';
import { BUTTON_ID } from '../buttonIds.ts';
import { createStubBridge } from '../device/stubBridge.ts';
import { NoteStore } from './noteStore.ts';
import { WrtnCore } from './wrtnCore.ts';

let server: WrtnServer;
let baseUrl: string;

beforeAll(async () => {
  server = new WrtnServer();
  await server.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${server.address()!.port}`;
});

afterAll(async () => {
  await server.close();
});

function settle(rounds = 12, ms = 5): Promise<void> {
  return new Promise((resolve) => {
    let n = 0;
    const step = () => (n++ < rounds ? setTimeout(step, ms) : resolve());
    setTimeout(step, ms);
  });
}

function makeCore(stub: StubDevice, opts: { store?: NoteStore } = {}): WrtnCore {
  const bridge = createStubBridge(stub);
  const transport = new HttpPollTransport({
    baseUrl,
    username: '',
    deviceType: stub.deviceType,
    client: 'test',
    waitMs: 30,
    initialBackoffMs: 1,
    requestTimeoutMs: 2_000,
  });
  return new WrtnCore({
    bridge,
    transport,
    ...(opts.store !== undefined ? { store: opts.store } : {}),
    defaultServerUrl: baseUrl,
  });
}

describe('NoteStore', () => {
  it('round-trips config through a .note file', async () => {
    const stub = new StubDevice();
    const bridge = createStubBridge(stub);
    const store = new NoteStore(bridge, '/MyStyle/WrtnStore/wrtn-config.note');

    expect(await store.load()).toBeNull();

    const saved = await store.save({ serverUrl: 'http://x:1', username: 'quiet-otter-9' });
    expect(saved).toBe(true);

    const loaded = await store.load();
    expect(loaded).toEqual({ serverUrl: 'http://x:1', username: 'quiet-otter-9' });

    // Overwrite: the last text element wins.
    await store.save({ serverUrl: 'http://y:2', username: 'bold-falcon-3' });
    expect(await store.load()).toEqual({ serverUrl: 'http://y:2', username: 'bold-falcon-3' });
  });
});

describe('WrtnCore', () => {
  it('connects, joins echo, sends a stroke, and queues the echo reply', async () => {
    const stub = new StubDevice();
    stub.t.openNote('/Note/Session.note');
    const core = makeCore(stub);
    try {
      await core.start();
      await settle();

      expect(core.state.phase).toBe('connected');
      expect(core.state.username).toMatch(/^[a-z]+(-[a-z]+){1,2}-\d+$/);

      core.addUser('echo');
      await settle();
      expect(core.state.members).toContainEqual({ username: 'echo', virtual: true });

      // Draw on the note: pen-up capture should send the stroke.
      const sentBefore = core.state.sent;
      stub.t.setPen({ penColor: 0, penType: 10, thickness: 300 });
      stub.t.drawStroke([
        { x: 1000, y: 2000 },
        { x: 1200, y: 2200 },
      ]);
      await settle(30);
      expect(core.state.sent).toBe(sentBefore + 1);

      // Echo reply arrives but must NOT auto-render: it is queued (issue #1
      // — auto save/insert/reloadFile per stroke flashed the page mid-
      // writing). No note mutation, no reload, pull button lit.
      await settle(30);
      expect(core.state.pending).toBe(1);
      expect(stub.t.reloadedCount()).toBe(0);
      expect(stub.t.buttonState(BUTTON_ID.pull)).toBe(true);
      const before = await stub.getElements(0, '/Note/Session.note');
      expect(before.success ? (before.result ?? []) : []).toHaveLength(1); // ours only

      // Manual pull renders the echo: same stroke, offset +2.5% of the
      // page, recolored gray (0x9D) — with exactly one screen flash.
      await core.pullPending();
      expect(core.state.pending).toBe(0);
      expect(stub.t.reloadedCount()).toBe(1);
      expect(stub.t.buttonState(BUTTON_ID.pull)).toBe(false);

      const elements = await stub.getElements(0, '/Note/Session.note');
      const strokes = elements.success ? (elements.result ?? []) : [];
      expect(strokes.length).toBeGreaterThanOrEqual(2); // ours + echo's
      const echoed = strokes.find((e) => e.stroke?.penColor === 0x9d);
      expect(echoed).toBeDefined();
      const { width, height } = stub.emr;
      const expected = [
        { x: Math.round((1000 / width + 0.025) * width), y: Math.round((2000 / height + 0.025) * height) },
        { x: Math.round((1200 / width + 0.025) * width), y: Math.round((2200 / height + 0.025) * height) },
      ];
      const pts = await echoed!.stroke!.points.getRange(0, 2);
      expect(pts).toEqual(expected);
      expect(core.state.received).toBe(1);

      // Loop guard: the inserted echo stroke must NOT be re-sent (the stub,
      // like the device, fires pen_up on insert).
      const sentAfterEcho = core.state.sent;
      await settle(20);
      expect(core.state.sent).toBe(sentAfterEcho);
    } finally {
      core.stop();
    }
  });

  it('pull with nothing pending does not touch the note', async () => {
    const stub = new StubDevice();
    stub.t.openNote('/Note/C.note');
    const core = makeCore(stub);
    try {
      await core.start();
      await settle();
      expect(core.state.pending).toBe(0);
      expect(stub.t.buttonState(BUTTON_ID.pull)).toBe(false);

      await core.pullPending();

      expect(core.state.pending).toBe(0);
      expect(stub.t.savedCount()).toBe(0);
      expect(stub.t.reloadedCount()).toBe(0);
    } finally {
      core.stop();
    }
  });

  it('queues strokes while no note is open; pull renders on the current page', async () => {
    // A has no note open; B draws in their session. A must queue (not drop,
    // not render), then render everything on the page open at PULL time.
    const stubA = new StubDevice();
    const stubB = new StubDevice();
    stubB.t.openNote('/Note/B.note');
    const coreA = makeCore(stubA);
    const coreB = makeCore(stubB);
    try {
      await coreA.start();
      await coreB.start();
      await settle();
      expect(coreA.state.phase).toBe('connected');
      expect(coreB.state.phase).toBe('connected');

      // B joins A's session (A is owner); A's strokes reach B and vice
      // versa.
      coreB.addUser(coreA.state.username);
      await settle();
      expect(coreA.state.members.map((m) => m.username)).toContain(coreB.state.username);

      // B draws; the stroke is broadcast to A (no note open).
      const sentB = coreB.state.sent;
      stubB.t.drawStroke([
        { x: 1000, y: 2000 },
        { x: 1300, y: 2300 },
      ]);
      await settle(30);
      expect(coreB.state.sent).toBe(sentB + 1);

      // A queued it (+ the echo bot's copy) without touching any note.
      expect(coreA.state.pending).toBeGreaterThanOrEqual(1);
      expect(stubA.t.reloadedCount()).toBe(0);

      // A opens a 2-page note on page 1: the pull retargets there.
      stubA.t.openNote('/Note/A.note', 2);
      stubA.t.goToPage(1);
      const sentA = coreA.state.sent;
      const pendingBefore = coreA.state.pending;
      await coreA.pullPending();

      expect(coreA.state.pending).toBe(0);
      expect(stubA.t.reloadedCount()).toBe(1);
      // One batched insertElements call carries the whole queue (the host
      // reloads the page once PER insertElements call — per-stroke inserts
      // flash the screen once per stroke, issue #1).
      const inserts = stubA.calls.filter((c) => c.method === 'insertElements');
      expect(inserts).toHaveLength(1);
      expect(inserts[0]?.args[2]).toBe(pendingBefore);
      const elements = await stubA.getElements(1, '/Note/A.note');
      const strokes = elements.success ? (elements.result ?? []) : [];
      expect(strokes.length).toBeGreaterThanOrEqual(1);
      // B's stroke lands in B's default pen (black).
      expect(strokes.some((e) => e.stroke?.penColor === 0x00)).toBe(true);
      // Page 0 stayed empty.
      const page0 = await stubA.getElements(0, '/Note/A.note');
      expect(page0.success ? (page0.result ?? []) : []).toHaveLength(0);

      // Loop guard on A's side too.
      await settle(20);
      expect(coreA.state.sent).toBe(sentA);
    } finally {
      coreA.stop();
      coreB.stop();
    }
  });

  it('persists and reloads a stored username', async () => {
    const stub = new StubDevice();
    stub.t.openNote('/Note/A.note');
    const bridge = createStubBridge(stub);
    const store = new NoteStore(bridge, '/MyStyle/WrtnStore/wrtn-config.note');

    const first = makeCore(stub, { store });
    await first.start();
    await settle();
    const name = first.state.username;
    expect(name).toBeTruthy();
    first.stop();

    const second = makeCore(stub, { store });
    await second.start();
    await settle();
    expect(second.state.username).toBe(name);
    second.stop();
  });

  it('keeps phase=offline when the server is unreachable, then works', async () => {
    const stub = new StubDevice();
    stub.t.openNote('/Note/B.note');
    const core = makeCore(stub);
    await core.start();
    await settle();
    expect(['connected', 'connecting']).toContain(core.state.phase);
    core.stop();
    expect(core.state.phase).toBe('closed');
  });
});
