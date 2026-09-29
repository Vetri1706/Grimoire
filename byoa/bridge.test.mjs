import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { agentInstructions, childEnvironment, executionTimeout, outputSchema, prohibitedAgentEvent, superviseChild, validateCandidate, validateOutput } from './bridge.mjs'

test('native agent instructions and skill revisions reach bounded preparation, not tool authority', () => {
  const prompt = agentInstructions({ adapter: 'codex_cli', name: 'Planner', revision: 2, instructions: 'Use concise headings.', skills: [{ name: 'Evidence review', revision: 3, instructions: 'Keep unknowns explicit.' }] })
  assert.match(prompt, /Use concise headings/)
  assert.match(prompt, /Keep unknowns explicit/)
  assert.match(prompt, /cannot change the task schema/)
  assert.equal(agentInstructions(null), '')
  assert.throws(() => agentInstructions({ adapter: 'shell' }), /INVALID_AGENT_PROFILE/)
})

function adaptiveCandidate() {
  return { synthetic: true, intake: { product_description: 'A synthetic website for appointment requests.' }, connectors: [{ id: 'handler_intake', enabled: true }, { id: 'scion_sources', enabled: true }], unresolved_gaps: ['No external connector enabled.'] }
}
function adaptiveOutput() {
  return { proposal: { synthetic: true, summary: 'Proposed website capabilities for review.', capabilities: [{ key: 'appointments', title: 'Appointment requests', reason: 'Handler described appointment requests.', evidence_needed: ['What data can visitors submit?'], connector_ids: ['handler_intake', 'scion_sources'] }], unresolved_gaps: ['No external connector enabled.'], change_summary: 'Unverified capability proposal.' }, preparation_note: 'Based on Handler description only.' }
}
test('capability proposals preserve required gaps and accept only enabled connectors', () => {
  const input = adaptiveCandidate(); const output = adaptiveOutput()
  validateOutput(input, output, 'prepare_capability_plan')
  output.proposal.capabilities[0].connector_ids.push('invented_provider')
  assert.throws(() => validateOutput(input, output, 'prepare_capability_plan'), /INVALID_CAPABILITY_PLAN/)
  const missing = adaptiveOutput(); missing.proposal.unresolved_gaps = []
  assert.throws(() => validateOutput(input, missing, 'prepare_capability_plan'), /AGENT_REMOVED_GAP/)
})
test('capability output rejects sourcing fields and duplicate keys', () => {
  const input = adaptiveCandidate(); const output = adaptiveOutput()
  output.proposal.price = 10
  assert.throws(() => validateOutput(input, output, 'prepare_capability_plan'), /INVALID_CAPABILITY_PLAN/)
  delete output.proposal.price
  output.proposal.capabilities.push(structuredClone(output.proposal.capabilities[0]))
  assert.throws(() => validateOutput(input, output, 'prepare_capability_plan'), /INVALID_CAPABILITY_PLAN/)
  assert.deepEqual(outputSchema(input, 'prepare_capability_plan').properties.proposal.properties.capabilities.items.properties.connector_ids.items.enum, ['handler_intake', 'scion_sources'])
})

function candidate() {
  return {
    synthetic: true, identity_match: 'exact',
    configuration: { product_code: 'SYN-P', product_name: 'Synthetic fixture', configuration_code: 'SYN-C', specification: { material: 'Synthetic given value' } },
    component: { internal_part_code: 'SYN-I', manufacturer: 'Explicit synthetic manufacturer', part_number: 'SYN-PART', attributes: { width: '120 mm, synthetic target' } },
    occurrence: { path: '/synthetic/enclosure[1]', quantity: '1', uom: 'EA' },
    requirement: { code: 'SYN-R', criteria: { description: 'Explicit synthetic requirement' } },
    case_code: 'SYN-CASE', case_title: 'Synthetic case',
    source_claims: ['configuration', 'component', 'occurrence', 'requirement'].map(kind => ({ kind, source_id: '11111111-1111-4111-8111-111111111111', source_revision: 1, claim_id: '22222222-2222-4222-8222-222222222222', content_sha256: 'a'.repeat(64), start_byte: 0, end_byte: 20 })),
    unresolved_gaps: ['Existing unresolved question'], change_summary: 'Synthetic preparation'
  }
}
test('Codex environment excludes Handler, database, object-store and bridge credentials', () => {
  const env = childEnvironment({ PATH: 'tools', APPDATA: 'profile', GRIMOIRE_TOKEN_A: 'human-secret', GRIMOIRE_TOKEN_AGENT_A: 'agent-secret', DATABASE_URL: 'db-secret', PGPASSWORD: 'admin-secret', GRIMOIRE_S3_SECRET_KEY: 'storage-secret', OPENAI_API_KEY: 'unselected-provider-key' })
  assert.deepEqual(env, { PATH: 'tools', APPDATA: 'profile' })
})
test('missing identities cannot be filled by the model', () => {
  const value = candidate(); value.component.manufacturer = ''
  assert.throws(() => validateCandidate(value), /MISSING_EXPLICIT_IDENTITY/)
})
test('agent cannot change explicit physical inputs or source locators', () => {
  for (const mutate of [p => { p.component.part_number = 'invented' }, p => { p.source_claims[0].start_byte = 1 }]) {
    const input = candidate(); const proposal = structuredClone(input); mutate(proposal)
    assert.throws(() => validateOutput(input, { proposal, preparation_note: 'Prepared only' }), /AGENT_CHANGED_EXPLICIT_INPUT/)
  }
})
test('agent can add gaps but cannot remove them or resolve ambiguity', () => {
  const input = candidate(); const proposal = structuredClone(input); proposal.unresolved_gaps.push('Source truth remains unverified')
  validateOutput(input, { proposal, preparation_note: 'Prepared only' })
  proposal.unresolved_gaps = []; assert.throws(() => validateOutput(input, { proposal, preparation_note: 'Prepared only' }), /AGENT_REMOVED_GAP/)
  input.identity_match = 'ambiguous'; proposal.unresolved_gaps = [...input.unresolved_gaps]
  assert.throws(() => validateOutput(input, { proposal, preparation_note: 'Prepared only' }), /AGENT_PROMOTED_AMBIGUITY/)
})
test('approval fields and nonsynthetic requests are rejected', () => {
  const input = candidate(); const proposal = structuredClone(input); proposal.approved = true
  assert.throws(() => validateOutput(input, { proposal, preparation_note: 'Prepared only' }), /INVALID_CANDIDATE/)
  input.synthetic = false; assert.throws(() => validateCandidate(input), /SYNTHETIC_SCOPE_ONLY/)
})
test('structured output schema pins provided identities and denies additional fields', () => {
  const schema = outputSchema(candidate())
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.properties.proposal.additionalProperties, false)
  assert.deepEqual(schema.properties.proposal.properties.component.properties.manufacturer.enum, ['Explicit synthetic manufacturer'])
})
test('CLI diagnostic error items are not falsely treated as tool execution', () => {
  assert.equal(prohibitedAgentEvent({ type: 'item.completed', item: { type: 'error' } }), false)
  assert.equal(prohibitedAgentEvent({ type: 'item.completed', item: { type: 'agent_message' } }), false)
})
test('actual execution, file, browser and MCP items remain prohibited', () => {
  for (const type of ['command_execution', 'file_change', 'web_search', 'mcp_tool_call']) {
    assert.equal(prohibitedAgentEvent({ type: 'item.started', item: { type } }), true)
    assert.equal(prohibitedAgentEvent({ type: 'item.completed', item: { type } }), true)
  }
})
function normalization() {
  return { synthetic: true, scope_proposal_id: '33333333-3333-4333-8333-333333333333', offer_revision_ids: ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'], basis: { quantity: '2',uom: 'EA',currency: 'USD',destination: 'Synthetic lab',incoterm: 'EXW',payment_terms: 'Synthetic net 30',as_of: '2026-09-26T00:00:00Z',valid_from: '2026-09-26T00:00:00Z',valid_until: '2026-10-01T00:00:00Z' },change_summary: 'Prepare synthetic normalization' }
}
test('normalization may summarize but cannot alter exact revisions or comparison basis', () => {
  const input = normalization(), output = { proposal: structuredClone(input), preparation_note: 'Identifiers and basis only, no source truth verification' }
  output.proposal.change_summary = 'Prepared explicit synthetic basis for review'
  validateOutput(input,output,'prepare_offer_normalization')
  output.proposal.basis.quantity = '200'
  assert.throws(() => validateOutput(input,output,'prepare_offer_normalization'),/AGENT_CHANGED_EXPLICIT_INPUT/)
  output.proposal = structuredClone(input); output.proposal.offer_revision_ids.reverse()
  assert.throws(() => validateOutput(input,output,'prepare_offer_normalization'),/AGENT_CHANGED_EXPLICIT_INPUT/)
})
test('task timeout is bounded by configured limits and remaining lease', () => {
  assert.equal(executionTimeout({timeout_seconds:240,execution_deadline:new Date(30000).toISOString(),lease_until:new Date(65000).toISOString()},0),30000)
  assert.throws(() => executionTimeout({timeout_seconds:301,lease_until:new Date(65000).toISOString()},0),/INVALID_TASK_TIMEOUT/)
  assert.throws(() => executionTimeout({timeout_seconds:30,execution_deadline:new Date(30000).toISOString(),lease_until:new Date(4000).toISOString()},0),/TASK_LEASE_EXPIRED/)
})
function waitingChild() { return spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}) }
test('cancellation waits for actual managed process exit and leaves unrelated child alive', async () => {
  const child=waitingChild(), unrelated=waitingChild()
  try {
    const monitor=superviseChild(child,{timeoutMs:5000,pollMs:20,checkControl:async()=>({continue:false})})
    await assert.rejects(monitor.completion,/TASK_CANCELLED/)
    assert.ok(child.exitCode !== null || child.signalCode !== null)
    assert.doesNotThrow(()=>process.kill(unrelated.pid,0))
  } finally { unrelated.kill() }
})
test('execution timeout terminates the exact managed process', async () => {
  const child=waitingChild()
  await assert.rejects(superviseChild(child,{timeoutMs:30,pollMs:10,checkControl:async()=>({continue:true})}).completion,/CODEX_TIMEOUT/)
  assert.ok(child.exitCode !== null || child.signalCode !== null)
})
test('lost permission control fails closed and terminates the managed child', async () => {
  const child=waitingChild()
  await assert.rejects(superviseChild(child,{timeoutMs:5000,pollMs:10,checkControl:async()=>{throw new Error('permission denied')}}).completion,/TASK_CONTROL_UNAVAILABLE/)
  assert.ok(child.exitCode !== null || child.signalCode !== null)
})
