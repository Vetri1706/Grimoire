import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Use a disposable local database. Creates synthetic configuration, never runs agents.
const base = process.env.GRIMOIRE_WEB_URL ?? 'http://127.0.0.1:5173';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname));
assert.equal(process.env.GRIMOIRE_TEST_DISPOSABLE, '1', 'Set GRIMOIRE_TEST_DISPOSABLE=1 for an explicitly disposable test installation.');
const expectedDatabase = process.env.GRIMOIRE_TEST_DATABASE ?? 'grimoire_test';
const health = await fetch(`${base}/api/health`).then(response => response.json());
assert.equal(health.database?.name, expectedDatabase, 'Check the test database before creating synthetic accounts.');
const evidence = resolve(process.env.GRIMOIRE_EVIDENCE_DIR ?? '../.local/onboarding-browser');
await mkdir(evidence, { recursive: true });
const stamp = Date.now();
const login = process.env.GRIMOIRE_TEST_LOGIN ?? `browser-owner-${stamp}`;
const passphrase = process.env.GRIMOIRE_TEST_PASSPHRASE ?? 'browser-test-passphrase';
const alpha = `Browser Alpha ${stamp}`, beta = `Browser Beta ${stamp}`, scionName = `Browser Digital Scion ${stamp}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(20000);
const pageErrors = [], checks = [];
page.on('pageerror', error => pageErrors.push(error.message));
async function snapshot(name) { await page.screenshot({ path: resolve(evidence, `${name}.png`), fullPage: true }); }
async function dashboard() { await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor(); }
async function openAccountMenu() {
  const trigger = page.getByRole('button', { name: 'Account menu', exact: true });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
}
async function openOrganizationMenu(target = page) {
  const trigger = target.getByRole('button', { name: 'Organization menu', exact: true });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  return target.getByRole('group', { name: 'Organizations', exact: true });
}
async function switchOrganization(target, organizationId) {
  const menu = await openOrganizationMenu(target);
  await menu.locator(`button[data-organization-id="${organizationId}"]`).click();
  await target.waitForFunction(id => document.querySelector('button[aria-label="Organization menu"]')?.getAttribute('data-organization-id') === id, organizationId);
}
try {
  await page.goto(base);
  await page.locator('#login-name').waitFor();
  if (!process.env.GRIMOIRE_TEST_LOGIN && await page.getByRole('button', { name: 'Set up this installation', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Set up this installation', exact: true }).click();
  }
  const setup = await page.locator('#handler-name').isVisible();
  if (setup) await page.locator('#handler-name').fill('Synthetic Browser Owner');
  else assert.ok(process.env.GRIMOIRE_TEST_LOGIN, 'Existing installation requires GRIMOIRE_TEST_LOGIN and GRIMOIRE_TEST_PASSPHRASE.');
  await page.locator('#login-name').fill(login);
  await page.locator('#handler-passphrase').fill(passphrase);
  assert.equal(await page.locator('.onboarding-steps li[data-current="true"]').count(), 1);
  await snapshot('onboarding-access');
  await page.getByRole('button', { name: setup ? /Create Handler identity/ : 'Sign in', exact: true }).click();
  if (!setup) { await dashboard(); await (await openOrganizationMenu()).getByRole('button', { name: 'Create another organization', exact: true }).click(); }
  await page.getByRole('heading', { name: 'What is your organization called?', exact: true }).waitFor();
  await page.locator('#organization-name').fill(alpha);
  await page.getByRole('button', { name: /Create organization/ }).click();
  await dashboard();
  const alphaId = await page.getByRole('button', { name: 'Organization menu', exact: true }).getAttribute('data-organization-id');
  assert.ok(alphaId, 'The organization menu must identify the active organization.');
  checks.push('owner setup/login and organization dashboard');
  await page.getByRole('button', { name: 'New Scion', exact: true }).first().click();
  await page.locator('#name').fill(scionName);
  await page.locator('#category').selectOption('digital');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.locator('#description').fill('Synthetic website for onboarding integration verification.');
  await page.locator('.scion-create-actions').getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Create Scion', exact: true }).click();
  await page.getByRole('heading', { name: scionName, exact: true, level: 1 }).waitFor();
  await page.getByRole('combobox', { name: 'More Scion views' }).selectOption('graph');
  await page.getByRole('heading', { name: 'Case graph', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Update intake', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('combobox', { name: 'More Scion views' }).locator('option[value="scope"]').count(), 0);
  await snapshot('onboarding-control-surface');
  checks.push('digital Scion real case graph retained; physical action absent');
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: '+ Create agent', exact: true }).click();
  await page.getByRole('textbox', { name: 'Agent name', exact: true }).fill(`Browser Planner ${stamp}`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Choose its runtime', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await page.getByRole('heading', { name: `Browser Planner ${stamp}`, exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '+ Assign task', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: /Run now/ }).isDisabled(), true);
  checks.push('native agent configuration allowed; task assignment/execution remain unauthorized');
  await (await openOrganizationMenu()).getByRole('button', { name: 'Create another organization', exact: true }).click();
  await page.locator('#organization-name').fill(beta);
  await page.getByRole('button', { name: /Create organization/ }).click();
  await dashboard();
  const betaId = await page.getByRole('button', { name: 'Organization menu', exact: true }).getAttribute('data-organization-id');
  assert.ok(betaId, 'The organization menu must identify the newly created organization.');
  assert.notEqual(betaId, alphaId);
  assert.equal(await page.getByText(scionName, { exact: true }).count(), 0);
  await switchOrganization(page, alphaId);
  await dashboard();
  await page.locator('#main-content').getByText(scionName, { exact: true }).first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload(); await dashboard();
  await page.locator('#main-content').getByText(scionName, { exact: true }).first().waitFor();
  await snapshot('onboarding-returned-narrow');
  checks.push('organization isolation, switch back and narrow reload');

  const other = await context.newPage();
  await other.goto(base); await other.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
  await switchOrganization(other, betaId);
  await other.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
  const denied = await context.request.post(`${base}/api/scions`, {
    headers: { 'X-Grimoire-CSRF': '1', 'X-Grimoire-Organization': alphaId, 'Idempotency-Key': `stale-tab-${stamp}` },
    data: { name: 'Must never be created by a stale tab', product_category: 'digital' },
  });
  assert.equal(denied.status(), 409);
  assert.equal((await denied.json()).error.code, 'ACTIVE_ORGANIZATION_CHANGED');
  await page.bringToFront();
  await page.waitForFunction(id => document.querySelector('button[aria-label="Organization menu"]')?.getAttribute('data-organization-id') === id, betaId);
  assert.equal(await page.getByText(scionName, { exact: true }).count(), 0);
  await other.close();
  checks.push('second tab switch invalidates display; stale organization mutation denied');

  // This one injected response tests UI outage handling; all auth outcomes use the real API.
  await page.route('**/api/session', route => route.request().method() === 'DELETE'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Synthetic outage test. Retry sign out.' } }) })
    : route.continue());
  await openAccountMenu();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByText(/Sign out could not be confirmed/).waitFor();
  await openAccountMenu();
  assert.equal(await page.getByRole('button', { name: 'Sign out', exact: true }).isVisible(), true);
  await page.unroute('**/api/session');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome to Grimoire.', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'Welcome to Grimoire.', exact: true }).waitFor();
  await page.locator('#login-name').fill(login);
  await page.locator('#handler-passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await dashboard();
  checks.push('failed logout retry; real logout survives reload; sign-in restores membership');
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ passed: checks.length, checks, evidence, pageErrors }, null, 2));
} finally { await browser.close(); }
