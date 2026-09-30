/**
 * The conversation journal: every received note (decrypted, mode 0600) and
 * the state of its exchange, under `<state dir>/conversation/`.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Exchange, Journal } from "./conversation.ts";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class FileJournal implements Journal {
  private readonly indexPath: string;

  constructor(readonly directory: string) {
    this.indexPath = join(directory, "journal.json");
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private notePath(recordId: string, suffix = ""): string {
    if (!SAFE_ID.test(recordId)) throw new Error("invalid record ID");
    return join(this.directory, `${recordId}${suffix}.note`);
  }

  async list(): Promise<Exchange[]> {
    try {
      return JSON.parse(await readFile(this.indexPath, "utf8")) as Exchange[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async put(exchange: Exchange): Promise<void> {
    await this.ensureDirectory();
    const entries = (await this.list()).filter((entry) => entry.recordId !== exchange.recordId);
    entries.push(exchange);
    // Write-then-rename so a crash never leaves a truncated index.
    const temporary = `${this.indexPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.indexPath);
  }

  private async write(path: string, bytes: Uint8Array): Promise<void> {
    await this.ensureDirectory();
    await writeFile(path, bytes, { mode: 0o600 });
    await chmod(path, 0o600);
  }

  saveNote(recordId: string, note: Uint8Array): Promise<void> {
    return this.write(this.notePath(recordId), note);
  }

  async loadNote(recordId: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.notePath(recordId)));
  }

  /** Keeps a copy of what was sent back, next to what was received. */
  saveReply(recordId: string, note: Uint8Array): Promise<void> {
    return this.write(this.notePath(recordId, "-reply"), note);
  }
}
