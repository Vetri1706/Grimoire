import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// A disposable protocol-only computer advertises one heartbeat before dispatch.
// No worker is spawned, no task is claimed, and no model or public fetch runs.
assert.equal(process.env.GRIMOIRE_TEST_DISPOSABLE, '1');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.GRIMOIRE_WEB_URL ?? 'http://127.0.0.1:5182';
const database = process.env.GRIMOIRE_TEST_DATABASE ?? 'grimoire_codex_flow_test';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(database.endsWith('_test'));
assert.equal((await (await fetch(`${base}/api/health`)).json()).database.name, database);
const evidence = path.join(root, '.local', 'research-timeout', String(Date.now()));
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
let org, scion, connection, task;
async function api(route, { method = 'GET', data, expected = 200, extra = {} } = {}) {
  const response = await context.request.fetch(`${base}/api${route}`, { method, data, headers: { 'X-Grimoire-CSRF': '1', ...(org ? { 'X-Grimoire-Organization': org } : {}), ...extra } });
  assert.equal(response.status(), expected, `${method} ${route}: ${await response.text()}`);
  return response.json();
}
async function until(check, label) {
  for (let i = 0; i < 40; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error(`Timed out: ${label}`);
}
async function capture(name) { await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled' }); }
try {
  const stamp = randomUUID().slice(0, 8);
  await api('/session/signup', { method: 'POST', expected: 201, data: { login_name: `research-timeout-${stamp}`, display_name: 'Timeout Test Handler', passphrase: `Disposable-only-${randomUUID()}` } });
  org = (await api('/organizations', { method: 'POST', expected: 201, data: { name: `Research timeout ${stamp}` }, extra: { 'Idempotency-Key': randomUUID() } })).active_organization.org_id;
  const agent = await api('/agents', { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID() }, data: { name: 'Two-minute researcher', role: 'researcher', title: 'Protocol-only test agent', capabilities: 'UI timeout verification only.', instructions: 'This is a disposable protocol fixture. No execution is authorized by this test.', reports_to: null, adapter: 'codex_cli', timeout_seconds: 120, skill_ids: [], paused: false } });
  scion = await api('/scions', { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID() }, data: { name: `Public research timeout fixture ${stamp}`, product_category: 'digital', product_description: 'Invented fixture for a browser timeout regression.', decision: 'Check the selected agent time limit.', requirements: ['Preserve the configured task timeout.'], questions: [], change_summary: 'Disposable browser regression.' } });
  const pairing = await api('/worker-connections/pairings', { method: 'POST', expected: 201, data: { device_name: 'Protocol-only test computer; no model' } });
  await api(`/worker-connections/pairings/${pairing.user_code}/approve`, { method: 'POST', data: { organization_id: org, consent: true, policy_version: 'codex-synthetic-v1' } });
  connection = await api('/worker-connections/pairings/poll', { method: 'POST', data: { device_secret: pairing.device_secret } });
  await page.goto(`${base}/#/scions/${scion.id}/research/new`);
  await page.getByRole('form', { name: 'Public web research' }).waitFor();
  await page.getByLabel('Public research brief', { exact: true }).fill('Public fixture: explain official GOV.UK Contracts Finder guidance. This test verifies task creation only and will cancel before execution.');
  await page.getByLabel('Assigned agent', { exact: true }).selectOption(agent.id);
  assert.match(await page.locator('.research-form-footer').innerText(), /2 minutes/);
  const heartbeat = await fetch(`${base}/api/agent/tasks/next`, { headers: { Authorization: `Bearer ${connection.credential}`, 'X-Grimoire-Worker-Protocol': '2', 'X-Grimoire-Public-Web': '1' } });
  assert.equal(heartbeat.status, 200); assert.equal((await heartbeat.json()).task, null);
  await page.getByLabel('Research computer', { exact: true }).selectOption(connection.connection_id);
  await page.locator('.research-consent input').check();
  await capture('01-selected-agent-two-minute-limit');
  const submitted = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === `/api/scions/${scion.id}/agent-tasks`);
  await page.getByRole('button', { name: 'Start research', exact: true }).click();
  assert.equal((await submitted).postDataJSON().timeout_seconds, 120);
  task = await until(async () => (await api(`/scions/${scion.id}/agent-tasks`)).tasks.find(item => item.status === 'dispatched'), 'native task dispatched without a worker');
  assert.equal(task.timeout_seconds, 120); assert.equal(task.claimed_at, null); assert.equal(task.provider_run_id, null); assert.equal(task.proposal_id, null);
  await until(() => page.url().includes(`/research/${task.id}`), 'focused research task route');
  assert.equal(await page.getByRole('navigation', { name: 'Company navigation' }).getByRole('button', { name: 'Tasks', exact: true }).getAttribute('aria-current'), 'page');
  await capture('02-dispatched-task-tasks-navigation');
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await until(async () => (await api(`/scions/${scion.id}/agent-tasks`)).tasks.find(item => item.id === task.id)?.status === 'cancelled', 'unclaimed task cancelled');
  assert.deepEqual((await api(`/scions/${scion.id}/research`)).reports, []);
  assert.equal(errors.length, 0);
  await capture('03-cancelled-without-execution');
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ status: 'PASS', database, scion_id: scion.id, task_id: task.id, selected_agent_timeout_seconds: 120, submitted_timeout_seconds: 120, stored_timeout_seconds: task.timeout_seconds, tasks_navigation_active: true, cancelled_before_claim: true, model_invoked: false, public_fetches: 0, browser_errors: errors }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', evidence, timeout_seconds: task.timeout_seconds, tasks_navigation_active: true, model_invoked: false }));
} catch (error) {
  await capture('failure').catch(() => {});
  await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ message: error.message, browser_errors: errors, scion_id: scion?.id, task_id: task?.id }, null, 2));
  throw error;
} finally {
  if (scion) for (const pending of (await api(`/scions/${scion.id}/agent-tasks`).catch(() => ({ tasks: [] }))).tasks) if (['queued', 'dispatched', 'running'].includes(pending.status)) await api(`/scions/${scion.id}/agent-tasks/${pending.id}/cancel`, { method: 'POST', data: {} }).catch(() => {});
  if (connection) await api(`/worker-connections/${connection.connection_id}/revoke`, { method: 'POST', data: { organization_id: org } }).catch(() => {});
  await browser.close();
}
