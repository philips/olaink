import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SupernoteX, toImage, toPdf } from "supernote-typescript";
import { encodePng } from "image-js";
import { decryptNoteForDevice, generateDeviceKeyPair } from "../server/src/prototypeNoteCrypto.ts";

interface ExtensionAPI {
  registerCommand(name: string, options: {
    description: string;
    handler: (args: string, ctx: { ui: { notify(message: string, level: string): void } }) => Promise<void> | void;
  }): void;
  sendUserMessage(content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>): void;
}

const MAX_NOTE_BYTES = 16 * 1024 * 1024;
const MAX_PAGES = 20;
const defaultRelay = "https://app.olaink.com";
const stateDir = join(homedir(), ".pi", "agent", "olaink");
const statePath = join(stateDir, "device.json");

type DeviceState = {
  deviceId: string;
  publicKeySpki: string;
  privateKeyPkcs8: string;
  userId: string;
  username?: string;
  deviceSessionToken: string;
  relay: string;
};

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function loadState(): Promise<DeviceState | undefined> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as DeviceState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveState(state: DeviceState): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(statePath, 0o600);
}

async function request<T>(state: DeviceState, path: string, body: unknown): Promise<T> {
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

async function pair(codeArg: string, relayArg: string): Promise<DeviceState> {
  const code = codeArg.replace(/\D/g, "");
  if (!/^\d{8}$/.test(code)) throw new Error("Usage: /olaink pair 1234-5678 [relay-url]");
  const relay = new URL(relayArg || defaultRelay).origin;
  if (new URL(relay).protocol !== "https:" && new URL(relay).hostname !== "localhost") {
    throw new Error("Ola Ink relay must use HTTPS");
  }
  const keys = await generateDeviceKeyPair(randomUUID());
  const privateKeyPkcs8 = b64url(new Uint8Array(await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey)));
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

async function receive(state: DeviceState): Promise<{ count: number; messages: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> }> {
  const result = await request<{ records: Array<any> }>(state, "/v1/companion/poll", { deviceId: state.deviceId });
  const records = Array.isArray(result.records) ? result.records : [];
  if (records.length === 0) return { count: 0, messages: [{ type: "text", text: "No Ola Ink notes are waiting." }] };

  const privateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8", Buffer.from(state.privateKeyPkcs8, "base64url"), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  );
  const device = { deviceId: state.deviceId, publicKeySpki: state.publicKeySpki, privateKey: privateKey as unknown as CryptoKey };
  const messages: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  let acknowledged: string[] = [];
  for (const record of records) {
    const payload = await decryptNoteForDevice(record, device);
    if (payload.note.byteLength < 1 || payload.note.byteLength > MAX_NOTE_BYTES) throw new Error("Received note exceeds the supported size limit");
    const note = new SupernoteX(Buffer.from(payload.note));
    if (note.pages.length > MAX_PAGES) throw new Error(`Note has ${note.pages.length} pages; limit is ${MAX_PAGES} to keep model input bounded`);
    const pdf = await toPdf(note);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const pdfPath = join(stateDir, `${record.id}.pdf`);
    await writeFile(pdfPath, pdf, { mode: 0o600 });
    messages.push({ type: "text", text: `Supernote note received: ${payload.filename} (${note.pages.length} page(s)). Searchable PDF saved at ${pdfPath}. Review the page images below.` });
    for (const image of await toImage(note)) {
      const png = encodePng(image);
      messages.push({ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" });
    }
    acknowledged.push(record.id);
  }
  // Ack only after successful decryption, conversion, and local PDF persistence.
  await request(state, "/v1/companion/ack", { deviceId: state.deviceId, recordIds: acknowledged });
  return { count: acknowledged.length, messages };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("olaink", {
    description: "Pair this Pi agent with Ola Ink and receive Supernote notes (pair CODE | poll | status)",
    handler: async (args, ctx) => {
      const [action = "poll", ...rest] = args.trim().split(/\s+/);
      try {
        if (action === "pair") {
          const paired = await pair(rest[0] ?? "", rest[1] ?? defaultRelay);
          ctx.ui.notify(`Paired to Ola Ink${paired.username ? ` as @${paired.username}` : ""}. Run /olaink poll to receive notes.`, "success");
          return;
        }
        const state = await loadState();
        if (action === "status") {
          ctx.ui.notify(state ? `Paired${state.username ? ` as @${state.username}` : ""} via ${state.relay}` : "Not paired. Use /olaink pair CODE.", "info");
          return;
        }
        if (action !== "poll") throw new Error("Usage: /olaink pair CODE [relay-url] | /olaink poll | /olaink status");
        if (!state) throw new Error("Not paired. On Supernote, create an Ola Ink pairing code, then run /olaink pair CODE.");
        const received = await receive(state);
        if (received.count === 0) {
          ctx.ui.notify("Ola Ink inbox is empty.", "info");
          return;
        }
        pi.sendUserMessage(received.messages);
        ctx.ui.notify(`Sent ${received.count} note(s) and page images to the agent.`, "success");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
