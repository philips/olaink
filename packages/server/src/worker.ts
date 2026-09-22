/**
 * Cloudflare Worker entry (wrangler.jsonc `main`). Binds the shared fetch
 * handler to D1 (`db`) and R2 (`notes`); everything else is identical to the
 * standalone binary.
 */
import { AuthGravityWhoAmIVerifier, PRODUCTION_AUTHGRAVITY_WHOAMI_URL } from './authGravity.ts';
import type { D1DatabaseLike } from './d1Store.ts';
import { OlainkApp } from './handler.ts';
import { R2NotePayloads, type R2BucketLike } from './notePayloads.ts';

export interface Env {
  db: D1DatabaseLike;
  notes: R2BucketLike;
  OLAINK_AUTHGRAVITY_WHOAMI_URL?: string;
}

// wrangler.jsonc defines this as "unknown"; deploys override it with
// `--define process.env.OLAINK_BUILD_COMMIT:'"<sha>"'`. buildInfo.ts is not
// imported here because its git fallback needs child_process.
const baked: string | undefined = process.env.OLAINK_BUILD_COMMIT;
const commit = typeof baked === 'string' && /^[0-9a-f]{40}$/i.test(baked) ? baked.toLowerCase() : 'unknown';

// The env object is stable for the life of an isolate, so the app (and its
// prepared services) is built once per env rather than per request.
const apps = new WeakMap<Env, OlainkApp>();

function appFor(env: Env): OlainkApp {
  let app = apps.get(env);
  if (!app) {
    app = new OlainkApp({
      db: env.db,
      payloads: new R2NotePayloads(env.notes),
      authGravity: new AuthGravityWhoAmIVerifier(env.OLAINK_AUTHGRAVITY_WHOAMI_URL ?? PRODUCTION_AUTHGRAVITY_WHOAMI_URL),
      commit,
    });
    apps.set(env, app);
  }
  return app;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    // Cloudflare sets CF-Connecting-IP on every request and overwrites any
    // client-supplied value, so it is a trustworthy rate-limit key here.
    return appFor(env).fetch(request, request.headers.get('cf-connecting-ip') ?? 'unknown');
  },
};
