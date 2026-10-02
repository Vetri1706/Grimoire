import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { validateOrigin } from './connection.mjs'
import { childEnvironment } from './bridge.mjs'

const execute = promisify(execFile)
export async function openPairingPage(browserUrl, origin, { platform = process.platform, exec = execute, environment = process.env } = {}) {
  origin = validateOrigin(origin)
  const url = new URL(browserUrl)
  if (url.origin !== origin || url.pathname !== '/' || url.search || !/^#\/connect-worker\/[A-F0-9]{16}$/.test(url.hash)) throw new Error('INVALID_PAIRING_BROWSER_URL')
  const env = childEnvironment(environment)
  try {
    if (platform === 'win32') {
      // URL is passed as environment data, never interpolated into a shell command.
      await exec(path.join(environment.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:GRIMOIRE_PAIRING_URL -ErrorAction Stop'],
        { env: { ...env, GRIMOIRE_PAIRING_URL: browserUrl }, windowsHide: true, timeout: 10000, maxBuffer: 4096 })
    } else if (platform === 'darwin') await exec('/usr/bin/open', [browserUrl], { env, timeout: 10000, maxBuffer: 4096 })
    else if (platform === 'linux') await exec('xdg-open', [browserUrl], { env, timeout: 10000, maxBuffer: 4096 })
    else return false
    return true
  } catch { return false }
}
