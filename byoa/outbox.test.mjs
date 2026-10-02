import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { queueResult, recoverResults, validateReceipt } from './outbox.mjs'
const configuration = { connectionId: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222' }
const task = { id: '33333333-3333-4333-8333-333333333333', lease_token: '44444444-4444-4444-8444-444444444444' }
const receipt = { proposal_id: '55555555-5555-4555-8555-555555555555', provider_run_id: 'codex-public-smoke', output_sha256: 'a'.repeat(64), preparation_note: 'Synthetic preparation only; human review remains required.' }
async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grimoire-outbox-test-'))
  try { await run(directory) } finally {
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('grimoire-outbox-test-'))
    await rm(directory, { recursive: true, force: true })
  }
}
test('a process restart replays only the same private result receipt; lost acknowledgements never regenerate', async () => fixture(async directory => {
  const file = await queueResult(configuration, task, receipt, directory)
  const stored = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(stored.receipt, receipt)
  const calls = [], visible = []
  const dependencies = { directory, log: text => visible.push(text), send: async (...args) => { calls.push(args); throw new Error('WORKER_NETWORK_UNAVAILABLE') } }
  await assert.rejects(recoverResults(configuration, dependencies), /WORKER_NETWORK/)
  assert.deepEqual(await readdir(directory), [`${task.id}.json`])
  // A fresh recovery invocation loads persisted bytes, not generation state.
  assert.equal(await recoverResults(configuration, { ...dependencies, send: async (...args) => { calls.push(args); return { id: task.id, status: 'completed' } } }), 1)
  assert.deepEqual(calls[0], calls[1])
  assert.deepEqual(calls[1], [`/api/agent/tasks/${task.id}/result`, { method: 'POST', headers: { 'X-Grimoire-Task-Lease': task.lease_token }, body: receipt }])
  assert.deepEqual(await readdir(directory), [])
  assert.doesNotMatch(JSON.stringify(visible), /44444444|preparation_note|output_sha256|Synthetic preparation/)
}))
test('revocation retains private receipt without bypassing access; terminal denial never redispatches', async () => fixture(async directory => {
  await queueResult(configuration, task, receipt, directory)
  await assert.rejects(recoverResults(configuration, { directory, send: async () => { throw new Error('API_401_UNAUTHORIZED') } }), /API_401/)
  assert.equal((await readdir(directory)).length, 1)
  let calls = 0
  assert.equal(await recoverResults(configuration, { directory, log: () => {}, send: async route => { calls++; assert.ok(route.endsWith('/result')); throw new Error('API_409_CONFLICT') } }), 0)
  assert.equal(calls, 1)
  assert.deepEqual(await readdir(directory), [])
}))
test('receipts cannot cross organizations, redirect a route, or add authority', () => {
  const record = { version: 1, connection_id: configuration.connectionId, organization_id: configuration.organizationId, task_id: task.id, lease_token: task.lease_token, receipt }
  assert.equal(validateReceipt(record, configuration), record)
  assert.ok(validateReceipt({ ...record, receipt: { ...receipt, provider_run_id: null } }, configuration))
  for (const change of [{ organization_id: task.id }, { connection_id: task.id }, { task_id: '../../outside' }, { lease_token: 'bad' }, { receipt: { ...receipt, approved: true } }, { receipt: { ...receipt, preparation_note: 'x'.repeat(2001) } }, { receipt: { ...receipt, provider_run_id: 'é'.repeat(101) } }]) assert.throws(() => validateReceipt({ ...record, ...change }, configuration), /INVALID_RESULT_RECEIPT/)
})
