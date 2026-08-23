import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpPollTransport, makeEnvelope } from '@wrtn/protocol';
import { StubDevice } from '@wrtn/sn-stub';
import { WrtnServer } from '@wrtn/server';
import { createStubBridge } from '../device/stubBridge.ts';
import { TYPE_TEXT } from '../device/types.ts';
import { NoteStore, STORE_NOTE_PATHS } from './noteStore.ts';
import { swapNotePathFor } from './swapNotes.ts';
import { WrtnCore } from './wrtnCore.ts';

let server: WrtnServer;
let baseUrl: string;

beforeAll(async () => {
  server = new WrtnServer();
  await server.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${server.address()!.port}`;
});
afterAll(async () => { await server.close(); });

function settle(rounds = 12, ms = 5): Promise<void> {
  return new Promise((resolve) => {
    let count = 0;
    const step = () => count++ < rounds ? setTimeout(step, ms) : resolve();
    setTimeout(step, ms);
  });
}

function makeCore(stub: StubDevice, opts: { store?: { load(): Promise<{ serverUrl: string; username: string } | null>; save(cfg: { serverUrl: string; username: string }): Promise<boolean>; } } = {}): WrtnCore {
  const transport = new HttpPollTransport({
    baseUrl, username: '', deviceType: stub.deviceType, client: 'test', waitMs: 30,
    initialBackoffMs: 1, requestTimeoutMs: 2_000,
  });
  return new WrtnCore({ bridge: createStubBridge(stub), transport, defaultServerUrl: baseUrl, ...(opts.store ? { store: opts.store } : {}) });
}

async function addTextPage(stub: StubDevice, path: string, text: string): Promise<void> {
  const bridge = createStubBridge(stub);
  stub.t.openNote(path);
  const element = await bridge.createElement(TYPE_TEXT);
  if (element === null || element.textBox === null) throw new Error('create text failed');
  element.textBox = { ...element.textBox, textContentFull: text, fontSize: 24, textRect: { left: 100, top: 100, right: 900, bottom: 300 }, textAlign: 0, textFrameWidthType: 1 };
  expect(await bridge.insertElements(path, 0, [element])).toBe(true);
}

describe('NoteStore', () => {
  it('round-trips config through an absolute .note file', async () => {
    const stub = new StubDevice();
    const store = new NoteStore(createStubBridge(stub));
    expect(await store.save({ serverUrl: 'http://x:1', username: 'quiet-otter-9' })).toBe(true);
    expect(await store.load()).toEqual({ serverUrl: 'http://x:1', username: 'quiet-otter-9' });
  });

  it('uses style_white when templates are unavailable in settings context', async () => {
    const stub = new StubDevice({ settingsContext: true });
    const store = new NoteStore(createStubBridge(stub));
    expect(await store.save({ serverUrl: 'http://x:1', username: 'quiet-otter-9' })).toBe(true);
    expect(stub.calls.find((call) => call.method === 'createNote')?.args).toEqual([STORE_NOTE_PATHS[0], 'style_white']);
  });
});

describe('SwapNote page transfer', () => {
  it('sends directly to a typed online username, appends, and acks', async () => {
    const sender = new StubDevice();
    const receiver = new StubDevice();
    const sourcePath = '/storage/emulated/0/Note/source.note';
    await addTextPage(sender, sourcePath, 'hello SwapNote');
    receiver.t.openNote('/storage/emulated/0/Note/other.note');
    const a = makeCore(sender);
    const b = makeCore(receiver);
    try {
      await a.start(); await b.start(); await settle();
      expect(await a.sendCurrentPage(b.state.username)).toBe(true);
      await settle(30);
      const destination = swapNotePathFor(a.state.username);
      expect(b.state.pagePending).toBe(1);
      receiver.t.openNote(destination);
      await settle(30);
      expect(b.state.pagePending).toBe(0);
      expect((await receiver.getNoteTotalPageNum(destination)).result).toBe(2);
      const elements = (await receiver.getElements(1, destination)).result ?? [];
      expect(elements.some((element) => element.textBox?.textContentFull === 'hello SwapNote')).toBe(true);
      expect(server.registry.pageMailboxSize(b.state.username)).toBe(0);
    } finally { a.stop(); b.stop(); }
  });

  it('keeps an offline page in the mailbox and appends it once after reconnect', async () => {
    const sender = new StubDevice();
    const receiver = new StubDevice();
    await addTextPage(sender, '/storage/emulated/0/Note/source.note', 'offline page');
    const a = makeCore(sender);
    await a.start(); await settle();
    const target = 'quiet-otter-99';
    expect(await a.sendCurrentPage(target)).toBe(true);
    await settle();
    expect(server.registry.pageMailboxSize(target)).toBe(1);
    const b = makeCore(receiver, { store: { load: async () => ({ serverUrl: baseUrl, username: target }), save: async () => true } });
    try {
      await b.start(); await settle(30);
      const destination = swapNotePathFor(a.state.username);
      receiver.t.openNote(destination);
      await settle(30);
      expect((await receiver.getNoteTotalPageNum(destination)).result).toBe(2);
      expect(server.registry.pageMailboxSize(target)).toBe(0);
    } finally { a.stop(); b.stop(); }
  });

  it('rejects invalid and reserved recipient names before sending', async () => {
    const stub = new StubDevice();
    await addTextPage(stub, '/storage/emulated/0/Note/source.note', 'page');
    const core = makeCore(stub);
    try {
      await core.start(); await settle();
      expect(await core.sendCurrentPage('not a username')).toBe(false);
      expect(await core.sendCurrentPage('swaptest')).toBe(false);
      expect(core.state.sent).toBe(0);
    } finally { core.stop(); }
  });

  it('accepts pages generated by swaptest', async () => {
    const stub = new StubDevice();
    const core = makeCore(stub);
    try {
      await core.start(); await settle();
      const env = makeEnvelope('swaptest', 'page.send', { to: core.state.username, elements: [{ kind: 'stroke' as const, stroke: { sid: 's', penColor: 0, penType: 10, thickness: 300, pts: [0.1, 0.1, 0.2, 0.2] } }] });
      server.registry.queuePage(core.state.username, env);
      await settle(20);
      const path = swapNotePathFor('swaptest');
      stub.t.openNote(path);
      await settle(30);
      expect((await stub.getNoteTotalPageNum(path)).result).toBe(2);
    } finally { core.stop(); }
  });
});
