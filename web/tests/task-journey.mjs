import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { saveConnection } from '../../byoa/connection.mjs';
import { childEnvironment } from '../../byoa/bridge.mjs';

// Explicitly opted-in real Codex execution of synthetic briefs only. No provider
// credentials are read by this test and no external research is enabled.
assert.equal(process.env.GRIMOIRE_TEST_DISPOSABLE, '1');
assert.equal(process.env.GRIMOIRE_TEST_LIVE_CODEX, '1', 'This journey invokes the installed, authenticated Codex CLI twice.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.GRIMOIRE_WEB_URL ?? 'http://127.0.0.1:5182';
const database = process.env.GRIMOIRE_TEST_DATABASE ?? 'grimoire_codex_flow_test';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(database.endsWith('_test'));
assert.equal((await (await fetch(`${base}/api/health`)).json()).database.name, database);
const evidence = path.join(root, '.local', 'task-journey', String(Date.now()));
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const errors = [], checks = [], providerRuns = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
const stamp = randomUUID().slice(0, 8);
let org, scion, record, savedPath, bridge, activeTask;
let workerError = '', workerExited = false;
async function api(route, { method = 'GET', data, expected = 200, extra = {} } = {}) {
  const response = await context.request.fetch(`${base}/api${route}`, { method, data, headers: { 'X-Grimoire-CSRF': '1', ...(org ? { 'X-Grimoire-Organization': org } : {}), ...extra } });
  assert.equal(response.status(), expected, `${method} ${route}: ${await response.text()}`);
  return response.json();
}
async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 500)); }
  throw new Error(`Timed out: ${message}`);
}
async function screenshot(name) { await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled' }); }
async function waitForResult(taskId) {
  return until(async () => {
    const task = (await api(`/scions/${scion.id}/agent-tasks`)).tasks.find(item => item.id === taskId);
    if (task?.status === 'failed' || task?.status === 'cancelled') throw new Error(`Actual Codex task ${task.status}: ${task.failure_code}`);
    if (workerExited && task?.status !== 'completed') throw new Error('Worker exited before completing the task.');
    return task?.status === 'completed' ? task : false;
  }, 'actual Codex result', 330000);
}
try {
  await api('/session/signup', { method: 'POST', expected: 201, data: { login_name: `journey-${stamp}`, display_name: 'Synthetic Journey Handler', passphrase: `Synthetic-only-${randomUUID()}` } });
  org = (await api('/organizations', { method: 'POST', expected: 201, data: { name: `Synthetic Task Journey ${stamp}` }, extra: { 'Idempotency-Key': randomUUID() } })).active_organization.org_id;
  const agent = await api('/agents', { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID() }, data: { name: 'Planning agent', role: 'planner', title: 'Product planning', capabilities: 'Prepare bounded capability hypotheses from the synthetic brief.', instructions: 'Use only the supplied brief. List missing evidence. Never select vendors or claim approval.', reports_to: null, adapter: 'codex_cli', timeout_seconds: 300, skill_ids: [], paused: false } });
  const pairing = await api('/worker-connections/pairings', { method: 'POST', expected: 201, data: { device_name: 'Synthetic journey Codex worker' } });
  await api(`/worker-connections/pairings/${pairing.user_code}/approve`, { method: 'POST', data: { organization_id: org, consent: true, policy_version: 'codex-synthetic-v1' } });
  const enrolled = await api('/worker-connections/pairings/poll', { method: 'POST', data: { device_secret: pairing.device_secret } });
  record = { version: 1, api_origin: base, connection_id: enrolled.connection_id, organization_id: enrolled.organization_id, organization_name: enrolled.organization_name, credential: enrolled.credential, adapter: enrolled.adapter, policy_version: enrolled.policy_version, content_class: enrolled.content_class, enrolled_at: new Date().toISOString() };
  savedPath = await saveConnection(record);
  bridge = spawn(process.execPath, [path.join(root, 'byoa/bridge.mjs'), '--connection', record.connection_id, '--watch'], { cwd: root, env: childEnvironment(process.env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  bridge.on('close', () => { workerExited = true; });
  bridge.stdout.on('data', () => {});
  bridge.stderr.on('data', bytes => { workerError = (workerError + bytes.toString()).slice(-4000); });
  await page.goto(`${base}/#/new`);
  await page.locator('#name').fill(`Clayhouse synthetic journey ${stamp}`);
  await page.locator('#category').selectOption('digital');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.locator('#description').fill('A synthetic workshop website. Visitors browse pottery classes, request a place, and contact the organizer. The organizer edits the schedule without coding.');
  await page.locator('#decision').fill('Which capabilities and evidence are needed before selecting service providers?');
  await page.getByText('Requirements and questions', { exact: false }).first().click();
  await page.locator('#requirements').fill('Visitors request class places.\nOrganizer edits class descriptions and schedules.');
  await page.locator('#questions').fill('Who confirms booking requests?');
  await page.locator('.scion-create-actions').getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Create Scion', exact: true }).click();
  await page.getByRole('region', { name: 'Scion tasks', exact: true }).waitFor();
  scion = (await api('/workspace')).scions[0];
  checks.push('Scion created through browser and opens on Tasks'); console.log(checks.at(-1));
  await page.locator('.task-empty').getByRole('button', { name: 'Start planning', exact: true }).click();
  await page.locator('#task-agent').selectOption(agent.id);
  await page.locator('.task-consent input').check();
  await page.locator('.task-composer').getByRole('button', { name: 'Start planning', exact: true }).click();
  activeTask = await until(async () => (await api(`/scions/${scion.id}/agent-tasks`)).tasks[0], 'saved planning task');
  await screenshot('01-planning'); console.log('Waiting for first actual Codex result');
  const first = await waitForResult(activeTask.id); assert.ok(first.provider_run_id); providerRuns.push(first.provider_run_id);
  await until(() => page.locator('.task-detail .task-status').textContent().then(text => text.includes('Needs input')), 'question is next action');
  await screenshot('02-needs-input');
  const before = await api(`/scions/${scion.id}/capabilities`); assert.equal(before.plans[0].reviews.length, 0);
  assert.equal((await api(`/scions/${scion.id}/control-surface`)).approval_available, false);
  checks.push('Actual Codex result becomes Needs input; agent completion creates no review or approval'); console.log(checks.at(-1));
  await page.locator('.task-detail-heading').getByRole('button', { name: 'Answer questions', exact: true }).click();
  await page.locator('#task-answer-0').fill('The workshop organizer confirms every booking manually by email. Online payments are outside this synthetic first version.');
  await page.getByRole('button', { name: 'Save answers', exact: true }).click();
  await until(async () => (await api(`/scions/${scion.id}`)).current_revision === 2, 'revision 2 saved');
  const oldPlan = (await api(`/scions/${scion.id}/capabilities`)).plans.find(plan => plan.id === first.proposal_id);
  assert.equal(oldPlan.status, 'stale'); assert.equal(oldPlan.input, null);
  await page.getByText('This task uses older inputs', { exact: true }).waitFor();
  await screenshot('03-stale-after-answer');
  checks.push('Handler answer saved by revision API; old plan becomes stale and hidden'); console.log(checks.at(-1));
  await page.locator('.task-detail-heading').getByRole('button', { name: 'Resolve blocker', exact: true }).click();
  await page.locator('.task-consent input').check();
  await page.locator('.task-composer').getByRole('button', { name: 'Start planning', exact: true }).click();
  activeTask = await until(async () => (await api(`/scions/${scion.id}/agent-tasks`)).tasks.find(task => task.scion_revision === 2), 'replacement planning task');
  assert.notEqual(activeTask.id, first.id); console.log('Waiting for replacement actual Codex result');
  const second = await waitForResult(activeTask.id); assert.ok(second.provider_run_id); providerRuns.push(second.provider_run_id);
  await page.locator('.task-detail-heading').getByRole('button', { name: 'Review result', exact: true }).click();
  await page.locator('#task-review-note').fill('Reviewed the synthetic capability hypotheses against the updated brief. External provider research and evidence verification remain unavailable; this records review only.');
  await page.getByRole('button', { name: 'Record review', exact: true }).click();
  await until(() => page.locator('.task-detail .task-status').textContent().then(text => text.includes('Completed')), 'Handler reviewed task completed');
  const current = (await api(`/scions/${scion.id}/capabilities`)).plans.find(plan => plan.id === second.proposal_id);
  assert.equal(current.reviews.length, 1); assert.equal(current.status, 'current');
  assert.equal((await api(`/scions/${scion.id}/control-surface`)).approval_available, false);
  await screenshot('04-reviewed-result');
  await page.reload(); await until(() => page.locator('.task-detail .task-status').textContent().then(text => text.includes('Completed')), 'persisted review after browser reload');
  checks.push('Replacement actual Codex result reviewed by Handler; one persisted receipt, no approval'); console.log(checks.at(-1));
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('05-mobile-reviewed-result');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'No horizontal overflow on mobile');
  assert.equal(errors.length, 0);
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ status: 'PASS', database, checks, provider_runs: providerRuns, scion_id: scion.id, task_ids: [first.id, second.id], model_invoked: true, approval_granted: false, browser_errors: errors }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', evidence, checks: checks.length, actual_codex_runs: providerRuns.length }));
} catch (error) {
  await screenshot('failure').catch(() => {});
  await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ message: error.message, checks, browser_errors: errors, scion_id: scion?.id, task_id: activeTask?.id, worker_diagnostic: workerError.replaceAll(record?.credential ?? '___never___', '[redacted]') }, null, 2));
  throw error;
} finally {
  if (activeTask && scion) await api(`/scions/${scion.id}/agent-tasks/${activeTask.id}/cancel`, { method: 'POST', data: {} }).catch(() => {});
  if (record) await api(`/worker-connections/${record.connection_id}/revoke`, { method: 'POST', data: { organization_id: org } }).catch(() => {});
  if (bridge && !workerExited) { await new Promise(resolve => setTimeout(resolve, 2000)); bridge.kill(); }
  if (savedPath) await unlink(savedPath).catch(() => {});
  await browser.close();
}
