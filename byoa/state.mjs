import os from 'node:os'
import path from 'node:path'

// Never anchor enrollment credentials to an npm cache, the current directory,
// an extracted release, or a server-supplied path.
export function stateDirectory(environment = process.env, platform = process.platform, home = os.homedir()) {
  if (environment.GRIMOIRE_CONNECTOR_HOME) {
    if (!path.isAbsolute(environment.GRIMOIRE_CONNECTOR_HOME)) throw new Error('CONNECTOR_HOME_MUST_BE_ABSOLUTE')
    return path.resolve(environment.GRIMOIRE_CONNECTOR_HOME)
  }
  if (platform === 'win32') {
    const local = environment.LOCALAPPDATA
    if (!local || !path.isAbsolute(local)) throw new Error('LOCAL_APP_DATA_UNAVAILABLE')
    return path.join(local, 'Grimoire', 'Connector', 'state')
  }
  const base = environment.XDG_STATE_HOME || path.join(home, '.local', 'state')
  if (!path.isAbsolute(base)) throw new Error('CONNECTOR_HOME_MUST_BE_ABSOLUTE')
  return path.join(base, 'grimoire')
}

export function supportedNode(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return false
  const [, major, minor] = match.map(Number)
  return (major === 22 && minor >= 16) || major === 24 || (major === 26 && minor >= 3)
}

export function requireSupportedNode(version = process.versions.node) {
  if (!supportedNode(version)) throw new Error('SUPPORTED_NODE_REQUIRED')
}
