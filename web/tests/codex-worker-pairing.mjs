import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { childEnvironment } from '../../byoa/bridge.mjs';
import { connectionDirectory, loadConnection, validateOrigin } from '../../byoa/connection.mjs';

// Real Chrome, real disposable PostgreSQL-backed API, real pairing CLI and idle
// worker. No task is dispatched and no provider/model invocation is authorized.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = validateOrigin(process.env.GRIMOIRE_WEB_URL ?? 'http://127.0.0.1:5182');
const address = new URL(base);
assert.equal(process.env.GRIMOIRE_TEST_DISPOSABLE, '1', 'Explicit disposable-installation authorization is required.');
assert.ok(address.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname), 'Only a local test installation may be used.');
const database = process.env.GRIMOIRE_TEST_DATABASE ?? 'grimoire_codex_v1_test';
assert.ok(database.endsWith('_test'), 'The named database must end in _test.');
const healthResponse = await fetch(`${base}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
assert.equal(health.database?.name, database, 'Verify disposable database identity before any account or worker mutation.');

const evidence = path.resolve(root, '.local', 'codex-worker-pairing', String(Date.now()));
await mkdir(evidence, { recursive: true });
const stamp = Date.now(), suffix = randomUUID().slice(0, 8);
const login = `pairing-test-${stamp}-${suffix}`;
const passphrase = `Synthetic-only-${randomUUID()}`;
const alphaName = `Synthetic Pairing Alpha ${stamp}`, betaName = `Synthetic Pairing Beta ${stamp}`;
const checks = [], browserErrors = [], children = [];
let browser, mainContext, page, record, connectionId, alphaId, betaId, revoked = false;
let secretReachedBrowser = false, dispatched = false;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function until(check, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(300);
  }
  throw new Error(`Timed out: ${label}`);
}
function launch(script, args) {
  const environment = childEnvironment(process.env);
  if (process.env.GRIMOIRE_CODEX_BIN) environment.GRIMOIRE_CODEX_BIN = process.env.GRIMOIRE_CODEX_BIN;
  const child = spawn(process.execPath, [path.join(root, script), ...args], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const managed = { child, stdout: '', stderr: '', exited: false, exitCode: null, error: false };
  managed.completion = new Promise(resolve => {
    child.once('error', () => { managed.error = true; });
    child.once('close', code => { managed.exited = true; managed.exitCode = code; resolve(); });
  });
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', data => {
    managed[stream] += data.toString();
    if (managed[stream].length > 32000 && !managed.exited) child.kill();
  });
  children.push(managed);
  return managed;
}
async function stop(managed) {
  if (!managed || managed.exited) return;
  // Stop only the exact Node child we created. This test never dispatches work,
  // so the worker cannot own a model process that would need task cancellation.
  managed.child.kill();
  await until(() => managed.exited, 'exact test worker termination', 10000);
}
async function newContext() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.on('page', current => {
    current.setDefaultTimeout(20000);
    current.on('pageerror', error => browserErrors.push(error.name));
    current.on('request', request => {
      if (request.method() !== 'GET' && /\/agent-tasks\/[^/]+\/dispatch$|\/tasks\/[^/]+\/dispatch$/.test(new URL(request.url()).pathname)) dispatched = true;
    });
    current.on('response', async response => {
      if (!record || !new URL(response.url()).pathname.startsWith('/api/worker-connections')) return;
      try { if ((await response.text()).includes(record.credential)) secretReachedBrowser = true; } catch { /* Navigation may abort a response. */ }
    });
  });
  return context;
}
const headers = org => ({ 'X-Grimoire-Organization': org, 'X-Grimoire-CSRF': '1' });
async function api(context, route, org, options = {}) {
  const response = await context.request.fetch(`${base}/api${route}`, { ...options, headers: { ...headers(org), ...options.headers } });
  return response;
}
async function session(context) {
  const response = await context.request.get(`${base}/api/session`);
  assert.equal(response.status(), 200);
  return response.json();
}
async function connections() {
  const response = await api(mainContext, '/worker-connections', alphaId);
  assert.equal(response.status(), 200);
  return (await response.json()).connections;
}
async function orgMenu() {
  const trigger = page.getByRole('button', { name: 'Organization menu', exact: true });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  return page.getByRole('group', { name: 'Organizations', exact: true });
}
async function switchOrg(org) {
  await (await orgMenu()).locator(`button[data-organization-id="${org}"]`).click();
  await page.waitForFunction(id => document.querySelector('button[aria-label="Organization menu"]')?.getAttribute('data-organization-id') === id, org);
}
async function createOrg(name) {
  await page.getByRole('heading', { name: 'What is your organization called?', exact: true }).waitFor();
  await page.locator('#organization-name').fill(name);
  await page.getByRole('button', { name: /Create organization/ }).click();
  await page.getByRole('heading', { name: 'Connect your Codex worker', exact: true }).waitFor();
  return (await session(mainContext)).active_organization.org_id;
}
async function rowStatus(status) {
  await page.locator('.worker-connection-list article').filter({ has: page.getByText(connectionId, { exact: true }) }).locator('.work-status').filter({ hasText: new RegExp(`^${status}$`, 'i') }).waitFor();
}
async function refreshConnections() { await page.getByRole('button', { name: 'Check connections', exact: true }).click(); }
async function snapshot(name) { await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true }); }

try {
  const cli = launch('byoa/connect.mjs', ['--api', base, '--device-name', `Synthetic browser worker ${stamp}`, '--watch']);
  const approvalUrl = await until(() => {
    if (cli.exited) throw new Error('Pairing CLI exited before producing a browser approval URL; inspect local Codex availability.');
    return cli.stdout.match(/https?:\/\/[^\s]+\/#\/connect-worker\/[A-F0-9]{16}/)?.[0];
  }, 'local CLI login check and pairing creation');
  assert.equal(new URL(approvalUrl).origin, base);
  const userCode = new URL(approvalUrl).hash.split('/').at(-1);
  assert.ok(cli.stdout.includes('No model was invoked.'));
  assert.ok(!cli.stdout.includes('device_secret'));
  checks.push('installed Codex checked locally; real pairing CLI starts without a model invocation or credential export');

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  mainContext = await newContext(); page = await mainContext.newPage();
  await page.goto(approvalUrl);
  await page.getByRole('button', { name: 'Use create account form', exact: true }).click();
  await page.locator('#handler-name').fill('Synthetic Pairing Handler');
  await page.locator('#login-name').fill(login);
  await page.locator('#handler-passphrase').fill(passphrase);
  await page.getByRole('button', { name: /Create account and continue/ }).click();
  alphaId = await createOrg(alphaName);
  assert.equal(new URL(page.url()).hash, `#/connect-worker/${userCode}`);
  const state = await session(mainContext);
  assert.equal(state.handler.installation_owner, false);
  assert.equal(state.active_organization.can_confirm_scope, false);
  assert.equal(state.active_organization.is_agent, false);
  assert.equal(await page.getByRole('button', { name: 'Authorize computer', exact: true }).isDisabled(), true);
  checks.push('fresh signup and organization creation preserve the pairing route without claiming installation ownership or approval authority');

  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.locator('#login-name').waitFor();
  await mainContext.close();
  mainContext = await newContext(); page = await mainContext.newPage();
  await page.goto(approvalUrl);
  await page.locator('#login-name').fill(login);
  await page.locator('#handler-passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Connect your Codex worker', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, `#/connect-worker/${userCode}`);
  checks.push('a fresh browser login returns to the exact pending pairing instead of losing its route');

  await (await orgMenu()).getByRole('button', { name: 'Create another organization', exact: true }).click();
  betaId = await createOrg(betaName);
  assert.notEqual(alphaId, betaId);
  await page.getByRole('checkbox').check();
  await switchOrg(alphaId);
  await until(async () => page.locator('.worker-pairing').getByText(alphaName, { exact: true }).first().isVisible(), 'selected organization review');
  assert.equal(await page.getByRole('checkbox').isChecked(), false, 'Switching organizations must clear consent.');
  const stale = await api(mainContext, `/worker-connections/pairings/${userCode}/approve`, betaId, { method: 'POST', data: { organization_id: betaId, consent: true, policy_version: 'codex-synthetic-v1' } });
  assert.equal(stale.status(), 409, 'A stale organization approval is rejected.');
  await snapshot('pairing-explicit-organization-consent');
  const workspaceBefore = await (await api(mainContext, '/workspace', alphaId)).json();
  assert.deepEqual(workspaceBefore.tasks, [], 'The fresh organization must have no work that an idle worker could claim.');
  assert.deepEqual(workspaceBefore.scions, []);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Authorize computer', exact: true }).click();
  await page.getByRole('heading', { name: 'Computer authorized', exact: true }).waitFor();
  connectionId = await until(() => {
    if (cli.exited) throw new Error('Pair-and-watch CLI exited before entering its worker loop.');
    return cli.stdout.match(/Connection: ([a-f0-9-]{36})/)?.[1];
  }, 'CLI consumes the single approved credential and stays running');
  assert.ok(connectionId, 'CLI prints a connection identifier.');
  record = await loadConnection(connectionId); // Also verifies Windows DACL or Unix 0600/0700 ownership.
  assert.equal(record.organization_id, alphaId);
  assert.equal(record.api_origin, base);
  assert.ok(!cli.stdout.includes(record.credential) && !cli.stderr.includes(record.credential), 'CLI must never print the credential.');
  const afterApproval = await connections();
  assert.equal(afterApproval.length, 1);
  const repeat = await api(mainContext, `/worker-connections/pairings/${userCode}/approve`, alphaId, { method: 'POST', data: { organization_id: alphaId, consent: true, policy_version: 'codex-synthetic-v1' } });
  assert.equal(repeat.status(), 200);
  assert.equal((await repeat.json()).status, 'consumed');
  assert.equal((await connections()).length, 1);
  checks.push('explicit organization consent issues one privately stored worker credential; approval replay creates no additional connection');

  await switchOrg(betaId);
  const foreign = await api(mainContext, `/worker-connections/pairings/${userCode}`, betaId);
  assert.equal(foreign.status(), 404);
  const foreignList = await api(mainContext, '/worker-connections', betaId);
  assert.deepEqual((await foreignList.json()).connections, []);
  const foreignRevoke = await api(mainContext, `/worker-connections/${connectionId}/revoke`, betaId, { method: 'POST', data: { organization_id: betaId } });
  assert.equal(foreignRevoke.status(), 404);
  await until(async () => !(await page.locator('.worker-pairing-code').count()) || await page.getByRole('alert').isVisible(), 'foreign pairing hidden');
  assert.equal(await page.getByRole('button', { name: 'Authorize computer', exact: true }).count(), 0);
  const foreignContext = await newContext();
  try {
    const foreignSignup = await foreignContext.request.post(`${base}/api/session/signup`, { headers: { 'X-Grimoire-CSRF': '1' }, data: { login_name: `foreign-pairing-${stamp}-${suffix}`, display_name: 'Synthetic Foreign Handler', passphrase: `Synthetic-foreign-${randomUUID()}` } });
    assert.equal(foreignSignup.status(), 201);
    const foreignOrg = await foreignContext.request.post(`${base}/api/organizations`, { headers: { 'X-Grimoire-CSRF': '1', 'Idempotency-Key': `foreign-org-${randomUUID()}` }, data: { name: `Synthetic Foreign Pairing Organization ${stamp}` } });
    assert.equal(foreignOrg.status(), 201);
    const foreignId = (await foreignOrg.json()).active_organization.org_id;
    assert.equal((await api(foreignContext, `/worker-connections/pairings/${userCode}`, foreignId)).status(), 404);
    assert.deepEqual((await (await api(foreignContext, '/worker-connections', foreignId)).json()).connections, []);
    assert.equal((await api(foreignContext, `/worker-connections/${connectionId}/revoke`, foreignId, { method: 'POST', data: { organization_id: foreignId } })).status(), 404);
  } finally { await foreignContext.close(); }
  await switchOrg(alphaId);
  await page.getByRole('button', { name: 'View worker connection', exact: true }).click();
  await page.getByRole('heading', { name: 'Agent connections', exact: true }).waitFor();
  checks.push('another organization and a separate foreign account cannot review, enumerate or revoke the enrolled connection; browser hides authorization controls after the switch');

  await until(async () => (await connections()).some(connection => connection.connection_id === connectionId && connection.status === 'connected'), 'real idle worker heartbeat');
  await refreshConnections(); await rowStatus('Worker online');
  const connected = (await connections())[0];
  assert.ok(connected.last_seen);
  await snapshot('runtime-real-worker-connected');
  assert.equal(cli.exited, false);
  checks.push('the same pair-and-watch CLI starts the real idle worker after approval; server-owned presence and heartbeat arrive without a second launch, dispatch or model invocation');

  assert.equal(await page.locator('.worker-setup').count(), 0, 'Setup starts collapsed.');
  await page.getByRole('button', { name: 'Connect Codex', exact: true }).click();
  await page.locator('.worker-setup').waitFor();
  assert.equal(await page.locator('.worker-setup .worker-command code').innerText(), `node byoa/connect.mjs --api '${base}' --watch`);
  await page.getByRole('button', { name: 'Copy connect command', exact: true }).click();
  await page.getByRole('button', { name: 'Copy connect command copied', exact: true }).waitFor();
  await snapshot('runtime-compact-connect-setup');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'The connection setup must not overflow a mobile viewport.');
  assert.ok((await page.locator('.worker-provider-heading>div').boundingBox()).width >= 140, 'Mobile provider copy must retain a readable column, not collapse beside the action.');
  await snapshot('runtime-connect-mobile');
  await page.locator('.worker-setup .worker-command').scrollIntoViewIfNeeded();
  assert.ok((await page.locator('.worker-setup .worker-command pre').boundingBox()).width >= 160, 'Mobile commands must use the available width instead of squeezing beside Copy.');
  await snapshot('runtime-connect-mobile-command');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Close setup', exact: true }).click();
  assert.equal(await page.locator('.worker-setup').count(), 0);
  checks.push('the compact provider card expands into a copyable current-origin pair-and-watch command and can close without changing the connection');

  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('radio', { name: /Midnight Blue/ }).check();
  await page.getByRole('button', { name: 'Runtime', exact: true }).click();
  await rowStatus('Worker online');
  await snapshot('runtime-midnight-blue');
  checks.push('connection setup fits a 390px mobile viewport and the same real worker status renders in Midnight Blue');

  // Inject only a transport outage; successful states still come from the API.
  await page.route('**/api/worker-connections', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_NETWORK_OUTAGE', message: 'Synthetic browser outage check.' } }) }));
  await refreshConnections();
  await page.getByText('Connection state unavailable. Waiting for an authenticated check.', { exact: true }).waitFor();
  assert.equal(await page.locator('.worker-connection-list article').count(), 0, 'Failed checks must hide previously connected rows.');
  await snapshot('runtime-outage-hides-stale-state');
  await page.unroute('**/api/worker-connections');
  await refreshConnections(); await rowStatus('Worker online');
  checks.push('an explicit test transport outage removes stale connected state; authenticated recovery restores real state');

  await stop(cli);
  await until(async () => (await connections())[0]?.status === 'disconnected', 'server heartbeat expiry after exact worker stop', 30000);
  const stoppedLastSeen = (await connections())[0].last_seen;
  await refreshConnections(); await rowStatus('Offline');
  assert.equal((await connections())[0].last_seen, stoppedLastSeen, 'Browser refresh must not synthesize a worker heartbeat.');
  await page.locator('.worker-resume summary').filter({ hasText: 'Resume worker' }).click();
  assert.equal(await page.locator('.worker-resume .worker-command code').innerText(), `node byoa/bridge.mjs --connection ${connectionId} --watch`);
  await snapshot('runtime-worker-stopped');
  const restarted = launch('byoa/bridge.mjs', ['--connection', connectionId, '--watch']);
  await until(async () => (await connections())[0]?.status === 'connected', 'restarted worker restores saved enrollment');
  await refreshConnections(); await rowStatus('Worker online');
  assert.equal((await connections()).length, 1);
  checks.push('stopping the exact worker becomes disconnected after server heartbeat expiry; restart reuses the private enrollment without a duplicate connection');

  await page.locator('.worker-details summary').filter({ hasText: 'Connection details' }).click();
  await page.getByText('Synthetic proposals · Human review required', { exact: true }).waitFor();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Revoke connection', exact: true }).click();
  await rowStatus('Revoked'); revoked = true;
  const denied = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${record.credential}` }, redirect: 'error' });
  assert.equal(denied.status, 401, 'Revocation invalidates the worker credential.');
  await stop(restarted);
  const revokedConnections = await connections();
  assert.equal(revokedConnections.length, 1);
  assert.equal(revokedConnections[0].status, 'revoked');
  await snapshot('runtime-worker-revoked');
  checks.push('browser revocation removes worker access; the previously valid credential now receives 401 and the durable row remains revoked');

  const workspaceAfter = await (await api(mainContext, '/workspace', alphaId)).json();
  assert.deepEqual(workspaceAfter.tasks, []);
  assert.deepEqual(workspaceAfter.scions, []);
  assert.equal(workspaceAfter.agent_runtime.status, 'disconnected');
  assert.equal((await session(mainContext)).active_organization.can_confirm_scope, false);
  assert.equal(dispatched, false);
  assert.equal(secretReachedBrowser, false);
  assert.ok(!JSON.stringify(await mainContext.storageState()).includes(record.credential), 'Worker credential is absent from browser storage and cookies.');
  for (const managed of children) assert.ok(!managed.stdout.includes(record.credential) && !managed.stderr.includes(record.credential));
  assert.deepEqual(browserErrors, []);
  checks.push('pairing, presence and revocation create no tasks, Scions or approval authority; no worker credential reaches browser storage or output');
  const report = { passed: checks.length, database, model_invoked: false, dispatched: false, checks, evidence, browser_errors: browserErrors };
  await writeFile(path.join(evidence, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const managed of children) await stop(managed).catch(() => {});
  if (connectionId && !revoked && mainContext) {
    // Restore the test account's selected organization before revoking only its
    // freshly created connection. No primary-user or installation data is used.
    await mainContext.request.post(`${base}/api/session/active-organization`, { headers: { 'X-Grimoire-CSRF': '1' }, data: { organization_id: alphaId } }).catch(() => {});
    await api(mainContext, `/worker-connections/${connectionId}/revoke`, alphaId, { method: 'POST', data: { organization_id: alphaId } }).catch(() => {});
  }
  if (/^[a-f0-9-]{36}$/.test(connectionId ?? '')) {
    const ownFile = path.resolve(connectionDirectory, `${connectionId}.json`);
    assert.equal(path.dirname(ownFile), path.resolve(connectionDirectory));
    await unlink(ownFile).catch(() => {});
  }
  await browser?.close();
}
