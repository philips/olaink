/** User registry, long-poll delivery queues, and durable-in-memory page mailboxes. */

import { randomBytes } from 'node:crypto';
import type { Envelope } from '@olaink/protocol';
import { RESERVED_NAMES } from '@olaink/protocol';

/** Server-side test bot: generates pages on demand. */
export const SWAPTEST = 'swaptest';
export const USER_TTL_MS = 60_000;
export const SWEEP_INTERVAL_MS = 5_000;
export const MAX_PAGE_MAILBOX = 50;

export class UserRec {
  inbox: Envelope[] = [];
  waiter: { resolve: (batch: Envelope[]) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    public username: string,
    public token: string,
    public deviceType: number,
    public client: string,
    public lastSeen: number,
  ) {}
}

export interface RegistryOptions { maxPageMailbox?: number; }

export class Registry {
  private readonly users = new Map<string, UserRec>();
  /** Kept independently of live users so offline recipients retain pages. */
  private readonly pageMailboxes = new Map<string, Envelope[]>();
  private readonly maxPageMailbox: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private now: () => number = Date.now, opts: RegistryOptions = {}) {
    this.maxPageMailbox = opts.maxPageMailbox ?? MAX_PAGE_MAILBOX;
  }

  hello(username: string, deviceType: number, client: string): UserRec {
    const existing = this.users.get(username);
    let rec: UserRec;
    if (existing) {
      // A re-hello supersedes any old long poll before rotating its token.
      if (existing.waiter) {
        clearTimeout(existing.waiter.timer);
        const waiter = existing.waiter;
        existing.waiter = null;
        waiter.resolve(existing.inbox);
        existing.inbox = [];
      }
      existing.token = randomBytes(16).toString('hex');
      existing.deviceType = deviceType;
      existing.client = client;
      existing.lastSeen = this.now();
      rec = existing;
    } else {
      rec = new UserRec(username, randomBytes(16).toString('hex'), deviceType, client, this.now());
      this.users.set(username, rec);
    }
    this.flushPageMailbox(username);
    return rec;
  }

  authenticate(username: string, token: string): UserRec | null {
    const rec = this.users.get(username);
    if (!rec || rec.token !== token) return null;
    rec.lastSeen = this.now();
    return rec;
  }

  getUser(username: string): UserRec | null { return this.users.get(username) ?? null; }

  peers(): Array<{ username: string; deviceType: number; client: string; lastSeen: number; idleMs: number; inbox: number; pages: number }> {
    const now = this.now();
    return [...this.users.values()].map((u) => ({
      username: u.username,
      deviceType: u.deviceType,
      client: u.client,
      lastSeen: u.lastSeen,
      idleMs: now - u.lastSeen,
      inbox: u.inbox.length,
      pages: this.pageMailboxSize(u.username),
    }));
  }

  get onlineUsernames(): string[] { return [...this.users.keys()]; }

  dropUser(username: string): void {
    const rec = this.users.get(username);
    if (!rec) return;
    this.users.delete(username);
    if (rec.waiter) {
      clearTimeout(rec.waiter.timer);
      rec.waiter.resolve([]);
      rec.waiter = null;
    }
  }

  queuePage(to: string, env: Envelope): void {
    let box = this.pageMailboxes.get(to);
    if (!box) { box = []; this.pageMailboxes.set(to, box); }
    box.push(env);
    if (box.length > this.maxPageMailbox) box.splice(0, box.length - this.maxPageMailbox);
    if (this.users.has(to)) this.deliver(to, env);
  }

  flushPageMailbox(username: string): void {
    const box = this.pageMailboxes.get(username);
    if (!box) return;
    for (const env of box) this.deliver(username, env);
  }

  ackPages(username: string, ids: Iterable<string>): number {
    const box = this.pageMailboxes.get(username);
    if (!box) return 0;
    const idSet = new Set(ids);
    const before = box.length;
    for (let i = box.length - 1; i >= 0; i--) if (idSet.has(box[i]!.id)) box.splice(i, 1);
    if (box.length === 0) this.pageMailboxes.delete(username);
    return before - box.length;
  }

  pageMailboxSize(username: string): number { return this.pageMailboxes.get(username)?.length ?? 0; }

  deliver(username: string, env: Envelope): void {
    const rec = this.users.get(username);
    if (!rec) return;
    if (rec.waiter) {
      const batch = [...rec.inbox, env];
      rec.inbox = [];
      clearTimeout(rec.waiter.timer);
      const waiter = rec.waiter;
      rec.waiter = null;
      waiter.resolve(batch);
      return;
    }
    rec.inbox.push(env);
  }


  async poll(username: string, waitMs: number): Promise<Envelope[]> {
    const rec = this.users.get(username);
    if (!rec) return [];
    if (rec.inbox.length > 0) { const batch = rec.inbox; rec.inbox = []; return batch; }
    if (waitMs <= 0 || rec.waiter) return [];
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        rec.waiter = null;
        const batch = rec.inbox;
        rec.inbox = [];
        resolve(batch);
      }, waitMs);
      rec.waiter = { resolve, timer };
    });
  }

  startSweeper(): void {
    if (this.sweepTimer !== null) return;
    const timer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    (timer as unknown as NodeJS.Timeout).unref?.();
    this.sweepTimer = timer;
  }

  stopSweeper(): void {
    if (this.sweepTimer !== null) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
  }

  sweepExpired(): string[] {
    const cutoff = this.now() - USER_TTL_MS;
    const expired = [...this.users.values()].filter((rec) => rec.lastSeen < cutoff).map((rec) => rec.username);
    for (const username of expired) this.dropUser(username);
    return expired;
  }
}

export { RESERVED_NAMES };
