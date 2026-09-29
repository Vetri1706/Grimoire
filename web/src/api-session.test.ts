import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, SESSION_AUTH, organizationSession, request } from './api.ts';

test('session workspace mutations carry the mounted organization, cookie and CSRF binding', async t => {
  let sent: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    sent = options;
    return new Response(JSON.stringify({ id: 'scion' }), { status: 201 });
  });
  await request(organizationSession('organization-a'), '/scions', { method: 'POST', body: '{}', headers: { 'Idempotency-Key': 'retry-key' } });
  const headers = new Headers(sent?.headers);
  assert.equal(sent?.credentials, 'same-origin');
  assert.equal(headers.get('X-Grimoire-Organization'), 'organization-a');
  assert.equal(headers.get('X-Grimoire-CSRF'), '1');
  assert.equal(headers.get('Authorization'), null);
  assert.equal(headers.get('Idempotency-Key'), 'retry-key');
});

test('session setup has no workspace binding and bearer callers retain their identity', async t => {
  const sent: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    sent.push(options); return new Response('{}');
  });
  await request(SESSION_AUTH, '/session/login', { method: 'POST', body: '{}' });
  await request('development-token', '/scions');
  assert.equal(new Headers(sent[0].headers).get('X-Grimoire-Organization'), null);
  assert.equal(new Headers(sent[0].headers).get('Authorization'), null);
  assert.equal(new Headers(sent[1].headers).get('Authorization'), 'Bearer development-token');
  assert.equal(new Headers(sent[1].headers).get('X-Grimoire-CSRF'), null);
});

test('logout success accepts an empty 204 and failed revocation stays a failure', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  assert.equal(await request(SESSION_AUTH, '/session', { method: 'DELETE' }), undefined);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Retry logout.' } }), { status: 503 }));
  await assert.rejects(request(SESSION_AUTH, '/session', { method: 'DELETE' }), error => error instanceof ApiError && error.status === 503);
});

test('a stale organization request reports the conflict without retrying it in another organization', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++; return new Response(JSON.stringify({ error: { code: 'ACTIVE_ORGANIZATION_CHANGED', message: 'Recheck session.' } }), { status: 409 });
  });
  await assert.rejects(request(organizationSession('organization-a'), '/scions', { method: 'POST', body: '{}' }), error => error instanceof ApiError && error.code === 'ACTIVE_ORGANIZATION_CHANGED');
  assert.equal(calls, 1);
});
