/** Direct SwapNote page routing for authenticated users. */

import {
  type Envelope,
  type PageSendPayload,
  isPageSendPayload,
  isPagesAckPayload,
  isPingPayload,
  makeEnvelope,
} from '@wrtn/protocol';
import { SWAPTEST, type Registry } from './registry.ts';

function errorEnvelope(code: string, message: string, replyTo?: string): Envelope {
  const env = makeEnvelope('server', 'error', { code, message });
  if (replyTo !== undefined) env.id = `err-${replyTo}`;
  return env;
}

export interface RouterDeps { registry: Registry; }

export class Router {
  constructor(private readonly deps: RouterDeps) {}

  /** Handle one envelope from an authenticated user; stamp its real sender. */
  handle(user: string, incoming: Envelope): void {
    const env: Envelope = { ...incoming, from: user };
    switch (env.type) {
      case 'ping':
        if (!isPingPayload(env.payload)) {
          this.deps.registry.deliver(user, errorEnvelope('bad_payload', 'invalid ping payload', env.id));
          return;
        }
        this.deps.registry.deliver(user, makeEnvelope('server', 'pong', { t: env.payload.t, serverNow: Date.now() }));
        return;
      case 'page.send':
        if (!isPageSendPayload(env.payload)) {
          this.deps.registry.deliver(user, errorEnvelope('bad_payload', 'invalid page.send payload', env.id));
          return;
        }
        this.routePageSend(user, env.payload);
        return;
      case 'pages.ack':
        if (isPagesAckPayload(env.payload)) this.deps.registry.ackPages(user, env.payload.pageIds);
        return;
      default:
        // Removed/unknown message types are ignored for forward compatibility.
        return;
    }
  }

  /** Store a page for an online or offline recipient and return its page id. */
  routePageSend(from: string, payload: PageSendPayload): Envelope {
    const env = makeEnvelope(from, 'page.send', payload);
    this.deps.registry.queuePage(payload.to, env);
    return env;
  }
}

export { SWAPTEST };
