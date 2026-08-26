import { Linking } from 'react-native';

/** Android action exported by the Ola Ink companion wrapper. */
export const COMPANION_SHARE_ACTION = 'dev.olaink.OPEN_SHARE';
/** An opaque launch identifier; it carries no note data or account state. */
export const COMPANION_DRAFT_ID_EXTRA = 'draftId';

export interface IntentLinking {
  sendIntent(action: string, extras?: Array<{ key: string; value: string | number | boolean }>): Promise<void>;
}

/** Open the separately installed companion without exposing the active note. */
export async function openCompanionShare(
  draftId = `launch-${Date.now().toString(36)}`,
  linking: IntentLinking = Linking,
): Promise<boolean> {
  try {
    await linking.sendIntent(COMPANION_SHARE_ACTION, [
      { key: COMPANION_DRAFT_ID_EXTRA, value: draftId },
    ]);
    console.log(`[olaink] companion share intent sent (${draftId})`);
    return true;
  } catch (error) {
    console.log(`[olaink] companion share intent failed: ${(error as Error).message}`);
    return false;
  }
}
