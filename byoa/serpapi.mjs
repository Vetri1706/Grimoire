import { publicResearchUrl } from './research.mjs'

const endpoint = 'https://serpapi.com/search.json'
const maxResponseBytes = 1_048_576
const timeoutMs = 45_000
const sensitiveParameter = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|auth|authorization|password|passwd|secret|signature|sig|credential|x-amz-.+|x-goog-.+)$/i
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(value)

class SerpApiError extends Error {}
const failure = code => new SerpApiError(code)

export function serpapiConfigured(environment = process.env) {
  return validKey(environment?.SERPAPI_API_KEY)
}

function containsSecret(value, apiKey) {
  if (typeof value !== 'string') return false
  for (let pass = 0; pass < 3; pass++) {
    if (value.includes(apiKey)) return true
    try {
      const decoded = decodeURIComponent(value)
      if (decoded === value) break
      value = decoded
    } catch { break }
  }
  return false
}

function safeText(value, max, apiKey) {
  if (containsSecret(value, apiKey)) throw failure('SERPAPI_SECRET_EXPOSURE')
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max).replace(/[\ud800-\udbff]$/, '')
}

function safeResultUrl(value, apiKey) {
  if (containsSecret(value, apiKey)) throw failure('SERPAPI_SECRET_EXPOSURE')
  let normalized
  try { normalized = publicResearchUrl(value) } catch { return null }
  if ([...new URL(normalized).searchParams.keys()].some(key => sensitiveParameter.test(key))) return null
  return normalized
}

export async function searchSerpApi(query, {
  apiKey = process.env.SERPAPI_API_KEY,
  signal,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
} = {}) {
  if (!validKey(apiKey)) throw failure('SERPAPI_NOT_CONFIGURED')
  if (typeof query !== 'string' || !query.trim() || query.length > 2000 || /[\u0000-\u001f\u007f]/.test(query)) throw failure('SERPAPI_INVALID_QUERY')
  query = query.trim()
  if (containsSecret(query, apiKey)) throw failure('SERPAPI_SECRET_EXPOSURE')
  if (signal?.aborted) throw failure('SERPAPI_CANCELLED')

  const controller = new AbortController()
  const cancel = () => controller.abort()
  let reader, timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  timer.unref?.()
  signal?.addEventListener('abort', cancel, { once: true })
  const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => {
    reject(failure(timedOut ? 'SERPAPI_TIMEOUT' : 'SERPAPI_CANCELLED'))
  }, { once: true }))

  try {
    const url = new URL(endpoint)
    url.search = new URLSearchParams({ engine: 'google', q: query, api_key: apiKey, output: 'json', no_cache: 'true' }).toString()
    const response = await Promise.race([
      Promise.resolve().then(() => fetchImpl(url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } })),
      aborted,
    ])
    if (response.status === 401 || response.status === 403) throw failure('SERPAPI_AUTH_FAILED')
    if (response.status === 429) throw failure('SERPAPI_RATE_LIMITED')
    if (!response.ok) throw failure('SERPAPI_UPSTREAM_ERROR')
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) throw failure('SERPAPI_RESPONSE_LIMIT')
    if (!response.body?.getReader) throw failure('SERPAPI_INVALID_RESPONSE')
    reader = response.body.getReader()
    const chunks = []
    let bytes = 0
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) break
      bytes += value.byteLength
      if (bytes > maxResponseBytes) throw failure('SERPAPI_RESPONSE_LIMIT')
      chunks.push(value)
    }
    let data
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))) } catch { throw failure('SERPAPI_INVALID_RESPONSE') }
    if (!object(data) || !object(data.search_metadata)) throw failure('SERPAPI_INVALID_RESPONSE')
    if (data.search_metadata.status !== 'Success') throw failure('SERPAPI_UPSTREAM_ERROR')
    const searchId = data.search_metadata.id
    if (typeof searchId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(searchId)) throw failure('SERPAPI_INVALID_RESPONSE')
    if (containsSecret(searchId, apiKey)) throw failure('SERPAPI_SECRET_EXPOSURE')
    const parameters = data.search_parameters
    if (parameters !== undefined && (!object(parameters) ||
      (parameters.q !== undefined && parameters.q !== query) ||
      (parameters.engine !== undefined && parameters.engine !== 'google'))) throw failure('SERPAPI_INVALID_RESPONSE')
    if (data.organic_results !== undefined && !Array.isArray(data.organic_results)) throw failure('SERPAPI_INVALID_RESPONSE')
    const organic = data.organic_results ?? []
    if (data.error !== undefined && typeof data.error !== 'string') throw failure('SERPAPI_INVALID_RESPONSE')
    if (data.error !== undefined && organic.length) throw failure('SERPAPI_UPSTREAM_ERROR')

    const results = [], observed = new Set()
    for (const result of organic) {
      if (!object(result)) continue
      const resultUrl = safeResultUrl(result.link, apiKey)
      if (!resultUrl || observed.has(resultUrl)) continue
      const title = safeText(result.title, 160, apiKey)
      if (!title) continue
      const snippet = safeText(result.snippet, 1000, apiKey)
      results.push({ url: resultUrl, title, snippet })
      observed.add(resultUrl)
      if (results.length === 8) break
    }
    const observedAt = now()
    if (typeof observedAt !== 'string' || observedAt.length > 64 || !Number.isFinite(Date.parse(observedAt))) throw failure('SERPAPI_INVALID_RESPONSE')
    if (containsSecret(observedAt, apiKey)) throw failure('SERPAPI_SECRET_EXPOSURE')
    return {
      query: { query, observed_at: observedAt, provider: 'serpapi', engine: 'google', search_id: searchId },
      results,
      observed_urls: [...observed],
    }
  } catch (error) {
    if (error instanceof SerpApiError) throw error
    if (controller.signal.aborted) throw failure(timedOut ? 'SERPAPI_TIMEOUT' : 'SERPAPI_CANCELLED')
    throw failure('SERPAPI_NETWORK_ERROR')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    // Stop an unread or over-limit response without propagating transport details.
    controller.abort()
    if (reader) {
      try { void reader.cancel().catch(() => {}) } catch {}
      try { reader.releaseLock() } catch {}
    }
  }
}
