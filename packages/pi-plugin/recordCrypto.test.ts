import { describe, expect, test } from "vitest";
import {
  decryptNoteForDevice as serverDecrypt,
  encryptNoteForDevices as serverEncrypt,
  generateDeviceKeyPair as serverKeyPair,
} from "../server/src/prototypeNoteCrypto.ts";
import { gzipSync } from "node:zlib";
import { decodeNotePayload, decryptNoteForDevice, encryptNoteForDevices, generateDeviceKeyPair } from "./recordCrypto.ts";

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

describe("payload compression", () => {
  // Long runs with a little noise, like a Ratta RLE page.
  const big = new Uint8Array(400_000).map((_, i) => (i % 97 < 90 ? 0x62 : (i * 31) & 0xff));
  const directoryFor = (device: { deviceId: string; publicKeySpki: string }) =>
    ({ userId: "v", version: 1, devices: [{ deviceId: device.deviceId, publicKeySpki: device.publicKeySpki }] });

  test("gzips by default, shrinking the record, and both decryptors restore the note", async () => {
    const device = await generateDeviceKeyPair("pi");
    const payload = { filename: "a.note", mime: "application/x-supernote", note: big };
    const gz = await encryptNoteForDevices(payload, { fromUserId: "u", fromDeviceId: "d", directory: directoryFor(device) });
    const raw = await encryptNoteForDevices(payload, { fromUserId: "u", fromDeviceId: "d", directory: directoryFor(device), compress: false });
    expect(gz.ciphertext.length).toBeLessThan(raw.ciphertext.length / 4);
    expect((await decryptNoteForDevice(gz, device)).note).toEqual(big);
    expect((await decryptNoteForDevice(raw, device)).note).toEqual(big);
    const reference = await serverDecrypt(gz, device);
    expect(reference.note).toEqual(big);
  });

  test("rejects a decompression bomb and unknown encodings", async () => {
    // 6 MiB of zeros gzips to a few KB but inflates past the 5 MiB note limit.
    const bomb = Buffer.from(gzipSync(new Uint8Array(6 * 1024 * 1024))).toString("base64url");
    const base = { version: 1, filename: "a.note", mime: "application/x-supernote", sha256: "x" };
    await expect(decodeNotePayload({ ...base, encoding: "gzip", note: bomb })).rejects.toThrow(/oversized/);
    await expect(decodeNotePayload({ ...base, encoding: "br", note: "AA" })).rejects.toThrow(/unsupported note encoding/);
  });
});
