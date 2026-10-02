import test from 'node:test'
import assert from 'node:assert/strict'
import { codexArguments, prohibitedAgentEvent, outputSchema, validateCandidate, validateOutput } from './bridge.mjs'
import { createAgentEventReader, requireObservedResearchSources } from './agent-events.mjs'
import { publicResearchUrl, researchKind } from './research.mjs'

const connection = '11111111-1111-4111-8111-111111111111'
const url = 'https://www.digikey.com/en/resources'
const input = () => ({ synthetic: false, objective: 'Research public component packaging information.', consent: true, policy_version: 'public-web-research-v1', worker_connection_id: connection })
const output = () => ({ proposal: { synthetic: false, summary: 'Public research leads for review.', process_steps: [{ title: 'Review packaging', detail: 'Check the packaging required by assembly before seeking a quote.', source_urls: [url] }], candidates: [{ name: 'Public supplier lead', url, rationale: 'A lead requiring qualification.', source_urls: [url] }], sources: [{ url, title: 'Official public information' }], unresolved_gaps: ['Supplier suitability and current availability remain unverified.'] }, preparation_note: 'Public-page findings; human review required, no sourcing approval.' })
const feed = (reader, event) => reader.push(Buffer.from(JSON.stringify(event) + '\n'))
const begin = reader => { feed(reader, { type: 'thread.started', thread_id: 'public-smoke' }); feed(reader, { type: 'turn.started' }) }
const search = (id = 'search-1', query = 'official component packaging') => ({ type: 'item.completed', item: { id, type: 'web_search', query, action: { type: 'search', query }, results: [{ type: 'text_result', url, ref_id: 'turn0search0', title: 'Official source' }] } })
const finish = reader => { feed(reader, { type: 'turn.completed', usage: {} }); return reader.finish() }

test('research needs exact separate consent, policy and selected computer', () => {
  validateCandidate(input(), researchKind)
  for (const change of [{ consent: false }, { synthetic: true }, { policy_version: 'codex-synthetic-v1' }, { worker_connection_id: 'anything' }, { objective: '' }, { private_scion: 'not permitted' }]) {
    assert.throws(() => validateCandidate({ ...input(), ...change }, researchKind), /INVALID_RESEARCH_CONSENT/)
  }
  assert.throws(() => validateCandidate(input(), 'prepare_capability_plan'), /INVALID_CAPABILITY_CANDIDATE/)
})

test('only research enables hosted live search and its necessary orchestration host', () => {
  for (const kind of ['prepare_capability_plan', 'prepare_physical_scope', 'prepare_offer_normalization', researchKind]) {
    const args = codexArguments('workspace', 'schema.json', 'output.json', kind)
    const disabled = args.flatMap((value, i) => value === '--disable' ? [args[i + 1]] : [])
    for (const tool of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'multi_agent', 'browser_use', 'computer_use']) assert.ok(disabled.includes(tool), `${kind}: ${tool} stays disabled`)
    assert.ok(args.includes('read-only'))
    assert.ok(args.includes('approval_policy="never"'))
    assert.ok(args.includes(`web_search="${kind === researchKind ? 'live' : 'disabled'}"`))
    assert.equal(disabled.includes('code_mode_host'), kind !== researchKind)
    assert.ok(args.includes('--ignore-user-config'))
  }
})

test('research reports accept bounded linked leads but reject invented authority and citations', () => {
  validateOutput(input(), output(), researchKind)
  const unknown = output(); unknown.proposal.approved = true
  assert.throws(() => validateOutput(input(), unknown, researchKind), /INVALID_RESEARCH_REPORT/)
  const bad = output(); bad.proposal.process_steps[0].source_urls = ['https://unobserved.org/source']
  assert.throws(() => validateOutput(input(), bad, researchKind), /INVALID_RESEARCH_CITATION/)
  const unlisted = output(); unlisted.proposal.candidates[0].url = 'https://www.digikey.com/'
  assert.throws(() => validateOutput(input(), unlisted, researchKind), /INVALID_RESEARCH_CITATION/)
  const variant = output(); variant.proposal.candidates[0].url += '#section'
  assert.throws(() => validateOutput(input(), variant, researchKind), /INVALID_RESEARCH_CITATION/)
  const duplicate = output(); duplicate.proposal.sources.push({ url: `${url}#other`, title: 'Same resource' })
  assert.throws(() => validateOutput(input(), duplicate, researchKind), /DUPLICATE_RESEARCH_SOURCE/)
  const empty = output(); empty.proposal.sources = []
  assert.throws(() => validateOutput(input(), empty, researchKind), /INVALID_RESEARCH_REPORT/)
  const schema = outputSchema(input(), researchKind)
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.properties.proposal.properties.synthetic.enum, [false])
})

test('research URLs exclude private literals, credentials and nonweb schemes before capture', () => {
  assert.equal(publicResearchUrl(`${url}#packaging`), url)
  for (const value of ['file:///secret', 'https://user:secret@vendor.com/', 'http://127.0.0.1/', 'https://[::1]/', 'http://169.254.169.254/', 'https://supplier.local/', 'https://localhost/', 'https://vendor.com:8443/', 'https://vendor.com\\@127.0.0.1/', 'http://2130706433/']) assert.throws(() => publicResearchUrl(value), /INVALID_RESEARCH_URL/)
})

test('observed CLI placeholders and completed snake-case web actions produce bounded trace metadata', () => {
  const reader = createAgentEventReader({ kind: researchKind, now: () => '2026-10-02T00:00:00.000Z' }); begin(reader)
  feed(reader, { type: 'item.started', item: { id: 'search-1', type: 'web_search', query: '', action: { type: 'other' } } })
  feed(reader, search()); feed(reader, search())
  feed(reader, { type: 'item.completed', item: { id: 'open-1', type: 'web_search', query: url, action: { type: 'open_page', url }, results: [{ type: 'text_result', url, ref_id: 'turn1view0', snippet: 'not persisted' }] } })
  const trace = finish(reader)
  assert.deepEqual(trace.queries, [{ query: 'official component packaging', observed_at: '2026-10-02T00:00:00.000Z' }])
  assert.deepEqual(trace.observed_urls, [url]); assert.equal(trace.search_events, 2)
  assert.doesNotMatch(JSON.stringify(trace), /snippet|not persisted/)
  requireObservedResearchSources(output().proposal, trace)
  const forged = output(); forged.proposal.sources[0].url = 'https://unobserved.org/source'
  assert.throws(() => requireObservedResearchSources(forged.proposal, trace), /UNOBSERVED_RESEARCH_SOURCE/)
})

test('every tool lifecycle rejects execution, mutation, browser, MCP and unknown tool types', () => {
  for (const type of ['item.started', 'item.updated', 'item.completed']) {
    for (const itemType of ['command_execution', 'file_change', 'mcp_tool_call', 'browser', 'unexpected_tool']) {
      const event = { type, item: { id: 'forbidden', type: itemType } }
      assert.equal(prohibitedAgentEvent(event, researchKind), true)
      assert.throws(() => feed(createAgentEventReader({ kind: researchKind }), event), /UNEXPECTED_AGENT_TOOL_USE/)
    }
    assert.equal(prohibitedAgentEvent({ type, item: { id: 'search', type: 'web_search' } }), true)
  }
})

test('malformed, truncated, unknown, conflicting and over-budget event streams fail closed', () => {
  assert.throws(() => createAgentEventReader().push('not json\n'), /INVALID_CODEX_EVENT/)
  const truncated = createAgentEventReader(); truncated.push('{"type":'); assert.throws(() => truncated.finish(), /INVALID_CODEX_EVENT/)
  assert.throws(() => feed(createAgentEventReader(), { type: 'future.unknown' }), /INVALID_CODEX_EVENT/)
  const conflict = createAgentEventReader({ kind: researchKind }); begin(conflict); feed(conflict, search())
  assert.throws(() => feed(conflict, search('search-1', 'different query')), /CONFLICTING_RESEARCH_EVENT/)
  const budget = createAgentEventReader({ maxBytes: 100 });
  feed(budget, { type: 'turn.started' }); feed(budget, { type: 'turn.started' });
  assert.throws(() => { for (let i = 0; i < 10; i++) feed(budget, { type: 'turn.started' }) }, /CODEX_OUTPUT_LIMIT/)
  const excessive = createAgentEventReader({ kind: researchKind }); begin(excessive)
  assert.throws(() => { for (let i = 0; i < 6; i++) feed(excessive, search(`search-${i}`, `query ${i}`)) }, /RESEARCH_QUERY_LIMIT/)
  const repeats = createAgentEventReader({ kind: researchKind }); begin(repeats)
  assert.throws(() => { for (let i = 0; i < 6; i++) feed(repeats, search(`repeat-${i}`)) }, /RESEARCH_QUERY_LIMIT/)
  const pages = createAgentEventReader({ kind: researchKind }); begin(pages); feed(pages, search())
  assert.throws(() => { for (let i = 0; i < 9; i++) feed(pages, { type: 'item.completed', item: { id: `page-${i}`, type: 'web_search', action: { type: 'open_page', url }, results: [] } }) }, /RESEARCH_PAGE_LIMIT/)
  const unknown = createAgentEventReader({ kind: researchKind }); begin(unknown)
  assert.throws(() => feed(unknown, { type: 'item.completed', item: { id: 'search', type: 'web_search', action: { type: 'other' } } }), /INVALID_RESEARCH_EVENT/)
})

test('a model answer without actual research is not research success', () => {
  const reader = createAgentEventReader({ kind: researchKind }); begin(reader)
  feed(reader, { type: 'item.completed', item: { type: 'agent_message', text: 'I researched it.' } })
  assert.throws(() => finish(reader), /RESEARCH_UNAVAILABLE/)
  const failed = createAgentEventReader({ kind: researchKind }); begin(failed); feed(failed, search()); feed(failed, { type: 'turn.failed' })
  assert.throws(() => finish(failed), /CODEX_TASK_FAILED/)
})

test('UTF-8 split across transport chunks preserves query text and a final non-newline event', () => {
  const reader = createAgentEventReader({ kind: researchKind }); begin(reader)
  const bytes = Buffer.from(JSON.stringify(search('search-1', 'café packaging')) + '\n')
  const split = bytes.indexOf(Buffer.from('é')) + 1
  reader.push(bytes.subarray(0, split)); reader.push(bytes.subarray(split))
  reader.push(JSON.stringify({ type: 'turn.completed' }))
  assert.equal(reader.finish().queries[0].query, 'café packaging')
})
