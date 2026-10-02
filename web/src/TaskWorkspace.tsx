import { useLayoutPreferences } from './LayoutPreferences';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, request } from './api';
import type { Scion } from './api';
import type { AdaptiveState, CapabilityPlan } from './adaptive-api';
import type { AgentRuntime, NativeAgent } from './agents-api';
import type { SourceList, SourceSummary } from './evidence-api';
import type { AgentTask, AgentTaskEvent, AgentTaskList } from './scope-api';
import { useCaseInvalidation } from './control-api';
import type { ControlSurfaceConnection } from './control-api';
import { WorkIcon } from './Workbench';
import AgentAvatar from './AgentAvatar';
import TaskSidePanel from './TaskSidePanel';
import TaskConversation from './TaskConversation';
import type { TaskArtifact, TaskDependency } from './TaskSidePanel';
import { TaskStatus } from './TaskDirectory';
import { answeredIntake, taskCreationRejected, taskFailureExplanation, taskWorkflow, taskWorkflowPriority } from './task-workflow';
import './task-workspace.css';

type ReviewReceipt = { id: string; plan_id: string; scion_revision: number; reviewer_id: string; note: string; created_at: string };
type ReviewedPlan = CapabilityPlan & { reviews?: ReviewReceipt[] };
type ReviewDraft = { planId: string; revision: number; open: boolean; note: string };
type Snapshot = { tasks: AgentTask[]; capabilities: Omit<AdaptiveState, 'plans'> & { plans: ReviewedPlan[] }; sources: SourceSummary[]; checked: string };
type Props = {
  token: string; scion: Scion; nativeAgents: NativeAgent[]; runtime?: AgentRuntime;
  canManage: boolean; canWrite: boolean; canPrepare: boolean; preferredTaskId: string | null;
  control: ControlSurfaceConnection; onNavigate: (path: string) => void;
  onScionSaved: (scion: Scion) => void | Promise<void>; onDirty: (dirty: boolean) => void;
};
const when = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
const explanation = (failure: unknown) => failure instanceof Error ? failure.message : 'The request failed. Recheck the current state before retrying.';
const title = (task: AgentTask) => task.task_kind === 'prepare_capability_plan' ? 'Prepare capability plan' : task.task_kind === 'prepare_physical_scope' ? 'Prepare physical scope' : 'Prepare supplier offer worksheet';

function useTaskSnapshot(token: string, scion: Scion, onClear: () => void) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const epoch = useRef(0);
  const reads = useRef(new Set<AbortController>());
  const lease = useRef<number | undefined>(undefined);
  const clear = useCallback((reason: string) => {
    epoch.current++; reads.current.forEach(controller => controller.abort()); reads.current.clear();
    window.clearTimeout(lease.current); setSnapshot(null); setError(reason); setLoading(false); onClear();
  }, [onClear]);
  useCaseInvalidation(scion.id, clear);
  const refresh = useCallback(async (force = false) => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    if (reads.current.size && !force) return;
    if (force) { epoch.current++; reads.current.forEach(controller => controller.abort()); reads.current.clear(); }
    const generation = epoch.current; const started = Date.now();
    async function read<T>(path: string) {
      const controller = new AbortController(); reads.current.add(controller);
      const deadline = window.setTimeout(() => controller.abort(), 2500);
      try { return await request<T>(token, path, { signal: controller.signal, cache: 'no-store' }); }
      finally { window.clearTimeout(deadline); reads.current.delete(controller); }
    }
    const base = `/scions/${scion.id}`;
    const results = await Promise.allSettled([read<AgentTaskList>(`${base}/agent-tasks`), read<Snapshot['capabilities']>(`${base}/capabilities`), read<SourceList>(`${base}/sources`)]);
    if (generation !== epoch.current) return;
    const [tasks, capabilities, sources] = results;
    if (tasks.status === 'rejected' || capabilities.status === 'rejected' || sources.status === 'rejected') {
      const failure = results.find(result => result.status === 'rejected');
      clear(`Current task inputs could not be checked. Result and evidence content are hidden. ${failure?.status === 'rejected' ? explanation(failure.reason) : ''}`); return;
    }
    if (Date.now() >= started + 5000 || document.visibilityState !== 'visible' || !navigator.onLine) { clear('The access check expired. Task results and evidence are hidden until rechecked.'); return; }
    const next = { tasks: tasks.value.tasks, capabilities: capabilities.value, sources: sources.value.sources, checked: new Date().toISOString() };
    setSnapshot(next); setError(''); setLoading(false);
    window.clearTimeout(lease.current);
    lease.current = window.setTimeout(() => clear('The connection is overdue. Task results and evidence are hidden until access is rechecked.'), Math.max(0, started + 5000 - Date.now()));
    return next;
  }, [token, scion.id, clear]);
  useEffect(() => {
    setSnapshot(null); setLoading(true); void refresh(true);
    const timer = window.setInterval(() => void refresh(), 2000);
    const changed = () => { if (document.visibilityState === 'visible' && navigator.onLine) void refresh(true); else clear('This page is hidden or offline. Task results and evidence are hidden until rechecked.'); };
    document.addEventListener('visibilitychange', changed); window.addEventListener('offline', changed); window.addEventListener('online', changed); window.addEventListener('pageshow', changed); window.addEventListener('pagehide', changed);
    return () => { epoch.current++; reads.current.forEach(controller => controller.abort()); reads.current.clear(); window.clearTimeout(lease.current); window.clearInterval(timer); document.removeEventListener('visibilitychange', changed); window.removeEventListener('offline', changed); window.removeEventListener('online', changed); window.removeEventListener('pageshow', changed); window.removeEventListener('pagehide', changed); };
  }, [refresh, clear]);
  return { snapshot, error, loading, refresh };
}

export default function TaskWorkspace(props: Props) {
  return <TaskWorkspaceBody key={`${props.token}:${props.scion.id}`} {...props} />;
}

function TaskWorkspaceBody({ token, scion, nativeAgents, runtime, canManage, canWrite, canPrepare, preferredTaskId, control, onNavigate, onScionSaved, onDirty }: Props) {
  const [composer, setComposer] = useState(false);
  const [chatDirty, setChatDirty] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const { inspectorDock, inspectorSide, showInspector, hideInspector } = useLayoutPreferences();
  const panelOpen = inspectorDock !== 'hidden';
  const panelTrigger = useRef<HTMLButtonElement>(null);
  const [agentId, setAgentId] = useState('');
  const [synthetic, setSynthetic] = useState(false);
  const [timeout, setTimeoutValue] = useState(240);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [queuedId, setQueuedId] = useState<string | null>(null);
  const queueRetry = useRef<{ body: string; revision: number; key: string; taskId?: string; unknown?: boolean } | null>(null);
  const [answerOpen, setAnswerOpen] = useState(false);
  const [answerBase, setAnswerBase] = useState(scion);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [description, setDescription] = useState(''); const [decision, setDecision] = useState('');
  const [answerConflict, setAnswerConflict] = useState(false);
  const answerRetry = useRef<{ body: string; revision: number; key: string } | null>(null);
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, ReviewDraft>>({});
  const reviewRetries = useRef<Record<string, { body: string; planId: string; revision: number; key: string }>>({});
  const answerSection = useRef<HTMLElement>(null); const resultSection = useRef<HTMLElement>(null);
  const context = `${token}:${scion.id}`; const liveContext = useRef(context); liveContext.current = context;
  const mounted = useRef(true); const writes = useRef(new Set<AbortController>());
  const answerDirty = Object.values(answers).some(value => value.trim()) || Boolean(description.trim() || decision.trim());
  const answerDirtyRef = useRef(answerDirty); answerDirtyRef.current = answerDirty;
  const clearDerived = useCallback(() => { setReviewDrafts({}); reviewRetries.current = {}; }, []);
  const { snapshot, error: loadError, loading, refresh } = useTaskSnapshot(token, scion, clearDerived);
  const authorized = canWrite || (canPrepare && scion.revision.product_category === 'digital');
  const fresh = snapshot?.capabilities.scion_revision === scion.current_revision && control.data?.scion_revision === scion.current_revision;
  const tasks = (snapshot?.tasks ?? []).filter(task => task.task_kind === 'prepare_capability_plan');
  const planFor = (task: AgentTask) => snapshot?.capabilities.plans.find(plan => plan.agent_task_id === task.id || plan.id === task.proposal_id);
  const flagsFor = (task: AgentTask) => control.data?.operations.tasks.find(item => item.id === task.id);
  const inputsMissing = Boolean(scion.revision.questions?.length) || !scion.revision.decision?.trim();
  const workflowFor = (task: AgentTask) => {
    const plan = planFor(task); const flags = flagsFor(task);
    return taskWorkflow({ status: task.status, blocked: flags?.blocked || plan?.status === 'blocked', stale: task.scion_revision !== scion.current_revision || flags?.stale || plan?.status === 'stale', reviewed: plan?.status === 'current' && Boolean(plan.input) && Boolean(plan.reviews?.length), needsInput: inputsMissing });
  };
  const selected = tasks.find(task => task.id === preferredTaskId) ?? (!preferredTaskId || preferredTaskId === 'new' ? [...tasks].sort((left, right) => taskWorkflowPriority(workflowFor(left)) - taskWorkflowPriority(workflowFor(right)))[0] : undefined);
  const plan = selected ? planFor(selected) : undefined;
  const workflow = selected ? workflowFor(selected) : undefined;
  const sourceNodes = control.data?.nodes.filter(node => node.kind === 'evidence_source') ?? [];
  const sourceNode = (source: SourceSummary) => sourceNodes.find(node => node.id === `source:${source.id}`);
  const sourcesAgree = Boolean(snapshot) && sourceNodes.length === snapshot?.sources.length && snapshot.sources.every(source => {
    const node = sourceNode(source);
    return node?.provenance.source_revision === source.current_revision && node.status === (source.rights_status === 'granted' ? 'available' : 'revoked');
  });
  const projectedPlan = control.data?.nodes.find(node => node.id === `plan:${plan?.id}`);
  const visiblePlan = fresh && sourcesAgree && projectedPlan?.status === 'current' && !projectedPlan.stale && plan?.status === 'current' && plan.input && selected && !flagsFor(selected)?.blocked && !flagsFor(selected)?.stale && selected.scion_revision === scion.current_revision ? plan : null;
  const reviewDraft = selected ? reviewDrafts[selected.id] : undefined;
  const reviewOpen = Boolean(visiblePlan && reviewDraft?.planId === visiblePlan.id && reviewDraft.open);
  const reviewNote = visiblePlan && reviewDraft?.planId === visiblePlan.id ? reviewDraft.note : '';
  const reviewDirty = Object.values(reviewDrafts).some(draft => draft.note.trim());
  function updateReviewDraft(patch: Partial<Pick<ReviewDraft, 'open' | 'note'>>) {
    if (!selected || !visiblePlan) return;
    setReviewDrafts(previous => ({ ...previous, [selected.id]: {
      planId: visiblePlan.id, revision: scion.current_revision,
      open: previous[selected.id]?.open ?? false, note: previous[selected.id]?.note ?? '', ...patch,
    } }));
  }
  const setReviewOpen = (open: boolean) => updateReviewDraft({ open });
  const setReviewNote = (note: string) => updateReviewDraft({ note });
  // Drafts belong to an authorized task/result revision, not the selected row.
  // Keep them during navigation, but discard derived text when access is lost.
  useEffect(() => {
    setReviewDrafts(previous => {
      const allowed = Object.fromEntries(Object.entries(previous).filter(([taskId, draft]) => {
        if (!fresh || !sourcesAgree || draft.revision !== scion.current_revision) return false;
        const result = snapshot?.capabilities.plans.find(item => item.id === draft.planId && item.agent_task_id === taskId);
        const projected = control.data?.nodes.find(item => item.id === `plan:${draft.planId}`);
        const flags = control.data?.operations.tasks.find(item => item.id === taskId);
        return result?.status === 'current' && Boolean(result.input) && projected?.status === 'current' && !projected.stale && flags && !flags.stale && !flags.blocked;
      }));
      const allowedPlans = new Set(Object.values(allowed).map(draft => draft.planId));
      for (const planId of Object.keys(reviewRetries.current)) if (!allowedPlans.has(planId)) delete reviewRetries.current[planId];
      return Object.keys(allowed).length === Object.keys(previous).length ? previous : allowed;
    });
  }, [fresh, sourcesAgree, snapshot, control.data, scion.current_revision]);
  const canControl = (task: AgentTask) => canWrite || (canPrepare && scion.revision.product_category === 'digital' && task.task_kind === 'prepare_capability_plan');
  const selectTask = (id: string) => onNavigate(`/scions/${scion.id}/tasks/${id}`);
  const assignedAgent = nativeAgents.find(agent => agent.id === selected?.agent_id);
  const relatedTasks = [...tasks].sort((left, right) => taskWorkflowPriority(workflowFor(left)) - taskWorkflowPriority(workflowFor(right)) || Date.parse(right.created_at) - Date.parse(left.created_at)).map(task => ({
    id: task.id, title: title(task), status: workflowFor(task), agentId: task.agent_id ?? undefined,
    agentName: nativeAgents.find(agent => agent.id === task.agent_id)?.config.name,
  }));
  const artifacts: TaskArtifact[] = plan ? [{ id: plan.id, title: 'Capability plan', kind: 'Proposal', status: visiblePlan ? visiblePlan.reviews?.length ? 'Review recorded' : 'Needs review' : plan.status === 'current' ? 'Access awaiting recheck' : plan.status,
    onOpen: visiblePlan ? () => onNavigate(`/scions/${scion.id}/proposals/${visiblePlan.id}`) : undefined,
  }] : [];
  const dependencies: TaskDependency[] = fresh && sourcesAgree ? (control.data?.edges ?? [])
    .filter(edge => edge.kind === 'evidence_dependency' && (edge.target === `task:${selected?.id}` || edge.target === `plan:${plan?.id}`))
    .filter((edge, index, edges) => edges.findIndex(other => other.source === edge.source) === index)
    .map(edge => {
      const node = control.data?.nodes.find(item => item.id === edge.source);
      const source = snapshot?.sources.find(item => `source:${item.id}` === edge.source);
      const permitted = source?.rights_status === 'granted' && node?.status === 'available' && node.provenance.source_revision === source.current_revision;
      return { id: edge.source, title: permitted ? source.title : node?.status === 'revoked' || source?.rights_status === 'revoked' ? 'Revoked source' : 'Source access awaiting recheck', status: permitted ? 'Available · unverified' : 'Content hidden', onOpen: () => onNavigate(`/scions/${scion.id}/sources`) };
    }) : [{ id: 'access-check', title: 'Dependencies awaiting access check', status: 'Unavailable' }];


  useEffect(() => { onDirty(Boolean(chatDirty || answerDirty || reviewDirty || composer && (synthetic || agentId))); return () => onDirty(false); }, [chatDirty, answerDirty, reviewDirty, composer, synthetic, agentId, onDirty]);
  useEffect(() => {
    mounted.current = true; setComposer(false); setAgentId(''); setSynthetic(false); setQueuedId(null); queueRetry.current = null;
    setAnswerOpen(false); setAnswerBase(scion); setAnswers({}); setDescription(''); setDecision(''); setAnswerConflict(false); answerRetry.current = null;
    clearDerived(); setError(''); setNotice(''); setBusy(null);
    return () => { mounted.current = false; writes.current.forEach(controller => controller.abort()); writes.current.clear(); };
  }, [context, clearDerived]);
  useEffect(() => { if (preferredTaskId === 'new') setComposer(true); }, [preferredTaskId]);
  useEffect(() => {
    if (answerBase.current_revision === scion.current_revision) return;
    if (answerDirtyRef.current) setAnswerConflict(true);
    else { setAnswerBase(scion); setAnswerConflict(false); answerRetry.current = null; }
  }, [scion, answerBase.current_revision]);
  useEffect(() => {
    const saved = snapshot?.tasks.find(task => task.id === queueRetry.current?.taskId);
    if (saved && saved.status !== 'queued') {
      queueRetry.current = null; setQueuedId(null); setComposer(false); setSynthetic(false);
      setError(''); setNotice('The saved task state was confirmed. Continue from its current status below.');
    }
  }, [snapshot]);

  async function mutate<T>(path: string, options: RequestInit): Promise<T> {
    const controller = new AbortController(); writes.current.add(controller);
    const deadline = window.setTimeout(() => controller.abort(), 10000);
    try { return await request<T>(token, path, { ...options, signal: controller.signal, cache: 'no-store' }); }
    finally { window.clearTimeout(deadline); writes.current.delete(controller); }
  }
  const current = (scope: string) => mounted.current && liveContext.current === scope;
  async function dispatch(task: AgentTask) {
    if (busy || !fresh || !canControl(task)) return;
    const scope = context; setBusy(task.id); setError(''); setNotice('');
    try {
      await mutate<AgentTask>(`/scions/${scion.id}/agent-tasks/${task.id}/dispatch`, { method: 'POST', body: '{}', headers: { 'If-Match': `"${task.scion_revision}"` } });
      if (!current(scope)) return;
      setNotice('Task started. The worker will report its progress here.'); setQueuedId(null); queueRetry.current = null; setComposer(false); setSynthetic(false);
      await refresh(true);
    } catch (failure) { if (current(scope)) {
      const next = await refresh(true); if (!current(scope)) return;
      const saved = next?.tasks.find(item => item.id === task.id);
      if (saved && saved.status !== 'queued') { queueRetry.current = null; setQueuedId(null); setComposer(false); setSynthetic(false); setNotice('The saved task state was confirmed. Continue from its current status below.'); }
      else setError(explanation(failure));
    } }
    finally { if (current(scope)) setBusy(null); }
  }
  async function startPlanning(event: FormEvent) {
    event.preventDefault(); if (busy || !authorized || !fresh || !synthetic || !scion.revision.product_description?.trim()) return;
    const scope = context; const revision = scion.current_revision;
    setBusy('planning'); setError(''); setNotice('');
    const body = JSON.stringify({ task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, timeout_seconds: timeout, ...(agentId ? { agent_id: agentId } : {}) });
    // Once a queue write may have succeeded, preserve its exact request until
    // its outcome is known. A failed dispatch must never create a second task.
    if (!queueRetry.current) queueRetry.current = { body, revision, key: crypto.randomUUID() };
    const attempt = queueRetry.current;
    try {
      let taskId = attempt.taskId;
      if (!taskId) {
        const queued = await mutate<AgentTask>(`/scions/${scion.id}/agent-tasks`, { method: 'POST', body: attempt.body, headers: { 'If-Match': `"${attempt.revision}"`, 'Idempotency-Key': attempt.key } });
        if (!current(scope)) return;
        taskId = queued.id; attempt.taskId = taskId; setQueuedId(taskId);
      }
      if (attempt.revision !== revision) throw new Error('The brief changed. Cancel this saved task in Technical details before preparing replacement work for the current revision.');
      await mutate<AgentTask>(`/scions/${scion.id}/agent-tasks/${taskId}/dispatch`, { method: 'POST', body: '{}', headers: { 'If-Match': `"${attempt.revision}"` } });
      if (!current(scope)) return;
      queueRetry.current = null; setQueuedId(null); setComposer(false); setSynthetic(false); setNotice('Planning started. A finished result will still need your review.');
      await refresh(true); selectTask(taskId);
    } catch (failure) { if (current(scope)) {
      const rejected = !attempt.taskId && failure instanceof ApiError && taskCreationRejected(failure.status, failure.code, Boolean(attempt.unknown));
      if (rejected) { queueRetry.current = null; setQueuedId(null); }
      else if (!attempt.taskId) attempt.unknown = true;
      const next = await refresh(true); if (!current(scope)) return;
      const saved = next?.tasks.find(task => task.id === attempt.taskId);
      if (saved && saved.status !== 'queued') {
        queueRetry.current = null; setQueuedId(null); setComposer(false); setSynthetic(false); setNotice('The saved task state was confirmed. Continue from its current status below.');
      } else setError(`${rejected ? 'The task was not created. Correct the inputs and try again. ' : attempt.taskId ? 'The task is saved, but its start was not confirmed. Retry this saved task; no replacement was created. ' : 'Creation could not be confirmed. Retry the same request to check its outcome. '}${explanation(failure)}`);
      if (attempt.taskId) selectTask(attempt.taskId);
    } }
    finally { if (current(scope)) setBusy(null); }
  }
  async function cancel(task: AgentTask) {
    if (busy || !canControl(task)) return;
    const scope = context; setBusy(task.id); setError('');
    try {
      const result = await mutate<AgentTask>(`/scions/${scion.id}/agent-tasks/${task.id}/cancel`, { method: 'POST', body: '{}' });
      if (!current(scope)) return;
      setNotice(result.status === 'cancel_requested' ? 'Cancellation requested. The task remains in progress until the worker confirms it stopped.' : 'Task cancelled.');
      if (queueRetry.current?.taskId === task.id) { queueRetry.current = null; setQueuedId(null); }
      await refresh(true);
    } catch (failure) { if (current(scope)) setError(explanation(failure)); }
    finally { if (current(scope)) setBusy(null); }
  }
  function openAnswers() { setAnswerOpen(true); window.setTimeout(() => answerSection.current?.scrollIntoView({ block: 'start', behavior: 'auto' }), 0); }
  async function saveAnswers(event: FormEvent) {
    event.preventDefault(); if (busy || !canManage || !answerDirty || answerConflict) return;
    const scope = context; setBusy('answers'); setError('');
    try {
      const body = JSON.stringify(answeredIntake(answerBase.revision, answers, description, decision));
      if (!answerRetry.current || answerRetry.current.body !== body || answerRetry.current.revision !== answerBase.current_revision) answerRetry.current = { body, revision: answerBase.current_revision, key: crypto.randomUUID() };
      const attempt = answerRetry.current;
      const next = await mutate<Scion>(`/scions/${scion.id}/revisions`, { method: 'POST', body, headers: { 'If-Match': `"${attempt.revision}"`, 'Idempotency-Key': attempt.key } });
      if (!current(scope)) return;
      setAnswers({}); setDescription(''); setDecision(''); setAnswerBase(next); setAnswerConflict(false); answerRetry.current = null; setAnswerOpen(false);
      clearDerived(); setNotice('Answers saved as a new brief revision. Previous proposals are now out of date; prepare a replacement when ready.');
      await onScionSaved(next); await refresh(true);
    } catch (failure) { if (current(scope)) { setError(explanation(failure)); if (failure instanceof ApiError && failure.status === 412) setAnswerConflict(true); } }
    finally { if (current(scope)) setBusy(null); }
  }
  async function recordReview(event: FormEvent) {
    event.preventDefault(); if (busy || !authorized || !visiblePlan || !reviewNote.trim() || !fresh) return;
    const scope = context; const reviewedPlan = visiblePlan; setBusy('review'); setError('');
    const body = JSON.stringify({ note: reviewNote.trim() });
    const previous = reviewRetries.current[reviewedPlan.id];
    if (!previous || previous.body !== body || previous.revision !== scion.current_revision) reviewRetries.current[reviewedPlan.id] = { body, planId: reviewedPlan.id, revision: scion.current_revision, key: crypto.randomUUID() };
    const attempt = reviewRetries.current[reviewedPlan.id];
    try {
      await mutate<ReviewReceipt>(`/scions/${scion.id}/capability-plans/${reviewedPlan.id}/reviews`, { method: 'POST', body, headers: { 'If-Match': `"${attempt.revision}"`, 'Idempotency-Key': attempt.key } });
      if (!current(scope)) return;
      setReviewNote(''); setReviewOpen(false); delete reviewRetries.current[reviewedPlan.id]; setNotice('Review recorded; no approval granted.'); await refresh(true); await control.refresh();
    } catch (failure) { if (current(scope)) { setError(explanation(failure)); await refresh(true); } }
    finally { if (current(scope)) setBusy(null); }
  }
  function prepareReplacement() {
    if (queueRetry.current) { setError('Resolve the previous creation attempt first. Reuse its request or inspect the saved task before preparing another.'); setComposer(true); return; }
    setComposer(true); setSynthetic(false); setError('');
    if (selected?.agent_id && nativeAgents.some(agent => agent.id === selected.agent_id && !agent.config.paused)) setAgentId(selected.agent_id);
  }
  function primaryAction() {
    if (!selected || !workflow) return;
    if (workflow.action === 'start') void dispatch(selected);
    else if (workflow.action === 'answer') openAnswers();
    else if (workflow.action === 'review') { setReviewOpen(true); window.setTimeout(() => resultSection.current?.scrollIntoView({ block: 'start', behavior: 'auto' }), 0); }
    else if (workflow.action === 'retry') prepareReplacement();
    else if (workflow.action === 'resolve') {
      if (flagsFor(selected)?.blocked || plan?.status === 'blocked') onNavigate(`/scions/${scion.id}/sources`);
      else prepareReplacement();
    }
  }
  const primaryLabel = workflow?.action === 'start' ? 'Start task' : workflow?.action === 'answer' ? 'Answer questions' : workflow?.action === 'review' ? 'Review result' : workflow?.action === 'retry' ? 'Retry planning' : workflow?.action === 'resolve' ? 'Resolve blocker' : null;
  const writablePrimary = workflow?.action === 'answer' ? canManage : workflow?.action === 'review' ? authorized && Boolean(visiblePlan) : selected ? canControl(selected) : false;

  const questionsPanel = <section className="task-questions" ref={answerSection} aria-label="Questions for you"><div className="task-section-heading"><div><h3>Questions for you</h3><p>{inputsMissing ? 'Your answers shape the next result.' : 'Handler inputs saved in the Scion brief.'}</p></div>{!answerOpen && inputsMissing && <button type="button" className="button secondary" disabled={!canManage} onClick={openAnswers}>Answer questions</button>}</div>
      {answerOpen ? <form onSubmit={saveAnswers}>
        {answerConflict && <div className="task-blocker" role="alert"><p>The brief changed while you were answering. Your draft is preserved below. Read the latest brief before reapplying answers.</p><button type="button" className="text-button" onClick={() => onNavigate(`/scions/${scion.id}/record`)}>Open latest brief</button><button type="button" className="text-button" onClick={() => { if (window.confirm('Discard these draft answers and start from the latest brief?')) { setAnswerBase(scion); setAnswers({}); setDescription(''); setDecision(''); setAnswerConflict(false); answerRetry.current = null; } }}>Start again from revision {scion.current_revision}</button></div>}
        <fieldset disabled={!canManage || busy !== null || answerConflict}>
          {!answerBase.revision.product_description?.trim() && <label htmlFor="task-product-description">What product are you building?<textarea id="task-product-description" maxLength={10000} rows={3} value={description} onChange={event => setDescription(event.target.value)} /></label>}
          {!answerBase.revision.decision?.trim() && <label htmlFor="task-handler-decision">What decision should this Scion help you make?<textarea id="task-handler-decision" maxLength={10000} rows={2} value={decision} onChange={event => setDecision(event.target.value)} /></label>}
          {(answerBase.revision.questions ?? []).map((question, index) => <label key={`${index}:${question}`} htmlFor={`task-answer-${index}`}>{question}<textarea id={`task-answer-${index}`} maxLength={2000} rows={2} value={answers[index] ?? ''} onChange={event => setAnswers(previous => ({ ...previous, [index]: event.target.value }))} /></label>)}
        </fieldset><p>Answers are recorded as Handler-provided requirements in a new revision. Leave an answer blank to keep its question unresolved. A new revision makes earlier proposals stale.</p><div className="task-form-footer"><button type="button" className="text-button" disabled={busy !== null} onClick={() => setAnswerOpen(false)}>Close</button><button type="submit" className="button primary" disabled={!canManage || !answerDirty || answerConflict || busy !== null}>{busy === 'answers' ? 'Saving…' : 'Save answers'}</button></div>
      </form> : <>{scion.revision.questions?.length ? <ul>{scion.revision.questions.map((question, index) => <li key={index}>{question}</li>)}</ul> : <p>{scion.revision.questions === null ? 'No questions have been recorded yet.' : 'No unresolved brief questions.'}</p>}{!scion.revision.decision?.trim() && <p>A Handler decision is still missing.</p>}{answerDirty && <p>Your unsaved answer draft is preserved. <button type="button" className="text-button" onClick={openAnswers}>Continue answering</button></p>}</>}
    </section>;

  return <section className="task-workspace" aria-label="Scion tasks">
    <header className="task-workspace-heading"><div>{selected ? <div className="task-workspace-context"><button type="button" className="text-button" onClick={() => onNavigate('/tasks')}>← All tasks</button><code>{selected.id.slice(0, 8)}</code></div> : <><h2>Tasks</h2><p>Start work, answer questions, and review the result in one place.</p></>}</div><div className="task-workspace-actions">{selected && <button ref={panelTrigger} type="button" className="button secondary" aria-expanded={panelOpen} onClick={() => panelOpen ? hideInspector() : showInspector()}><WorkIcon name="runtime" />{panelOpen ? 'Hide task panel' : 'Show task panel'}</button>}<button type="button" className="button secondary" disabled={!authorized || busy !== null} onClick={prepareReplacement}><WorkIcon name="new" />New task</button><button type="button" className="button secondary" onClick={() => onNavigate(`/scions/${scion.id}/research/new`)}>Research the web</button></div></header>
    {(error || loadError) && <div className="error-message" role="alert"><div>{error || loadError}{loadError && <button type="button" className="text-button" onClick={() => void refresh(true)}>Recheck access</button>}</div></div>}
    {notice && <p className="task-notice" role="status">{notice}</p>}
    {composer && <form className="task-composer" onSubmit={startPlanning}>
      <div className="task-section-heading"><div><span className="task-composer-step">New planning task</span><h3>Plan this Scion</h3></div><button type="button" className="text-button" disabled={busy !== null} onClick={() => setComposer(false)}>Close</button></div>
      <p>A single Codex task prepares a capability plan from revision {scion.current_revision}. It will run after you choose Start planning.</p>
      <fieldset disabled={busy !== null || Boolean(queueRetry.current)}><label htmlFor="task-agent">Assigned agent</label><select id="task-agent" value={agentId} onChange={event => { setAgentId(event.target.value); const chosen = nativeAgents.find(agent => agent.id === event.target.value); if (chosen) setTimeoutValue(chosen.config.timeout_seconds); }}><option value="">Codex worker · no agent profile</option>{nativeAgents.filter(agent => !agent.config.paused).map(agent => <option key={agent.id} value={agent.id}>{agent.config.name}</option>)}</select><label className="task-consent"><input type="checkbox" checked={synthetic} onChange={event => setSynthetic(event.target.checked)} /><span>This is a synthetic test Scion. Use my connected Codex worker to prepare a proposal for human review.</span></label><details className="task-technical"><summary>Execution settings</summary><label htmlFor="task-timeout">Time limit in seconds<input id="task-timeout" type="number" min={30} max={300} value={timeout} onChange={event => setTimeoutValue(Number(event.target.value))} /></label><p>The organization worker runs one task at a time. Start dispatches this task; the browser does not execute it.</p></details></fieldset>
      {!scion.revision.product_description?.trim() && <p className="task-blocker">Add a product description before starting. <button type="button" className="text-button" onClick={openAnswers}>Add description</button></p>}
      {queuedId && <p>Saved task <button type="button" className="text-button" onClick={() => selectTask(queuedId)}>Open task</button>. Retry its start to keep the same record.</p>}
      <div className="task-form-footer"><span>{runtime?.status === 'connected' ? 'Worker online' : runtime ? 'Worker offline · task can wait for it' : 'Connection not checked · task can wait'}</span><button type="submit" className="button primary" disabled={!authorized || !fresh || busy !== null || !synthetic || !scion.revision.product_description?.trim()}>{busy === 'planning' ? 'Starting…' : queueRetry.current ? 'Retry same request' : 'Start planning'}</button></div>
    </form>}
    {loading && <p role="status">Checking current tasks…</p>}
    {!loading && !snapshot && !loadError && <p role="status">Task state is unavailable until access is checked.</p>}
    {snapshot && <div data-inspector-side={inspectorSide} className={`task-layout${selected && panelOpen ? ' task-layout-inspector' : ' task-layout-empty'}`}>
      {!selected && <div className="task-list-panel"><div className="task-list-meta"><span>{tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}</span><span className={`task-worker-state ${runtime?.status === 'connected' ? 'connected' : 'disconnected'}`} title={`Last heartbeat: ${when(runtime?.last_seen ?? null)}`}>{runtime?.status === 'connected' ? 'Worker online' : runtime ? 'Worker offline' : 'Connection not checked'}</span></div><p className="task-list-order">Next action first</p>
        {tasks.length ? <div className="task-record-list" aria-label="Task list">{[...tasks].sort((left, right) => taskWorkflowPriority(workflowFor(left)) - taskWorkflowPriority(workflowFor(right)) || Date.parse(right.created_at) - Date.parse(left.created_at)).map(task => <button type="button" key={task.id} className="task-record-row" onClick={() => selectTask(task.id)}><span className="task-record-icon">{nativeAgents.find(agent => agent.id === task.agent_id) ? <AgentAvatar id={task.agent_id ?? undefined} name={nativeAgents.find(agent => agent.id === task.agent_id)!.config.name} size="sm" /> : <WorkIcon name="tasks" />}</span><span><strong>{title(task)}</strong><small>{nativeAgents.find(agent => agent.id === task.agent_id)?.config.name ?? (task.agent_id ? 'Assigned agent' : 'Codex worker')} · Revision {task.scion_revision}</small><TaskStatus workflow={workflowFor(task)} /></span></button>)}</div> : <div className="task-empty"><WorkIcon name="tasks" /><h3>No tasks yet</h3><p>Start with one capability planning task. Its result will come back here for your review.</p><button type="button" className="button primary" disabled={!authorized || !fresh} onClick={prepareReplacement}>Start planning</button></div>}
      </div>}
      {selected && workflow ? <article className="task-detail" aria-label="Task detail">
        <header className="task-detail-heading"><div><TaskStatus workflow={workflow} /><h2>{title(selected)}</h2><div className="task-detail-assignment">{nativeAgents.find(agent => agent.id === selected.agent_id) && <AgentAvatar id={selected.agent_id ?? undefined} name={nativeAgents.find(agent => agent.id === selected.agent_id)!.config.name} size="sm" />}<span>{nativeAgents.find(agent => agent.id === selected.agent_id)?.config.name ?? (selected.agent_id ? 'Assigned agent' : 'Codex worker')}</span><span>Revision {selected.scion_revision}</span></div><p className="task-detail-created">Created {when(selected.created_at)}</p></div>{primaryLabel && <button type="button" className="button primary" disabled={!writablePrimary || !fresh || busy !== null} onClick={primaryAction}>{busy === selected.id ? 'Working…' : primaryLabel}</button>}</header>
        {workflow.state === 'blocked' && <div className="task-blocker" role="status"><strong>{flagsFor(selected)?.blocked || plan?.status === 'blocked' ? 'Evidence access changed' : selected.scion_revision !== scion.current_revision || flagsFor(selected)?.stale || plan?.status === 'stale' ? 'This task uses older inputs' : 'The task needs attention'}</strong><p>{flagsFor(selected)?.blocked || plan?.status === 'blocked' ? 'Dependent source content is hidden. Review evidence permissions before preparing replacement work.' : selected.scion_revision !== scion.current_revision || flagsFor(selected)?.stale || plan?.status === 'stale' ? 'The saved task stays in history. Prepare a new task from the current brief and authorized evidence.' : taskFailureExplanation(selected.failure_code)}</p></div>}
        {workflow.state === 'in_progress' && <p className="task-notice" role="status">{selected.status === 'cancel_requested' ? 'Cancellation requested. Waiting for the worker to confirm execution stopped.' : selected.status === 'running' ? runtime?.status === 'connected' ? 'Codex is preparing the result. Progress below comes from the saved task state.' : <>Last recorded: in progress. The worker is {runtime ? 'disconnected' : 'not yet checked'}; further progress is unconfirmed. <button type="button" className="text-button" onClick={() => onNavigate('/settings/runtime')}>Check connection</button></> : runtime?.status === 'connected' ? 'The task is waiting for the worker’s next available slot.' : <>The task is ready to run when your worker connects. <button type="button" className="text-button" onClick={() => onNavigate('/settings/runtime')}>Connect worker</button></>}</p>}
        {workflow.state === 'needs_input' && <p className="task-notice">The draft is ready. Your brief still has questions or a missing decision to address before the next revision.</p>}
        {workflow.state === 'completed' && <p className="task-notice">Handler review is recorded. This is a review receipt, not approval. Watchtower review tasks remain separate.</p>}
        <TaskConversation token={token} scion={scion} task={selected} nativeAgents={nativeAgents} canPrepare={canPrepare} onNavigate={onNavigate} onDirty={setChatDirty} onChanged={async () => { await refresh(true); await control.refresh(); }}
          intro={<details className="task-thread-brief"><summary>Current Scion brief · Revision {scion.current_revision}</summary><p>{scion.revision.product_description || 'No product description recorded.'}</p>{scion.revision.decision && <p>{scion.revision.decision}</p>}</details>}
          renderResponse={response => response.task_id === selected.id && visiblePlan ? <button type="button" className="task-thread-deliverable" onClick={() => { setDetailOpen(true); window.setTimeout(() => resultSection.current?.scrollIntoView({ block: 'start', behavior: 'auto' }), 0); }}><span>Capability plan</span><span>Inspect result →</span></button> : undefined}>
        <details className="task-conversation-context" open={detailOpen || answerOpen || reviewOpen} onToggle={event => setDetailOpen(event.currentTarget.open)}><summary>Result, questions and review{visiblePlan ? ' · Capability plan' : ''}</summary>
        {(inputsMissing || answerOpen || answerDirty) && questionsPanel}
        <section className="task-deliverable" ref={resultSection}><div className="task-section-heading"><h3>Result</h3>{visiblePlan && <button type="button" className="text-button" onClick={() => onNavigate(`/scions/${scion.id}/proposals/${visiblePlan.id}`)}>Open full result <WorkIcon name="arrow" /></button>}</div>
          {visiblePlan?.input ? <><h4>Capability plan</h4><p>{visiblePlan.input.summary}</p><div className="task-capabilities">{visiblePlan.input.capabilities.map(capability => <details key={capability.key}><summary>{capability.title}</summary><p>{capability.reason}</p>{capability.evidence_needed.length > 0 && <><h5>Evidence still needed</h5><ul>{capability.evidence_needed.map((item, index) => <li key={index}>{item}</li>)}</ul></>}</details>)}</div>{visiblePlan.input.unresolved_gaps.length > 0 && <details className="task-technical"><summary>Unresolved proposal gaps · {visiblePlan.input.unresolved_gaps.length}</summary><ul>{visiblePlan.input.unresolved_gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul><p>These remain gaps in the proposal. A review receipt does not resolve them.</p></details>}
            {visiblePlan.reviews?.map(review => <div className="task-review-receipt" key={review.id}><strong>Review recorded · {when(review.created_at)}</strong><p>{review.note}</p><span>No approval granted.</span></div>)}
            {reviewOpen && <form className="task-review-form" onSubmit={recordReview}><label htmlFor="task-review-note">Your review note</label><textarea id="task-review-note" required maxLength={2000} rows={3} value={reviewNote} onChange={event => setReviewNote(event.target.value)} disabled={busy !== null} placeholder="What did you review, and what still needs attention?" /><p>Record your review of this current draft. This does not approve sourcing, resolve watch alerts, or verify its claims.</p><div className="task-form-footer"><button type="button" className="text-button" onClick={() => { setReviewOpen(false); setReviewNote(''); }} disabled={busy !== null}>Cancel</button><button type="submit" className="button primary" disabled={!authorized || !fresh || !reviewNote.trim() || busy !== null}>{busy === 'review' ? 'Recording…' : 'Record review'}</button></div></form>}
          </> : <p>{plan?.status === 'blocked' ? 'The result is hidden because a dependent source is no longer permitted.' : plan?.status === 'stale' || selected.scion_revision !== scion.current_revision ? 'The result is out of date. Prepare replacement work from current inputs.' : selected.status === 'failed' ? 'No accepted deliverable was produced.' : selected.status === 'cancelled' ? 'This task was cancelled.' : selected.status === 'completed' ? 'The result is unavailable until its current access can be checked.' : 'The completed proposal will appear here.'}</p>}
        </section>
        {!inputsMissing && !answerOpen && !answerDirty && <details className="task-technical task-brief-status"><summary>Brief questions · up to date</summary>{questionsPanel}</details>}
        <section className="task-evidence"><div className="task-section-heading"><h3>Evidence</h3><button type="button" className="text-button" onClick={() => onNavigate(`/scions/${scion.id}/sources`)}>Manage evidence <WorkIcon name="arrow" /></button></div><p>Current source permissions. Source content stays in the evidence view.</p>{snapshot.sources.length ? <ul>{snapshot.sources.map(source => <li key={source.id}>{fresh && source.rights_status === 'granted' && sourceNode(source)?.status === 'available' && sourceNode(source)?.provenance.source_revision === source.current_revision ? <><strong>{source.title}</strong><span>Revision {source.current_revision} · {source.claim_count} recorded claims · unverified</span></> : <><strong>{source.rights_status === 'revoked' || sourceNode(source)?.status === 'revoked' ? 'Revoked source' : 'Source access awaiting recheck'}</strong><span>Content and source details hidden</span></>}</li>)}</ul> : <p>No internal evidence source has been added yet.</p>}<p className="task-external-state">External connector unavailable.</p></section>
        <details className="task-technical task-activity-disclosure"><summary>Agent activity</summary><TaskActivity token={token} scionId={scion.id} task={selected} /></details>
        <details className="task-technical task-task-details"><summary>Technical details</summary><dl><div><dt>Task ID</dt><dd><code>{selected.id}</code></dd></div><div><dt>Rust task status</dt><dd>{selected.status}</dd></div><div><dt>Agent revision</dt><dd>{selected.agent_revision ?? 'No agent profile assigned'}</dd></div><div><dt>Attempt</dt><dd>{selected.attempt}</dd></div><div><dt>Time limit</dt><dd>{selected.timeout_seconds} seconds</dd></div><div><dt>Started</dt><dd>{when(selected.dispatched_at)}</dd></div><div><dt>Worker claimed</dt><dd>{when(selected.claimed_at)}</dd></div><div><dt>Completed</dt><dd>{when(selected.completed_at)}</dd></div><div><dt>Failure code</dt><dd>{selected.failure_code ?? 'None recorded'}</dd></div><div><dt>Provider run</dt><dd><code>{selected.provider_run_id ?? 'Not recorded'}</code></dd></div><div><dt>Output hash</dt><dd><code>{selected.output_sha256 ?? 'Not recorded'}</code></dd></div><div><dt>Subtasks</dt><dd>No delegated subtasks were recorded for this task.</dd></div></dl>{['queued', 'dispatched', 'running'].includes(selected.status) && <button type="button" className="button secondary" disabled={!canControl(selected) || busy !== null} onClick={() => void cancel(selected)}>{selected.status === 'running' ? 'Request cancellation' : 'Cancel task'}</button>}</details>
        </details>
        </TaskConversation>
      </article> : tasks.length > 0 ? <div className="task-empty"><h3>Select a task</h3><p>{preferredTaskId ? 'That task is not available in this Scion. Choose a current record from the list.' : 'Choose a task to see its current state and result.'}</p></div> : null}
      {selected && workflow && panelOpen && <TaskSidePanel task={selected} scion={scion} agent={assignedAgent} runtime={runtime} workflow={workflow} relatedTasks={relatedTasks} artifacts={artifacts} dependencies={dependencies} reviewCount={visiblePlan?.reviews?.length} onNavigate={onNavigate} onSelectTask={selectTask} onClose={() => { hideInspector(); panelTrigger.current?.focus(); }} />}
    </div>}
    {!selected && questionsPanel}
  </section>;
}

function TaskActivity({ token, scionId, task }: { token: string; scionId: string; task: AgentTask }) {
  const [events, setEvents] = useState<AgentTaskEvent[] | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let active = true; setEvents(null); setError('');
    const deadline = window.setTimeout(() => controller.abort(), 2500);
    request<{ events: AgentTaskEvent[] }>(token, `/scions/${scionId}/agent-tasks/${task.id}/events`, { signal: controller.signal, cache: 'no-store' }).then(result => { if (active) setEvents(result.events); }).catch(() => { if (active) setError('Activity could not be checked.'); }).finally(() => window.clearTimeout(deadline));
    return () => { active = false; controller.abort(); window.clearTimeout(deadline); };
  }, [token, scionId, task.id, task.status, task.attempt]);
  return <section className="task-activity"><h3>Activity</h3>{error ? <p role="status">{error}</p> : events ? <ol>{events.map(event => <li key={event.id}><span>{event.status === 'completed' ? 'Result prepared' : event.status === 'dispatched' ? 'Started by Handler' : event.status === 'running' ? 'Worker began preparation' : event.status.replaceAll('_', ' ')}</span><time>{when(event.recorded_at)}</time></li>)}</ol> : <p role="status">Loading recorded activity…</p>}</section>;
}
