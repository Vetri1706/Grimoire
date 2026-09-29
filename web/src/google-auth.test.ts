import assert from 'node:assert/strict';
import test from 'node:test';
import { completeGoogleSignIn, googleSignInChallenge, googleSignInConfig } from './google-auth.ts';

test('Google availability only reads same-origin public configuration without bearer credentials', async t => {
  t.mock.method(globalThis, 'fetch', async (url: unknown, options: RequestInit) => {
    assert.equal(url, '/api/session/google/config');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(new Headers(options.headers).get('Authorization'), null);
    assert.equal(options.body, undefined);
    return new Response(JSON.stringify({ enabled: false }));
  });
  assert.deepEqual(await googleSignInConfig(), { enabled: false });
});

test('a Google challenge is a CSRF-marked same-origin POST and supports cancellation', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url: unknown, options: RequestInit) => {
    assert.equal(url, '/api/session/google/challenge');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.signal, controller.signal);
    assert.equal(new Headers(options.headers).get('X-Grimoire-CSRF'), '1');
    assert.equal(new Headers(options.headers).get('Authorization'), null);
    return new Response(JSON.stringify({ client_id: 'synthetic-only', nonce: 'synthetic-nonce', expires_at: '2030-01-01T00:00:00Z' }));
  });
  assert.equal((await googleSignInChallenge(controller.signal)).nonce, 'synthetic-nonce');
});

test('Google completion submits only its credential through the existing CSRF session boundary', async t => {
  t.mock.method(globalThis, 'fetch', async (url: unknown, options: RequestInit) => {
    assert.equal(url, '/api/session/google');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(new Headers(options.headers).get('X-Grimoire-CSRF'), '1');
    assert.equal(new Headers(options.headers).get('Authorization'), null);
    assert.deepEqual(JSON.parse(options.body as string), { credential: 'synthetic-token-not-a-real-google-token' });
    return new Response(JSON.stringify({ handler: { identity_id: 'synthetic-handler' }, organizations: [], active_organization: null }));
  });
  assert.equal((await completeGoogleSignIn('synthetic-token-not-a-real-google-token')).handler.identity_id, 'synthetic-handler');
});
