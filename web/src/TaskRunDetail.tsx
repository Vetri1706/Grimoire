import { useLayoutPreferences } from './LayoutPreferences';
import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from './api';
import type { Scion } from './api';
import type { AgentRuntime, NativeAgent } from './agents-api';
import type { AgentTask, AgentTaskList } from './scope-api';
import { useCaseInvalidation } from './control-api';
import type { ControlSurfaceConnection } from './control-api';
import AgentAvatar from './AgentAvatar';
import AgentTasks from './AgentTasks';
import TaskSidePanel from './TaskSidePanel';
import type { TaskArtifact, TaskDependency } from './TaskSidePanel';
import { TaskStatus } from './TaskDirectory';
import { taskFailureExplanation, taskWorkflow } from './task-workflow';
import type { TaskWorkflow } from './task-workflow';
import './task-run-detail.css';

type Props = {
  token: string; scion: Scion; preferredTaskId: string; nativeAgents: NativeAgent[];
  runtime?: AgentRuntime; canWrite: boolean; canPrepare?: boolean;
  control: ControlSurfaceConnection; onNavigate: (path: string) => void;
};

const taskTitle = (task: AgentTask) => task.task_kind === 'prepare_capability_plan' ? 'Prepare capability plan' : task.task_kind === 'prepare_physical_scope' ? 'Prepare physical scope' : 'Prepare supplier offer worksheet';
const outputTitle = (task: AgentTask) => task.task_kind === 'prepare_capability_plan' ? 'Capability plan' : task.task_kind === 'prepare_physical_scope' ? 'Physical scope proposal' : 'Offer normalization proposal';
const outputRoute = (kind: AgentTask['task_kind']) => kind === 'prepare_capability_plan' ? 'proposals' : kind === 'prepare_physical_scope' ? 'scope' : 'offers';
const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// This lease governs displayed metadata. Persisted Watchtower checks run on the server.
function useTaskRecords(token: string, scionId: string, revision: number) {
  const [tasks, setTasks] = useState<AgentTask[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const epoch = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const lease = useRef<number | undefined>(undefined);
  const clear = useCallback((reason: string) => {
    epoch.current++; pending.current?.abort(); pending.current = null;
    window.clearTimeout(lease.current); setTasks(null); setError(reason); setLoading(false);
  }, []);
  useCaseInvalidation(scionId, clear);
  const refresh = useCallback(async (force = false) => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    if (pending.current && !force) return;
    if (force) { epoch.current++; pending.current?.abort(); pending.current = null; }
    const generation = epoch.current;
    const started = Date.now();
    const controller = new AbortController(); pending.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 2500);
    try {
      const result = await request<AgentTaskList>(token, `/scions/${encodeURIComponent(scionId)}/agent-tasks`, { signal: controller.signal, cache: 'no-store' });
      if (generation !== epoch.current) return;
      if (!Array.isArray(result.tasks) || result.tasks.some(task => task.scion_id !== scionId)) throw new Error('The task list could not be verified for this Scion.');
      if (document.visibilityState !== 'visible' || !navigator.onLine || Date.now() >= started + 5000) { clear('Task access expired. Details are hidden until access is rechecked.'); return; }
      setTasks(result.tasks); setError(''); setLoading(false);
      window.clearTimeout(lease.current);
      lease.current = window.setTimeout(() => clear('The connection is overdue. Task details are hidden until access is rechecked.'), Math.max(0, started + 5000 - Date.now()));
    } catch (failure) {
      if (generation === epoch.current) clear(failure instanceof Error ? failure.message : 'Task details could not be checked.');
    } finally {
      window.clearTimeout(timeout);
      if (pending.current === controller) pending.current = null;
    }
  }, [token, scionId, clear]);
  useEffect(() => {
    setTasks(null); setLoading(true); void refresh(true);
    const timer = window.setInterval(() => void refresh(), 2000);
    const changed = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void refresh(true);
      else clear('This page is hidden or offline. Task details are hidden until access is rechecked.');
    };
    document.addEventListener('visibilitychange', changed);
    window.addEventListener('offline', changed); window.addEventListener('online', changed);
    window.addEventListener('pagehide', changed); window.addEventListener('pageshow', changed);
    return () => {
      epoch.current++; pending.current?.abort(); pending.current = null;
      window.clearTimeout(lease.current); window.clearInterval(timer);
      document.removeEventListener('visibilitychange', changed);
      window.removeEventListener('offline', changed); window.removeEventListener('online', changed);
      window.removeEventListener('pagehide', changed); window.removeEventListener('pageshow', changed);
    };
  }, [refresh, clear, revision]);
  return { tasks, error, loading, refresh };
}

export default function TaskRunDetail(props: Props) {
  return <TaskRunDetailBody key={`${props.token}:${props.scion.id}`} {...props} />;
}

function TaskRunDetailBody({ token, scion, preferredTaskId, nativeAgents, runtime, canWrite, canPrepare = false, control, onNavigate }: Props) {
  const { tasks, error, loading, refresh } = useTaskRecords(token, scion.id, scion.current_revision);
  const { inspectorDock, inspectorSide, showInspector, hideInspector } = useLayoutPreferences();
  const panelOpen = inspectorDock !== 'hidden';
  const panelTrigger = useRef<HTMLButtonElement>(null);
  const projection = control.data?.scion_id === scion.id && control.data.scion_revision === scion.current_revision ? control.data : null;
  const checkedRuntime = projection?.operations.agent_runtime ?? runtime;
  const selected = projection && tasks?.find(task => task.id === preferredTaskId);
  const flagsFor = (task: AgentTask) => projection?.operations.tasks.find(record => record.id === task.id);
  const flags = selected ? flagsFor(selected) : undefined;
  const workflowFor = (task: AgentTask): TaskWorkflow => {
    const state = flagsFor(task);
    const value = taskWorkflow({ status: task.status, blocked: !state || state.blocked, stale: state?.stale || task.scion_revision !== scion.current_revision });
    // The queue does not report physical/offer confirmation. Its canonical proposal does.
    return value.state === 'needs_review' && task.task_kind !== 'prepare_capability_plan' ? { ...value, label: 'Inspect result' } : value;
  };
  const ready = Boolean(selected && flags);
  const stale = Boolean(selected && (flags?.stale || selected.scion_revision !== scion.current_revision));
  const blocked = Boolean(flags?.blocked);
  const agent = nativeAgents.find(record => record.id === selected?.agent_id);
  const agentName = agent?.config.name ?? (selected?.agent_id ? 'Assigned agent' : 'Unassigned task');
  const openOutput = (id: string, kind: AgentTask['task_kind']) => onNavigate(`/scions/${scion.id}/${outputRoute(kind)}/${id}`);
  const selectTask = (id: string) => onNavigate(`/scions/${scion.id}/${tasks?.find(task => task.id === id)?.task_kind === 'research_public_web' ? 'research' : 'agent-work'}/${id}`);
  const artifacts: TaskArtifact[] = ready && selected?.proposal_id ? [{
    id: selected.proposal_id, title: outputTitle(selected), kind: 'Proposal',
    status: blocked ? 'Blocked' : stale ? 'Stale' : 'Prepared · inspect review state',
    onOpen: () => openOutput(selected.proposal_id!, selected.task_kind),
  }] : [];
  const dependencies: TaskDependency[] = ready && projection ? projection.edges
    .filter(edge => edge.kind === 'evidence_dependency' && edge.target === `task:${selected!.id}`)
    .filter((edge, index, edges) => edges.findIndex(other => other.source === edge.source) === index)
    .map(edge => {
      const node = projection.nodes.find(record => record.id === edge.source);
      const available = node?.kind === 'evidence_source' && node.status === 'available' && !node.stale && node.details !== null;
      return { id: edge.source, title: available ? node.title : node?.status === 'revoked' ? 'Revoked source' : 'Source access unavailable', status: available ? 'Available · unverified' : 'Content hidden', onOpen: () => onNavigate(`/scions/${scion.id}/sources`) };
    }) : [];
  const relatedTasks = ready ? (tasks ?? []).filter(task => flagsFor(task)).map(task => ({
    id: task.id, title: taskTitle(task), status: workflowFor(task), agentId: task.agent_id ?? undefined,
    agentName: nativeAgents.find(record => record.id === task.agent_id)?.config.name,
  })) : [];
  const recheck = async () => { await Promise.all([refresh(true), control.refresh()]); };
  const taskNode = selected ? projection?.nodes.find(node => node.id === `task:${selected.id}`) : undefined;

  return <section className="task-run-workspace" aria-label="Task detail">
    <div className="task-run-toolbar">
      <span className="task-run-reference"><button type="button" className="text-button" onClick={() => onNavigate('/tasks')}>← All tasks</button><code>{preferredTaskId.slice(0, 8)}</code></span>
      <div><button type="button" className="button secondary" onClick={() => void recheck()}>Refresh</button>
        {ready && <button ref={panelTrigger} type="button" className="button secondary" aria-expanded={panelOpen} onClick={() => panelOpen ? hideInspector() : showInspector()}>{panelOpen ? 'Hide details' : 'Show details'}</button>}</div>
    </div>
    {!ready ? <div className="task-run-unavailable" role="status">
      <h2>{loading || control.loading ? 'Checking task access…' : !projection || error ? 'Task details are unavailable' : 'Task could not be matched to the current case'}</h2>
      <p>{error || control.error || (loading || control.loading || !projection ? 'Details will appear after the current Scion and source permissions are checked.' : 'This task is not in the latest available records. Return to Tasks or refresh to check again.')}</p>
      {!loading && <button className="button secondary" type="button" onClick={() => void recheck()}>Check again</button>}
    </div> : selected && <div data-inspector-side={inspectorSide} className={`task-run-layout${panelOpen ? '' : ' task-run-layout-wide'}`}>
      <article className="task-run-main">
        <header className="task-run-heading">
          <TaskStatus workflow={workflowFor(selected)} />
          <h2>{taskTitle(selected)}</h2>
          <div className="task-run-assignment">{selected.agent_id && <AgentAvatar id={selected.agent_id} name={agentName} size="md" />}
            {selected.agent_id ? <button className="text-button" type="button" onClick={() => onNavigate(`/agents/${selected.agent_id}`)}>{agentName}</button> : <span>{agentName}</span>}
            <span>Scion revision {selected.scion_revision}</span>
          </div>
          <p>Created {when(selected.created_at)}</p>
        </header>
        {(blocked || stale) && <div className="task-run-blocker" role="status"><strong>{blocked ? 'Dependent work is blocked' : 'This task uses an older revision'}</strong>
          <p>{taskNode?.blockers.length ? taskNode.blockers.join(' ') : blocked ? 'Inspect the source permissions and proposal before continuing.' : 'Inspect the current proposal and prepare replacement work from the latest Scion revision.'}</p>
          <button type="button" className="text-button" onClick={() => onNavigate(`/scions/${scion.id}/${blocked ? 'sources' : outputRoute(selected.task_kind)}`)}>{blocked ? 'Inspect sources' : 'Open current proposal workspace'} →</button>
        </div>}
        {selected.status === 'failed' && <p className="task-run-blocker">{taskFailureExplanation(selected.failure_code)}</p>}
        {selected.status === 'completed' && <p className="task-run-review-note">Preparation is complete. Open the proposal to inspect its current review and confirmation state.</p>}
        <AgentTasks key={selected.id} runtime={checkedRuntime} token={token} scionId={scion.id} currentRevision={scion.current_revision}
          canWrite={canWrite} canPrepareCapability={canPrepare} canDispatchTask={() => !blocked && !stale} tasks={[selected]} error="" compact
          onOpen={openOutput} onChanged={recheck} />
      </article>
      {panelOpen && <TaskSidePanel key={selected.id} task={selected} scion={scion} agent={agent} runtime={checkedRuntime}
        workflow={workflowFor(selected)} relatedTasks={relatedTasks} artifacts={artifacts} dependencies={dependencies}
        onNavigate={onNavigate} onSelectTask={selectTask} onClose={() => { hideInspector(); panelTrigger.current?.focus(); }} />}
    </div>}
  </section>;
}
