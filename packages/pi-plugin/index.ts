import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SupernoteX, toImage, toPdf } from "supernote-typescript";
import { encodePng } from "image-js";
import { decryptNoteForDevice, generateDeviceKeyPair } from "./recordCrypto.ts";
import { allowedSenderIds, describeAllowlist, partitionRecordsByAllowlist, type AllowedSender } from "./allowlist.ts";

type NotifyLevel = "info" | "warning" | "error";
type UiContext = { ui: { notify(message: string, level?: NotifyLevel): void } };

interface ExtensionAPI {
  registerCommand(name: string, options: {
    description: string;
    handler: (args: string, ctx: UiContext) => Promise<void> | void;
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
  /**
   * Restricts which paired-account senders this device will process notes
   * from. `undefined` accepts anyone who knows your username (the historic
   * default); a configured list, even an empty one, is fail-closed. See
   * ./allowlist.ts.
   */
  allowedSenders?: AllowedSender[];
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

/** Resolves a companion-visible username to the stable account ID behind it, via the same directory lookup the sender uses to address a note. */
async function resolveSender(state: DeviceState, usernameArg: string): Promise<AllowedSender> {
  const username = usernameArg.trim().replace(/^@/, "");
  if (!username) throw new Error("Usage: /olaink allow add USERNAME");
  const result = await request<{ username: string; directory: { userId: string } }>(
    state, "/v1/companion/directory", { deviceId: state.deviceId, username },
  );
  return { username: result.username, userId: result.directory.userId };
}

async function receive(state: DeviceState): Promise<{
  count: number;
  rejectedCount: number;
  rejectedSenderIds: string[];
  messages: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
}> {
  const result = await request<{ records: Array<any> }>(state, "/v1/companion/poll", { deviceId: state.deviceId });
  const records = Array.isArray(result.records) ? result.records : [];
  if (records.length === 0) {
    return { count: 0, rejectedCount: 0, rejectedSenderIds: [], messages: [{ type: "text", text: "No Ola Ink notes are waiting." }] };
  }

  // fromUserId is authenticated by the relay at send time (it only accepts a
  // record whose fromUserId matches the sending device's own account), so it
  // is safe to filter on before any decryption happens.
  const { allowed, rejected } = partitionRecordsByAllowlist(records, allowedSenderIds(state.allowedSenders));

  const privateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8", Buffer.from(state.privateKeyPkcs8, "base64url"), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  );
  const device = { deviceId: state.deviceId, publicKeySpki: state.publicKeySpki, privateKey: privateKey as unknown as CryptoKey };
  const messages: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  const acknowledged: string[] = [];
  for (const record of allowed) {
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
  // Consume blocked records too, so a disallowed sender cannot pile up an
  // inbox this device will never surface. Ack only after every allowed
  // record's decryption, conversion, and local PDF persistence succeeded; a
  // failure aborts before acking anything, leaving the whole batch for retry.
  const rejectedIds = rejected.filter((record): record is { id: string } => typeof record.id === "string").map((record) => record.id);
  const toAck = [...acknowledged, ...rejectedIds];
  if (toAck.length > 0) await request(state, "/v1/companion/ack", { deviceId: state.deviceId, recordIds: toAck });
  const rejectedSenderIds = [...new Set(rejected.map((record) => typeof record.fromUserId === "string" ? record.fromUserId : "unknown"))];
  return { count: acknowledged.length, rejectedCount: rejected.length, rejectedSenderIds, messages };
}

async function handleAllowCommand(state: DeviceState, rest: string[], ctx: UiContext): Promise<void> {
  const [sub = "list", ...names] = rest;
  if (sub === "list") {
    ctx.ui.notify(describeAllowlist(state.allowedSenders), "info");
    return;
  }
  if (sub === "clear") {
    const { allowedSenders: _drop, ...next } = state;
    await saveState(next);
    ctx.ui.notify("Sender restriction removed. Notes are now accepted from anyone who knows your username.", "warning");
    return;
  }
  if (sub === "add" || sub === "remove") {
    const name = names[0];
    if (!name) throw new Error(`Usage: /olaink allow ${sub} USERNAME`);
    if (sub === "add") {
      const resolved = await resolveSender(state, name);
      const existing = state.allowedSenders ?? [];
      const next = existing.some((entry) => entry.userId === resolved.userId) ? existing : [...existing, resolved];
      await saveState({ ...state, allowedSenders: next });
      ctx.ui.notify(`Added @${resolved.username}. ${describeAllowlist(next)}`, "info");
    } else {
      const target = name.trim().replace(/^@/, "").toLowerCase();
      const next = (state.allowedSenders ?? []).filter((entry) => entry.username !== target);
      await saveState({ ...state, allowedSenders: next });
      ctx.ui.notify(`Removed @${target}. ${describeAllowlist(next)}`, "info");
    }
    return;
  }
  // A bare list of usernames (no recognized subcommand) replaces the allowlist wholesale.
  const resolved = await Promise.all([sub, ...names].map((name) => resolveSender(state, name)));
  await saveState({ ...state, allowedSenders: resolved });
  ctx.ui.notify(describeAllowlist(resolved), "info");
}

const USAGE = "Usage: /olaink pair CODE [relay-url] | /olaink poll | /olaink status | /olaink allow [list|add|remove|clear] [USERNAME]";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("olaink", {
    description: "Pair this Pi agent with Ola Ink, receive Supernote notes, and manage the sender allowlist (pair CODE | poll | status | allow ...)",
    handler: async (args, ctx) => {
      const [action = "poll", ...rest] = args.trim().split(/\s+/);
      try {
        if (action === "pair") {
          const paired = await pair(rest[0] ?? "", rest[1] ?? defaultRelay);
          ctx.ui.notify(`Paired to Ola Ink${paired.username ? ` as @${paired.username}` : ""}. Run /olaink poll to receive notes. By default any sender who knows your username can send you a note; run /olaink allow add USERNAME to restrict senders.`, "info");
          return;
        }
        const state = await loadState();
        if (action === "status") {
          ctx.ui.notify(state
            ? `Paired${state.username ? ` as @${state.username}` : ""} via ${state.relay}. ${describeAllowlist(state.allowedSenders)}`
            : "Not paired. Use /olaink pair CODE.", "info");
          return;
        }
        if (action === "allow") {
          if (!state) throw new Error("Not paired. Use /olaink pair CODE first.");
          await handleAllowCommand(state, rest, ctx);
          return;
        }
        if (action !== "poll") throw new Error(USAGE);
        if (!state) throw new Error("Not paired. On Supernote, create an Ola Ink pairing code, then run /olaink pair CODE.");
        const received = await receive(state);
        if (received.rejectedCount > 0) {
          ctx.ui.notify(
            `Blocked ${received.rejectedCount} note(s) from sender(s) not on your allowlist (account ${received.rejectedSenderIds.length === 1 ? "id" : "ids"} ${received.rejectedSenderIds.join(", ")}).`,
            "warning",
          );
        }
        if (received.count === 0) {
          if (received.rejectedCount === 0) ctx.ui.notify("Ola Ink inbox is empty.", "info");
          return;
        }
        pi.sendUserMessage(received.messages);
        ctx.ui.notify(`Sent ${received.count} note(s) and page images to the agent.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
