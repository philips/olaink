import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describeAllowlist, partitionRecordsByAllowlist, allowedSenderIds, type AllowedSender } from "./allowlist.ts";
import { ConversationController, type Exchange } from "./conversation.ts";
import { FileJournal } from "./journal.ts";
import { buildReplyNote, noteToPdf, readNote, replyFilename, type MessageContent } from "./noteContent.ts";
import {
  acknowledge,
  decryptRecord,
  defaultRelay,
  loadState,
  pair,
  pollRecords,
  resolveSender,
  saveState,
  sendNote,
  stateDir,
  type DeviceState,
} from "./relay.ts";

type NotifyLevel = "info" | "warning" | "error";
type UiContext = {
  ui: { notify(message: string, level?: NotifyLevel): void; setStatus?(key: string, text: string | undefined): void };
  isIdle?(): boolean;
};

interface ExtensionAPI {
  registerCommand(name: string, options: {
    description: string;
    handler: (args: string, ctx: UiContext) => Promise<void> | void;
  }): void;
  sendUserMessage(content: string | MessageContent[], options?: { deliverAs?: "steer" | "followUp" }): void;
  on(event: string, handler: (event: any, ctx: UiContext) => unknown): unknown;
}

async function requireState(): Promise<DeviceState> {
  const state = await loadState();
  if (!state) throw new Error("Not paired. On Supernote, create an Ola Ink pairing code, then run /olaink pair CODE.");
  return state;
}

/** `/olaink poll`: fetch every waiting note once and show it to the agent. */
async function receive(state: DeviceState): Promise<{
  count: number;
  rejectedCount: number;
  rejectedSenderIds: string[];
  messages: MessageContent[];
}> {
  const records = await pollRecords(state);
  if (records.length === 0) return { count: 0, rejectedCount: 0, rejectedSenderIds: [], messages: [] };

  // fromUserId is authenticated by the relay at send time (it only accepts a
  // record whose fromUserId matches the sending device's own account), so it
  // is safe to filter on before any decryption happens.
  const { allowed, rejected } = partitionRecordsByAllowlist(records, allowedSenderIds(state.allowedSenders));
  const messages: MessageContent[] = [];
  const acknowledged: string[] = [];
  for (const record of allowed) {
    const payload = await decryptRecord(state, record);
    const note = await readNote(payload.note);
    const pdf = await noteToPdf(payload.note);
    await mkdir(stateDir(), { recursive: true, mode: 0o700 });
    const pdfPath = join(stateDir(), `${record.id}.pdf`);
    await writeFile(pdfPath, pdf, { mode: 0o600 });
    const text = note.pageText.some(Boolean) ? `\nText in the note:\n${note.pageText.filter(Boolean).join("\n\n")}` : "";
    messages.push({ type: "text", text: `Supernote note received: ${payload.filename} (${note.pageCount} page(s)). Searchable PDF saved at ${pdfPath}. Review the page images below.${text}` });
    messages.push(...note.images);
    acknowledged.push(record.id);
  }
  // Consume blocked records too, so a disallowed sender cannot pile up an
  // inbox this device will never surface. Ack only after every allowed
  // record's decryption, conversion, and local PDF persistence succeeded; a
  // failure aborts before acking anything, leaving the whole batch for retry.
  await acknowledge(state, [...acknowledged, ...rejected.map((record) => record.id)]);
  const rejectedSenderIds = [...new Set(rejected.map((record) => typeof record.fromUserId === "string" ? record.fromUserId : "unknown"))];
  return { count: acknowledged.length, rejectedCount: rejected.length, rejectedSenderIds, messages };
}

async function addAllowedSender(state: DeviceState, name: string): Promise<{ state: DeviceState; added: AllowedSender }> {
  const resolved = await resolveSender(state, name);
  const existing = state.allowedSenders ?? [];
  const next = { ...state, allowedSenders: existing.some((entry) => entry.userId === resolved.userId) ? existing : [...existing, resolved] };
  await saveState(next);
  return { state: next, added: resolved };
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
      const { state: next, added } = await addAllowedSender(state, name);
      ctx.ui.notify(`Added @${added.username}. ${describeAllowlist(next.allowedSenders)}`, "info");
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

/** The user message a received note becomes in conversation mode. */
async function conversationPrompt(exchange: Exchange, noteBytes: Uint8Array): Promise<MessageContent[]> {
  const note = await readNote(noteBytes, { scale: 2 });
  const text = note.pageText.map((page, i) => (page ? `Page ${i + 1}:\n${page}` : "")).filter(Boolean).join("\n\n");
  return [
    {
      type: "text",
      text: [
        `Supernote note from @${exchange.from.username}: ${exchange.filename} (${note.pageCount} page(s)). The page images follow.`,
        text ? `\nText found in the note (typed text boxes exactly; handwriting recognition may contain errors):\n${text}\n` : "",
        "Conversation mode is on: your final message will be typeset and sent back to their Supernote as a .note file for them to read on e-ink.",
        "Answer what they wrote. Use plain text or light Markdown (short headings, lists); avoid tables, images, and very long code. Be concise.",
      ].join("\n"),
    },
    ...note.images,
  ];
}

const USAGE = "Usage: /olaink pair CODE [relay-url] | poll | status | allow [list|add|remove|clear] [USERNAME] | converse [on [USERNAME]|off|drop] | reply USERNAME TEXT";

export default function (pi: ExtensionAPI) {
  let latestCtx: UiContext | undefined;
  const remember = (ctx: UiContext | undefined) => { if (ctx) latestCtx = ctx; };
  const journal = () => new FileJournal(join(stateDir(), "conversation"));

  const conversation = new ConversationController({
    allowedSenders: async () => (await loadState())?.allowedSenders,
    poll: async () => pollRecords(await requireState()),
    ack: async (ids) => acknowledge(await requireState(), ids),
    decrypt: async (record) => {
      const payload = await decryptRecord(await requireState(), record);
      return { filename: payload.filename, note: payload.note };
    },
    prompt: async (exchange, note) => {
      pi.sendUserMessage(await conversationPrompt(exchange, note));
    },
    reply: async (exchange, text) => {
      const state = await requireState();
      const built = buildReplyNote(text);
      const filename = replyFilename(exchange.filename);
      await journal().saveReply(exchange.recordId, built.note);
      const recordId = await sendNote(state, exchange.from, { filename, note: built.note });
      return { recordId, filename };
    },
    isIdle: () => latestCtx?.isIdle?.() ?? true,
    get journal() { return journal(); },
    notify: (message, level) => latestCtx?.ui.notify(message, level),
    status: (text) => latestCtx?.ui.setStatus?.("olaink", text),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  }, process.env.OLAINK_PI_POLL_MS ? { pollMs: Number(process.env.OLAINK_PI_POLL_MS) } : {});

  pi.on("agent_start", (_event, ctx) => { remember(ctx); conversation.onAgentStart(); });
  pi.on("agent_end", (event, ctx) => { remember(ctx); conversation.onAgentEnd(event?.messages ?? []); });
  pi.on("agent_settled", async (_event, ctx) => { remember(ctx); await conversation.onAgentSettled(); });
  pi.on("session_shutdown", () => conversation.stop());

  pi.registerCommand("olaink", {
    description: "Exchange Supernote notes with Ola Ink (pair CODE | poll | status | allow ... | converse on/off | reply USERNAME TEXT)",
    handler: async (args, ctx) => {
      remember(ctx);
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
            ? `Paired${state.username ? ` as @${state.username}` : ""} via ${state.relay}. ${describeAllowlist(state.allowedSenders)} ${conversation.describe()}`
            : "Not paired. Use /olaink pair CODE.", "info");
          return;
        }
        if (!state) throw new Error("Not paired. On Supernote, create an Ola Ink pairing code, then run /olaink pair CODE.");
        if (action === "allow") {
          await handleAllowCommand(state, rest, ctx);
          return;
        }
        if (action === "converse") {
          const [sub = "status", username] = rest;
          if (sub === "on") {
            if (username) {
              const { added } = await addAllowedSender(state, username);
              ctx.ui.notify(`Allowed @${added.username}.`, "info");
            }
            await conversation.start();
          } else if (sub === "off") {
            conversation.stop();
            ctx.ui.notify("Conversation mode off. Notes stay on the relay until you poll or turn it back on.", "info");
          } else if (sub === "drop") {
            ctx.ui.notify(`Dropped ${await conversation.dropInterrupted()} interrupted note(s).`, "info");
          } else {
            ctx.ui.notify(conversation.describe(), "info");
          }
          return;
        }
        if (action === "reply") {
          // Debug/manual: typeset TEXT and send it to an allowed sender.
          const [username, ...words] = rest;
          const to = (state.allowedSenders ?? []).find((s) => s.username === username?.replace(/^@/, "").toLowerCase());
          if (!to || words.length === 0) throw new Error("Usage: /olaink reply USERNAME TEXT (USERNAME must be on the allowlist)");
          const built = buildReplyNote(words.join(" "));
          await sendNote(state, to, { filename: "Pi.note", note: built.note });
          ctx.ui.notify(`Sent a ${built.pages}-page note to @${to.username}.`, "info");
          return;
        }
        if (action !== "poll") throw new Error(USAGE);
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
