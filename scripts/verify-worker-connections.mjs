import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

// Synthetic HTTP fixtures only. No installation-owner setup, provider login,
// Codex execution, database credentials, or persistent local credential files.
if (!process.argv.includes('--disposable') || !process.env.GRIMOIRE_API_URL) {
  throw new Error('Set GRIMOIRE_API_URL and pass --disposable for an isolated *_test API.');
}
const base = new URL(process.env.GRIMOIRE_API_URL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || !['http:', 'https:'].includes(base.protocol) || base.username || base.password
    || base.pathname !== '/' || base.search || base.hash) {
  throw new Error('GRIMOIRE_API_URL must be a loopback HTTP(S) origin without credentials.');
}
const runId = randomUUID();
const expectedDatabase = process.env.GRIMOIRE_TEST_DATABASE ?? 'grimoire_codex_v1_test';
const results = [];
const cookies = new Set();
const issued = [];
let first;
let second;
let pairing;
let connection;
let setupBefore;
let database;

async function request(path, { method = 'GET', body, cookie, org, csrf = true, headers = {} } = {}) {
  const response = await fetch(new URL(path, base), {
    method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}), ...(org ? { 'X-Grimoire-Organization': org } : {}),
      ...(csrf && !['GET', 'HEAD'].includes(method) ? { 'X-Grimoire-CSRF': '1' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: response.status, headers: response.headers, data };
}
function status(response, expected, code) {
  assert.equal(response.status, expected,
    `Expected HTTP ${expected}; got ${response.status} (${response.data?.error?.code ?? 'no API error code'})`);
  if (code) assert.equal(response.data?.error?.code, code);
  return response;
}
function noSecrets(value) {
  const serialized = JSON.stringify(value);
  assert.ok(!/"(?:device_secret|credential|credential_sha256|device_sha256)"\s*:/.test(serialized), 'Browser response contains a credential field');
  if (pairing?.device_secret) assert.ok(!serialized.includes(pairing.device_secret), 'Browser response contains pairing proof');
  for (const item of issued) assert.ok(!serialized.includes(item.credential), 'Browser response contains worker credential');
}
async function check(name, run) {
  await run();
  results.push({ name, passed: true });
  console.log(`PASS ${name}`);
}
async function signup(suffix) {
  const result = status(await request('/api/session/signup', { method: 'POST', body: {
    login_name: `pair_${runId}_${suffix}`, display_name: `Synthetic worker pairing ${suffix}`,
    passphrase: `synthetic-${randomUUID()}`,
  } }), 201);
  const cookieHeader = result.headers.get('set-cookie');
  assert.ok(/^grimoire_session=[0-9a-f]{64};/.test(cookieHeader ?? ''), 'Signup did not issue an opaque session cookie');
  assert.ok(cookieHeader.includes('HttpOnly; SameSite=Strict'), 'Session cookie policy is not protected');
  const cookie = cookieHeader.split(';', 1)[0];
  cookies.add(cookie);
  assert.equal(result.data.handler.installation_owner, false);
  assert.equal(result.data.organizations.length, 0);
  const organization = status(await request('/api/organizations', { method: 'POST', cookie,
    body: { name: `Synthetic worker pairing ${suffix} ${runId}` }, headers: { 'Idempotency-Key': randomUUID() } }), 201);
  return { cookie, org: organization.data.active_organization.org_id };
}
const reviewPath = () => `/api/worker-connections/pairings/${pairing.user_code}`;
const approveBody = org => ({ organization_id: org, consent: true, policy_version: 'codex-synthetic-v1' });
const revokePath = id => `/api/worker-connections/${id}/revoke`;
const asWorker = () => ({ headers: { Authorization: `Bearer ${connection.credential}` } });

try {
  await check('fixture writes are restricted to a disposable test database', async () => {
    database = status(await request('/api/health'), 200).data?.database?.name;
    assert.ok(typeof database === 'string' && database.endsWith('_test'), 'Refusing worker fixtures outside a *_test database');
    assert.equal(database, expectedDatabase, 'The API is attached to a different test database than requested');
    setupBefore = status(await request('/api/setup/status'), 200).data.setup_required;
  });
  await check('normal signup creates isolated organizations without claiming installation ownership', async () => {
    first = await signup('one');
    second = await signup('two');
    assert.notEqual(first.org, second.org);
    assert.equal(status(await request('/api/setup/status'), 200).data.setup_required, setupBefore);
  });
  await check('pairing has bounded proofs and cannot configure an arbitrary adapter', async () => {
    status(await request('/api/worker-connections/pairings', { method: 'POST', body: { device_name: 'Synthetic device', adapter: 'shell' } }), 422);
    const created = status(await request('/api/worker-connections/pairings', { method: 'POST',
      body: { device_name: `Synthetic HTTP worker ${runId}` } }), 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    pairing = created.data;
    assert.ok(/^[a-f0-9]{64}$/.test(pairing.device_secret ?? ''), 'Expected a 256-bit device proof');
    assert.ok(/^[A-F0-9]{16}$/.test(pairing.user_code ?? ''), 'Expected the bounded human code');
    assert.equal(pairing.adapter, 'codex_cli');
    assert.equal(pairing.policy_version, 'codex-synthetic-v1');
    assert.equal(pairing.content_class, 'synthetic_only');
    const pending = status(await request('/api/worker-connections/pairings/poll', { method: 'POST', body: { device_secret: pairing.device_secret } }), 200);
    assert.equal(pending.data.status, 'pending');
    noSecrets(pending.data);
    const limited = status(await request('/api/worker-connections/pairings/poll', { method: 'POST', body: { device_secret: pairing.device_secret } }), 429, 'WORKER_PAIRING_RATE_LIMIT');
    assert.equal(limited.headers.get('retry-after'), '3');
    status(await request('/api/worker-connections/pairings/poll', { method: 'POST', body: { device_secret: 'f'.repeat(64) } }), 404, 'WORKER_CONNECTION_NOT_FOUND');
  });
  await check('review requires a human session and exact mounted organization without exposing proofs', async () => {
    status(await request(reviewPath()), 401);
    status(await request(reviewPath(), { cookie: first.cookie }), 409, 'ACTIVE_ORGANIZATION_CHANGED');
    status(await request(reviewPath(), { cookie: first.cookie, org: second.org }), 409, 'ACTIVE_ORGANIZATION_CHANGED');
    status(await request(reviewPath(), { ...first, headers: { Authorization: 'Bearer synthetic-bearer' } }), 401);
    const reviewed = status(await request(reviewPath(), first), 200);
    noSecrets(reviewed.data);
    assert.equal(reviewed.data.organization_id, first.org);
    assert.equal(reviewed.data.status, 'pending');
    assert.equal(reviewed.data.content_class, 'synthetic_only');
    assert.ok(reviewed.data.consent_text.includes('does not grant'), 'Review must explain the human authority boundary');
  });
  await check('approval requires CSRF, current policy consent and the displayed organization', async () => {
    const path = `${reviewPath()}/approve`;
    status(await request(path, { ...first, method: 'POST', csrf: false, body: approveBody(first.org) }), 403, 'SESSION_REQUEST_DENIED');
    status(await request(path, { ...first, method: 'POST', body: approveBody(first.org), headers: { Authorization: 'Bearer synthetic-bearer' } }), 401);
    status(await request(path, { ...first, org: second.org, method: 'POST', body: approveBody(second.org) }), 409, 'ACTIVE_ORGANIZATION_CHANGED');
    status(await request(path, { ...first, method: 'POST', body: { ...approveBody(first.org), consent: false } }), 422, 'WORKER_CONSENT_REQUIRED');
    status(await request(path, { ...first, method: 'POST', body: { ...approveBody(first.org), policy_version: 'unreviewed' } }), 422, 'WORKER_CONSENT_REQUIRED');
    for (let repeat = 0; repeat < 2; repeat++) {
      const approved = status(await request(path, { ...first, method: 'POST', body: approveBody(first.org) }), 200);
      assert.equal(approved.data.status, 'approved');
      noSecrets(approved.data);
    }
  });
  await check('another organization cannot view or approve the bound pairing', async () => {
    status(await request(reviewPath(), second), 404, 'WORKER_CONNECTION_NOT_FOUND');
    status(await request(`${reviewPath()}/approve`, { ...second, method: 'POST', body: approveBody(second.org) }), 404, 'WORKER_CONNECTION_NOT_FOUND');
    assert.equal(status(await request('/api/worker-connections', second), 200).data.connections.length, 0);
  });
  await check('concurrent polls issue exactly one credential and consumed retries return no secret', async () => {
    await wait(3200);
    const responses = await Promise.all([0, 1].map(() => request('/api/worker-connections/pairings/poll', {
      method: 'POST', body: { device_secret: pairing.device_secret },
    })));
    // Capture every unexpectedly issued credential too, so finally can revoke it.
    for (const response of responses) {
      status(response, 200);
      if (response.data?.status === 'approved') issued.push(response.data);
    }
    assert.equal(issued.length, 1, 'Concurrent polls must issue exactly one worker credential');
    connection = issued[0];
    assert.ok(/^[a-f0-9]{64}$/.test(connection.credential ?? ''), 'Issued worker credential is malformed');
    assert.equal(connection.organization_id, first.org);
    assert.equal(responses.filter(item => item.data.status === 'consumed').length, 1);
    const replay = status(await request('/api/worker-connections/pairings/poll', { method: 'POST', body: { device_secret: pairing.device_secret } }), 200);
    assert.equal(replay.data.status, 'consumed');
    noSecrets(replay.data);
    assert.equal(responses[0].headers.get('cache-control'), 'no-store');
  });
  await check('paired worker is proposal-only and presence reflects its real authenticated heartbeat', async () => {
    const actor = status(await request('/api/me', asWorker()), 200).data;
    assert.equal(actor.org_id, first.org);
    assert.equal(actor.is_agent, true);
    assert.equal(actor.can_propose_scope, true);
    for (const flag of ['can_write', 'can_manage_workspace', 'can_prepare_workspace', 'can_confirm_scope']) assert.equal(actor[flag], false, `Unexpected worker authority: ${flag}`);
    status(await request('/api/worker-connections', asWorker()), 401);
    status(await request('/api/approvals', { ...asWorker(), method: 'POST', body: {} }), 403);
    let listed = status(await request('/api/worker-connections', first), 200).data;
    noSecrets(listed);
    assert.equal(listed.connections.length, 1);
    assert.equal(listed.connections[0].status, 'disconnected');
    const next = status(await request('/api/agent/tasks/next', { headers: { ...asWorker().headers, 'X-Grimoire-Worker-Protocol': '2' } }), 200);
    assert.equal(next.data.task, null, 'Fresh synthetic organization should contain no work');
    listed = status(await request('/api/worker-connections', first), 200).data;
    noSecrets(listed);
    assert.equal(listed.connections[0].status, 'connected');
    assert.ok(listed.connections[0].last_seen, 'Authenticated heartbeat was not persisted');
  });
  await check('session organization switches invalidate stale connection views and approvals', async () => {
    const newOrganization = status(await request('/api/organizations', { method: 'POST', cookie: first.cookie,
      body: { name: `Synthetic second mounted workspace ${runId}` }, headers: { 'Idempotency-Key': randomUUID() } }), 201).data.active_organization.org_id;
    try {
      status(await request(reviewPath(), first), 409, 'ACTIVE_ORGANIZATION_CHANGED');
      status(await request(`${reviewPath()}/approve`, { ...first, method: 'POST', body: approveBody(first.org) }), 409, 'ACTIVE_ORGANIZATION_CHANGED');
      status(await request(revokePath(connection.connection_id), { ...first, method: 'POST', body: { organization_id: first.org } }), 409, 'ACTIVE_ORGANIZATION_CHANGED');
      status(await request('/api/worker-connections', first), 409, 'ACTIVE_ORGANIZATION_CHANGED');
      const newView = status(await request('/api/worker-connections', { cookie: first.cookie, org: newOrganization }), 200);
      assert.equal(newView.data.connections.length, 0);
    } finally {
      status(await request('/api/session/active-organization', { method: 'POST', cookie: first.cookie, body: { organization_id: first.org } }), 200);
    }
  });
  await check('revocation rejects foreign/agent/CSRF requests and immediately disables credentials and presence', async () => {
    const path = revokePath(connection.connection_id);
    status(await request(path, { ...second, method: 'POST', body: { organization_id: second.org } }), 404, 'WORKER_CONNECTION_NOT_FOUND');
    status(await request(path, { ...first, method: 'POST', csrf: false, body: { organization_id: first.org } }), 403, 'SESSION_REQUEST_DENIED');
    status(await request(path, { ...asWorker(), method: 'POST', body: { organization_id: first.org } }), 401);
    for (let repeat = 0; repeat < 2; repeat++) {
      const revoked = status(await request(path, { ...first, method: 'POST', body: { organization_id: first.org } }), 200);
      assert.equal(revoked.data.status, 'revoked');
      noSecrets(revoked.data);
    }
    status(await request('/api/me', asWorker()), 401);
    status(await request('/api/agent/tasks/next', { headers: { ...asWorker().headers, 'X-Grimoire-Worker-Protocol': '2' } }), 401);
    const listed = status(await request('/api/worker-connections', first), 200).data;
    noSecrets(listed);
    assert.equal(listed.connections.length, 1);
    assert.equal(listed.connections[0].status, 'revoked');
    assert.equal(listed.connections[0].last_seen, null);
  });
  await check('verification never changes installation ownership or executes a model', async () => {
    assert.equal(status(await request('/api/setup/status'), 200).data.setup_required, setupBefore);
  });
} catch (error) {
  // Assertions intentionally compare only safe status/metadata, never raw proofs.
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  if (first) {
    for (const item of issued) {
      try {
        status(await request(revokePath(item.connection_id), { ...first, method: 'POST', body: { organization_id: first.org } }), 200);
      } catch (error) { console.error(`FAIL worker fixture revocation: ${error.message}`); process.exitCode = 1; }
    }
  }
  for (const cookie of cookies) {
    try { status(await request('/api/session', { method: 'DELETE', cookie }), 204); }
    catch (error) { console.error(`FAIL fixture session cleanup: ${error.message}`); process.exitCode = 1; }
  }
  console.log(JSON.stringify({ run_id: runId, api: base.origin, database, passed: results.length,
    failed: process.exitCode ? 1 : 0, model_invoked: false, results }, null, 2));
}
