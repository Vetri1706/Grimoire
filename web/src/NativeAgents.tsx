import { useEffect, useRef, useState } from 'react';
import type { FocusEvent, FormEvent, ReactNode } from 'react';
import { request } from './api';
import { useAgent } from './agents-api';
import type { AgentConfig, AgentDetail, NativeAgent, NativeTask } from './agents-api';
import type { WorkspaceState } from './workspace-api';
import { WorkIcon, WorkStatus, workTime } from './Workbench';
import AgentCreation from './AgentCreation';
import SkillsLibrary from './SkillsLibrary';
import AgentAvatar from './AgentAvatar';
import './native-agents.css';
import './native-directory.css';
import './agents-polish.css';

type Props = { token: string; page: string; route: string; data: WorkspaceState; canWrite: boolean; canExecute: boolean; canPrepare: boolean; onNavigate: (path: string) => void; onChanged: () => Promise<void>; onDirty: (dirty: boolean) => void };
const defaultAgent: AgentConfig = { name: '', role: 'planner', title: '', capabilities: '', instructions: 'Prepare evidence-bound Scion proposals. Keep unknowns explicit and require human review.', reports_to: null, adapter: 'codex_cli', timeout_seconds: 240, skill_ids: [], paused: false };
const sections = [
  { label: 'Agent', items: [['overview', 'Overview'], ['instructions', 'Instructions'], ['skills', 'Skills']] },
  { label: 'Runtime', items: [['runtime', 'Harness / Runtime'], ['credentials', 'Credentials'], ['tools', 'Tools']] },
  { label: 'Governance', items: [['permissions', 'Permissions / Trust'], ['revisions', 'Revisions']] },
  { label: 'Audit', items: [['activity', 'Activity'], ['runs', 'Runs'], ['usage', 'Usage & limits']] },
];

function revealAgentNavigationFocus(event: FocusEvent<HTMLElement>) {
  const navigation = event.currentTarget;
  if (!(event.target instanceof HTMLButtonElement) || navigation.scrollWidth <= navigation.clientWidth) return;
  const item = event.target.getBoundingClientRect();
  const viewport = navigation.getBoundingClientRect();
  // Keep the whole focused control and its outline inside the mobile scroll strip.
  const inset = 6;
  if (item.left < viewport.left + inset) navigation.scrollLeft += item.left - viewport.left - inset;
  else if (item.right > viewport.right - inset) navigation.scrollLeft += item.right - viewport.right + inset;
}

function Empty({ children }: { children: ReactNode }) { return <div className="work-empty">{children}</div>; }
function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) { return <section className="agent-card"><div className="work-section-title"><h2>{title}</h2>{action}</div>{children}</section>; }

export default function NativeAgents(props: Props) {
  const { token, page, route } = props;
  const [, , recordId, view = 'overview'] = route.split('/');
  const connection = useAgent(token, page === 'agents' && recordId && recordId !== 'new' ? recordId : undefined);
  if (page === 'skills') return <SkillsLibrary {...props} />;
  if (recordId === 'new') return <AgentCreation {...props} />;
  if (!recordId) return <AgentDirectory {...props} />;
  if (!connection.data) return <section className="work-page"><h1>Agent</h1><Empty>{connection.error || 'Checking agent access…'}{connection.error && <button className="button secondary" onClick={() => void connection.refresh()}>Reconnect</button>}</Empty></section>;
  return <AgentProfile key={`${token}:${recordId}`} {...props} detail={connection.data} view={view} refresh={connection.refresh} />;
}

function AgentDirectory({ data, onNavigate, canWrite }: Props) {
  const [filter, setFilter] = useState<'all' | 'active' | 'paused' | 'error'>('all');
  const [query, setQuery] = useState('');
  const connected = data.agent_runtime.status === 'connected';
  const state = (agent: NativeAgent) => agent.config.paused ? 'paused' : agent.status;
  const matches = (agent: NativeAgent, tab: typeof filter) => tab === 'all' || (tab === 'active' ? connected && state(agent) === 'running' : tab === 'paused' ? state(agent) === 'paused' : ['error', 'failed'].includes(state(agent)));
  const search = query.trim().toLocaleLowerCase();
  const agents = data.agents.filter(agent => matches(agent, filter) && `${agent.config.name} ${agent.config.title} ${agent.config.role} ${agent.config.capabilities}`.toLocaleLowerCase().includes(search)).sort((left, right) => left.config.name.localeCompare(right.config.name));
  const latestAssignments = new Map<string, WorkspaceState['tasks'][number]>();
  for (const task of data.tasks) {
    if (!task.agent_id) continue;
    const previous = latestAssignments.get(task.agent_id);
    if (!previous || new Date(task.created_at).getTime() > new Date(previous.created_at).getTime()) latestAssignments.set(task.agent_id, task);
  }
  return <section className="work-page native-directory agent-directory-page">
    <h1 className="agent-directory-accessible-title">Agents</h1>
    <div className="native-directory-toolbar"><div className="native-directory-tabs" role="group" aria-label="Filter agents by status">{(['all', 'active', 'paused', 'error'] as const).map(tab => <button key={tab} type="button" aria-pressed={filter === tab} onClick={() => setFilter(tab)}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}</div><button className="button secondary" disabled={!canWrite} onClick={() => onNavigate('/agents/new')}><WorkIcon name="new" />Create agent</button></div>
    <div className="agent-directory-subtoolbar"><p className="native-directory-count" role="status">{agents.length}{agents.length !== data.agents.length ? ` of ${data.agents.length}` : ''} {agents.length === 1 ? 'agent' : 'agents'}</p><label className="native-directory-search"><WorkIcon name="search" /><input aria-label="Search agents" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search agents…" /></label><div className="native-directory-runtime" title={connected ? 'Worker heartbeat received. Provider execution is confirmed by actual task outcomes.' : 'Active work cannot be verified while the worker is disconnected.'}><span>Worker <WorkStatus value={data.agent_runtime.status} /></span><span className="agent-directory-heartbeat">{data.agent_runtime.last_seen ? `Last seen ${workTime(data.agent_runtime.last_seen)}` : 'No heartbeat received'}</span>{!connected && <button type="button" className="text-button" onClick={() => onNavigate('/settings/runtime')}>Connect Codex <WorkIcon name="arrow" /></button>}</div></div>
    {filter === 'active' && <p className="native-directory-note">Agents with a recorded running task and a connected worker.</p>}
    {filter === 'error' && <p className="native-directory-note">Reported agent errors. Individual task failures remain in each agent’s Runs.</p>}
    {agents.length ? <div className="native-directory-list agent-directory-polished">{agents.map(agent => {
      const reported = state(agent);
      const unverified = reported === 'running' && !connected;
      const latest = latestAssignments.get(agent.id);
      const latestScion = data.scions.find(scion => scion.id === latest?.scion_id);
      return <button className="native-directory-row" key={agent.id} onClick={() => onNavigate(`/agents/${agent.id}`)}>
        <span className="native-directory-identity"><AgentAvatar name={agent.config.name} id={agent.id} /><span><strong>{agent.config.name}</strong><small>{agent.config.title || agent.config.role}</small></span></span>
        <span className="native-directory-adapter"><strong>{agent.config.adapter === 'codex_cli' ? 'Codex CLI' : agent.config.adapter}</strong><small>{agent.config.skill_ids.length} {agent.config.skill_ids.length === 1 ? 'skill' : 'skills'} · r{agent.revision}</small></span>
        <span className="native-directory-latest"><strong>{latest ? latestScion?.revision.name ?? 'Scion' : 'No recent assignment'}</strong>{latest && <small>Assigned {workTime(latest.created_at)}</small>}</span>
        <span className="native-directory-state"><WorkStatus value={unverified ? 'disconnected' : reported} />{unverified && <small>Last recorded: running</small>}</span><WorkIcon name="arrow" />
      </button>;
    })}</div> : <Empty>{data.agents.length ? <><h2>No matching agents</h2><p>{search ? 'Try another name, role, or title.' : `No agents match the ${filter} filter.`}</p><button className="text-button" type="button" onClick={() => { setQuery(''); setFilter('all'); }}>Clear filters</button></> : <><h2>Create your first agent</h2><p>Give an agent instructions and skills, then assign a Scion. Work starts only when a Handler dispatches it.</p><button className="button primary" disabled={!canWrite} onClick={() => onNavigate('/agents/new')}>Create your first agent</button></>}</Empty>}
  </section>;
}

function AgentProfile(props: Props & { detail: AgentDetail; view: string; refresh: () => Promise<void> }) {
  const { detail, view, token, data, canWrite, canExecute, canPrepare, onNavigate, onChanged, refresh } = props;
  const { agent, tasks, runtime } = detail;
  const reportedState = agent.config.paused ? 'paused' : agent.status;
  const unverifiedRunning = reportedState === 'running' && runtime.status !== 'connected';
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const retry = useRef<{ body: string; key: string } | null>(null);
  const canControl = (task: NativeTask) => canExecute || (canPrepare && (task.task_kind === 'research_public_web' || task.task_kind === 'prepare_capability_plan' && data.scions.find(scion => scion.id === task.scion_id)?.revision.product_category === 'digital'));
  const next = tasks.filter(task => canControl(task) && task.status === 'queued' && !task.stale && !task.blocked).at(-1);
  const runs = tasks.filter(task => task.claimed_at);
  const go = (section: string) => onNavigate(`/agents/${agent.id}/${section}`);
  async function pause() {
    if (busy) return; setBusy(true); setError('');
    const body = JSON.stringify({ ...agent.config, paused: !agent.config.paused });
    if (retry.current?.body !== body) retry.current = { body, key: crypto.randomUUID() };
    try { await request(token, `/agents/${agent.id}`, { method: 'PUT', body, headers: { 'If-Match': `"${agent.revision}"`, 'Idempotency-Key': retry.current.key } }); retry.current = null; await refresh(); await onChanged(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Agent state could not be changed.'); }
    finally { setBusy(false); }
  }
  async function command(task: NativeTask, action: 'dispatch' | 'cancel') {
    if (!canControl(task) || busy) return; setBusy(true); setError('');
    try { await request(token, `/scions/${task.scion_id}/agent-tasks/${task.id}/${action}`, { method: 'POST', body: '{}', headers: { 'If-Match': `"${task.scion_revision}"` } }); await refresh(); await onChanged(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Task command failed.'); }
    finally { setBusy(false); }
  }
  const taskRows = (items: NativeTask[]) => items.length ? <div className="work-list">{items.map(task => <div className="work-row" key={task.id}><button className="work-row-body work-task-link" onClick={() => onNavigate(`/scions/${task.scion_id}/${task.task_kind === 'research_public_web' ? 'research' : data.scions.find(scion => scion.id === task.scion_id)?.revision.product_category === 'digital' ? 'tasks' : 'agent-work'}/${task.id}`)}><strong>{data.scions.find(scion => scion.id === task.scion_id)?.revision.name ?? 'Scion'}</strong><small>{task.task_kind.replaceAll('_', ' ')} · Agent r{task.agent_revision}</small></button><WorkStatus value={task.blocked ? 'blocked' : task.stale ? 'stale' : task.status} />{task.status === 'queued' && <button className="button secondary" disabled={!canControl(task) || busy || agent.config.paused || task.stale || task.blocked || runtime.status !== 'connected'} onClick={() => void command(task, 'dispatch')}>Run</button>}{['queued', 'dispatched', 'running'].includes(task.status) && <button className="text-button" disabled={!canControl(task) || busy} onClick={() => void command(task, 'cancel')}>Cancel</button>}<time>{workTime(task.completed_at || task.created_at)}</time></div>)}</div> : <Empty>No tasks assigned to this agent yet.</Empty>;
  return <div className="native-agent-layout"><nav className="agent-local-nav" aria-label="Agent navigation" onFocus={revealAgentNavigationFocus}>{sections.map(group => <section key={group.label}><h2>{group.label}</h2>{group.items.map(([key, title]) => <button key={key} className={view === key ? 'selected' : ''} aria-current={view === key ? 'page' : undefined} onClick={() => go(key)}><WorkIcon name={key === 'overview' ? 'dashboard' : key === 'activity' || key === 'revisions' ? 'audit' : key === 'tools' ? 'connectors' : key} />{title}</button>)}</section>)}</nav><div className="native-agent-content"><header className="native-agent-header"><AgentAvatar name={agent.config.name} id={agent.id} size="lg" /><div><h1>{agent.config.name}</h1><p>Codex CLI <span>·</span> {agent.config.role} <span>·</span> <WorkStatus value={unverifiedRunning ? 'disconnected' : reportedState} />{unverifiedRunning && <span>Last recorded: running</span>}</p></div><div className="native-agent-actions"><button className="button secondary" disabled={!(canExecute || canPrepare) || agent.config.paused} onClick={() => go('assign')}>+ Assign task</button><button className="button secondary" disabled={busy || !next || agent.config.paused || runtime.status !== 'connected'} title={runtime.status !== 'connected' ? 'Start the Grimoire worker to run assigned work.' : 'Dispatch the oldest eligible assigned task'} onClick={() => next && void command(next, 'dispatch')}>▷ Run now</button><button className="button secondary" disabled={!canWrite || busy} onClick={() => void pause()}>{agent.config.paused ? 'Resume' : 'Ⅱ Pause'}</button></div></header>{error && <div role="alert" className="work-empty">{error}</div>}
    {view === 'overview' && <><h2 className="native-view-title">Overview</h2><Card title="Latest run" action={<button className="text-button" onClick={() => go('runs')}>All runs →</button>}>{runs.length ? <><WorkStatus value={runs[0].status} /><p>{data.scions.find(scion => scion.id === runs[0].scion_id)?.revision.name ?? 'Scion'}</p><p className="work-muted">{runs[0].failure_code || (runs[0].status === 'completed' ? 'Proposal prepared. Human review remains required.' : 'Recorded task state; completion has not been confirmed.')}</p></> : <p className="work-muted">No run recorded. Assign a Scion task to get started.</p>}</Card><div className="native-card-grid"><Card title="Identity" action={<button className="text-button" onClick={() => go('identity')}>Edit</button>}><dl><div><dt>Role</dt><dd>{agent.config.role}</dd></div><div><dt>Title</dt><dd>{agent.config.title || 'Not set'}</dd></div><div><dt>Reports to</dt><dd>{data.agents.find(item => item.id === agent.config.reports_to)?.config.name ?? 'Handler board'}</dd></div><div><dt>Direct reports</dt><dd>{data.agents.filter(item => item.config.reports_to === agent.id).length}</dd></div></dl></Card><Card title="Harness / Runtime" action={<button className="text-button" onClick={() => go('runtime')}>Configure</button>}><dl><div><dt>Adapter</dt><dd>Codex CLI</dd></div><div><dt>Worker</dt><dd><WorkStatus value={runtime.status} /></dd></div><div><dt>Task limit</dt><dd>{agent.config.timeout_seconds} seconds</dd></div><div><dt>Last seen</dt><dd>{runtime.last_seen ? workTime(runtime.last_seen) : 'No heartbeat received'}</dd></div></dl></Card><Card title="Capabilities"><p>{agent.config.capabilities || 'No capability summary has been added.'}</p></Card><Card title="Skills" action={<button className="text-button" onClick={() => go('skills')}>Manage</button>}><div className="native-skill-tags">{agent.config.skill_ids.map(id => <span key={id}>{data.skills.find(skill => skill.id === id)?.config.name ?? 'Unavailable skill'}</span>)}</div>{!agent.config.skill_ids.length && <p className="work-muted">No skills assigned.</p>}</Card></div><Card title="Recent tasks" action={<button className="text-button" onClick={() => go('assign')}>Assign →</button>}>{taskRows(tasks.slice(0, 5))}</Card></>}
    {['identity', 'instructions', 'skills', 'runtime'].includes(view) && <AgentEditor key={`${agent.id}:${view}`} {...props} agent={agent} view={view} />}
    {view === 'assign' && <><AssignTask {...props} canWrite={canExecute || canPrepare} agent={agent} refresh={refresh} /><Card title="Assigned tasks">{taskRows(tasks)}</Card></>}
    {view === 'runs' && <><h2 className="native-view-title">Runs</h2><p className="work-muted">Real claimed Rust tasks. Queued work is not a run. Most recent 100 assigned tasks.</p>{runs.length ? runs.map(task => <details className="agent-run" key={task.id}><summary><WorkStatus value={task.status} /><strong>{data.scions.find(scion => scion.id === task.scion_id)?.revision.name ?? 'Scion'}</strong><time>{workTime(task.claimed_at)}</time></summary><dl><div><dt>Task</dt><dd><code>{task.id}</code></dd></div><div><dt>Agent config</dt><dd>Revision {task.agent_revision}</dd></div><div><dt>Provider session</dt><dd>{task.provider_run_id || 'Not reported'}</dd></div><div><dt>Failure</dt><dd>{task.failure_code || 'None recorded'}</dd></div><div><dt>Result digest</dt><dd><code>{task.output_sha256 || 'Not reported'}</code></dd></div></dl><button className="text-button" onClick={() => onNavigate(`/scions/${task.scion_id}/${task.task_kind === 'research_public_web' ? 'research' : task.task_kind === 'prepare_capability_plan' ? 'proposals' : task.task_kind === 'prepare_physical_scope' ? 'scope' : 'offers'}/${task.task_kind === 'research_public_web' ? task.id : task.proposal_id ?? ''}`)}>Open Scion result →</button></details>) : <Empty>No execution has been recorded for this agent.</Empty>}</>}
    {view === 'revisions' && <><h2 className="native-view-title">Configuration revisions</h2><p className="work-muted">Append-only history. Assigned tasks keep their original agent and skill snapshots.</p>{detail.revisions.map(revision => <details className="agent-run" key={revision.revision}><summary><strong>Revision {revision.revision}</strong><span>{revision.config.paused ? 'Paused' : 'Enabled'}</span><time>{workTime(revision.created_at)}</time></summary><dl><div><dt>Name / role</dt><dd>{revision.config.name} · {revision.config.role}</dd></div><div><dt>Task limit</dt><dd>{revision.config.timeout_seconds}s</dd></div><div><dt>Skills</dt><dd>{revision.config.skill_ids.length}</dd></div><div><dt>Author</dt><dd><code>{revision.created_by}</code></dd></div></dl><pre>{revision.config.instructions || 'No extra instructions.'}</pre></details>)}</>}
    {view === 'activity' && <><h2 className="native-view-title">Activity</h2><p className="work-muted">Persisted configuration revisions and task events. No prompts or source quotes.</p>{detail.revisions.map(revision => <div className="work-audit-row" key={`revision:${revision.revision}`}><WorkIcon name="audit" /><div><strong>Configuration revision {revision.revision}</strong><p>{revision.config.paused ? 'Agent paused' : 'Agent configuration saved'}</p></div><time>{workTime(revision.created_at)}</time></div>)}{detail.events.map(event => <div className="work-audit-row" key={event.id}><WorkStatus value={event.status} /><code>{event.task_id}</code><time>{workTime(event.recorded_at)}</time></div>)}</>}
    {view === 'credentials' && <><h2 className="native-view-title">Credentials</h2><Card title="Codex login"><p>Execution uses the installed Codex CLI login on the Grimoire worker machine. No browser or agent profile receives that credential.</p><p className="work-muted">A worker heartbeat is not proof of provider authentication. The outcome of an actual run reports success or failure.</p></Card><Card title="Worker transport"><p>The enrolled Grimoire proposal-worker credential stays on your computer. It cannot edit Scions, manage agents, confirm scope or approve decisions.</p><p className="work-muted">Connect and revoke organization workers in Runtime settings. Secrets are not accepted in instructions or skills.</p></Card></>}
    {view === 'tools' && <><h2 className="native-view-title">Tools</h2><Card title="Agent runtime"><dl><div><dt>Input</dt><dd>Revision-pinned preparation candidate or explicitly authorized public research brief</dd></div><div><dt>Output</dt><dd>Schema-validated proposal or cited research report</dd></div><div><dt>Public web research</dt><dd>Hosted search and bounded public-page capture, authorized separately per task</dd></div><div><dt>Shell / browser control</dt><dd>Disabled</dd></div><div><dt>Skills</dt><dd>Versioned preparation instructions, not executable plugins</dd></div></dl><p className="work-muted">Grimoire validates evidence and object permissions outside the model. Tool availability cannot be widened by an agent instruction.</p></Card></>}
    {view === 'permissions' && <><h2 className="native-view-title">Permissions / Trust</h2><Card title="Proposal-only authority"><ul className="native-policy"><li>Handler-controlled assignment and dispatch.</li><li>Organization-scoped Scion and source access.</li><li>Pause prevents new claims and requests cancellation of active work.</li><li>Revoked or stale evidence blocks preparation and results.</li><li>Agent completion never grants human review or sourcing approval.</li></ul></Card><p className="work-muted">Reporting lines organize the team; they do not grant security permissions. Authority is enforced by Rust and PostgreSQL, not editable prompts.</p></>}
    {view === 'usage' && <><h2 className="native-view-title">Usage & limits</h2><div className="native-card-grid"><Card title="Execution budget"><dl><div><dt>Per task</dt><dd>{agent.config.timeout_seconds} seconds maximum</dd></div><div><dt>Organization concurrency</dt><dd>{runtime.concurrency} active task</dd></div><div><dt>Recorded runs</dt><dd>{runs.length} in this 100-task window</dd></div></dl><button className="text-button" onClick={() => go('runtime')}>Configure task limit →</button></Card><Card title="Provider costs"><p>Not reported by this adapter.</p><p className="work-muted">No fabricated spend, token totals or dollar budget. Monetary budget enforcement is not implemented; the actual task timeout and concurrency limits remain enforced.</p></Card></div></>}
  </div></div>;
}

function AgentEditor(props: Props & { agent: NativeAgent | null; view: string }) {
  const { agent, view, data, token, canWrite, onDirty, onChanged, onNavigate } = props;
  const [config, setConfig] = useState<AgentConfig>(agent?.config ?? defaultAgent);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const baseRevision = useRef(agent?.revision); const retry = useRef<{ body: string; key: string } | null>(null);
  const pending = useRef(false); const alive = useRef(true); const controller = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  const change = <Key extends keyof AgentConfig>(key: Key, value: AgentConfig[Key]) => { setConfig(current => ({ ...current, [key]: value })); onDirty(true); };
  async function save(event: FormEvent) {
    event.preventDefault(); if (pending.current || !canWrite) return; pending.current = true; setBusy(true); setError(''); controller.current = new AbortController();
    const body = JSON.stringify(config); if (retry.current?.body !== body) retry.current = { body, key: crypto.randomUUID() };
    try { const result = await request<NativeAgent>(token, agent ? `/agents/${agent.id}` : '/agents', { method: agent ? 'PUT' : 'POST', body, signal: controller.current.signal, headers: { 'Idempotency-Key': retry.current.key, ...(agent ? { 'If-Match': `"${baseRevision.current}"` } : {}) } }); if (!alive.current) return; onDirty(false); await onChanged(); if (alive.current) onNavigate(`/agents/${result.id}`); }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : 'Configuration was not saved.'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return <form className="native-config-form" onSubmit={event => void save(event)}><h2>{!agent ? 'Agent identity' : view === 'identity' ? 'Identity' : view === 'runtime' ? 'Harness / Runtime' : view === 'skills' ? 'Skills' : 'Instructions'}</h2>
    {view === 'identity' && <><label>Name<input required maxLength={100} value={config.name} onChange={event => change('name', event.target.value)} placeholder="e.g. Scion planner" /></label><div className="native-field-pair"><label>Role<input required maxLength={100} value={config.role} onChange={event => change('role', event.target.value)} /></label><label>Title<input maxLength={160} value={config.title} onChange={event => change('title', event.target.value)} placeholder="Optional" /></label></div><label>Reports to<select value={config.reports_to ?? ''} onChange={event => change('reports_to', event.target.value || null)}><option value="">Handler board</option>{data.agents.filter(item => item.id !== agent?.id).map(item => <option key={item.id} value={item.id}>{item.config.name}</option>)}</select></label><label>Capabilities<textarea maxLength={2000} rows={3} value={config.capabilities} onChange={event => change('capabilities', event.target.value)} placeholder="What should this agent help with?" /></label></>}
    {(!agent || view === 'instructions') && <><label>Instructions<textarea rows={12} maxLength={12000} value={config.instructions} onChange={event => change('instructions', event.target.value)} /></label><p className="work-muted">Passed to the worker as a pinned configuration. Cannot authorize tools, remove evidence gaps or grant approval. Do not paste secrets or private source content here.</p></>}
    {view === 'skills' && <><div className="skills-agent-toolbar"><span>{config.skill_ids.length} / 8 selected</span><button type="button" className="text-button" onClick={() => onNavigate('/skills/discover')}>Discover skills →</button></div><p className="work-muted">Select up to eight Grimoire skills. Their exact text and revisions are pinned when a task is assigned; changing a skill affects future assignments only.</p>{data.skills.map(skill => <label className="native-checkbox" key={skill.id}><input type="checkbox" checked={config.skill_ids.includes(skill.id)} disabled={!canWrite || busy || (!config.skill_ids.includes(skill.id) && config.skill_ids.length >= 8)} onChange={event => change('skill_ids', event.target.checked ? [...config.skill_ids, skill.id] : config.skill_ids.filter(id => id !== skill.id))} /><span><strong>{skill.config.name}</strong><small>Revision {skill.revision} · {skill.config.description}</small></span></label>)}{!data.skills.length && <Empty>No skills yet. <button type="button" className="text-button" onClick={() => onNavigate('/skills/new')}>Create a skill →</button></Empty>}</>}
    {view === 'runtime' && <><label>Adapter<select value="codex_cli" disabled><option value="codex_cli">Codex CLI · local Grimoire worker</option></select></label><label>Model<input value="Installed adapter default" disabled /></label><label>Task timeout (seconds)<input type="number" min={30} max={300} required value={config.timeout_seconds} onChange={event => change('timeout_seconds', Number(event.target.value))} /></label><Card title="Worker connection"><WorkStatus value={data.agent_runtime.status} /><p>{data.agent_runtime.last_seen ? `Last seen ${workTime(data.agent_runtime.last_seen)}` : 'No heartbeat received'}</p><p className="work-muted">Start the Grimoire-owned worker from the repository:</p><button type="button" className="button secondary" onClick={() => onNavigate('/settings/runtime')}>Connect your Codex CLI</button><p className="work-muted">No Paperclip process is used. A running bridge does not establish provider login; inspect an actual run outcome.</p></Card></>}
    {error && <div role="alert" className="work-empty">{error}<button type="button" className="text-button" onClick={() => { if (agent && window.confirm('Discard this draft and load the latest configuration?')) { setConfig(agent.config); baseRevision.current = agent.revision; retry.current = null; setError(''); onDirty(false); } }}>Reload latest configuration</button></div>}
    <div className="native-form-actions"><button type="button" className="button secondary" onClick={() => onNavigate(agent ? `/agents/${agent.id}` : '/agents')}>Cancel</button><button className="button primary" disabled={!canWrite || busy}>{busy ? 'Saving…' : agent ? 'Save revision' : 'Create agent'}</button></div>
  </form>;
}

function AssignTask(props: Props & { agent: NativeAgent; refresh: () => Promise<void> }) {
  const { agent, token, data, canWrite, canExecute, canPrepare, onChanged, refresh, onDirty } = props;
  const availableScions = data.scions.filter(scion => canExecute || (canPrepare && scion.revision.product_category === 'digital'));
  const [scionId, setScionId] = useState(''); const [synthetic, setSynthetic] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  const retry = useRef<{ body: string; key: string } | null>(null);
  async function assign(event: FormEvent) {
    event.preventDefault(); if (!canWrite || !synthetic || busy) return; const scion = availableScions.find(item => item.id === scionId); if (!scion) return;
    setBusy(true); setError(''); const body = JSON.stringify({ task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, timeout_seconds: agent.config.timeout_seconds, agent_id: agent.id });
    const identity = `${scion.id}:${scion.current_revision}:${body}`; if (retry.current?.body !== identity) retry.current = { body: identity, key: crypto.randomUUID() };
    try { await request(token, `/scions/${scion.id}/agent-tasks`, { method: 'POST', body, headers: { 'If-Match': `"${scion.current_revision}"`, 'Idempotency-Key': retry.current.key } }); onDirty(false); retry.current = null; setNotice('Task assigned and queued. Run it explicitly when the worker is connected.'); setSynthetic(false); await refresh(); await onChanged(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Assignment failed.'); }
    finally { setBusy(false); }
  }
  return <form className="native-config-form" onSubmit={event => void assign(event)}><h2>Assign a Scion</h2><p className="work-muted">Prepare a capability proposal from an exact Scion revision. The agent configuration and skills are pinned now; this does not start execution.</p><label>Scion<select required value={scionId} onChange={event => { setScionId(event.target.value); onDirty(true); }}><option value="">Choose a Scion</option>{availableScions.map(scion => <option key={scion.id} value={scion.id}>{scion.revision.name} · r{scion.current_revision}</option>)}</select></label><label className="native-checkbox"><input type="checkbox" checked={synthetic} onChange={event => { setSynthetic(event.target.checked); onDirty(true); }} /><span>This is synthetic preparation only, not a real supplier or approval action.</span></label>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}<button className="button primary" disabled={!canWrite || !scionId || !synthetic || busy || agent.config.paused}>{busy ? 'Assigning…' : 'Assign task'}</button></form>;
}
