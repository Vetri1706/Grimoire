import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, writeFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { checkCodexLogin, connectWorker, parseArguments } from './connect.mjs'
import { childEnvironment, parseBridgeArguments } from './bridge.mjs'
import { loadConnection, pairWorker, pairingRequest, saveConnection, validateOrigin, workerConfiguration } from './connection.mjs'

const connectionId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const credential = 'a'.repeat(64), deviceSecret = 'b'.repeat(64)
const baseRecord = () => ({ version: 1, api_origin: 'https://grimoire.example', connection_id: connectionId, organization_id: organizationId, organization_name: 'Synthetic test organization', credential, adapter: 'codex_cli', policy_version: 'codex-synthetic-v1', content_class: 'synthetic_only' })

test('origin enrollment allows HTTPS or exact HTTP loopback only', () => {
  for (const origin of ['https://grimoire.example', 'https://grimoire.example:8443', 'http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']) assert.equal(validateOrigin(origin + '/'), origin)
  for (const origin of ['http://grimoire.example', 'http://127.1:8080', 'http://2130706433:8080', 'https://user:secret@grimoire.example', 'https://grimoire.example/path', 'https://grimoire.example/..', 'https://grimoire.example?destination=elsewhere', 'https://grimoire.example/#token', 'file:///tmp/credentials', ' https://grimoire.example', 'https:\\grimoire.example']) assert.throws(() => validateOrigin(origin))
})

test('legacy worker environment cannot authorize an external endpoint', async () => {
  await assert.rejects(workerConfiguration({ environment: { GRIMOIRE_API_URL: 'https://grimoire.example', GRIMOIRE_TOKEN_AGENT_A: credential } }), /LOCAL_API_REQUIRED/)
  assert.deepEqual(await workerConfiguration({ environment: { GRIMOIRE_TOKEN_AGENT_A: credential } }), { origin: 'http://127.0.0.1:8080', token: credential })
})

test('CLI arguments require an explicit origin and prohibit token or browser approval flags', () => {
  assert.deepEqual(parseArguments(['--api', 'https://grimoire.example', '--device-name', 'My laptop']), { origin: 'https://grimoire.example', deviceName: 'My laptop', watch: false })
  assert.deepEqual(parseArguments(['--watch', '--api', 'https://grimoire.example', '--device-name', 'My laptop']), { origin: 'https://grimoire.example', deviceName: 'My laptop', watch: true })
  for (const args of [['--watch', '--watch'], ['--watch', 'true']]) assert.throws(() => parseArguments(['--api', 'https://grimoire.example', ...args]))
  for (const args of [[], ['--api'], ['--token', credential], ['--api', 'https://grimoire.example', '--approve'], ['--api', 'https://grimoire.example', '--api', 'https://elsewhere.example']]) assert.throws(() => parseArguments(args))
  assert.deepEqual(parseBridgeArguments(['--connection', connectionId, '--watch']), { selector: connectionId, mode: 'watch' })
  assert.throws(() => parseBridgeArguments(['--connection', '../secret']))
  assert.throws(() => parseBridgeArguments(['--watch', '--check']))
})

test('connect starts the existing worker only after successful consent and private credential persistence', async () => {
  const order = [], visible = []
  const options = { origin: 'https://grimoire.example', deviceName: 'Synthetic laptop', watch: true }
  const result = { connectionId, organizationId, organizationName: 'Synthetic organization' }
  const dependencies = {
    checkLogin: async () => { order.push('login checked') },
    pair: async received => {
      assert.equal(received.origin, options.origin)
      assert.equal(received.deviceName, options.deviceName)
      assert.equal(received.watch, undefined)
      order.push('approved and saved')
      return result
    },
    run: async received => { order.push('worker started'); assert.deepEqual(received, { selector: connectionId, mode: 'watch' }) },
    log: line => visible.push(line),
  }
  assert.deepEqual(await connectWorker(options, dependencies), result)
  assert.deepEqual(order, ['login checked', 'approved and saved', 'worker started'])
  assert.match(visible.join('\n'), /explicitly dispatched/)
  assert.doesNotMatch(JSON.stringify(visible), new RegExp(credential))
  order.length = 0
  await connectWorker({ ...options, watch: false }, dependencies)
  assert.deepEqual(order, ['login checked', 'approved and saved'])
  for (const failure of ['PAIRING_DENIED', 'CONNECTION_FILE_NOT_PRIVATE']) {
    order.length = 0
    await assert.rejects(connectWorker(options, { ...dependencies, pair: async () => { throw new Error(failure) } }), new RegExp(failure))
    assert.deepEqual(order, ['login checked'])
  }
})

test('Codex check invokes only version/login status with no bridge, provider or deployment credentials', async () => {
  const calls = []
  const result = await checkCodexLogin({ resolve: () => 'codex-native', environment: { PATH: 'bin', HOME: '/local', CODEX_HOME: '/local/codex', GRIMOIRE_TOKEN_AGENT_A: credential, OPENAI_API_KEY: 'provider-key', AWS_SECRET_ACCESS_KEY: 'aws-key', DATABASE_URL: 'postgres-secret', GRIMOIRE_CONNECTION: connectionId }, exec: async (...args) => { calls.push(args); return { stdout: '', stderr: 'Logged in using ChatGPT' } } })
  assert.deepEqual(result, { binary_available: true, login_available: true, model_invoked: false })
  assert.deepEqual(calls.map(call => call[1]), [['--version'], ['login', 'status']])
  for (const [, , options] of calls) assert.deepEqual(options.env, { PATH: 'bin', HOME: '/local', CODEX_HOME: '/local/codex' })
  assert.doesNotMatch(JSON.stringify(calls), /provider-key|aws-key|postgres-secret|aaaaaaaa/)
  assert.deepEqual(childEnvironment({ PATH: 'bin', GRIMOIRE_DEVICE_SECRET: deviceSecret, GRIMOIRE_CONNECTION_CREDENTIAL: credential }), { PATH: 'bin' })
})

test('unauthenticated or unrecognized local Codex checks never emit provider output', async () => {
  await assert.rejects(checkCodexLogin({ resolve: () => 'codex', exec: async (_binary, args) => { if (args[0] === 'login') throw new Error(`private output ${credential}`); return {} } }), error => error.message === 'CODEX_LOGIN_REQUIRED_RUN_CODEX_LOGIN_LOCALLY')
  await assert.rejects(checkCodexLogin({ resolve: () => 'codex', exec: async () => ({ stdout: credential, stderr: '' }) }), /CODEX_LOGIN_STATUS_UNRECOGNIZED/)
})

function pairingFixture(statuses) {
  let current = Date.parse('2026-10-01T10:00:00Z')
  const calls = [], visible = [], saved = [], waits = []
  const request = async (origin, route, body) => {
    calls.push({ origin, route, body })
    if (route.endsWith('/pairings')) return { pairing_id: connectionId, user_code: 'ABCD1234ABCD1234', device_secret: deviceSecret, expires_at: new Date(current + 60000).toISOString(), poll_interval_seconds: 3, adapter: 'codex_cli', policy_version: 'codex-synthetic-v1', content_class: 'synthetic_only' }
    const next = statuses.shift() ?? { status: 'pending' }
    if (next instanceof Error) throw next
    return next
  }
  return { calls, visible, saved, waits, options: { origin: 'https://grimoire.example', deviceName: 'Test laptop', request, now: () => current, sleep: async milliseconds => { waits.push(milliseconds); current += milliseconds }, onPairing: value => visible.push(value), save: async record => saved.push(record) } }
}
function approved() { const record = baseRecord(); return { status: 'approved', ...record } }

test('human pairing publishes only user code, pins origin and saves only the approved organization credential', async () => {
  const fixture = pairingFixture([{ status: 'pending' }, approved()])
  const result = await pairWorker(fixture.options)
  assert.equal(fixture.visible[0].browserUrl, 'https://grimoire.example/#/connect-worker/ABCD1234ABCD1234')
  assert.doesNotMatch(JSON.stringify([fixture.visible, result]), /bbbbbbbb|aaaaaaaa|device_secret|credential/)
  assert.equal(fixture.saved.length, 1)
  assert.equal(fixture.saved[0].credential, credential)
  assert.equal(fixture.saved[0].organization_id, organizationId)
  assert.ok(fixture.calls.every(call => call.origin === 'https://grimoire.example'))
  assert.deepEqual(fixture.calls.slice(1).map(call => call.body), [{ device_secret: deviceSecret }, { device_secret: deviceSecret }])
  assert.ok(fixture.calls.every(call => !call.route.includes('approve')))
  assert.doesNotMatch(JSON.stringify(fixture.saved), /device_secret|bbbbbbbb/)
})

test('polls back off on network interruptions and server rate limits', async () => {
  const fixture = pairingFixture([new Error('PAIRING_NETWORK_UNAVAILABLE'), { status: 'slow_down', poll_interval_seconds: 12 }, approved()])
  await pairWorker(fixture.options)
  assert.deepEqual(fixture.waits, [3000, 6000, 12000])
})

test('expiry bounds polling; consumed or denied pairing never retries or stores a credential', async () => {
  for (const status of ['consumed', 'denied', 'expired']) {
    const fixture = pairingFixture([{ status }, approved()])
    await assert.rejects(pairWorker(fixture.options), new RegExp(`PAIRING_${status.toUpperCase()}`))
    assert.equal(fixture.calls.length, 2)
    assert.equal(fixture.saved.length, 0)
  }
  const fixture = pairingFixture([])
  await assert.rejects(pairWorker(fixture.options), /PAIRING_EXPIRED/)
  assert.equal(fixture.waits.reduce((a, b) => a + b), 60000)
  assert.equal(fixture.saved.length, 0)
})

test('approval with expanded policy or malformed credentials fails closed', async () => {
  for (const change of [{ adapter: 'shell' }, { content_class: 'private_sources' }, { policy_version: 'other' }, { credential: 'not-a-credential' }, { organization_id: '../elsewhere' }]) {
    const fixture = pairingFixture([{ ...approved(), ...change }])
    await assert.rejects(pairWorker(fixture.options), /INVALID_CONNECTION_FILE/)
    assert.equal(fixture.saved.length, 0)
  }
})

test('pairing HTTP requests use timeout, omit ambient credentials and reject redirects', async () => {
  let options
  await pairingRequest('https://grimoire.example', '/api/worker-connections/pairings/poll', { device_secret: deviceSecret }, { fetchImpl: async (_url, init) => { options = init; return new Response('{"status":"pending"}') } })
  assert.equal(options.redirect, 'error')
  assert.equal(options.credentials, 'omit')
  assert.equal(options.headers.Authorization, undefined)
  assert.ok(options.signal instanceof AbortSignal)
  await assert.rejects(pairingRequest('https://grimoire.example', '//evil.example', {}), /INVALID_PAIRING_ROUTE/)
  const result = await pairingRequest('https://grimoire.example', '/api/worker-connections/pairings/poll', {}, { fetchImpl: async () => new Response('', { status: 429, headers: { 'Retry-After': '600' } }) })
  assert.deepEqual(result, { status: 'slow_down', poll_interval_seconds: 30 })
})

test('native fetch never follows a redirect carrying the possession secret', async () => {
  let destinationCalls = 0
  const destination = createServer((_request, response) => { destinationCalls++; response.end('{}') })
  destination.listen(0, '127.0.0.1'); await once(destination, 'listening')
  const source = createServer((_request, response) => { response.writeHead(307, { Location: `http://127.0.0.1:${destination.address().port}/stolen` }); response.end() })
  source.listen(0, '127.0.0.1'); await once(source, 'listening')
  try {
    await assert.rejects(pairingRequest(`http://127.0.0.1:${source.address().port}`, '/api/worker-connections/pairings/poll', { device_secret: deviceSecret }), /PAIRING_NETWORK_UNAVAILABLE/)
    assert.equal(destinationCalls, 0)
  } finally { source.closeAllConnections(); source.close(); destination.closeAllConnections(); destination.close() }
})

test('saved enrollment has private permissions, stable organization selection and no silent overwrite', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grimoire-connection-test-'))
  try {
    const file = await saveConnection(baseRecord(), directory)
    const loaded = await loadConnection(connectionId, directory)
    assert.equal(loaded.credential, credential)
    assert.equal((await loadConnection(organizationId, directory)).connection_id, connectionId)
    const config = await workerConfiguration({ selector: connectionId, directory, environment: { GRIMOIRE_API_URL: 'https://wrong.example', GRIMOIRE_TOKEN_AGENT_A: 'wrong' } })
    assert.equal(config.origin, 'https://grimoire.example')
    assert.equal(config.token, credential)
    assert.doesNotMatch(await readFile(file, 'utf8'), /device_secret|bbbbbbbb/)
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
    await assert.rejects(saveConnection(baseRecord(), directory), /CONNECTION_ALREADY_SAVED/)
    await saveConnection({ ...baseRecord(), connection_id: '33333333-3333-4333-8333-333333333333' }, directory)
    await assert.rejects(loadConnection(organizationId, directory), /MULTIPLE_CONNECTIONS_USE_CONNECTION_ID/)
    await assert.rejects(loadConnection('../../elsewhere', directory), /CONNECTION_ID_OR_ORGANIZATION_ID_REQUIRED/)
  } finally {
    assert.equal(path.dirname(directory), os.tmpdir())
    assert.ok(path.basename(directory).startsWith('grimoire-connection-test-'))
    await rm(directory, { recursive: true, force: true })
  }
})

test('inherited or group-readable enrollment storage is rejected', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grimoire-connection-test-'))
  const unsafe = path.join(directory, 'unsafe')
  try {
    await mkdir(unsafe, { mode: 0o755 })
    await writeFile(path.join(unsafe, `${connectionId}.json`), JSON.stringify(baseRecord()), { mode: 0o644 })
    await assert.rejects(loadConnection(connectionId, unsafe), /CONNECTION_FILE_NOT_PRIVATE/)
  } finally {
    assert.equal(path.dirname(directory), os.tmpdir())
    assert.ok(path.basename(directory).startsWith('grimoire-connection-test-'))
    await rm(directory, { recursive: true, force: true })
  }
})
