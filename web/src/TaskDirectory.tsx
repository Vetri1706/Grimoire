import { useEffect, useState } from 'react';
import type { WorkspaceState } from './workspace-api';
import { WorkIcon } from './Workbench';
import AgentAvatar from './AgentAvatar';
import WorkStateGlyph from './WorkStateGlyph';
import { taskWorkflow, taskWorkflowPriority } from './task-workflow';
import type { TaskWorkflow } from './task-workflow';
import './task-directory.css';

const statuses = ['To do', 'In progress', 'Needs input', 'Needs review', 'Completed', 'Blocked', 'Cancelled'] as const;
type Task = WorkspaceState['tasks'][number];
type View = { filter: string; sort: 'attention' | 'newest' | 'oldest'; group: 'none' | 'status' | 'scion' };
const defaultView: View = { filter: 'All', sort: 'attention', group: 'none' };
const title = (task: Task) => task.task_kind === 'research_public_web' ? 'Research procurement' : task.task_kind === 'prepare_capability_plan' ? 'Plan product capabilities' : task.task_kind === 'prepare_physical_scope' ? 'Prepare physical scope' : 'Prepare offer comparison';

function readView(key: string): View {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    return {
      filter: ['All', 'Needs you', ...statuses].includes(saved?.filter) ? saved.filter : defaultView.filter,
      sort: ['attention', 'newest', 'oldest'].includes(saved?.sort) ? saved.sort : defaultView.sort,
      group: ['none', 'status', 'scion'].includes(saved?.group) ? saved.group : defaultView.group,
    };
  } catch { return defaultView; }
}

function workflow(task: Task, data: WorkspaceState) {
  const scion = data.scions.find(item => item.id === task.scion_id);
  const brief = scion?.revision;
  return taskWorkflow({ status: task.status, blocked: task.blocked, stale: task.stale || Boolean(scion && task.scion_revision !== scion.current_revision), reviewed: task.review_recorded, needsInput: Boolean(task.task_kind === 'prepare_capability_plan' && brief && (brief.questions?.length || !brief.decision?.trim())) });
}

function detail(task: Task, state: TaskWorkflow, data: WorkspaceState) {
  if (task.status === 'cancelled') return 'Work cancelled';
  if (task.blocked) return 'Evidence access changed · resolve blocker';
  if (task.stale || data.scions.some(scion => scion.id === task.scion_id && scion.current_revision !== task.scion_revision)) return 'Result is stale · replacement work needed';
  if (task.status === 'failed') return 'Last attempt failed · inspect and retry';
  if (task.status === 'cancel_requested') return 'Stopping · awaiting worker acknowledgement';
  if (task.status === 'dispatched') return 'Waiting for the connected worker';
  if (task.status === 'running') return data.agent_runtime.status === 'connected' ? 'Agent is preparing a result' : 'Last recorded: in progress · worker disconnected';
  if (state.state === 'needs_input') return 'Draft prepared · answer the remaining questions';
  if (task.proposal_id) return task.review_recorded ? 'Human review recorded · no approval granted' : 'Deliverable ready · human review pending';
  return 'Ready to start';
}

export function TaskStatus({ workflow: state }: { workflow: TaskWorkflow }) {
  return <span className={`task-status task-status-${state.state}`}><WorkStateGlyph state={state.state} />{state.label}</span>;
}

type Props = { data: WorkspaceState; canWrite: boolean; onNavigate: (route: string) => void };
export default function TaskDirectory(props: Props) {
  return <TaskDirectoryBody key={props.data.org_id} {...props} />;
}

function TaskDirectoryBody({ data, canWrite, onNavigate }: Props) {
  const preferenceKey = `grimoire:task-view:${data.org_id}`;
  const [view, setView] = useState(() => readView(preferenceKey));
  const [query, setQuery] = useState('');
  const [choosing, setChoosing] = useState(false);
  useEffect(() => { try { localStorage.setItem(preferenceKey, JSON.stringify(view)); } catch { /* Storage is optional; the current view remains usable. */ } }, [preferenceKey, view]);
  const scionName = (id: string) => data.scions.find(scion => scion.id === id)?.revision.name ?? 'Scion';
  const agentFor = (task: Task) => data.agents.find(agent => agent.id === task.agent_id);
  const assignee = (task: Task) => agentFor(task)?.config.name ?? (task.agent_id ? 'Assigned agent' : 'Codex worker');
  const records = data.tasks.map(task => ({ task, state: workflow(task, data) }));
  const needsYou = records.filter(({ state }) => ['needs_input', 'needs_review'].includes(state.state)).length;
  const tasks = records.filter(({ task, state }) => (view.filter === 'All' || (view.filter === 'Needs you' ? ['needs_input', 'needs_review'].includes(state.state) : state.label === view.filter)) && `${title(task)} ${scionName(task.scion_id)} ${assignee(task)} ${task.id}`.toLowerCase().includes(query.trim().toLowerCase())).sort((left, right) => {
    const byDate = Date.parse(right.task.created_at) - Date.parse(left.task.created_at);
    return view.sort === 'oldest' ? -byDate : view.sort === 'newest' ? byDate : taskWorkflowPriority(left.state) - taskWorkflowPriority(right.state) || byDate;
  });
  const groups = new Map<string, typeof tasks>();
  for (const record of tasks) {
    const key = view.group === 'status' ? record.state.label : view.group === 'scion' ? record.task.scion_id : 'all';
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const open = (task: Task) => onNavigate(`/scions/${task.scion_id}/${task.task_kind === 'research_public_web' ? 'research' : data.scions.find(scion => scion.id === task.scion_id)?.revision.product_category === 'digital' ? 'tasks' : 'agent-work'}/${task.id}`);
  const emptyScions = data.scions.filter(scion => !data.tasks.some(task => task.scion_id === scion.id));
  const filtered = Boolean(query || view.filter !== 'All');
  return <section className="work-page task-directory">
    <h1 className="sr-only">Tasks</h1>
    {choosing && <section className="task-scion-picker"><div className="task-directory-section-heading"><div><h2>Choose a Scion</h2><p>Keep the task connected to the product it supports.</p></div><button className="text-button" onClick={() => setChoosing(false)}>Close</button></div>{data.scions.map(scion => <button className="work-row" key={scion.id} onClick={() => onNavigate(`/scions/${scion.id}/${scion.revision.product_category === 'digital' ? 'tasks/new' : 'agent-work'}`)}><WorkIcon name="scions" /><strong>{scion.revision.name}</strong><WorkIcon name="arrow" /></button>)}<button className="text-button" onClick={() => onNavigate('/new')}>Create a Scion →</button></section>}
    <div className="task-directory-toolbar">
      <button className="button secondary" disabled={!canWrite} aria-expanded={choosing} onClick={() => data.scions.length ? setChoosing(value => !value) : onNavigate('/new')}><WorkIcon name="new" />New task</button>
      <label className="task-directory-search"><WorkIcon name="search" /><input aria-label="Search tasks" placeholder="Search tasks…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="task-directory-view-controls">
        <label><span>Status</span><select aria-label="Filter tasks by status" value={view.filter} onChange={event => setView(previous => ({ ...previous, filter: event.target.value }))}>{['All', 'Needs you', ...statuses].map(label => <option key={label}>{label}</option>)}</select></label>
        <label><span>Group</span><select aria-label="Group tasks" value={view.group} onChange={event => setView(previous => ({ ...previous, group: event.target.value as View['group'] }))}><option value="none">No grouping</option><option value="status">Status</option><option value="scion">Scion</option></select></label>
        <label><span>Sort</span><select aria-label="Sort tasks" value={view.sort} onChange={event => setView(previous => ({ ...previous, sort: event.target.value as View['sort'] }))}><option value="attention">Next action first</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>
      </div>
    </div>
    <div className="task-directory-summary"><span role="status">{tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}{filtered ? ` of ${data.tasks.length}` : ''}</span>{needsYou > 0 && <button className="text-button" aria-pressed={view.filter === 'Needs you'} onClick={() => setView(previous => ({ ...previous, filter: previous.filter === 'Needs you' ? 'All' : 'Needs you' }))}>{needsYou} {needsYou === 1 ? 'needs' : 'need'} you <WorkIcon name="arrow" /></button>}{filtered && <button className="text-button" onClick={() => { setQuery(''); setView(previous => ({ ...previous, filter: 'All' })); }}>Clear filters</button>}</div>
    {tasks.length ? <div className="task-directory-list"><div className="task-directory-columns" aria-hidden="true"><span>Task</span><span>Assigned to</span><span>Status</span><span>Created</span><span /></div>{[...groups].map(([key, group]) => <section className="task-directory-group" key={key} aria-label={view.group === 'none' ? 'All tasks' : view.group === 'scion' ? scionName(key) : key}>{view.group !== 'none' && <h2>{view.group === 'scion' ? scionName(key) : key}<span>{group.length}</span></h2>}{group.map(({ task, state }) => <button key={task.id} className="task-directory-row" onClick={() => open(task)}>
      <span className="task-directory-title"><span className="task-directory-title-line"><strong>{title(task)}</strong><code title={task.id}>{task.id.slice(0, 8)}</code></span><span className="task-directory-context"><span>{scionName(task.scion_id)}</span><span aria-hidden="true">·</span><small>{detail(task, state, data)}</small></span></span>
      <span className="task-directory-assignee">{agentFor(task) ? <AgentAvatar id={task.agent_id ?? undefined} name={assignee(task)} size="sm" /> : <span className="task-directory-worker-icon"><WorkIcon name="runtime" /></span>}<span>{assignee(task)}{['needs_input', 'needs_review'].includes(state.state) && <small>Handler action needed</small>}</span></span>
      <TaskStatus workflow={state} /><time dateTime={task.created_at} title={new Date(task.created_at).toLocaleString()}>{new Date(task.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</time><WorkIcon name="arrow" />
    </button>)}</section>)}</div>
      : <div className="work-empty task-directory-empty"><WorkIcon name={data.tasks.length ? 'search' : 'tasks'} /><h2>{data.tasks.length ? 'No tasks match this view' : 'Your next step starts here'}</h2><p>{data.tasks.length ? 'Try another status or search by Scion, agent, or task ID.' : data.scions.length ? 'Open a Scion to plan its next steps.' : 'Describe your product in a Scion, then start a planning task.'}</p>{filtered && <button className="button secondary" onClick={() => { setQuery(''); setView(defaultView); }}>Reset view</button>}{!data.scions.length && <button className="button primary" disabled={!canWrite} onClick={() => onNavigate('/new')}>Create a Scion</button>}</div>}
    {!filtered && emptyScions.length > 0 && <section className="task-directory-ready"><h2>Ready to plan <span>{emptyScions.length}</span></h2>{emptyScions.map(scion => <button className="work-row" key={scion.id} onClick={() => onNavigate(`/scions/${scion.id}`)}><WorkIcon name="scions" /><span className="work-row-body"><strong>{scion.revision.name}</strong><small>No task started yet</small></span><span>Open Scion</span><WorkIcon name="arrow" /></button>)}</section>}
    {data.tasks.length >= data.collection_limit && <p className="task-directory-limit">Showing the most recent {data.collection_limit} tasks. Open a Scion for its full task list.</p>}
  </section>;
}
