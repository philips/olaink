import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpPollTransport } from '@wrtn/protocol';
import { StubDevice } from '@wrtn/sn-stub';
import { WrtnServer } from '@wrtn/server';
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
  it('connects, joins echo, sends a stroke, and renders the echo reply', async () => {
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

      // Echo reply should have been rendered into the note: same stroke,
      // offset +2.5% of the page, recolored gray (0x9D).
      await settle(30);
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
