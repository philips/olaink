/**
 * WRTN session controller — the heart of the plugin.
 *
 * Owns the transport, pen capture, remote-stroke rendering, and session
 * state. Deliberately free of React Native imports so it runs under Vitest
 * against the StubDevice; App.tsx only renders snapshots of `state`.
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
import type { DeviceBridge } from '../device/types.ts';
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
  private notifyScheduled = false;
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
        this.notify();
        return;
      }
      case 'strokes': {
        console.log(`[wrtn] strokes env from ${env.from} (${(env.payload as StrokesPayload).strokes.length} strokes)`);
        await this.renderStrokes(env.from, env.payload as StrokesPayload);
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

  // -- render --------------------------------------------------------------

  private async renderStrokes(from: string, payload: StrokesPayload): Promise<void> {
    console.log('[wrtn] renderStrokes: getting current note path…');
    const path = await this.deps.bridge.getCurrentFilePath();
    console.log(`[wrtn] renderStrokes: path=${path}`);
    if (path === null || path === '') {
      this.log(`strokes from ${from} dropped (no note open)`);
      return;
    }
    let drawn = 0;
    for (const s of payload.strokes) {
      try {
        const created = await this.insertStroke(path, s);
        if (created) drawn++;
      } catch (err) {
        this.log(`render failed: ${(err as Error).message}`);
      }
    }
    if (drawn > 0) {
      this.state = { ...this.state, received: this.state.received + drawn };
      this.log(`drew ${drawn} stroke(s) from ${from}`);
      this.notify();
    }
  }

  private async insertStroke(notePath: string, s: StrokePayload): Promise<boolean> {
    const el = await this.deps.bridge.createElement(TYPE_STROKE);
    if (el === null || el.stroke === null) return false;

    el.thickness = s.thickness;
    el.layerNum = s.layer;
    el.stroke.penColor = s.penColor;
    el.stroke.penType = s.penType;

    // Denormalize 0..1 back to this device's EMR coordinates.
    const emr = await this.deps.bridge.getEmrSize();
    const points = [];
    for (let i = 0; i < s.pts.length; i += 2) {
      points.push({
        x: Math.round(s.pts[i]! * emr.width),
        y: Math.round(s.pts[i + 1]! * emr.height),
      });
    }
    // NOTE: setRange is REPLACE_POINT_AT_INDEX — a no-op on a fresh element
    // (size 0, returns success, inserts nothing). Points must be INSERTED.
    for (let i = 0; i < points.length; i++) {
      const ok = await el.stroke.points.add(i, points[i]!);
      if (!ok) this.log(`point add ${i} returned false`);
    }
    console.log(`[wrtn] points added (${points.length}), pressures…`);
    if (s.prs !== undefined && s.prs.length === points.length) {
      for (let i = 0; i < s.prs.length; i++) {
        await el.stroke.pressures.add(i, s.prs[i]!);
      }
    }
    const got = await el.stroke.points.size();
    console.log(`[wrtn] points.size after add: ${got}/${points.length}`);
    if (got !== points.length) {
      this.log(`points mismatch after add: ${got}/${points.length}`);
    }

    // Loop guards BEFORE insert: the device fires event_pen_up while
    // insertElements commits, i.e. before post-insert code runs.
    this.insertedUuids.add(el.uuid);
    this.suppressUntil = this.now() + SUPPRESS_MS;

    const inserted = await this.deps.bridge.insertElements(notePath, s.page, [el]);

    this.deps.bridge.recycleElement(el.uuid);
    if (inserted) {
      await this.deps.bridge.saveCurrentNote();
      await this.deps.bridge.reloadFile();
    } else {
      this.insertedUuids.delete(el.uuid);
    }
    // Keep the uuid set small.
    if (this.insertedUuids.size > 64) {
      const iter = this.insertedUuids.values().next();
      if (!iter.done) this.insertedUuids.delete(iter.value);
    }
    return inserted;
  }
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
