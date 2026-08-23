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
 *
 * Path facts (verified on-device 2026-08-23, see plans/supernote-plugin.md):
 * - createNote REQUIRES absolute /storage/emulated/0/... paths; relative
 *   note-root paths fail with 1204 Invalid file path (reads are fine with
 *   relative paths, which is why the old bug hid for so long).
 * - The Nomad host auto-creates the nested WrtnStore/ parent (verified
 *   2026-08-23); retain the flat fallback defensively for host differences.
 * - getNoteSystemTemplates fails in the settings-client context (the headless
 *   session runs there), so the template falls back to 'style_white' —
 *   first template on a stock Nomad; 'blank' does not exist on-device (802).
 */

import type { DeviceBridge } from '../device/types.ts';
import { TYPE_TEXT } from '../device/types.ts';

export interface StoredConfig {
  serverUrl: string;
  username: string;
}

/**
 * Candidate config-note paths, tried in order (create) and searched in order
 * (load). All absolute — createNote requirement. The flat one needs no
 * parent dir.
 */
export const STORE_NOTE_PATHS: readonly string[] = [
  '/storage/emulated/0/MyStyle/WrtnStore/wrtn-config.note',
  '/storage/emulated/0/MyStyle/wrtn-config.note',
];

export class NoteStore {
  constructor(
    private readonly bridge: DeviceBridge,
    private readonly notePaths: readonly string[] = STORE_NOTE_PATHS,
  ) {}

  async load(): Promise<StoredConfig | null> {
    for (const notePath of this.notePaths) {
      let elements;
      try {
        elements = await this.bridge.getElements(0, notePath);
      } catch {
        continue;
      }
      const texts = elements.filter((e) => e.type === TYPE_TEXT && e.textBox?.textContentFull);
      if (texts.length === 0) continue;
      const last = texts[texts.length - 1]!;
      try {
        const parsed = JSON.parse(last.textBox!.textContentFull!) as Partial<StoredConfig>;
        if (typeof parsed.serverUrl === 'string' && typeof parsed.username === 'string') {
          return { serverUrl: parsed.serverUrl, username: parsed.username };
        }
      } catch {
        // Malformed config: try the next candidate, then let the caller
        // regenerate (save will append to the existing note either way).
      }
    }
    return null;
  }

  async save(cfg: StoredConfig): Promise<boolean> {
    try {
      const notePath = await this.ensureStoreNote();
      if (notePath === null) return false;

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
      const inserted = await this.bridge.insertElements(notePath, 0, [el]);
      this.bridge.recycleElement(el.uuid);
      if (!inserted) {
        console.log(`[wrtn] store save failed: insertElements ${notePath}`);
      }
      return inserted;
    } catch (err) {
      console.log(`[wrtn] store save failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** Find an existing config note; else create one at the first candidate
   * path that createNote accepts. Returns the path to write to. */
  private async ensureStoreNote(): Promise<string | null> {
    for (const p of this.notePaths) {
      try {
        if ((await this.bridge.getNoteTotalPageNum(p)) !== null) return p;
      } catch {
        // try next candidate
      }
    }
    for (const p of this.notePaths) {
      if (await this.createStoreNote(p)) return p;
    }
    return null;
  }

  private async createStoreNote(notePath: string): Promise<boolean> {
    let template: string | undefined;
    try {
      template = (await this.bridge.getNoteSystemTemplates())[0]?.name;
    } catch {
      template = undefined;
    }
    const created = await this.bridge.createNote({
      notePath,
      template: template ?? 'style_white',
      isPortrait: true,
    });
    if (!created) {
      console.log(`[wrtn] store createNote failed: ${notePath}`);
    }
    return created;
  }
}
