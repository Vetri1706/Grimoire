import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Creates only synthetic users and organizations in an explicitly disposable
// *_test database. Dispatches then cancels synthetic work in a fresh organization
// with no enrolled worker; never claims installation ownership or calls a provider.
if (!process.argv.includes('--disposable') || !process.env.GRIMOIRE_API_URL) {
  throw new Error('Set GRIMOIRE_API_URL and pass --disposable for an isolated test API.');
}
const base = new URL(process.env.GRIMOIRE_API_URL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || !['http:', 'https:'].includes(base.protocol) || base.username || base.password
    || base.pathname !== '/' || base.search || base.hash) {
  throw new Error('GRIMOIRE_API_URL must be a loopback HTTP(S) origin without credentials.');
}
const runId = randomUUID();
const sessions = new Set();
let passed = 0;
const identity = suffix => ({ login_name: `signup_${runId}_${suffix}`,
  display_name: `Synthetic signup ${suffix}`, passphrase: `synthetic-${randomUUID()}` });
const first = identity('one');
const second = identity('two');

async function request(path, { method = 'GET', body, cookie, org, csrf = true, headers = {} } = {}) {
  const response = await fetch(new URL(path, base), {
    method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...(org ? { 'X-Grimoire-Organization': org } : {}),
      ...(csrf && !['GET', 'HEAD'].includes(method) ? { 'X-Grimoire-CSRF': '1' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  return { status: response.status, headers: response.headers, data };
}
function status(response, expected, code) {
  assert.equal(response.status, expected,
    `Expected HTTP ${expected}; got ${response.status} (${response.data?.error?.code ?? 'no API error code'})`);
  if (code) assert.equal(response.data?.error?.code, code);
  return response;
}
function session(response) {
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie ?? '', /^grimoire_session=[0-9a-f]{64};/);
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.match(cookie, /Path=\/api;/);
  const token = cookie.split(';', 1)[0];
  sessions.add(token);
  return token;
}
async function check(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}
const retry = suffix => ({ 'Idempotency-Key': `${runId}:${suffix}` });
let setupBefore;
let firstCookie;
let secondCookie;
let firstOrg;
let secondOrg;
let scion;
let source;
let task;

try {
  await check('only a disposable test database may be mutated', async () => {
    const health = status(await request('/api/health'), 200);
    assert.match(health.data?.database?.name ?? '', /_test$/,
      'Refusing signup fixture writes outside a *_test database.');
    setupBefore = status(await request('/api/setup/status'), 200).data.setup_required;
  });
  await check('signup, login and owner setup require a browser marker before any session', async () => {
    for (const path of ['/api/session/signup', '/api/session/login', '/api/setup/owner']) {
      const response = status(await request(path, { method: 'POST', body: first, csrf: false }),
        403, 'SESSION_REQUEST_DENIED');
      assert.equal(response.headers.get('set-cookie'), null);
    }
  });
  await check('seeded or agent bearer headers cannot register a human identity', async () => {
    const response = status(await request('/api/session/signup', { method: 'POST', body: first,
      headers: { Authorization: `Bearer ${process.env.GRIMOIRE_TOKEN_AGENT_A ?? 'synthetic-denied-bearer'}` } }),
    403, 'HANDLER_REGISTRATION_IDENTITY_DENIED');
    assert.equal(response.headers.get('set-cookie'), null);
  });
  await check('signup rejects caller-supplied owner authority', async () => {
    status(await request('/api/session/signup', { method: 'POST',
      body: { ...first, installation_owner: true } }), 422, 'INVALID_REQUEST');
  });
  await check('normal signup creates a non-owner with no inherited organization', async () => {
    const response = status(await request('/api/session/signup', { method: 'POST', body: first }), 201);
    firstCookie = session(response);
    assert.equal(response.data.handler.installation_owner, false);
    assert.equal(response.data.handler.login_name, first.login_name);
    assert.deepEqual(response.data.organizations, []);
    assert.equal(response.data.active_organization, null);
    assert.equal(status(await request('/api/setup/status'), 200).data.setup_required, setupBefore);
    status(await request('/api/scions', { cookie: firstCookie }), 409, 'ACTIVE_ORGANIZATION_REQUIRED');
  });
  await check('duplicate login conflicts without issuing a session', async () => {
    const response = status(await request('/api/session/signup', { method: 'POST',
      body: { ...first, login_name: first.login_name.toUpperCase() } }), 409, 'IDENTITY_CONFLICT');
    assert.equal(response.headers.get('set-cookie'), null);
  });
  await check('registered account can log in; wrong passphrase cannot', async () => {
    status(await request('/api/session/login', { method: 'POST',
      body: { login_name: first.login_name, passphrase: 'incorrect synthetic passphrase' } }), 401);
    const response = status(await request('/api/session/login', { method: 'POST',
      body: { login_name: first.login_name, passphrase: first.passphrase } }), 200);
    firstCookie = session(response);
    assert.equal(response.data.handler.installation_owner, false);
  });
  await check('separate signups create separate organizations without sourcing or approval authority', async () => {
    const registered = status(await request('/api/session/signup', { method: 'POST', body: second }), 201);
    secondCookie = session(registered);
    assert.equal(registered.data.handler.installation_owner, false);
    const users = [[firstCookie, 'one'], [secondCookie, 'two']];
    const organizations = [];
    for (const [cookie, suffix] of users) {
      const response = status(await request('/api/organizations', { method: 'POST', cookie,
        body: { name: `Synthetic registered organization ${suffix}` }, headers: retry(suffix) }), 201);
      const actor = response.data.active_organization;
      assert.equal(actor.can_manage_workspace, true);
      assert.equal(actor.can_prepare_workspace, true);
      for (const capability of ['can_write', 'can_confirm_scope', 'can_propose_scope', 'is_agent']) {
        assert.equal(actor[capability], false, `Unexpected privilege: ${capability}`);
      }
      assert.equal(response.data.organizations.length, 1);
      organizations.push(actor.org_id);
    }
    [firstOrg, secondOrg] = organizations;
    assert.notEqual(firstOrg, secondOrg);
  });
  await check('registered Handler can create a digital Scion in their own organization', async () => {
    const response = status(await request('/api/scions', { method: 'POST', cookie: firstCookie, org: firstOrg,
      headers: retry('scion'), body: { name: 'Synthetic signup website', product_category: 'digital',
        product_description: 'Provider-free registration isolation fixture.',
        requirements: ['Protect private organization data'], questions: ['Which Handler decision is missing?'],
        change_summary: 'Synthetic registration verification' } }), 201);
    scion = response.data.id;
  });
  await check('another registered organization cannot read Scion nodes, edges, alerts or revisions', async () => {
    for (const suffix of ['', '/revisions', '/control-surface', '/agent-tasks', '/sources']) {
      status(await request(`/api/scions/${scion}${suffix}`, { cookie: secondCookie, org: secondOrg }), 404);
    }
    assert.deepEqual(status(await request('/api/scions', { cookie: secondCookie, org: secondOrg }), 200).data.scions, []);
    status(await request('/api/session/active-organization', { method: 'POST', cookie: secondCookie,
      body: { organization_id: firstOrg } }), 404, 'ORGANIZATION_NOT_FOUND');
  });
  await check('registered owner records a permitted synthetic source and exact claim idempotently', async () => {
    const path = `/api/scions/${scion}/sources`;
    const options = { method: 'POST', cookie: firstCookie, org: firstOrg,
      headers: { ...retry('source'), 'If-Match': '"1"' },
      body: { title: 'Synthetic owned note', origin: 'synthetic://registration',
        owner: 'Synthetic test Handler', synthetic: true, source_text: 'Synthetic note',
        rights_status: 'granted', permission_basis: 'I authored this synthetic test note.',
        permitted_use: 'scion_review', change_summary: 'Synthetic preparation test' } };
    source = status(await request(path, options), 201).data.source_id;
    assert.equal(status(await request(path, options), 201).data.source_id, source);
    const claims = `${path}/${source}/revisions/1/claims`;
    const claimOptions = { method: 'POST', cookie: firstCookie, org: firstOrg,
      headers: retry('claim'), body: { statement: 'Unverified synthetic claim',
        locator: { start_byte: 0, end_byte: 14, quote: 'Synthetic note' } } };
    const claim = status(await request(claims, claimOptions), 201).data.claim_id;
    assert.equal(status(await request(claims, claimOptions), 201).data.claim_id, claim);
  });
  await check('registered owner queues, dispatches and cancels digital work without duplicate events', async () => {
    const path = `/api/scions/${scion}/agent-tasks`;
    const options = { method: 'POST', cookie: firstCookie, org: firstOrg,
      headers: { ...retry('task'), 'If-Match': '"1"' },
      body: { task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, timeout_seconds: 120 } };
    const created = status(await request(path, options), 201).data;
    task = created.id;
    assert.equal(created.status, 'queued');
    assert.equal(status(await request(path, options), 201).data.id, task);
    status(await request(path, { ...options, body: { ...options.body, timeout_seconds: 90 } }),
      409, 'IDEMPOTENCY_CONFLICT');
    for (const action of ['dispatch', 'cancel']) {
      const actionOptions = { method: 'POST', cookie: firstCookie, org: firstOrg,
        headers: { 'If-Match': '"1"' } };
      const expected = action === 'dispatch' ? 'dispatched' : 'cancelled';
      assert.equal(status(await request(`${path}/${task}/${action}`, actionOptions), 200).data.status, expected);
      assert.equal(status(await request(`${path}/${task}/${action}`, actionOptions), 200).data.status, expected);
    }
    const events = status(await request(`${path}/${task}/events`, { cookie: firstCookie, org: firstOrg }), 200).data.events;
    assert.deepEqual(events.map(event => event.status), ['queued', 'dispatched', 'cancelled']);
  });
  await check('foreign organization cannot read prepared source content or task events', async () => {
    for (const suffix of [`sources/${source}`, `sources/${source}/revisions`, `agent-tasks/${task}/events`]) {
      status(await request(`/api/scions/${scion}/${suffix}`, { cookie: secondCookie, org: secondOrg }), 404);
    }
  });
  await check('registered owner can revoke source permission and immediately loses content access', async () => {
    const path = `/api/scions/${scion}/sources/${source}`;
    const options = { method: 'POST', cookie: firstCookie, org: firstOrg,
      headers: { ...retry('source-revoke'), 'If-Match': '"1"' }, body: { reason: 'Synthetic permission withdrawal' } };
    assert.equal(status(await request(`${path}/revoke`, options), 201).data.rights_status, 'revoked');
    status(await request(`${path}/revoke`, options), 201);
    status(await request(path, { cookie: firstCookie, org: firstOrg }), 403, 'SOURCE_RIGHTS_DENIED');
  });
  await check('workspace preparation grants no physical sourcing or approval authority', async () => {
    for (const [path, code] of [[`/api/scions/${scion}/scope/proposals`, 'SCOPE_PROPOSAL_DENIED'],
      ['/api/approvals', 'APPROVAL_UNAVAILABLE'], [`/api/scions/${scion}/sourcing-approval`, 'APPROVAL_UNAVAILABLE']]) {
      status(await request(path, { method: 'POST', cookie: firstCookie, org: firstOrg, body: {},
        headers: { ...retry(path), 'If-Match': '"1"' } }), 403, code);
    }
    for (const task_kind of ['prepare_physical_scope', 'prepare_offer_normalization']) {
      status(await request(`/api/scions/${scion}/agent-tasks`, { method: 'POST', cookie: firstCookie, org: firstOrg,
        headers: { ...retry(task_kind), 'If-Match': '"1"' },
        body: { task_kind, candidate_proposal: { synthetic: true }, timeout_seconds: 120 } }), 403, 'INTAKE_WRITE_DENIED');
    }
    const physical = status(await request('/api/scions', { method: 'POST', cookie: firstCookie, org: firstOrg,
      headers: retry('physical-scion'), body: { name: 'Synthetic physical intake', product_category: 'physical',
        product_description: 'Physical preparation must retain its existing authority requirement.' } }), 201).data.id;
    status(await request(`/api/scions/${physical}/agent-tasks`, { method: 'POST', cookie: firstCookie, org: firstOrg,
      headers: { ...retry('physical-capability'), 'If-Match': '"1"' },
      body: { task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, timeout_seconds: 120 } }),
    403, 'INTAKE_WRITE_DENIED');
    const actor = status(await request('/api/session', { cookie: firstCookie }), 200).data.active_organization;
    assert.equal(actor.can_prepare_workspace, true);
    for (const capability of ['can_write', 'can_confirm_scope', 'can_propose_scope', 'is_agent']) {
      assert.equal(actor[capability], false, `Preparation granted unexpected privilege: ${capability}`);
    }
  });
  await check('signup leaves installation setup state unchanged', async () => {
    assert.equal(status(await request('/api/setup/status'), 200).data.setup_required, setupBefore);
  });
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const cookie of sessions) {
    try { status(await request('/api/session', { method: 'DELETE', cookie }), 204); }
    catch (error) { console.error(`FAIL session cleanup: ${error.message}`); process.exitCode = 1; }
  }
  console.log(JSON.stringify({ run_id: runId, api: base.origin, passed, failed: process.exitCode ? 1 : 0 }, null, 2));
}
