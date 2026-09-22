/**
 * Opaque storage for encrypted note payloads. R2 in the Worker (one object
 * per note record ID); a local directory in the standalone binary. Records
 * are written once at send time and garbage-collected when the last delivery
 * of the record is acknowledged or removed. The service never reads or
 * modifies payload content.
 */
export interface NotePayloadStore {
  put(recordId: string, encodedRecord: string): Promise<void>;
  get(recordId: string): Promise<string | null>;
  delete(recordId: string): Promise<void>;
}

/** Minimal structural slice of the R2 bucket API used by the relay. */
export interface R2BucketLike {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(key: string): Promise<unknown>;
}

export class R2NotePayloads implements NotePayloadStore {
  constructor(private readonly bucket: R2BucketLike) {}

  async put(recordId: string, encodedRecord: string): Promise<void> {
    await this.bucket.put(recordId, encodedRecord, { httpMetadata: { contentType: 'application/json' } });
  }

  async get(recordId: string): Promise<string | null> {
    const object = await this.bucket.get(recordId);
    return object ? object.text() : null;
  }

  async delete(recordId: string): Promise<void> {
    await this.bucket.delete(recordId);
  }
}

/** In-process payloads for tests and ':memory:' standalone runs. */
export class MemoryNotePayloadStore implements NotePayloadStore {
  readonly objects = new Map<string, string>();

  async put(recordId: string, encodedRecord: string): Promise<void> {
    this.objects.set(recordId, encodedRecord);
  }

  async get(recordId: string): Promise<string | null> {
    return this.objects.get(recordId) ?? null;
  }

  async delete(recordId: string): Promise<void> {
    this.objects.delete(recordId);
  }
}
