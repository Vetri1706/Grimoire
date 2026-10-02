import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, copyFile, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'byoa')
const destination = path.join(root, 'web', 'public', 'downloads')
const staging = path.join(root, '.local', 'connector-build', randomUUID())
const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
const allowed = new Set([...manifest.files, 'package.json'])
// npm pack uses a fixed local CLI and argv, never a shell or registry publication.
const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
const npm = candidates.find(value => value && path.basename(value) === 'npm-cli.js' && existsSync(value))
if (!npm) throw new Error('Run this build through npm run build in web, or use Node with npm installed.')
await mkdir(staging, { recursive: true })
const packed = JSON.parse((await run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', staging], { cwd: source, windowsHide: true, maxBuffer: 1024 * 1024 })).stdout)[0]
if (!packed || packed.name !== manifest.name || packed.version !== manifest.version) throw new Error('Unexpected npm pack result')
const entries = []
for (const { path: name } of packed.files) {
  if (!allowed.has(name) || name.includes('..') || name.startsWith('/') || name.includes('\\')) throw new Error(`Unexpected public package file: ${name}`)
  const file = path.join(source, name)
  if (!(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()) throw new Error('Public connector files must be regular files')
  entries.push([name, await readFile(file)])
}
if (entries.length !== allowed.size) throw new Error('npm pack omitted a required runtime file')
entries.push(['Connect Grimoire.cmd', await readFile(path.join(source, 'bootstrap', 'launch.cmd'))])

// Small dependency-free ZIP writer: stored entries, fixed timestamps, no paths
// outside the explicit npm file allowlist. No install scripts or bundled secrets.
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
  return (crc ^ 0xffffffff) >>> 0
}
function zip(files) {
  const locals = [], central = []; let offset = 0
  for (const [name, bytes] of files) {
    const filename = Buffer.from(name), crc = crc32(bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(33, 12)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26)
    locals.push(local, filename, bytes)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(33, 14)
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42)
    central.push(directory, filename); offset += local.length + filename.length + bytes.length
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, index, end])
}
await mkdir(destination, { recursive: true })
const tarball = await readFile(path.join(staging, packed.filename))
const windows = zip(entries)
await copyFile(path.join(staging, packed.filename), path.join(destination, 'grimoire-connector.tgz'))
await writeFile(path.join(destination, 'grimoire-connector-windows.zip'), windows)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const release = {
  version: manifest.version,
  package: { path: '/downloads/grimoire-connector.tgz', sha256: digest(tarball) },
  windows: { path: '/downloads/grimoire-connector-windows.zip', sha256: digest(windows) },
  npm: { published: false },
}
// Write metadata last; UI never exposes a partially generated release.
await writeFile(path.join(destination, 'connector-release.json'), `${JSON.stringify(release, null, 2)}\n`)
console.log(`Connector ${manifest.version}: npm pack verified ${packed.files.length} allowlisted files; tarball ${tarball.length} bytes, Windows ZIP ${windows.length} bytes. Not published or deployed.`)
