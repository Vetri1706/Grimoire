import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { saveConnection } from '../../byoa/connection.mjs';
import { childEnvironment } from '../../byoa/bridge.mjs';

// Explicit opt-in: one real provider task using only an invented public brief.
// No model/provider output, source bytes, token or worker credential is printed.
assert.equal(process.env.GRIMOIRE_TEST_DISPOSABLE, '1');
assert.equal(process.env.GRIMOIRE_TEST_LIVE_CODEX, '1', 'This journey invokes the installed authenticated Codex CLI once.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.GRIMOIRE_WEB_URL ?? 'http://127.0.0.1:5182';
const database = process.env.GRIMOIRE_TEST_DATABASE ?? 'grimoire_codex_flow_test';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(database.endsWith('_test'));
assert.equal((await (await fetch(`${base}/api/health`)).json()).database.name, database);
const evidence = path.join(root, '.local', 'research-journey', String(Date.now()));
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(25000);
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.type() === 'prompt' ? dialog.accept('Disposable verification: source permission withdrawn while the report is open.') : dialog.accept());
const stamp = randomUUID().slice(0, 8);
let org, scion, record, savedPath, bridge, activeTask, report;
let workerError = '', workerExited = false;
async function api(route, { method = 'GET', data, expected = 200, extra = {}, client = context, organization = org } = {}) {
  const response = await client.request.fetch(`${base}/api${route}`, { method, data, headers: { 'X-Grimoire-CSRF': '1', ...(organization ? { 'X-Grimoire-Organization': organization } : {}), ...extra } });
  assert.equal(response.status(), expected, `${method} ${route}: ${await response.text()}`);
  return response.json();
}
async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 500)); }
  throw new Error(`Timed out: ${message}`);
}
async function screenshot(name) { await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled' }); }
const checked = message => { checks.push(message); console.log(message); };
const researchState = () => api(`/scions/${scion.id}/research`);
function startWorker() {
  workerExited = false;
  bridge = spawn(process.execPath, [path.join(root, 'byoa/bridge.mjs'), '--connection', record.connection_id, '--watch'], { cwd: root, env: childEnvironment(process.env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  bridge.on('close', () => { workerExited = true; }); bridge.stdout.on('data', () => {});
  bridge.stderr.on('data', bytes => { workerError = (workerError + bytes.toString()).slice(-4000); });
}
try {
  await api('/session/signup', { method: 'POST', expected: 201, data: { login_name: `research-${stamp}`, display_name: 'Public Research Test Handler', passphrase: `Disposable-only-${randomUUID()}` } });
  org = (await api('/organizations', { method: 'POST', expected: 201, data: { name: `Public Research Journey ${stamp}` }, extra: { 'Idempotency-Key': randomUUID() } })).active_organization.org_id;
  const researchInstructions = await readFile(path.join(root, 'skills/product-planning/grimoire-public-research/SKILL.md'), 'utf8');
  const agent = await api('/agents', { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID() }, data: { name: 'Public procurement researcher', role: 'researcher', title: 'Public procurement research', capabilities: 'Research explicitly selected public procurement questions and preserve source attribution.', instructions: researchInstructions, reports_to: null, adapter: 'codex_cli', timeout_seconds: 300, skill_ids: [], paused: false } });
  scion = await api('/scions', { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID() }, data: { name: `Public procurement workflow ${stamp}`, product_category: 'digital', product_description: 'Invented test project for a public procurement information website. No real procurement is planned.', decision: 'Understand the official public process before any supplier selection.', requirements: ['Use official public procurement guidance.'], questions: [], change_summary: 'Disposable live public research verification.' } });
  const pairing = await api('/worker-connections/pairings', { method: 'POST', expected: 201, data: { device_name: `Public research test computer ${stamp}` } });
  await api(`/worker-connections/pairings/${pairing.user_code}/approve`, { method: 'POST', data: { organization_id: org, consent: true, policy_version: 'codex-synthetic-v1' } });
  const enrolled = await api('/worker-connections/pairings/poll', { method: 'POST', data: { device_secret: pairing.device_secret } });
  record = { version: 1, api_origin: base, connection_id: enrolled.connection_id, organization_id: enrolled.organization_id, organization_name: enrolled.organization_name, credential: enrolled.credential, adapter: enrolled.adapter, policy_version: enrolled.policy_version, content_class: enrolled.content_class, enrolled_at: new Date().toISOString() };
  savedPath = await saveConnection(record); startWorker();
  await until(async () => (await researchState()).worker_connections.some(item => item.connection_id === record.connection_id && item.research_capable && item.status === 'connected'), 'research-capable worker heartbeat');
  const candidate = { synthetic: false, objective: 'Public test brief: understand GOV.UK Contracts Finder. No real supplier selection or purchase is authorized.', consent: true, policy_version: 'public-web-research-v1', worker_connection_id: record.connection_id };
  const queuedBody = { task_kind: 'research_public_web', candidate_proposal: candidate, agent_id: agent.id, timeout_seconds: 300 };
  const idempotency = randomUUID();
  const cancelled = await api(`/scions/${scion.id}/agent-tasks`, { method: 'POST', expected: 201, extra: { 'Idempotency-Key': idempotency, 'If-Match': '"1"' }, data: queuedBody });
  const replay = await api(`/scions/${scion.id}/agent-tasks`, { method: 'POST', expected: 201, extra: { 'Idempotency-Key': idempotency, 'If-Match': '"1"' }, data: queuedBody });
  assert.equal(replay.id, cancelled.id);
  await api(`/scions/${scion.id}/agent-tasks/${cancelled.id}/cancel`, { method: 'POST', data: {} });
  assert.equal((await api(`/scions/${scion.id}/agent-tasks`)).tasks.find(task => task.id === cancelled.id).status, 'cancelled');
  checked('A retried task request reuses one native task; cancelling queued research starts no provider work.');
  await page.goto(`${base}/#/scions/${scion.id}/research/new`);
  await page.getByRole('form', { name: 'Public web research' }).waitFor();
  await page.getByLabel('Public research brief', { exact: true }).fill('For an invented UK supplier considering public-sector contracts, research the official GOV.UK Contracts Finder workflow: finding suitable opportunities, where notices are published, and what a supplier should verify before responding. Use only official gov.uk public guidance, at most 2 search queries and 2 source pages. Return 3 concise supported process steps, no supplier or product candidates, and explicit unresolved gaps. Do not submit a bid, create an account, contact anyone, or make a purchase.');
  await page.getByLabel(/^Assigned agent/).selectOption(agent.id);
  await page.getByLabel(/^Research computer/).selectOption(record.connection_id);
  assert.equal(await page.getByRole('button', { name: 'Start research', exact: true }).isEnabled(), false);
  await page.locator('.research-consent input').check();
  await screenshot('01-explicit-public-consent');
  await page.getByRole('button', { name: 'Start research', exact: true }).click();
  activeTask = await until(async () => (await api(`/scions/${scion.id}/agent-tasks`)).tasks.find(task => task.id !== cancelled.id), 'saved browser research task');
  checked('Browser collects explicit public-brief, agent and computer consent and dispatches the saved native task.');
  console.log('Waiting for one actual Codex public research task and server captures.');
  activeTask = await until(async () => {
    const task = (await api(`/scions/${scion.id}/agent-tasks`)).tasks.find(item => item.id === activeTask.id);
    if (['failed', 'cancelled'].includes(task?.status)) throw new Error(`Actual research task ${task.status}: ${task.failure_code}`);
    if (workerExited && task?.status !== 'completed') throw new Error('Research worker exited before completing its task.');
    return task?.status === 'completed' ? task : false;
  }, 'actual research task completion', 330000);
  assert.ok(activeTask.provider_run_id); assert.match(activeTask.output_sha256, /^[a-f0-9]{64}$/);
  report = (await researchState()).reports.find(item => item.id === activeTask.proposal_id);
  assert.ok(report?.input); assert.equal(report.agent_task_id, activeTask.id); assert.equal(report.status, 'current'); assert.equal(report.reviews.length, 0);
  assert.ok(report.input.queries.length >= 1 && report.input.queries.length <= 5);
  assert.ok(report.input.sources.length >= 1 && report.input.sources.length <= 8);
  const captured = report.captures.filter(item => item.status === 'captured');
  assert.ok(captured.length >= 1, 'At least one real public source must be fetched successfully.');
  for (const capture of captured) { assert.match(capture.content_sha256, /^[a-f0-9]{64}$/); assert.ok(capture.excerpt?.length); assert.ok(capture.byte_length > 0); assert.ok(new URL(capture.final_url).hostname.endsWith('gov.uk')); }
  assert.equal((await api(`/scions/${scion.id}/control-surface`)).approval_available, false);
  await page.getByRole('heading', { name: 'Research report', exact: true }).waitFor();
  await screenshot('02-real-research-report');
  checked('One actual Codex run produced a native completed task, observed query provenance and real server-captured public source hashes; no review or approval was created.');
  await page.getByLabel('Review note', { exact: true }).fill('Reviewed the public guidance and recorded capture receipts. Supplier suitability, current opportunity terms and procurement approval require separate human decisions.');
  // The server commits a real review, but its response is deliberately lost.
  // Retrying must recover the same receipt without a second review or approval.
  let lostReviewResponse = false;
  await page.route('**/research-reports/*/reviews', async route => {
    if (route.request().method() === 'POST' && !lostReviewResponse) { lostReviewResponse = true; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Record review', exact: true }).click();
  await page.getByRole('button', { name: 'Retry saved review', exact: true }).click();
  await page.unroute('**/research-reports/*/reviews');
  await until(async () => (await researchState()).reports.find(item => item.id === report.id)?.reviews.length === 1, 'persisted Handler review');
  assert.equal((await api(`/scions/${scion.id}/control-surface`)).approval_available, false);
  await screenshot('03-human-review');
  await page.reload(); await page.getByRole('heading', { name: 'Research report', exact: true }).waitFor();
  assert.equal(await page.locator('.research-review-receipt').count(), 1);
  checked('A lost review response retries to one persisted receipt; Handler review survives reload and remains separate from procurement approval.');
  const foreign = await browser.newContext();
  try {
    await api('/session/signup', { method: 'POST', expected: 201, client: foreign, organization: null, data: { login_name: `foreign-research-${stamp}`, display_name: 'Foreign Test Handler', passphrase: `Disposable-only-${randomUUID()}` } });
    const otherOrg = (await api('/organizations', { method: 'POST', expected: 201, client: foreign, organization: null, data: { name: `Foreign Research ${stamp}` }, extra: { 'Idempotency-Key': randomUUID() } })).active_organization.org_id;
    for (const route of [`/scions/${scion.id}/research`, `/scions/${scion.id}/agent-tasks`, `/scions/${scion.id}/control-surface`]) await api(route, { expected: 404, client: foreign, organization: otherOrg });
    await api(`/scions/${scion.id}/research-captures/${captured[0].id}/revoke`, { method: 'POST', expected: 404, client: foreign, organization: otherOrg, data: { reason: 'Cross-organization denial test.' } });
  } finally { await foreign.close(); }
  checked('Foreign organization cannot read tasks, graph or research alerts/content, or revoke the captured source.');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('04-mobile-research');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'No mobile horizontal overflow.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const capturedRow = page.locator('.research-capture').filter({ hasText: captured[0].final_url });
  await capturedRow.locator('summary').click();
  await capturedRow.getByRole('button', { name: 'Withdraw source', exact: true }).click();
  await until(async () => (await researchState()).reports.find(item => item.id === report.id)?.status === 'blocked', 'source revocation blocks research');
  const blocked = (await researchState()).reports.find(item => item.id === report.id);
  assert.equal(blocked.input, null);
  const withdrawn = blocked.captures.find(item => item.id === captured[0].id);
  assert.equal(withdrawn.status, 'revoked'); assert.equal(withdrawn.excerpt, null); assert.equal(withdrawn.content_sha256, null); assert.equal(withdrawn.url, null);
  await until(() => page.locator('.research-result').count().then(count => count === 0), 'open view hides dependent report content');
  assert.equal(await page.getByRole('button', { name: 'Record review', exact: true }).count(), 0);
  await screenshot('05-source-withdrawal-blocks');
  await page.reload(); await page.getByText('Source access has changed. This report is hidden until replacement research is available.', { exact: true }).waitFor();
  checked('Source withdrawal hides captured bytes and dependent report in the already-open browser, blocks new review, and survives reload.');
  assert.equal(errors.length, 0);
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ status: 'PASS', database, checks, scion_id: scion.id, task_id: activeTask.id, provider_run_id: activeTask.provider_run_id, report_id: report.id, captured_sources: captured.map(item => ({ id: item.id, url: item.final_url, content_sha256: item.content_sha256, byte_length: item.byte_length })), actual_codex_runs: 1, approval_granted: false, browser_errors: errors }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', evidence, checks: checks.length, actual_codex_runs: 1 }));
} catch (error) {
  await screenshot('failure').catch(() => {});
  await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ message: error.message, checks, browser_errors: errors, scion_id: scion?.id, task_id: activeTask?.id, worker_diagnostic: workerError.replaceAll(record?.credential ?? '___never___', '[redacted]') }, null, 2));
  throw error;
} finally {
  if (scion) for (const task of (await api(`/scions/${scion.id}/agent-tasks`).catch(() => ({ tasks: [] }))).tasks) if (['queued', 'dispatched', 'running'].includes(task.status)) await api(`/scions/${scion.id}/agent-tasks/${task.id}/cancel`, { method: 'POST', data: {} }).catch(() => {});
  if (record) await api(`/worker-connections/${record.connection_id}/revoke`, { method: 'POST', data: { organization_id: org } }).catch(() => {});
  if (bridge && !workerExited) { await new Promise(resolve => setTimeout(resolve, 2000)); bridge.kill(); }
  if (savedPath) await unlink(savedPath).catch(() => {});
  await browser.close();
}
