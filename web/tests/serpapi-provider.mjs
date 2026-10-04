import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Protocol-only fixture: no worker process, provider call, or public fetch.
// Every dispatched task is cancelled before any claim can occur.
assert.equal(process.env.GRIMOIRE_TEST_DISPOSABLE, '1');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.GRIMOIRE_WEB_URL ?? 'http://127.0.0.1:5182';
const database = process.env.GRIMOIRE_TEST_DATABASE ?? 'grimoire_codex_flow_test';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(database.endsWith('_test'));
assert.equal((await (await fetch(`${base}/api/health`)).json()).database.name, database);
const evidence = path.join(root, '.local', 'serpapi-ui', String(Date.now()));
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const errors = [], checks = []; let org, scion, connection, mobileGeometry;
page.on('pageerror', error => errors.push(error.message));
async function api(route, { method = 'GET', data, expected = 200, extra = {} } = {}) {
  const response = await context.request.fetch(`${base}/api${route}`, { method, data, headers: { 'X-Grimoire-CSRF': '1', ...(org ? { 'X-Grimoire-Organization': org } : {}), ...extra } });
  assert.equal(response.status(), expected, `${method} ${route}: ${await response.text()}`);
  return response.json();
}
const create = data => ({ method: 'POST', expected: 201, data, extra: { 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' } });
async function until(check, label) {
  for (let i = 0; i < 60; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error(`Timed out: ${label}`);
}
async function heartbeat(serpapi) {
  const response = await fetch(`${base}/api/agent/tasks/next`, { headers: { Authorization: `Bearer ${connection.credential}`, 'X-Grimoire-Worker-Protocol': '2', 'X-Grimoire-Public-Web': '1', 'X-Grimoire-Task-Messages': '1', ...(serpapi ? { 'X-Grimoire-SerpApi': '1' } : {}) } });
  assert.equal(response.status, 200); assert.equal((await response.json()).task, null);
}
const screenshot = name => page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled' });
const checked = message => { checks.push(message); console.log(message); };
try {
  const stamp = randomUUID().slice(0, 8);
  await api('/session/signup', create({ login_name: `serpapi-ui-${stamp}`, display_name: 'SerpApi UI Test Handler', passphrase: `Disposable-only-${randomUUID()}` }));
  org = (await api('/organizations', create({ name: `SerpApi UI ${stamp}` }))).active_organization.org_id;
  const agent = await api('/agents', create({ name: 'Protocol-only researcher', role: 'researcher', title: 'No-model browser fixture', capabilities: 'Provider consent verification only.', instructions: 'This disposable test cancels before any execution.', reports_to: null, adapter: 'codex_cli', timeout_seconds: 120, skill_ids: [], paused: false }));
  scion = await api('/scions', create({ name: `Provider UI fixture ${stamp}`, product_category: 'digital', product_description: 'Invented fixture for testing search provider consent.', decision: 'Check explicit search provider selection.', requirements: ['Keep provider selection through follow-ups.'], questions: [], change_summary: 'Disposable browser regression.' }));
  const pairing = await api('/worker-connections/pairings', create({ device_name: 'Protocol-only test computer; no provider calls' }));
  await api(`/worker-connections/pairings/${pairing.user_code}/approve`, { method: 'POST', data: { organization_id: org, consent: true, policy_version: 'codex-synthetic-v1' } });
  connection = await api('/worker-connections/pairings/poll', { method: 'POST', data: { device_secret: pairing.device_secret } });
  await heartbeat(false);
  await page.goto(`${base}/#/scions/${scion.id}/research/new`);
  const form = page.getByRole('form', { name: 'Public web research', exact: true });
  await form.waitFor();
  await form.getByLabel('Public research brief', { exact: true }).fill('Public fixture: official Contracts Finder guidance. No real research execution is permitted by this test.');
  await form.getByLabel('Assigned agent', { exact: true }).selectOption(agent.id);
  await form.getByLabel('Research computer', { exact: true }).selectOption(connection.connection_id);
  await form.locator('.research-consent input').check();
  assert.equal(await form.getByRole('button', { name: 'Start research', exact: true }).isEnabled(), true);
  await form.getByLabel('Search provider', { exact: true }).selectOption('serpapi');
  assert.equal(await form.locator('.research-consent input').isChecked(), false);
  assert.equal(await form.getByLabel('Research computer', { exact: true }).inputValue(), '');
  assert.equal(await form.getByLabel('Research computer', { exact: true }).locator('option').count(), 1);
  await form.getByText('No SerpApi research worker is ready', { exact: true }).waitFor();
  assert.equal(await form.getByRole('button', { name: 'Start research', exact: true }).isEnabled(), false);
  assert.match(await form.locator('.research-consent').innerText(), /Up to 3 searches.*SerpApi.*credits/);
  await screenshot('01-serpapi-unavailable');
  checked('Changing provider clears consent and computer selection; Codex-only workers cannot authorize SerpApi.');
  await heartbeat(true);
  await form.getByLabel('Research computer', { exact: true }).selectOption(connection.connection_id);
  assert.equal(await form.getByRole('button', { name: 'Start research', exact: true }).isEnabled(), false);
  await form.locator('.research-consent input').check();
  await page.setViewportSize({ width: 390, height: 844 });
  await form.locator('.research-consent').scrollIntoViewIfNeeded();
  await screenshot('02-mobile-serpapi-consent');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await screenshot('03-desktop-serpapi-consent');
  await heartbeat(true);
  const submitted = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === `/api/scions/${scion.id}/agent-tasks`);
  await form.getByRole('button', { name: 'Start research', exact: true }).click();
  assert.equal((await submitted).postDataJSON().candidate_proposal.search_provider, 'serpapi');
  const task = await until(async () => (await api(`/scions/${scion.id}/agent-tasks`)).tasks.find(item => item.status === 'dispatched'), 'SerpApi task dispatch');
  assert.equal(task.claimed_at, null); assert.equal(task.provider_run_id, null);
  await api(`/scions/${scion.id}/agent-tasks/${task.id}/cancel`, { method: 'POST', data: {} });
  checked('Explicit SerpApi consent produces a persisted SerpApi task; mobile and desktop layouts fit.');
  await until(() => page.url().includes(`/research/${task.id}`), 'task page');
  const chat = page.getByRole('form', { name: 'Message task', exact: true });
  await chat.getByText('Search provider: SerpApi Google Search', { exact: true }).waitFor();
  await heartbeat(true);
  const missingProvider = await context.request.post(`${base}/api/scions/${scion.id}/agent-tasks/${task.id}/messages`, {
    headers: { 'X-Grimoire-CSRF': '1', 'X-Grimoire-Organization': org, 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' },
    data: { body: 'Legacy-client fixture without explicit SerpApi consent.', intent: 'follow_up', worker_connection_id: connection.connection_id, public_web_consent: true },
  });
  assert.ok([400, 422].includes(missingProvider.status()), 'A SerpApi follow-up requires explicit search_provider consent.');
  assert.equal((await api(`/scions/${scion.id}/agent-tasks`)).tasks.length, 1);
  checked('A legacy follow-up without explicit SerpApi provider consent is rejected without creating a task.');
  await heartbeat(false);
  await until(() => chat.getByLabel('Research computer', { exact: true }).locator('option').count().then(count => count === 1), 'SerpApi follow-up rejects Codex-only worker');
  assert.match(await chat.innerText(), /No SerpApi research computer is ready/);
  await heartbeat(true);
  await chat.getByLabel('Public follow-up brief', { exact: true }).fill('Continue this public protocol-only fixture.');
  await chat.getByLabel('Research computer', { exact: true }).selectOption(connection.connection_id);
  assert.equal(await chat.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), false);
  await chat.locator('.task-chat-consent input').check();
  await until(() => chat.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), 'follow-up consent accepted');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.task-chat-dock').evaluate(element => getComputedStyle(element).position), 'relative');
  await page.locator('#main-content').evaluate(element => { const chat = document.querySelector('.task-chat-composer'); element.scrollTop += chat.getBoundingClientRect().top - element.getBoundingClientRect().top - 12; });
  await page.screenshot({ path: path.join(evidence, '04-mobile-follow-up-in-flow.png'), fullPage: false, animations: 'disabled' });
  mobileGeometry = await page.evaluate(() => ({ viewport_height: innerHeight, document_scroll_height: document.documentElement.scrollHeight, body_scroll_height: document.body.scrollHeight, main_client_height: document.querySelector('#main-content').clientHeight, main_scroll_height: document.querySelector('#main-content').scrollHeight }));
  assert.ok(mobileGeometry.document_scroll_height <= mobileGeometry.viewport_height + 1, `Unexpected outer vertical overflow: ${JSON.stringify(mobileGeometry)}`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.locator('.task-chat-dock').evaluate(element => getComputedStyle(element).position), 'sticky');
  await heartbeat(true);
  const followup = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname.endsWith(`/agent-tasks/${task.id}/messages`));
  await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  assert.equal((await followup).postDataJSON().search_provider, 'serpapi');
  const next = await until(async () => (await api(`/scions/${scion.id}/agent-tasks`)).tasks.find(item => item.id !== task.id), 'persisted follow-up');
  await api(`/scions/${scion.id}/agent-tasks/${next.id}/cancel`, { method: 'POST', data: {} });
  const state = await api(`/scions/${scion.id}/research`);
  assert.equal(state.briefs.find(brief => brief.task_id === next.id).search_provider, 'serpapi');
  assert.deepEqual(state.reports, []);
  assert.equal(errors.length, 0);
  checked('Follow-up retains SerpApi, requires a capable computer and fresh consent, and never silently falls back.');
  await screenshot('05-follow-up-provider');
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ status: 'PASS', database, checks, mobile_geometry: mobileGeometry, browser_errors: errors, model_invoked: false, search_api_calls: 0, public_fetches: 0 }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', evidence, checks: checks.length, model_invoked: false, search_api_calls: 0 }));
} catch (error) {
  await screenshot('failure').catch(() => {});
  throw error;
} finally {
  if (scion) for (const task of (await api(`/scions/${scion.id}/agent-tasks`).catch(() => ({ tasks: [] }))).tasks) if (['queued', 'dispatched', 'running'].includes(task.status)) await api(`/scions/${scion.id}/agent-tasks/${task.id}/cancel`, { method: 'POST', data: {} }).catch(() => {});
  if (connection) await api(`/worker-connections/${connection.connection_id}/revoke`, { method: 'POST', data: { organization_id: org } }).catch(() => {});
  await browser.close();
}
