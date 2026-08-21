/**
 * Config persistence using a .note file as the backing store.
 *
 * The SDK has no writeFile for pure-JS plugins (FileUtils lacks it), but a
 * .note file round-trips: createNote with a real system template, stash the
 * config JSON as a type-500 text element via insertElements, read it back
 * with getElements. This is the on-device-proven pattern from the Supernote
 * plugin research repo.
 *
 * Writes append a new text element and reads take the LAST one — avoids
 * replaceElements complexity for a tiny config object. Failures are
 * non-fatal: the caller regenerates a username when the store is unusable.
 */

import type { DeviceBridge } from '../device/types.ts';
import { TYPE_TEXT } from '../device/types.ts';

export interface StoredConfig {
  serverUrl: string;
  username: string;
}

export class NoteStore {
  constructor(
    private readonly bridge: DeviceBridge,
    private readonly notePath: string,
  ) {}

  async load(): Promise<StoredConfig | null> {
    let elements;
    try {
      elements = await this.bridge.getElements(0, this.notePath);
    } catch {
      return null;
    }
    const texts = elements.filter((e) => e.type === TYPE_TEXT && e.textBox?.textContentFull);
    if (texts.length === 0) return null;
    const last = texts[texts.length - 1]!;
    try {
      const parsed = JSON.parse(last.textBox!.textContentFull!) as Partial<StoredConfig>;
      if (typeof parsed.serverUrl === 'string' && typeof parsed.username === 'string') {
        return { serverUrl: parsed.serverUrl, username: parsed.username };
      }
      return null;
    } catch {
      return null;
    }
  }

  async save(cfg: StoredConfig): Promise<boolean> {
    try {
      const exists = (await this.bridge.getNoteTotalPageNum(this.notePath)) !== null;
      if (!exists) {
        const created = await this.createStoreNote();
        if (!created) return false;
      }

      const el = await this.bridge.createElement(TYPE_TEXT);
      if (el === null) return false;
      el.textBox = {
        ...(el.textBox ?? {}),
        fontSize: 24,
        textContentFull: JSON.stringify(cfg),
        textRect: { left: 100, top: 100, right: 900, bottom: 300 },
        textAlign: 0,
        textFrameWidthType: 1,
      };
      const inserted = await this.bridge.insertElements(this.notePath, 0, [el]);
      this.bridge.recycleElement(el.uuid);
      return inserted;
    } catch (err) {
      console.log(`[wrtn] store save failed: ${(err as Error).message}`);
      return false;
    }
  }

  private async createStoreNote(): Promise<boolean> {
    const templates = await this.bridge.getNoteSystemTemplates();
    const template = templates[0]?.name;
    if (template === undefined) return false;
    return this.bridge.createNote({ notePath: this.notePath, template, isPortrait: true });
  }
}
