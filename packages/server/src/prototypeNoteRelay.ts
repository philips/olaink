import { fromBase64Url, utf8ByteLength } from './bytes.ts';
import { D1Store, type DeviceInventoryEntry } from './d1Store.ts';
import type { NotePayloadStore } from './notePayloads.ts';
import {
  assertPublicKey,
  type DevicePublicKey,
  type EncryptedNoteHeaderV2,
  type EncryptedNoteRecordV1,
} from './prototypeNoteCrypto.ts';

/** Encrypted whole-note relay. Records are always opaque to the service. */

/** A directory device plus the payload formats it advertises (see plans/binary-record-transport.md). */
export type DirectoryDevice = DevicePublicKey & { payloadVersions: number[] };

export interface DeviceDirectory {
  userId: string;
  version: number;
  devices: DirectoryDevice[];
}

/** A poll entry: a full v1 record, or a v2 routing header (blob fetched separately). */
export type PolledRecord = EncryptedNoteRecordV1 | EncryptedNoteHeaderV2;

/**
 * The highest payload version in the intersection of what every listed
 * device advertises; 1 when any is legacy (v1 is the universal baseline).
 */
export function negotiatedPayloadVersion(devices: DirectoryDevice[]): number {
  let candidates: number[] | null = null;
  for (const device of devices) {
    const supported = device.payloadVersions.length > 0 ? device.payloadVersions : [1];
    candidates = candidates === null ? [...supported] : candidates.filter((version) => supported.includes(version));
  }
  return candidates !== null && candidates.length > 0 ? Math.max(...candidates) : 1;
}

export interface PrototypeNoteRelayOptions {
  /** Directory, device, and delivery metadata (D1, or the SQLite shim). */
  store: D1Store;
  /** Opaque record payloads, one object per record ID (R2, or a local directory). */
  payloads: NotePayloadStore;
  now?: () => number;
  /** Payload GC failures are logged, never surfaced to the client. */
  log?: (...args: unknown[]) => void;
}

export class PrototypeNoteRelay {
  private readonly now: () => number;
  private readonly log: (...args: unknown[]) => void;

  constructor(private readonly options: PrototypeNoteRelayOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((...args) => console.log('[olaink-relay]', ...args));
  }

  async registerDevice(userId: string, device: DevicePublicKey & { payloadVersions?: number[] }): Promise<DeviceDirectory> {
    if (!isIdentifier(userId) || !isIdentifier(device.deviceId)) throw new Error('invalid device registration');
    await assertPublicKey(device.publicKeySpki);
    return this.options.store.registerDevice(userId, device, this.now());
  }

  /** Removes a device, its pending deliveries, and its directory key slot. */
  async unregisterDevice(deviceId: string): Promise<boolean> {
    if (!isIdentifier(deviceId)) return false;
    const { removed, gcRecordIds } = await this.options.store.unregisterDevice(deviceId);
    await this.collect(gcRecordIds);
    return removed;
  }

  directory(userId: string): Promise<DeviceDirectory> {
    return this.options.store.directory(userId);
  }

  /**
   * The devices enrolled under this account, for the companion's device
   * management UI. Includes the caller itself; the UI distinguishes it by
   * device ID.
   */
  inventory(userId: string): Promise<DeviceInventoryEntry[]> {
    return this.options.store.deviceInventory(userId);
  }

  /**
   * Removes a device enrolled under the same account as the calling device.
   * Companion-scoped: a caller can only affect devices in its own account,
   * and cannot remove itself (self-removal is the logout flow).
   */
  async removeDeviceFromAccount(callerDeviceId: string, targetDeviceId: string): Promise<boolean> {
    if (!isIdentifier(callerDeviceId) || !isIdentifier(targetDeviceId)) return false;
    if (callerDeviceId === targetDeviceId) return false;
    const callerOwner = await this.ownerOfDevice(callerDeviceId);
    const targetOwner = callerOwner === null ? null : await this.ownerOfDevice(targetDeviceId);
    if (callerOwner === null || targetOwner === null || callerOwner !== targetOwner) return false;
    return this.unregisterDevice(targetDeviceId);
  }

  /**
   * Stores the payload, then its metadata and delivery rows. A record ID is
   * single-use: re-sending the identical record is idempotent (deliveries
   * are re-added), a different record under a used ID is rejected. If the
   * metadata write fails, a payload this call created is removed again, so a
   * failed send leaves no orphan state.
   */
  async send(record: EncryptedNoteRecordV1): Promise<void> {
    await this.validateRecord(record);
    const encoded = JSON.stringify(record);
    const existing = await this.options.payloads.get(record.id);
    if (existing !== null && existing !== encoded) throw new Error('record ID is already in use');
    if (existing === null) await this.options.payloads.put(record.id, encoded);
    try {
      await this.options.store.enqueue(record, this.now(), utf8ByteLength(encoded));
    } catch (error) {
      if (existing === null) await this.collect([record.id]);
      throw error;
    }
  }

  /** Opaque account ownership used by the authenticated HTTP boundary. */
  async ownerOfDevice(deviceId: string): Promise<string | null> {
    return (await this.options.store.device(deviceId))?.userId ?? null;
  }

  async poll(deviceId: string): Promise<EncryptedNoteRecordV1[]> {
    await this.requireDevice(deviceId);
    const deliveries = await this.options.store.poll(deviceId);
    const records: EncryptedNoteRecordV1[] = [];
    for (const { recordId, headerJson } of deliveries) {
      // A v2 record can only be here through a capability-negotiation bug;
      // leave it queued and keep the legacy poll alive rather than failing
      // the whole inbox on bytes JSON.parse cannot read.
      if (headerJson !== null) {
        this.log('skipping record-v2 delivery in a legacy poll', recordId);
        continue;
      }
      const payload = await this.options.payloads.get(recordId);
      // A delivery row without a payload means storage lost the object; skip
      // it rather than failing the whole inbox. Log only the opaque ID.
      if (payload === null) this.log('missing payload for record', recordId);
      else records.push(JSON.parse(payload) as EncryptedNoteRecordV1);
    }
    return records;
  }

  /**
   * A poll for a v2-capable client: legacy v1 records arrive inline (the
   * client decrypts them as before), v2 records arrive as their small D1
   * routing headers — the ciphertext blob is fetched per record, so the
   * response no longer carries every waiting note at once.
   */
  async pollMixed(deviceId: string): Promise<PolledRecord[]> {
    await this.requireDevice(deviceId);
    const deliveries = await this.options.store.poll(deviceId);
    const records: PolledRecord[] = [];
    for (const { recordId, headerJson } of deliveries) {
      if (headerJson !== null) {
        records.push(JSON.parse(headerJson) as EncryptedNoteHeaderV2);
        continue;
      }
      const payload = await this.options.payloads.get(recordId);
      // A delivery row without a payload means storage lost the object; skip
      // it rather than failing the whole inbox. Log only the opaque ID.
      if (payload === null) this.log('missing payload for record', recordId);
      else records.push(JSON.parse(payload) as EncryptedNoteRecordV1);
    }
    return records;
  }

  /**
   * The raw ciphertext blob of one v2 record, but only for a device that
   * holds a pending delivery of it. Legacy v1 records have no blob and
   * answer null.
   */
  async blobFor(deviceId: string, recordId: string): Promise<Uint8Array | null> {
    if (!isIdentifier(recordId)) return null;
    if (!await this.options.store.deliveryExists(deviceId, recordId)) return null;
    if (await this.options.store.noteHeader(recordId) === null) return null;
    return this.options.payloads.getBytes(recordId);
  }

  /**
   * Stores a record-v2 payload and its metadata/delivery rows, mirroring
   * send(): the blob first, then D1, rolling the blob back if D1 rejects.
   * Idempotent re-sends of the identical blob re-add deliveries; a different
   * blob under a used ID is rejected.
   */
  async sendV2(header: EncryptedNoteHeaderV2, blob: Uint8Array): Promise<void> {
    await this.validateHeaderV2(header, blob);
    const existing = await this.options.payloads.getBytes(header.id);
    if (existing !== null && !bytesEqual(existing, blob)) throw new Error('record ID is already in use');
    if (existing === null) await this.options.payloads.putBytes(header.id, blob);
    try {
      await this.options.store.enqueue(header, this.now(), blob.byteLength, JSON.stringify(header));
    } catch (error) {
      if (existing === null) await this.collect([header.id]);
      throw error;
    }
  }

  async acknowledge(deviceId: string, recordIds: string[]): Promise<number> {
    await this.requireDevice(deviceId);
    const { acknowledged, gcRecordIds } = await this.options.store.acknowledge(deviceId, recordIds);
    await this.collect(gcRecordIds);
    return acknowledged;
  }

  /**
   * Deletes notes older than maxAgeMs, regardless of delivery state, in
   * batches (bounded by maxBatches per call so one sweep cannot run
   * unbounded work). R2/payload deletion runs before the D1 row delete, so a
   * mid-sweep failure leaves the same "row present, payload missing" state
   * poll() already tolerates (logs and skips) — safe to retry on the next
   * sweep. Deleting an already-gone ID is a no-op, so overlapping sweeps
   * cannot corrupt state, only duplicate harmless work.
   */
  async purgeExpired(maxAgeMs: number, batchSize = 500, maxBatches = 20): Promise<number> {
    const cutoff = this.now() - maxAgeMs;
    let purged = 0;
    for (let i = 0; i < maxBatches; i++) {
      const ids = await this.options.store.expiredNoteIds(cutoff, batchSize);
      if (ids.length === 0) break;
      await this.collect(ids);
      await this.options.store.deleteNotes(ids);
      purged += ids.length;
      if (ids.length < batchSize) break;
    }
    if (purged > 0) this.log('retention sweep purged', purged, 'note(s) older than', new Date(cutoff).toISOString());
    return purged;
  }

  /** Best-effort payload GC: a leftover object is harmless, a failed request is not. */
  private async collect(recordIds: string[]): Promise<void> {
    await Promise.all(recordIds.map(async (recordId) => {
      try {
        await this.options.payloads.delete(recordId);
      } catch (error) {
        this.log('payload delete failed for record', recordId, error);
      }
    }));
  }

  /** The v2 counterpart of validateRecord, plus the blob's declared length. */
  private async validateHeaderV2(header: EncryptedNoteHeaderV2, blob: Uint8Array): Promise<void> {
    if (
      header.version !== 2 || !isIdentifier(header.id) || !isIdentifier(header.fromUserId) ||
      !isIdentifier(header.fromDeviceId) || !isIdentifier(header.toUserId) ||
      !Number.isInteger(header.toDirectoryVersion) || header.toDirectoryVersion < 1 ||
      !isBase64Url(header.contentIv, 12, 12) ||
      !Number.isInteger(header.ciphertextBytes) || header.ciphertextBytes < 16 ||
      header.ciphertextBytes !== blob.byteLength ||
      !Array.isArray(header.keySlots) || header.keySlots.length === 0
    ) throw new Error('invalid encrypted note record');
    const sender = await this.requireDevice(header.fromDeviceId);
    if (sender.userId !== header.fromUserId) throw new Error('record sender device does not belong to sender');
    const directory = await this.directory(header.toUserId);
    if (directory.version !== header.toDirectoryVersion || directory.devices.length !== header.keySlots.length) {
      throw new Error('recipient directory is stale or incomplete');
    }
    const expected = new Set(directory.devices.map((device) => device.deviceId));
    for (const slot of header.keySlots) {
      if (!isIdentifier(slot.deviceId) || !expected.delete(slot.deviceId) ||
        !isBase64Url(slot.ephemeralPublicKeySpki, 1) || !isBase64Url(slot.wrapIv, 12, 12) ||
        !isBase64Url(slot.wrappedContentKey, 16)) {
        throw new Error('invalid key slots');
      }
      await assertPublicKey(slot.ephemeralPublicKeySpki);
    }
    if (expected.size !== 0) throw new Error('recipient slots do not match directory');
  }

  private async validateRecord(record: EncryptedNoteRecordV1): Promise<void> {
    if (
      record.version !== 1 || !isIdentifier(record.id) || !isIdentifier(record.fromUserId) ||
      !isIdentifier(record.fromDeviceId) || !isIdentifier(record.toUserId) ||
      !Number.isInteger(record.toDirectoryVersion) || record.toDirectoryVersion < 1 ||
      !isBase64Url(record.contentIv, 12, 12) || !isBase64Url(record.ciphertext, 16) ||
      !Array.isArray(record.keySlots) || record.keySlots.length === 0
    ) throw new Error('invalid encrypted note record');
    const sender = await this.requireDevice(record.fromDeviceId);
    if (sender.userId !== record.fromUserId) throw new Error('record sender device does not belong to sender');
    const directory = await this.directory(record.toUserId);
    if (directory.version !== record.toDirectoryVersion || directory.devices.length !== record.keySlots.length) {
      throw new Error('recipient directory is stale or incomplete');
    }
    const expected = new Set(directory.devices.map((device) => device.deviceId));
    for (const slot of record.keySlots) {
      if (!isIdentifier(slot.deviceId) || !expected.delete(slot.deviceId) ||
        !isBase64Url(slot.ephemeralPublicKeySpki, 1) || !isBase64Url(slot.wrapIv, 12, 12) ||
        !isBase64Url(slot.wrappedContentKey, 16)) {
        throw new Error('invalid key slots');
      }
      await assertPublicKey(slot.ephemeralPublicKeySpki);
    }
    if (expected.size !== 0) throw new Error('recipient slots do not match directory');
  }

  private async requireDevice(deviceId: string): Promise<{ userId: string; deviceId: string; publicKeySpki: string }> {
    const device = await this.options.store.device(deviceId);
    if (!device) throw new Error('unknown device');
    return device;
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function isBase64Url(value: unknown, minimumBytes: number, maximumBytes = Number.POSITIVE_INFINITY): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const bytes = fromBase64Url(value);
  return bytes !== null && bytes.length >= minimumBytes && bytes.length <= maximumBytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
