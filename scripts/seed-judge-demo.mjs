import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Explicit operator seed. Public requests never allocate accounts or execute agents.
// All task outputs below are synthetic protocol fixtures, not Codex/model runs.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = Object.fromEntries(process.argv.slice(2).map((item, index, args) =>
  item.startsWith('--') ? [item.slice(2), args[index + 1]] : []).filter(pair => pair.length));
const database = options.database ?? 'grimoire_dev';
assert.ok(['grimoire_dev', 'grimoire_test'].includes(database), 'Only named local Grimoire databases are supported.');
const api = new URL(options.api ?? 'http://127.0.0.1:8080');
assert.ok(api.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname) && !api.username && !api.password,
  'Seed from the deployment host through loopback HTTP; never send seed credentials to a remote server.');
const config = Object.fromEntries(readFileSync(resolve(options.config ?? resolve(root, '.env')), 'utf8')
  .split(/\r?\n/).map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(match => [match[1], match[2]]));
assert.match(config.POSTGRES_PASSWORD ?? '', /^[a-f0-9]{64}$/);
assert.ok(Number(config.PGPORT) >= 1024 && Number(config.PGPORT) <= 65535);
const psql = options.psql ?? (process.platform === 'win32' ? resolve(root, '.tools/pgsql/bin/psql.exe') : 'psql');
const org = 'd3400000-0000-4000-8000-000000000001';
const preparer = 'd3400000-0000-4000-8000-000000000003';
const agent = 'd3400000-0000-4000-8000-000000000004';
const handlerToken = randomBytes(32).toString('hex'), agentToken = randomBytes(32).toString('hex');
const digest = value => createHash('sha256').update(value).digest('hex');
const handlerHash = digest(handlerToken), agentHash = digest(agentToken);
let credentialsCreated = false;
function sql(source) {
  const result = spawnSync(psql, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
    '-p', config.PGPORT, '-U', 'postgres', '-d', database, '-f', '-'], {
    input: `SET ROLE grimoire_migrator;\n${source}`, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PGPASSWORD: config.POSTGRES_PASSWORD, PGCLIENTENCODING: 'UTF8' }, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(`Demo database operation failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
function revokeSeedCredentials() {
  if (!credentialsCreated) return;
  sql(`UPDATE grimoire.intake_credentials SET revoked_at=clock_timestamp()
    WHERE token_sha256 IN ('${handlerHash}','${agentHash}') AND revoked_at IS NULL;`);
  credentialsCreated = false;
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    try { revokeSeedCredentials(); }
    catch { console.error('Credential cleanup could not reach PostgreSQL; temporary credentials expire after 15 minutes.'); }
    process.exit(code);
  });
}
async function call(path, { method = 'GET', body, match, asAgent = false, headers = {} } = {}) {
  const response = await fetch(new URL(`/api${path}`, api), {
    method, headers: { Authorization: `Bearer ${asAgent ? agentToken : handlerToken}`,
      ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}),
      ...(match ? { 'If-Match': `"${match}"` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
const health = await fetch(new URL('/api/health', api), { signal: AbortSignal.timeout(5000) }).then(response => response.json());
assert.equal(health.database?.name, database, 'The API and seed database must match.');
// Also bind this API to this exact database instance using the reserved org's existence.
assert.equal(sql(`SELECT count(*) FROM grimoire.organizations WHERE id='${org}' AND name='Grimoire public synthetic judge workspace';`), '1', 'Apply migration 0046 first.');
const registered = Number(sql('SELECT count(*) FROM grimoire.intake_public_demo_scenarios;'));
if (registered === 3) {
  const manifest = await fetch(new URL('/api/demo', api)).then(response => response.json());
  assert.equal(manifest.scenarios?.length, 3, 'Existing public seed is not healthy; preserve it for inspection.');
  console.log('Public synthetic judge workspace is already seeded; no records or audit events changed.');
  process.exit(0);
}
assert.equal(registered, 0, 'Partial registry found; preserve it for operator inspection.');

try {
  sql(`BEGIN;
    SELECT set_config('app.request_id',gen_random_uuid()::text,true);
    SELECT set_config('app.effective_role','local_setup',true);
    SELECT set_config('app.endpoint_scope','operator:public-synthetic-demo-seed',true);
    SELECT set_config('app.action_reason','Seed public synthetic protocol records; no provider invoked or approval granted',true);
    INSERT INTO grimoire.principals(id,org_id,external_subject,display_name) VALUES
      ('${preparer}','${org}','demo:synthetic-preparer','Synthetic demo Handler'),
      ('${agent}','${org}','demo:synthetic-protocol-agent','Synthetic protocol agent - no model executed') ON CONFLICT(id) DO NOTHING;
    INSERT INTO grimoire.principal_roles(org_id,principal_id,role) VALUES
      ('${org}','${preparer}','procurement_preparer'),('${org}','${agent}','read_only_agent') ON CONFLICT DO NOTHING;
    INSERT INTO grimoire.intake_scope_agents(org_id,principal_id) VALUES ('${org}','${agent}') ON CONFLICT DO NOTHING;
    INSERT INTO grimoire.intake_credentials(token_sha256,org_id,principal_id,label,expires_at) VALUES
      ('${handlerHash}','${org}','${preparer}','Temporary public synthetic fixture seed',clock_timestamp()+interval '15 minutes'),
      ('${agentHash}','${org}','${agent}','Temporary synthetic protocol fixture seed',clock_timestamp()+interval '15 minutes');
    COMMIT;`);
  credentialsCreated = true;
  const actor = await call('/me');
  assert.equal(actor.org_id, org, 'The API must connect to the same database instance as the seed credentials.');
  const seeded = [];
  for (const slug of ['current', 'revised', 'revoked']) {
    const draft = { name: `Synthetic judge: Workshop website - ${slug}`,
      product_description: 'PUBLIC_SYNTHETIC_JUDGE_FIXTURE: A workshop website with editable class pages and an enquiry form. All content and protocol outputs are synthetic; no model or external provider was called.',
      product_category: 'digital', decision: null, requirements: ['Handlers can edit class pages.'], questions: null,
      change_summary: 'Public synthetic judge fixture, with no human approval or real provider execution.' };
    const scion = await call('/scions', { method: 'POST', body: draft });
    const path = `/scions/${scion.id}`;
    const statement = `SYNTHETIC_JUDGE_EVIDENCE_${slug.toUpperCase()}: The workshop team needs editable class pages. This is an unverified synthetic requirement, not vendor evidence.`;
    const source = await call(`${path}/sources`, { method: 'POST', match: 1, body: {
      title: 'Synthetic internal workshop note', origin: `synthetic://public-judge/${slug}`, owner: 'Synthetic demo Handler',
      synthetic: true, source_text: statement, rights_status: 'granted', permission_basis: 'Synthetic content authored for public judging',
      permitted_use: 'scion_review', change_summary: 'Public synthetic evidence fixture',
    } });
    await call(`${path}/sources/${source.source_id}/revisions/1/claims`, { method: 'POST', body: {
      statement, locator: { start_byte: 0, end_byte: Buffer.byteLength(statement), quote: statement },
    } });
    const claims = await call(`${path}/sources/${source.source_id}/revisions/1/claims`);
    const task = await call(`${path}/agent-tasks`, { method: 'POST', match: 1, body: {
      task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, timeout_seconds: 300,
    } });
    await call(`${path}/agent-tasks/${task.id}/dispatch`, { method: 'POST', match: 1 });
    const lease = await call(`/agent/tasks/${task.id}/claim`, { method: 'POST', asAgent: true });
    const capabilities = await call(`${path}/capabilities`);
    const plan = await call(`${path}/capability-plans`, { method: 'POST', match: 1, asAgent: true,
      headers: { 'X-Grimoire-Task-Id': task.id, 'X-Grimoire-Task-Lease': lease.lease_token }, body: {
        synthetic: true, summary: 'Synthetic Codex-plan protocol example: editable workshop pages and an enquiry form. No Codex/model run occurred.',
        capabilities: [{ key: 'editing', title: 'Editable workshop pages', reason: 'The synthetic Handler requested page editing.',
          evidence_needed: ['Authorized editing requirements and a Handler decision'], connector_ids: ['handler_intake', 'scion_sources'] }],
        unresolved_gaps: capabilities.unresolved_gaps, change_summary: 'Seeded proposal protocol example; not an approval or executed model result.',
      } });
    await call(`${path}/evidence-comparisons`, { method: 'POST', match: 1, body: {
      synthetic: true, plan_id: plan.id,
      alternatives: [{ label: 'Synthetic editable-page approach', criteria: [{ capability_key: 'editing', claim_ids: [claims.claims[0].id] }] },
        { label: 'Synthetic enquiry-first approach', criteria: [{ capability_key: 'editing', claim_ids: [] }] }],
      unresolved_gaps: ['No external connector or verified vendor evidence. Handler decision remains missing.'],
      change_summary: 'Public synthetic comparison for permission and revision review.',
    } });
    await call(`/agent/tasks/${task.id}/result`, { method: 'POST', asAgent: true,
      headers: { 'X-Grimoire-Task-Lease': lease.lease_token }, body: {
        proposal_id: plan.id, provider_run_id: `synthetic-judge-protocol-${slug}-no-model`, output_sha256: digest(JSON.stringify(plan)),
        preparation_note: 'Seeded protocol completion only. No Codex, BYOA provider, or Paperclip run occurred; no approval granted.',
      } });
    if (slug === 'revised') await call(`${path}/revisions`, { method: 'POST', match: 1, body: {
      ...draft, requirements: ['Handlers can edit class pages.', 'Visitors need accessible mobile enquiry forms.'],
      change_summary: 'Synthetic requirement change: the revision-1 proposal now needs a new review.',
    } });
    if (slug === 'revoked') await call(`${path}/sources/${source.source_id}/revoke`, { method: 'POST', match: 1, body: {
      reason: 'Synthetic public demo: source permission withdrawn. Dependent content must be hidden and work blocked.',
    } });
    assert.match(scion.id, /^[a-f0-9-]{36}$/);
    seeded.push({ slug, id: scion.id });
    console.log(`Prepared ${slug} synthetic case through real API transitions; no provider invoked.`);
  }
  // Publish only once all scenarios finished. No partial seed is publicly visible.
  sql(`BEGIN; INSERT INTO grimoire.intake_public_demo_scenarios(slug,org_id,scion_id,synthetic) VALUES
    ${seeded.map(({ slug, id }) => `('${slug}','${org}','${id}',true)`).join(',\n')}; COMMIT;`);
  console.log('Published three read-only synthetic judge scenarios. Open /demo on the web frontend.');
} finally {
  // Hashes are safe in SQL; raw one-time bearer tokens existed only in memory.
  revokeSeedCredentials();
}
