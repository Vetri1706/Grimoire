import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { supportedNode, stateDirectory } from './state.mjs'
import { parseCliArguments, selectConnection, explainError } from './cli.mjs'
import { openPairingPage } from './browser.mjs'
import { workerRequest, validateTaskEnvelope } from './bridge.mjs'

test('Node support includes Node 26.3 and stays bounded; state is independent of package and current directory', () => {
  for (const version of ['22.16.0', '22.99.0', '24.0.0', '24.21.0', '26.3.0', '26.10.0']) assert.equal(supportedNode(version), true)
  for (const version of ['18.20.0', '22.15.0', '23.1.0', '25.0.0', '26.2.0', '27.0.0', '24.0.0-beta', 'garbage']) assert.equal(supportedNode(version), false)
  assert.equal(stateDirectory({ GRIMOIRE_CONNECTOR_HOME: path.resolve('test-state') }), path.resolve('test-state'))
  assert.throws(() => stateDirectory({ GRIMOIRE_CONNECTOR_HOME: './relative' }), /ABSOLUTE/)
  const home = path.resolve('fake-user')
  assert.equal(stateDirectory({}, 'linux', home), path.join(home, '.local', 'state', 'grimoire'))
})
test('CLI cannot accept tokens, shell commands, ambiguous enrollment or arbitrary connection selectors', async () => {
  assert.deepEqual(parseCliArguments(['--api', 'https://example.com', '--watch']), { watch: true, browser: true, origin: 'https://example.com' })
  for (const args of [['--token', 'secret'], ['--command', 'evil'], ['--connection', '../secret'], ['--api', 'x', '--api', 'y'], ['--connection', '11111111-1111-4111-8111-111111111111', '--pair']]) assert.throws(() => parseCliArguments(args))
  const records = [{ connectionId: 'one' }, { connectionId: 'two' }]
  await assert.rejects(selectConnection(records, { terminal: false }), /SELECT_CONNECTION/)
  assert.deepEqual(await selectConnection(records, { terminal: true, ask: async () => '2', log: () => {} }), records[1])
  await assert.rejects(selectConnection(records, { terminal: true, ask: async () => '0', log: () => {} }), /SELECT_CONNECTION/)
  assert.doesNotMatch(explainError(new Error('private user data sk-secret')), /private user data|sk-secret/)
})
test('browser receives only the pinned human pairing URL as data and no ambient credentials', async () => {
  const calls = []
  const origin = 'https://grimoire.example'
  const url = `${origin}/#/connect-worker/ABCD1234ABCD1234`
  await openPairingPage(url, origin, { platform: 'win32', environment: { SystemRoot: 'C:\\Windows', AWS_SECRET_ACCESS_KEY: 'never', GRIMOIRE_TOKEN_AGENT_A: 'never' }, exec: async (...args) => calls.push(args) })
  assert.equal(calls[0][2].env.GRIMOIRE_PAIRING_URL, url)
  assert.doesNotMatch(JSON.stringify(calls[0][1]), /grimoire\.example/)
  assert.doesNotMatch(JSON.stringify(calls), /never/)
  for (const value of ['https://evil.example/#/connect-worker/ABCD1234ABCD1234', `${origin}/#/connect-worker/secret&calc`, `${origin}/?token=secret`]) await assert.rejects(openPairingPage(value, origin))
  assert.equal(await openPairingPage(url, origin, { platform: 'linux', exec: async () => { throw new Error('no desktop') } }), false)
})
test('network recovery retries only reads and idempotent effects; claims are never silently repeated', async () => {
  const token = 'local-credential'
  for (const route of ['/api/agent/tasks/one/claim', '/api/unrepeatable']) {
    let calls = 0
    await assert.rejects(workerRequest('https://grimoire.example', token, route, { method: 'POST', body: {}, fetchImpl: async () => { calls++; throw new Error('lost response') }, sleep: async () => {} }), /WORKER_NETWORK_UNAVAILABLE/)
    assert.equal(calls, 1)
  }
  for (const [route, headers] of [['/api/agent/tasks/one/result', {}], ['/api/scions/one/capability-plans', { 'Idempotency-Key': 'same-task-proposal' }]]) {
    const calls = []
    const body = { proposal_id: 'same' }
    const response = await workerRequest('https://grimoire.example', token, route, { method: 'POST', body, headers, sleep: async () => {}, fetchImpl: async (_url, init) => { calls.push(init); if (calls.length === 1) throw new Error('lost acknowledgement'); return new Response('{"ok":true}') } })
    assert.deepEqual(response, { ok: true })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].body, calls[1].body)
    assert.deepEqual(calls[0].headers, calls[1].headers)
    assert.equal(calls[0].redirect, 'error')
  }
})
test('revocation and control loss never retry or leak response body', async () => {
  let calls = 0
  await assert.rejects(workerRequest('https://grimoire.example', 'secret', '/api/me', { fetchImpl: async () => { calls++; return new Response('{"error":{"code":"secret user data"}}', { status: 401 }) } }), /API_401_FAILED/)
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(workerRequest('https://grimoire.example', 'secret', '/api/agent/tasks/one/control', { timeoutMs: 2500, fetchImpl: async () => { calls++; throw new Error('private error') } }), /WORKER_NETWORK_UNAVAILABLE/)
  assert.equal(calls, 1)
})
test('a claim cannot redirect receipt paths or execute a different task', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const task = { id, scion_id: '22222222-2222-4222-8222-222222222222', lease_token: '33333333-3333-4333-8333-333333333333', scion_revision: 1, adapter: 'codex_cli', status: 'running', task_kind: 'prepare_capability_plan', timeout_seconds: 30, execution_deadline: new Date(Date.now() + 30000).toISOString(), lease_until: new Date(Date.now() + 60000).toISOString() }
  assert.equal(validateTaskEnvelope(task, id), task)
  for (const change of [{ id: '../../connections/leak' }, { id: task.scion_id }, { lease_token: 'missing' }, { scion_id: '../outside' }, { scion_revision: '1' }, { task_kind: 'shell' }, { adapter: 'shell' }, { status: 'dispatched' }, { lease_until: 'yesterday' }]) assert.throws(() => validateTaskEnvelope({ ...task, ...change }, id))
})
