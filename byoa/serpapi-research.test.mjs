import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareSerpApiResearch, searchPlanPrompt, searchPlanSchema, validateSearchPlan } from './serpapi-research.mjs'
import { codexArguments, childEnvironment, validateCandidate } from './bridge.mjs'
import { createAgentEventReader } from './agent-events.mjs'
import { workerProtocolHeaders } from './conversation.mjs'

const url = 'https://www.rust-lang.org/learn'
const candidate = { synthetic: false, objective: 'Find official Rust learning resources.', consent: true, policy_version: 'public-web-research-v1', worker_connection_id: '11111111-1111-4111-8111-111111111111', search_provider: 'serpapi' }
const query = { query: 'official Rust learning resources', observed_at: '2026-10-04T00:00:00.000Z', provider: 'serpapi', engine: 'google', search_id: 'search_123' }
const source = { url, title: 'Learn Rust', snippet: 'Official learning resources.' }
const receipt = { id: '22222222-2222-4222-8222-222222222222', url, status: 'captured', excerpt: 'Start with the Rust book.', fetched_at: query.observed_at, content_sha256: 'a'.repeat(64) }
const output = () => ({ proposal: { synthetic: false, summary: 'Official Rust learning material.', process_steps: [{ title: 'Read documentation', detail: 'The captured page links to the Rust book.', source_urls: [url] }], candidates: [], sources: [{ url, title: 'Learn Rust' }], unresolved_gaps: ['Page content remains unverified.'] }, preparation_note: 'SerpApi discovery with a captured excerpt; human review remains required.' })
function callbacks(overrides = {}) {
  return { check: async () => {}, plan: async () => ({ queries: [query.query], max_sources: 8 }), search: async () => ({ query, results: [source], observed_urls: [url] }), capture: async () => receipt, synthesize: async () => ({ output: output(), trace: { provider_run_id: 'real-model-run', queries: [], observed_urls: [] } }), ...overrides }
}

test('SerpApi is an explicit consented provider with bounded search planning', () => {
  validateCandidate(candidate, 'research_public_web')
  assert.throws(() => validateCandidate({ ...candidate, search_provider: 'unknown' }, 'research_public_web'), /INVALID_RESEARCH_CONSENT/)
  for (const plan of [{ queries: [] }, { queries: ['same', 'same'] }, { queries: ['a', 'b', 'c', 'd'] }, { queries: ['secret\nnewline'] }, { queries: ['a'], api_key: 'not accepted' }]) assert.throws(() => validateSearchPlan({ max_sources: 8, ...plan }), /INVALID_SERPAPI_PLAN/)
  for (const max_sources of [0, 9, 1.5, undefined, null, '2', true]) assert.throws(() => validateSearchPlan({ queries: [query.query], max_sources }), /INVALID_SERPAPI_PLAN/)
  assert.throws(() => validateSearchPlan({ queries: [query.query] }), /INVALID_SERPAPI_PLAN/)
  for (const max_sources of [1, 2, 8]) assert.deepEqual(validateSearchPlan({ queries: [query.query], max_sources }), { queries: [query.query], max_sources })
  assert.deepEqual(searchPlanSchema.required, ['queries', 'max_sources'])
  const prompt = searchPlanPrompt({ ...candidate, objective: 'Use at most two source pages from gov.uk.' })
  assert.match(prompt, /at most two source pages means max_sources must be at most 2/)
  assert.match(prompt, /site:gov\.uk/)
})

test('SerpApi credentials stay outside Codex and capability headers contain only availability', () => {
  const environment = { PATH: 'local-tools', SERPAPI_API_KEY: 'private-serpapi-key' }
  assert.deepEqual(childEnvironment(environment), { PATH: 'local-tools' })
  assert.equal(workerProtocolHeaders(environment)['X-Grimoire-SerpApi'], '1')
  assert.equal(workerProtocolHeaders({})['X-Grimoire-SerpApi'], undefined)
  assert.doesNotMatch(JSON.stringify(workerProtocolHeaders(environment)), /private-serpapi-key/)
})

test('SerpApi synthesis cannot silently use Codex web search', () => {
  const args = codexArguments('workspace', 'schema.json', 'output.json', 'research_public_web', 'serpapi')
  assert.ok(args.includes('web_search="disabled"'))
  assert.ok(args.includes('code_mode_host'))
  const reader = createAgentEventReader()
  assert.throws(() => reader.push(JSON.stringify({ type: 'item.started', item: { type: 'web_search', id: 'unapproved' } }) + '\n'), /UNEXPECTED_AGENT_TOOL_USE/)
})

test('provider receipts and captured evidence feed synthesis without manufactured model search events', async () => {
  let sawCapture = false
  const result = await prepareSerpApiResearch(candidate, callbacks({ capture: async () => { sawCapture = true; return receipt }, synthesize: async prompt => {
    assert.equal(sawCapture, true)
    assert.match(prompt, /Start with the Rust book/)
    assert.match(prompt, /search_123/)
    assert.match(prompt, /you did not browse or run those searches yourself/)
    return { output: output(), trace: { provider_run_id: 'real-model-run' } }
  } }))
  assert.deepEqual(result.trace.queries, [query])
  assert.deepEqual(result.trace.observed_urls, [url])
  assert.equal(result.capture_ids.get(url), receipt.id)
})

test('empty searches keep their receipts when another planned query yields useful evidence', async () => {
  const result = await prepareSerpApiResearch(candidate, callbacks({ plan: async () => ({ queries: ['empty search', query.query], max_sources: 8 }), search: async value => ({ query: { ...query, query: value }, results: value === 'empty search' ? [] : [source] }) }))
  assert.equal(result.trace.queries.length, 2)
  assert.equal(result.trace.search_calls, 2)
})

test('empty or uncapturable evidence cannot become successful research', async () => {
  let synthesized = false
  const synthesize = async () => { synthesized = true; return { output: output() } }
  await assert.rejects(prepareSerpApiResearch(candidate, callbacks({ search: async () => ({ query, results: [] }), synthesize })), /SERPAPI_NO_RESULTS/)
  await assert.rejects(prepareSerpApiResearch(candidate, callbacks({ capture: async () => ({ ...receipt, status: 'failed', excerpt: null }), synthesize })), /SERPAPI_SOURCES_UNAVAILABLE/)
  assert.equal(synthesized, false)
})

test('malformed captured receipt URLs, identifiers and hashes cannot reach synthesis', async () => {
  const invalid = [
    { url: 'https://unobserved.org/' },
    { url: `${url}#section` },
    { id: undefined },
    { id: '-'.repeat(36) },
    { id: '22222222-2222-4222-8222-22222222222z' },
    { content_sha256: undefined },
    { content_sha256: 'a'.repeat(63) },
    { content_sha256: 'a'.repeat(65) },
    { content_sha256: 'z'.repeat(64) },
  ]
  for (const change of invalid) {
    let synthesized = false
    await assert.rejects(prepareSerpApiResearch(candidate, callbacks({
      capture: async () => ({ ...receipt, ...change }),
      synthesize: async () => { synthesized = true; return { output: output() } },
    })), /^Error: INVALID_RESEARCH_CAPTURE$/)
    assert.equal(synthesized, false)
  }
})

test('synthesis cannot cite pages that were not discovered and captured', async () => {
  const forged = output(); forged.proposal.sources = [{ url: 'https://unobserved.org/', title: 'Invented source' }]; forged.proposal.process_steps = []
  await assert.rejects(prepareSerpApiResearch(candidate, callbacks({ synthesize: async () => ({ output: forged, trace: {} }) })), /UNOBSERVED_RESEARCH_SOURCE/)
  const alias = output(); alias.proposal.sources[0].url += '#section'; alias.proposal.process_steps[0].source_urls = [alias.proposal.sources[0].url]
  await assert.rejects(prepareSerpApiResearch(candidate, callbacks({ synthesize: async () => ({ output: alias, trace: {} }) })), /UNOBSERVED_RESEARCH_SOURCE/)
})

test('revoked task control prevents further search and synthesis', async () => {
  let checks = 0, searched = false
  await assert.rejects(prepareSerpApiResearch(candidate, callbacks({ check: async () => { if (++checks === 2) throw new Error('TASK_CANCELLED') }, search: async () => { searched = true } })), /TASK_CANCELLED/)
  assert.equal(searched, false)
})

test('capture selection spreads across queries, deduplicates URLs and respects eight-page budget', async () => {
  const captured = []
  await prepareSerpApiResearch(candidate, callbacks({ plan: async () => ({ queries: ['first', 'second'], max_sources: 8 }), search: async value => ({ query: { ...query, query: value }, results: Array.from({ length: 8 }, (_, index) => ({ ...source, url: index === 0 ? url : `https://rust-lang.org/${value}/${index}` })) }), capture: async value => { captured.push(value.url); return { ...receipt, url: value.url } } }))
  assert.equal(captured.length, 8)
  assert.equal(new Set(captured).size, 8)
  assert.ok(captured.includes('https://rust-lang.org/second/1'))
})

test('one- and two-page budgets limit captures across all planned searches', async () => {
  for (const max_sources of [1, 2]) {
    const captured = []
    const result = await prepareSerpApiResearch(candidate, callbacks({
      plan: async () => ({ queries: ['first', 'second'], max_sources }),
      search: async value => ({ query: { ...query, query: value }, results: Array.from({ length: 8 }, (_, index) => ({ ...source, url: value === 'first' && index === 0 ? url : `https://rust-lang.org/${value}/${index}` })) }),
      capture: async value => { captured.push(value.url); return { ...receipt, url: value.url } },
    }))
    assert.equal(captured.length, max_sources)
    assert.equal(result.trace.open_calls, max_sources)
    assert.equal(result.trace.observed_urls.length, max_sources)
    assert.equal(result.trace.search_calls, 2)
  }
})

test('failed captures consume the requested page budget without attempting replacements', async () => {
  let captured = 0, synthesized = false
  await assert.rejects(prepareSerpApiResearch(candidate, callbacks({
    plan: async () => ({ queries: [query.query], max_sources: 2 }),
    search: async () => ({ query, results: Array.from({ length: 8 }, (_, index) => ({ ...source, url: `https://rust-lang.org/${index}` })) }),
    capture: async () => { captured++; return { ...receipt, status: 'failed', excerpt: null } },
    synthesize: async () => { synthesized = true; return { output: output() } },
  })), /SERPAPI_SOURCES_UNAVAILABLE/)
  assert.equal(captured, 2)
  assert.equal(synthesized, false)
})
