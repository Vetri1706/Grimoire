import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import type { AgentTask, AgentTaskEvent } from './scope-api';

const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const statusLabel: Record<AgentTask['status'], string> = {
  queued: 'Queued · awaiting Handler dispatch', dispatched: 'Dispatched · waiting for local bridge', running: 'Running · claimed by local bridge',
  cancel_requested: 'Cancellation requested · waiting for worker acknowledgement', cancelled: 'Cancelled',
  completed: 'Proposal prepared · human review required', failed: 'Failed · no human confirmation performed',
};
function taskLabel(task: AgentTask) { return task.task_kind === 'prepare_offer_normalization' ? 'Offer normalization proposal' : 'Physical scope proposal'; }

export default function AgentTasks({ token, scionId, currentRevision, canWrite, tasks, error, onOpen, onChanged }: {
  token: string; scionId: string; currentRevision: number; canWrite: boolean; tasks: AgentTask[] | null; error: string;
  onOpen: (id: string, kind: AgentTask['task_kind']) => void; onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const active = useRef(true);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; pending.current?.abort(); }; }, []);
  async function command(task: AgentTask, action: 'dispatch' | 'cancel') {
    if (busy) return;
    setBusy(task.id); setActionError(''); setActionNotice('');
    const controller = new AbortController(); pending.current = controller;
    const deadline = window.setTimeout(() => controller.abort(), 5000);
    try {
      const updated = await request<AgentTask>(token, `/scions/${scionId}/agent-tasks/${task.id}/${action}`, { method: 'POST', body: '{}', signal: controller.signal, cache: 'no-store', headers: action === 'dispatch' ? { 'If-Match': `"${task.scion_revision}"` } : {} });
      if (!active.current) return;
      if (action === 'cancel' && updated.status === 'cancel_requested') setActionNotice('Cancellation was requested. The task continues to occupy its worker slot until the local bridge acknowledges that execution has stopped.');
      else if (action === 'cancel' && updated.status === 'cancelled') setActionNotice('The API reports this task cancelled. No proposal from this cancelled execution can be submitted.');
      else if (action === 'dispatch' && ['dispatched', 'running', 'completed'].includes(updated.status)) setActionNotice('The task was dispatched. Its status below reports whether the local bridge has claimed it.');
      else setActionNotice(`The API reports task status: ${updated.status}.`);
      await onChanged();
    } catch (failure) { if (active.current) setActionError(failure instanceof Error ? failure.message : 'The task command failed. Recheck its status before retrying.'); }
    finally { window.clearTimeout(deadline); if (active.current) setBusy(null); if (pending.current === controller) pending.current = null; }
  }
  return <section className="scope-agent-queue" aria-label="Local Codex CLI tasks"><div className="section-heading"><div><p className="eyebrow">CONTROLLED PROPOSAL PREPARATION</p><h2>Your local Codex CLI</h2></div><span className="badge">Bridge connection not reported</span></div>
    <p className="section-description">A candidate is queued first. A Handler must dispatch it before the local bridge can run it using the existing Codex CLI login. The browser receives no Codex credential. Queuing or dispatching does not establish a connected Codex session.</p>
    <div className="agent-control-limits"><div><strong>Organization worker concurrency</strong><span>Limit: 1 active task</span><p>Cancellation-requested tasks retain their slot until execution stops. The API enforces this limit.</p></div><div><strong>Per-task runtime limit</strong><span>30–300 seconds</span><p>The submitted task records its limit. Human review is always a separate action.</p></div></div>
    <p className="scope-agent-boundary">The adapter prepares synthetic proposals only. Agent completion cannot confirm a physical scope, approve a normalization, create a sourcing decision, or authorize supplier contact. Paperclip is not connected.</p>
    {error && <p className="scope-gap">{error}</p>}{actionError && <div className="error-message" role="alert">{actionError}</div>}{actionNotice && <div className="info-notice" role="status">{actionNotice}</div>}
    {tasks?.length === 0 && <p className="scope-empty">No queued tasks for this Scion. Submit an explicit candidate from a proposal form, then dispatch it here.</p>}{tasks === null && !error && <p className="section-description">Task queue status is not currently available.</p>}
    {tasks && tasks.length > 0 && <ol className="scope-task-list">{tasks.map(task => {
      const canDispatch = task.status === 'queued' && task.scion_revision === currentRevision;
      const canCancel = ['queued', 'dispatched', 'running'].includes(task.status);
      return <li key={task.id}><div className="section-heading"><div><p className="eyebrow">{taskLabel(task)}</p><h3>{statusLabel[task.status] || task.status}</h3></div>{task.proposal_id && <button className="button secondary" onClick={() => onOpen(task.proposal_id!, task.task_kind)}>Open prepared proposal</button>}</div>
        <p className="section-description">Scion revision {task.scion_revision} · queued {when(task.created_at)} · attempt {task.attempt} · runtime limit {typeof task.timeout_seconds === 'number' ? `${task.timeout_seconds}s` : 'not reported'}</p>
        {task.status === 'queued' && task.scion_revision !== currentRevision && <p className="scope-gap">This task pins an older intake revision. It cannot be dispatched; cancel it and prepare a current candidate.</p>}
        {task.status === 'cancel_requested' && <p className="scope-gap">The API has recorded the request. Cancellation is not complete until the worker acknowledges that its Codex process has stopped.</p>}
        {task.status === 'failed' && <p className="scope-gap">The task failed. Inspect its failure code and immutable events before submitting another candidate.</p>}
        {(canDispatch || canCancel) && <div className="agent-task-actions">{canDispatch && <button type="button" className="button primary" disabled={!canWrite || busy !== null} onClick={() => void command(task, 'dispatch')}>{busy === task.id ? 'Submitting command…' : 'Dispatch task'}</button>}{canCancel && <button type="button" className="button secondary" disabled={!canWrite || busy !== null} onClick={() => void command(task, 'cancel')}>{task.status === 'running' ? 'Request cancellation' : 'Cancel task'}</button>}</div>}
        <details className="revision-details"><summary>Task timing and result provenance</summary><dl><dt>Task ID</dt><dd><code>{task.id}</code></dd><dt>Adapter</dt><dd>Local Codex CLI</dd><dt>Dispatched</dt><dd>{task.dispatched_at ? when(task.dispatched_at) : 'Not dispatched'}</dd><dt>Claimed</dt><dd>{task.claimed_at ? when(task.claimed_at) : 'Not claimed'}</dd><dt>Current lease ends</dt><dd>{task.lease_until ? when(task.lease_until) : 'No active lease recorded'}</dd><dt>Completed</dt><dd>{task.completed_at ? when(task.completed_at) : 'Not completed'}</dd><dt>Cancelled</dt><dd>{task.cancelled_at ? when(task.cancelled_at) : 'Not cancelled'}</dd><dt>Provider run ID</dt><dd><code>{task.provider_run_id || 'Not recorded'}</code></dd><dt>Output SHA-256</dt><dd><code>{task.output_sha256 || 'Not recorded'}</code></dd><dt>Failure code</dt><dd>{task.failure_code || 'None recorded'}</dd></dl></details>
        <TaskEvents token={token} scionId={scionId} task={task} />
      </li>;
    })}</ol>}
  </section>;
}

function TaskEvents({ token, scionId, task }: { token: string; scionId: string; task: AgentTask }) {
  const [open, setOpen] = useState(false); const [events, setEvents] = useState<AgentTaskEvent[] | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 2000);
    request<{ events: AgentTaskEvent[] }>(token, `/scions/${scionId}/agent-tasks/${task.id}/events`, { signal: controller.signal, cache: 'no-store' }).then(result => { if (active) { setEvents(result.events); setError(''); } }).catch(() => { if (active) { setEvents(null); setError('Task event history could not be read.'); } }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [open, token, scionId, task.id, task.status, task.attempt]);
  return <details className="revision-details" onToggle={event => setOpen(event.currentTarget.open)}><summary>Immutable task events</summary>{error && <p className="scope-gap">{error}</p>}{open && !events && !error && <p role="status">Loading task events…</p>}{events && <ol className="agent-event-list">{events.map(event => <li key={event.id}><strong>{event.status}</strong><span>{when(event.recorded_at)} · attempt {event.attempt}</span><p className="field-help">Principal <code>{event.principal_id}</code></p><pre className="scope-json">{JSON.stringify(event.details, null, 2)}</pre></li>)}</ol>}</details>;
}
