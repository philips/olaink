/**
 * Opaque storage for encrypted note payloads. R2 in the Worker (one object
 * per note record ID); a local directory in the standalone binary. Records
 * are written once at send time and garbage-collected when the last delivery
 * of the record is acknowledged or removed. The service never reads or
 * modifies payload content.
 *
 * Two shapes share the same keyspace: v1 records store the full record JSON
 * as text (`put`/`get`); v2 records store the raw ciphertext blob as bytes
 * (`putBytes`/`getBytes`). A record ID is only ever written in one shape.
 */
export interface NotePayloadStore {
  put(recordId: string, encodedRecord: string): Promise<void>;
  get(recordId: string): Promise<string | null>;
  putBytes(recordId: string, blob: Uint8Array): Promise<void>;
  getBytes(recordId: string): Promise<Uint8Array | null>;
  delete(recordId: string): Promise<void>;
}

/** Minimal structural slice of the R2 bucket API used by the relay. */
export interface R2BucketLike {
  put(key: string, value: string | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> } | null>;
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

  async putBytes(recordId: string, blob: Uint8Array): Promise<void> {
    await this.bucket.put(recordId, blob, { httpMetadata: { contentType: 'application/octet-stream' } });
  }

  async getBytes(recordId: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(recordId);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }

  async delete(recordId: string): Promise<void> {
    await this.bucket.delete(recordId);
  }
}

/** In-process payloads for tests and ':memory:' standalone runs. */
export class MemoryNotePayloadStore implements NotePayloadStore {
  readonly objects = new Map<string, string>();
  readonly blobs = new Map<string, Uint8Array>();

  async put(recordId: string, encodedRecord: string): Promise<void> {
    this.objects.set(recordId, encodedRecord);
  }

  async get(recordId: string): Promise<string | null> {
    return this.objects.get(recordId) ?? null;
  }

  async putBytes(recordId: string, blob: Uint8Array): Promise<void> {
    this.blobs.set(recordId, blob);
  }

  async getBytes(recordId: string): Promise<Uint8Array | null> {
    return this.blobs.get(recordId) ?? null;
  }

  async delete(recordId: string): Promise<void> {
    this.objects.delete(recordId);
    this.blobs.delete(recordId);
  }
}
