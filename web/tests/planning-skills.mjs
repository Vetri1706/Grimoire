import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { starterSkills } from '../src/skillCatalog.ts';
import { agentInstructions } from '../../byoa/bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.GRIMOIRE_WEB_URL ?? 'http://127.0.0.1:5182';
const database = process.env.GRIMOIRE_TEST_DATABASE ?? 'grimoire_codex_flow_test';
assert.equal(process.env.GRIMOIRE_TEST_DISPOSABLE, '1');
assert.ok(database.endsWith('_test'));
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
assert.equal((await (await fetch(`${base}/api/health`)).json()).database.name, database);
const evidence = path.join(root, '.local', 'planning-skills', String(Date.now()));
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(20000);
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const suffix = randomUUID().slice(0, 8);
let organizationId, connection, task;
const headers = () => ({ 'X-Grimoire-CSRF': '1', ...(organizationId ? { 'X-Grimoire-Organization': organizationId } : {}) });
async function api(route, { method = 'GET', data, expected = 200, extra = {} } = {}) {
  const response = await context.request.fetch(`${base}/api${route}`, { method, data, headers: { ...headers(), ...extra } });
  assert.equal(response.status(), expected, `${method} ${route}: ${await response.text()}`);
  return response.json();
}
async function worker(route, data, extra = {}) {
  const response = await fetch(`${base}/api${route}`, { method: 'POST', headers: { Authorization: `Bearer ${connection.credential}`, 'Content-Type': 'application/json', 'X-Grimoire-Worker-Protocol': '2', ...extra }, body: JSON.stringify(data) });
  assert.equal(response.status, 200, route);
  return response.json();
}
async function navigate(route) { await page.goto(`${base}/#${route}`); }
async function screenshot(name) { await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled' }); }
try {
  await api('/session/signup', { method: 'POST', expected: 201, data: { login_name: `planning-${suffix}`, display_name: 'Synthetic Planning Handler', passphrase: `Synthetic-only-${randomUUID()}` } });
  const session = await api('/organizations', { method: 'POST', expected: 201, data: { name: `Synthetic Planning ${suffix}` }, extra: { 'Idempotency-Key': randomUUID() } });
  organizationId = session.active_organization.org_id;
  assert.equal(session.active_organization.can_confirm_scope, false);
  await navigate('/skills/discover');
  await page.getByRole('heading', { name: 'Discover skills', exact: true }).waitFor();
  assert.equal(await page.locator('.skills-card').count(), 3);
  await screenshot('discover-pearl');
  const item = starterSkills[0];
  await page.locator('.skills-card').filter({ hasText: item.name }).click();
  await page.getByRole('heading', { name: item.name, exact: true }).waitFor();
  assert.equal(await page.locator('.skills-instructions pre').textContent(), item.instructions);
  await page.getByText(item.source.commit, { exact: true }).waitFor();
  // Lose one response after the server commits. Retrying must replay the same
  // idempotency key, leaving exactly one installed document.
  let lost = false;
  await page.route('**/api/skills', async route => {
    if (route.request().method() === 'POST' && !lost) { lost = true; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Install skill', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await page.getByRole('button', { name: 'Install skill', exact: true }).click();
  await page.getByRole('button', { name: 'Open installed skill', exact: true }).waitFor();
  await page.unroute('**/api/skills');
  const list = await api('/skills');
  const skills = list.skills;
  assert.equal(skills.length, 1);
  const installed = skills[0];
  assert.equal(installed.config.instructions, item.instructions);
  await screenshot('reviewed-skill-installed');
  checks.push('reviewed catalog previews pinned provenance; a lost install response retries without duplicating the organization skill');

  await navigate('/agents/new');
  await page.getByLabel('Agent name', { exact: true }).fill('Synthetic product planner');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Choose its runtime', exact: true }).waitFor();
  await screenshot('agent-runtime-connection');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'Assign skills' }).click();
  await page.getByRole('checkbox', { name: item.name, exact: true }).check();
  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await page.getByRole('heading', { name: 'Synthetic product planner', exact: true }).waitFor();
  const agent = (await api('/agents')).agents[0];
  assert.deepEqual(agent.config.skill_ids, [installed.id]);
  checks.push('agent creation assigns the installed skill through the real native agent API');

  const scion = await api('/scions', { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID() }, data: { name: `Synthetic skills brief ${suffix}`, product_category: 'digital', product_description: 'Synthetic workshop booking website.', decision: 'Identify capabilities and missing evidence before choosing providers.', requirements: ['Visitors can request a class place.'], questions: ['Who handles booking requests?'], change_summary: 'Synthetic skill verification.' } });
  task = await api(`/scions/${scion.id}/agent-tasks`, { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' }, data: { task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, timeout_seconds: 120, agent_id: agent.id } });
  await navigate(`/skills/${installed.id}`);
  const changedInstructions = `${item.instructions}\n\nSYNTHETIC_REVISION_TWO: use concise wording.`;
  await page.getByRole('textbox', { name: /^Instructions/ }).fill(changedInstructions);
  await page.getByRole('button', { name: 'Save skill revision', exact: true }).click();
  await page.getByRole('heading', { name: 'Installed skills', exact: true }).waitFor();
  assert.equal((await api('/skills')).skills[0].revision, 2);

  // Enroll a disposable protocol fixture, then claim without starting any model.
  // This inspects the exact worker payload produced from PostgreSQL snapshots.
  const pairingResponse = await fetch(`${base}/api/worker-connections/pairings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_name: 'Synthetic skills protocol fixture' }) });
  assert.equal(pairingResponse.status, 201);
  const pairing = await pairingResponse.json();
  await api(`/worker-connections/pairings/${pairing.user_code}/approve`, { method: 'POST', data: { organization_id: organizationId, consent: true, policy_version: 'codex-synthetic-v1' } });
  connection = await (await fetch(`${base}/api/worker-connections/pairings/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_secret: pairing.device_secret }) })).json();
  assert.equal(connection.status, 'approved');
  await api(`/scions/${scion.id}/agent-tasks/${task.id}/dispatch`, { method: 'POST', extra: { 'If-Match': '"1"' } });
  const claimed = await worker(`/agent/tasks/${task.id}/claim`, {});
  assert.equal(claimed.agent_profile.skills[0].revision, 1);
  assert.equal(claimed.agent_profile.skills[0].instructions, item.instructions);
  const prompt = agentInstructions(claimed.agent_profile);
  assert.ok(prompt.includes(item.source.commit) && !prompt.includes('SYNTHETIC_REVISION_TWO'));
  await worker(`/agent/tasks/${task.id}/fail`, { failure_code: 'SYNTHETIC_PAYLOAD_CHECK_ONLY' }, { 'X-Grimoire-Task-Lease': claimed.lease_token });
  checks.push('editing an installed skill cannot change an assigned task; claimed worker payload and Codex prompt retain revision 1 and provenance');

  await navigate('/skills/new');
  await page.getByLabel('Name', { exact: true }).fill('Synthetic custom planning');
  await page.getByRole('textbox', { name: /^Instructions/ }).fill('界'.repeat(4001));
  assert.equal(await page.getByRole('button', { name: 'Create skill', exact: true }).isDisabled(), true);
  await page.getByText(/12,003 \/ 12,000 UTF-8 bytes/).waitFor();
  await page.getByRole('textbox', { name: /^Instructions/ }).fill('Use supplied synthetic inputs. List missing evidence. Require Handler review.');
  await page.getByRole('button', { name: 'Create skill', exact: true }).click();
  await page.getByRole('heading', { name: 'Installed skills', exact: true }).waitFor();
  await page.getByRole('button', { name: 'My Skills', exact: true }).click();
  assert.equal(await page.locator('.skills-card').count(), 2, 'A customized starter belongs with authored skills.');
  checks.push('authoring enforces UTF-8 bytes and customized starters appear with organization-authored skills');

  await navigate('/skills/discover');
  // Use the app preference control.
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  const darkButton = page.getByRole('button', { name: /Switch to.*(Midnight|dark)/i });
  if (await darkButton.count()) await darkButton.click();
  else await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await screenshot('discover-midnight');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  const colors = await page.locator('.skills-card').first().evaluate(element => {
    const style = getComputedStyle(element);
    return { foreground: style.color, background: style.backgroundColor };
  });
  const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number);
  assert.ok(rgb(colors.background).every(channel => channel < 90), 'Midnight skill cards keep a dark surface after transitions.');
  assert.ok(rgb(colors.foreground).every(channel => channel > 190), 'Midnight text keeps a bright readable foreground.');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('discover-mobile');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  checks.push('planning skills remain usable at desktop and mobile widths');

  const foreign = await browser.newContext();
  try {
    const foreignSignup = await foreign.request.post(`${base}/api/session/signup`, { headers: { 'X-Grimoire-CSRF': '1' }, data: { login_name: `planning-foreign-${suffix}`, display_name: 'Synthetic Foreign Handler', passphrase: `Synthetic-only-${randomUUID()}` } });
    assert.equal(foreignSignup.status(), 201);
    const foreignOrg = await foreign.request.post(`${base}/api/organizations`, { headers: { 'X-Grimoire-CSRF': '1', 'Idempotency-Key': randomUUID() }, data: { name: `Synthetic foreign skills ${suffix}` } });
    assert.equal(foreignOrg.status(), 201);
    const foreignId = (await foreignOrg.json()).active_organization.org_id;
    const foreignSkills = await foreign.request.get(`${base}/api/skills`, { headers: { 'X-Grimoire-Organization': foreignId } });
    assert.deepEqual((await foreignSkills.json()).skills, []);
    const denied = await foreign.request.put(`${base}/api/skills/${installed.id}`, { headers: { 'X-Grimoire-Organization': foreignId, 'X-Grimoire-CSRF': '1', 'Idempotency-Key': randomUUID(), 'If-Match': '"2"' }, data: installed.config });
    assert.equal(denied.status(), 404);
  } finally { await foreign.close(); }
  checks.push('foreign organizations cannot enumerate or edit installed skill documents');
  assert.deepEqual(errors, []);
  const report = { passed: checks.length, database, model_invoked: false, checks, evidence };
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await screenshot('failure');
  console.error((await page.locator('body').innerText()).slice(0, 3500));
  throw error;
} finally {
  if (connection?.connection_id) await api(`/worker-connections/${connection.connection_id}/revoke`, { method: 'POST', data: { organization_id: organizationId } }).catch(() => {});
  await browser.close();
}
