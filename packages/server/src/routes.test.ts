import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './testApp.ts';

let harness: TestApp;

beforeAll(async () => {
  harness = await createTestApp({ commit: 'c'.repeat(40) });
});

afterAll(() => harness.close());

describe('HTTP API', () => {
  it('healthz responds ok and commit reports the build source', async () => {
    const res = await harness.fetch('/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    const commit = await harness.fetch('/commit');
    expect(commit.status).toBe(200);
    expect(commit.headers.get('cache-control')).toBe('no-store');
    expect(await commit.text()).toBe(`${'c'.repeat(40)}\n`);
  });

  it('serves the passkey-capable primary-device setup page at the root', async () => {
    const res = await harness.fetch('/');
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
    expect(page).not.toContain('Choose your Ola Ink username');
    expect(page).not.toContain('username-section');
    expect(page).toContain('Create browser inbox key');
    expect(page).toContain('Browser inbox created for');
    expect(page).toContain('Sign in with passkey');
    expect(page).toContain('Create account and passkey');
    expect(page).toContain('id="auth-or"');
    expect(page).not.toContain('Continue with passkey');
    expect(page).toContain('Claim username');
    expect(page).toContain('label shown for this Ola Ink passkey');
    expect(page).toContain('Add Supernote companion');
    expect(page).toContain('workspace-navigation');
    expect(page).toContain('workspace-menu');
    expect(page).toContain('workspace-nav');
    expect(page).toContain('Encrypt and send note');
    expect(page).toContain('Close note');
    expect(page).toContain('main { max-width: none; margin: 5vh 0; padding: 0 1rem 3rem; }');
    expect(page).toContain('#inbox-section, #inbox-view, #detail { margin: 0; padding: 0; border: 0; background: transparent; min-width: 0; }');
    expect(page).toContain('#inbox-section { margin-left: -1rem; margin-right: -1rem; }');
    expect(page).toContain('aspect-ratio: 3 / 4');
    expect(page).not.toContain('position: fixed; z-index: 2; inset: 0');
    expect(page).toContain('<supernote-viewer id="viewer" bare></supernote-viewer>');
    expect(page).not.toContain('single-page');
    expect(page).not.toContain('Previous page');
    expect(page).toContain('Log out');
    expect(page).toContain("id=\"logout\"");
    expect(page).toContain('/v1/logout');
    expect(page).toContain('receiver:');
    expect(page).not.toContain('DEVICE_KEY');
    expect(page).toContain('class="olaink-header"');
    expect(page).toContain('id="workspace-menu"');
    expect(page).toContain('main:has(#detail:not([hidden])) { display: flex; flex-direction: column; height: 100dvh;');
    expect(page).toContain('main:has(#detail:not([hidden])) #viewer { flex: 0 1 auto; align-self: center; min-height: 0; width: auto; max-width: 100%; height: auto; }');
    expect(page).not.toContain('id="status"');
    expect(page).not.toContain('src="/olaink-logo.svg"');
    expect(page).toContain('<div class="olaink-leading-actions"><button id="workspace-menu"');
    expect(page).toContain('</div><a class="olaink-brand"');
    expect(page).toContain('/v1/pairings');
    expect(page).toContain('note integrity check failed');
    expect(page).not.toContain('auth-endpoint');
    expect(page).not.toContain('__CSP_NONCE__');
  });

  it('permits CORS only for Android pairing and device-scoped delivery endpoints', async () => {
    const response = await harness.fetch('/v1/pairings/claim', {
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

    for (const path of ['/v1/companion/directory', '/v1/companion/notes', '/v1/companion/poll', '/v1/companion/ack', '/v1/companion/logout']) {
      const response = await harness.fetch(path, {
        method: 'OPTIONS', headers: { Origin: 'https://appassets.androidplatform.net' },
      });
      expect(response.status).toBe(204);
    }

    const other = await harness.fetch('/v1/pairings/claim', {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.invalid' },
    });
    expect(other.status).toBe(404);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('self-hosts the pinned viewer and does not retain retired routes', async () => {
    const logo = await harness.fetch('/olaink-logo.svg');
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toContain('image/svg+xml');
    expect(await logo.text()).toContain('<svg');
    const viewer = await harness.fetch('/supernote-viewer.js');
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
      const response = await harness.fetch(path, {
        method: isApiRoute ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        ...(isApiRoute ? { body: '{}' } : {}),
      });
      expect(response.status).toBe(404);
    }
  });
});
