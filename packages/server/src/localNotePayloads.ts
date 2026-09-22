import { mkdirSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NotePayloadStore } from './notePayloads.ts';

/**
 * R2 stand-in for the standalone binary: one file per note record ID in a
 * local directory. Writes go to a temporary file and are renamed into place,
 * so a crash never leaves a truncated payload under a record ID.
 */
export class DirectoryNotePayloads implements NotePayloadStore {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }

  async put(recordId: string, encodedRecord: string): Promise<void> {
    const path = this.path(recordId);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, encodedRecord, 'utf8');
    await rename(temporary, path);
  }

  async get(recordId: string): Promise<string | null> {
    try {
      return await readFile(this.path(recordId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(recordId: string): Promise<void> {
    await rm(this.path(recordId), { force: true });
  }

  private path(recordId: string): string {
    // Record IDs are validated identifiers; re-check so a key can never
    // escape the directory.
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(recordId)) throw new Error('invalid note record ID');
    return join(this.directory, `${recordId}.json`);
  }
}
