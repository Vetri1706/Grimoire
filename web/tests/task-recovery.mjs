import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Actual React routes, Rust API, PostgreSQL and source store. Fault injection
// drops responses or a single mutation; no mock task state and no model calls.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.GRIMOIRE_WEB_URL ?? 'http://127.0.0.1:5182';
const database = process.env.GRIMOIRE_TEST_DATABASE ?? 'grimoire_codex_flow_test';
assert.equal(process.env.GRIMOIRE_TEST_DISPOSABLE, '1');
assert.ok(database.endsWith('_test'));
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.equal((await (await fetch(`${base}/api/health`)).json()).database.name, database);
const only = process.argv.find(value => value.startsWith('--only='))?.slice(7);
const evidence = path.join(root, '.local', 'task-recovery', String(Date.now()));
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [], fixtures = [], failures = [];

async function fixture(label) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); page.setDefaultTimeout(16000);
  const errors = [], dialogs = []; page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  const suffix = randomUUID().slice(0, 8);
  const f = { label, context, page, errors, dialogs, organizationId: null, scion: null, connection: null, claimed: [] };
  fixtures.push(f);
  f.api = async (route, { method = 'GET', data, expected = 200, extra = {} } = {}) => {
    const response = await context.request.fetch(`${base}/api${route}`, { method, data, headers: { 'X-Grimoire-CSRF': '1', ...(f.organizationId ? { 'X-Grimoire-Organization': f.organizationId } : {}), ...extra } });
    assert.equal(response.status(), expected, `${method} ${route}: ${await response.text()}`);
    return response.json();
  };
  f.worker = async (route, data, extra = {}, expected = 200) => {
    const response = await fetch(`${base}/api${route}`, { method: 'POST', headers: { Authorization: `Bearer ${f.connection.credential}`, 'Content-Type': 'application/json', 'X-Grimoire-Worker-Protocol': '2', ...extra }, body: JSON.stringify(data) });
    assert.equal(response.status, expected, `${route}: ${await response.clone().text()}`);
    return response.json();
  };
  f.tasks = async () => (await f.api(`/scions/${f.scion.id}/agent-tasks`)).tasks;
  f.navigate = async route => { await page.goto(`${base}/#${route}`); };
  f.shot = async name => page.screenshot({ path: path.join(evidence, `${label}-${name}.png`), fullPage: true, animations: 'disabled' });
  await f.api('/session/signup', { method: 'POST', expected: 201, data: { login_name: `recovery-${suffix}`, display_name: 'Synthetic Recovery Handler', passphrase: `Synthetic-only-${randomUUID()}` } });
  const session = await f.api('/organizations', { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID() }, data: { name: `Synthetic Recovery ${label} ${suffix}` } });
  f.organizationId = session.active_organization.org_id;
  assert.equal(session.active_organization.can_confirm_scope, false);
  f.scion = await f.api('/scions', { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID() }, data: { name: `Synthetic ${label} ${suffix}`, product_category: 'digital', product_description: 'A synthetic pottery workshop website. Visitors can request a class place.', decision: 'Identify capabilities and missing evidence.', requirements: ['Visitors request a class place.'], questions: label === 'open-task-source-revocation' ? [] : ['Who confirms booking requests?'], change_summary: 'Synthetic task recovery browser test.' } });
  return f;
}
async function pair(f) {
  const response = await fetch(`${base}/api/worker-connections/pairings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_name: 'Synthetic task recovery protocol fixture - no model' }) });
  assert.equal(response.status, 201);
  const pairing = await response.json();
  await f.api(`/worker-connections/pairings/${pairing.user_code}/approve`, { method: 'POST', data: { organization_id: f.organizationId, consent: true, policy_version: 'codex-synthetic-v1' } });
  f.connection = await (await fetch(`${base}/api/worker-connections/pairings/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_secret: pairing.device_secret }) })).json();
  assert.equal(f.connection.status, 'approved');
}
async function composer(f) {
  await f.navigate(`/scions/${f.scion.id}/tasks/new`);
  const form = f.page.locator('.task-composer'); await form.waitFor();
  await form.getByRole('checkbox').check();
  return form;
}
async function waitFresh(f) {
  await f.page.waitForFunction(() => {
    const button = [...document.querySelectorAll('.task-composer button[type=submit]')][0];
    return button && !button.disabled;
  });
}
async function pollTwice(f) {
  for (let index = 0; index < 2; index++) await f.page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/scions/${f.scion.id}/capabilities` && response.status() === 200);
}
async function run(name, body) {
  if (only && only !== name) return;
  const f = await fixture(name);
  try { await body(f); assert.deepEqual(f.errors, []); assert.deepEqual(f.dialogs, [], 'Same-workspace task actions must not trigger discard dialogs.'); checks.push(name); await f.shot('passed'); console.log(`PASS ${name}`); }
  catch (error) {
    await f.shot('failure').catch(() => {});
    failures.push({ name, message: error.message, browserErrors: f.errors, page: (await f.page.locator('body').innerText().catch(() => '')).slice(-6500) });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

try {
  await run('new-task-and-rejected-agent', async f => {
    const config = { name: 'Synthetic planner', role: 'planner', title: '', capabilities: '', instructions: 'Synthetic preparation only; human review remains required.', reports_to: null, adapter: 'codex_cli', timeout_seconds: 120, skill_ids: [], paused: false };
    const agent = await f.api('/agents', { method: 'POST', expected: 201, data: config, extra: { 'Idempotency-Key': randomUUID() } });
    const form = await composer(f);
    await form.getByRole('combobox', { name: 'Assigned agent' }).selectOption(agent.id);
    const keys = []; let paused = false;
    await f.page.route(`**/api/scions/${f.scion.id}/agent-tasks`, async route => {
      if (route.request().method() === 'POST') {
        keys.push(route.request().headers()['idempotency-key']);
        if (!paused) { paused = true; await f.api(`/agents/${agent.id}`, { method: 'PUT', data: { ...config, paused: true }, extra: { 'If-Match': '"1"', 'Idempotency-Key': randomUUID() } }); }
      }
      await route.continue();
    });
    await waitFresh(f); const failed = f.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/agent-tasks'));
    await form.getByRole('button', { name: 'Start planning', exact: true }).click();
    const rejected = await failed; assert.equal(rejected.status(), 409); assert.equal((await rejected.json()).error.code, 'AGENT_UNAVAILABLE');
    const alert = f.page.getByRole('alert').filter({ hasText: /paused|runtime bounds/i }); await alert.waitFor();
    await pollTwice(f); assert.equal(await alert.isVisible(), true);
    assert.equal((await f.tasks()).length, 0);
    assert.equal(await form.getByRole('combobox', { name: 'Assigned agent' }).isEnabled(), true, 'A definitive rejection must unlock the editable request.');
    await form.getByRole('combobox', { name: 'Assigned agent' }).selectOption('');
    await form.getByRole('button', { name: 'Start planning', exact: true }).click();
    await f.page.locator('.task-detail').waitFor();
    assert.equal((await f.tasks()).length, 1); assert.equal((await f.tasks())[0].status, 'dispatched'); assert.notEqual(keys[0], keys[1]);
  });

  await run('lost-create-response', async f => {
    const form = await composer(f); const keys = []; let committed;
    await f.page.route(`**/api/scions/${f.scion.id}/agent-tasks`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      keys.push(route.request().headers()['idempotency-key']);
      if (!committed) { const response = await route.fetch(); assert.equal(response.status(), 201); committed = await response.json(); await route.abort('failed'); }
      else await route.continue();
    });
    await waitFresh(f); await form.getByRole('button', { name: 'Start planning', exact: true }).click();
    await f.page.getByRole('alert').filter({ hasText: /could not be confirmed|could not be reached/i }).waitFor();
    assert.equal((await f.tasks()).length, 1);
    const dispatched = f.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/scions/${f.scion.id}/agent-tasks/${committed.id}/dispatch`);
    await form.getByRole('button', { name: 'Retry same request', exact: true }).click();
    assert.equal((await dispatched).status(), 200);
    await f.page.locator('.task-detail').waitFor();
    const tasks = await f.tasks(); assert.equal(tasks.length, 1); assert.equal(tasks[0].id, committed.id); assert.equal(tasks[0].status, 'dispatched'); assert.equal(keys[0], keys[1]);
    const events = (await f.api(`/scions/${f.scion.id}/agent-tasks/${committed.id}/events`)).events;
    assert.equal(events.filter(event => event.status === 'queued').length, 1);
    assert.equal(events.filter(event => event.status === 'dispatched').length, 1);
  });

  await run('lost-dispatch-after-claim', async f => {
    await pair(f); const form = await composer(f); let claimed;
    await f.page.route(`**/api/scions/${f.scion.id}/agent-tasks/*/dispatch`, async route => {
      if (claimed) return route.continue();
      const response = await route.fetch(); assert.equal(response.status(), 200); const task = await response.json();
      claimed = await f.worker(`/agent/tasks/${task.id}/claim`, {}); f.claimed.push(claimed);
      await route.abort('failed');
    });
    await waitFresh(f); await form.getByRole('button', { name: 'Start planning', exact: true }).click();
    await f.page.locator('.task-detail').waitFor();
    await pollTwice(f);
    assert.equal((await f.tasks()).length, 1); assert.equal((await f.tasks())[0].status, 'running');
    assert.equal(await f.page.getByRole('alert').filter({ hasText: /start was not confirmed/ }).count(), 0, 'Observed running task resolves lost dispatch response.');
    await f.page.locator('.task-workspace-heading').getByRole('button', { name: 'New task', exact: true }).click();
    assert.equal(await f.page.locator('.task-composer').getByRole('combobox', { name: 'Assigned agent' }).isEnabled(), true);
    await f.worker(`/agent/tasks/${claimed.id}/fail`, { failure_code: 'SYNTHETIC_RECOVERY_NO_MODEL' }, { 'X-Grimoire-Task-Lease': claimed.lease_token });
  });

  await run('answer-failure-preserves-draft', async f => {
    await f.navigate(`/scions/${f.scion.id}/tasks`);
    await f.page.getByRole('button', { name: 'Answer questions', exact: true }).click();
    const input = f.page.getByRole('textbox', { name: 'Who confirms booking requests?', exact: true });
    const draft = 'A synthetic Handler confirms the request after reviewing availability.'; await input.fill(draft);
    let injected = false;
    await f.page.route(`**/api/scions/${f.scion.id}/revisions`, async route => {
      if (!injected && route.request().method() === 'POST') { injected = true; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_SAVE_FAILURE', message: 'Synthetic one-time write interruption.' } }) }); }
      else await route.continue();
    });
    await f.page.getByRole('button', { name: 'Save answers', exact: true }).click();
    const alert = f.page.getByRole('alert').filter({ hasText: 'Synthetic one-time write interruption.' }); await alert.waitFor();
    await pollTwice(f); assert.equal(await input.inputValue(), draft); assert.equal(await alert.isVisible(), true);
    assert.equal((await f.api(`/scions/${f.scion.id}`)).current_revision, 1);
    const queued = await f.api(`/scions/${f.scion.id}/agent-tasks`, { method: 'POST', expected: 201, extra: { 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, data: { task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, timeout_seconds: 120 } });
    await f.page.locator('.task-detail').waitFor();
    await f.navigate(`/scions/${f.scion.id}/tasks/${queued.id}`);
    await f.page.waitForURL(`**/#/scions/${f.scion.id}/tasks/${queued.id}`);
    assert.deepEqual(f.dialogs, [], 'Selecting a task in this Scion must preserve the answer draft without asking to discard it.');
    assert.equal(await input.inputValue(), draft);
    await f.page.getByRole('button', { name: 'Save answers', exact: true }).click();
    await f.page.getByRole('status').filter({ hasText: 'Answers saved' }).waitFor();
    const updated = await f.api(`/scions/${f.scion.id}`); assert.equal(updated.current_revision, 2); assert.ok(updated.revision.requirements.some(value => value.includes(draft))); assert.deepEqual(updated.revision.questions, []);
  });

  await run('competing-revision-preserves-draft', async f => {
    await f.navigate(`/scions/${f.scion.id}/tasks`);
    await f.page.getByRole('button', { name: 'Answer questions', exact: true }).click();
    const input = f.page.getByRole('textbox', { name: 'Who confirms booking requests?', exact: true });
    const draft = 'My unsaved answer must survive a competing brief revision.'; await input.fill(draft);
    let competed = false; let status;
    await f.page.route(`**/api/scions/${f.scion.id}/revisions`, async route => {
      if (route.request().method() === 'POST' && !competed) {
        competed = true;
        const { number, created_at, created_by, ...revision } = f.scion.revision;
        await f.api(`/scions/${f.scion.id}/revisions`, { method: 'POST', expected: 201, extra: { 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, data: { ...revision, change_summary: 'Independent client changed the brief before this tab saved.', questions: [...revision.questions, 'Which dates are available?'] } });
        const response = await route.fetch(); status = response.status(); await route.fulfill({ response });
      } else await route.continue();
    });
    await f.page.getByRole('button', { name: 'Save answers', exact: true }).click();
    await f.page.getByRole('alert').filter({ hasText: /brief changed while you were answering/i }).waitFor();
    assert.equal(status, 412); await pollTwice(f); assert.equal(await input.inputValue(), draft);
    assert.equal(await f.page.getByRole('button', { name: 'Save answers', exact: true }).isDisabled(), true);
    const current = await f.api(`/scions/${f.scion.id}`); assert.equal(current.current_revision, 2); assert.ok(!current.revision.requirements.some(value => value.includes(draft)));
  });

  await run('open-task-source-revocation', async f => {
    const marker = `SYNTHETIC_PRIVATE_SOURCE_${randomUUID()}`;
    const source = await f.api(`/scions/${f.scion.id}/sources`, { method: 'POST', expected: 201, extra: { 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, data: { title: marker, origin: `synthetic://task-recovery/${randomUUID()}`, owner: 'Synthetic Handler', synthetic: true, source_text: `${marker}: A synthetic workshop accepts requests. No independent provider evidence.`, rights_status: 'granted', permission_basis: 'Synthetic text authored solely for disposable browser test.', permitted_use: 'scion_review', change_summary: 'Synthetic source before task snapshot.' } });
    await pair(f);
    const task = await f.api(`/scions/${f.scion.id}/agent-tasks`, { method: 'POST', expected: 201, extra: { 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, data: { task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, timeout_seconds: 120 } });
    await f.api(`/scions/${f.scion.id}/agent-tasks/${task.id}/dispatch`, { method: 'POST', data: {}, extra: { 'If-Match': '"1"' } });
    const claimed = await f.worker(`/agent/tasks/${task.id}/claim`, {}); f.claimed.push(claimed);
    const state = await f.api(`/scions/${f.scion.id}/capabilities`);
    const planMarker = `SYNTHETIC_PLAN_BODY_${randomUUID()}`;
    const plan = await f.worker(`/scions/${f.scion.id}/capability-plans`, { synthetic: true, summary: planMarker, capabilities: [{ key: 'class_requests', title: 'Class request form', reason: 'The synthetic brief asks visitors to request a place.', evidence_needed: ['Authorized evidence for the request workflow.'], connector_ids: ['handler_intake', 'scion_sources'] }], unresolved_gaps: [...state.unresolved_gaps, 'Synthetic protocol fixture only; no model or verified vendor.'], change_summary: 'Synthetic protocol fixture; no model invoked and no approval.' }, { 'If-Match': '"1"', 'Idempotency-Key': randomUUID(), 'X-Grimoire-Task-Id': task.id, 'X-Grimoire-Task-Lease': claimed.lease_token }, 201);
    await f.worker(`/agent/tasks/${task.id}/result`, { proposal_id: plan.id, provider_run_id: 'synthetic-browser-protocol-no-model', output_sha256: '6'.repeat(64), preparation_note: 'Synthetic browser protocol fixture. No Codex or provider executed.' }, { 'X-Grimoire-Task-Lease': claimed.lease_token });
    await f.navigate(`/scions/${f.scion.id}/tasks/${task.id}`);
    await f.page.getByText(planMarker, { exact: true }).waitFor(); await f.page.locator('.task-evidence').getByText(marker, { exact: true }).waitFor();
    const before = await f.api(`/scions/${f.scion.id}/capabilities`); assert.equal(before.approval_available, false); assert.equal(before.plans[0].reviews?.length ?? 0, 0);
    const peer = await f.api(`/scions/${f.scion.id}/agent-tasks`, { method: 'POST', expected: 201, extra: { 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, data: { task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, timeout_seconds: 120 } });
    const inspector = f.page.getByRole('complementary', { name: 'Task inspector' });
    await f.page.locator('.task-detail-heading').getByRole('button', { name: 'Review result', exact: true }).click();
    const reviewDraft = `Unsaved Handler review ${marker}`;
    await f.page.locator('#task-review-note').fill(reviewDraft);
    await inspector.getByRole('tab', { name: 'Tasks', exact: true }).click();
    await inspector.getByRole('tabpanel', { name: 'Tasks', exact: true }).getByRole('button', { name: /Prepare capability plan/ }).click();
    await f.page.waitForURL(`**/#/scions/${f.scion.id}/tasks/${peer.id}`);
    assert.equal(await f.page.locator('#task-review-note').count(), 0, 'A review draft never appears on another task.');
    await f.page.goBack();
    await f.page.waitForURL(`**/#/scions/${f.scion.id}/tasks/${task.id}`);
    await f.page.locator('#task-review-note').waitFor();
    assert.equal(await f.page.locator('#task-review-note').inputValue(), reviewDraft, 'Review draft survives related-task navigation and browser Back.');
    assert.deepEqual(f.dialogs, [], 'In-Scion navigation preserves drafts without a discard prompt.');
    await inspector.getByRole('tab', { name: 'Properties', exact: true }).click();
    await f.shot('content-before-revocation');
    await f.page.setViewportSize({ width: 390, height: 844 });
    await f.shot('content-mobile');
    const fits = await f.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    assert.equal(fits, true, 'The populated task detail must fit a narrow mobile viewport.');
    await f.page.setViewportSize({ width: 1440, height: 1000 });
    await f.api(`/scions/${f.scion.id}/sources/${source.source_id}/revoke`, { method: 'POST', expected: 201, extra: { 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, data: { reason: 'Synthetic permission revoked while the task remains open.' } });
    await f.page.getByText('Evidence access changed', { exact: true }).waitFor();
    assert.equal(await f.page.getByText(planMarker, { exact: true }).count(), 0); assert.equal(await f.page.getByText(marker, { exact: true }).count(), 0);
    await pollTwice(f); const visible = await f.page.locator('body').innerText(); assert.ok(!visible.includes(marker) && !visible.includes(planMarker));
    assert.equal(await f.page.locator('#task-review-note').count(), 0, 'Source revocation hides the derived review draft too.');
    await inspector.getByRole('tab', { name: 'Artifacts', exact: true }).click();
    assert.equal(await inspector.getByRole('button', { name: /Capability plan/ }).count(), 0, 'A revoked-source artifact cannot be opened from the task inspector.');
    await inspector.locator('[data-status="blocked"]').waitFor();
    const after = await f.api(`/scions/${f.scion.id}/capabilities`); assert.equal(after.plans[0].status, 'blocked'); assert.equal(after.plans[0].input, null); assert.equal(after.approval_available, false);
  });
} finally {
  for (const f of fixtures) {
    for (const task of await f.tasks().catch(() => [])) {
      if (['queued', 'dispatched', 'running'].includes(task.status)) await f.api(`/scions/${f.scion.id}/agent-tasks/${task.id}/cancel`, { method: 'POST', data: {} }).catch(() => {});
      const claimed = f.claimed.find(item => item.id === task.id);
      if (claimed && ['running', 'cancel_requested'].includes(task.status)) await f.worker(`/agent/tasks/${task.id}/cancelled`, {}, { 'X-Grimoire-Task-Lease': claimed.lease_token }).catch(() => {});
    }
    if (f.connection?.connection_id) await f.api(`/worker-connections/${f.connection.connection_id}/revoke`, { method: 'POST', data: { organization_id: f.organizationId } }).catch(() => {});
    await f.context.close();
  }
  await browser.close();
  const report = { database, model_invoked: false, passed: checks.length, checks, failures, evidence };
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
}
