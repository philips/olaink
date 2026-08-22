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
  type SessionStateMember,
  type StrokePayload,
  type StrokesPayload,
  type Transport,
  generateUsername,
  makeEnvelope,
} from '@wrtn/protocol';
import type { BridgeElement, DeviceBridge } from '../device/types.ts';
import { TYPE_STROKE } from '../device/types.ts';
import type { StoredConfig } from './noteStore.ts';

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
    this.deps.transport.start();
    this.syncPullButton();
    this.notify();
  }

  stop(): void {
    this.unsubPenUp?.();
    this.offMessage?.();
    this.offStateChange?.();
    this.unsubPenUp = null;
    this.offMessage = null;
    this.offStateChange = null;
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
   * Keep the pull toolbar button's enabled state in sync with the queue:
   * lit (enabled) when strokes are waiting, grayed (disabled) when idle.
   * This is the "notification symbol" — the SDK exposes no icon/badge
   * update API, only setButtonState.
   */
  private syncPullButton(): void {
    const enabled = this.pendingQueue.length > 0;
    if (this.pullButtonState === enabled) return;
    this.pullButtonState = enabled;
    void this.deps.bridge.setPullEnabled?.(enabled);
  }

  /**
   * Build a device stroke element for wire stroke `s` (no file I/O). The
   * element stays in the native cache until insertElements commits it.
   * Returns null when the element can't be built (logged).
   */
  private async buildStrokeElement(
    page: number,
    s: StrokePayload,
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
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
