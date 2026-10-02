import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// This suite creates a synthetic installation owner and organizations. It never
// starts a service, contacts an agent provider, or operates on an existing owner.
// Example: GRIMOIRE_API_URL=http://127.0.0.1:18089 node scripts/verify-onboarding.mjs --disposable
if (!process.argv.includes('--disposable')) {
  throw new Error('Refusing setup mutations: pass --disposable for a fresh test database.');
}
if (!process.env.GRIMOIRE_API_URL) {
  throw new Error('Set GRIMOIRE_API_URL to the disposable API instance.');
}
const base = new URL(process.env.GRIMOIRE_API_URL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.search || base.hash
    || base.pathname !== '/' || !['http:', 'https:'].includes(base.protocol)) {
  throw new Error('GRIMOIRE_API_URL must be a loopback HTTP(S) origin without credentials.');
}

const runId = randomUUID();
const loginName = process.env.GRIMOIRE_TEST_LOGIN ?? 'onboarding-regression-owner';
const passphrase = process.env.GRIMOIRE_TEST_PASSPHRASE ?? `synthetic-only-${randomUUID()}`;
const owner = { login_name: loginName, display_name: 'Synthetic onboarding owner', passphrase };
const results = [];
const identifiers = {};
const sessions = new Set();
let cookie;
let organization;

async function request(path, { method = 'GET', body, headers = {}, session = cookie,
  org = organization, csrf = true } = {}) {
  const outgoing = { Accept: 'application/json', ...headers };
  if (body !== undefined) outgoing['Content-Type'] = 'application/json';
  if (session) outgoing.Cookie = session;
  if (org) outgoing['X-Grimoire-Organization'] = org;
  if (csrf && method !== 'GET') outgoing['X-Grimoire-CSRF'] = '1';
  const response = await fetch(new URL(path, base), {
    method, headers: outgoing, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(15000),
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

function captureSession(response) {
  const value = response.headers.get('set-cookie');
  assert.ok(/^grimoire_session=[0-9a-f]{64};/.test(value ?? ''), 'Expected an opaque session cookie');
  assert.ok(/HttpOnly/i.test(value), 'Session cookie must be HttpOnly');
  assert.ok(/SameSite=Strict/i.test(value), 'Session cookie must be SameSite=Strict');
  assert.ok(/Path=\/api(?:;|$)/i.test(value), 'Session cookie must be scoped to /api');
  const captured = value.split(';', 1)[0];
  sessions.add(captured);
  return captured;
}

async function check(name, execute) {
  try {
    await execute();
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    throw error;
  }
}

const keyHeaders = suffix => ({ 'Idempotency-Key': `${runId}:${suffix}` });
const draft = {
  name: 'Synthetic onboarding website', product_category: 'digital',
  product_description: 'Provider-free login and organization isolation fixture.',
  requirements: ['Keep other organizations isolated'], questions: ['Which Handler decision is required?'],
  change_summary: 'Synthetic onboarding regression fixture',
};

try {
  await check('fresh disposable installation is required', async () => {
    const response = status(await request('/api/setup/status', { session: null, org: null }), 200);
    assert.equal(response.data.setup_required, true, 'Existing installation detected; refusing all mutations.');
  });
  await check('installation owner setup issues a protected cookie', async () => {
    const response = status(await request('/api/setup/owner', {
      method: 'POST', body: owner, session: null, org: null,
    }), 201);
    cookie = captureSession(response);
    identifiers.handler = response.data.handler.identity_id;
    assert.equal(response.data.handler.installation_owner, true);
    assert.deepEqual(response.data.organizations, []);
    assert.equal(response.data.active_organization, null);
  });
  await check('setup is complete and duplicate owner setup conflicts', async () => {
    assert.equal(status(await request('/api/setup/status'), 200).data.setup_required, false);
    status(await request('/api/setup/owner', { method: 'POST', body: owner, session: null }),
      409, 'INSTALLATION_ALREADY_CONFIGURED');
  });
  await check('invalid credentials do not issue a session', async () => {
    const response = status(await request('/api/session/login', {
      method: 'POST', session: null, body: { login_name: loginName, passphrase: 'wrong-synthetic-passphrase' },
    }), 401, 'UNAUTHENTICATED');
    assert.equal(response.headers.get('set-cookie'), null);
  });
  await check('valid login restores the Handler identity', async () => {
    const response = status(await request('/api/session/login', {
      method: 'POST', session: null, body: { login_name: loginName, passphrase },
    }), 200);
    cookie = captureSession(response);
    assert.equal(response.data.handler.identity_id, identifiers.handler);
  });
  await check('cookie mutation requires the CSRF marker', async () => {
    status(await request('/api/organizations', {
      method: 'POST', csrf: false, body: { name: 'Must not be created' }, headers: keyHeaders('csrf'),
    }), 403, 'SESSION_REQUEST_DENIED');
    assert.deepEqual(status(await request('/api/session'), 200).data.organizations, []);
  });
  await check('organization creation grants workspace preparation without sourcing or approval authority', async () => {
    const response = status(await request('/api/organizations', {
      method: 'POST', body: { name: 'Synthetic Alpha' }, headers: keyHeaders('alpha'),
    }), 201);
    const actor = response.data.active_organization;
    organization = actor.org_id;
    identifiers.alpha = organization;
    assert.equal(actor.can_manage_workspace, true);
    assert.equal(actor.can_prepare_workspace, true);
    for (const capability of ['can_write', 'can_confirm_scope', 'can_propose_scope', 'is_agent']) {
      assert.equal(actor[capability], false, `Unexpected privilege: ${capability}`);
    }
    assert.equal(response.data.organizations.length, 1);
  });
  await check('organization retry is idempotent and changed input conflicts', async () => {
    const replay = status(await request('/api/organizations', {
      method: 'POST', body: { name: 'Synthetic Alpha' }, headers: keyHeaders('alpha'),
    }), 201);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.equal(replay.data.active_organization.org_id, organization);
    assert.equal(replay.data.organizations.length, 1);
    status(await request('/api/organizations', {
      method: 'POST', body: { name: 'Conflicting Alpha' }, headers: keyHeaders('alpha'),
    }), 409, 'IDEMPOTENCY_CONFLICT');
    assert.equal(status(await request('/api/session'), 200).data.organizations.length, 1);
  });
  await check('new organization has no Scions', async () => {
    assert.deepEqual(status(await request('/api/scions'), 200).data.scions, []);
  });
  await check('workspace requests require the expected organization', async () => {
    status(await request('/api/scions', { org: null }), 409, 'ACTIVE_ORGANIZATION_CHANGED');
  });
  await check('organization admin creates a Scion draft', async () => {
    const response = status(await request('/api/scions', {
      method: 'POST', body: draft, headers: keyHeaders('scion'),
    }), 201);
    identifiers.scion = response.data.id;
    assert.equal(response.data.current_revision, 1);
    assert.equal(response.data.revision.product_category, 'digital');
    assert.equal(response.headers.get('etag'), '"1"');
  });
  await check('organization admin revises a Scion with its current version', async () => {
    const response = status(await request(`/api/scions/${identifiers.scion}/revisions`, {
      method: 'POST', body: { ...draft, name: 'Revised synthetic website', change_summary: 'Revision regression' },
      headers: { ...keyHeaders('revision'), 'If-Match': '"1"' },
    }), 201);
    assert.equal(response.data.current_revision, 2);
    assert.equal(response.data.revision.name, 'Revised synthetic website');
    assert.equal(response.headers.get('etag'), '"2"');
  });
  await check('organization admin records internal evidence with an idempotent source receipt', async () => {
    const path = `/api/scions/${identifiers.scion}/sources`;
    const options = { method: 'POST', headers: { ...keyHeaders('source'), 'If-Match': '"2"' },
      body: { title: 'Synthetic onboarding note', origin: 'synthetic://onboarding', owner: 'Synthetic onboarding owner',
        synthetic: true, source_text: 'Synthetic note', rights_status: 'granted',
        permission_basis: 'I authored this synthetic test note.', permitted_use: 'scion_review',
        change_summary: 'Synthetic workspace preparation regression' } };
    identifiers.source = status(await request(path, options), 201).data.source_id;
    assert.equal(status(await request(path, options), 201).data.source_id, identifiers.source);
  });
  await check('organization admin queues and cancels a digital task idempotently', async () => {
    const path = `/api/scions/${identifiers.scion}/agent-tasks`;
    const options = { method: 'POST', headers: { ...keyHeaders('task'), 'If-Match': '"2"' },
      body: { task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, timeout_seconds: 120 } };
    const created = status(await request(path, options), 201).data;
    identifiers.task = created.id;
    assert.equal(created.status, 'queued');
    assert.equal(status(await request(path, options), 201).data.id, identifiers.task);
    status(await request(path, { ...options, body: { ...options.body, timeout_seconds: 90 } }), 409, 'IDEMPOTENCY_CONFLICT');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.equal(status(await request(`${path}/${identifiers.task}/cancel`, { method: 'POST' }), 200).data.status, 'cancelled');
    }
    const events = status(await request(`${path}/${identifiers.task}/events`), 200).data.events;
    assert.deepEqual(events.map(event => event.status), ['queued', 'cancelled']);
  });
  await check('organization admin cannot queue physical scope or supplier-offer preparation', async () => {
    for (const task_kind of ['prepare_physical_scope', 'prepare_offer_normalization']) {
      status(await request(`/api/scions/${identifiers.scion}/agent-tasks`, {
        method: 'POST', headers: { ...keyHeaders(task_kind), 'If-Match': '"2"' },
        body: { task_kind, candidate_proposal: { synthetic: true }, timeout_seconds: 120 },
      }), 403, 'INTAKE_WRITE_DENIED');
    }
  });
  for (const [label, path, code] of [
    ['physical scope proposal', `/api/scions/${identifiers.scion}/scope/proposals`, 'SCOPE_PROPOSAL_DENIED'],
    ['approval', '/api/approvals', 'APPROVAL_UNAVAILABLE'],
    ['Scion sourcing approval', `/api/scions/${identifiers.scion}/sourcing-approval`, 'APPROVAL_UNAVAILABLE'],
  ]) {
    await check(`plain organization admin cannot perform ${label}`, async () => {
      status(await request(path, {
        method: 'POST', body: {}, headers: { ...keyHeaders(label), 'If-Match': '"2"' },
      }), 403, code);
    });
  }
  await check('second organization starts empty and cannot read the first Scion', async () => {
    const response = status(await request('/api/organizations', {
      method: 'POST', body: { name: 'Synthetic Beta' }, headers: keyHeaders('beta'),
    }), 201);
    organization = response.data.active_organization.org_id;
    identifiers.beta = organization;
    assert.notEqual(organization, identifiers.alpha);
    assert.equal(response.data.organizations.length, 2);
    assert.deepEqual(status(await request('/api/scions'), 200).data.scions, []);
    status(await request(`/api/scions/${identifiers.scion}`), 404, 'SCION_NOT_FOUND');
    status(await request(`/api/scions/${identifiers.scion}/revisions`), 404, 'SCION_NOT_FOUND');
    for (const suffix of ['/control-surface', `/sources/${identifiers.source}`, `/agent-tasks/${identifiers.task}/events`]) {
      status(await request(`/api/scions/${identifiers.scion}${suffix}`), 404);
    }
  });
  await check('stale tab cannot read or write after a shared-session organization switch', async () => {
    status(await request('/api/scions', { org: identifiers.alpha }), 409, 'ACTIVE_ORGANIZATION_CHANGED');
    status(await request('/api/scions', {
      method: 'POST', org: identifiers.alpha, body: { ...draft, name: 'Must not cross organizations' },
      headers: keyHeaders('stale-tab-create'),
    }), 409, 'ACTIVE_ORGANIZATION_CHANGED');
    assert.deepEqual(status(await request('/api/scions'), 200).data.scions, []);
  });
  await check('switching back restores the original revision without a stale-tab write', async () => {
    const response = status(await request('/api/session/active-organization', {
      method: 'POST', body: { organization_id: identifiers.alpha },
    }), 200);
    organization = response.data.active_organization.org_id;
    assert.equal(organization, identifiers.alpha);
    const scions = status(await request('/api/scions'), 200).data.scions;
    assert.equal(scions.length, 1);
    assert.equal(scions[0].id, identifiers.scion);
    assert.equal(scions[0].current_revision, 2);
  });
  await check('non-member organization switch is denied without changing the active organization', async () => {
    status(await request('/api/session/active-organization', {
      method: 'POST', body: { organization_id: randomUUID() },
    }), 404, 'ORGANIZATION_NOT_FOUND');
    assert.equal(status(await request('/api/session'), 200).data.active_organization.org_id, identifiers.alpha);
  });
  await check('logout revokes the session and reused cookie cannot read or mutate', async () => {
    const revoked = cookie;
    const response = status(await request('/api/session', { method: 'DELETE' }), 204);
    assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/);
    sessions.delete(revoked);
    for (const path of ['/api/session', '/api/scions']) {
      status(await request(path, { session: revoked }), 401, 'UNAUTHENTICATED');
    }
    status(await request('/api/organizations', {
      method: 'POST', session: revoked, body: { name: 'Revoked session must not create' },
      headers: keyHeaders('revoked-create'),
    }), 401, 'UNAUTHENTICATED');
    status(await request('/api/session/active-organization', {
      method: 'POST', session: revoked, body: { organization_id: identifiers.beta },
    }), 401, 'UNAUTHENTICATED');
    cookie = null;
  });
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  // Keep the disposable records available for database audit inspection, but
  // revoke any setup/login session still held by the harness, including on failure.
  for (const session of sessions) {
    try {
      status(await request('/api/session', { method: 'DELETE', session }), 204);
    } catch (error) {
      results.push({ name: 'cleanup session revocation', passed: false, error: error.message });
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify({ run_id: runId, api: base.origin, login_name: loginName,
    ...identifiers, passed: results.filter(result => result.passed).length,
    failed: results.filter(result => !result.passed).length, results }, null, 2));
}
