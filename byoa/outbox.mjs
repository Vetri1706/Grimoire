import { readdir, readFile, lstat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { stateDirectory } from './state.mjs'
import { writePrivateJson, verifyPrivate } from './connection.mjs'
import { validPreparationNote } from './conversation.mjs'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
function root(configuration, directory) {
  if (!uuid.test(configuration.connectionId ?? '') || !uuid.test(configuration.organizationId ?? '')) throw new Error('INVALID_RESULT_RECEIPT')
  return directory ?? path.join(stateDirectory(), 'pending-results', configuration.connectionId)
}
export function validateReceipt(record, configuration) {
  const receipt = record?.receipt
  if (!record || record.version !== 1 || record.connection_id !== configuration.connectionId || record.organization_id !== configuration.organizationId ||
      !uuid.test(record.task_id ?? '') || !uuid.test(record.lease_token ?? '') || !receipt ||
      Object.keys(receipt).sort().join() !== 'output_sha256,preparation_note,proposal_id,provider_run_id' ||
      !uuid.test(receipt.proposal_id ?? '') || (receipt.provider_run_id !== null && (typeof receipt.provider_run_id !== 'string' || !receipt.provider_run_id || receipt.provider_run_id.includes('\0') || Buffer.byteLength(receipt.provider_run_id) > 200)) ||
      !/^[a-f0-9]{64}$/.test(receipt.output_sha256 ?? '') || !validPreparationNote(receipt.preparation_note)) throw new Error('INVALID_RESULT_RECEIPT')
  return record
}
export async function queueResult(configuration, task, receipt, directory) {
  const record = validateReceipt({ version: 1, connection_id: configuration.connectionId, organization_id: configuration.organizationId, task_id: task.id, lease_token: task.lease_token, receipt }, configuration)
  const file = path.join(root(configuration, directory), `${task.id}.json`)
  await writePrivateJson(file, record)
  return file
}
export async function acknowledgeResult(file) { await verifyPrivate(file, false); await unlink(file) }

// The durable outbox contains only the exact result receipt and original lease.
// It cannot resume generation, submit a new proposal, claim or dispatch work.
export async function recoverResults(configuration, { send, directory, log = console.log } = {}) {
  const folder = root(configuration, directory)
  try { await verifyPrivate(folder, true) } catch (error) { if (error.code === 'ENOENT') return 0; throw error }
  const names = (await readdir(folder)).filter(name => /^[a-f0-9-]{36}\.json$/i.test(name))
  if (names.length > 100) throw new Error('RESULT_OUTBOX_LIMIT')
  let recovered = 0
  for (const name of names) {
    const file = path.join(folder, name)
    await verifyPrivate(file, false)
    if ((await lstat(file)).size > 8192) throw new Error('INVALID_RESULT_RECEIPT')
    let record
    try { record = validateReceipt(JSON.parse(await readFile(file, 'utf8')), configuration) } catch { throw new Error('INVALID_RESULT_RECEIPT') }
    if (name !== `${record.task_id}.json`) throw new Error('INVALID_RESULT_RECEIPT')
    let response
    try {
      response = await send(`/api/agent/tasks/${record.task_id}/result`, { method: 'POST', headers: { 'X-Grimoire-Task-Lease': record.lease_token }, body: record.receipt })
    } catch (error) {
      if (!/^API_(404|409)_/.test(error.message)) throw error
      // A definitive stale/terminal denial is not permission to regenerate.
      log(`Saved result for task ${record.task_id} could not be acknowledged. Inspect the task in Grimoire; it will not be rerun automatically.`)
      await acknowledgeResult(file)
      continue
    }
    if (response?.id !== record.task_id || response?.status !== 'completed') throw new Error('INVALID_RECEIPT_ACKNOWLEDGEMENT')
    await acknowledgeResult(file)
    recovered++
    log(`Recovered the existing result acknowledgement for task ${record.task_id}. No model was run.`)
  }
  return recovered
}
