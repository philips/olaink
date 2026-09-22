import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createTestApp } from './testApp.ts';

// Runs only in the `workers` project: requests go through worker.ts itself
// (the deployed entry), against the Miniflare D1/R2 bindings.
describe('Worker entry', () => {
  it('serves the handler with the wrangler define and bindings', async () => {
    await createTestApp(); // empty bindings
    expect(await (await exports.default.fetch(new Request('https://app.olaink.com/healthz'))).text()).toBe('ok');
    expect(await (await exports.default.fetch(new Request('https://app.olaink.com/commit'))).text()).toBe('unknown\n');
  });

  it('keys the pairing-claim rate limit on CF-Connecting-IP', async () => {
    await createTestApp();
    const claim = (ip: string) => exports.default.fetch(new Request('https://app.olaink.com/v1/pairings/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ code: '00000000', device: {} }),
    }));
    for (let attempt = 0; attempt < 10; attempt += 1) expect((await claim('198.51.100.7')).status).toBe(400);
    expect((await claim('198.51.100.7')).status).toBe(429);
    expect((await claim('198.51.100.8')).status).toBe(400);
  });
});
