import { Linking } from 'react-native';
import { PluginCommAPI } from 'sn-plugin-lib';

/** Android action exported by the Ola Ink companion wrapper. */
export const COMPANION_SHARE_ACTION = 'dev.olaink.OPEN_SHARE';
export const COMPANION_DRAFT_ID_EXTRA = 'draftId';
/**
 * Deliberately unsafe prototype-only hand-off. This is an absolute filesystem
 * path, not a URI grant; the companion needs developer-enabled all-files
 * access. Do not use this in a production share flow.
 */
export const COMPANION_NOTE_PATH_EXTRA = 'notePath';

export interface IntentLinking {
  sendIntent(action: string, extras?: Array<{ key: string; value: string | number | boolean }>): Promise<void>;
}

interface ApiResponse<T> {
  success: boolean;
  result: T | null;
}

export interface CurrentFilePathAPI {
  getCurrentFilePath(): Promise<ApiResponse<string> | null | undefined>;
}

/**
 * Open the separately installed companion. `draftId` is opaque unless an
 * explicitly unsafe prototype path hand-off is requested with `notePath`.
 */
export async function openCompanionShare(
  draftId = `launch-${Date.now().toString(36)}`,
  linking: IntentLinking = Linking,
  notePath?: string | null,
): Promise<boolean> {
  try {
    const extras: Array<{ key: string; value: string | number | boolean }> = [
      { key: COMPANION_DRAFT_ID_EXTRA, value: draftId },
    ];
    if (typeof notePath === 'string' && notePath.length > 0) {
      extras.push({ key: COMPANION_NOTE_PATH_EXTRA, value: notePath });
    }
    await linking.sendIntent(COMPANION_SHARE_ACTION, extras);
    console.log(`[olaink] companion share intent sent (${draftId})`);
    return true;
  } catch (error) {
    console.log(`[olaink] companion share intent failed: ${(error as Error).message}`);
    return false;
  }
}

/**
 * Prototype-only active-note launch. The Supernote beta API returns a raw
 * path, which is intentionally forwarded as an Android intent extra here.
 */
export async function openCurrentNoteInCompanion(
  draftId = `launch-${Date.now().toString(36)}`,
  linking: IntentLinking = Linking,
  comm: CurrentFilePathAPI = PluginCommAPI as unknown as CurrentFilePathAPI,
): Promise<boolean> {
  try {
    const response = await comm.getCurrentFilePath();
    const notePath = response?.success ? response.result : null;
    if (typeof notePath !== 'string' || notePath.length === 0) {
      console.log('[olaink] current note path was unavailable');
      return false;
    }
    return openCompanionShare(draftId, linking, notePath);
  } catch (error) {
    console.log(`[olaink] current note path failed: ${(error as Error).message}`);
    return false;
  }
}
