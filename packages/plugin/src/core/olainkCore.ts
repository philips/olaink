/** SwapNote controller: direct page transfer, receive queueing, and note append. */

import {
  type Envelope,
  type PageElement,
  type PageSendPayload,
  type PageStroke,
  type PageText,
  type Transport,
  generateUsername,
  isValidUsername,
  makeEnvelope,
} from '@olaink/protocol';
import type { BridgeElement, DeviceBridge } from '../device/types.ts';
import { TYPE_STROKE, TYPE_TEXT } from '../device/types.ts';
import { swapNotePathFor, swapNoteSenderOf } from './swapNotes.ts';
import type { StoredConfig } from './noteStore.ts';
import { BUILD_STAMP } from '../buildStamp.ts';

export type CorePhase = 'starting' | 'offline' | 'connecting' | 'connected' | 'closed';

export interface CoreState {
  phase: CorePhase;
  serverUrl: string;
  username: string;
  log: string[];
  sent: number;
  pagePending: number;
  pagePendingBySender: { sender: string; count: number }[];
  storeError: string | null;
}

export interface OlainkCoreDeps {
  bridge: DeviceBridge;
  transport: Transport;
  store?: { load(): Promise<StoredConfig | null>; save(cfg: StoredConfig): Promise<boolean>; };
  defaultServerUrl: string;
  now?: () => number;
}

const MAX_QUEUED_PAGES = 50;

export class OlainkCore {
  public state: CoreState;
  private readonly now: () => number;
  private offMessage: (() => void) | null = null;
  private offStateChange: (() => void) | null = null;
  private unsubTick: (() => void) | null = null;
  private notifyScheduled = false;
  private readonly listeners = new Set<() => void>();
  private readonly pageQueue = new Map<string, Envelope[]>();
  private readonly knownPageIds = new Set<string>();
  private readonly ensuringNotes = new Map<string, Promise<boolean>>();
  private swapFlushInFlight = false;

  constructor(private readonly deps: OlainkCoreDeps) {
    this.now = deps.now ?? Date.now;
    this.state = {
      phase: 'starting', serverUrl: deps.defaultServerUrl, username: '', log: [], sent: 0,
      pagePending: 0, pagePendingBySender: [], storeError: null,
    };
  }

  subscribe(cb: () => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  private notify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    Promise.resolve().then(() => queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const cb of this.listeners) cb();
    }));
  }

  private log(line: string): void {
    console.log(`[olaink] ${line}`);
    this.state = { ...this.state, log: [...this.state.log.slice(-40), `${new Date(this.now()).toISOString().slice(11, 19)} ${line}`] };
    this.notify();
  }

  async start(): Promise<void> {
    let cfg: StoredConfig | null = null;
    if (this.deps.store !== undefined) {
      try { cfg = await this.deps.store.load(); } catch { cfg = null; }
    }
    let username = cfg?.username ?? '';
    const serverUrl = cfg?.serverUrl ?? this.deps.defaultServerUrl;
    let storeError: string | null = null;
    if (this.deps.store !== undefined && cfg === null) {
      username = generateUsername();
      if (!(await this.deps.store.save({ serverUrl, username }))) storeError = 'config not persisted; username will change';
    }
    if (username === '') username = generateUsername();

    this.state = { ...this.state, username, serverUrl, storeError, phase: 'connecting' };
    this.log(`build ${BUILD_STAMP.git} (${BUILD_STAMP.builtAt})`);
    this.log(`connecting as ${username} -> ${serverUrl}`);
    this.deps.transport.setUsername(username);
    this.offMessage = this.deps.transport.onMessage((env) => void this.onEnvelope(env));
    this.offStateChange = this.deps.transport.onStateChange((s) => {
      const phase: CorePhase = s === 'connected' ? 'connected' : s === 'backoff' || s === 'connecting' ? 'connecting' : 'offline';
      if (phase !== this.state.phase) {
        this.state = { ...this.state, phase };
        this.log(`transport ${s}: ${this.deps.transport.lastError ?? ''}`);
      }
    });
    // Poll ticks are the reliable trigger for noticing a newly opened SwapNote.
    this.unsubTick = this.deps.transport.onTick?.(() => void this.maybeFlushSwapPages()) ?? null;
    this.deps.transport.start();
    this.notify();
  }

  stop(): void {
    this.offMessage?.(); this.offStateChange?.(); this.unsubTick?.();
    this.offMessage = null; this.offStateChange = null; this.unsubTick = null;
    this.deps.transport.close();
    this.state = { ...this.state, phase: 'closed' };
    this.notify();
  }

  async setServerUrl(url: string): Promise<void> {
    const trimmed = url.trim();
    if (trimmed === '') return;
    this.state = { ...this.state, serverUrl: trimmed };
    if (this.deps.store !== undefined && this.state.username !== '') {
      const saved = await this.deps.store.save({ serverUrl: trimmed, username: this.state.username });
      this.state = { ...this.state, storeError: saved ? null : 'config not persisted' };
    }
    this.log(`server set to ${trimmed} (restart plugin to apply)`);
  }

  private send(env: Envelope): void {
    this.deps.transport.send(env);
    this.state = { ...this.state, sent: this.state.sent + 1 };
    this.notify();
  }

  private async onEnvelope(env: Envelope): Promise<void> {
    switch (env.type) {
      case 'welcome': {
        const username = (env.payload as { username?: string }).username ?? this.state.username;
        if (username !== this.state.username) {
          this.state = { ...this.state, username };
          if (this.deps.store !== undefined) void this.deps.store.save({ serverUrl: this.state.serverUrl, username });
        }
        this.state = { ...this.state, phase: 'connected' };
        this.log(`connected as ${username}`);
        return;
      }
      case 'page.send': this.queuePage(env); return;
      case 'error': {
        const payload = env.payload as { code: string; message: string };
        this.log(`error: ${payload.code} ${payload.message}`);
        return;
      }
      default: return;
    }
  }

  private pageQueueTotal(): number {
    let total = 0;
    for (const queue of this.pageQueue.values()) total += queue.length;
    return total;
  }

  private pageQueueInfo(): { sender: string; count: number }[] {
    return [...this.pageQueue.entries()].map(([sender, queue]) => ({ sender, count: queue.length }));
  }

  private updatePageState(): void {
    this.state = { ...this.state, pagePending: this.pageQueueTotal(), pagePendingBySender: this.pageQueueInfo() };
    this.notify();
  }

  private queuePage(env: Envelope): void {
    if (this.knownPageIds.has(env.id)) { this.log(`page from ${env.from}: duplicate ${env.id}, ignored`); return; }
    this.knownPageIds.add(env.id);
    if (this.knownPageIds.size > 256) {
      const first = this.knownPageIds.values().next();
      if (!first.done) this.knownPageIds.delete(first.value);
    }
    const queue = this.pageQueue.get(env.from) ?? [];
    queue.push(env);
    this.pageQueue.set(env.from, queue);
    let overflow = this.pageQueueTotal() - MAX_QUEUED_PAGES;
    for (const [sender, pages] of this.pageQueue) {
      if (overflow <= 0) break;
      const drop = Math.min(overflow, pages.length);
      pages.splice(0, drop);
      overflow -= drop;
      this.log(`page queue full: dropped ${drop} oldest from ${sender}`);
      if (pages.length === 0) this.pageQueue.delete(sender);
    }
    void this.ensureSwapNote(env.from, 'sender');
    this.log(`page from ${env.from} queued (pages pending: ${this.pageQueueTotal()})`);
    this.updatePageState();
    void this.maybeFlushSwapPages();
  }

  private async maybeFlushSwapPages(): Promise<void> {
    if (this.swapFlushInFlight) return;
    const path = await this.deps.bridge.getCurrentFilePath();
    if (path === null || path === '') return;
    const sender = swapNoteSenderOf(path);
    if (sender !== null && (this.pageQueue.get(sender)?.length ?? 0) > 0) await this.appendQueuedPages(sender);
  }

  private async appendQueuedPages(sender: string): Promise<void> {
    if (this.swapFlushInFlight) return;
    this.swapFlushInFlight = true;
    try {
      const notePath = swapNotePathFor(sender);
      if (!(await this.ensureSwapNote(sender, 'append'))) { this.log(`append: swapnote-${sender}.note unavailable, pages kept queued`); return; }
      const total = await this.deps.bridge.getNoteTotalPageNum(notePath);
      if (total === null) { this.log(`append: cannot read swapnote-${sender}.note, pages kept queued`); return; }
      const batch = this.pageQueue.get(sender) ?? [];
      if (batch.length === 0) return;
      await this.deps.bridge.saveCurrentNote();
      const emr = await this.deps.bridge.getEmrSize();
      const ackedIds: string[] = [];
      let nextIndex = total;
      for (const env of batch) {
        const payload = env.payload as PageSendPayload;
        if (!(await this.deps.bridge.insertNotePage(notePath, nextIndex, await this.pageTemplateName()))) {
          this.log(`append: insertNotePage failed at ${nextIndex}; ${batch.length - ackedIds.length} page(s) kept queued`);
          break;
        }
        const size = (await this.deps.bridge.getPageSize(notePath, nextIndex)) ?? { width: 1920, height: 2560 };
        const elements: BridgeElement[] = [];
        for (const pageElement of payload.elements) {
          try {
            const element = pageElement.kind === 'stroke'
              ? await this.buildStrokeElement(nextIndex, pageElement.stroke, emr)
              : await this.buildTextElement(nextIndex, pageElement.text, size);
            if (element !== null) elements.push(element);
          } catch (err) { this.log(`append: element failed: ${(err as Error).message}`); }
        }
        let wrote = true;
        if (elements.length > 0) {
          wrote = await this.deps.bridge.insertElements(notePath, nextIndex, elements);
          if (!wrote) for (const element of elements) this.deps.bridge.recycleElement(element.uuid);
        }
        if (!wrote) { this.log(`append: page insert failed; ${batch.length - ackedIds.length} page(s) kept queued`); break; }
        ackedIds.push(env.id);
        this.log(`appended page from ${sender} (${elements.length} elements) as page ${nextIndex}`);
        nextIndex += 1;
      }
      const remaining = batch.slice(ackedIds.length);
      if (remaining.length === 0) this.pageQueue.delete(sender); else this.pageQueue.set(sender, remaining);
      if (ackedIds.length > 0) this.send(makeEnvelope(this.state.username, 'pages.ack', { pageIds: ackedIds }));
      await this.deps.bridge.reloadFile();
      if (ackedIds.length > 0) this.log(`appended ${ackedIds.length} page(s) from ${sender} to swapnote-${sender}.note`);
      this.updatePageState();
    } catch (err) {
      this.log(`append failed: ${(err as Error).message}`);
    } finally { this.swapFlushInFlight = false; }
  }

  private ensureSwapNote(username: string, why: string): Promise<boolean> {
    const inFlight = this.ensuringNotes.get(username);
    if (inFlight !== undefined) return inFlight;
    const promise = (async () => {
      const notePath = swapNotePathFor(username);
      try {
        if ((await this.deps.bridge.getNoteTotalPageNum(notePath)) !== null) return true;
        const created = await this.deps.bridge.createNote({ notePath, template: await this.pageTemplateName(), isPortrait: true });
        this.log(created ? `created ${notePath} (${why})` : `createNote ${notePath} failed (${why})`);
        return created;
      } catch (err) {
        this.log(`ensureSwapNote(${username}) ${notePath} failed: ${(err as Error).message}`);
        return false;
      } finally { this.ensuringNotes.delete(username); }
    })();
    this.ensuringNotes.set(username, promise);
    return promise;
  }

  private async pageTemplateName(): Promise<string> {
    try { return (await this.deps.bridge.getNoteSystemTemplates())[0]?.name ?? 'style_white'; }
    catch { return 'style_white'; }
  }

  /** Send the open page directly to a valid username, including offline recipients. */
  async sendCurrentPage(target: string): Promise<boolean> {
    const name = target.trim().toLowerCase();
    if (!isValidUsername(name)) { this.log('send: enter a valid recipient username'); return false; }
    const path = await this.deps.bridge.getCurrentFilePath();
    if (path === null || path === '') { this.log('send: no note open'); return false; }
    const page = await this.deps.bridge.getCurrentPageNum();
    if (page === null || page < 0) { this.log('send: no current page'); return false; }
    const source = await this.deps.bridge.getElements(page, path);
    if (source.length === 0) { this.log('send: page is empty, nothing to send'); return false; }
    const emr = await this.deps.bridge.getEmrSize();
    const size = await this.deps.bridge.getPageSize(path, page);
    const elements: PageElement[] = [];
    for (const element of source) {
      if (element.type === TYPE_STROKE && element.stroke !== null) {
        const count = await element.stroke.points.size();
        if (count < 2) continue;
        const points = await element.stroke.points.getRange(0, count);
        const pts = points.flatMap((point) => [clamp01(point.x / emr.width), clamp01(point.y / emr.height)]);
        let prs: number[] | undefined;
        try {
          const pressures = await element.stroke.pressures.getRange(0, count);
          if (pressures.length === count) prs = pressures.map(Math.round);
        } catch { prs = undefined; }
        elements.push({ kind: 'stroke', stroke: { sid: element.uuid, penColor: element.stroke.penColor, penType: element.stroke.penType, thickness: element.thickness, pts, ...(prs === undefined ? {} : { prs }) } satisfies PageStroke });
      } else if (element.type === TYPE_TEXT && element.textBox?.textContentFull && size !== null) {
        const rect = element.textBox.textRect;
        if (rect === undefined) continue;
        elements.push({ kind: 'text', text: {
          sid: element.uuid, text: element.textBox.textContentFull, fontSize: element.textBox.fontSize ?? 24,
          rect: { left: clamp01(rect.left / size.width), top: clamp01(rect.top / size.height), right: clamp01(rect.right / size.width), bottom: clamp01(rect.bottom / size.height) },
          textAlign: element.textBox.textAlign ?? 0, textFrameWidthType: element.textBox.textFrameWidthType ?? 1,
        } satisfies PageText });
      }
    }
    if (elements.length === 0) { this.log('send: page has nothing sendable'); return false; }
    this.send(makeEnvelope(this.state.username, 'page.send', { to: name, elements }));
    this.log(`sent page ${page} of ${path} to ${name} (${elements.length} elements)`);
    return true;
  }

  private async buildStrokeElement(page: number, stroke: PageStroke, emr: { width: number; height: number }): Promise<BridgeElement | null> {
    const element = await this.deps.bridge.createElement(TYPE_STROKE);
    if (element === null || element.stroke === null) return null;
    const points: { x: number; y: number }[] = [];
    let maxX = 0; let maxY = 0;
    for (let i = 0; i < stroke.pts.length; i += 2) {
      const x = Math.round(stroke.pts[i]! * emr.width);
      const y = Math.round(stroke.pts[i + 1]! * emr.height);
      points.push({ x, y }); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    element.thickness = stroke.thickness;
    element.pageNum = page;
    element.layerNum = 0;
    element.maxX = maxX;
    element.maxY = maxY;
    element.stroke.penColor = stroke.penColor;
    element.stroke.penType = stroke.penType;
    await element.stroke.points.setRange(0, points.length, points);
    await element.stroke.pressures.setRange(0, points.length, stroke.prs?.length === points.length ? [...stroke.prs] : points.map(() => 2048));
    if ((await element.stroke.points.size()) !== points.length) { this.deps.bridge.recycleElement(element.uuid); return null; }
    return element;
  }

  private async buildTextElement(page: number, text: PageText, size: { width: number; height: number }): Promise<BridgeElement | null> {
    const element = await this.deps.bridge.createElement(TYPE_TEXT);
    if (element === null || element.textBox === null) return null;
    const left = Math.round(text.rect.left * size.width);
    const top = Math.round(text.rect.top * size.height);
    const right = Math.round(text.rect.right * size.width);
    const bottom = Math.round(text.rect.bottom * size.height);
    element.pageNum = page; element.layerNum = 0; element.maxX = Math.max(right, 1); element.maxY = Math.max(bottom, 1);
    element.textBox = { ...element.textBox, fontSize: text.fontSize, textContentFull: text.text, textRect: { left, top, right, bottom }, textAlign: text.textAlign, textFrameWidthType: text.textFrameWidthType };
    return element;
  }
}

function clamp01(n: number): number { return Math.min(1, Math.max(0, n)); }
