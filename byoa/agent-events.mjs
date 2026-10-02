import { StringDecoder } from 'node:string_decoder'
import { publicResearchUrl, researchKind } from './research.mjs'

const passiveItems = new Set(['reasoning', 'agent_message', 'todo_list', 'error'])
const lifecycle = new Set(['item.started', 'item.updated', 'item.completed'])
const eventTypes = new Set(['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error', ...lifecycle])
const bounded = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\0')

export function prohibitedEvent(event, kind) {
  return lifecycle.has(event?.type) && (!event.item || !bounded(event.item.type, 80) ||
    (!passiveItems.has(event.item.type) && !(kind === researchKind && event.item.type === 'web_search')))
}

// Observe only the CLI's structured events. No provider transcript or web body is
// returned. A result URL proves discovery, not the truth of its associated claim.
export function createAgentEventReader({ kind, now = () => new Date().toISOString(), maxBytes = 2_000_000 } = {}) {
  const decoder = new StringDecoder('utf8')
  let pending = '', totalBytes = 0, providerRunId = null, diagnostic = '', completed = false, failed = false, searchCalls = 0, openCalls = 0
  const queries = new Map(), observedUrls = new Set(), completedItems = new Map(), searchItems = new Set(), references = new Map()

  function record(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event) || !eventTypes.has(event.type)) throw new Error('INVALID_CODEX_EVENT')
    if (prohibitedEvent(event, kind)) throw new Error('UNEXPECTED_AGENT_TOOL_USE')
    if (event.type === 'thread.started') {
      if (!bounded(event.thread_id, 200) || !event.thread_id || (providerRunId && providerRunId !== event.thread_id)) throw new Error('INVALID_CODEX_EVENT')
      providerRunId = event.thread_id
    }
    if (event.type === 'error' && bounded(event.message, 3000)) diagnostic = event.message
    if (event.item?.type === 'error' && bounded(event.item.message, 3000)) diagnostic = event.item.message
    if (event.type === 'turn.failed') failed = true
    if (event.type === 'turn.completed') completed = true
    if (event.item?.type !== 'web_search') return
    const item = event.item
    if (!bounded(item.id, 200) || !item.id) throw new Error('INVALID_RESEARCH_EVENT')
    searchItems.add(item.id)
    if (searchItems.size > 20) throw new Error('RESEARCH_TOOL_LIMIT')
    // Current Codex emits an empty 'other' placeholder at item.started.
    if (event.type !== 'item.completed') {
      if (item.action && !['other', 'search', 'open_page', 'find_in_page'].includes(item.action.type)) throw new Error('INVALID_RESEARCH_EVENT')
      return
    }
    const action = item.action
    if (!action || !['search', 'open_page', 'find_in_page'].includes(action.type)) throw new Error('INVALID_RESEARCH_EVENT')
    const fingerprint = JSON.stringify({ query: item.query, action, results: item.results })
    if (completedItems.has(item.id)) {
      if (completedItems.get(item.id) !== fingerprint) throw new Error('CONFLICTING_RESEARCH_EVENT')
      return
    }
    completedItems.set(item.id, fingerprint)
    if (action.type === 'search') {
      const values = action.queries ?? [action.query ?? item.query]
      if (!Array.isArray(values) || !values.length || values.some(value => !bounded(value, 2000) || !value.trim())) throw new Error('INVALID_RESEARCH_EVENT')
      searchCalls += values.length
      if (searchCalls > 5) throw new Error('RESEARCH_QUERY_LIMIT')
      for (const query of values) if (!queries.has(query.trim())) queries.set(query.trim(), { query: query.trim(), observed_at: now() })
      if (queries.size > 5) throw new Error('RESEARCH_QUERY_LIMIT')
    }
    if (action.type !== 'search') {
      if (!bounded(action.url, 2000) || !action.url) throw new Error('INVALID_RESEARCH_EVENT')
      if (/^https?:/i.test(action.url)) publicResearchUrl(action.url)
      else if (!references.has(action.url)) throw new Error('INVALID_RESEARCH_EVENT')
      if (action.type === 'open_page' && ++openCalls > 8) throw new Error('RESEARCH_PAGE_LIMIT')
    }
    if (item.results !== undefined && item.results !== null && (!Array.isArray(item.results) || item.results.length > 100)) throw new Error('INVALID_RESEARCH_EVENT')
    for (const result of item.results ?? []) {
      if (result?.type !== 'text_result' || typeof result.url !== 'string') continue
      let url
      try { url = publicResearchUrl(result.url) } catch { continue }
      observedUrls.add(url)
      if (bounded(result.ref_id, 200)) references.set(result.ref_id, url)
    }
    if (action.type !== 'search' && action.url) {
      const url = references.get(action.url)
      if (url) observedUrls.add(url)
    }
  }
  function lines(final = false) {
    const values = pending.split('\n')
    pending = final ? '' : values.pop()
    for (const line of values) {
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch { throw new Error('INVALID_CODEX_EVENT') }
      record(event)
    }
    if (pending.length > 500_000) throw new Error('CODEX_OUTPUT_LIMIT')
  }
  return {
    push(bytes) {
      totalBytes += Buffer.byteLength(bytes)
      if (totalBytes > maxBytes) throw new Error('CODEX_OUTPUT_LIMIT')
      pending += decoder.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
      lines()
    },
    finish() {
      pending += decoder.end()
      lines(true)
      if (failed || !completed || !providerRunId) throw new Error('CODEX_TASK_FAILED')
      if (kind === researchKind && (!queries.size || !observedUrls.size)) throw new Error('RESEARCH_UNAVAILABLE')
      return { provider_run_id: providerRunId, queries: [...queries.values()], observed_urls: [...observedUrls], search_events: completedItems.size, search_calls: searchCalls, open_calls: openCalls }
    },
    diagnostic() { return diagnostic },
  }
}

export function requireObservedResearchSources(report, trace) {
  const observed = new Set(trace.observed_urls)
  for (const source of report.sources) if (!observed.has(publicResearchUrl(source.url))) throw new Error('UNOBSERVED_RESEARCH_SOURCE')
  for (const candidate of report.candidates) if (!observed.has(publicResearchUrl(candidate.url))) throw new Error('UNOBSERVED_RESEARCH_SOURCE')
}
