/**
 * On-device DeviceBridge over sn-plugin-lib (the Supernote plugin SDK).
 *
 * Only this file (and the RN entrypoints) touch the SDK; everything else in
 * the plugin core runs against the port interface and is unit-testable.
 */

import {
  PluginCommAPI,
  PluginFileAPI,
  PluginManager,
  PluginNoteAPI,
  PointUtils,
} from 'sn-plugin-lib';
import type {
  BridgeElement,
  DeviceBridge,
  NoteTemplate,
} from './types.ts';

interface APIResponseShape<T> {
  success: boolean;
  result: T | null;
  error: { code: number; message: string } | null;
}

function unwrap<T>(resp: APIResponseShape<T> | null | undefined, what: string): T | null {
  if (!resp) return null;
  if (!resp.success) {
    console.log(`[wrtn] ${what} failed: ${resp.error?.code} ${resp.error?.message}`);
    return null;
  }
  return resp.result ?? null;
}

let emrCache: { width: number; height: number } | null = null;

export function createSnDeviceBridge(): DeviceBridge {
  return {
    async getDeviceType(): Promise<number> {
      try {
        return await PluginManager.getDeviceType();
      } catch {
        return -1;
      }
    },

    async getEmrSize(): Promise<{ width: number; height: number }> {
      if (emrCache !== null) return emrCache;
      try {
        const machine = await PluginManager.getDeviceType();
        const pageSize = PointUtils.getNotePageSize(PointUtils.ROTATION_0, machine);
        emrCache = {
          width: PointUtils.getRealMaxX(pageSize),
          height: PointUtils.getRealMaxY(pageSize),
        };
      } catch {
        // Fallback: Nomad A6X2 geometry (verified 2026-08-21).
        emrCache = { width: 21632, height: 16224 };
      }
      return emrCache;
    },

    registerPenUp(cb: () => void): () => void {
      const sub = PluginManager.registerEventListener('event_pen_up', 1, {
        onMsg: () => cb(),
      });
      return () => sub.remove();
    },

    async getCurrentFilePath(): Promise<string | null> {
      const r = await PluginCommAPI.getCurrentFilePath();
      return unwrap(r as APIResponseShape<string>, 'getCurrentFilePath');
    },

    async getCurrentPageNum(): Promise<number | null> {
      const r = await PluginCommAPI.getCurrentPageNum();
      return unwrap(r as APIResponseShape<number>, 'getCurrentPageNum');
    },

    async getLastElement(): Promise<BridgeElement | null> {
      const r = await PluginFileAPI.getLastElement();
      return unwrap(r as APIResponseShape<BridgeElement>, 'getLastElement');
    },

    async createElement(type: number): Promise<BridgeElement | null> {
      const r = await PluginCommAPI.createElement(type);
      return unwrap(r as APIResponseShape<BridgeElement>, 'createElement');
    },

    async insertElements(notePath: string, page: number, elements: BridgeElement[]): Promise<boolean> {
      const r = await PluginFileAPI.insertElements(notePath, page, elements as unknown as object[]);
      return unwrap(r as APIResponseShape<boolean>, 'insertElements') ?? false;
    },

    async getElements(page: number, notePath: string): Promise<BridgeElement[]> {
      const r = await PluginFileAPI.getElements(page, notePath);
      return unwrap(r as APIResponseShape<BridgeElement[]>, 'getElements') ?? [];
    },

    async saveCurrentNote(): Promise<boolean> {
      const r = await PluginNoteAPI.saveCurrentNote();
      return unwrap(r as APIResponseShape<boolean>, 'saveCurrentNote') ?? false;
    },

    async reloadFile(): Promise<boolean> {
      const r = await PluginCommAPI.reloadFile();
      return unwrap(r as APIResponseShape<boolean>, 'reloadFile') ?? false;
    },

    recycleElement(uuid: string): void {
      PluginCommAPI.recycleElement(uuid);
    },

    async getNoteTotalPageNum(notePath: string): Promise<number | null> {
      const r = await PluginFileAPI.getNoteTotalPageNum(notePath);
      return unwrap(r as APIResponseShape<number>, 'getNoteTotalPageNum');
    },

    async getNoteSystemTemplates(): Promise<NoteTemplate[]> {
      const r = await PluginCommAPI.getNoteSystemTemplates();
      return unwrap(r as APIResponseShape<NoteTemplate[]>, 'getNoteSystemTemplates') ?? [];
    },

    async createNote(opts: { notePath: string; template: string; isPortrait: boolean }): Promise<boolean> {
      const r = await PluginFileAPI.createNote({
        notePath: opts.notePath,
        template: opts.template,
        mode: 0,
        isPortrait: opts.isPortrait,
      });
      return unwrap(r as APIResponseShape<boolean>, 'createNote') ?? false;
    },
  };
}
