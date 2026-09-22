/**
 * Structural types for the `cloudflare:test` / `cloudflare:workers` modules
 * used by the Workers test project, so the root tsc run (Node + DOM libs)
 * typechecks those files without pulling in @cloudflare/workers-types.
 */
declare module 'cloudflare:test' {
  import type { D1DatabaseLike } from './d1Store.ts';
  import type { R2BucketLike } from './notePayloads.ts';

  interface R2ListResult {
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }

  export const env: {
    db: D1DatabaseLike;
    notes: R2BucketLike & { list(options?: { cursor?: string }): Promise<R2ListResult> };
    TEST_MIGRATIONS: { name: string; queries: string[] }[];
  };

  export function applyD1Migrations(
    db: D1DatabaseLike,
    migrations: { name: string; queries: string[] }[],
  ): Promise<void>;
}

declare module 'cloudflare:workers' {
  export const exports: { default: { fetch(request: Request): Promise<Response> } };
}
