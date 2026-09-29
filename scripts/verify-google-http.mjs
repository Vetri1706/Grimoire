import assert from 'node:assert/strict';

// Denial/challenge tests only. A configured test client ID is not a Google
// authentication result, and this script never accepts or fabricates an ID token.
if (!process.argv.includes('--disposable') || !process.env.GRIMOIRE_API_URL) {
  throw new Error('Set GRIMOIRE_API_URL and pass --disposable for the isolated test API.');
}
const base = new URL(process.env.GRIMOIRE_API_URL);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) && !base.username && !base.password);
const enabled = process.argv.includes('--enabled');
let count = 0;
async function call(path, { method = 'GET', body, cookie, csrf = true, headers = {} } = {}) {
  const response = await fetch(new URL(`/api${path}`, base), { method, redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf && method !== 'GET' ? { 'X-Grimoire-CSRF': '1' } : {}), ...headers }, body: body && JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, data: text ? JSON.parse(text) : null };
}
function expect(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  if (code) assert.equal(response.data?.error?.code, code);
  return response;
}
function pass(label) { count++; console.log(`PASS ${label}`); }
function challengeCookie(response) {
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie ?? '', /^grimoire_google_challenge=[a-f0-9]{64}; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=300/);
  assert.ok(!cookie.includes('grimoire_session='));
  return cookie.split(';', 1)[0];
}
assert.match(expect(await call('/health'), 200).data.database.name, /_test$/);
const config = expect(await call('/session/google/config'), 200);
assert.equal(config.data.enabled, enabled);
assert.equal(config.headers.get('cache-control'), 'no-store');
if (!enabled) assert.equal(config.data.client_id, null);
pass('provider configuration is truthful and not cached');
for (const path of ['/session/google/challenge', '/session/google']) {
  expect(await call(path, { method: 'POST', body: { credential: 'invalid' }, csrf: false }), 403, 'SESSION_REQUEST_DENIED');
  expect(await call(path, { method: 'POST', body: { credential: 'invalid' }, headers: { Authorization: 'Bearer denied-test-agent' } }), 403, 'GOOGLE_SIGN_IN_IDENTITY_DENIED');
}
pass('Google entry requires the browser marker and denies bearer identities');
if (!enabled) {
  for (const path of ['/session/google/challenge', '/session/google']) {
    const response = expect(await call(path, { method: 'POST', body: { credential: 'invalid' } }), 503, 'GOOGLE_SIGN_IN_UNAVAILABLE');
    assert.equal(response.headers.get('set-cookie'), null);
  }
  pass('missing client configuration creates no challenge or session');
} else {
  const first = expect(await call('/session/google/challenge', { method: 'POST' }), 200);
  let cookie = challengeCookie(first);
  assert.equal(first.data.client_id, config.data.client_id);
  assert.match(first.data.nonce, /^[a-f0-9]{64}$/);
  assert.notEqual(cookie.split('=')[1], first.data.nonce);
  assert.ok(Date.parse(first.data.expires_at) > Date.now() && Date.parse(first.data.expires_at) <= Date.now() + 301000);
  expect(await call('/session', { cookie }), 401);
  pass('challenge uses an independent HttpOnly cookie and nonce without granting a session');
  for (const candidate of [undefined, `grimoire_google_challenge=${'0'.repeat(64)}`, `${cookie}; ${cookie}`]) {
    expect(await call('/session/google', { method: 'POST', cookie: candidate, body: { credential: 'invalid' } }), 401, 'GOOGLE_CHALLENGE_EXPIRED');
  }
  pass('missing, unknown and duplicate challenge cookies are denied');
  expect(await call('/session/google', { method: 'POST', cookie, body: { credential: 'invalid', organization_id: 'caller-selected' } }), 422, 'INVALID_REQUEST');
  const invalid = expect(await call('/session/google', { method: 'POST', cookie, body: { credential: 'invalid' } }), 401, 'GOOGLE_CREDENTIAL_INVALID');
  assert.equal(invalid.headers.get('set-cookie'), null);
  pass('unverified credentials and caller-selected identity fields cannot create a session');
  const replacement = expect(await call('/session/google/challenge', { method: 'POST', cookie }), 200);
  const nextCookie = challengeCookie(replacement);
  assert.notEqual(nextCookie, cookie);
  assert.notEqual(replacement.data.nonce, first.data.nonce);
  expect(await call('/session/google', { method: 'POST', cookie, body: { credential: 'invalid' } }), 401, 'GOOGLE_CHALLENGE_EXPIRED');
  cookie = nextCookie;
  pass('restarting the browser flow replaces the old challenge');
  const logout = expect(await call('/session', { method: 'DELETE', cookie }), 204);
  assert.match(logout.headers.get('set-cookie'), /grimoire_google_challenge=;.*Max-Age=0/);
  expect(await call('/session/google', { method: 'POST', cookie, body: { credential: 'invalid' } }), 401, 'GOOGLE_CHALLENGE_EXPIRED');
  pass('logout revokes the outstanding Google challenge');
}
const demo = expect(await call('/demo'), 200);
assert.equal(demo.data.read_only, true);
assert.equal(demo.data.scenarios.length, 3);
assert.equal(demo.headers.get('set-cookie'), null);
pass('judge demo remains accessible without Google or a session');
console.log(`PASS ${count} Google HTTP groups (${enabled ? 'configured synthetic client ID; no Google login performed' : 'Google disabled'}).`);
