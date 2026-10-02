import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { childEnvironment, resolveCodex, runBridge } from './bridge.mjs'
import { pairWorker, validateOrigin } from './connection.mjs'

const execute = promisify(execFile)
export async function checkCodexLogin({ environment = process.env, resolve = resolveCodex, exec = execute } = {}) {
  let binary
  try { binary = resolve(environment) } catch { throw new Error('CODEX_BINARY_UNAVAILABLE_INSTALL_CODEX_OR_SET_GRIMOIRE_CODEX_BIN') }
  const options = { env: childEnvironment(environment), windowsHide: true, timeout: 15000, maxBuffer: 4096 }
  try { await exec(binary, ['--version'], options) } catch { throw new Error('CODEX_BINARY_CHECK_FAILED') }
  let help
  try { help = await exec(binary, ['exec', '--help'], { ...options, maxBuffer: 32768 }) } catch { throw new Error('CODEX_RUNTIME_INCOMPATIBLE') }
  // Check the actual installed contract before issuing an enrollment or claim.
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--sandbox', '--output-schema', '--output-last-message', '--json']) {
    if (!String(help.stdout ?? '').includes(flag)) throw new Error('CODEX_RUNTIME_INCOMPATIBLE')
  }
  let result
  try { result = await exec(binary, ['login', 'status'], options) } catch { throw new Error('CODEX_LOGIN_REQUIRED_RUN_CODEX_LOGIN_LOCALLY') }
  if (!/Logged in using /i.test(`${result.stdout}\n${result.stderr}`)) throw new Error('CODEX_LOGIN_STATUS_UNRECOGNIZED')
  return { binary_available: true, login_available: true, model_invoked: false }
}

export function parseArguments(args) {
  const options = {}
  for (let index = 0; index < args.length; index++) {
    const name = args[index]
    if (name === '--watch' && options[name] === undefined) { options[name] = true; continue }
    if (!['--api', '--device-name'].includes(name) || options[name] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('USAGE_NODE_BYOA_CONNECT_MJS_API_ORIGIN')
    options[name] = args[++index]
  }
  if (!options['--api']) throw new Error('API_ORIGIN_REQUIRED_USE_API_FLAG')
  const deviceName = options['--device-name'] ?? hostname()
  if (!deviceName.trim() || deviceName.length > 80 || /[\x00-\x1f\x7f]/.test(deviceName)) throw new Error('INVALID_DEVICE_NAME')
  return { origin: validateOrigin(options['--api']), deviceName, watch: options['--watch'] ?? false }
}

export async function connectWorker(options, { checkLogin = checkCodexLogin, pair = pairWorker, run = runBridge, log = console.log } = {}) {
  await checkLogin()
  log('Codex is installed and already signed in on this computer. No model was invoked.')
  log('Approve this local worker in Grimoire for one organization. Your Codex login stays on this computer.')
  if (options.watch) log('After approval, this terminal keeps the worker running. It can execute tasks explicitly dispatched in that organization. Press Ctrl+C to stop.')
  const result = await pair({ origin: options.origin, deviceName: options.deviceName, onPairing({ browserUrl, expiresAt }) {
    log(`Open this address in your signed-in browser:\n${browserUrl}`)
    log(`Waiting for your organization approval until ${expiresAt}. Press Ctrl+C to stop.`)
    if (options.openBrowser) Promise.resolve(options.openBrowser(browserUrl, options.origin)).then(opened => { if (!opened) log('Could not open a browser automatically. Copy the pairing address above into your browser.') }).catch(() => log('Open the pairing address above manually.'))
  } })
  log(`Paired with organization ${JSON.stringify(result.organizationName)} (${result.organizationId}). Grimoire will show Connected after the worker sends a heartbeat.`)
  log(`Connection: ${result.connectionId}`)
  log('The scoped worker credential was saved in a private local file. Human review remains required for proposals.')
  if (options.resumeCommand) log('To resume later, repeat the same website startup command or reopen Connect Grimoire.cmd. The saved connection will be reused.')
  else log(`Resume this worker: node byoa/bridge.mjs --connection ${result.connectionId} --watch`)
  if (options.watch) {
    log('Starting the worker. Keep this terminal open; Grimoire shows its last heartbeat. Only a task outcome confirms Codex execution.')
    await run({ selector: result.connectionId, mode: 'watch' })
  } else log('The worker has not started. Run the resume command above, or use --watch when connecting next time.')
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) Promise.resolve().then(() => connectWorker(parseArguments(process.argv.slice(2)))).catch(error => {
  console.error(/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'CONNECTION_FAILED')
  process.exitCode = 1
})
