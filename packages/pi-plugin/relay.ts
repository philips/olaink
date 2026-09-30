/**
 * Device state and relay transport for the Ola Ink Pi extension: pairing,
 * the sender directory, polling, acknowledgement, and sending notes.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  decryptNoteForDevice,
  encryptNoteForDevices,
  generateDeviceKeyPair,
  type DeviceDirectory,
  type DeviceKeyPair,
  type NotePayloadV1,
} from "./recordCrypto.ts";
import type { AllowedSender } from "./allowlist.ts";

export const defaultRelay = "https://app.olaink.com";
/** The Supernote plugin only accepts `.note` payloads with this MIME type. */
export const NOTE_MIME = "application/x-supernote";

/**
 * Where device state, received notes, and the conversation journal live.
 * `OLAINK_PI_STATE_DIR` exists so a test or a second identity never touches
 * the real pairing.
 */
export function stateDir(): string {
  return process.env.OLAINK_PI_STATE_DIR || join(homedir(), ".pi", "agent", "olaink");
}

export type DeviceState = {
  deviceId: string;
  publicKeySpki: string;
  privateKeyPkcs8: string;
  userId: string;
  username?: string;
  deviceSessionToken: string;
  relay: string;
  /**
   * Restricts which paired-account senders this device will process notes
   * from. `undefined` accepts anyone who knows your username (the historic
   * default); a configured list, even an empty one, is fail-closed. See
   * ./allowlist.ts.
   */
  allowedSenders?: AllowedSender[];
};

/** One encrypted delivery as `/v1/companion/poll` returns it. */
export type RelayRecord = { id: string; fromUserId: string } & Record<string, unknown>;

export async function loadState(): Promise<DeviceState | undefined> {
  try {
    return JSON.parse(await readFile(join(stateDir(), "device.json"), "utf8")) as DeviceState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveState(state: DeviceState): Promise<void> {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  const path = join(stateDir(), "device.json");
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Only HTTPS relays, except a local development relay. */
export function assertRelayOrigin(relayArg: string): string {
  const url = new URL(relayArg);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("Ola Ink relay must use HTTPS");
  return url.origin;
}

export async function request<T>(state: DeviceState, path: string, body: unknown): Promise<T> {
  const response = await fetch(new URL(path, state.relay), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-olaink-device-session": state.deviceSessionToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json() as { ok?: boolean; error?: string } & T;
  if (!response.ok || !result.ok) throw new Error(`Ola Ink returned HTTP ${response.status}: ${result.error ?? "request failed"}`);
  return result;
}

export async function pair(codeArg: string, relayArg: string): Promise<DeviceState> {
  const code = codeArg.replace(/\D/g, "");
  if (!/^\d{8}$/.test(code)) throw new Error("Usage: /olaink pair 1234-5678 [relay-url]");
  const relay = assertRelayOrigin(relayArg || defaultRelay);
  const keys = await generateDeviceKeyPair(randomUUID());
  const privateKeyPkcs8 = Buffer.from(await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64url");
  const response = await fetch(new URL("/v1/pairings/claim", relay), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: `${code.slice(0, 4)}-${code.slice(4)}`,
      device: { deviceId: keys.deviceId, publicKeySpki: keys.publicKeySpki },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json() as { ok?: boolean; error?: string; pairing?: {
    userId: string; deviceSessionToken: string; username?: string;
  } };
  if (!response.ok || !result.ok || !result.pairing) {
    throw new Error(`Pairing failed (HTTP ${response.status}): ${result.error ?? "invalid code"}`);
  }
  const state: DeviceState = {
    deviceId: keys.deviceId,
    publicKeySpki: keys.publicKeySpki,
    privateKeyPkcs8,
    userId: result.pairing.userId,
    ...(result.pairing.username ? { username: result.pairing.username } : {}),
    deviceSessionToken: result.pairing.deviceSessionToken,
    relay,
  };
  await saveState(state);
  return state;
}

/** Looks up a username's account ID and current device directory, the same directory lookup a sender uses to address a note. */
export async function lookupUser(state: DeviceState, usernameArg: string): Promise<{ username: string; directory: DeviceDirectory }> {
  const username = usernameArg.trim().replace(/^@/, "");
  if (!username) throw new Error("A username is required");
  return request<{ username: string; directory: DeviceDirectory }>(
    state, "/v1/companion/directory", { deviceId: state.deviceId, username },
  );
}

/** Resolves a username to the stable account ID behind it. */
export async function resolveSender(state: DeviceState, username: string): Promise<AllowedSender> {
  const result = await lookupUser(state, username);
  return { username: result.username, userId: result.directory.userId };
}

export async function pollRecords(state: DeviceState): Promise<RelayRecord[]> {
  const result = await request<{ records: unknown }>(state, "/v1/companion/poll", { deviceId: state.deviceId });
  return (Array.isArray(result.records) ? result.records : []).filter(
    (record): record is RelayRecord => record !== null && typeof record === "object" && typeof (record as RelayRecord).id === "string",
  );
}

export async function acknowledge(state: DeviceState, recordIds: string[]): Promise<void> {
  if (recordIds.length > 0) await request(state, "/v1/companion/ack", { deviceId: state.deviceId, recordIds });
}

async function deviceKeys(state: DeviceState): Promise<DeviceKeyPair> {
  const privateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8", Buffer.from(state.privateKeyPkcs8, "base64url"), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  );
  return { deviceId: state.deviceId, publicKeySpki: state.publicKeySpki, privateKey: privateKey as unknown as CryptoKey };
}

export async function decryptRecord(state: DeviceState, record: RelayRecord): Promise<NotePayloadV1> {
  return decryptNoteForDevice(record, await deviceKeys(state));
}

/**
 * Encrypts a whole `.note` to `to`'s devices and sends it. The recipient is
 * re-resolved first and must still be the expected account, so a renamed or
 * retired username can never redirect a reply. A stale directory (a device
 * was added or removed since the lookup) is retried once.
 */
export async function sendNote(
  state: DeviceState, to: AllowedSender, payload: { filename: string; note: Uint8Array },
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const { username, directory } = await lookupUser(state, to.username);
    if (directory.userId !== to.userId) throw new Error(`@${to.username} no longer belongs to the expected account; not sending`);
    const record = await encryptNoteForDevices(
      {
        filename: payload.filename,
        mime: NOTE_MIME,
        note: payload.note,
        ...(state.username ? { senderUsername: state.username } : {}),
      },
      { fromUserId: state.userId, fromDeviceId: state.deviceId, directory },
    );
    try {
      await request(state, "/v1/companion/notes", { deviceId: state.deviceId, username, record });
      return record.id;
    } catch (error) {
      if (attempt > 0 || !String(error).includes("invalid_note")) throw error;
    }
  }
}
