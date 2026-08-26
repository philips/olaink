import { Linking } from 'react-native';
import { PluginCommAPI } from 'sn-plugin-lib';

/** Android action exported by the Ola Ink companion wrapper. */
export const COMPANION_SHARE_ACTION = 'com.olaink.OPEN_SHARE';
/** An opaque launch identifier; it carries no note data or account state. */
export const COMPANION_DRAFT_ID_EXTRA = 'draftId';
/**
 * Temporary direct active-note hand-off. This is a filesystem path, not an
 * Android URI permission grant.
 * TODO: Replace with a supported Supernote-provided content:// URI hand-off.
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

/** Open the separately installed companion with an optional active-note path. */
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
 * Open the companion with the active Supernote file selected already.
 * TODO: getCurrentFilePath() returns an unscoped path; use a supported
 * content:// grant when Supernote exposes one.
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
