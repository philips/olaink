import { describe, expect, test } from "vitest";
import {
  decryptNoteForDevice as serverDecrypt,
  encryptNoteForDevices as serverEncrypt,
  generateDeviceKeyPair as serverKeyPair,
} from "../server/src/prototypeNoteCrypto.ts";
import { decryptNoteForDevice, encryptNoteForDevices, generateDeviceKeyPair } from "./recordCrypto.ts";

const note = new TextEncoder().encode("noteSN_FILE_VER_20260016 pretend note bytes");

describe("record-v1 interop", () => {
  test("a Pi-encrypted record opens with the relay's reference decryptor, for every device", async () => {
    const devices = await Promise.all(["supernote", "browser"].map((id) => serverKeyPair(id)));
    const record = await encryptNoteForDevices(
      { filename: "Re-question.note", mime: "application/x-supernote", note, senderUsername: "pi-bot" },
      {
        fromUserId: "account_pi",
        fromDeviceId: "pi-device",
        directory: { userId: "account_alice", version: 3, devices: devices.map(({ deviceId, publicKeySpki }) => ({ deviceId, publicKeySpki })) },
      },
    );
    expect(record).toMatchObject({ fromUserId: "account_pi", toUserId: "account_alice", toDirectoryVersion: 3 });
    expect(record.keySlots.map((slot) => slot.deviceId)).toEqual(["supernote", "browser"]);
    for (const device of devices) {
      const payload = await serverDecrypt(record, device);
      expect(payload.filename).toBe("Re-question.note");
      expect(payload.mime).toBe("application/x-supernote");
      expect(new TextDecoder().decode(payload.note)).toBe(new TextDecoder().decode(note));
    }
  });

  test("the payload names the sender for the Supernote plugin", async () => {
    const device = await generateDeviceKeyPair("pi");
    const record = await encryptNoteForDevices(
      { filename: "a.note", mime: "application/x-supernote", note, senderUsername: "pi-bot" },
      { fromUserId: "u", fromDeviceId: "d", directory: { userId: "v", version: 1, devices: [device] } },
    );
    const slot = record.keySlots[0]!;
    expect(slot.deviceId).toBe("pi");
    // Round-trips through this module's own decryptor too.
    expect((await decryptNoteForDevice(record, device)).filename).toBe("a.note");
  });

  test("a relay-encrypted record still opens in Pi", async () => {
    const device = await generateDeviceKeyPair("pi");
    const record = await serverEncrypt(
      { filename: "q.note", mime: "application/x-supernote", note },
      { fromUserId: "u", fromDeviceId: "d", toUserId: "v", toDirectoryVersion: 1, recipients: [device] },
    );
    expect((await decryptNoteForDevice(record, device)).filename).toBe("q.note");
  });

  test("refuses an empty or duplicated directory", async () => {
    const device = await generateDeviceKeyPair("pi");
    const payload = { filename: "a.note", mime: "application/x-supernote", note };
    await expect(encryptNoteForDevices(payload, { fromUserId: "u", fromDeviceId: "d", directory: { userId: "v", version: 1, devices: [] } }))
      .rejects.toThrow(/no devices/);
    await expect(encryptNoteForDevices(payload, { fromUserId: "u", fromDeviceId: "d", directory: { userId: "v", version: 1, devices: [device, device] } }))
      .rejects.toThrow(/duplicate/);
  });
});
