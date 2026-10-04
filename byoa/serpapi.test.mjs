import test from 'node:test'
import assert from 'node:assert/strict'
import { searchSerpApi, serpapiConfigured } from './serpapi.mjs'
import { requireObservedResearchSources } from './agent-events.mjs'

const apiKey = 'test-secret-only-on-worker-123456'
const query = 'official component packaging'
const sourceUrl = 'https://www.digikey.com/en/resources'
const observedAt = '2026-10-04T12:00:00.000Z'
const result = (link = sourceUrl, title = 'Official source', snippet = 'Public search snippet.') => ({ link, title, snippet })
const payload = (results = [result()]) => ({ search_metadata: { status: 'Success', id: 'search_123' }, search_parameters: { engine: 'google', q: query }, organic_results: results })
const options = data => ({ apiKey, now: () => observedAt, fetchImpl: async () => Response.json(data) })

test('configuration requires a bounded key without whitespace or control characters', () => {
  assert.equal(serpapiConfigured({ SERPAPI_API_KEY: apiKey }), true)
  for (const value of [undefined, null, '', ' ', 'secret\n', 'bad key', 'bad\0key', 'x'.repeat(4097)]) assert.equal(serpapiConfigured({ SERPAPI_API_KEY: value }), false)
})

test('fresh Google request returns bounded observations without exposing private request fields', async () => {
  let calls = 0
  const data = payload()
  data.search_metadata.json_endpoint = `https://serpapi.com/searches/id.json?api_key=${apiKey}`
  data.extra = { api_key: apiKey }
  const output = await searchSerpApi(` ${query} `, { ...options(data), fetchImpl: async (url, init) => {
    calls++
    assert.equal(url.origin, 'https://serpapi.com')
    assert.equal(url.pathname, '/search.json')
    assert.deepEqual(Object.fromEntries(url.searchParams), { engine: 'google', q: query, api_key: apiKey, output: 'json', no_cache: 'true' })
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Accept, 'application/json')
    assert.ok(init.signal instanceof AbortSignal)
    return Response.json(data)
  } })
  assert.equal(calls, 1)
  assert.deepEqual(output, { query: { query, observed_at: observedAt, provider: 'serpapi', engine: 'google', search_id: 'search_123' }, results: [{ url: sourceUrl, title: 'Official source', snippet: 'Public search snippet.' }], observed_urls: [sourceUrl] })
  assert.ok(!JSON.stringify(output).includes(apiKey))
  requireObservedResearchSources({ sources: [{ url: sourceUrl }], candidates: [{ url: sourceUrl }] }, output)
  assert.throws(() => requireObservedResearchSources({ sources: [{ url: 'https://unobserved.org/' }], candidates: [] }, output), /UNOBSERVED_RESEARCH_SOURCE/)
})

test('invalid queries and absent keys do not call the provider', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return Response.json(payload()) }
  for (const value of ['', ' ', null, 1, 'x'.repeat(2001), 'query\0', 'query\n']) await assert.rejects(searchSerpApi(value, { apiKey, fetchImpl }), /^Error: SERPAPI_INVALID_QUERY$/)
  await assert.rejects(searchSerpApi(query, { apiKey: '', fetchImpl }), /^Error: SERPAPI_NOT_CONFIGURED$/)
  assert.equal(calls, 0)
})

test('HTTP failures have fixed messages and never retry or echo the provider body', async () => {
  for (const [status, code] of [[400, 'SERPAPI_UPSTREAM_ERROR'], [401, 'SERPAPI_AUTH_FAILED'], [403, 'SERPAPI_AUTH_FAILED'], [429, 'SERPAPI_RATE_LIMITED'], [500, 'SERPAPI_UPSTREAM_ERROR'], [503, 'SERPAPI_UPSTREAM_ERROR']]) {
    let calls = 0
    await assert.rejects(searchSerpApi(query, { apiKey, fetchImpl: async () => { calls++; return Response.json({ error: `failed ${apiKey}` }, { status }) } }), error => {
      assert.equal(error.message, code)
      assert.ok(!String(error.stack).includes(apiKey))
      assert.equal(error.cause, undefined)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('empty successful searches stay distinct from malformed and failed searches', async () => {
  const empty = payload([]); empty.error = "Google hasn't returned any results for this query."
  const missing = payload(); delete missing.organic_results
  for (const data of [empty, missing, payload([])]) {
    const output = await searchSerpApi(query, options(data))
    assert.equal(output.query.search_id, 'search_123')
    assert.deepEqual(output.results, [])
    assert.deepEqual(output.observed_urls, [])
  }
  for (const status of ['Error', 'Processing', 'Queued']) {
    const data = payload(); data.search_metadata.status = status
    await assert.rejects(searchSerpApi(query, options(data)), /SERPAPI_UPSTREAM_ERROR/)
  }
  const conflict = payload(); conflict.error = apiKey
  await assert.rejects(searchSerpApi(query, options(conflict)), /^Error: SERPAPI_UPSTREAM_ERROR$/)
  for (const data of [null, [], {}, { ...payload(), search_metadata: null }, { ...payload(), search_metadata: { status: 'Success', id: 'bad/id' } }, { ...payload(), organic_results: {} }, { ...payload(), search_parameters: { q: 'another query' } }, { ...payload(), search_parameters: { engine: 'bing', q: query } }]) await assert.rejects(searchSerpApi(query, options(data)), /SERPAPI_INVALID_RESPONSE/)
  await assert.rejects(searchSerpApi(query, { apiKey, fetchImpl: async () => new Response('{bad json') }), /SERPAPI_INVALID_RESPONSE/)
})

test('unsafe and credential-bearing URLs are skipped, links deduplicate, and returned fields are bounded', async () => {
  const unsafe = ['file:///secret', 'https://user:password@vendor.com/', 'http://127.0.0.1/', 'https://[::1]/', 'http://169.254.169.254/', 'https://supplier.local/', 'https://localhost/', 'https://vendor.com:8443/', 'https://vendor.com/?api_key=another-secret', 'https://vendor.com/?access_token=another-secret', 'https://vendor.com/?X-Amz-Signature=signature']
  const data = payload([
    ...unsafe.map(url => result(url)),
    { displayed_link: 'https://missing-link.com', title: 'No actual URL' },
    result(`${sourceUrl}#section`, 'x'.repeat(180), 'y'.repeat(1100)),
    result(sourceUrl),
    ...Array.from({ length: 10 }, (_, index) => result(`https://vendor.com/source-${index}`)),
  ])
  const output = await searchSerpApi(query, options(data))
  assert.equal(output.results.length, 8)
  assert.equal(output.results[0].url, sourceUrl)
  assert.equal(output.results[0].title.length, 160)
  assert.equal(output.results[0].snippet.length, 1000)
  assert.deepEqual(output.observed_urls, output.results.map(item => item.url))
  assert.equal(output.observed_urls.filter(url => url === sourceUrl).length, 1)
  const empty = await searchSerpApi(query, options(payload(unsafe.map(url => result(url)))))
  assert.deepEqual(empty.results, [])
  assert.deepEqual(empty.observed_urls, [])
})

test('echoed secrets in allowed output or requested query fail without returning the secret', async () => {
  const echoedId = payload(); echoedId.search_metadata.id = apiKey
  const encodedSecret = [...apiKey].map(char => `%${char.charCodeAt(0).toString(16)}`).join('')
  for (const data of [payload([result(sourceUrl, apiKey)]), payload([result(sourceUrl, 'Title', apiKey)]), payload([result(`https://vendor.com/${apiKey}`)]), payload([result(`https://vendor.com/${encodedSecret}`)]), echoedId]) {
    await assert.rejects(searchSerpApi(query, options(data)), error => error.message === 'SERPAPI_SECRET_EXPOSURE' && !error.stack.includes(apiKey))
  }
  let called = false
  await assert.rejects(searchSerpApi(`search ${apiKey}`, { apiKey, fetchImpl: async () => { called = true } }), /SERPAPI_SECRET_EXPOSURE/)
  assert.equal(called, false)
})

test('streaming response limit is enforced without relying on content-length', async () => {
  let cancelled = false
  let pulled = 0
  const body = new ReadableStream({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(262_144)) },
    cancel() { cancelled = true },
  })
  await assert.rejects(searchSerpApi(query, { apiKey, fetchImpl: async () => new Response(body) }), /SERPAPI_RESPONSE_LIMIT/)
  assert.ok(cancelled)
  assert.ok(pulled <= 7)
  await assert.rejects(searchSerpApi(query, { apiKey, fetchImpl: async () => new Response('{}', { headers: { 'content-length': '1048577' } }) }), /SERPAPI_RESPONSE_LIMIT/)
})

test('UTF-8 across stream boundaries parses while invalid bytes fail', async () => {
  const data = payload([result(sourceUrl, 'Caf\u00e9 packaging')])
  const bytes = Buffer.from(JSON.stringify(data))
  const split = bytes.indexOf(Buffer.from('\u00e9')) + 1
  const body = new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, split)); controller.enqueue(bytes.subarray(split)); controller.close() } })
  const output = await searchSerpApi(query, { ...options(data), fetchImpl: async () => new Response(body) })
  assert.equal(output.results[0].title, 'Caf\u00e9 packaging')
  await assert.rejects(searchSerpApi(query, { apiKey, fetchImpl: async () => new Response(new Uint8Array([255])) }), /SERPAPI_INVALID_RESPONSE/)
})

test('cancellation stops pending fetches and body reads without revealing abort reasons', async () => {
  const before = new AbortController(); before.abort(apiKey)
  await assert.rejects(searchSerpApi(query, { apiKey, signal: before.signal, fetchImpl: async () => assert.fail('must not fetch') }), /^Error: SERPAPI_CANCELLED$/)
  const during = new AbortController()
  let receivedSignal
  const pending = searchSerpApi(query, { apiKey, signal: during.signal, fetchImpl: async (_url, init) => {
    receivedSignal = init.signal
    during.abort(apiKey)
    return new Promise(() => {})
  } })
  await assert.rejects(pending, /^Error: SERPAPI_CANCELLED$/)
  assert.ok(receivedSignal.aborted)
  const bodyAbort = new AbortController()
  const body = new ReadableStream({ pull() { bodyAbort.abort(apiKey) } }, { highWaterMark: 0 })
  await assert.rejects(searchSerpApi(query, { apiKey, signal: bodyAbort.signal, fetchImpl: async () => new Response(body) }), /^Error: SERPAPI_CANCELLED$/)
})

test('timeout aborts a stalled provider after forty-five seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = searchSerpApi(query, { apiKey, fetchImpl: async () => new Promise(() => {}) })
  t.mock.timers.tick(45_000)
  await assert.rejects(pending, /^Error: SERPAPI_TIMEOUT$/)
})

test('transport exceptions are sanitized rather than propagated with request details', async () => {
  await assert.rejects(searchSerpApi(query, { apiKey, fetchImpl: async () => { throw new Error(`https://serpapi.com/search.json?api_key=${apiKey}`) } }), error => error.message === 'SERPAPI_NETWORK_ERROR' && !error.stack.includes(apiKey) && error.cause === undefined)
})
