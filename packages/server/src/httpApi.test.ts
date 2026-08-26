import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OlainkServer } from './httpApi.ts';
import { buildCommit } from './buildInfo.ts';

let server: OlainkServer;
let baseUrl: string;

beforeAll(async () => {
  server = new OlainkServer();
  await server.listen({ port: 0, host: '127.0.0.1' });
  const addr = server.address()!;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await server.close();
});

describe('HTTP API', () => {
  it('healthz responds ok and commit reports the build source', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    const commit = await fetch(`${baseUrl}/commit`);
    expect(commit.status).toBe(200);
    expect(commit.headers.get('cache-control')).toBe('no-store');
    expect(await commit.text()).toBe(`${buildCommit}\n`);
    expect(buildCommit).toMatch(/^(?:[0-9a-f]{40}|unknown)$/);
  });

  it('serves the passkey-capable primary-device setup page at the root', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self' 'nonce-");
    expect(res.headers.get('content-security-policy')).toContain("font-src 'self' data:");
    expect(res.headers.get('content-security-policy')).toContain("worker-src 'self' blob:");
    expect(res.headers.get('content-security-policy')).toContain("img-src 'self' data:");
    const page = await res.text();
    expect(page).toContain('Powered by AuthGravity');
    expect(page).toContain('https://authgravity.app.olaink.com');
    expect(page).toContain('This username is permanent. You cannot change it');
    expect(page).toContain('Create browser inbox key');
    expect(page).toContain('Add Supernote companion');
    expect(page).toContain('Encrypt and send note');
    expect(page).toContain("await encryptForDirectory(note, file.name, recipient, recipientInfo.directory)");
    expect(page).toContain('class="olaink-header"');
    expect(page).toContain('src="/olaink-logo.svg"');
    expect(page).toContain('/v1/pairings');
    expect(page).toContain('note integrity check failed');
    expect(page).not.toContain('auth-endpoint');
    expect(page).not.toContain('__CSP_NONCE__');
  });

  it('permits CORS only for Android pairing and device-scoped delivery endpoints', async () => {
    const response = await fetch(`${baseUrl}/v1/pairings/claim`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://appassets.androidplatform.net',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://appassets.androidplatform.net');
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(response.headers.get('access-control-allow-headers')).toContain('x-olaink-device-session');

    for (const path of ['/v1/companion/directory', '/v1/companion/notes', '/v1/companion/poll', '/v1/companion/ack']) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'OPTIONS', headers: { Origin: 'https://appassets.androidplatform.net' },
      });
      expect(response.status).toBe(204);
    }

    const other = await fetch(`${baseUrl}/v1/pairings/claim`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.invalid' },
    });
    expect(other.status).toBe(404);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('self-hosts the pinned viewer and does not retain retired routes', async () => {
    const logo = await fetch(`${baseUrl}/olaink-logo.svg`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toContain('image/svg+xml');
    expect(await logo.text()).toContain('<svg');
    const viewer = await fetch(`${baseUrl}/supernote-viewer.js`);
    expect(viewer.status).toBe(200);
    expect(viewer.headers.get('content-type')).toContain('text/javascript');
    for (const path of [
      '/prototype/onboard',
      '/v1/peers',
      '/v1/hello',
      '/v1/send',
      `/v1/test/${['swap', 'test'].join('')}/page`,
    ]) {
      const isApiRoute = path.startsWith('/v1/');
      const response = await fetch(`${baseUrl}${path}`, {
        method: isApiRoute ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        ...(isApiRoute ? { body: '{}' } : {}),
      });
      expect(response.status).toBe(404);
    }
  });
});
