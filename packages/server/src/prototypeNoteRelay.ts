import { fromBase64Url } from './bytes.ts';
import type { D1Store } from './d1Store.ts';
import type { NotePayloadStore } from './notePayloads.ts';
import {
  assertPublicKey,
  type DevicePublicKey,
  type EncryptedNoteRecordV1,
} from './prototypeNoteCrypto.ts';

/** Encrypted whole-note relay. Records are always opaque to the service. */

export interface DeviceDirectory {
  userId: string;
  version: number;
  devices: DevicePublicKey[];
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

  async registerDevice(userId: string, device: DevicePublicKey): Promise<DeviceDirectory> {
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
      await this.options.store.enqueue(record, this.now());
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
    const payloads = await Promise.all(deliveries.map(({ recordId }) => this.options.payloads.get(recordId)));
    const records: EncryptedNoteRecordV1[] = [];
    payloads.forEach((payload, index) => {
      // A delivery row without a payload means storage lost the object; skip
      // it rather than failing the whole inbox. Log only the opaque ID.
      if (payload === null) this.log('missing payload for record', deliveries[index]!.recordId);
      else records.push(JSON.parse(payload) as EncryptedNoteRecordV1);
    });
    return records;
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
