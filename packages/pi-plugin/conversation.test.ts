import { beforeEach, describe, expect, test } from "vitest";
import type { AllowedSender } from "./allowlist.ts";
import { ConversationController, finalAssistantText, type ConversationDeps, type Exchange, type Journal } from "./conversation.ts";
import type { RelayRecord } from "./relay.ts";

const alice: AllowedSender = { username: "alice", userId: "account_alice" };

class MemoryJournal implements Journal {
  entries = new Map<string, Exchange>();
  notes = new Map<string, Uint8Array>();
  async list() { return [...this.entries.values()].map((e) => ({ ...e })); }
  async put(exchange: Exchange) { this.entries.set(exchange.recordId, { ...exchange }); }
  async saveNote(id: string, note: Uint8Array) { this.notes.set(id, note); }
  async loadNote(id: string) {
    const note = this.notes.get(id);
    if (!note) throw new Error(`no note ${id}`);
    return note;
  }
}

/** A fake relay + agent + clock driving the controller deterministically. */
class Harness {
  relay: RelayRecord[] = [];
  acked: string[] = [];
  prompts: Exchange[] = [];
  replies: { exchange: Exchange; text: string }[] = [];
  notices: string[] = [];
  statuses: (string | undefined)[] = [];
  timers: { callback: () => void; ms: number }[] = [];
  allowed: AllowedSender[] | undefined = [alice];
  idle = true;
  failPoll: Error | undefined;
  failReply: Error | undefined;
  journal = new MemoryJournal();
  controller: ConversationController;

  constructor() {
    const deps: ConversationDeps = {
      allowedSenders: async () => this.allowed,
      poll: async () => {
        if (this.failPoll) throw this.failPoll;
        return [...this.relay];
      },
      ack: async (ids) => {
        this.acked.push(...ids);
        this.relay = this.relay.filter((r) => !ids.includes(r.id));
      },
      decrypt: async (record) => ({ filename: `${record.id}.note`, note: new TextEncoder().encode(`note ${record.id}`) }),
      prompt: async (exchange) => { this.prompts.push({ ...exchange }); },
      reply: async (exchange, text) => {
        if (this.failReply) throw this.failReply;
        this.replies.push({ exchange: { ...exchange }, text });
        return { recordId: `reply-${exchange.recordId}`, filename: `Re-${exchange.filename}` };
      },
      isIdle: () => this.idle,
      journal: this.journal,
      notify: (message) => { this.notices.push(message); },
      status: (text) => { this.statuses.push(text); },
      setTimer: (callback, ms) => {
        const timer = { callback, ms };
        this.timers.push(timer);
        return timer;
      },
      clearTimer: (handle) => { this.timers = this.timers.filter((t) => t !== handle); },
      now: () => 1_000,
    };
    this.controller = new ConversationController(deps, { pollMs: 1_000 });
  }

  /** Runs the next scheduled timer and lets its async work finish. */
  async fire(): Promise<number> {
    const timer = this.timers.shift();
    if (!timer) throw new Error("nothing scheduled");
    timer.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return timer.ms;
  }

  /** Simulates Pi running the prompted turn to completion. */
  async agentAnswers(text: string | undefined): Promise<void> {
    this.controller.onAgentStart();
    this.controller.onAgentEnd(text === undefined ? [] : [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "text", text }] },
    ]);
    await this.controller.onAgentSettled();
  }
}

const record = (id: string, fromUserId = alice.userId): RelayRecord => ({ id, fromUserId });

describe("ConversationController", () => {
  let h: Harness;
  beforeEach(() => { h = new Harness(); });

  test("refuses to start without an allowlist", async () => {
    h.allowed = undefined;
    await expect(h.controller.start()).rejects.toThrow(/allowlist/);
    h.allowed = [];
    await expect(h.controller.start()).rejects.toThrow(/allowlist/);
    expect(h.controller.active).toBe(false);
  });

  test("a full exchange: stage, ack, prompt, reply, then poll again right away", async () => {
    h.relay = [record("r1"), record("r2")];
    await h.controller.start();
    expect(await h.fire()).toBe(0);

    // One note per cycle, durable locally before the ack.
    expect(h.journal.notes.has("r1")).toBe(true);
    expect(h.acked).toEqual(["r1"]);
    expect(h.relay.map((r) => r.id)).toEqual(["r2"]);
    expect(h.prompts.map((p) => p.recordId)).toEqual(["r1"]);
    expect(h.controller.phase).toBe("waiting");
    expect((await h.journal.list())[0]!.state).toBe("prompted");

    await h.agentAnswers("The answer is 391.");
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]!.text).toBe("The answer is 391.");
    expect(h.replies[0]!.exchange.from).toEqual(alice);
    const entry = h.journal.entries.get("r1")!;
    expect(entry).toMatchObject({ state: "replied", replyRecordId: "reply-r1", replyFilename: "Re-r1.note" });
    expect(h.controller.phase).toBe("idle");

    // The next note is picked up on the immediate re-poll.
    expect(await h.fire()).toBe(0);
    expect(h.prompts.map((p) => p.recordId)).toEqual(["r1", "r2"]);
  });

  test("does nothing but reschedule while Pi is busy", async () => {
    h.relay = [record("r1")];
    h.idle = false;
    await h.controller.start();
    await h.fire();
    expect(h.prompts).toHaveLength(0);
    expect(h.acked).toHaveLength(0);
    expect(h.timers.map((t) => t.ms)).toEqual([1_000]);
  });

  test("consumes records from senders not on the allowlist without prompting", async () => {
    h.relay = [record("spam", "account_mallory"), record("r1")];
    await h.controller.start();
    await h.fire();
    expect(h.acked).toEqual(["spam", "r1"]);
    expect(h.prompts.map((p) => p.recordId)).toEqual(["r1"]);
    expect(h.notices.some((n) => /Blocked 1/.test(n))).toBe(true);
  });

  test("ignores agent runs it did not start, and replies only once the run settles", async () => {
    await h.controller.start();
    // A run the user started while the mode was idle.
    await h.agentAnswers("unrelated");
    expect(h.replies).toHaveLength(0);

    h.relay = [record("r1")];
    await h.fire();
    h.controller.onAgentStart();
    h.controller.onAgentEnd([{ role: "assistant", content: [{ type: "text", text: "draft" }] }]);
    expect(h.replies).toHaveLength(0);
    // A retry/continuation within the same settle window supersedes the draft.
    h.controller.onAgentEnd([{ role: "assistant", content: [{ type: "text", text: "final" }] }]);
    await h.controller.onAgentSettled();
    expect(h.replies.map((r) => r.text)).toEqual(["final"]);
  });

  test("marks the exchange failed when the agent gives no answer", async () => {
    h.relay = [record("r1")];
    await h.controller.start();
    await h.fire();
    await h.agentAnswers(undefined);
    expect(h.replies).toHaveLength(0);
    expect(h.journal.entries.get("r1")!.state).toBe("failed");
    expect(h.controller.phase).toBe("idle");
  });

  test("a failed send is recorded and the loop continues", async () => {
    h.relay = [record("r1")];
    h.failReply = new Error("relay down");
    await h.controller.start();
    await h.fire();
    await h.agentAnswers("hi");
    expect(h.journal.entries.get("r1")).toMatchObject({ state: "failed", error: "relay down" });
    expect(h.timers).toHaveLength(1);
  });

  test("backs off exponentially on relay errors", async () => {
    h.failPoll = new Error("HTTP 503");
    await h.controller.start();
    await h.fire();
    expect(h.timers.map((t) => t.ms)).toEqual([2_000]);
    await h.fire();
    expect(h.timers.map((t) => t.ms)).toEqual([4_000]);
    h.failPoll = undefined;
    await h.fire();
    expect(h.timers.map((t) => t.ms)).toEqual([1_000]);
  });

  test("resumes an interrupted exchange before polling, and can drop one instead", async () => {
    await h.journal.saveNote("old", new Uint8Array([1]));
    await h.journal.put({ recordId: "old", from: alice, filename: "old.note", receivedAt: 1, state: "prompted" });
    h.relay = [record("r1")];
    await h.controller.start();
    await h.fire();
    expect(h.prompts.map((p) => p.recordId)).toEqual(["old"]);
    expect(h.acked).toEqual([]);

    h.controller.stop();
    expect(await h.controller.dropInterrupted()).toBe(1);
    expect(h.journal.entries.get("old")!.state).toBe("dropped");
  });

  test("re-acks a record it already handled instead of answering twice", async () => {
    await h.journal.put({ recordId: "r1", from: alice, filename: "r1.note", receivedAt: 1, state: "replied" });
    h.relay = [record("r1")];
    await h.controller.start();
    await h.fire();
    expect(h.acked).toEqual(["r1"]);
    expect(h.prompts).toHaveLength(0);
  });

  test("stop() cancels polling", async () => {
    await h.controller.start();
    h.controller.stop();
    expect(h.timers).toHaveLength(0);
    expect(h.controller.active).toBe(false);
    expect(h.statuses.at(-1)).toBeUndefined();
  });
});

describe("finalAssistantText", () => {
  test("takes the last assistant message with text", () => {
    expect(finalAssistantText([
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "toolResult", content: [{ type: "text", text: "tool" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "Final " }, { type: "text", text: "answer" }] },
      { role: "assistant", content: [{ type: "toolCall" }] },
    ])).toBe("Final answer");
    expect(finalAssistantText([{ role: "user", content: "hi" }])).toBeUndefined();
  });
});
