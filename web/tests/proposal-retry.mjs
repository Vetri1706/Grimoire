import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Real Chrome and a disposable PostgreSQL-backed installation. These tests only
// queue/cancel synthetic tasks; no worker enrollment, dispatch, or model run.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.GRIMOIRE_WEB_URL ?? 'http://127.0.0.1:5182';
const database = process.env.GRIMOIRE_TEST_DATABASE ?? 'grimoire_codex_flow_test';
const reproduce = process.argv.includes('--reproduce');
assert.equal(process.env.GRIMOIRE_TEST_DISPOSABLE, '1');
assert.ok(database.endsWith('_test'));
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
assert.equal((await (await fetch(`${base}/api/health`)).json()).database.name, database);
const evidence = path.join(root, '.local', 'proposal-retry', `${Date.now()}-${reproduce ? 'before' : 'after'}`);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(20000);
const browserErrors = [], checks = [], requests = [];
let organizationId, scionId, dispatched = false;
page.on('pageerror', error => browserErrors.push(error.message));
page.on('request', request => {
  if (request.method() !== 'POST') return;
  const pathname = new URL(request.url()).pathname;
  if (/\/agent-tasks\/[^/]+\/dispatch$/.test(pathname)) dispatched = true;
  if (pathname.endsWith('/agent-tasks')) requests.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() });
});
async function api(route, { method = 'GET', data, expected = 200, extra = {} } = {}) {
  const response = await context.request.fetch(`${base}/api${route}`, { method, data, headers: { 'X-Grimoire-CSRF': '1', ...(organizationId ? { 'X-Grimoire-Organization': organizationId } : {}), ...extra } });
  assert.equal(response.status(), expected, `${method} ${route}: ${await response.text()}`);
  return response.json();
}
const tasks = async () => (await api(`/scions/${scionId}/agent-tasks`)).tasks;
async function form() {
  const details = page.locator('.proposal-prepare');
  await details.waitFor();
  if (!(await details.evaluate(element => element.open))) await details.locator('summary').click();
  await details.getByRole('checkbox').check();
  await details.getByRole('button', { name: 'Queue Codex proposal', exact: true }).waitFor();
  return details;
}
async function queue(expected = 201) {
  const current = await form();
  const response = page.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname === `/api/scions/${scionId}/agent-tasks`);
  await current.getByRole('button', { name: 'Queue Codex proposal', exact: true }).click();
  const result = await response;
  assert.equal(result.status(), expected, await result.text());
  return result.json();
}
async function cancelInBrowser() {
  const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/cancel'));
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  assert.equal((await response).status(), 200);
  await page.getByRole('heading', { name: 'Cancelled', exact: true }).waitFor();
}
async function screenshot(name) { await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled' }); }
async function openPreparation() {
  if (reproduce) { await page.goto(`${base}/#/scions/${scionId}/agent-work`); return; }
  // The digital workspace now has a new task-first route. Exercise the actual
  // legacy preparation component/shared physical-write hook without reintroducing
  // a production route. Only this browser receives the harness HTML; all React
  // modules and API requests are the real local application's implementations.
  const mainModule = await (await fetch(`${base}/src/main.tsx`)).text();
  const modulePath = name => {
    const target = mainModule.match(new RegExp(`from \"([^\"]*/${name}\\.js[^\"]*)\"`))?.[1];
    assert.ok(target, `Locate Vite's existing ${name} module.`);
    return target;
  };
  const reactPath = modulePath('react');
  const domPath = modulePath('react-dom_client');
  await page.route('**/__proposal_retry__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><title>Proposal retry regression</title></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;
const [{ default: React }, { default: ReactDOM }, { default: AdaptiveScion }, { organizationSession, request }, { ThemeProvider }] = await Promise.all([
  import(${JSON.stringify(reactPath)}), import(${JSON.stringify(domPath)}), import('/src/AdaptiveScion.tsx'), import('/src/api.ts'), import('/src/theme.tsx')
]);
await Promise.all([import('/src/styles.css'), import('/src/workbench.css')]);
const session = await (await fetch('/api/session')).json();
const actor = session.active_organization;
const token = organizationSession(actor.org_id);
const scionId = new URLSearchParams(location.search).get('scion');
const [scion, agents] = await Promise.all([request(token, '/scions/' + scionId), request(token, '/agents')]);
const noOp = () => {};
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(ThemeProvider, null, React.createElement(AdaptiveScion, {
  token, scion, nativeAgents: agents.agents, canWrite: actor.can_write, canPrepare: actor.can_prepare_workspace,
  preferredPlanId: null, view: 'agent-work', onView: noOp, onDirty: noOp, onSources: noOp, onScopeProposal: noOp, onOfferProposal: noOp
})));
</script></body></html>` }));
  await page.goto(`${base}/__proposal_retry__?scion=${encodeURIComponent(scionId)}`);
}
try {
  const suffix = randomUUID().slice(0, 8);
  await api('/session/signup', { method: 'POST', expected: 201, data: { login_name: `proposal-retry-${suffix}`, display_name: 'Synthetic Proposal Retry', passphrase: `Synthetic-only-${randomUUID()}` } });
  const session = await api('/organizations', { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID() }, data: { name: `Synthetic Proposal Retry ${suffix}` } });
  organizationId = session.active_organization.org_id;
  assert.equal(session.active_organization.can_confirm_scope, false);
  const scion = await api('/scions', { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID() }, data: { name: `Synthetic retry brief ${suffix}`, product_category: 'digital', product_description: 'Synthetic pottery workshop booking website. Visitors request a class place; a Handler confirms the request.', decision: 'Identify capabilities and missing evidence.', requirements: ['Visitors can request a class place.'], questions: ['Who confirms requests?'], change_summary: 'Synthetic retry verification.' } });
  scionId = scion.id;
  await openPreparation();
  const first = await queue();
  await page.getByRole('button', { name: 'Cancel task', exact: true }).waitFor();
  await cancelInBrowser();
  const second = await queue();
  const list = await tasks();
  if (reproduce) {
    assert.equal(second.id, first.id);
    assert.equal(second.status, 'cancelled');
    assert.equal(list.length, 1);
    assert.equal(requests[0].key, requests[1].key);
    checks.push('Before fix: queue/cancel/requeue unchanged returns the same cancelled task and does not create new work.');
    await screenshot('cancelled-task-replayed-as-new');
  } else {
    assert.notEqual(second.id, first.id);
    assert.equal(second.status, 'queued');
    assert.equal(list.length, 2);
    assert.notEqual(requests[0].key, requests[1].key);
    checks.push('Confirmed successful submissions retire their key: unchanged preparation after cancellation creates a distinct queued task.');

    let lost = false, committed;
    const taskPath = `**/api/scions/${scionId}/agent-tasks`;
    await page.route(taskPath, async route => {
      if (route.request().method() === 'POST' && !lost) {
        lost = true;
        const response = await route.fetch();
        assert.equal(response.status(), 201);
        committed = await response.json();
        await route.abort('failed');
      } else await route.continue();
    });
    const prepared = await form();
    await prepared.getByRole('button', { name: 'Queue Codex proposal', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /could not be reached|connection|could not confirm/i }).first().waitFor();
    assert.equal((await tasks()).length, 3);
    const retry = await queue();
    assert.equal(retry.id, committed.id);
    assert.equal((await tasks()).length, 3);
    assert.equal(requests[2].key, requests[3].key);
    const events = await api(`/scions/${scionId}/agent-tasks/${retry.id}/events`);
    assert.equal(events.events.length, 1, 'A lost-response retry cannot append a second queued task event.');
    await page.unroute(taskPath);
    checks.push('A lost response after commit retains its key; retry returns one task with one queued event.');

    const agent = await api('/agents', { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID() }, data: { name: 'Synthetic short-runtime planner', role: 'planner', title: '', capabilities: '', instructions: 'Synthetic preparation only. Keep human review required.', reports_to: null, adapter: 'codex_cli', timeout_seconds: 120, skill_ids: [], paused: false } });
    await page.reload();
    const errorForm = await form();
    await errorForm.getByRole('combobox', { name: 'Assigned agent', exact: true }).selectOption(agent.id);
    await errorForm.getByRole('spinbutton').fill('240');
    const failure = await queue(409);
    assert.equal(failure.error.code, 'AGENT_UNAVAILABLE');
    const mutationError = page.getByRole('alert').filter({ hasText: /agent is paused|runtime bounds/i });
    await mutationError.waitFor();
    // Observe two real successful data polls, not merely elapsed wall time.
    for (let index = 0; index < 2; index++) await page.waitForResponse(value => value.request().method() === 'GET' && new URL(value.url()).pathname === `/api/scions/${scionId}/capabilities` && value.status() === 200);
    assert.equal(await mutationError.isVisible(), true);
    assert.equal((await tasks()).length, 3, 'A rejected preparation cannot leave a partial task.');
    await screenshot('queue-error-survives-polling');
    checks.push('A real rejected task bind remains visible across successful access polling and creates no partial task.');
  }
  assert.equal(dispatched, false);
  assert.deepEqual(browserErrors, []);
  const report = { mode: reproduce ? 'before-production-route' : 'after-real-component-harness', passed: checks.length, database, model_invoked: false, dispatched, checks, task_ids: (await tasks()).map(task => ({ id: task.id, status: task.status })), requests, evidence };
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await screenshot('failure');
  console.error(JSON.stringify({ browserErrors, evidence }));
  if (await page.locator('vite-error-overlay').count()) console.error(await page.locator('vite-error-overlay').innerText());
  console.error((await page.locator('body').innerText()).slice(-5000));
  throw error;
} finally {
  if (scionId) for (const task of await tasks().catch(() => [])) if (task.status === 'queued') await api(`/scions/${scionId}/agent-tasks/${task.id}/cancel`, { method: 'POST', data: {} }).catch(() => {});
  await browser.close();
}
