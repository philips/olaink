/**
 * SwapNote path helpers (issue #2).
 *
 * Each user we exchange with gets a dedicated note in the device's INBOX
 * folder:
 *   /storage/emulated/0/INBOX/swapnote-<username>.note
 *
 * The ABSOLUTE Android path is mandatory: createNote rejects note-root
 * relative paths (e.g. /INBOX/..., /Note/...) with 1204 "Invalid file path"
 * while it accepts /storage/emulated/0/... (verified on-device 2026-08-23 —
 * relative /MyStyle and /Note got 1204, absolute Note/INBOX/MyStyle all got
 * past path validation). getCurrentFilePath() returns the same absolute
 * format, which is what the other file APIs expect.
 *
 * Flat name on purpose: the SDK has no directory-creation API, so a
 * subdirectory would require a one-time adb bootstrap.
 *
 * The note name IS the routing key, so the note path maps 1:1 to a sender
 * username.
 */

import { isStructurallyValidUsername } from '@olaink/protocol';

const SWAP_NOTE_DIR = '/storage/emulated/0/INBOX';
const SWAP_NOTE_PREFIX = 'swapnote-';

export function swapNotePathFor(username: string): string {
  return `${SWAP_NOTE_DIR}/${SWAP_NOTE_PREFIX}${username}.note`;
}

/**
 * Inverse of swapNotePathFor: the sender username if this is a SwapNote path.
 * Structural check only — the sender may be a reserved bot name (swaptest is
 * a page sender), so isValidUsername (which rejects reserved names) would
 * wrongly return null here.
 */
export function swapNoteSenderOf(notePath: string): string | null {
  const parts = notePath.split('/');
  const dir = parts[parts.length - 2] ?? '';
  const name = parts[parts.length - 1] ?? '';
  if (dir !== 'INBOX' || !name.startsWith(SWAP_NOTE_PREFIX) || !name.endsWith('.note')) {
    return null;
  }
  const username = name.slice(SWAP_NOTE_PREFIX.length, -'.note'.length);
  return isStructurallyValidUsername(username) ? username : null;
}
