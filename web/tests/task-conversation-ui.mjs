import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Notes-only real browser/API regression. No worker is paired, no provider is
// called, and both fixture tasks are cancelled before opening the conversation.
assert.equal(process.env.GRIMOIRE_TEST_DISPOSABLE, '1');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.GRIMOIRE_WEB_URL ?? 'http://127.0.0.1:5182';
const database = process.env.GRIMOIRE_TEST_DATABASE ?? 'grimoire_codex_flow_test';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(database.endsWith('_test'));
assert.equal((await (await fetch(`${base}/api/health`)).json()).database.name, database);
const evidence = path.join(root, '.local', 'task-conversation-ui', String(Date.now()));
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const checks = [], errors = []; let org, scion; const tasks = [];
page.on('pageerror', failure => errors.push(failure.message));
page.on('dialog', dialog => dialog.accept());
async function api(route, { method = 'GET', data, expected = 200, extra = {} } = {}) {
  const response = await context.request.fetch(`${base}/api${route}`, { method, data, headers: { 'X-Grimoire-CSRF': '1', ...(org ? { 'X-Grimoire-Organization': org } : {}), ...extra } });
  assert.equal(response.status(), expected, `${method} ${route}: ${await response.text()}`);
  return expected === 204 ? null : response.json();
}
const create = data => ({ method: 'POST', data, expected: 201, extra: { 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' } });
const route = task => `/scions/${scion.id}/tasks/${task.id}`;
const form = () => page.getByRole('form', { name: 'Message task', exact: true });
const editor = () => form().getByLabel('Message', { exact: true });
const shot = name => page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled' });
const check = description => { checks.push(description); console.log(description); };
async function until(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
}
async function navigate(destination) {
  await page.evaluate(destination => { window.location.hash = destination; }, destination);
  if (destination.includes('/tasks/')) await form().waitFor();
}
try {
  const stamp = randomUUID().slice(0, 8);
  const login = { login_name: `chat-ui-${stamp}`, passphrase: `Disposable-chat-ui-${randomUUID()}` };
  await api('/session/signup', { method: 'POST', expected: 201, data: { ...login, display_name: 'Synthetic Chat UI Handler' } });
  org = (await api('/organizations', create({ name: `Synthetic chat UI ${stamp}` }))).active_organization.org_id;
  const agent = await api('/agents', create({ name: 'Synthetic UI planner', role: 'planner', title: 'Notes-only browser fixture', capabilities: 'Synthetic planning fixture.', instructions: 'This test does not dispatch any model work.', reports_to: null, adapter: 'codex_cli', timeout_seconds: 300, skill_ids: [], paused: false }));
  scion = await api('/scions', create({ name: `Synthetic chat UI workshop ${stamp}`, product_category: 'digital', product_description: 'A synthetic pottery workshop website for testing chat navigation and input only.', decision: 'Check the task conversation without invoking a model.', requirements: ['Preserve unsent messages until the session ends.'], questions: [], change_summary: 'Disposable no-model UI fixture.' }));
  for (let i = 0; i < 2; i++) {
    const task = await api(`/scions/${scion.id}/agent-tasks`, create({ task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, agent_id: agent.id, timeout_seconds: 300 }));
    tasks.push(task);
    await api(`/scions/${scion.id}/agent-tasks/${task.id}/cancel`, { method: 'POST', data: {} });
  }
  await page.goto(`${base}/#${route(tasks[0])}`); await form().waitFor();
  await form().getByLabel('Message action', { exact: true }).selectOption('note');
  const draft = `Unsent UI draft ${stamp}: keep the workshop plan bounded.`;
  await editor().fill(draft);
  await navigate(route(tasks[1])); await until(() => editor().inputValue().then(value => value === ''), 'second task has a separate draft');
  await navigate(route(tasks[0])); await until(() => editor().inputValue().then(value => value === draft), 'original task draft restored after unmount');
  assert.equal(await form().getByLabel('Message action', { exact: true }).inputValue(), 'note');
  check('Unsent draft and intent survive task unmount/navigation, with distinct drafts per task.');

  await editor().press('End'); await editor().press('Enter'); await editor().press('T');
  const note = await editor().inputValue(); assert.equal(note, `${draft}\nT`);
  assert.equal((await api(`/scions/${scion.id}/agent-tasks/${tasks[0].id}/conversation`)).messages.length, 0);
  await until(() => form().getByRole('button', { name: 'Add note', exact: true }).isEnabled(), 'note sending available');
  await editor().press('Control+Enter');
  await page.locator('.task-thread-message').filter({ hasText: note }).waitFor();
  assert.equal(await editor().inputValue(), '');
  assert.equal((await api(`/scions/${scion.id}/agent-tasks`)).tasks.length, 2);
  check('Enter adds a newline; Ctrl+Enter saves exactly one note and starts no task.');

  await editor().fill(`Retained while access is unavailable ${stamp}`);
  const readPattern = `**/api/scions/${scion.id}/agent-tasks/${tasks[0].id}/conversation`;
  await page.route(readPattern, matched => matched.abort('failed'));
  await until(() => page.locator('.task-thread-message').filter({ hasText: note }).count().then(value => value === 0), 'thread content hidden after access failure', 6500);
  assert.match(await editor().inputValue(), /Retained while access/);
  assert.equal(await form().getByRole('button', { name: 'Add note', exact: true }).isDisabled(), true);
  await page.unroute(readPattern);
  await page.getByRole('button', { name: 'Check conversation again', exact: true }).click();
  await page.locator('.task-thread-message').filter({ hasText: note }).waitFor();
  assert.match(await editor().inputValue(), /Retained while access/);
  await editor().fill('');
  check('Failed access recheck hides recorded messages and disables sending, while preserving the entered draft.');

  const messagePath = `/scions/${scion.id}/agent-tasks/${tasks[0].id}/messages`;
  let latestText;
  for (let index = 0; index < 7; index++) {
    latestText = `Synthetic history note ${index + 1} ${stamp}. ${'Keep class requests separate from confirmed bookings. '.repeat(7)}`;
    await api(messagePath, create({ body: latestText, intent: 'note' }));
  }
  await page.reload(); await form().waitFor();
  const fullyAboveComposer = text => page.locator('.task-thread-message').filter({ hasText: text }).evaluate(element => {
    const reply = element.getBoundingClientRect(), dock = document.querySelector('.task-chat-dock').getBoundingClientRect();
    const main = document.querySelector('#main-content').getBoundingClientRect();
    return reply.bottom <= dock.top + 2 && reply.top >= main.top - 2;
  }).catch(() => false);
  await until(() => fullyAboveComposer(latestText), 'initial long thread displays latest note above composer');
  await page.locator('#main-content').evaluate(element => element.scrollTo({ top: 0 }));
  await until(() => page.locator('#main-content').evaluate(element => element.scrollTop < 2), 'reader at earlier history');
  const priorScroll = await page.locator('#main-content').evaluate(element => element.scrollTop);
  await page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith(`/agent-tasks/${tasks[0].id}/conversation`) && response.status() === 200);
  assert.ok(Math.abs(await page.locator('#main-content').evaluate(element => element.scrollTop) - priorScroll) < 3, 'ordinary access polling preserves the reading position');
  const newNote = `Latest incoming note ${stamp}: this is saved while the Handler reads an earlier message.`;
  await api(messagePath, create({ body: newNote, intent: 'note' }));
  await page.locator('.task-thread-message').filter({ hasText: newNote }).waitFor({ state: 'attached' });
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).waitFor();
  assert.ok(Math.abs(await page.locator('#main-content').evaluate(element => element.scrollTop) - priorScroll) < 3);
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await until(() => fullyAboveComposer(newNote), 'jump reveals saved latest note above composer');
  await shot('05-long-thread-latest-note');
  check('Long threads open at the latest record; incoming messages preserve earlier reading position and provide Jump to latest.');

  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'grimoire.theme-preference', newValue: 'light' })));
  await shot('01-desktop-pearl');
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'grimoire.theme-preference', newValue: 'dark' })));
  await shot('02-desktop-midnight');
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileJump = page.getByRole('button', { name: 'Jump to latest', exact: true });
  if (await mobileJump.isVisible()) await mobileJump.click();
  await until(() => fullyAboveComposer(newNote), 'mobile latest note above composer');
  await shot('03-mobile-midnight');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.setViewportSize({ width: 390, height: 500 });
  await editor().focus(); await editor().scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.task-chat-dock').evaluate(element => getComputedStyle(element).position), 'static');
  await shot('04-short-viewport-composer');
  assert.ok((await api(`/scions/${scion.id}/agent-tasks`)).tasks.every(task => task.status === 'cancelled' && !task.provider_run_id));
  check('Pearl/Midnight desktop and narrow mobile layouts fit; short viewports put the composer in normal flow.');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await editor().fill(`Clear this draft on session end ${stamp}`);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('grimoire:session-invalidated', { detail: { token: '__grimoire_cookie_session__:previous-organization' } })));
  assert.match(await editor().inputValue(), /Clear this draft on session end/);
  assert.equal(await page.locator('.task-thread-message').filter({ hasText: note }).count(), 1);
  await navigate('/dashboard'); await form().waitFor({ state: 'detached' });
  await context.clearCookies();
  await page.evaluate(token => window.dispatchEvent(new CustomEvent('grimoire:session-invalidated', { detail: { token } })), `__grimoire_cookie_session__:${org}`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().waitFor();
  await api('/session/login', { method: 'POST', data: login });
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'grimoire:session-changed', newValue: 'synthetic-ui-recheck' })));
  await until(() => page.locator('.company-app').count().then(value => value > 0), 'same Handler signed in again');
  await navigate(route(tasks[0]));
  assert.equal(await editor().inputValue(), '');
  await page.locator('.task-thread-message').filter({ hasText: note }).waitFor();
  check('Session invalidation clears unsent drafts even while the chat is unmounted; a same-Handler sign-in retrieves only persisted messages.');

  await editor().fill(`Mounted draft clears ${stamp}`);
  await context.clearCookies();
  await page.evaluate(token => window.dispatchEvent(new CustomEvent('grimoire:session-invalidated', { detail: { token } })), `__grimoire_cookie_session__:${org}`);
  await until(() => page.locator('.task-thread-message').filter({ hasText: note }).count().then(value => value === 0), 'session end clears open conversation');
  await form().waitFor({ state: 'detached' });
  assert.equal(errors.length, 0);
  check('An invalidated active session removes the open conversation and draft immediately.');
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ status: 'PASS', database, checks, scion_id: scion.id, task_ids: tasks.map(task => task.id), browser_errors: errors, actual_model_runs: 0 }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', evidence, checks: checks.length, actual_model_runs: 0 }));
} catch (failure) {
  await shot('failure').catch(() => {});
  await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ message: failure.message, checks, browser_errors: errors, scion_id: scion?.id }, null, 2));
  throw failure;
} finally { await browser.close(); }
