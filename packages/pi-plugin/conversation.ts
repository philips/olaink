/**
 * Conversation mode: poll the relay while Pi is idle, hand one received note
 * at a time to the agent, and send the agent's final answer back to the
 * sender as a typeset `.note`.
 *
 *   idle ──tick──▶ polling ──allowed record──▶ waiting (agent run) ──settled──▶ replying ──▶ idle
 *
 * Everything with side effects is injected, so the state machine is tested
 * without a relay, a model, or timers.
 */
import { partitionRecordsByAllowlist, type AllowedSender } from "./allowlist.ts";
import type { RelayRecord } from "./relay.ts";

export type ExchangeState = "staged" | "prompted" | "replied" | "failed" | "dropped";

/** One received note and what became of it; persisted in the journal. */
export type Exchange = {
  recordId: string;
  from: AllowedSender;
  filename: string;
  receivedAt: number;
  state: ExchangeState;
  replyRecordId?: string;
  replyFilename?: string;
  error?: string;
};

export interface Journal {
  list(): Promise<Exchange[]>;
  put(exchange: Exchange): Promise<void>;
  /** Persists the received note so an interrupted exchange can resume. */
  saveNote(recordId: string, note: Uint8Array): Promise<void>;
  loadNote(recordId: string): Promise<Uint8Array>;
}

export interface ConversationDeps {
  allowedSenders(): Promise<AllowedSender[] | undefined>;
  poll(): Promise<RelayRecord[]>;
  ack(recordIds: string[]): Promise<void>;
  decrypt(record: RelayRecord): Promise<{ filename: string; note: Uint8Array }>;
  /** Hands the note to the agent as a new user message. */
  prompt(exchange: Exchange, note: Uint8Array): Promise<void>;
  /** Typesets and sends the reply; returns the outgoing record ID and filename. */
  reply(exchange: Exchange, text: string): Promise<{ recordId: string; filename: string }>;
  isIdle(): boolean;
  journal: Journal;
  notify(message: string, level: "info" | "warning" | "error"): void;
  status(text: string | undefined): void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
}

export type ConversationPhase = "stopped" | "idle" | "polling" | "waiting" | "replying";

type AssistantLikeMessage = { role?: string; content?: unknown; stopReason?: string };

/** The text of the last assistant message in an agent run. */
export function finalAssistantText(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as AssistantLikeMessage;
    if (message?.role !== "assistant") continue;
    const content = message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("")
        : "";
    if (text.trim()) return text.trim();
  }
  return undefined;
}

export class ConversationController {
  static readonly POLL_MS = 20_000;
  static readonly MAX_BACKOFF_MS = 5 * 60_000;

  phase: ConversationPhase = "stopped";
  private timer: unknown;
  private failures = 0;
  private current: Exchange | undefined;
  private runStarted = false;
  private replyText: string | undefined;
  private readonly pollMs: number;

  constructor(private readonly deps: ConversationDeps, options: { pollMs?: number } = {}) {
    this.pollMs = options.pollMs ?? ConversationController.POLL_MS;
  }

  get active(): boolean {
    return this.phase !== "stopped";
  }

  get exchange(): Exchange | undefined {
    return this.current;
  }

  /** Starts polling. Refuses without a configured, non-empty allowlist. */
  async start(): Promise<void> {
    const allowed = await this.deps.allowedSenders();
    if (!allowed || allowed.length === 0) {
      throw new Error("Conversation mode sends every received note to the agent, so it needs a sender allowlist. Run /olaink allow add USERNAME (or /olaink converse on USERNAME) first.");
    }
    if (this.active) return;
    this.phase = "idle";
    this.failures = 0;
    this.deps.notify(`Conversation mode on: waiting for notes from ${allowed.map((s) => `@${s.username}`).join(", ")}.`, "info");
    const interrupted = (await this.deps.journal.list()).filter((e) => e.state === "staged" || e.state === "prompted");
    if (interrupted.length > 0) {
      this.deps.notify(`Resuming ${interrupted.length} interrupted note(s) first.`, "info");
    }
    this.schedule(0);
  }

  stop(): void {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
    this.phase = "stopped";
    this.current = undefined;
    this.deps.status(undefined);
  }

  describe(): string {
    if (!this.active) return "Conversation mode is off.";
    if (this.current) return `Conversation mode: ${this.phase} (${this.current.filename} from @${this.current.from.username}).`;
    return `Conversation mode: ${this.phase}, polling every ${Math.round(this.pollMs / 1000)}s.`;
  }

  private schedule(ms: number): void {
    if (!this.active) return;
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => {
      this.timer = undefined;
      void this.tick();
    }, ms);
  }

  private setStatus(): void {
    const who = this.current ? ` @${this.current.from.username}` : "";
    const label = { stopped: undefined, idle: "✉ waiting for notes", polling: "✉ checking", waiting: `✉${who} · thinking`, replying: `✉${who} · sending reply` }[this.phase];
    this.deps.status(label);
  }

  /** One polling cycle; exported for tests. */
  async tick(): Promise<void> {
    if (this.phase !== "idle") return;
    // Never interrupt the user or a running agent.
    if (!this.deps.isIdle()) return this.schedule(this.pollMs);
    this.phase = "polling";
    this.setStatus();
    try {
      const exchange = await this.nextExchange();
      this.failures = 0;
      if (!this.active) return;
      if (!exchange) {
        this.phase = "idle";
        this.setStatus();
        return this.schedule(this.pollMs);
      }
      await this.promptAgent(exchange);
    } catch (error) {
      if (!this.active) return;
      this.phase = "idle";
      this.current = undefined;
      this.failures++;
      const delay = Math.min(this.pollMs * 2 ** this.failures, ConversationController.MAX_BACKOFF_MS);
      this.deps.notify(`Ola Ink: ${message(error)} (retrying in ${Math.round(delay / 1000)}s)`, "warning");
      this.setStatus();
      this.schedule(delay);
    }
  }

  /** An interrupted exchange first, else the oldest allowed record on the relay. */
  private async nextExchange(): Promise<Exchange | undefined> {
    const interrupted = (await this.deps.journal.list())
      .filter((e) => e.state === "staged" || e.state === "prompted")
      .sort((a, b) => a.receivedAt - b.receivedAt)[0];
    if (interrupted) return interrupted;

    const allowed = await this.deps.allowedSenders();
    if (!allowed || allowed.length === 0) throw new Error("the sender allowlist is empty");
    const records = await this.deps.poll();
    if (records.length === 0) return undefined;
    const { allowed: accepted, rejected } = partitionRecordsByAllowlist(records, new Set(allowed.map((s) => s.userId)));
    if (rejected.length > 0) {
      await this.deps.ack(rejected.map((r) => r.id));
      this.deps.notify(`Blocked ${rejected.length} note(s) from sender(s) not on your allowlist.`, "warning");
    }
    const handled = new Set((await this.deps.journal.list()).map((e) => e.recordId));
    for (const record of accepted) {
      // Already processed (e.g. the ack was lost): just consume it again.
      if (handled.has(record.id)) {
        await this.deps.ack([record.id]);
        continue;
      }
      const from = allowed.find((s) => s.userId === record.fromUserId)!;
      const { filename, note } = await this.deps.decrypt(record);
      const exchange: Exchange = { recordId: record.id, from, filename, receivedAt: this.deps.now(), state: "staged" };
      // Durable locally before the relay forgets it; one note per cycle, the
      // rest stay queued on the relay.
      await this.deps.journal.saveNote(record.id, note);
      await this.deps.journal.put(exchange);
      await this.deps.ack([record.id]);
      return exchange;
    }
    return undefined;
  }

  private async promptAgent(exchange: Exchange): Promise<void> {
    this.current = exchange;
    this.runStarted = false;
    this.replyText = undefined;
    this.phase = "waiting";
    this.setStatus();
    const note = await this.deps.journal.loadNote(exchange.recordId);
    exchange.state = "prompted";
    await this.deps.journal.put(exchange);
    await this.deps.prompt(exchange, note);
  }

  /** Pi `agent_start`: the run we prompted has begun. */
  onAgentStart(): void {
    if (this.phase === "waiting") this.runStarted = true;
  }

  /** Pi `agent_end`: remember the run's final answer. */
  onAgentEnd(messages: readonly unknown[]): void {
    if (this.phase === "waiting" && this.runStarted) this.replyText = finalAssistantText(messages) ?? this.replyText;
  }

  /** Pi `agent_settled`: no retry or continuation will follow; send the reply. */
  async onAgentSettled(): Promise<void> {
    if (this.phase !== "waiting" || !this.runStarted || !this.current) return;
    const exchange = this.current;
    const text = this.replyText;
    if (!text) {
      await this.finish(exchange, { state: "failed", error: "the agent produced no answer" });
      this.deps.notify(`Ola Ink: no answer to send for ${exchange.filename}; it was not replied to.`, "warning");
      return;
    }
    this.phase = "replying";
    this.setStatus();
    try {
      const sent = await this.deps.reply(exchange, text);
      await this.finish(exchange, { state: "replied", replyRecordId: sent.recordId, replyFilename: sent.filename });
      this.deps.notify(`Sent ${sent.filename} to @${exchange.from.username}.`, "info");
    } catch (error) {
      await this.finish(exchange, { state: "failed", error: message(error) });
      this.deps.notify(`Ola Ink: could not send the reply to ${exchange.filename}: ${message(error)}`, "error");
    }
  }

  private async finish(exchange: Exchange, update: Partial<Exchange>): Promise<void> {
    Object.assign(exchange, update);
    await this.deps.journal.put(exchange);
    this.current = undefined;
    this.replyText = undefined;
    this.runStarted = false;
    if (!this.active) return;
    this.phase = "idle";
    this.setStatus();
    // Check right away: the sender may already have written back.
    this.schedule(0);
  }

  /** Marks interrupted exchanges as dropped so they are not resumed. */
  async dropInterrupted(): Promise<number> {
    const interrupted = (await this.deps.journal.list()).filter((e) => (e.state === "staged" || e.state === "prompted") && e !== this.current);
    for (const exchange of interrupted) await this.deps.journal.put({ ...exchange, state: "dropped" });
    return interrupted.length;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
