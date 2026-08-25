/**
 * In-memory encrypted whole-note relay used during the PWA/companion spike.
 *
 * The relay cannot decrypt ordinary records. `echo` is deliberately different:
 * it is an automated recipient device whose private key lives in this process,
 * decrypts a note addressed to it, and creates a newly encrypted reply for the
 * sender. It is for end-to-end tests only; never send sensitive notes to echo.
 */
import {
  assertPublicKey,
  decryptNoteForDevice,
  encryptNoteForDevices,
  generateDeviceKeyPair,
  type DeviceKeyPair,
  type DevicePublicKey,
  type EncryptedNoteRecordV1,
} from './prototypeNoteCrypto.ts';

export const ECHO_USER_ID = 'echo';
export const ECHO_DEVICE_ID = 'echo-prototype-device';

interface RegisteredDevice extends DevicePublicKey {
  userId: string;
}

export interface DeviceDirectory {
  userId: string;
  version: number;
  devices: DevicePublicKey[];
}

export class PrototypeNoteRelay {
  private readonly devices = new Map<string, RegisteredDevice>();
  private readonly directoryVersions = new Map<string, number>();
  private readonly inboxes = new Map<string, EncryptedNoteRecordV1[]>();
  private readonly echo: DeviceKeyPair = generateDeviceKeyPair(ECHO_DEVICE_ID);

  constructor() {
    this.registerDevice(ECHO_USER_ID, this.echo);
  }

  registerDevice(userId: string, device: DevicePublicKey): DeviceDirectory {
    if (!isIdentifier(userId) || !isIdentifier(device.deviceId)) throw new Error('invalid device registration');
    assertPublicKey(device.publicKeySpki);
    const existing = this.devices.get(device.deviceId);
    if (existing && existing.userId !== userId) throw new Error('device ID is already registered');
    if (
      userId === ECHO_USER_ID &&
      (device.deviceId !== ECHO_DEVICE_ID || device.publicKeySpki !== this.echo.publicKeySpki)
    ) throw new Error('echo directory is managed by the server');
    if (!existing || existing.publicKeySpki !== device.publicKeySpki) {
      this.directoryVersions.set(userId, (this.directoryVersions.get(userId) ?? 0) + 1);
    }
    this.devices.set(device.deviceId, { userId, ...device });
    return this.directory(userId);
  }

  directory(userId: string): DeviceDirectory {
    const devices = [...this.devices.values()]
      .filter((device) => device.userId === userId)
      .map(({ deviceId, publicKeySpki }) => ({ deviceId, publicKeySpki }));
    return { userId, version: this.directoryVersions.get(userId) ?? 0, devices };
  }

  async send(record: EncryptedNoteRecordV1): Promise<void> {
    this.validateRecord(record);
    if (record.toUserId === ECHO_USER_ID) {
      await this.replyAsEcho(record);
      return;
    }
    for (const slot of record.keySlots) this.inbox(slot.deviceId).push(record);
  }

  poll(deviceId: string): EncryptedNoteRecordV1[] {
    this.requireDevice(deviceId);
    return [...this.inbox(deviceId)];
  }

  acknowledge(deviceId: string, recordIds: string[]): number {
    this.requireDevice(deviceId);
    const ids = new Set(recordIds);
    const inbox = this.inbox(deviceId);
    const before = inbox.length;
    for (let index = inbox.length - 1; index >= 0; index--) {
      if (ids.has(inbox[index]!.id)) inbox.splice(index, 1);
    }
    return before - inbox.length;
  }

  private async replyAsEcho(record: EncryptedNoteRecordV1): Promise<void> {
    // This is a separate recipient client implemented in Node. It is the sole
    // place the prototype service uses a private key to read note content.
    const note = decryptNoteForDevice(record, this.echo);
    const sender = this.directory(record.fromUserId);
    if (sender.devices.length === 0) throw new Error('echo sender has no registered devices');
    const reply = encryptNoteForDevices(note, {
      fromUserId: ECHO_USER_ID,
      fromDeviceId: ECHO_DEVICE_ID,
      toUserId: record.fromUserId,
      toDirectoryVersion: sender.version,
      recipients: sender.devices,
    });
    this.validateRecord(reply);
    for (const slot of reply.keySlots) this.inbox(slot.deviceId).push(reply);
  }

  private validateRecord(record: EncryptedNoteRecordV1): void {
    if (
      record.version !== 1 || !isIdentifier(record.id) || !isIdentifier(record.fromUserId) ||
      !isIdentifier(record.fromDeviceId) || !isIdentifier(record.toUserId) ||
      !Number.isInteger(record.toDirectoryVersion) || record.toDirectoryVersion < 1 ||
      !isBase64Url(record.contentIv, 12, 12) || !isBase64Url(record.ciphertext, 16) ||
      !Array.isArray(record.keySlots) || record.keySlots.length === 0
    ) throw new Error('invalid encrypted note record');
    const sender = this.requireDevice(record.fromDeviceId);
    if (sender.userId !== record.fromUserId) throw new Error('record sender device does not belong to sender');
    const directory = this.directory(record.toUserId);
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
      assertPublicKey(slot.ephemeralPublicKeySpki);
    }
    if (expected.size !== 0) throw new Error('recipient slots do not match directory');
  }

  private requireDevice(deviceId: string): RegisteredDevice {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error('unknown device');
    return device;
  }

  private inbox(deviceId: string): EncryptedNoteRecordV1[] {
    let inbox = this.inboxes.get(deviceId);
    if (!inbox) {
      inbox = [];
      this.inboxes.set(deviceId, inbox);
    }
    return inbox;
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function isBase64Url(value: unknown, minimumBytes: number, maximumBytes = Number.POSITIVE_INFINITY): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length >= minimumBytes && bytes.length <= maximumBytes && bytes.toString('base64url') === value;
}
