import test from 'node:test'
import assert from 'node:assert/strict'
import { createSession } from './local-mcp.mjs'
const env = { GRIMOIRE_MCP_TOKEN: 'local-test-only', GRIMOIRE_API_URL: 'http://127.0.0.1:8080' }
const call = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params })
test('MCP refuses nonlocal hosts and missing credentials', () => {
  assert.throws(() => createSession({ ...env, GRIMOIRE_API_URL: 'https://example.com' }), /LOCAL_API_REQUIRED/)
  assert.throws(() => createSession({}), /MCP_CREDENTIAL_REQUIRED/)
})
test('MCP lifecycle exposes only read tools and rejects write/malformed calls without fetch', async () => {
  const session = createSession(env, () => { throw new Error('Unexpected fetch') })
  assert.equal((await session(call(1, 'tools/list'))).error.code, -32002)
  assert.equal((await session(call(2, 'initialize', { protocolVersion: '2025-03-26' }))).result.protocolVersion, '2025-03-26')
  await session({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const tools = (await session(call(3, 'tools/list'))).result.tools
  assert.equal(tools.length, 3)
  assert.ok(tools.every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint))
  assert.equal((await session(call(4, 'tools/call', { name: 'approve', arguments: {} }))).error.code, -32602)
  assert.equal((await session(call(5, 'tools/call', { name: tools[0].name, arguments: { scion_id: '../../secret' } }))).error.code, -32602)
})
