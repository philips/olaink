/**
 * WRTN session controller — the heart of the plugin.
 *
 * Owns the transport, pen capture, remote-stroke rendering, and session
 * state. Deliberately free of React Native imports so it runs under Vitest
 * against the StubDevice; App.tsx only renders snapshots of `state`.
 *
 * Inbound rendering is MANUAL (issue: auto-reload on every remote stroke
 * flashed the page mid-writing and could discard in-progress ink). Remote
 * strokes are queued in memory; `pullPending()` flushes them with a single
 * save → insert → reloadFile cycle (one screen flash per pull).
 *
 * Loop protection: strokes we insert from remote users also trigger
 * event_pen_up on-device. Two guards:
 *   1. uuid set of elements we just created (cheap, exact)
 *   2. a short suppression window after insert+reload (covers uuid changes
 *      across reloadFile, which the SDK is known to do)
 */

import {
  type Envelope,
  type PageElement,
  type PageSendPayload,
  type PageStroke,
  type PageText,
  type SessionStateMember,
  type StrokePayload,
  type StrokesPayload,
  type Transport,
  generateUsername,
  makeEnvelope,
} from '@wrtn/protocol';
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
  members: SessionStateMember[];
  log: string[];
  sent: number;
  received: number;
  /** Remote strokes queued, awaiting a manual pull (see pullPending). */
  pending: number;
  /** Pages queued from senders, awaiting append to their SwapNote. */
  pagePending: number;
  /** Per-sender breakdown of queued pages (for the setup view). */
  pagePendingBySender: { sender: string; count: number }[];
  storeError: string | null;
}

export interface WrtnCoreDeps {
  bridge: DeviceBridge;
  transport: Transport;
  store?: {
    load(): Promise<StoredConfig | null>;
    save(cfg: StoredConfig): Promise<boolean>;
  };
  defaultServerUrl: string;
  now?: () => number;
}

const SUPPRESS_MS = 1000;

/** Bounded queue: drops the oldest strokes once exceeded (logged). */
const MAX_PENDING_STROKES = 200;

/** Bounded queue for received pages awaiting append (logged on drop). */
const MAX_QUEUED_PAGES = 50;

export class WrtnCore {
  public state: CoreState;

  private readonly deps: WrtnCoreDeps;
  private readonly now: () => number;
  private unsubPenUp: (() => void) | null = null;
  private offMessage: (() => void) | null = null;
  private offStateChange: (() => void) | null = null;
  private readonly insertedUuids = new Set<string>();
  private suppressUntil = 0;
  private capturing = false;
  private pulling = false;
  private notifyScheduled = false;
  private pendingQueue: { from: string; stroke: StrokePayload }[] = [];
  private droppedLogged = false;
  private pullButtonState: boolean | null = null;
  // -- SwapNote page transfer (issue #2) ----------------------------------
  /** Received pages awaiting append, keyed by sender username (arrival order). */
  private readonly pageQueue = new Map<string, Envelope[]>();
  /** Envelope ids already seen (dedup across server re-delivery). Bounded. */
  private readonly knownPageIds = new Set<string>();
  private swapFlushInFlight = false;
  /** In-flight ensureSwapNote promises (one per username). */
  private readonly ensuringNotes = new Map<string, Promise<boolean>>();
  /** Real members seen in session.state (note pre-creation tracking). */
  private readonly seenMembers = new Set<string>();
  private unsubTick: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(deps: WrtnCoreDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.state = {
      phase: 'starting',
      serverUrl: deps.defaultServerUrl,
      username: '',
      members: [],
      log: [],
      sent: 0,
      received: 0,
      pending: 0,
      pagePending: 0,
      pagePendingBySender: [],
      storeError: null,
    };
  }

  /** Subscribe to state changes (coalesced). Returns unsubscribe. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    const flush = () => {
      this.notifyScheduled = false;
      for (const cb of this.listeners) cb();
    };
    // Coalesce bursts within a tick.
    Promise.resolve().then(() => queueMicrotask(flush));
  }

  private log(line: string): void {
    console.log(`[wrtn] ${line}`);
    this.state = {
      ...this.state,
      log: [...this.state.log.slice(-40), `${new Date(this.now()).toISOString().slice(11, 19)} ${line}`],
    };
    this.notify();
  }

  // -- lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    let cfg: StoredConfig | null = null;
    if (this.deps.store !== undefined) {
      try {
        cfg = await this.deps.store.load();
      } catch {
        cfg = null;
      }
    }

    let username = cfg?.username ?? '';
    let serverUrl = cfg?.serverUrl ?? this.deps.defaultServerUrl;
    let storeError: string | null = null;
    if (this.deps.store !== undefined && cfg === null) {
      // No stored config: mint a username and persist best-effort.
      username = generateUsername();
      const saved = await this.deps.store.save({ serverUrl, username });
      if (!saved) storeError = 'config not persisted; username will change';
    }
    if (username === '') username = generateUsername();

    this.state = { ...this.state, username, serverUrl, storeError, phase: 'connecting' };
    this.log(`build ${BUILD_STAMP.git} (${BUILD_STAMP.builtAt})`);
    this.log(`joining as ${username} -> ${serverUrl}`);

    this.deps.transport.setUsername(username);
    this.offMessage = this.deps.transport.onMessage((env) => void this.onEnvelope(env));
    this.offStateChange = this.deps.transport.onStateChange((s) => {
      const phase: CorePhase =
        s === 'connected' ? 'connected' : s === 'backoff' || s === 'connecting' ? 'connecting' : 'offline';
      if (phase !== this.state.phase) {
        this.state = { ...this.state, phase };
        this.log(`transport ${s}: ${this.deps.transport.lastError ?? ''}`);
        this.notify();
      }
    });
    this.unsubPenUp = this.deps.bridge.registerPenUp(() => void this.onPenUp());
    // Poll round-trips are the only "timer" in the plugin runtime (no
    // working setTimeout): use each tick to notice the user opened a
    // SwapNote with queued pages, and append them (issue #2).
    this.unsubTick = this.deps.transport.onTick?.(() => void this.maybeFlushSwapPages()) ?? null;
    this.deps.transport.start();
    this.syncPullButton();
    this.notify();
  }

  stop(): void {
    this.unsubPenUp?.();
    this.offMessage?.();
    this.offStateChange?.();
    this.unsubTick?.();
    this.unsubPenUp = null;
    this.offMessage = null;
    this.offStateChange = null;
    this.unsubTick = null;
    this.deps.transport.close();
    this.state = { ...this.state, phase: 'closed' };
    this.notify();
  }

  // -- session operations (UI entry points) --------------------------------

  addUser(target: string): void {
    const name = target.trim().toLowerCase();
    if (name === '') return;
    this.send(makeEnvelope(this.state.username, 'session.add', { target: name }));
    this.log(`invited ${name}`);
  }

  leave(): void {
    this.send(makeEnvelope(this.state.username, 'session.leave', {}));
    this.state = { ...this.state, members: [] };
    this.notify();
  }

  /** Change the server URL (persists, requires restart to take effect). */
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

  // -- inbound -------------------------------------------------------------

  private async onEnvelope(env: Envelope): Promise<void> {
    switch (env.type) {
      case 'welcome': {
        const username = (env.payload as { username?: string }).username ?? this.state.username;
        if (username !== this.state.username) {
          // Server renamed us (collision); persist the new identity.
          this.state = { ...this.state, username };
          if (this.deps.store !== undefined) {
            void this.deps.store.save({ serverUrl: this.state.serverUrl, username });
          }
        }
        this.state = { ...this.state, phase: 'connected' };
        this.log(`connected as ${username}`);
        this.notify();
        // v1 onboarding: solo sessions get the echo bot so there is always
        // someone to exchange strokes with.
        if (this.state.members.length === 0) {
          this.send(makeEnvelope(username, 'session.add', { target: 'echo' }));
          this.log('invited echo');
        }
        return;
      }
      case 'session.state': {
        const payload = env.payload as { owner: string; members: SessionStateMember[] };
        this.state = { ...this.state, members: payload.members };
        this.log(`session: ${payload.members.map((m) => m.username).join(', ')}`);
        // Pre-create /storage/emulated/0/INBOX/swapnote-<user>.note for each newly-seen real peer (issue #2
        // UX: "each user you accept an invite from will have a note").
        for (const m of payload.members) {
          if (m.username === this.state.username || m.virtual) continue;
          if (!this.seenMembers.has(m.username)) {
            this.seenMembers.add(m.username);
            void this.ensureSwapNote(m.username, 'member');
          }
        }
        // If we end up solo (e.g. after another user leaves our shared
        // session, or a peer connection broke), re-join the echo bot so
        // there is always someone to exchange strokes with.
        const realOthers = payload.members.filter(
          (m) => m.username !== this.state.username && !m.virtual,
        );
        if (realOthers.length === 0 && !payload.members.some((m) => m.username === 'echo')) {
          this.send(makeEnvelope(this.state.username, 'session.add', { target: 'echo' }));
          this.log('re-invited echo (solo)');
        }
        this.notify();
        return;
      }
      case 'strokes': {
        this.queueStrokes(env.from, env.payload as StrokesPayload);
        return;
      }
      case 'page.send': {
        this.queuePage(env);
        return;
      }
      case 'error': {
        const payload = env.payload as { code: string; message: string };
        this.log(`error: ${payload.code} ${payload.message}`);
        return;
      }
      default:
        return;
    }
  }

  // -- capture -------------------------------------------------------------

  private async onPenUp(): Promise<void> {
    if (this.capturing) return;
    if (this.now() < this.suppressUntil) return;
    this.capturing = true;
    try {
      const el = await this.deps.bridge.getLastElement();
      if (el === null || el.type !== TYPE_STROKE || el.stroke === null) return;
      if (this.insertedUuids.has(el.uuid)) {
        this.insertedUuids.delete(el.uuid);
        return;
      }

      const path = await this.deps.bridge.getCurrentFilePath();
      if (path === null || path === '') return;
      const page = el.pageNum;

      const count = await el.stroke.points.size();
      if (count < 2) return;
      const pts = await el.stroke.points.getRange(0, count);
      // Normalize to 0..1 by the device's EMR range — device-independent wire format.
      const emr = await this.deps.bridge.getEmrSize();
      const flat: number[] = [];
      for (const p of pts) {
        flat.push(clamp01(p.x / emr.width), clamp01(p.y / emr.height));
      }
      let prs: number[] | undefined;
      try {
        const pressures = await el.stroke.pressures.getRange(0, count);
        if (pressures.length === count) prs = pressures.map((p) => Math.round(p));
      } catch {
        prs = undefined;
      }

      const stroke: StrokePayload = {
        sid: el.uuid,
        page,
        layer: el.layerNum,
        penColor: el.stroke.penColor,
        penType: el.stroke.penType,
        thickness: el.thickness,
        pts: flat,
        ...(prs !== undefined ? { prs: prs.map((p) => Math.round(p)) } : {}),
      };
      this.send(makeEnvelope(this.state.username, 'strokes', { strokes: [stroke] }));
      this.log(`sent stroke (${flat.length / 2} pts)`);
    } catch (err) {
      this.log(`capture failed: ${(err as Error).message}`);
    } finally {
      this.capturing = false;
      // The user may just have started writing in a SwapNote with queued
      // pages: append them in the background (capture above already ran,
      // so the loop guard set by the flush can't eat this stroke).
      void this.maybeFlushSwapPages();
    }
  }

  // -- queue + manual pull ---------------------------------------------------

  /**
   * Queue incoming remote strokes. Deliberately touches no device APIs: the
   * note stays exactly as the user left it until they pull (see issue #1 —
   * auto save/insert/reloadFile per stroke flashed the page and risked
   * discarding in-progress ink).
   */
  private queueStrokes(from: string, payload: StrokesPayload): void {
    for (const s of payload.strokes) {
      this.pendingQueue.push({ from, stroke: s });
    }
    if (this.pendingQueue.length > MAX_PENDING_STROKES) {
      const dropped = this.pendingQueue.length - MAX_PENDING_STROKES;
      this.pendingQueue.splice(0, dropped);
      if (!this.droppedLogged) {
        this.log(`pending queue full: dropped ${dropped} oldest stroke(s)`);
        this.droppedLogged = true;
      }
    }
    const n = this.pendingQueue.length;
    this.state = { ...this.state, pending: n };
    this.log(`queued stroke(s) from ${from} (pending: ${n})`);
    this.syncPullButton();
    this.notify();
  }

  /**
   * Manual pull (toolbar "WRTN Pull" button / setup view): flush the pending
   * queue into the current page with ONE save → insert → reloadFile cycle,
   * i.e. one screen flash per pull instead of one per received stroke.
   *
   * v1 semantics: strokes land on the page the receiver is looking at PULL
   * TIME (the sender's page index is meaningless across devices/notes).
   * If no note is open, the queue is kept for the next pull.
   */
  async pullPending(): Promise<void> {
    if (this.pulling) return;
    if (this.pendingQueue.length === 0) {
      this.log('pull: nothing pending');
      return;
    }
    this.pulling = true;
    try {
      const path = await this.deps.bridge.getCurrentFilePath();
      if (path === null || path === '') {
        this.log(`pull: no note open — keeping ${this.pendingQueue.length} stroke(s) queued`);
        return;
      }
      // SwapNote pages for this note append first (each becomes a NEW page,
      // so the current page index used below for strokes is unaffected).
      const openSender = swapNoteSenderOf(path);
      if (openSender !== null) await this.maybeFlushSwapPages();
      const curPage = await this.deps.bridge.getCurrentPageNum();
      const page = curPage !== null && curPage >= 0 ? curPage : 0;

      // Flush the user's in-memory ink to the file before touching it (per
      // SDK: saveCurrentNote before file APIs; also prevents reloadFile from
      // discarding unsaved drawn strokes).
      await this.deps.bridge.saveCurrentNote();
      const batch = this.pendingQueue;
      this.pendingQueue = [];
      this.droppedLogged = false;
      const emr = await this.deps.bridge.getEmrSize();

      // Build every element first, then commit with ONE insertElements call.
      // E2E (2026-08-21, host logs): the note app reloads the visible page
      // after EVERY insertElements (clearPageStatus → isNeedReloadLayers →
      // full refreshBitmap), so per-stroke inserts flash once per stroke.
      const els: BridgeElement[] = [];
      for (const { from, stroke } of batch) {
        let el: BridgeElement | null = null;
        try {
          el = await this.buildStrokeElement(page, stroke, emr);
        } catch (err) {
          this.log(`pull: render failed: ${(err as Error).message}`);
        }
        if (el === null) this.log(`pull: dropped stroke from ${from}`);
        else els.push(el);
      }
      let drawn = 0;
      if (els.length > 0) {
        // Loop guards BEFORE insert: the device may fire event_pen_up while
        // insertElements commits.
        for (const el of els) this.insertedUuids.add(el.uuid);
        this.suppressUntil = this.now() + SUPPRESS_MS;
        const inserted = await this.deps.bridge.insertElements(path, page, els);
        if (inserted) {
          drawn = els.length;
          // reloadFile guarantees the ink is visible (the host's post-insert
          // reload can lag or be skipped; without it the live view is stale).
          await this.deps.bridge.reloadFile();
          this.log(`pulled: drew ${drawn} stroke(s) on page ${page}`);
        } else {
          for (const el of els) {
            this.insertedUuids.delete(el.uuid);
            this.deps.bridge.recycleElement(el.uuid);
          }
          this.log(`pull: 0 of ${batch.length} stroke(s) rendered`);
        }
        // Keep the uuid set small.
        if (this.insertedUuids.size > 64) {
          const iter = this.insertedUuids.values().next();
          if (!iter.done) this.insertedUuids.delete(iter.value);
        }
      } else {
        this.log(`pull: 0 of ${batch.length} stroke(s) rendered`);
      }
      this.state = {
        ...this.state,
        pending: 0,
        received: this.state.received + drawn,
      };
      this.syncPullButton();
      this.notify();
    } finally {
      this.pulling = false;
    }
  }

  /**
   * Keep the pull toolbar button's enabled state in sync with the queues:
   * lit (enabled) when strokes OR pages are waiting, grayed (disabled) when
   * idle. This is the "notification symbol" — the SDK exposes no icon/badge
   * update API, only setButtonState.
   */
  private syncPullButton(): void {
    const enabled = this.pendingQueue.length > 0 || this.pageQueueTotal() > 0;
    if (this.pullButtonState === enabled) return;
    this.pullButtonState = enabled;
    void this.deps.bridge.setPullEnabled?.(enabled);
  }

  // -- SwapNote page transfer (issue #2) ------------------------------------

  private pageQueueTotal(): number {
    let n = 0;
    for (const q of this.pageQueue.values()) n += q.length;
    return n;
  }

  private pageQueueInfo(): { sender: string; count: number }[] {
    return [...this.pageQueue.entries()].map(([sender, q]) => ({ sender, count: q.length }));
  }

  /**
   * Queue a received page.send (dedup by envelope id — the server re-delivers
   * un-acked pages on reconnect). If the sender's SwapNote is the note that
   * is OPEN right now, append immediately ("auto-append even while reading");
   * otherwise the pages wait until that note is opened.
   */
  private queuePage(env: Envelope): void {
    if (this.knownPageIds.has(env.id)) {
      this.log(`page from ${env.from}: duplicate ${env.id}, ignored`);
      return;
    }
    this.knownPageIds.add(env.id);
    if (this.knownPageIds.size > 256) {
      const iter = this.knownPageIds.values().next();
      if (!iter.done) this.knownPageIds.delete(iter.value);
    }
    const q = this.pageQueue.get(env.from) ?? [];
    q.push(env);
    this.pageQueue.set(env.from, q);
    if (this.pageQueueTotal() > MAX_QUEUED_PAGES) {
      const overflow = this.pageQueueTotal() - MAX_QUEUED_PAGES;
      for (const [sender, pages] of this.pageQueue) {
        const drop = Math.min(overflow, pages.length);
        if (drop <= 0) continue;
        pages.splice(0, drop);
        this.log(`page queue full: dropped ${drop} oldest from ${sender}`);
        if (pages.length === 0) this.pageQueue.delete(sender);
        else break;
      }
    }
    // The note for this sender should exist (created on demand).
    void this.ensureSwapNote(env.from, 'sender');
    const total = this.pageQueueTotal();
    this.state = {
      ...this.state,
      pagePending: total,
      pagePendingBySender: this.pageQueueInfo(),
    };
    this.log(`page from ${env.from} queued (pages pending: ${total})`);
    this.syncPullButton();
    this.notify();
    void this.maybeFlushSwapPages();
  }

  /**
   * If the currently-open note is a SwapNote with queued pages from that
   * sender, append them. Called on every poll tick (the only timer the
   * runtime has), on pen-up, and from pullPending.
   */
  private async maybeFlushSwapPages(): Promise<void> {
    if (this.swapFlushInFlight) return;
    const path = await this.deps.bridge.getCurrentFilePath();
    if (path === null || path === '') return;
    const sender = swapNoteSenderOf(path);
    if (sender === null) return;
    const q = this.pageQueue.get(sender);
    if (q === undefined || q.length === 0) return;
    await this.appendQueuedPages(sender);
  }

  /**
   * Append every page queued from `sender` as NEW pages at the end of
   * /storage/emulated/0/INBOX/swapnote-<sender>.note, then ack the written ones so the server drops
   * them from its mailbox. One saveCurrentNote up front, ONE reloadFile at
   * the end (each insertElements into a non-visible page may still nudge the
   * host; a single final reload guarantees the new pages are shown).
   */
  private async appendQueuedPages(sender: string): Promise<void> {
    if (this.swapFlushInFlight) return;
    this.swapFlushInFlight = true;
    try {
      const notePath = swapNotePathFor(sender);
      if (!(await this.ensureSwapNote(sender, 'append'))) {
        this.log(`append: swapnote-${sender}.note unavailable, pages kept queued`);
        return;
      }
      const total0 = await this.deps.bridge.getNoteTotalPageNum(notePath);
      if (total0 === null) {
        this.log(`append: cannot read swapnote-${sender}.note, pages kept queued`);
        return;
      }
      const batch = this.pageQueue.get(sender) ?? [];
      if (batch.length === 0) return;
      // Loop guard BEFORE any insert: the device fires event_pen_up while
      // insertElements commits (see pullPending). Suppressing up front keeps
      // the appended strokes from being re-captured and re-sent as live
      // strokes. Cost: a genuine pen-up during the ~1s flush is dropped.
      this.suppressUntil = this.now() + SUPPRESS_MS;
      await this.deps.bridge.saveCurrentNote();
      const emr = await this.deps.bridge.getEmrSize();
      const ackedIds: string[] = [];
      let nextIndex = total0;
      for (const env of batch) {
        const payload = env.payload as PageSendPayload;
        const insertedPage = await this.deps.bridge.insertNotePage(
          notePath,
          nextIndex,
          await this.pageTemplateName(),
        );
        if (!insertedPage) {
          this.log(`append: insertNotePage failed at ${nextIndex}; ${batch.length - ackedIds.length} page(s) kept queued`);
          break;
        }
        const size =
          (await this.deps.bridge.getPageSize(notePath, nextIndex)) ?? { width: 1920, height: 2560 };
        const els: BridgeElement[] = [];
        for (const pe of payload.elements) {
          let el: BridgeElement | null = null;
          try {
            el =
              pe.kind === 'stroke'
                ? await this.buildStrokeElement(nextIndex, pe.stroke, emr)
                : await this.buildTextElement(nextIndex, pe.text, size);
          } catch (err) {
            this.log(`append: element failed: ${(err as Error).message}`);
          }
          if (el !== null) els.push(el);
        }
        // insertElements into an EMPTY page would 106; a page with no
        // sendable elements still stands (it was just inserted).
        let wrote = true;
        if (els.length > 0) {
          for (const el of els) this.insertedUuids.add(el.uuid);
          wrote = await this.deps.bridge.insertElements(notePath, nextIndex, els);
          if (!wrote) {
            for (const el of els) {
              this.insertedUuids.delete(el.uuid);
              this.deps.bridge.recycleElement(el.uuid);
            }
          }
        }
        if (!wrote) {
          this.log(`append: page insert failed; ${batch.length - ackedIds.length} page(s) kept queued`);
          break;
        }
        const writtenAt = nextIndex;
        nextIndex += 1;
        ackedIds.push(env.id);
        this.log(`appended page from ${sender} (${els.length} elements) as page ${writtenAt}`);
      }
      const written = batch.slice(0, ackedIds.length);
      const remaining = batch.slice(written.length);
      if (remaining.length === 0) this.pageQueue.delete(sender);
      else this.pageQueue.set(sender, remaining);
      if (ackedIds.length > 0) {
        this.send(makeEnvelope(this.state.username, 'pages.ack', { pageIds: ackedIds }));
      }
      // The loop guard above already covered the inserts; one final reload
      // guarantees the new pages are shown (the host's post-insert reload can
      // lag or be skipped).
      await this.deps.bridge.reloadFile();
      if (ackedIds.length > 0) {
        this.log(`appended ${ackedIds.length} page(s) from ${sender} to swapnote-${sender}.note`);
      }
      this.state = {
        ...this.state,
        pagePending: this.pageQueueTotal(),
        pagePendingBySender: this.pageQueueInfo(),
      };
      this.syncPullButton();
      this.notify();
    } catch (err) {
      this.log(`append failed: ${(err as Error).message}`);
    } finally {
      this.swapFlushInFlight = false;
    }
  }

  /**
   * Ensure /storage/emulated/0/INBOX/swapnote-<username>.note exists (created with the first system
   * template, portrait). Non-fatal: callers keep pages queued on failure.
   */
  private ensureSwapNote(username: string, why: string): Promise<boolean> {
    const inFlight = this.ensuringNotes.get(username);
    if (inFlight !== undefined) return inFlight;
    const p = (async (): Promise<boolean> => {
      const notePath = swapNotePathFor(username);
      try {
        const total = await this.deps.bridge.getNoteTotalPageNum(notePath);
        if (total !== null) return true;
        const template = await this.pageTemplateName();
        const created = await this.deps.bridge.createNote({
          notePath,
          template,
          isPortrait: true,
        });
        this.log(
          created
            ? `created ${notePath} (${why})`
            : `createNote ${notePath} failed (${why})`,
        );
        return created;
      } catch (err) {
        this.log(`ensureSwapNote(${username}) ${notePath} failed: ${(err as Error).message}`);
        return false;
      } finally {
        this.ensuringNotes.delete(username);
      }
    })();
    this.ensuringNotes.set(username, p);
    return p;
  }

  /**
   * Page template for createNote: first system template, 'style_white'
   * fallback. ('blank' is NOT a real template name on-device — createNote
   * rejects it with 802 "Background template file does not exist".
   * 'style_white' is the first entry of the on-device list, i.e. the blank
   * page; verified 2026-08-23.)
   */
  private async pageTemplateName(): Promise<string> {
    try {
      const templates = await this.deps.bridge.getNoteSystemTemplates();
      return templates[0]?.name ?? 'style_white';
    } catch {
      return 'style_white';
    }
  }

  /**
   * Send the CURRENT page of the open note, whole, to one user (issue #2).
   * Strokes are normalized by this device's EMR range; text boxes by the
   * page pixel size. The receiver appends it to their /storage/emulated/0/INBOX/swapnote-<us>.note.
   * Returns true when the page was put on the wire.
   */
  async sendCurrentPage(target: string): Promise<boolean> {
    const name = target.trim().toLowerCase();
    if (name === '') return false;
    const path = await this.deps.bridge.getCurrentFilePath();
    if (path === null || path === '') {
      this.log('send: no note open');
      return false;
    }
    const page = await this.deps.bridge.getCurrentPageNum();
    if (page === null || page < 0) {
      this.log('send: no current page');
      return false;
    }
    const elements = await this.deps.bridge.getElements(page, path);
    if (elements.length === 0) {
      this.log('send: page is empty, nothing to send');
      return false;
    }
    const emr = await this.deps.bridge.getEmrSize();
    const size = await this.deps.bridge.getPageSize(path, page);
    const els: PageElement[] = [];
    for (const el of elements) {
      if (el.type === TYPE_STROKE && el.stroke !== null) {
        const count = await el.stroke.points.size();
        if (count < 2) continue;
        const pts = await el.stroke.points.getRange(0, count);
        const flat: number[] = [];
        for (const p of pts) {
          flat.push(clamp01(p.x / emr.width), clamp01(p.y / emr.height));
        }
        let prs: number[] | undefined;
        try {
          const pressures = await el.stroke.pressures.getRange(0, count);
          if (pressures.length === count) prs = pressures.map((p) => Math.round(p));
        } catch {
          prs = undefined;
        }
        els.push({
          kind: 'stroke',
          stroke: {
            sid: el.uuid,
            penColor: el.stroke.penColor,
            penType: el.stroke.penType,
            thickness: el.thickness,
            pts: flat,
            ...(prs !== undefined ? { prs } : {}),
          } satisfies PageStroke,
        });
      } else if (
        el.type === TYPE_TEXT &&
        el.textBox !== null &&
        el.textBox.textContentFull !== null &&
        el.textBox.textContentFull !== '' &&
        size !== null
      ) {
        const r = el.textBox.textRect;
        if (r === undefined) continue;
        els.push({
          kind: 'text',
          text: {
            sid: el.uuid,
            text: el.textBox.textContentFull,
            fontSize: el.textBox.fontSize ?? 24,
            rect: {
              left: clamp01(r.left / size.width),
              top: clamp01(r.top / size.height),
              right: clamp01(r.right / size.width),
              bottom: clamp01(r.bottom / size.height),
            },
            textAlign: el.textBox.textAlign ?? 0,
            textFrameWidthType: el.textBox.textFrameWidthType ?? 1,
          } satisfies PageText,
        });
      }
    }
    if (els.length === 0) {
      this.log('send: page has nothing sendable');
      return false;
    }
    this.send(makeEnvelope(this.state.username, 'page.send', { to: name, elements: els }));
    this.log(`sent page ${page} of ${path} to ${name} (${els.length} elements)`);
    return true;
  }

  /**
   * Build a device stroke element for a wire stroke (no file I/O). The
   * element stays in the native cache until insertElements commits it.
   * Returns null when the element can't be built (logged).
   *
   * Accepts the stroke shape shared by StrokePayload and PageStroke.
   */
  private async buildStrokeElement(
    page: number,
    s: Pick<StrokePayload, 'penColor' | 'penType' | 'thickness' | 'pts'> & { prs?: number[] },
    emr: { width: number; height: number },
  ): Promise<BridgeElement | null> {
    // E2E-verified recipe (2026-08-21):
    //  - createElement + setRange(0, N, pts): the native REPLACE branch does
    //    remove-loop (no-op on empty) + addAll + resolve(true) — the only
    //    point-write opcode pair that both inserts AND resolves.
    //    (add()/INSERT_POINT_AT_INDEX inserts but never resolves its promise;
    //    arrays in plain objects are rejected by the JS schema at 107.)
    //  - layerNum must be 0 (Main Layer) — deleted/absent layers make the
    //    note app silently drop the trail (insertCount:0).
    //  - maxX/maxY must be non-zero or the trail is dropped.
    const el = await this.deps.bridge.createElement(TYPE_STROKE);
    if (el === null || el.stroke === null) return null;

    // Denormalize 0..1 back to this device's EMR coordinates.
    const points: { x: number; y: number }[] = [];
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < s.pts.length; i += 2) {
      const x = Math.round(s.pts[i]! * emr.width);
      const y = Math.round(s.pts[i + 1]! * emr.height);
      points.push({ x, y });
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const pressures =
      s.prs !== undefined && s.prs.length === points.length ? [...s.prs] : points.map(() => 2048);

    el.thickness = s.thickness;
    el.pageNum = page;
    el.layerNum = 0; // Main Layer (see note above)
    el.maxX = maxX;
    el.maxY = maxY;
    el.stroke.penColor = s.penColor;
    el.stroke.penType = s.penType;
    await el.stroke.points.setRange(0, points.length, points);
    await el.stroke.pressures.setRange(0, pressures.length, pressures);
    const got = await el.stroke.points.size();
    if (got !== points.length) {
      this.log(`point setRange failed: ${got}/${points.length}`);
      this.deps.bridge.recycleElement(el.uuid);
      return null;
    }
    return el;
  }

  /**
   * Build a device text-box element from a wire PageText (no file I/O).
   */
  private async buildTextElement(
    page: number,
    t: PageText,
    size: { width: number; height: number },
  ): Promise<BridgeElement | null> {
    const el = await this.deps.bridge.createElement(TYPE_TEXT);
    if (el === null || el.textBox === null) return null;
    const left = Math.round(t.rect.left * size.width);
    const top = Math.round(t.rect.top * size.height);
    const right = Math.round(t.rect.right * size.width);
    const bottom = Math.round(t.rect.bottom * size.height);
    el.pageNum = page;
    el.layerNum = 0;
    el.maxX = Math.max(right, 1);
    el.maxY = Math.max(bottom, 1);
    el.textBox = {
      ...el.textBox,
      fontSize: t.fontSize,
      textContentFull: t.text,
      textRect: { left, top, right, bottom },
      textAlign: t.textAlign,
      textFrameWidthType: t.textFrameWidthType,
    };
    return el;
  }
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
