/**
 * Protocol routing: applies envelope semantics for an authenticated user.
 * Transport-independent — the HTTP layer calls `handle`, tests call it
 * directly against a Registry.
 *
 * The server stamps `from` itself (auth identity), never trusting the
 * client-supplied value.
 */

import {
  type Envelope,
  type SessionStatePayload,
  type StrokePayload,
  type StrokesPayload,
  isJoinPayload,
  isPingPayload,
  isSessionAddPayload,
  isSessionLeavePayload,
  isStrokesPayload,
  makeEnvelope,
} from '@wrtn/protocol';
import { ECHO, type Registry, type Session } from './registry.ts';

export const ECHO_OFFSET_X = 384;
export const ECHO_OFFSET_Y = 384;
export const ECHO_PEN_COLOR = 0x9d;

function errorEnvelope(from: string, code: string, message: string, replyTo?: string): Envelope {
  const env = makeEnvelope('server', 'error', { code, message });
  if (replyTo !== undefined) env.id = `err-${replyTo}`;
  void from;
  return env;
}

export interface RouterDeps {
  registry: Registry;
}

export class Router {
  constructor(private readonly deps: RouterDeps) {}

  /** Broadcast session.state to every real member of a session. */
  broadcastSessionState(session: Session): void {
    const payload: SessionStatePayload = {
      owner: session.owner,
      members: [...session.members].map((m) => ({
        username: m,
        virtual: m === ECHO || this.deps.registry.getUser(m) === null,
      })),
    };
    const env = makeEnvelope('server', 'session.state', payload);
    for (const member of session.members) {
      if (this.deps.registry.getUser(member) !== null) {
        this.deps.registry.deliver(member, env);
      }
    }
  }

  /** Handle one envelope from an authenticated user. */
  handle(user: string, incoming: Envelope): void {
    const env: Envelope = { ...incoming, from: user };

    switch (env.type) {
      case 'ping': {
        if (!isPingPayload(env.payload)) {
          this.deps.registry.deliver(user, errorEnvelope(user, 'bad_payload', 'invalid ping payload', env.id));
          return;
        }
        this.deps.registry.deliver(user, makeEnvelope('server', 'pong', { t: env.payload.t, serverNow: Date.now() }));
        return;
      }

      case 'join': {
        if (!isJoinPayload(env.payload)) {
          this.deps.registry.deliver(user, errorEnvelope(user, 'bad_payload', 'invalid join payload', env.id));
          return;
        }
        const owner = env.payload.owner;
        if (owner === user) return; // already in own session
        if (owner !== ECHO && this.deps.registry.getUser(owner) === null) {
          this.deps.registry.deliver(user, errorEnvelope(user, 'user_not_found', `no such user: ${owner}`, env.id));
          return;
        }
        this.deps.registry.joinSession(user, owner);
        return;
      }

      case 'session.add': {
        if (!isSessionAddPayload(env.payload)) {
          this.deps.registry.deliver(user, errorEnvelope(user, 'bad_payload', 'invalid session.add payload', env.id));
          return;
        }
        const target = env.payload.target;
        const session = this.deps.registry.sessionOf(user);
        if (session === null) {
          this.deps.registry.deliver(user, errorEnvelope(user, 'no_session', 'not in a session', env.id));
          return;
        }
        if (target !== ECHO && this.deps.registry.getUser(target) === null) {
          this.deps.registry.deliver(user, errorEnvelope(user, 'user_not_found', `no such user: ${target}`, env.id));
          return;
        }
        this.deps.registry.joinSession(target, session.owner);
        return;
      }

      case 'session.leave': {
        if (!isSessionLeavePayload(env.payload)) return;
        this.deps.registry.leaveSession(user, { silent: false });
        return;
      }

      case 'strokes': {
        if (!isStrokesPayload(env.payload)) {
          this.deps.registry.deliver(user, errorEnvelope(user, 'bad_payload', 'invalid strokes payload', env.id));
          return;
        }
        const session = this.deps.registry.sessionOf(user);
        if (session === null) return;
        const recipients = [...session.members].filter((m) => m !== user && m !== ECHO);
        for (const r of recipients) this.deps.registry.deliver(r, env);
        if (session.members.has(ECHO)) this.runEcho(session, user, env.payload);
        return;
      }

      default:
        // Unknown types are ignored (forward compat).
        return;
    }
  }

  /**
   * Echo behavior: reply to the sender with the same strokes translated by
   * a fixed offset and recolored, so the round-trip is visible on the note.
   */
  private runEcho(session: Session, sender: string, payload: StrokesPayload): void {
    const echoed: StrokePayload[] = payload.strokes.map((s) => ({
      ...s,
      sid: `${s.sid}-echo`,
      penColor: ECHO_PEN_COLOR,
      pts: s.pts.map((n, i) => (i % 2 === 0 ? n + ECHO_OFFSET_X : n + ECHO_OFFSET_Y)),
      ...(s.prs !== undefined ? { prs: s.prs } : {}),
    }));
    const reply = makeEnvelope(ECHO, 'strokes', { strokes: echoed } satisfies StrokesPayload);
    // Everyone real except the echo itself — including the original sender.
    for (const member of session.members) {
      if (member === ECHO) continue;
      if (this.deps.registry.getUser(member) !== null) {
        this.deps.registry.deliver(member, reply);
      }
    }
    void sender;
  }
}
