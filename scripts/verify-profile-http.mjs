import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.GRIMOIRE_PROFILE_TEST_URL || 'http://127.0.0.1:8082';
// Deliberately limited to the retained isolated test API; never use a person's
// account/session or the primary development API for mutation tests.
assert.equal(base, 'http://127.0.0.1:8082', 'Profile mutation checks require the isolated API on 8082.');
const results = [];
async function call(path, { cookie, csrf = true, ...options } = {}) {
  return fetch(`${base}/api${path}`, {
    ...options,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-Grimoire-CSRF': '1' } : {}), 'Content-Type': 'application/json', ...options.headers },
  });
}
async function register() {
  const response = await call('/session/signup', { method: 'POST', body: JSON.stringify({ login_name: `profile_${randomUUID().replaceAll('-', '')}`, display_name: 'Synthetic profile Handler', passphrase: `synthetic-${randomUUID()}` }) });
  assert.equal(response.status, 201);
  return { cookie: response.headers.get('set-cookie').split(';')[0], state: await response.json() };
}
const first = await register();
const second = await register();
try {
  const created = await call('/organizations', { cookie: first.cookie, method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ name: 'Synthetic profile settings verification' }) });
  assert.equal(created.status, 201);
  const before = await created.json();
  const change = { method: 'POST', body: JSON.stringify({ display_name: '  Synthetic renamed Handler  ' }) };
  assert.equal((await call('/session/profile', change)).status, 401);
  assert.equal((await call('/session/profile', { ...change, cookie: first.cookie, csrf: false })).status, 403);
  assert.equal((await call('/session/profile', { ...change, cookie: first.cookie, headers: { Authorization: 'Bearer synthetic-agent-cannot-edit-handler' } })).status, 401);
  for (const body of [{ display_name: ' ' }, { display_name: 'x'.repeat(121) }, { display_name: 'Other', identity_id: second.state.handler.identity_id }, { display_name: 'Other', can_write: true }]) {
    assert.equal((await call('/session/profile', { cookie: first.cookie, method: 'POST', body: JSON.stringify(body) })).status, 422);
  }
  results.push('Authentication, CSRF, bearer exclusion, name bounds, and unknown-field rejection');
  const update = await call('/session/profile', { ...change, cookie: first.cookie });
  assert.equal(update.status, 200);
  const after = await update.json();
  assert.equal(after.handler.display_name, 'Synthetic renamed Handler');
  assert.equal(after.active_organization.display_name, 'Synthetic renamed Handler');
  assert.deepEqual({ ...after.handler, display_name: before.handler.display_name }, before.handler);
  assert.deepEqual({ ...after.active_organization, display_name: before.active_organization.display_name }, before.active_organization);
  assert.deepEqual(after.organizations, before.organizations);
  const persisted = await (await call('/session', { cookie: first.cookie })).json();
  assert.equal(persisted.handler.display_name, after.handler.display_name);
  const unchanged = await (await call('/session', { cookie: second.cookie })).json();
  assert.deepEqual(unchanged, second.state);
  results.push('Profile persisted across reads; identity, memberships, permissions, and unrelated account preserved');
  assert.equal((await call('/session', { cookie: first.cookie, method: 'DELETE' })).status, 204);
  assert.equal((await call('/session/profile', { ...change, cookie: first.cookie })).status, 401);
  results.push('Revoked session cannot update profile');
  console.log(JSON.stringify({ status: 'PASS', base, checks: results }, null, 2));
} finally {
  await call('/session', { cookie: first.cookie, method: 'DELETE' });
  await call('/session', { cookie: second.cookie, method: 'DELETE' });
}
