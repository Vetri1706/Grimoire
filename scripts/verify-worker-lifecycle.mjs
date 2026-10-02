import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { queueResult, recoverResults } from '../byoa/outbox.mjs';
import { verifyPrivate } from '../byoa/connection.mjs';

// Real Rust API, PostgreSQL and browser-session HTTP clients. Provider execution
// is deliberately absent: completed records are labelled protocol-only fixtures.
// Task deadlines expire naturally; only the new pairing's clock is advanced.
assert.equal(process.env.GRIMOIRE_TEST_DISPOSABLE, '1');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.GRIMOIRE_TEST_API ?? 'http://127.0.0.1:8082';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const database = 'grimoire_codex_flow_test';
assert.equal((await (await fetch(`${base}/api/health`)).json()).database.name, database);
const configPath = process.env.GRIMOIRE_TEST_CONFIG ?? path.resolve(root, '../grim-integrate-onboarding/.env');
const config = Object.fromEntries((await readFile(configPath, 'utf8')).split(/\r?\n/).flatMap(line => { const match = /^([A-Z0-9_]+)=(.*)$/.exec(line); return match ? [[match[1], match[2]]] : []; }));
assert.equal(config.PGPORT, '55434'); assert.match(config.POSTGRES_PASSWORD, /^[a-f0-9]{64}$/);
const { request } = createRequire(path.join(root, 'web/package.json'))('playwright');
const human = await request.newContext(), foreign = await request.newContext();
const evidence = path.join(root, '.local', 'worker-lifecycle', String(Date.now())); await mkdir(evidence, { recursive: true });
const checks = [], connections = [], taskIds = [];
const safe = value => JSON.stringify(value, (key, val) => /credential|secret|token|lease_token/i.test(key) ? '[redacted]' : val);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const protocol = { 'X-Grimoire-Worker-Protocol': '2', 'X-Grimoire-Public-Web': '1', 'X-Grimoire-Task-Messages': '1' };
let org, foreignOrg, scion, taskA, taskB, taskC, workerA, workerB;
async function api(context, route, { method = 'GET', data, expected = 200, organization = org, headers = {} } = {}) {
  const response = await context.fetch(`${base}/api${route}`, { method, data, headers: { 'X-Grimoire-CSRF': '1', ...(organization ? { 'X-Grimoire-Organization': organization } : {}), ...headers } });
  const body = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${safe(body)}`); return body;
}
async function worker(connection, route, { method = 'GET', data, expected = 200, headers = {} } = {}) {
  const response = await fetch(`${base}/api${route}`, { method, headers: { Authorization: `Bearer ${connection.credential}`, ...protocol, ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const body = await response.json(); assert.equal(response.status, expected, `${method} ${route}: ${safe(body)}`); return body;
}
async function sql(query) {
  return new Promise((resolve, reject) => {
    const process = spawn(path.join(root, '.tools/pgsql/bin/psql.exe'), ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '55434', '-U', 'postgres', '-d', database], { cwd: root, env: { ...globalThis.process.env, PGPASSWORD: config.POSTGRES_PASSWORD, PGCLIENTENCODING: 'UTF8' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = ''; process.stdout.on('data', bytes => { output += bytes; }); process.stderr.on('data', bytes => { error += bytes; }); process.on('error', reject);
    process.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(error.replaceAll(config.POSTGRES_PASSWORD, '[redacted]')))); process.stdin.end(query);
  });
}
const checked = value => { checks.push(value); console.log(value); };
const list = () => api(human, '/worker-connections').then(value => value.connections);
const tasks = () => api(human, `/scions/${scion.id}/agent-tasks`).then(value => value.tasks);
const controls = claim => ({ 'X-Grimoire-Task-Lease': claim.lease_token });
async function restartReceiptRecovery(configuration, directory) {
  // A fresh Node process imports the shipped recovery module. The credential is
  // passed only over stdin; neither command arguments nor child logs contain it.
  const program = `
    import assert from 'node:assert/strict';
    import { recoverResults } from ${JSON.stringify(new URL('../byoa/outbox.mjs', import.meta.url).href)};
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const { configuration, directory, origin } = JSON.parse(input);
    let sends = 0;
    const recovered = await recoverResults(configuration, { directory, log() {}, send: async (route, options) => {
      assert.match(route, /^\\/api\\/agent\\/tasks\\/[a-f0-9-]{36}\\/result$/);
      assert.equal(options.method, 'POST'); sends++;
      const response = await fetch(origin + route, { method: 'POST', headers: { Authorization: 'Bearer ' + configuration.credential, 'Content-Type': 'application/json', ...options.headers }, body: JSON.stringify(options.body) });
      if (!response.ok) throw new Error('RECOVERY_HTTP_' + response.status);
      return response.json();
    } });
    console.log(JSON.stringify({ recovered, sends, model_invocations: 0 }));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { error += bytes; }); child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`Fresh receipt recovery exited ${code}: ${error.replaceAll(configuration.credential, '[redacted]')}`));
      try { resolve(JSON.parse(output.trim())); } catch (failure) { reject(failure); }
    });
    child.stdin.end(JSON.stringify({ configuration, directory, origin: base }));
  });
}
async function pair(name) {
  const pairing = await api(human, '/worker-connections/pairings', { method: 'POST', expected: 201, data: { device_name: name } });
  await api(human, `/worker-connections/pairings/${pairing.user_code}/approve`, { method: 'POST', data: { organization_id: org, consent: true, policy_version: 'codex-synthetic-v1' } });
  const connection = await api(human, '/worker-connections/pairings/poll', { method: 'POST', data: { device_secret: pairing.device_secret } });
  assert.equal(connection.status, 'approved'); connections.push(connection); return { pairing, connection };
}
async function createTask() {
  const task = await api(human, `/scions/${scion.id}/agent-tasks`, { method: 'POST', expected: 201, headers: { 'If-Match': '"1"', 'Idempotency-Key': randomUUID() }, data: { task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, timeout_seconds: 30 } });
  taskIds.push(task.id);
  await api(human, `/scions/${scion.id}/agent-tasks/${task.id}/dispatch`, { method: 'POST', data: {}, headers: { 'If-Match': '"1"' } }); return task;
}
try {
  assert.equal(await sql('SELECT current_database();'), database);
  const stamp = randomUUID().slice(0, 8);
  await api(human, '/session/signup', { method: 'POST', expected: 201, organization: null, data: { login_name: `lifecycle-${stamp}`, display_name: 'Synthetic Lifecycle Handler', passphrase: `Disposable-${randomUUID()}` } });
  org = (await api(human, '/organizations', { method: 'POST', expected: 201, organization: null, headers: { 'Idempotency-Key': randomUUID() }, data: { name: `Worker lifecycle ${stamp}` } })).active_organization.org_id;
  await api(foreign, '/session/signup', { method: 'POST', expected: 201, organization: null, data: { login_name: `lifecycle-other-${stamp}`, display_name: 'Other Synthetic Handler', passphrase: `Disposable-${randomUUID()}` } });
  foreignOrg = (await api(foreign, '/organizations', { method: 'POST', expected: 201, organization: null, headers: { 'Idempotency-Key': randomUUID() }, data: { name: `Other lifecycle ${stamp}` } })).active_organization.org_id;
  const pending = await api(human, '/worker-connections/pairings', { method: 'POST', expected: 201, data: { device_name: 'Lifecycle expiry fixture' } });
  const pendingPoll = await api(human, '/worker-connections/pairings/poll', { method: 'POST', data: { device_secret: pending.device_secret } });
  assert.equal(pendingPoll.status, 'pending'); assert.equal(pendingPoll.credential, undefined);
  await api(human, '/worker-connections/pairings/poll', { method: 'POST', expected: 429, data: { device_secret: pending.device_secret } });
  await api(human, `/worker-connections/pairings/${pending.user_code}/approve`, { method: 'POST', expected: 422, data: { organization_id: org, consent: false, policy_version: 'codex-synthetic-v1' } });
  assert.match(pending.pairing_id, /^[a-f0-9-]{36}$/);
  await sql(`UPDATE grimoire.intake_worker_pairings SET created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '10 minutes' WHERE id='${pending.pairing_id}' AND device_name='Lifecycle expiry fixture' AND approved_at IS NULL;`);
  assert.equal((await api(human, '/worker-connections/pairings/poll', { method: 'POST', data: { device_secret: pending.device_secret } })).status, 'expired');
  assert.equal((await api(human, `/worker-connections/pairings/${pending.user_code}/approve`, { method: 'POST', data: { organization_id: org, consent: true, policy_version: 'codex-synthetic-v1' } })).status, 'expired');
  checked('Real pairing endpoints enforce pending/throttle/consent and expired proofs cannot issue credentials.');

  const first = await pair('Lifecycle computer A'); workerA = first.connection;
  assert.equal((await api(human, '/worker-connections/pairings/poll', { method: 'POST', data: { device_secret: first.pairing.device_secret } })).status, 'consumed');
  const replayApproval = await api(human, `/worker-connections/pairings/${first.pairing.user_code}/approve`, { method: 'POST', data: { organization_id: org, consent: true, policy_version: 'codex-synthetic-v1' } });
  assert.equal(replayApproval.status, 'consumed'); assert.equal(replayApproval.connection_id, workerA.connection_id);
  await api(foreign, `/worker-connections/pairings/${first.pairing.user_code}`, { organization: foreignOrg, expected: 404 });
  await api(foreign, `/worker-connections/${workerA.connection_id}/revoke`, { method: 'POST', organization: foreignOrg, expected: 404, data: { organization_id: foreignOrg } });
  await api(human, `/worker-connections/pairings/${first.pairing.user_code}/approve`, { method: 'POST', organization: foreignOrg, expected: 409, data: { organization_id: foreignOrg, consent: true, policy_version: 'codex-synthetic-v1' } });
  assert.deepEqual((await api(foreign, '/worker-connections', { organization: foreignOrg })).connections, []);
  assert.equal((await list()).length, 1);
  checked('Approval/poll replay creates one connection; foreign organization cannot enumerate, approve or revoke it.');

  workerB = (await pair('Lifecycle computer B')).connection;
  assert.equal((await worker(workerA, '/agent/tasks/next')).task, null); assert.equal((await worker(workerB, '/agent/tasks/next')).task, null);
  assert.ok((await list()).every(item => item.status === 'connected' && item.active_task === null));
  scion = await api(human, '/scions', { method: 'POST', expected: 201, headers: { 'Idempotency-Key': randomUUID() }, data: { name: `Synthetic lifecycle brief ${stamp}`, product_category: 'digital', product_description: 'An invented class booking website for transport protocol tests; no model is invoked.', decision: 'Verify native worker lifecycle only.', requirements: [], questions: [], change_summary: 'Disposable no-model lifecycle fixture.' } });
  taskA = await createTask();
  await api(human, `/scions/${scion.id}/agent-tasks/${taskA.id}/dispatch`, { method: 'POST', data: {}, headers: { 'If-Match': '"1"' } });
  const claims = await Promise.all([0, 1].map(async () => {
    const response = await fetch(`${base}/api/agent/tasks/${taskA.id}/claim`, { method: 'POST', headers: { Authorization: `Bearer ${workerA.credential}`, ...protocol, 'Content-Type': 'application/json' }, body: '{}' }); return { status: response.status, body: await response.json() };
  }));
  assert.deepEqual(claims.map(value => value.status).sort(), [200, 409]); const claimedA = claims.find(value => value.status === 200).body; assert.equal(claimedA.attempt, 1);
  assert.equal((await worker(workerB, '/agent/tasks/next')).task, null);
  const busy = (await list()).find(item => item.connection_id === workerA.connection_id); assert.equal(busy.status, 'busy'); assert.equal(busy.active_task.id, taskA.id); assert.equal(busy.active_task.status, 'running'); assert.equal(busy.active_task.input, undefined);
  assert.equal((await list()).find(item => item.connection_id === workerB.connection_id).status, 'connected');
  taskB = await createTask(); assert.equal((await worker(workerB, '/agent/tasks/next')).task, null);
  checked('Duplicate dispatch/claim has one winner and one attempt; busy identifies the actual leased computer, and another dispatched task is not delivered concurrently.');

  const state = await api(human, `/scions/${scion.id}/capabilities`);
  const proposal = { synthetic: true, summary: 'Protocol fixture only, no model ran.', capabilities: [{ key: 'transport_check', title: 'Transport check', reason: 'Synthetic protocol validation.', evidence_needed: ['A real product brief and human review.'], connector_ids: ['handler_intake'] }], unresolved_gaps: state.unresolved_gaps, change_summary: 'No-model lifecycle fixture.' };
  const proposalHeaders = { ...controls(claimedA), 'X-Grimoire-Task-Id': taskA.id, 'If-Match': '"1"', 'Idempotency-Key': randomUUID() };
  const prepared = await worker(workerA, `/scions/${scion.id}/capability-plans`, { method: 'POST', expected: 201, data: proposal, headers: proposalHeaders });
  const repeated = await worker(workerA, `/scions/${scion.id}/capability-plans`, { method: 'POST', expected: 201, data: proposal, headers: proposalHeaders }); assert.equal(repeated.id, prepared.id);
  const resultBody = { proposal_id: prepared.id, provider_run_id: randomUUID(), output_sha256: '5'.repeat(64), preparation_note: 'Synthetic transport fixture; no Codex or provider execution, no approval.' };
  const receiptConfiguration = { connectionId: workerA.connection_id, organizationId: org, credential: workerA.credential };
  const receiptDirectory = path.join(evidence, 'private-state', 'pending-results', workerA.connection_id);
  const receiptFile = await queueResult(receiptConfiguration, claimedA, resultBody, receiptDirectory);
  await verifyPrivate(receiptDirectory, true); await verifyPrivate(receiptFile, false);
  await assert.rejects(recoverResults(receiptConfiguration, { directory: receiptDirectory, log() {}, send: async (route, options) => {
    assert.equal(route, `/api/agent/tasks/${taskA.id}/result`);
    await worker(workerA, route.slice(4), { method: options.method, data: options.body, headers: options.headers });
    // The API accepted the actual POST; simulate losing only its response.
    throw new Error('SIMULATED_LOST_RECEIPT_RESPONSE');
  } }), /SIMULATED_LOST_RECEIPT_RESPONSE/);
  const savedReceipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  assert.equal(savedReceipt.lease_token, claimedA.lease_token); assert.deepEqual(savedReceipt.receipt, resultBody);
  assert.equal(JSON.stringify(savedReceipt).includes(workerA.credential), false);
  await verifyPrivate(receiptFile, false);
  await worker(workerA, `/agent/tasks/${taskA.id}/result`, { method: 'POST', data: resultBody, headers: controls(claimedA) });
  await worker(workerA, `/agent/tasks/${taskA.id}/result`, { method: 'POST', expected: 409, data: { ...resultBody, preparation_note: 'Changed result cannot be acknowledged as the same receipt.' }, headers: controls(claimedA) });
  await worker(workerB, `/agent/tasks/${taskA.id}/result`, { method: 'POST', expected: 409, data: resultBody, headers: controls(claimedA) });
  assert.equal((await api(human, `/scions/${scion.id}/capabilities`)).plans.length, 1);
  const eventsA = await api(human, `/scions/${scion.id}/agent-tasks/${taskA.id}/events`); assert.equal(eventsA.events.filter(event => event.status === 'completed').length, 1);
  checked('Exact proposal and result retries return one immutable receipt; changed reply metadata and another worker are rejected.');
  checked('The actual private result outbox retains the exact original lease and receipt after a lost successful HTTP response, without storing the worker credential.');

  const claimedB = await worker(workerB, `/agent/tasks/${taskB.id}/claim`, { method: 'POST', data: {} });
  assert.equal((await list()).find(item => item.connection_id === workerB.connection_id).status, 'busy');
  await api(human, `/scions/${scion.id}/agent-tasks/${taskB.id}/cancel`, { method: 'POST', expected: 202, data: {} });
  assert.equal((await worker(workerB, `/agent/tasks/${taskB.id}/control`, { headers: controls(claimedB) })).continue, false);
  await worker(workerB, `/agent/tasks/${taskB.id}/result`, { method: 'POST', expected: 409, data: resultBody, headers: controls(claimedB) });
  await worker(workerB, `/agent/tasks/${taskB.id}/cancelled`, { method: 'POST', data: {}, headers: controls(claimedB) });
  await worker(workerB, `/agent/tasks/${taskB.id}/cancelled`, { method: 'POST', data: {}, headers: controls(claimedB) });
  assert.equal((await tasks()).find(task => task.id === taskB.id).status, 'cancelled');
  checked('Running cancellation signals stop, rejects late output, and acknowledges cancellation idempotently.');

  const beforeIdle = (await list()).find(item => item.connection_id === workerA.connection_id).last_seen;
  console.log('Waiting for real heartbeat expiry (no worker process is running).'); await pause(16000);
  const offline = (await list()).find(item => item.connection_id === workerA.connection_id); assert.equal(offline.status, 'disconnected'); assert.equal(offline.active_task, null); assert.equal(offline.last_seen, beforeIdle);
  await worker(workerA, '/agent/tasks/next');
  assert.equal((await list()).find(item => item.connection_id === workerA.connection_id).status, 'connected'); assert.equal((await list()).length, 2);
  checked('Heartbeat naturally expires; browser reads do not refresh it, and reconnect reuses the same credential without duplicate enrollment.');

  taskC = await createTask(); const claimedC = await worker(workerB, `/agent/tasks/${taskC.id}/claim`, { method: 'POST', data: {} });
  await worker(workerB, `/agent/tasks/${taskC.id}/control`, { headers: controls(claimedC) });
  assert.equal((await list()).find(item => item.connection_id === workerB.connection_id).status, 'busy');
  await api(human, `/worker-connections/${workerB.connection_id}/revoke`, { method: 'POST', data: { organization_id: org } });
  await api(human, `/worker-connections/${workerB.connection_id}/revoke`, { method: 'POST', data: { organization_id: org } });
  assert.equal((await list()).find(item => item.connection_id === workerB.connection_id).status, 'revoked');
  for (const route of ['/agent/tasks/next', `/agent/tasks/${taskC.id}/control`]) await worker(workerB, route, { expected: 401, headers: controls(claimedC) });
  await worker(workerB, `/agent/tasks/${taskC.id}/result`, { method: 'POST', expected: 401, data: resultBody, headers: controls(claimedC) });
  assert.equal((await worker(workerA, '/agent/tasks/next')).task, null);
  checked('Connection revocation immediately denies polling, controls and results for the revoked credential; no replacement work starts while its lease is outstanding.');
  console.log('Waiting for the real 30-second task plus 30-second lease grace to expire.');
  while (Date.now() <= Date.parse(claimedC.lease_until) + 100) await pause(Math.min(5000, Date.parse(claimedC.lease_until) + 150 - Date.now()));
  assert.equal((await worker(workerA, '/agent/tasks/next')).task, null);
  const expiredTask = (await tasks()).find(task => task.id === taskC.id); assert.equal(expiredTask.status, 'failed'); assert.equal(expiredTask.failure_code, 'LEASE_EXPIRED'); assert.equal(expiredTask.attempt, 1);
  assert.ok(Date.now() > Date.parse(claimedA.lease_until));
  const recovery = await restartReceiptRecovery(receiptConfiguration, receiptDirectory);
  assert.deepEqual(recovery, { recovered: 1, sends: 1, model_invocations: 0 });
  await assert.rejects(readFile(receiptFile), { code: 'ENOENT' });
  await worker(workerA, `/agent/tasks/${taskA.id}/result`, { method: 'POST', expected: 409, data: { ...resultBody, output_sha256: '6'.repeat(64) }, headers: controls(claimedA) });
  checked('Expired interrupted work becomes terminal LEASE_EXPIRED and is never redelivered; an exact completed receipt is still recoverable after its lease expires.');
  checked('A fresh Node recovery process replays one saved receipt after lease expiry, removes its private outbox file, and calls only the existing task-result endpoint.');
  const taskD = await createTask(), claimedD = await worker(workerA, `/agent/tasks/${taskD.id}/claim`, { method: 'POST', data: {} });
  await worker(workerA, `/agent/tasks/${taskD.id}/fail`, { method: 'POST', data: { failure_code: 'PROTOCOL_TEST_INTERRUPTED' }, headers: controls(claimedD) });
  await worker(workerA, `/agent/tasks/${taskD.id}/fail`, { method: 'POST', data: { failure_code: 'PROTOCOL_TEST_INTERRUPTED' }, headers: controls(claimedD) });
  await worker(workerA, `/agent/tasks/${taskD.id}/fail`, { method: 'POST', expected: 409, data: { failure_code: 'DIFFERENT_RECEIPT' }, headers: controls(claimedD) });
  assert.equal((await worker(workerA, '/agent/tasks/next')).task, null);
  await api(human, `/worker-connections/${workerA.connection_id}/revoke`, { method: 'POST', data: { organization_id: org } });
  const counts = JSON.parse(await sql(`SELECT json_build_object('connections', (SELECT count(*) FROM grimoire.intake_worker_connections WHERE org_id='${org}'),'paired_events',(SELECT count(*) FROM grimoire.intake_worker_connection_events WHERE org_id='${org}' AND event_kind='paired'),'revoked_events',(SELECT count(*) FROM grimoire.intake_worker_connection_events WHERE org_id='${org}' AND event_kind='revoked'),'plans',(SELECT count(*) FROM grimoire.intake_capability_plans WHERE scion_id='${scion.id}'),'completed_events',(SELECT count(*) FROM grimoire.intake_agent_task_events WHERE task_id='${taskA.id}' AND status='completed'));`));
  assert.deepEqual(counts, { connections: 2, paired_events: 2, revoked_events: 2, plans: 1, completed_events: 1 });
  checked('Failure acknowledgements are idempotent; persistent connection, revocation, proposal and completion counts contain no duplicated effects.');
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ status: 'PASS', database, checks, organization_id: org, scion_id: scion.id, task_ids: taskIds, connection_ids: connections.map(item => item.connection_id), counts, model_invocations: 0, fixture_kind: 'Explicit synthetic protocol records; no provider execution or approval.' }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', evidence, checks: checks.length, model_invocations: 0 }));
} catch (error) {
  await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ message: error.message, database, checks, organization_id: org, scion_id: scion?.id, task_ids: taskIds, model_invocations: 0 }, null, 2)); throw error;
} finally {
  if (scion) for (const task of await tasks().catch(() => [])) if (['queued', 'dispatched', 'running'].includes(task.status)) await api(human, `/scions/${scion.id}/agent-tasks/${task.id}/cancel`, { method: 'POST', expected: task.status === 'running' ? 202 : 200, data: {} }).catch(() => {});
  for (const connection of connections) await api(human, `/worker-connections/${connection.connection_id}/revoke`, { method: 'POST', data: { organization_id: org } }).catch(() => {});
  await human.dispose(); await foreign.dispose();
}
