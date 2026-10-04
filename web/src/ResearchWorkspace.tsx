import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, request } from './api';
import type { Scion } from './api';
import type { AgentRuntime, NativeAgent } from './agents-api';
import type { AgentTask } from './scope-api';
import { publicResearchUrl, researchProviderLabel, useResearch } from './research-api';
import type { ResearchReport, ResearchSearchProvider } from './research-api';
import { taskCreationRejected, taskFailureExplanation, taskWorkflow } from './task-workflow';
import { TaskStatus } from './TaskDirectory';
import { useLayoutPreferences } from './LayoutPreferences';
import TaskSidePanel from './TaskSidePanel';
import AgentAvatar from './AgentAvatar';
import TaskConversation from './TaskConversation';
import './research-workspace.css';

type Props = { token: string; scion: Scion; nativeAgents: NativeAgent[]; runtime?: AgentRuntime; canPrepare: boolean; preferredTaskId: string | null; onNavigate: (path: string) => void; onDirty: (dirty: boolean) => void };
const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const errorText = (error: unknown) => error instanceof Error ? error.message : 'This action could not be completed. Your draft is still here.';

function SourceLink({ url, children }: { url: string; children?: React.ReactNode }) {
  const href = publicResearchUrl(url);
  return href ? <a href={href} target="_blank" rel="noopener noreferrer">{children || new URL(href).hostname} ↗</a> : <span>Invalid source URL</span>;
}

export default function ResearchWorkspace({ token, scion, nativeAgents, canPrepare, preferredTaskId, onNavigate, onDirty }: Props) {
  const { data, error: readError, unsupported, refresh } = useResearch(token, scion.id, scion.current_revision);
  const layout = useLayoutPreferences(); const panelOpen = layout.inspectorDock !== 'hidden';
  const panelTrigger = useRef<HTMLButtonElement>(null);
  const [objective, setObjective] = useState(''); const [agentId, setAgentId] = useState(''); const [connectionId, setConnectionId] = useState('');
  const [searchProvider, setSearchProvider] = useState<ResearchSearchProvider>('codex');
  const [consent, setConsent] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [chatDirty, setChatDirty] = useState(false);
  const submission = useRef<{ body: string; revision: number; key: string; task?: AgentTask; unknown: boolean } | null>(null);
  const reviewRetry = useRef<{ reportId: string; body: string; key: string } | null>(null);
  const mounted = useRef(true); const pending = useRef<AbortController | null>(null);
  const preparing = preferredTaskId === 'new';
  const selected = data?.tasks.find(task => task.id === preferredTaskId);
  const report = selected ? data?.reports.find(item => item.agent_task_id === selected.id) : undefined;
  const taskBrief = data?.briefs.find(brief => brief.task_id === selected?.id);
  const taskComputer = data?.worker_connections.find(connection => connection.connection_id === taskBrief?.worker_connection_id);
  const taskRuntime: AgentRuntime | undefined = taskComputer ? { backend: 'grimoire', adapter: 'codex_cli', protocol: 2, concurrency: 1, costs_available: false, status: taskComputer.status === 'connected' ? 'connected' : 'disconnected', last_seen: taskComputer.last_seen } : undefined;
  const activeAgents = nativeAgents.filter(agent => !agent.config.paused && ['idle', 'running'].includes(agent.status));
  const researchConnections = data?.worker_connections.filter(connection => connection.research_capable && connection.status === 'connected') ?? [];
  const capableConnections = researchConnections.filter(connection => searchProvider !== 'serpapi' || connection.serpapi_capable === true);
  const selectedAgent = activeAgents.find(agent => agent.id === agentId);
  const researchTimeout = Math.min(300, selectedAgent?.config.timeout_seconds ?? 300);
  const selectedConnection = capableConnections.find(connection => connection.connection_id === connectionId);
  const locked = busy || Boolean(submission.current);
  const dirty = Boolean(objective.trim() || reviewNote.trim() || submission.current || chatDirty);
  const reportFor = (task: AgentTask) => data?.reports.find(item => item.agent_task_id === task.id);
  const workflowFor = (task: AgentTask) => { const item = reportFor(task); return taskWorkflow({ status: task.status, stale: task.scion_revision !== scion.current_revision || item?.status === 'stale', blocked: item?.status === 'blocked', reviewed: item?.status === 'current' && Boolean(item.input) && Boolean(item.reviews.length) }); };
  const openTask = (id: string) => onNavigate(`/scions/${scion.id}/research/${id}`);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); onDirty(false); }; }, [onDirty]);
  useEffect(() => { setReviewNote(''); reviewRetry.current = null; }, [preferredTaskId]);
  useEffect(() => { if (report?.status === 'blocked') { setReviewNote(''); reviewRetry.current = null; } }, [report?.status]);

  async function write<T>(path: string, body: string, revision?: number, key?: string) {
    const controller = new AbortController(); pending.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 12000);
    try { return await request<T>(token, path, { method: 'POST', body, signal: controller.signal, headers: { ...(revision ? { 'If-Match': `"${revision}"` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } }); }
    finally { window.clearTimeout(timer); if (pending.current === controller) pending.current = null; }
  }
  async function start(event: FormEvent) {
    event.preventDefault(); if (busy || !canPrepare || !data) return;
    if (!submission.current && (!objective.trim() || !consent || !selectedAgent || !selectedConnection)) return;
    setBusy(true); setError(''); setNotice('');
    const retry = submission.current ?? { body: JSON.stringify({ task_kind: 'research_public_web', candidate_proposal: { synthetic: false, objective: objective.trim(), consent: true, policy_version: data.policy_version, worker_connection_id: connectionId, ...(searchProvider === 'serpapi' ? { search_provider: 'serpapi' } : {}) }, agent_id: agentId, timeout_seconds: researchTimeout }), revision: scion.current_revision, key: crypto.randomUUID(), unknown: false };
    submission.current = retry;
    try {
      if (!retry.task) retry.task = await write<AgentTask>(`/scions/${scion.id}/agent-tasks`, retry.body, retry.revision, retry.key);
      if (!mounted.current) return;
      // A lost dispatch response may already have been claimed or completed.
      // Recover the exact saved task before sending another command.
      const current = await request<{ tasks: AgentTask[] }>(token, `/scions/${scion.id}/agent-tasks`, { cache: 'no-store' });
      const saved = current.tasks.find(task => task.id === retry.task!.id);
      if (!saved) throw new Error('The saved task is not currently visible. Recheck access before retrying.');
      const task = saved.status === 'queued' ? await write<AgentTask>(`/scions/${scion.id}/agent-tasks/${saved.id}/dispatch`, '{}', retry.revision) : saved;
      if (!mounted.current) return;
      submission.current = null; setObjective(''); setConsent(false); onDirty(false); await refresh(); openTask(task.id);
    } catch (failure) {
      if (!mounted.current) return;
      if (!retry.task && failure instanceof ApiError && taskCreationRejected(failure.status, failure.code, retry.unknown)) submission.current = null;
      else retry.unknown = true;
      setError(`${errorText(failure)}${retry.task ? ' The task is saved; retrying will dispatch that same task.' : retry.unknown ? ' Retry the same request to recover its saved result safely.' : ''}`);
    } finally { if (mounted.current) setBusy(false); }
  }
  async function command(task: AgentTask, action: 'dispatch' | 'cancel') {
    if (busy || !canPrepare) return; setBusy(true); setError('');
    try { await write(`/scions/${scion.id}/agent-tasks/${task.id}/${action}`, '{}', action === 'dispatch' ? task.scion_revision : undefined); if (mounted.current) { setNotice(action === 'cancel' ? 'Cancellation requested. The recorded task status confirms when the worker has stopped.' : 'Task dispatched to its authorized computer.'); await refresh(); } }
    catch (failure) { if (mounted.current) setError(errorText(failure)); } finally { if (mounted.current) setBusy(false); }
  }
  async function review(event: FormEvent) {
    event.preventDefault(); if (!report || report.status !== 'current' || busy || !reviewNote.trim() || !canPrepare) return;
    setBusy(true); setError('');
    const retry = reviewRetry.current ?? { reportId: report.id, body: JSON.stringify({ note: reviewNote.trim() }), key: crypto.randomUUID() }; reviewRetry.current = retry;
    try { await write(`/scions/${scion.id}/research-reports/${retry.reportId}/reviews`, retry.body, scion.current_revision, retry.key); if (mounted.current) { setReviewNote(''); reviewRetry.current = null; setNotice('Review recorded. Procurement approval remains a separate decision.'); await refresh(); } }
    catch (failure) { if (mounted.current) setError(errorText(failure)); } finally { if (mounted.current) setBusy(false); }
  }
  async function revoke(captureId: string) {
    const reason = window.prompt('Why should this captured source be withdrawn from the research?');
    if (!reason?.trim() || busy || !canPrepare) return; setBusy(true); setError('');
    try { await write(`/scions/${scion.id}/research-captures/${captureId}/revoke`, JSON.stringify({ reason: reason.trim() })); if (mounted.current) { setReviewNote(''); reviewRetry.current = null; await refresh(); setNotice('Source withdrawn. Dependent research is blocked.'); } }
    catch (failure) { if (mounted.current) setError(errorText(failure)); } finally { if (mounted.current) setBusy(false); }
  }

  function openResearchResult() {
    const result = document.getElementById('research-result');
    const disclosure = result?.closest('details');
    if (disclosure) disclosure.open = true;
    result?.scrollIntoView({ block: 'start' });
  }
  const artifacts = report ? [{ id: report.id, title: 'Procurement research report', kind: 'Public web research', status: report.status, onOpen: openResearchResult }] : [];
  return <section className="research-workspace">
    <header className="research-toolbar"><div><button className="text-button" type="button" onClick={() => onNavigate('/tasks')}>← All tasks</button><h2>{selected ? 'Research procurement' : preparing ? 'Start public web research' : 'Research'}</h2></div><div>{selected && <button ref={panelTrigger} type="button" className="button secondary" aria-expanded={panelOpen} onClick={() => panelOpen ? layout.hideInspector() : layout.showInspector()}>{panelOpen ? 'Hide task panel' : 'Show task panel'}</button>}{!preparing && <button type="button" className="button primary" disabled={!canPrepare || !data} onClick={() => onNavigate(`/scions/${scion.id}/research/new`)}>Research the web</button>}</div></header>
    {(error || readError) && <p role="alert" className="error-message">{unsupported ? 'The running API does not yet support public research. Start the updated API after its database migration; your brief is preserved.' : error || readError}<button type="button" className="text-button" onClick={() => void refresh()}>Check again</button></p>}
    {notice && <p role="status" className="info-notice">{notice}</p>}
    {preparing && <form className="research-composer" onSubmit={event => void start(event)} aria-label="Public web research">
      <p>Find relevant suppliers or services, understand the procurement process, and collect sources for review.</p>
      <label>Public research brief<textarea value={objective} onChange={event => setObjective(event.target.value)} maxLength={4000} rows={6} required disabled={locked} placeholder="What are you sourcing, in which region, and what requirements should the agent investigate?" /></label>
      <p className="research-help">Write only what may be sent to public search. The Scion’s private brief and uploaded sources are not automatically included. The selected agent's instructions and assigned skills guide its work.</p>
      <label>Search provider<select aria-label="Search provider" value={searchProvider} onChange={event => { setSearchProvider(event.target.value as ResearchSearchProvider); setConnectionId(''); setConsent(false); }} disabled={locked}><option value="codex">Codex web search</option><option value="serpapi">SerpApi Google Search</option></select></label>
      <div className="research-form-row"><label>Assigned agent<select aria-label="Assigned agent" value={agentId} onChange={event => { setAgentId(event.target.value); setConsent(false); }} required disabled={locked}><option value="">Choose an agent</option>{activeAgents.map(agent => <option key={agent.id} value={agent.id}>{agent.config.name}</option>)}</select></label><label>Research computer<select aria-label="Research computer" value={connectionId} onChange={event => { setConnectionId(event.target.value); setConsent(false); }} required disabled={locked}><option value="">Choose a connected computer</option>{capableConnections.map(connection => <option key={connection.connection_id} value={connection.connection_id}>{connection.device_name}</option>)}</select></label></div>
      {!activeAgents.length && <p>Create an agent in <button type="button" className="text-button" onClick={() => onNavigate('/agents')}>Agents</button> to assign this task.</p>}
      {data && !capableConnections.length && <div className="research-blocker"><strong>{searchProvider === 'serpapi' ? 'No SerpApi research worker is ready' : 'No research worker is ready'}</strong><p>{searchProvider === 'serpapi' ? <>Configure <code>SERPAPI_API_KEY</code> on an authorized computer and restart its updated worker. The key stays on that computer.</> : 'Start the updated Codex worker on an authorized computer. Older workers can still prepare their existing tasks.'}</p><button type="button" className="text-button" onClick={() => onNavigate('/settings/runtime')}>Open agent connections →</button></div>}
      <label className="research-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} required disabled={locked} /><span>Allow {selectedAgent?.config.name ?? 'this agent'} on {selectedConnection?.device_name ?? 'the selected computer'} to research this public brief using {searchProvider === 'serpapi' ? 'SerpApi Google Search and my Codex account' : 'Codex web search with my Codex account'} and retrieve public pages for this task. {searchProvider === 'serpapi' && 'Up to 3 searches are sent to SerpApi and may consume search credits. '}Results require my review.</span></label>
      <div className="research-form-footer"><span>Report: up to {searchProvider === 'serpapi' ? 3 : 5} queries · 8 captured sources · {researchTimeout < 60 ? `${researchTimeout} seconds` : `${Number((researchTimeout / 60).toFixed(1))} minutes`} task limit</span><button type="submit" className="button primary" disabled={busy || !canPrepare || !data || (!submission.current && (!consent || !selectedAgent || !selectedConnection || !objective.trim()))}>{busy ? 'Starting…' : submission.current ? 'Retry saved request' : 'Start research'}</button></div>
    </form>}
    {!preparing && !selected && data && <div className="research-task-list">{preferredTaskId ? <p role="status">This task is unavailable in the current Scion.</p> : data.tasks.length ? data.tasks.map(task => <button className="research-task-row" key={task.id} onClick={() => openTask(task.id)}><span><strong>Procurement research</strong><small>Revision {task.scion_revision} · {when(task.created_at)}</small></span><TaskStatus workflow={workflowFor(task)} /><span aria-hidden="true">→</span></button>) : <div className="research-empty"><h3>Turn a sourcing question into a researched plan</h3><p>Describe the requirement. Your agent searches public information and prepares a cited report for you to review.</p></div>}</div>}
    {selected && <div className={`research-layout${panelOpen ? '' : ' research-layout-wide'}`} data-inspector-side={layout.inspectorSide}>
      <article className="research-main research-chat-main">
        <TaskConversation token={token} scion={scion} task={selected} nativeAgents={nativeAgents} canPrepare={canPrepare} onNavigate={onNavigate} onDirty={setChatDirty} onChanged={refresh}
          renderResponse={response => response.task_id === selected.id && report?.input ? <button type="button" className="task-thread-deliverable" onClick={openResearchResult}><span>Procurement research report</span><span>Inspect result →</span></button> : undefined} intro={<>
        <div className="research-task-heading"><TaskStatus workflow={workflowFor(selected)} />{nativeAgents.find(agent => agent.id === selected.agent_id) && <span className="research-assignee"><AgentAvatar id={selected.agent_id!} name={nativeAgents.find(agent => agent.id === selected.agent_id)!.config.name} size="sm" />{nativeAgents.find(agent => agent.id === selected.agent_id)!.config.name}</span>}<small>Scion revision {selected.scion_revision}</small></div>
        {selected.scion_revision !== scion.current_revision && <p className="research-blocker">The brief has changed. This result belongs to an earlier revision. Start replacement research against the current brief.</p>}
        {taskBrief && <details className="task-thread-brief research-objective"><summary>Public research brief · Revision {selected.scion_revision}</summary><p>{taskBrief.objective}</p><small>Search provider: {researchProviderLabel(taskBrief.search_provider ?? 'codex')}</small></details>}
        {selected.status === 'failed' && <p className="research-blocker">{taskFailureExplanation(selected.failure_code)} <code>{selected.failure_code}</code></p>}
        {['dispatched', 'running', 'cancel_requested'].includes(selected.status) && <p role="status">{selected.status === 'dispatched' ? 'Waiting for the authorized research worker.' : selected.status === 'cancel_requested' ? 'Waiting for the worker to stop.' : 'The agent is researching public sources. Its result will appear here.'}</p>}
        <div className="research-task-actions">{selected.status === 'queued' && <button className="button primary" disabled={busy || !canPrepare || selected.scion_revision !== scion.current_revision} onClick={() => void command(selected, 'dispatch')}>Start research</button>}{['queued', 'dispatched', 'running'].includes(selected.status) && <button className="button secondary" disabled={busy || !canPrepare} onClick={() => void command(selected, 'cancel')}>Cancel task</button>}{['failed', 'cancelled'].includes(selected.status) && <button className="button primary" disabled={!canPrepare} onClick={() => onNavigate(`/scions/${scion.id}/research/new`)}>Create replacement research</button>}</div>
        </>}>
        {report && <details className="research-deliverable"><summary><span>Research report</span><small>{report.status === 'current' ? 'Deliverable · review required' : report.status}</small></summary><ResearchResult report={report} canPrepare={canPrepare} busy={busy} onRevoke={id => void revoke(id)} /></details>}
        {selected.status === 'completed' && report?.input && report.status === 'current' && <section className="research-review"><h3>Review result</h3><p>Check the sources and record your assessment. This does not approve a supplier, purchase, price, or product identity.</p>{report.reviews.map(receipt => <div className="research-review-receipt" key={receipt.id}><p>{receipt.note}</p><small>Review recorded {when(receipt.created_at)}</small></div>)}<form onSubmit={event => void review(event)}><label>Review note<textarea rows={3} value={reviewNote} maxLength={4000} onChange={event => setReviewNote(event.target.value)} disabled={busy || Boolean(reviewRetry.current)} required /></label><button className="button primary" disabled={busy || !canPrepare || !reviewNote.trim()}>{reviewRetry.current ? 'Retry saved review' : 'Record review'}</button></form></section>}
        {!report && selected.status === 'completed' && <p role="status">The saved report is not available in this view. Recheck access before relying on the result.</p>}
        </TaskConversation>
      </article>
      {panelOpen && <TaskSidePanel task={selected} scion={scion} agent={nativeAgents.find(agent => agent.id === selected.agent_id)} runtime={taskRuntime} workflow={workflowFor(selected)} relatedTasks={data!.tasks.map(task => ({ id: task.id, title: 'Research procurement', status: workflowFor(task), agentId: task.agent_id ?? undefined, agentName: nativeAgents.find(agent => agent.id === task.agent_id)?.config.name }))} artifacts={artifacts} dependencies={(report?.captures ?? []).map(capture => ({ id: capture.id, title: (capture.status === 'revoked') ? 'Withdrawn web source' : capture.final_url || capture.url || 'Source unavailable', status: (capture.status === 'revoked') ? 'Revoked' : capture.status }))} reviewCount={report?.reviews.length} onNavigate={onNavigate} onSelectTask={openTask} onClose={() => { layout.hideInspector(); panelTrigger.current?.focus(); }} />}
    </div>}
  </section>;
}

function ResearchResult({ report, canPrepare, busy, onRevoke }: { report: ResearchReport; canPrepare: boolean; busy: boolean; onRevoke: (id: string) => void }) {
  if (!report.input) return <p className="research-blocker">Source access has changed. This report is hidden until replacement research is available.</p>;
  const input = report.input;
  return <section id="research-result" className="research-result"><div className="research-result-heading"><h3>Research report</h3><span>Agent findings · unverified</span></div><p>{input.summary}</p>
    <section><h3>Procurement process</h3>{input.process_steps.length ? <ol className="research-steps">{input.process_steps.map((step, index) => <li key={index}><h4>{step.title}</h4><p>{step.detail}</p><div className="research-citations">{step.source_urls.length ? step.source_urls.map(url => <SourceLink key={url} url={url} />) : <span>Agent inference; no source attached</span>}</div></li>)}</ol> : <p>No supported process steps were found.</p>}</section>
    <section><h3>Candidates to assess</h3>{input.candidates.length ? input.candidates.map((candidate, index) => <article className="research-candidate" key={index}><h4><SourceLink url={candidate.url}>{candidate.name}</SourceLink></h4><p>{candidate.rationale}</p><div className="research-citations">{candidate.source_urls.length ? candidate.source_urls.map(url => <SourceLink key={url} url={url} />) : <span>Agent inference; no source attached</span>}</div></article>) : <p>No supported candidates were found.</p>}</section>
    {input.unresolved_gaps.length > 0 && <section><h3>Still needs an answer</h3><ul>{input.unresolved_gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></section>}
    <section><h3>Sources</h3><p className="research-help">Captures record what the server retrieved at that time. They do not verify the agent’s interpretation or establish current pricing or availability.</p>{input.sources.map((source, index) => <div className="research-source" key={index}><SourceLink url={source.url}>{source.title}</SourceLink><small>{source.url}</small></div>)}{report.captures.map(capture => <details className="research-capture" key={capture.id}><summary>{capture.final_url || capture.url} · {(capture.status === 'revoked') ? 'Withdrawn' : capture.status}</summary>{(capture.status === 'revoked') ? <p>Captured content has been withdrawn.</p> : <><p className="research-help">Retrieved {when(capture.fetched_at)}</p>{capture.failure_code && <p>{capture.failure_code}</p>}{capture.excerpt && <pre>{capture.excerpt}</pre>}{capture.content_sha256 && <p className="research-hash">SHA-256 <code>{capture.content_sha256}</code></p>}{canPrepare && <button type="button" className="text-button" disabled={busy} onClick={() => onRevoke(capture.id)}>Withdraw source</button>}</>}</details>)}</section>
    <details className="research-provenance"><summary>Research provenance</summary><p>Report saved {when(report.created_at)} · Scion revision {report.scion_revision}</p><ol>{input.queries.map((query, index) => <li key={index}>{query.query}<small>{researchProviderLabel(query.provider ?? 'codex')} · {when(query.observed_at)}</small>{query.search_id && <small>Search ID: <code>{query.search_id}</code></small>}</li>)}</ol><code>{report.id}</code></details>
  </section>;
}
