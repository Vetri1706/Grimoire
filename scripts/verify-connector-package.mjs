// Runs the built connector outside the repository using only its packed files.
// No pairing, network model call, registry fetch, or npm publication is performed.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir, lstat, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { supportedNode } from '../byoa/state.mjs'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (![2, 3].includes(args.length) || args[0] !== '--node' || !path.isAbsolute(args[1]) || (args.length === 3 && args[2] !== '--keep-fixture')) throw new Error('Use --node with an absolute supported Node.js executable path; optionally add --keep-fixture.')
const node = args[1]
const keepFixture = args.includes('--keep-fixture')
const nodeVersion = (await run(node, ['--version'], { windowsHide: true, timeout: 15000 })).stdout.trim()
assert.ok(supportedNode(nodeVersion.replace(/^v/, '')), 'Package verification requires a supported Node.js runtime')
const environment = {}
for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOME', 'CODEX_HOME', 'GRIMOIRE_CODEX_BIN']) {
  if (process.env[name]) environment[name] = process.env[name]
}
environment.PATH = `${path.dirname(node)}${path.delimiter}${environment.PATH ?? ''}`
const fixtureParent = path.resolve(root, '..', '.local', 'connector-package-tests')
const fixture = path.join(fixtureParent, randomUUID())
await mkdir(fixture, { recursive: true })
const options = { cwd: fixture, env: environment, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }
const artifacts = path.join(root, 'web', 'public', 'downloads')
const release = JSON.parse(await readFile(path.join(artifacts, 'connector-release.json'), 'utf8'))
const sourcePackage = JSON.parse(await readFile(path.join(root, 'byoa', 'package.json'), 'utf8'))
const allowed = new Set([...sourcePackage.files, 'package.json'])
const tar = process.platform === 'win32' ? path.join(environment.SystemRoot, 'System32', 'tar.exe') : 'tar'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { version: release.version, node: nodeVersion, npm_published: release.npm.published, checks: [], artifact_sha256: {} }
function passed(check) { report.checks.push(check); console.log(`PASS: ${check}`) }
async function compareTree(directory, expected) {
  const found = new Set()
  async function visit(current) {
    for (const name of await readdir(current)) {
      const full = path.join(current, name), stat = await lstat(full)
      assert.equal(stat.isSymbolicLink(), false, 'No archive entry may be a symbolic link')
      if (stat.isDirectory()) { await visit(full); continue }
      assert.equal(stat.isFile(), true, 'Only files and directories may be unpacked')
      const relative = path.relative(directory, full).split(path.sep).join('/')
      assert.ok(expected.has(relative), `Unexpected archive entry: ${relative}`)
      found.add(relative)
      const source = relative === 'Connect Grimoire.cmd' ? 'bootstrap/launch.cmd' : relative
      assert.equal(digest(await readFile(full)), digest(await readFile(path.join(root, 'byoa', source))), `Packed content differs from current source: ${relative}`)
    }
  }
  await visit(directory)
  assert.deepEqual([...found].sort(), [...expected].sort(), 'Packed file allowlist must be complete')
}
try {
  assert.equal(release.npm.published, false, 'These local artifacts must not claim npm publication')
  for (const [kind, filename] of [['package', 'grimoire-connector.tgz'], ['windows', 'grimoire-connector-windows.zip']]) {
    const archive = path.join(artifacts, filename)
    const actualHash = digest(await readFile(archive))
    assert.equal(actualHash, release[kind].sha256, 'Release checksum must match the actual archive')
    report.artifact_sha256[kind] = actualHash
    const names = (await run(tar, ['-tf', archive], options)).stdout.trim().split(/\r?\n/)
    const expected = kind === 'package' ? new Set([...allowed].map(name => `package/${name}`)) : new Set([...allowed, 'Connect Grimoire.cmd'])
    assert.deepEqual(names.sort(), [...expected].sort(), 'Archive entries must match the explicit runtime allowlist')
    const extracted = path.join(fixture, kind)
    await mkdir(extracted)
    await run(tar, ['-xf', archive, '-C', extracted], options)
    const packageRoot = kind === 'package' ? path.join(extracted, 'package') : extracted
    await compareTree(packageRoot, kind === 'package' ? allowed : new Set([...allowed, 'Connect Grimoire.cmd']))
    const cli = path.join(packageRoot, 'cli.mjs')
    assert.equal((await run(node, [cli, '--version'], options)).stdout.trim(), release.version)
    const help = (await run(node, [cli, '--help'], options)).stdout
    assert.match(help, /Closing it stops execution/)
    assert.match(help, /separate Codex login stays on this computer/)
    const setup = (await run(node, [cli, '--check'], options)).stdout.trim()
    assert.equal(setup, 'Node and local Codex checks passed. No pairing or model execution was performed.')
    passed(`${kind}: exact file allowlist, source equality, checksum, isolated help/version and real local Codex setup check`)
  }
  const emptyWorkingDirectory = path.join(fixture, 'empty')
  await mkdir(emptyWorkingDirectory)
  const npm = path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const config = path.join(fixture, 'empty.npmrc')
  await writeFile(config, '')
  const npmEnvironment = { ...environment,
    npm_config_cache: path.join(fixture, 'npm-cache'),
    npm_config_userconfig: config,
    npm_config_globalconfig: path.join(fixture, 'empty-global.npmrc'),
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
  }
  await writeFile(npmEnvironment.npm_config_globalconfig, '')
  const result = await run(node, [npm, 'exec', '--offline', '--yes', '--ignore-scripts', `--package=${path.join(artifacts, 'grimoire-connector.tgz')}`, '--', 'grimoire-connector', '--version'], { ...options, cwd: emptyWorkingDirectory, env: npmEnvironment, timeout: 60000 })
  assert.equal(result.stdout.trim(), release.version)
  passed('npm exec installs the local packed tarball offline and resolves its bin from an empty working directory')
  assert.deepEqual(await readdir(emptyWorkingDirectory), [], 'npm execution must not create project files')
  report.pairing_performed = false
  report.model_invoked = false
  report.registry_access = false
  console.log(JSON.stringify(report, null, 2))
} finally {
  const resolvedParent = await realpath(fixtureParent)
  const resolvedFixture = await realpath(fixture)
  assert.ok(resolvedFixture.startsWith(`${resolvedParent}${path.sep}`), 'Refuse cleanup outside the isolated package test directory')
  assert.equal((await lstat(fixture)).isSymbolicLink(), false)
  if (keepFixture) console.log(`Retained isolated package fixture: ${resolvedFixture}`)
  else await rm(resolvedFixture, { recursive: true, force: true })
}
