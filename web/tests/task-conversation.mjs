import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { saveConnection } from '../../byoa/connection.mjs';
import { childEnvironment } from '../../byoa/bridge.mjs';
import { workerProtocolHeaders } from '../../byoa/conversation.mjs';

// One real installed Codex invocation, only after an explicitly opted-in test.
// The original task is cancelled without execution. Notes and receipt retries
// use the real API/database; only the first POST response is deliberately lost.
assert.equal(process.env.GRIMOIRE_TEST_DISPOSABLE, '1');
assert.equal(process.env.GRIMOIRE_TEST_LIVE_CODEX, '1');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.GRIMOIRE_WEB_URL ?? 'http://127.0.0.1:5182';
const database = process.env.GRIMOIRE_TEST_DATABASE ?? 'grimoire_codex_flow_test';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(database.endsWith('_test'));
assert.equal((await (await fetch(`${base}/api/health`)).json()).database.name, database);
const evidence = path.join(root, '.local', 'task-conversation', String(Date.now()));
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
let org, scion, record, savedPath, bridge, original, followup, source;
let workerError = '', workerExited = false;
async function api(route, { method = 'GET', data, expected = 200, extra = {} } = {}) {
  const response = await context.request.fetch(`${base}/api${route}`, { method, data, headers: { 'X-Grimoire-CSRF': '1', ...(org ? { 'X-Grimoire-Organization': org } : {}), ...extra } });
  assert.equal(response.status(), expected, `${method} ${route}: ${await response.text()}`);
  return response.json();
}
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 400)); }
  throw new Error(`Timed out: ${label}`);
}
const capture = name => page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled' });
const conversationPath = () => `/scions/${scion.id}/agent-tasks/${original.id}/conversation`;
const tasks = () => api(`/scions/${scion.id}/agent-tasks`).then(value => value.tasks);
const check = text => { checks.push(text); console.log(text); };
try {
  const stamp = randomUUID().slice(0, 8);
  await api('/session/signup', { method: 'POST', expected: 201, data: { login_name: `conversation-${stamp}`, display_name: 'Conversation Test Handler', passphrase: `Disposable-only-${randomUUID()}` } });
  org = (await api('/organizations', { method: 'POST', expected: 201, data: { name: `Synthetic conversation ${stamp}` }, extra: { 'Idempotency-Key': randomUUID() } })).active_organization.org_id;
  const agent = await api('/agents', { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID() }, data: { name: 'Conversation planner', role: 'planner', title: 'Synthetic capability planning', capabilities: 'Respond to explicit Handler follow-up requests with a bounded capability plan.', instructions: 'Use only the supplied synthetic brief and explicit follow-up. Preserve missing evidence and all mandatory gaps. Never claim source verification or approval.', reports_to: null, adapter: 'codex_cli', timeout_seconds: 300, skill_ids: [], paused: false } });
  scion = await api('/scions', { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID() }, data: { name: `Synthetic conversation workshop ${stamp}`, product_category: 'digital', product_description: 'A synthetic pottery workshop website. Visitors browse classes and request places; the organizer confirms requests manually.', decision: 'Identify capabilities and missing evidence before service selection.', requirements: ['Support visitor class requests.'], questions: [], change_summary: 'Disposable conversation journey.' } });
  source = await api(`/scions/${scion.id}/sources`, { method: 'POST', expected: 201, extra: { 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, data: { title: `Synthetic conversation source ${stamp}`, origin: `synthetic://conversation/${stamp}`, owner: 'Synthetic Handler', synthetic: true, source_text: 'Synthetic workshop facts authored for a disposable test. Visitors request a place; the organizer checks availability. No independent supplier evidence.', rights_status: 'granted', permission_basis: 'Original synthetic fixture text.', permitted_use: 'scion_review', change_summary: 'Source before task snapshot.' } });
  original = await api(`/scions/${scion.id}/agent-tasks`, { method: 'POST', expected: 201, extra: { 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, data: { task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, agent_id: agent.id, timeout_seconds: 300 } });
  await api(`/scions/${scion.id}/agent-tasks/${original.id}/cancel`, { method: 'POST', data: {} });
  const pairing = await api('/worker-connections/pairings', { method: 'POST', expected: 201, data: { device_name: 'Disposable conversation Codex worker' } });
  await api(`/worker-connections/pairings/${pairing.user_code}/approve`, { method: 'POST', data: { organization_id: org, consent: true, policy_version: 'codex-synthetic-v1' } });
  const enrolled = await api('/worker-connections/pairings/poll', { method: 'POST', data: { device_secret: pairing.device_secret } });
  record = { version: 1, api_origin: base, connection_id: enrolled.connection_id, organization_id: enrolled.organization_id, organization_name: enrolled.organization_name, credential: enrolled.credential, adapter: enrolled.adapter, policy_version: enrolled.policy_version, content_class: enrolled.content_class, enrolled_at: new Date().toISOString() };
  const heartbeat = await fetch(`${base}/api/agent/tasks/next`, { headers: { Authorization: `Bearer ${record.credential}`, ...workerProtocolHeaders() } });
  assert.equal(heartbeat.status, 200); assert.equal((await heartbeat.json()).task, null);
  await page.goto(`${base}/#/scions/${scion.id}/tasks/${original.id}`);
  const form = () => page.getByRole('form', { name: 'Message task', exact: true });
  await form().waitFor();
  await form().getByLabel('Message action', { exact: true }).selectOption('note');
  const note = `Handler note ${stamp}: keep the scope synthetic; this note starts no work.`;
  await form().getByLabel('Message', { exact: true }).fill(note);
  await form().getByRole('button', { name: 'Add note', exact: true }).click();
  await page.getByText(note, { exact: true }).waitFor();
  assert.equal((await tasks()).length, 1);
  assert.equal((await api(conversationPath())).messages.length, 1);
  await page.reload(); await page.getByText(note, { exact: true }).waitFor();
  check('A browser note persists after reload and creates no task or provider execution.');

  await form().getByLabel('Message action', { exact: true }).selectOption('follow_up');
  await form().getByLabel('Agent', { exact: true }).selectOption(agent.id);
  const requestText = 'Refine the synthetic plan to support morning-only class requests. Include a capability with key morning_only_requests and title Morning-only class requests. In your preparation_note include the exact marker COBALT_WINDOW and explain the requested change. This is a hypothesis for human review, not approved requirements.';
  await form().getByLabel('Message', { exact: true }).fill(requestText);
  let receipt, firstRequest, routeFailure, dropped = false;
  const postPattern = `**/api/scions/${scion.id}/agent-tasks/${original.id}/messages`;
  await page.route(postPattern, async route => {
    if (route.request().method() !== 'POST' || dropped) return route.continue();
    dropped = true; firstRequest = { body: route.request().postData(), key: route.request().headers()['idempotency-key'] };
    try {
      const response = await route.fetch(); assert.equal(response.status(), 201, await response.text()); receipt = await response.json();
    } catch (failure) { routeFailure = failure; }
    await route.abort('failed').catch(() => {});
  });
  await form().getByRole('button', { name: 'Send message', exact: true }).click();
  await form().getByRole('button', { name: 'Retry message', exact: true }).waitFor();
  if (routeFailure) throw routeFailure;
  assert.equal(await form().getByLabel('Message', { exact: true }).inputValue(), requestText);
  assert.ok(receipt.task_id); assert.equal((await tasks()).length, 2);
  await capture('01-lost-receipt-draft-retained');
  const replayRequest = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith(`/agent-tasks/${original.id}/messages`));
  await form().getByRole('button', { name: 'Retry message', exact: true }).click();
  const replay = await replayRequest;
  assert.equal(replay.postData(), firstRequest.body); assert.equal(replay.headers()['idempotency-key'], firstRequest.key);
  await until(() => page.url().endsWith(`/tasks/${receipt.task_id}`), 'follow-up route');
  await page.unroute(postPattern);
  followup = (await tasks()).find(task => task.id === receipt.task_id);
  assert.equal(followup.status, 'dispatched'); assert.equal((await tasks()).length, 2);
  const recorded = await api(conversationPath());
  assert.equal(recorded.messages.length, 2); assert.equal(recorded.messages.filter(item => item.body === requestText).length, 1);
  check('Lost message response retries the same key/body and recovers one message and one dispatched native task.');
  const oldWorker = await fetch(`${base}/api/agent/tasks/next`, { headers: { Authorization: `Bearer ${record.credential}`, 'X-Grimoire-Worker-Protocol': '2', 'X-Grimoire-Public-Web': '1' } });
  assert.equal(oldWorker.status, 200); assert.equal((await oldWorker.json()).task, null);
  const unsupportedClaim = await fetch(`${base}/api/agent/tasks/${followup.id}/claim`, { method: 'POST', headers: { Authorization: `Bearer ${record.credential}`, 'X-Grimoire-Worker-Protocol': '2', 'Content-Type': 'application/json' }, body: '{}' });
  assert.ok([403, 409].includes(unsupportedClaim.status));
  assert.equal((await tasks()).find(task => task.id === followup.id).status, 'dispatched');
  check('A legacy worker cannot discover or claim message-bound follow-up work.');

  savedPath = await saveConnection(record);
  bridge = spawn(process.execPath, [path.join(root, 'byoa/bridge.mjs'), '--connection', record.connection_id, '--watch'], { cwd: root, env: childEnvironment(process.env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  bridge.on('close', () => { workerExited = true; }); bridge.stdout.on('data', () => {}); bridge.stderr.on('data', bytes => { workerError = (workerError + bytes.toString()).slice(-4000); });
  console.log('Waiting for one actual Codex follow-up result.');
  followup = await until(async () => {
    const task = (await tasks()).find(item => item.id === receipt.task_id);
    if (['failed', 'cancelled'].includes(task.status)) throw new Error(`Actual follow-up ${task.status}: ${task.failure_code}`);
    if (workerExited && task.status !== 'completed') throw new Error('Worker exited before the actual follow-up result.');
    return task.status === 'completed' && task;
  }, 'one actual Codex follow-up', 330000);
  assert.ok(followup.provider_run_id); assert.ok(followup.proposal_id);
  const completedConversation = await api(conversationPath());
  const reply = completedConversation.responses.find(item => item.task_id === followup.id);
  assert.equal(reply.content_hidden, false); assert.equal(reply.proposal_id, followup.proposal_id);
  assert.match(reply.preparation_note, /COBALT_WINDOW/); assert.ok(Buffer.byteLength(reply.preparation_note, 'utf8') <= 2000);
  const plan = (await api(`/scions/${scion.id}/capabilities`)).plans.find(item => item.id === followup.proposal_id);
  assert.ok(plan.input.capabilities.some(item => item.key === 'morning_only_requests'));
  assert.equal(plan.reviews.length, 0); assert.equal((await api(`/scions/${scion.id}/control-surface`)).approval_available, false);
  await page.getByText(reply.preparation_note, { exact: true }).waitFor();
  await capture('02-real-agent-reply-and-deliverable');
  await page.reload(); await page.getByText(reply.preparation_note, { exact: true }).waitFor();
  assert.equal((await tasks()).filter(task => task.provider_run_id).length, 1);
  check('One actual Codex run reflects the Handler request in its persisted reply and typed deliverable; no review or approval is fabricated.');

  const outsider = await browser.newContext();
  let outsiderOrg;
  const outsiderApi = async (route, method = 'GET', data) => outsider.request.fetch(`${base}/api${route}`, { method, data, headers: { 'X-Grimoire-CSRF': '1', ...(outsiderOrg ? { 'X-Grimoire-Organization': outsiderOrg } : {}), ...(method === 'POST' ? { 'If-Match': '"1"', 'Idempotency-Key': randomUUID() } : {}) } });
  assert.equal((await outsiderApi('/session/signup', 'POST', { login_name: `outsider-conversation-${stamp}`, display_name: 'Other organization Handler', passphrase: `Disposable-${randomUUID()}` })).status(), 201);
  const outsiderCreated = await outsiderApi('/organizations', 'POST', { name: `Other conversation organization ${stamp}` });
  assert.equal(outsiderCreated.status(), 201); outsiderOrg = (await outsiderCreated.json()).active_organization.org_id;
  assert.ok([403, 404].includes((await outsiderApi(conversationPath())).status()));
  assert.ok([403, 404].includes((await outsiderApi(`/scions/${scion.id}/agent-tasks/${followup.id}/messages`, 'POST', { body: 'Foreign note', intent: 'note' })).status()));
  await outsider.close();
  check('Another Handler cannot read or write this organization task conversation.');

  await page.setViewportSize({ width: 390, height: 844 });
  await capture('03-mobile-task-conversation');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await api(`/scions/${scion.id}/sources/${source.source_id}/revoke`, { method: 'POST', expected: 201, extra: { 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, data: { reason: 'Synthetic source permission withdrawn during open task conversation.' } });
  const revokedConversation = await api(conversationPath());
  const withheld = revokedConversation.responses.find(item => item.task_id === followup.id);
  assert.equal(withheld.content_hidden, true); assert.equal(withheld.preparation_note, null); assert.equal(withheld.proposal_id, null);
  assert.equal(revokedConversation.follow_up_available, false);
  await until(() => page.getByText(reply.preparation_note, { exact: true }).count().then(count => count === 0), 'open reply hidden after source withdrawal');
  await page.reload(); await page.getByText('This result is hidden because its inputs are stale, blocked, or unavailable.', { exact: true }).waitFor();
  await capture('04-source-withdrawal-redacts-reply');
  check('Source withdrawal hides derived replies and deliverable references on the original thread and open page, including after reload.');
  assert.equal(errors.length, 0);
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ status: 'PASS', database, checks, scion_id: scion.id, task_ids: [original.id, followup.id], thread_task_id: completedConversation.thread_task_id, message_ids: completedConversation.messages.map(item => item.id), provider_run_id: followup.provider_run_id, proposal_id: followup.proposal_id, actual_codex_runs: 1, approval_granted: false, source_revoked: true, browser_errors: errors }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', evidence, checks: checks.length, actual_codex_runs: 1 }));
} catch (error) {
  await capture('failure').catch(() => {});
  await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ message: error.message, checks, browser_errors: errors, scion_id: scion?.id, task_ids: [original?.id, followup?.id], worker_diagnostic: workerError.replaceAll(record?.credential ?? '___never___', '[redacted]') }, null, 2));
  throw error;
} finally {
  if (scion) for (const pending of await tasks().catch(() => [])) if (['queued', 'dispatched', 'running'].includes(pending.status)) await api(`/scions/${scion.id}/agent-tasks/${pending.id}/cancel`, { method: 'POST', data: {} }).catch(() => {});
  if (record) await api(`/worker-connections/${record.connection_id}/revoke`, { method: 'POST', data: { organization_id: org } }).catch(() => {});
  if (bridge && !workerExited) { await new Promise(resolve => setTimeout(resolve, 2000)); bridge.kill(); }
  if (savedPath) await unlink(savedPath).catch(() => {});
  await browser.close();
}
