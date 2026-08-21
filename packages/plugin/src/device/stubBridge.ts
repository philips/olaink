/**
 * Test adapter: presents a StubDevice (from @wrtn/sn-stub) as a DeviceBridge
 * by unwrapping its APIResponse wrappers. Used by plugin unit tests.
 */

import type { StubDevice } from '@wrtn/sn-stub';
import type {
  BridgeElement,
  DeviceBridge,
  NoteTemplate,
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
    async getElements(page: number, notePath: string) {
      return or<BridgeElement[]>(await stub.getElements(page, notePath), []);
    },
    async saveCurrentNote() {
      return or(await stub.saveCurrentNote(), false);
    },
    async reloadFile() {
      return or(await stub.reloadFile(), false);
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
