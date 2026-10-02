import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Real browser, Rust API, PostgreSQL and source store. Synthetic protocol results
// exercise physical/offer routing; no Codex process or external provider runs.
assert.equal(process.env.GRIMOIRE_TEST_DISPOSABLE, '1');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.GRIMOIRE_WEB_URL ?? 'http://127.0.0.1:5182';
const database = process.env.GRIMOIRE_TEST_DATABASE ?? 'grimoire_codex_flow_test';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(database.endsWith('_test'));
assert.equal((await (await fetch(`${base}/api/health`)).json()).database.name, database);
const configPath = process.env.GRIMOIRE_TEST_CONFIG ?? path.resolve(root, '../grim-integrate-onboarding/.env');
const config = Object.fromEntries((await readFile(configPath, 'utf8')).split(/\r?\n/).flatMap(line => {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line); return match ? [[match[1], match[2]]] : [];
}));
assert.equal(config.PGPORT, '55434', 'Use the existing isolated local test PostgreSQL, never the primary installation.');
assert.ok(config.POSTGRES_PASSWORD);
const psql = process.env.GRIMOIRE_TEST_PSQL ?? path.join(path.dirname(configPath), '.tools', 'pgsql', 'bin', 'psql.exe');
const evidence = path.join(root, '.local', 'task-run-inspector', String(Date.now()));
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const checks = [], errors = [], records = [];
page.on('pageerror', error => errors.push(error.message));
const stamp = randomUUID().slice(0, 8);
const workerId = randomUUID(), reviewerId = randomUUID();
const workerToken = randomBytes(32).toString('hex'), reviewerToken = randomBytes(32).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
let org, principal, seeded = false, foreignContext;
function sql(body) {
  const result = spawnSync(psql, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', config.PGPORT, '-U', 'postgres', '-d', database], {
    input: `BEGIN; SET LOCAL search_path = grimoire, public;
SELECT set_config('app.request_id',gen_random_uuid()::text,true);
SELECT set_config('app.effective_role','local_setup',true);
SELECT set_config('app.endpoint_scope','local:synthetic-task-inspector',true);
SELECT set_config('app.action_reason','Disposable synthetic browser inspector fixtures; no provider execution',true);
${body}\nCOMMIT;`, encoding: 'utf8', windowsHide: true, env: { ...process.env, PGPASSWORD: config.POSTGRES_PASSWORD },
  });
  assert.equal(result.status, 0, `Disposable fixture bootstrap failed: ${result.stderr}`);
}
async function api(route, { method = 'GET', data, expected = 200, extra = {}, bearer, client = context, organization = org } = {}) {
  const response = await client.request.fetch(`${base}/api${route}`, { method, data, headers: {
    ...(bearer ? { Authorization: `Bearer ${bearer}`, 'X-Grimoire-Worker-Protocol': '2' } : { 'X-Grimoire-CSRF': '1', ...(organization ? { 'X-Grimoire-Organization': organization } : {}) }), ...extra,
  } });
  assert.equal(response.status(), expected, `${method} ${route}: ${await response.text()}`);
  return expected === 204 ? null : response.json();
}
const mutation = (data, extra = {}) => ({ method: 'POST', expected: 201, data, extra: { 'Idempotency-Key': randomUUID(), 'If-Match': '"1"', ...extra } });
async function shot(name) { await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled' }); }
async function navigate(scionId, taskId, view = 'agent-work') {
  await page.goto(`${base}/#/scions/${scionId}/${view}/${taskId}`);
  await page.locator('.task-run-heading').waitFor();
  await page.getByRole('complementary', { name: 'Task inspector' }).waitFor();
}
async function source(scion, title, quote) {
  const prefix = 'SYNTHETIC TEST SOURCE - no production evidence.\n';
  const text = `${prefix}${quote}\n`, start = Buffer.byteLength(prefix), end = start + Buffer.byteLength(quote);
  const saved = await api(`/scions/${scion.id}/sources`, mutation({ title, origin: `synthetic://task-inspector/${stamp}`, owner: 'Synthetic browser fixture author', synthetic: true, source_text: text, rights_status: 'granted', permission_basis: 'Synthetic author permits disposable local tests.', permitted_use: 'scion_review', change_summary: 'Synthetic inspector source.' }));
  const route = `/scions/${scion.id}/sources/${saved.source_id}`;
  await api(`${route}/revisions/1/claims`, mutation({ statement: quote, locator: { start_byte: start, end_byte: end, quote } }));
  const claims = await api(`${route}/revisions/1/claims`);
  return { source_id: saved.source_id, source_revision: 1, claim_id: claims.claims[0].id, content_sha256: hash(text), start_byte: start, end_byte: end };
}
async function queue(scion, kind, candidate, agent) {
  const task = await api(`/scions/${scion.id}/agent-tasks`, mutation({ task_kind: kind, candidate_proposal: candidate, timeout_seconds: 300, agent_id: agent.id }));
  records.push({ scion_id: scion.id, task_id: task.id }); return task;
}
async function complete(scion, task, candidate, proposalRoute) {
  await api(`/scions/${scion.id}/agent-tasks/${task.id}/dispatch`, { method: 'POST', data: {}, extra: { 'If-Match': '"1"' } });
  const claimed = await api(`/agent/tasks/${task.id}/claim`, { method: 'POST', data: {}, bearer: workerToken });
  const proposal = await api(`/scions/${scion.id}/${proposalRoute}`, { ...mutation(candidate, { 'X-Grimoire-Task-Id': task.id, 'X-Grimoire-Task-Lease': claimed.lease_token }), bearer: workerToken });
  const result = await api(`/agent/tasks/${task.id}/result`, { method: 'POST', bearer: workerToken, data: { proposal_id: proposal.id, provider_run_id: 'synthetic-task-inspector-protocol-no-model', output_sha256: hash(JSON.stringify(candidate)), preparation_note: 'Synthetic browser protocol fixture. No model ran; no human approval is supplied by completion.' }, extra: { 'X-Grimoire-Task-Lease': claimed.lease_token } });
  assert.equal(result.status, 'completed'); assert.equal(proposal.confirmation, null); return proposal;
}
try {
  await api('/session/signup', { method: 'POST', expected: 201, data: { login_name: `inspector-${stamp}`, display_name: 'Synthetic Inspector Handler', passphrase: `Synthetic-only-${randomUUID()}` } });
  const session = await api('/organizations', mutation({ name: `Synthetic task inspector ${stamp}` }));
  org = session.active_organization.org_id; principal = session.active_organization.principal_id;
  for (const id of [org, principal, workerId, reviewerId]) assert.match(id, /^[a-f0-9-]{36}$/);
  // Same minimum local_setup role/credential seeding as db/local-handlers.sql
  // and db/local-scope-actors.sql, restricted to this newly-created test org.
  sql(`INSERT INTO principal_roles(org_id,principal_id,role) VALUES ('${org}','${principal}','procurement_preparer');
INSERT INTO principals(id,org_id,external_subject,display_name) VALUES
('${workerId}','${org}','synthetic:inspector-worker:${stamp}','Synthetic inspector protocol worker'),
('${reviewerId}','${org}','synthetic:inspector-reviewer:${stamp}','Synthetic inspector scope reviewer');
INSERT INTO principal_roles(org_id,principal_id,role) VALUES ('${org}','${workerId}','read_only_agent'),('${org}','${reviewerId}','engineering_reviewer');
INSERT INTO intake_scope_agents(org_id,principal_id) VALUES ('${org}','${workerId}');
INSERT INTO intake_scope_reviewers(org_id,principal_id) VALUES ('${org}','${reviewerId}');
INSERT INTO intake_credentials(token_sha256,org_id,principal_id,label) VALUES
('${hash(workerToken)}','${org}','${workerId}','Disposable inspector protocol worker'),
('${hash(reviewerToken)}','${org}','${reviewerId}','Disposable inspector synthetic reviewer');`);
  seeded = true;
  assert.equal((await api('/session')).active_organization.can_propose_scope, true);
  const agent = await api('/agents', mutation({ name: `Synthetic physical planner ${stamp}`, role: 'planner', title: 'Physical scope preparation', capabilities: 'Prepare synthetic proposals only.', instructions: 'Preserve exact source references and human review gates.', reports_to: null, adapter: 'codex_cli', timeout_seconds: 300, skill_ids: [], paused: false }));
  const scion = await api('/scions', mutation({ name: `Synthetic enclosure ${stamp}`, product_category: 'physical', product_description: 'Synthetic controlled enclosure for browser task routing.', decision: 'Inspect synthetic physical scope and offer normalization.', requirements: ['Width 120 mm.'], questions: [], change_summary: 'Disposable task inspector fixture.' }));
  const candidate = { synthetic: true, identity_match: 'exact', configuration: { product_code: `SYN-P-${stamp}`, product_name: 'Synthetic enclosure', configuration_code: 'SYN-CFG-A', specification: { enclosure: 'Synthetic controlled enclosure configuration' } }, component: { internal_part_code: `SYN-C-${stamp}`, manufacturer: 'Synthetic manufacturer', part_number: 'SYN-PART-001', attributes: { material: 'synthetic aluminum' } }, occurrence: { path: '/synthetic/enclosure[1]', quantity: '1', uom: 'EA' }, requirement: { code: 'SYN-WIDTH-001', criteria: { target_width_mm: 120 } }, case_code: `SYN-CASE-${stamp}`, case_title: 'Synthetic inspector enclosure', unresolved_gaps: [], change_summary: 'Synthetic scope preparation for separate review.', source_claims: [] };
  for (const [kind, quote] of Object.entries({ configuration: `Configuration: product SYN-P-${stamp}, Synthetic enclosure, configuration SYN-CFG-A; specification Synthetic controlled enclosure configuration.`, component: `Component: SYN-C-${stamp}, manufacturer Synthetic manufacturer, part SYN-PART-001; material synthetic aluminum.`, occurrence: 'Exact BOM occurrence: /synthetic/enclosure[1], quantity 1, unit EA; uses the named configuration and component above.', requirement: 'Requirement: SYN-WIDTH-001, target_width_mm = 120 for this exact enclosure occurrence.' })) candidate.source_claims.push({ kind, ...await source(scion, `SYNTHETIC ${kind} ${stamp}`, quote) });
  const physicalTask = await queue(scion, 'prepare_physical_scope', candidate, agent);
  const physicalProposal = await complete(scion, physicalTask, candidate, 'scope/proposals');
  await navigate(scion.id, physicalTask.id);
  await page.locator('.task-run-heading').getByRole('heading', { name: 'Prepare physical scope' }).waitFor();
  const inspector = page.getByRole('complementary', { name: 'Task inspector' });
  assert.equal(await inspector.locator('[data-avatar-identity]').count(), 1);
  await inspector.getByRole('tab', { name: 'Artifacts', exact: true }).click();
  await inspector.getByRole('button', { name: /Physical scope proposal/ }).click();
  await page.waitForURL(url => url.hash === `#/scions/${scion.id}/scope/${physicalProposal.id}`);
  await page.locator('.scope-proposals').waitFor();
  checks.push('Focused physical task and its recorded artifact open the canonical scope page');

  await api(`/scions/${scion.id}/scope/proposals/${physicalProposal.id}/confirm`, { ...mutation({ confirm_synthetic_scope: true, review_note: 'Separate synthetic reviewer checks exact authored fixture references; no real sourcing approval.' }), bearer: reviewerToken });
  const offerIds = [];
  for (const suffix of ['A', 'B']) {
    const offer = { synthetic: true, scion_revision: 1, scope_proposal_id: physicalProposal.id, supplier: { legal_name: `Synthetic supplier ${suffix}`, jurisdiction: 'SYNTHETIC-US-DE', registration_ref: `SYN-REG-${stamp}-${suffix}`, site_code: `SYN-SITE-${stamp}-${suffix}`, country_code: 'US', account_ref: `SYN-ACCOUNT-${stamp}-${suffix}` }, offer_ref: `SYN-QUOTE-${stamp}-${suffix}`, identity_match: 'exact', offered_manufacturer: 'Synthetic manufacturer', offered_part_number: 'SYN-PART-001', quantity: '2', uom: 'EA', unit_price: '12.50', currency: 'USD', destination: 'Synthetic test lab', incoterm: 'EXW', payment_terms: 'Synthetic net 30', quoted_at: '2026-09-26T00:00:00Z', valid_from: '2026-09-26T00:00:00Z', valid_until: '2026-10-26T00:00:00Z', lead_time_days: 7, change_summary: 'Synthetic quote for disposable browser test.' };
    offer.source = await source(scion, `SYNTHETIC quote ${suffix} ${stamp}`, JSON.stringify(offer));
    offerIds.push((await api(`/scions/${scion.id}/offers`, mutation(offer))).revision.id);
  }
  const normalization = { synthetic: true, scope_proposal_id: physicalProposal.id, offer_revision_ids: offerIds, basis: { quantity: '2', uom: 'EA', currency: 'USD', destination: 'Synthetic test lab', incoterm: 'EXW', payment_terms: 'Synthetic net 30', as_of: '2026-09-26T00:00:00Z', valid_from: '2026-09-26T00:00:00Z', valid_until: '2026-10-01T00:00:00Z' }, change_summary: 'Synthetic exact comparison, no commercial approval.' };
  const offerTask = await queue(scion, 'prepare_offer_normalization', normalization, agent);
  const offerProposal = await complete(scion, offerTask, normalization, 'comparisons/proposals');
  await navigate(scion.id, offerTask.id, 'tasks');
  await page.locator('.task-run-heading').getByRole('heading', { name: 'Prepare supplier offer worksheet' }).waitFor();
  await inspector.getByRole('tab', { name: 'Artifacts', exact: true }).click();
  await inspector.getByRole('button', { name: /Offer normalization proposal/ }).click();
  await page.waitForURL(url => url.hash === `#/scions/${scion.id}/offers/${offerProposal.id}`);
  await page.locator('.offers-workspace').waitFor();
  checks.push('Focused normalization task opens its canonical offer artifact; completion supplied no confirmation');

  await navigate(scion.id, offerTask.id);
  await inspector.getByRole('tab', { name: 'Tasks', exact: true }).click();
  await inspector.getByRole('button', { name: /Prepare physical scope/ }).click();
  await page.waitForURL(url => url.hash.endsWith(`/agent-work/${physicalTask.id}`));
  await page.locator('.task-run-heading').getByRole('heading', { name: 'Prepare physical scope' }).waitFor();
  await page.getByRole('button', { name: 'Close task inspector' }).click();
  assert.equal(await inspector.count(), 0);
  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  await inspector.waitFor(); await shot('physical-inspector-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await shot('physical-inspector-mobile'); await page.setViewportSize({ width: 1600, height: 1000 });
  checks.push('Real same-Scion peer selection, inspector close/reopen, and mobile layout work');

  foreignContext = await browser.newContext();
  await api('/session/signup', { client: foreignContext, organization: null, method: 'POST', expected: 201, data: { login_name: `foreign-inspector-${stamp}`, display_name: 'Synthetic Foreign Handler', passphrase: `Synthetic-only-${randomUUID()}` } });
  const foreignOrg = (await api('/organizations', { ...mutation({ name: `Foreign inspector ${stamp}` }), client: foreignContext, organization: null })).active_organization.org_id;
  const foreignScion = await api('/scions', { ...mutation({ name: `Foreign private task ${stamp}`, product_category: 'digital', product_description: 'Synthetic foreign brief.', decision: 'Prepare hypotheses.', requirements: [], questions: [], change_summary: 'Foreign isolation test.' }), client: foreignContext, organization: foreignOrg });
  const foreignTask = await api(`/scions/${foreignScion.id}/agent-tasks`, { ...mutation({ task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, timeout_seconds: 120 }), client: foreignContext, organization: foreignOrg });
  for (const id of [randomUUID(), foreignTask.id]) {
    await page.goto(`${base}/#/scions/${scion.id}/agent-work/${id}`);
    await page.getByRole('heading', { name: 'Task could not be matched to the current case' }).waitFor();
    assert.equal(await page.locator('.task-run-heading, .task-side-panel, .scope-task-list').count(), 0);
    assert.ok(!(await page.locator('body').innerText()).includes(foreignScion.revision.name));
  }
  await api(`/scions/${foreignScion.id}/agent-tasks`, { expected: 404 });
  checks.push('Missing and foreign task IDs never fall back to another task; foreign API scope is denied');

  const staleTask = await queue(scion, 'prepare_physical_scope', candidate, agent);
  await navigate(scion.id, physicalTask.id);
  await api(`/scions/${scion.id}/sources/${candidate.source_claims[0].source_id}/revoke`, mutation({ reason: 'Synthetic source permission revoked while its task inspector remains open.' }));
  const revokedScope = await api(`/scions/${scion.id}/scope/proposals/${physicalProposal.id}`);
  const revokedOffer = await api(`/scions/${scion.id}/comparisons/proposals/${offerProposal.id}`);
  assert.equal(revokedScope.input, null); assert.equal(revokedOffer.input, null); assert.equal(revokedOffer.snapshot, null);
  await page.locator('.task-run-heading').waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes(`SYNTHETIC configuration ${stamp}`));
  await inspector.getByRole('tab', { name: 'Artifacts', exact: true }).click();
  await inspector.getByRole('button', { name: /Physical scope proposal/ }).click();
  await page.waitForURL(url => url.hash === `#/scions/${scion.id}/scope/${physicalProposal.id}`);
  await page.locator('.scope-proposals').waitFor();
  assert.ok(!(await page.locator('.scope-proposals').innerText()).includes(`SYN-P-${stamp}`));
  checks.push('Source revocation hides physical and offer inputs; canonical artifact navigation preserves redaction');
  await api(`/scions/${scion.id}/revisions`, mutation({ ...scion.revision, number: undefined, created_at: undefined, created_by: undefined, change_summary: 'Synthetic revision to verify stale-task cancellation.' }));
  await navigate(scion.id, staleTask.id);
  await page.getByText('This task uses an older revision', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Dispatch task', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Cancel task', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await page.locator('.task-run-heading .task-status').filter({ hasText: 'Cancelled' }).waitFor();
  checks.push('Stale work cannot dispatch, but the authorized Handler can cancel it');

  await context.setOffline(true);
  await page.getByRole('heading', { name: 'Task details are unavailable' }).waitFor();
  assert.equal(await inspector.count(), 0); assert.equal(await page.locator('.scope-task-list').count(), 0);
  await context.setOffline(false);
  await page.locator('.task-run-heading').waitFor();
  assert.deepEqual(errors, []);
  checks.push('Connection loss clears task details and controls, then fresh access restores them');
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ status: 'PASS', database, checks, records, provider_calls: 0, protocol_results: 2, browser_errors: errors }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', evidence, checks: checks.length, provider_calls: 0 }));
} catch (error) {
  await shot('failure').catch(() => {});
  await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ message: error.message, checks, records, browser_errors: errors }, null, 2));
  throw error;
} finally {
  if (seeded) sql(`UPDATE intake_credentials SET revoked_at=clock_timestamp() WHERE org_id='${org}' AND principal_id IN ('${workerId}','${reviewerId}');
DELETE FROM principal_roles WHERE org_id='${org}' AND principal_id='${principal}' AND role='procurement_preparer';`);
  await api('/session/logout', { method: 'POST', data: {}, expected: 204 }).catch(() => {});
  await foreignContext?.close(); await browser.close();
}
