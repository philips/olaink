/**
 * Test adapter: presents a StubDevice (from @wrtn/sn-stub) as a DeviceBridge
 * by unwrapping its APIResponse wrappers. Used by plugin unit tests.
 */

import type { StubDevice } from '@wrtn/sn-stub';
import { BUTTON_ID } from '../buttonIds.ts';
import type {
  BridgeElement,
  DeviceBridge,
  NoteTemplate,
  PlainStrokeElement,
} from './types.ts';

interface Resp<T> {
  success: boolean;
  result: T | null;
}

function or<T>(resp: Resp<T>, fallback: T): T {
  return resp.success && resp.result !== null ? resp.result : fallback;
}

export function createStubBridge(stub: StubDevice): DeviceBridge {
  return {
    async getDeviceType() {
      return stub.deviceType;
    },
    async getEmrSize() {
      return stub.emr;
    },
    registerPenUp(cb: () => void): () => void {
      const sub = stub.registerEventListener('event_pen_up', 1, () => cb());
      return () => sub.remove();
    },
    async getCurrentFilePath() {
      return or(await stub.getCurrentFilePath(), '');
    },
    async getCurrentPageNum() {
      return or(await stub.getCurrentPageNum(), -1);
    },
    async getLastElement() {
      return or<BridgeElement | null>(await stub.getLastElement(), null);
    },
    async createElement(type: number) {
      return or<BridgeElement | null>(await stub.createElement(type), null);
    },
    async insertElements(notePath: string, page: number, elements: BridgeElement[]) {
      return or(await stub.insertElements(notePath, page, elements as never[]), false);
    },
    async insertStrokeElements(notePath: string, page: number, els: PlainStrokeElement[]) {
      // Reuse the stub's insert path: rebuild stub elements from the plain
      // payload so pen_up firing / bookkeeping stay identical to the device.
      const built: unknown[] = [];
      for (const e of els) {
        const r = await stub.createElement(0);
        if (!r.success || r.result === null) return false;
        const el = r.result;
        if (el.stroke === null) return false;
        el.uuid = e.uuid;
        el.thickness = e.thickness;
        el.layerNum = e.layerNum;
        el.pageNum = e.pageNum;
        el.stroke.penColor = e.stroke.penColor;
        el.stroke.penType = e.stroke.penType;
        await el.stroke.points.setRange(0, e.stroke.points.length, e.stroke.points);
        await el.stroke.pressures.setRange(0, e.stroke.pressures.length, e.stroke.pressures);
        built.push(el);
      }
      return or(await stub.insertElements(notePath, page, built as never[]), false);
    },
    async getElements(page: number, notePath: string) {
      return or<BridgeElement[]>(await stub.getElements(page, notePath), []);
    },
    async getPageSize(notePath: string, page: number) {
      const r = await stub.getPageSize(notePath, page);
      return r.success && r.result !== null
        ? (r.result as { width: number; height: number })
        : null;
    },
    async insertNotePage(notePath: string, page: number, template: string) {
      return or(await stub.insertNotePage({ notePath, page, template }), false);
    },
    async saveCurrentNote() {
      return or(await stub.saveCurrentNote(), false);
    },
    async reloadFile() {
      return or(await stub.reloadFile(), false);
    },
    async setPullEnabled(enabled) {
      await stub.setButtonState(BUTTON_ID.pull, enabled);
    },
    recycleElement(uuid: string): void {
      void stub.recycleElement(uuid);
    },
    async getNoteTotalPageNum(notePath: string) {
      const r = await stub.getNoteTotalPageNum(notePath);
      return r.success ? r.result : null;
    },
    async getNoteSystemTemplates(): Promise<NoteTemplate[]> {
      const r = await stub.getNoteSystemTemplates();
      return or(r as unknown as Resp<NoteTemplate[]>, []);
    },
    async createNote(opts: { notePath: string; template: string; isPortrait: boolean }) {
      return or(await stub.createNote(opts), false);
    },
  };
}
