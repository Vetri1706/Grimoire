#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { hostname } from 'node:os'
import { requireSupportedNode } from './state.mjs'

export const version = '0.1.2'
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export function parseCliArguments(args) {
  const result = { watch: true, browser: true }
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (seen.has(key)) throw new Error('INVALID_CONNECTOR_ARGUMENTS')
    seen.add(key)
    if (key === '--watch') continue
    if (key === '--pair') { result.pair = true; continue }
    if (key === '--no-browser') { result.browser = false; continue }
    if (['--help', '--version', '--list', '--check'].includes(key)) { result[key.slice(2)] = true; continue }
    if (!['--api', '--connection', '--device-name'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('INVALID_CONNECTOR_ARGUMENTS')
    result[{ '--api': 'origin', '--connection': 'selector', '--device-name': 'deviceName' }[key]] = args[++i]
  }
  if (result.selector && (!uuid.test(result.selector) || result.pair)) throw new Error('INVALID_CONNECTOR_ARGUMENTS')
  if (result.deviceName && (!result.deviceName.trim() || result.deviceName.length > 80 || /[\x00-\x1f\x7f]/.test(result.deviceName))) throw new Error('INVALID_DEVICE_NAME')
  return result
}
const safeLabel = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '')
export const errorHelp = {
  SUPPORTED_NODE_REQUIRED: 'Use Node.js 22.16+ (22.x), 24.x, or 26.3+ (26.x), or download the Windows connector from Grimoire.',
  CODEX_BINARY_UNAVAILABLE_INSTALL_CODEX_OR_SET_GRIMOIRE_CODEX_BIN: 'Install Codex CLI from https://developers.openai.com/codex/cli/ and run codex login locally. Node.js alone does not install Codex. For an existing native installation, set GRIMOIRE_CODEX_BIN to its absolute codex executable path.',
  CODEX_BINARY_CHECK_FAILED: 'The local Codex executable could not start. Reinstall Codex CLI or check GRIMOIRE_CODEX_BIN.',
  CODEX_RUNTIME_INCOMPATIBLE: 'Update Codex CLI. This bridge requires the isolated exec flags provided by Codex CLI 0.157.1, including --ignore-user-config and --ignore-rules. No task has started.',
  CODEX_LOGIN_REQUIRED_RUN_CODEX_LOGIN_LOCALLY: 'Run codex login on this computer, then repeat the connector command. Grimoire sign-in does not sign you into Codex.',
  CODEX_LOGIN_STATUS_UNRECOGNIZED: 'Run codex login status locally and update Codex if necessary. Its output was not shared with Grimoire.',
  PAIRING_EXPIRED: 'The pairing code expired. Repeat the startup command for a new code.',
  PAIRING_CONSUMED: 'This single-use pairing was already collected, or its response was lost. Revoke the unused connection in Grimoire Settings, then rerun with --pair. No credential can be recovered from this code.',
  PAIRING_DENIED: 'Pairing was declined in Grimoire. Rerun with --pair if you want to request access again.',
  PAIRING_NETWORK_UNAVAILABLE: 'Could not reach Grimoire. Check the website address, HTTPS certificate and internet connection, then retry.',
  CONNECTION_FILE_NOT_PRIVATE: 'The local credential folder must be accessible only to your account. Repair its permissions or use a private GRIMOIRE_CONNECTOR_HOME directory; do not share credential files.',
  CONNECTION_NOT_FOUND: 'No saved connection matches that ID. Run the website startup command to pair this computer.',
  SELECT_CONNECTION_REQUIRED: 'More than one organization is paired. Use --list, then --connection followed by the intended connection ID.',
  CONNECTION_ORIGIN_MISMATCH: 'The saved connection belongs to another website. Use its original website address or pair a new connection.',
  API_401_UNAUTHORIZED: 'The worker credential expired or was revoked. Check Authorized computers in Grimoire and rerun with --pair.',
  API_403_FORBIDDEN: 'This worker no longer has access. Ask a Handler to check the organization and connection, then pair again if needed.',
}
export function explainError(error) {
  const code = /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'CONNECTOR_FAILED'
  return `${code}\n${errorHelp[code] ?? (code.startsWith('API_401_') || code.startsWith('API_403_') ? errorHelp.API_401_UNAUTHORIZED : 'Check the connection in Grimoire Settings and retry. No provider credentials are included in this error.')}`
}
export async function selectConnection(records, { terminal = process.stdin.isTTY, ask, log = console.log } = {}) {
  if (records.length <= 1) return records[0]
  if (!terminal) throw new Error('SELECT_CONNECTION_REQUIRED')
  records.forEach((record, index) => log(`${index + 1}. ${safeLabel(record.organizationName)} (${record.connectionId})`))
  let reader
  try {
    if (!ask) { reader = createInterface({ input: process.stdin, output: process.stdout }); ask = prompt => reader.question(prompt) }
    const answer = await ask('Select the organization whose dispatched tasks this terminal may execute: ')
    if (!/^[1-9]\d*$/.test(answer) || !records[Number(answer) - 1]) throw new Error('SELECT_CONNECTION_REQUIRED')
    return records[Number(answer) - 1]
  } finally { reader?.close() }
}
export async function main(args = process.argv.slice(2)) {
  const options = parseCliArguments(args)
  if (options.version) { console.log(version); return }
  if (options.help) {
    console.log('Grimoire local connector\n  grimoire-connector --api https://your-grimoire-site --watch\n  grimoire-connector --connection UUID --watch\n  grimoire-connector --list\n\n--pair requests a fresh enrollment; --no-browser prints the pairing link only.\n--check verifies local Codex setup without pairing or executing tasks.\nKeep this terminal open. Closing it stops execution; this is not a background service.\nGrimoire authorizes one organization. Your separate Codex login stays on this computer.')
    return
  }
  requireSupportedNode()
  const { listConnections, loadConnection, validateOrigin } = await import('./connection.mjs')
  const { checkCodexLogin, connectWorker } = await import('./connect.mjs')
  const { runBridge } = await import('./bridge.mjs')
  const { openPairingPage } = await import('./browser.mjs')
  if (options.origin) options.origin = validateOrigin(options.origin)
  if (options.list) {
    const records = await listConnections(options.origin)
    for (const record of records) console.log(`${record.connectionId}  ${JSON.stringify(safeLabel(record.organizationName))}  ${record.origin}`)
    if (!records.length) console.log('No saved connections. Copy the startup command from Grimoire > Connect Codex.')
    return
  }
  if (options.check) { await checkCodexLogin(); console.log('Node and local Codex checks passed. No pairing or model execution was performed.'); return }
  if (!options.origin && !options.selector) throw new Error('API_ORIGIN_REQUIRED_USE_API_FLAG')
  let connection
  if (options.selector) {
    const record = await loadConnection(options.selector)
    if (options.origin && record.api_origin !== options.origin) throw new Error('CONNECTION_ORIGIN_MISMATCH')
    connection = { connectionId: record.connection_id, organizationName: record.organization_name }
  } else if (!options.pair) connection = await selectConnection(await listConnections(options.origin))
  if (connection) {
    await checkCodexLogin()
    console.log(`Resuming ${JSON.stringify(safeLabel(connection.organizationName))} (${connection.connectionId}). Only explicitly dispatched tasks can run. Keep this terminal open; Ctrl+C stops execution.`)
    await runBridge({ selector: connection.connectionId, mode: 'watch' })
  } else {
    await connectWorker({ ...options, deviceName: options.deviceName ?? hostname(), resumeCommand: 'grimoire-connector', openBrowser: options.browser ? openPairingPage : undefined })
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(explainError(error)); process.exitCode = 1 })
