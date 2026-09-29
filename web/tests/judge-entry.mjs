import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Real Chrome + real local API, with new browser contexts and synthetic accounts.
// No owner, provider credential, real Codex account, or task dispatch is needed.
const base = (process.env.GRIMOIRE_WEB_URL ?? 'http://127.0.0.1:5182').replace(/\/$/, '');
const address = new URL(base);
assert.equal(process.env.GRIMOIRE_TEST_DISPOSABLE, '1', 'Set GRIMOIRE_TEST_DISPOSABLE=1 for an explicitly disposable test installation.');
assert.ok(address.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname) && !address.username && !address.password, 'Use only a loopback HTTP test installation.');
const expectedDatabase = process.env.GRIMOIRE_TEST_DATABASE ?? 'grimoire_test';
const health = await fetch(`${base}/api/health`).then(response => response.json());
assert.equal(health.database?.name, expectedDatabase, 'Check the test database before creating synthetic accounts.');
const evidence = resolve(process.env.GRIMOIRE_EVIDENCE_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../.local/judge-entry'));
await mkdir(evidence, { recursive: true });
const stamp = Date.now();
const passphrase = `Synthetic-test-only-${randomUUID()}`;
const checks = [], pageErrors = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function fresh() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.on('page', page => { page.setDefaultTimeout(20000); page.on('pageerror', error => pageErrors.push(error.message)); });
  return context;
}
async function snapshot(page, name) { await page.screenshot({ path: resolve(evidence, `${name}.png`), fullPage: true }); }
async function dashboard(page) { await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor(); }
async function openAccountMenu(page) {
  const trigger = page.getByRole('button', { name: 'Account menu', exact: true });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
}
async function signup(context, suffix) {
  const page = await context.newPage();
  await page.goto(base);
  await page.getByRole('heading', { name: 'Welcome to Grimoire.', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Use create account form', exact: true }).click();
  await page.locator('#handler-name').fill(`Synthetic Judge Test ${suffix}`);
  const login = `judge-test-${stamp}-${suffix}`;
  await page.locator('#login-name').fill(login);
  await page.locator('#handler-passphrase').fill(passphrase);
  await page.getByRole('button', { name: /Create account and continue/ }).click();
  await page.getByRole('heading', { name: 'What is your organization called?', exact: true }).waitFor();
  await page.locator('#organization-name').fill(`Private synthetic organization ${stamp} ${suffix}`);
  await page.getByRole('button', { name: /Create organization/ }).click();
  await dashboard(page);
  const state = await context.request.get(`${base}/api/session`).then(response => response.json());
  assert.equal(state.handler.installation_owner, false);
  assert.equal(state.organizations.length, 1);
  assert.equal(state.active_organization.can_manage_workspace, true);
  for (const permission of ['can_write', 'can_confirm_scope', 'can_propose_scope', 'is_agent']) assert.equal(state.active_organization[permission], false);
  return { page, login, org: state.active_organization.org_id };
}
async function demoReady(page, title) {
  await page.getByRole('heading', { name: 'Case graph', exact: true }).waitFor();
  if (title) await page.locator('.demo-case-heading').getByRole('heading', { name: title, exact: true }).waitFor();
  await page.getByRole('heading', { name: /^Watchtower\b/ }).waitFor();
  await page.getByRole('heading', { name: 'Operations dock', exact: true }).waitFor();
}
try {
  const accountA = await fresh();
  const alice = await signup(accountA, 'a');
  const scionName = `Private judge test website ${stamp}`;
  await alice.page.getByRole('button', { name: 'New Scion', exact: true }).first().click();
  await alice.page.locator('#name').fill(scionName);
  await alice.page.locator('#category').selectOption('digital');
  await alice.page.getByRole('button', { name: 'Continue', exact: true }).click();
  await alice.page.locator('#description').fill('Private synthetic website. Never publish this test account in the public demo.');
  await alice.page.locator('.scion-create-actions').getByRole('button', { name: 'Review', exact: true }).click();
  await alice.page.getByRole('button', { name: 'Create Scion', exact: true }).click();
  await alice.page.getByRole('heading', { name: scionName, exact: true, level: 1 }).waitFor();
  const scionId = new URL(alice.page.url()).hash.match(/^#\/scions\/([a-f0-9-]{36})/)?.[1];
  assert.ok(scionId);
  await alice.page.getByRole('combobox', { name: 'More Scion views' }).selectOption('graph');
  await alice.page.getByRole('heading', { name: 'Case graph', exact: true }).waitFor();
  assert.equal(await alice.page.getByRole('combobox', { name: 'More Scion views' }).locator('option[value="scope"],option[value="offers"]').count(), 0);
  await snapshot(alice.page, 'private-signup-scion');
  await alice.page.reload();
  await alice.page.getByRole('heading', { name: scionName, exact: true, level: 1 }).waitFor();
  checks.push('fresh normal signup creates an isolated organization and digital Scion without owner, sourcing or approval authority; session survives reload');

  await openAccountMenu(alice.page);
  await alice.page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await alice.page.getByRole('heading', { name: 'Welcome to Grimoire.', exact: true }).waitFor();
  await alice.page.reload();
  await alice.page.locator('#login-name').fill(alice.login);
  await alice.page.locator('#handler-passphrase').fill(passphrase);
  await alice.page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await dashboard(alice.page);
  assert.equal(await alice.page.getByRole('button', { name: 'Organization menu', exact: true }).getAttribute('data-organization-id'), alice.org);
  await alice.page.locator('#main-content').getByText(scionName, { exact: true }).first().waitFor();
  checks.push('logout clears access after reload; login restores the same private organization');

  const beforeCookies = await accountA.cookies();
  const sameSessionDemo = await accountA.newPage();
  const signedDemoRequests = [];
  sameSessionDemo.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/')) signedDemoRequests.push({ path: new URL(request.url()).pathname, headers: request.allHeaders() });
  });
  await sameSessionDemo.goto(`${base}/demo`);
  await demoReady(sameSessionDemo);
  const afterState = await accountA.request.get(`${base}/api/session`).then(response => response.json());
  assert.equal(afterState.active_organization.org_id, alice.org);
  const afterCookies = await accountA.cookies();
  assert.ok(beforeCookies.length === afterCookies.length && beforeCookies.every(before => afterCookies.some(after => before.name === after.name && before.value === after.value)), 'Viewing the demo must leave the authenticated session unchanged.');
  for (const request of signedDemoRequests) {
    assert.ok(request.path.startsWith('/api/demo'));
    const headers = await request.headers;
    assert.ok(!headers.cookie && !headers.authorization && !headers['x-grimoire-organization'], 'Signed-in demo requests omit account credentials.');
  }
  await sameSessionDemo.close();
  checks.push('signed-in visitors open the public demo without sending cookies or changing their session or organization');

  const accountB = await fresh();
  const bob = await signup(accountB, 'b');
  assert.notEqual(bob.org, alice.org);
  assert.equal(await bob.page.getByText(scionName, { exact: true }).count(), 0);
  const bobHeaders = { 'X-Grimoire-Organization': bob.org };
  for (const path of [`/scions/${scionId}`, `/scions/${scionId}/control-surface`, `/scions/${scionId}/sources`]) {
    const response = await accountB.request.get(`${base}/api${path}`, { headers: bobHeaders });
    assert.equal(response.status(), 404, `Other organization must not see ${path}.`);
  }
  const bobWorkspace = await accountB.request.get(`${base}/api/workspace`, { headers: bobHeaders }).then(response => response.json());
  assert.equal(bobWorkspace.org_id, bob.org);
  assert.equal(bobWorkspace.scions.length, 0);
  for (const collection of ['events', 'reviews', 'watches']) assert.deepEqual(bobWorkspace[collection], []);
  checks.push('second account sees an empty isolated workspace; foreign private Scion, graph and sources return 404, with no foreign alerts');

  const publicContext = await fresh();
  const publicPage = await publicContext.newPage();
  const publicRequests = [];
  publicPage.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/')) publicRequests.push({ path: new URL(request.url()).pathname, method: request.method(), headers: request.allHeaders() });
  });
  await publicPage.goto(`${base}/demo`);
  await demoReady(publicPage);
  assert.deepEqual(await publicContext.cookies(), []);
  const manifestResponse = await publicContext.request.get(`${base}/api/demo`);
  assert.equal(manifestResponse.status(), 200);
  assert.equal(manifestResponse.headers()['cache-control'], 'no-store');
  assert.equal(manifestResponse.headers()['set-cookie'], undefined);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.synthetic, true); assert.equal(manifest.read_only, true);
  assert.deepEqual(manifest.scenarios.map(scenario => scenario.slug).sort(), ['current', 'revised', 'revoked']);
  const cases = {};
  for (const scenario of manifest.scenarios) {
    await publicPage.goto(`${base}/demo#${scenario.slug}`);
    await demoReady(publicPage, scenario.title);
    const response = await publicContext.request.get(`${base}/api/demo/${scenario.slug}`);
    assert.equal(response.status(), 200);
    const data = await response.json(); cases[scenario.slug] = data;
    assert.equal(data.scion_id, scenario.scion_id);
    assert.equal(data.synthetic, true); assert.equal(data.read_only, true); assert.equal(data.approval_available, false);
    assert.ok(data.nodes.length > 6 && data.edges.length > 5);
    assert.ok(data.nodes.some(node => node.kind === 'human_review' && node.status === 'required'));
    assert.ok(data.nodes.some(node => node.id === 'connector:external' && node.status === 'unavailable'));
    assert.equal(data.watchtower.watches.length, 3);
    assert.ok(data.watchtower.last_successful_check, 'Monitor persisted a successful server check.');
    assert.ok(data.nodes.every(node => node.safe_next_action.enabled === false));
    assert.equal(await publicPage.getByText('Read-only preview', { exact: true }).isVisible(), true);
    assert.equal(await publicPage.locator('.os-inspector button.button').count(), 0);
    assert.equal(await publicPage.getByRole('button', { name: /Update intake|Open workspace|Run now|Approve/ }).count(), 0);
    assert.equal(await publicPage.getByText(scionName, { exact: true }).count(), 0);
    await snapshot(publicPage, `public-${scenario.slug}`);
  }
  assert.ok(cases.current.operations.tasks.some(task => task.status === 'completed'));
  assert.ok(cases.current.nodes.some(node => node.kind === 'capability_proposal' && !node.stale && node.details));
  assert.ok(JSON.stringify(cases.current).includes('SYNTHETIC_JUDGE_EVIDENCE_CURRENT'));
  assert.ok(cases.revised.nodes.some(node => node.kind === 'capability_proposal' && node.stale && node.details === null));
  assert.ok(cases.revised.operations.events.some(event => event.kind === 'scion_revision_changed'));
  assert.ok(cases.revised.operations.human_review.length > 0);
  assert.ok(cases.revoked.nodes.some(node => node.kind === 'evidence_source' && /revoked|blocked/.test(node.status) && node.details === null));
  assert.ok(cases.revoked.nodes.some(node => node.kind === 'capability_proposal' && node.status === 'blocked' && node.details === null));
  assert.ok(cases.revoked.operations.tasks.some(task => task.blocked));
  assert.ok(!JSON.stringify(cases.revoked).includes('SYNTHETIC_JUDGE_EVIDENCE_REVOKED'));
  assert.ok(cases.revoked.operations.human_review.length > 0);
  checks.push('public database projections show completed draft without approval, revised stale plan and persisted review, revoked evidence redaction and blocked dependent tasks');

  await publicPage.goto(`${base}/demo#revoked`); await demoReady(publicPage);
  await publicPage.locator('.os-node').filter({ hasText: 'Evidence source' }).first().click();
  await publicPage.locator('.os-withheld').waitFor();
  assert.equal(await publicPage.locator('.os-node-details').count(), 0);
  assert.ok(!(await publicPage.locator('body').innerText()).includes('SYNTHETIC_JUDGE_EVIDENCE_REVOKED'));
  await publicPage.getByRole('tab', { name: /^Blocked/ }).click();
  assert.ok(await publicPage.locator('.os-dock-panel .os-work-list li').count() > 0);
  await publicPage.getByRole('tab', { name: /^Event feed/ }).click();
  assert.ok(await publicPage.locator('.os-event-feed li').count() > 0);
  checks.push('browser inspector withholds revoked content; Operations dock exposes persisted blocked work and auditable events');

  for (const path of [`/demo/${scionId}`, '/demo/not-published']) assert.equal((await publicContext.request.get(`${base}/api${path}`)).status(), 404);
  assert.equal((await publicContext.request.post(`${base}/api/demo/current`, { data: {} })).status(), 405);
  assert.equal((await publicContext.request.get(`${base}/api/scions/${scionId}/control-surface`)).status(), 401);
  assert.equal((await publicContext.request.post(`${base}/api/scions/${cases.current.scion_id}/revisions`, { data: { name: 'Forbidden public mutation' } })).status(), 401);
  assert.deepEqual(await publicContext.cookies(), []);
  for (const request of publicRequests) {
    assert.ok(request.path.startsWith('/api/demo'), `Public page must never bootstrap account state: ${request.path}`);
    assert.equal(request.method, 'GET');
    const headers = await request.headers;
    assert.ok(!headers.cookie && !headers.authorization && !headers['x-grimoire-organization'], 'Public page sends no account credentials.');
  }
  checks.push('fresh public browser allocates no identity or cookie, calls no setup/session endpoints, cannot mutate or enumerate private cases, and requests only GET demo snapshots');

  await publicContext.setOffline(true);
  await publicPage.getByText('Case view disconnected', { exact: true }).waitFor();
  assert.equal(await publicPage.locator('.os-node').count(), 0);
  assert.equal(await publicPage.locator('.os-event-feed').count(), 0);
  await snapshot(publicPage, 'public-disconnected');
  await publicContext.setOffline(false);
  await demoReady(publicPage);
  checks.push('offline transition clears nodes and events; reconnect reads server state again');

  await publicPage.setViewportSize({ width: 390, height: 844 });
  await publicPage.reload(); await demoReady(publicPage);
  assert.ok(await publicPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile demo must not overflow the viewport; graph has its own scroll region.');
  await snapshot(publicPage, 'public-mobile');
  await publicPage.getByRole('link', { name: 'Sign in / open workspace' }).click();
  await publicPage.getByRole('heading', { name: 'Welcome to Grimoire.', exact: true }).waitFor();
  assert.ok(await publicPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile account entry must not overflow.');
  await snapshot(publicPage, 'account-entry-mobile');
  assert.deepEqual(pageErrors, []);
  checks.push('mobile demo and normal account entry fit a fresh 390px viewport; no browser JavaScript errors');
  const report = { passed: checks.length, checks, evidence, pageErrors, database: expectedDatabase };
  await writeFile(resolve(evidence, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
