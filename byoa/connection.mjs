import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, lstat, chmod, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { stateDirectory } from './state.mjs'

const execFileAsync = promisify(execFile)
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export const connectionDirectory = path.join(stateDirectory(), 'connections')
const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])

// A connection is an explicit enrollment of one origin, not a URL supplied by a task.
export function validateOrigin(value, { legacy = false } = {}) {
  let url
  try { url = new URL(value) } catch { throw new Error('INVALID_API_ORIGIN') }
  const hostname = url.hostname
  const safeHost = /^\[[a-f0-9:]+\]$/i.test(hostname) || (hostname.length <= 253 && hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))
  if (typeof value !== 'string' || value.trim() !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !safeHost ||
      !['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback.has(url.hostname)) ||
      (legacy && (url.protocol !== 'http:' || !loopback.has(url.hostname)))) throw new Error(legacy ? 'LOCAL_API_REQUIRED' : 'HTTPS_OR_LOOPBACK_ORIGIN_REQUIRED')
  // Reject parser-normalized dot paths, backslashes and disguised loopback literals.
  if (!new RegExp(`^${url.protocol}//`, 'i').test(value) || value.includes('\\') ||
      value.replace(/\/$/, '').toLowerCase() !== url.origin.toLowerCase()) throw new Error('CANONICAL_API_ORIGIN_REQUIRED')
  return url.origin
}

function validateRecord(record) {
  if (!record || record.version !== 1 || !uuid.test(record.connection_id) || !uuid.test(record.organization_id) ||
      typeof record.organization_name !== 'string' || !record.organization_name.trim() || record.organization_name.length > 240 ||
      !/^[a-f0-9]{64}$/.test(record.credential) || record.adapter !== 'codex_cli' ||
      record.policy_version !== 'codex-synthetic-v1' || record.content_class !== 'synthetic_only') throw new Error('INVALID_CONNECTION_FILE')
  validateOrigin(record.api_origin)
  return record
}

function privateEnvironment(environment = process.env) {
  const keys = ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'HOME']
  return Object.fromEntries(keys.filter(key => environment[key]).map(key => [key, environment[key]]))
}

async function protect(target, directory) {
  if (process.platform !== 'win32') { await chmod(target, directory ? 0o700 : 0o600); return }
  // Start with a fresh protected DACL: inherited or explicit grants to other users
  // must not survive. The target is passed as data, never interpolated into code.
  const script = `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[Security.AccessControl.${directory ? 'DirectorySecurity' : 'FileSecurity'}]::new(); $acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($sid); $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',${directory ? "'ContainerInherit,ObjectInherit'" : "'None'"},'None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:GRIMOIRE_PRIVATE_PATH -AclObject $acl -ErrorAction Stop`
  try {
    await execFileAsync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...privateEnvironment(), GRIMOIRE_PRIVATE_PATH: target }, windowsHide: true, timeout: 15000, maxBuffer: 4096 })
  } catch { throw new Error('CONNECTION_FILE_PERMISSION_FAILED') }
}

export async function verifyPrivate(target, directory) {
  const info = await lstat(target)
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('UNSAFE_CONNECTION_PATH')
  if (process.platform !== 'win32') {
    if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('CONNECTION_FILE_NOT_PRIVATE')
    return
  }
  const script = `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=Get-Acl -LiteralPath $env:GRIMOIRE_PRIVATE_PATH -ErrorAction Stop; if (!$acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { exit 2 }; foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid) { exit 3 } }`
  try {
    await execFileAsync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...privateEnvironment(), GRIMOIRE_PRIVATE_PATH: target }, windowsHide: true, timeout: 15000, maxBuffer: 4096 })
  } catch { throw new Error('CONNECTION_FILE_NOT_PRIVATE') }
}

export async function ensurePrivateDirectory(directory) {
  for (let ancestor = path.resolve(directory); ; ancestor = path.dirname(ancestor)) {
    try { if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('UNSAFE_CONNECTION_PATH') } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (path.dirname(ancestor) === ancestor) break
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('UNSAFE_CONNECTION_PATH')
  try { await verifyPrivate(directory, true) } catch (error) {
    if (error.message !== 'CONNECTION_FILE_NOT_PRIVATE') throw error
    await protect(directory, true)
    await verifyPrivate(directory, true)
  }
  return directory
}

export async function writePrivateJson(file, value) {
  const directory = path.dirname(file)
  await ensurePrivateDirectory(directory)
  // Reject existing symlinks and unexpected file permissions before replacement.
  try { await verifyPrivate(file, false) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const pending = path.join(directory, `.pending-${randomUUID()}`)
  let handle
  try {
    handle = await open(pending, 'wx', 0o600)
    await protect(pending, false)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close(); handle = null
    await rename(pending, file)
  } finally {
    await handle?.close().catch(() => {})
    await unlink(pending).catch(() => {})
  }
}

export async function saveConnection(record, directory = connectionDirectory) {
  validateRecord(record)
  await ensurePrivateDirectory(directory)
  const finalPath = path.join(directory, `${record.connection_id}.json`)
  // Never overwrite an enrollment silently. A separate connection can be revoked
  // explicitly in the organization runtime settings.
  try { await lstat(finalPath); throw new Error('CONNECTION_ALREADY_SAVED') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const pending = path.join(directory, `.pending-${randomUUID()}`)
  let handle
  try {
    handle = await open(pending, 'wx', 0o600)
    await protect(pending, false)
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close(); handle = null
    await rename(pending, finalPath)
    await verifyPrivate(finalPath, false)
    return finalPath
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(pending).catch(() => {})
    throw error
  }
}

export async function listConnections(origin, directory = connectionDirectory) {
  if (origin) origin = validateOrigin(origin)
  try { await verifyPrivate(directory, true) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const records = []
  for (const name of (await readdir(directory)).sort()) {
    if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue
    const record = await loadConnection(name.slice(0, -5), directory)
    if (origin && record.api_origin !== origin) continue
    // Never return credentials to a listing, log or browser.
    records.push({ connectionId: record.connection_id, organizationId: record.organization_id, organizationName: record.organization_name, origin: record.api_origin })
  }
  return records
}

export async function loadConnection(selector, directory = connectionDirectory) {
  if (!uuid.test(selector ?? '')) throw new Error('CONNECTION_ID_OR_ORGANIZATION_ID_REQUIRED')
  selector = selector.toLowerCase()
  await verifyPrivate(directory, true)
  const exactPath = path.join(directory, `${selector}.json`)
  async function readRecord(file) {
    await verifyPrivate(file, false)
    if ((await lstat(file)).size > 8192) throw new Error('INVALID_CONNECTION_FILE')
    let record
    try { record = JSON.parse(await readFile(file, 'utf8')) } catch { throw new Error('INVALID_CONNECTION_FILE') }
    validateRecord(record)
    if (path.basename(file) !== `${record.connection_id}.json`) throw new Error('CONNECTION_ID_MISMATCH')
    return record
  }
  try { return await readRecord(exactPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const matches = []
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue
    const record = await readRecord(path.join(directory, name))
    if (record.organization_id.toLowerCase() === selector.toLowerCase()) matches.push(record)
  }
  if (matches.length !== 1) throw new Error(matches.length ? 'MULTIPLE_CONNECTIONS_USE_CONNECTION_ID' : 'CONNECTION_NOT_FOUND')
  return matches[0]
}

export async function workerConfiguration({ selector, environment = process.env, directory } = {}) {
  if (selector) {
    const record = await loadConnection(selector, directory)
    return { origin: validateOrigin(record.api_origin), token: record.credential, connectionId: record.connection_id, organizationId: record.organization_id }
  }
  return { origin: validateOrigin(environment.GRIMOIRE_API_URL ?? 'http://127.0.0.1:8080', { legacy: true }), token: environment.GRIMOIRE_TOKEN_AGENT_A }
}

export async function pairingRequest(origin, route, body, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  validateOrigin(origin)
  if (!['/api/worker-connections/pairings', '/api/worker-connections/pairings/poll'].includes(route)) throw new Error('INVALID_PAIRING_ROUTE')
  let response
  try {
    response = await fetchImpl(`${origin}${route}`, { method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch { throw new Error('PAIRING_NETWORK_UNAVAILABLE') }
  if (response.status === 429) {
    const seconds = Number(response.headers.get('Retry-After'))
    return { status: 'slow_down', poll_interval_seconds: Number.isFinite(seconds) ? Math.min(30, Math.max(3, seconds)) : 3 }
  }
  if (!response.ok) throw new Error(`PAIRING_API_${response.status}`)
  let result
  try {
    const bytes = await response.text()
    if (bytes.length > 8192) throw new Error()
    result = JSON.parse(bytes)
  } catch { throw new Error('INVALID_PAIRING_RESPONSE') }
  return result
}

export async function pairWorker({ origin, deviceName, onPairing = () => {}, request = pairingRequest, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), save = saveConnection }) {
  origin = validateOrigin(origin)
  const pairing = await request(origin, '/api/worker-connections/pairings', { device_name: deviceName })
  const expiry = Date.parse(pairing.expires_at)
  if (!uuid.test(pairing.pairing_id ?? '') || !/^[a-fA-F0-9]{64}$/.test(pairing.device_secret ?? '') ||
      !/^[A-F0-9]{16}$/.test(pairing.user_code ?? '') || !Number.isFinite(expiry) || expiry <= now() || expiry > now() + 15 * 60 * 1000 ||
      pairing.adapter !== 'codex_cli' || pairing.policy_version !== 'codex-synthetic-v1' || pairing.content_class !== 'synthetic_only') throw new Error('INVALID_PAIRING_RESPONSE')
  // Only the human code is exposed to the browser and console. The possession
  // secret is used exclusively for the same-origin poll and is never persisted.
  onPairing({ userCode: pairing.user_code, browserUrl: `${origin}/#/connect-worker/${pairing.user_code}`, expiresAt: pairing.expires_at })
  let interval = Math.max(3, Math.min(30, Number(pairing.poll_interval_seconds) || 3)) * 1000
  while (now() < expiry) {
    await sleep(Math.min(interval, expiry - now()))
    if (now() >= expiry) break
    let result
    try { result = await request(origin, '/api/worker-connections/pairings/poll', { device_secret: pairing.device_secret }) }
    catch (error) {
      if (error.message !== 'PAIRING_NETWORK_UNAVAILABLE') throw error
      interval = Math.min(30000, interval * 2)
      continue
    }
    if (result.status === 'pending' || result.status === 'slow_down') {
      interval = Math.max(3, Math.min(30, Number(result.poll_interval_seconds) || 3)) * 1000
      continue
    }
    if (result.status === 'approved') {
      const record = validateRecord({ version: 1, api_origin: origin, connection_id: result.connection_id, organization_id: result.organization_id, organization_name: result.organization_name, credential: result.credential, adapter: result.adapter, policy_version: result.policy_version, content_class: result.content_class, enrolled_at: new Date(now()).toISOString() })
      await save(record)
      // Return only public metadata. Callers cannot accidentally print the token.
      return { connectionId: record.connection_id, organizationId: record.organization_id, organizationName: record.organization_name, origin }
    }
    if (['expired', 'denied', 'consumed'].includes(result.status)) throw new Error(`PAIRING_${result.status.toUpperCase()}`)
    throw new Error('INVALID_PAIRING_RESPONSE')
  }
  throw new Error('PAIRING_EXPIRED')
}

// Used by the Windows launcher to canonicalize organization selectors without
// copying a credential into PowerShell or into a process command line.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(async () => {
    if (process.argv.length !== 4 || process.argv[2] !== '--describe') throw new Error('CONNECTION_DESCRIBE_ARGUMENT_REQUIRED')
    const record = await loadConnection(process.argv[3])
    console.log(JSON.stringify({ connection_id: record.connection_id, organization_id: record.organization_id, api_origin: record.api_origin }))
  }).catch(error => { console.error(/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'CONNECTION_UNAVAILABLE'); process.exitCode = 1 })
}
