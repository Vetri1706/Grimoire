import ResearchWorkspace from './ResearchWorkspace';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiError, SESSION_AUTH, announceSessionChange, organizationSession, request, sessionChangedStorageKey, sessionInvalidatedEvent } from './api';
import { IdentityAccess, OrganizationOnboarding } from './Onboarding';
import { ThemePicker } from './theme';
import Evidence from './Evidence';
import PhysicalScope from './PhysicalScope';
import Offers from './Offers';
import AdaptiveScion from './AdaptiveScion';
import TaskWorkspace from './TaskWorkspace';
import TaskRunDetail from './TaskRunDetail';
import ControlSurface from './ControlSurface';
import NativeAgents from './NativeAgents';
import { Settings } from './Settings';
import { LayoutProvider } from './LayoutPreferences';
import { WorkerPairing } from './WorkerConnections';
import ScionCreation from './ScionCreation';
import type { AgentRuntime, NativeAgent } from './agents-api';
import { useControlSurface } from './control-api';
import type { CaseNode } from './control-api';
import { CompanyNavigation, WorkspacePage, ScionOverview, ScionActivity, pageNames } from './Workbench';
import { useWorkspace } from './workspace-api';
import type { Category, Intake, Revision, RevisionHistory, Scion, SessionState } from './api';

type IconName = 'book' | 'plus' | 'arrow' | 'history' | 'file' | 'check' | 'search' | 'lock' | 'edit' | 'alert' | 'logout' | 'layers' | 'columns';
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    book: <><path d="M3 4h6a4 4 0 0 1 3 1.4A4 4 0 0 1 15 4h6v16h-6a4 4 0 0 0-3 1.4A4 4 0 0 0 9 20H3Z" /><path d="M12 5v16M6 8h3M15 8h3M6 12h3M15 12h3" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="m9 5 7 7-7 7M4 12h12" />,
    history: <><path d="M3 11a9 9 0 1 1 2.5 7M3 4v7h7" /><path d="M12 7v5l3 2" /></>,
    file: <><path d="M14 3H5v18h14V8Z" /><path d="M14 3v5h5M8 12h8M8 16h5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
    edit: <><path d="m14 5 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15Z" /></>,
    alert: <><path d="m12 3 10 18H2Z" /><path d="M12 9v5M12 17h.01" /></>,
    logout: <><path d="M9 3H3v18h6M8 12h13m-5-5 5 5-5 5" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
    columns: <><rect x="3" y="4" width="7" height="16" rx="1" /><rect x="14" y="4" width="7" height="16" rx="1" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
const date = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const category = (value: Category) => value === 'unspecified' ? 'Category missing' : value === 'digital' ? 'Digital product' : 'Physical product';
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The request failed. Please retry.';
const routeFromHash = () => window.location.hash.replace(/^#/, '') || '/';

export default function App() {
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [accessLoading, setAccessLoading] = useState(true);
  const [accessError, setAccessError] = useState('');
  const [sessionRefresh, setSessionRefresh] = useState(0);
  const [creatingOrganization, setCreatingOrganization] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const authPending = useRef(false);
  const principal = session?.active_organization ?? null;
  const token = principal ? organizationSession(principal.org_id) : '';
  const activeToken = useRef(token); activeToken.current = token;
  const [route, setRoute] = useState(routeFromHash);
  const [selected, setSelected] = useState<Scion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState('');
  const dirty = useRef(false);
  const editingBrief = useRef(edit); editingBrief.current = edit;
  const routeRef = useRef(route);
  const parts = route.split('/');
  const id = parts[1] === 'scions' && parts[2] ? parts[2] : null;
  const page = route === '/' ? 'tasks' : parts[1];
  const workspaceReturnRoute = useRef('/tasks');
  useEffect(() => { if (page !== 'settings' && page !== 'profile') workspaceReturnRoute.current = route; }, [page, route]);
  const view = parts[3] || 'default';
  const focusedId = parts[4] || null;
  const taskRoute = Boolean(id && focusedId && focusedId !== 'new' && (view === 'tasks' || view === 'agent-work' || view === 'research'));
  const canWrite = principal?.can_write === true;
  const canPrepare = principal?.can_prepare_workspace === true;
  const canManage = principal?.can_manage_workspace === true;
  const workspace = useWorkspace(token, principal?.org_id);

  useEffect(() => { document.getElementById('main-content')?.scrollTo(0, 0); }, [route]);

  useEffect(() => {
    const change = () => {
      const next = routeFromHash(); if (next === routeRef.current) return;
      const previousParts = routeRef.current.split('/'); const nextParts = next.split('/');
      // Task selection retains the same Scion-keyed workspace and its drafts.
      const retainsTaskDraft = !editingBrief.current && previousParts[1] === 'scions' && nextParts[1] === 'scions' && previousParts[2] === nextParts[2]
        && (!previousParts[3] || previousParts[3] === 'tasks') && (!nextParts[3] || nextParts[3] === 'tasks');
      if (dirty.current && !retainsTaskDraft && !window.confirm('Leave this edit? Your unsaved changes will be lost.')) {
        window.history.replaceState(null, '', `#${routeRef.current}`); return;
      }
      if (!retainsTaskDraft) dirty.current = false;
      routeRef.current = next; setRoute(next); setEdit(false); setNotice('');
    };
    window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload); return () => window.removeEventListener('beforeunload', unload);
  }, []);
  useEffect(() => {
    let active = true;
    setAccessLoading(true); setAccessError('');
    async function bootstrap() {
      try {
        const status = await request<{ setup_required: boolean }>(SESSION_AUTH, '/setup/status');
        if (!active) return;
        setSetupRequired(status.setup_required);
        try {
          const state = await request<SessionState>(SESSION_AUTH, '/session', { cache: 'no-store' });
          if (active) setSession(state);
        } catch (failure) {
          if (failure instanceof ApiError && failure.status === 401) { if (active) setSession(null); }
          else throw failure;
        }
      } catch (failure) { if (active) setAccessError(errorText(failure)); }
      finally { if (active) setAccessLoading(false); }
    }
    void bootstrap();
    return () => { active = false; };
  }, [sessionRefresh]);
  useEffect(() => {
    function recheck() {
      setSession(null); setSelected(null); setEdit(false); setCreatingOrganization(false);
      dirty.current = false; setAccessLoading(true); setSessionRefresh(value => value + 1);
    }
    const invalidated = (event: Event) => {
      if ((event as CustomEvent<{ token: string }>).detail?.token === activeToken.current) recheck();
    };
    const changed = (event: StorageEvent) => { if (event.key === sessionChangedStorageKey) recheck(); };
    window.addEventListener(sessionInvalidatedEvent, invalidated); window.addEventListener('storage', changed);
    return () => { window.removeEventListener(sessionInvalidatedEvent, invalidated); window.removeEventListener('storage', changed); };
  }, []);
  useEffect(() => {
    setError(''); setSelected(null);
    if (!id || !token || !principal) { setLoading(false); return; }
    const controller = new AbortController(); let active = true; setLoading(true);
    request<Scion>(token, `/scions/${encodeURIComponent(id)}`, { signal: controller.signal, cache: 'no-store' }).then(value => { if (active) setSelected(value); }).catch(failure => { if (active) setError(errorText(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [id, token, principal, refresh]);
  const setDirty = useCallback((value: boolean) => { dirty.current = value; }, []);
  function navigate(next: string) { window.location.hash = next; }
  function acceptSession(state: SessionState) {
    dirty.current = false; setSession(state); if (state.handler.installation_owner) setSetupRequired(false); setAccessError(''); setError('');
    setCreatingOrganization(false); setSelected(null); setEdit(false); setNotice('');
    const next = /^\/connect-worker\/[a-fA-F0-9]{16}$/.test(routeRef.current) ? routeRef.current : '/';
    setRefresh(value => value + 1); routeRef.current = next;
    window.history.replaceState(null, '', `#${next}`); setRoute(next); announceSessionChange();
  }
  async function disconnect() {
    if (authPending.current || (dirty.current && !window.confirm('Sign out and discard this unsaved edit?'))) return;
    authPending.current = true; setAuthBusy(true); setError('');
    try {
      await request<void>(SESSION_AUTH, '/session', { method: 'DELETE' });
      dirty.current = false; setSession(null); setSelected(null); setEdit(false); setCreatingOrganization(false); announceSessionChange();
    } catch (failure) { setError('Sign out could not be confirmed. ' + errorText(failure)); }
    finally { authPending.current = false; setAuthBusy(false); }
  }
  async function switchOrganization(organizationId: string) {
    if (authPending.current || organizationId === principal?.org_id || (dirty.current && !window.confirm('Switch organizations and discard this unsaved edit?'))) return;
    authPending.current = true; setAuthBusy(true); setError('');
    try {
      const state = await request<SessionState>(SESSION_AUTH, '/session/active-organization', { method: 'POST', body: JSON.stringify({ organization_id: organizationId }) });
      acceptSession(state);
    } catch (failure) { setError(errorText(failure)); }
    finally { authPending.current = false; setAuthBusy(false); }
  }
  function createOrganization() {
    if (authPending.current || (dirty.current && !window.confirm('Create another organization and discard this unsaved edit?'))) return;
    dirty.current = false; setEdit(false); setCreatingOrganization(true);
  }
  function saved(scion: Scion) {
    dirty.current = false; setEdit(false); setSelected(scion); setRefresh(value => value + 1);
    void workspace.refresh(); navigate(`/scions/${scion.id}`);
    setNotice(`Revision ${scion.current_revision} saved.`);
  }
  const appearance = <ThemePicker />;
  if (accessLoading) return <div className="boot-state" role="status"><Icon name="book" size={28} /><p>Opening Grimoire...</p></div>;
  if (accessError || setupRequired === null) return <main className="boot-state"><Icon name="alert" /><p>{accessError || 'Installation state could not be checked.'}</p><button className="button primary" onClick={() => setSessionRefresh(value => value + 1)}>Retry</button></main>;
  if (!session) return <IdentityAccess setupRequired={setupRequired} appearance={appearance} onReady={acceptSession} />;
  if (!principal || creatingOrganization) return <OrganizationOnboarding session={session} appearance={appearance} allowCancel={Boolean(principal)} onReady={acceptSession} onCancel={() => setCreatingOrganization(false)} />;
  const record = selected?.id === id ? selected : null;
  if (page === 'settings' || page === 'profile') return <LayoutProvider userId={session.handler.identity_id} organizationId={principal.org_id}><Settings session={session} connection={workspace} route={route} onSession={next => { setSession(next); announceSessionChange(); }} onSwitchOrganization={organizationId => void switchOrganization(organizationId)} onCreateOrganization={createOrganization} onNavigate={navigate} onBack={() => navigate(workspaceReturnRoute.current)} onDisconnect={() => void disconnect()} onDirty={setDirty} busy={authBusy} feedback={<>
    {notice && <div className="settings-feedback" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss notification">×</button></div>}
    {error && <ErrorMessage>{error}<button className="text-button" onClick={() => setRefresh(value => value + 1)}>Retry</button></ErrorMessage>}
  </>} /></LayoutProvider>;
  return <LayoutProvider userId={session.handler.identity_id} organizationId={principal.org_id}><div className="company-app">
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to content</a>
    <CompanyNavigation principal={principal} handler={session.handler} organizations={session.organizations} data={workspace.data} route={route} onNavigate={navigate} onSwitchOrganization={organizationId => void switchOrganization(organizationId)} onCreateOrganization={createOrganization} onDisconnect={() => void disconnect()} disconnectBusy={authBusy} canWrite={canManage} />
<div className="company-main"><header className="company-topbar"><nav aria-label="Breadcrumb">{id ? <><button onClick={() => navigate(taskRoute ? '/tasks' : '/scions')}>{taskRoute ? 'Tasks' : 'Scions'}</button><span>›</span><strong>{record?.revision.name ?? 'Scion'}</strong></> : <strong className="company-page-label">{route === '/new' ? 'New Scion' : pageNames[page] ?? 'Workspace'}</strong>}{(page === 'agents' || page === 'skills') && parts[2] && <><span>›</span><span>{parts[2] === 'new' ? 'Create' : page === 'skills' && parts[2] === 'discover' ? 'Discover' : page === 'skills' && parts[2] === 'studio' ? 'My Skills' : (page === 'agents' ? workspace.data?.agents : workspace.data?.skills)?.find(item => item.id === parts[2])?.config.name ?? 'Record'}</span></>}{id && !taskRoute && view !== 'overview' && <><span>›</span><span>{scionViewNames[view] ?? (record?.revision.product_category === 'digital' ? 'Tasks' : 'Overview')}</span></>}</nav></header>
    <main id="main-content" tabIndex={-1}>
      {notice && <div className="work-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notification">×</button></div>}
      {error && <ErrorMessage>{error}<button className="text-button" onClick={() => setRefresh(value => value + 1)}>Retry</button></ErrorMessage>}
      {id ? loading ? <div className="loading-panel" role="status">Loading Scion…</div> : record ? edit ? <div className="work-form-page"><IntakeForm key={`${record.id}-edit`} token={token} scion={record} onSaved={saved} onDirty={setDirty} onCancel={() => { if (!dirty.current || window.confirm('Discard this unsaved revision?')) { dirty.current = false; setEdit(false); } }} /></div> : <CaseRecord runtime={workspace.data?.agent_runtime} nativeAgents={workspace.data?.agents ?? []} key={record.id} token={token} scion={record} view={view} focusedId={focusedId} onNavigate={navigate} principalId={principal.principal_id} canManage={canManage} canWrite={canWrite} canPrepare={canPrepare} onDirty={setDirty} onEdit={current => { setSelected(current); setEdit(true); }} /> : null
      : route === '/new' ? !canManage ? <ErrorMessage>A Handler identity is required to create a Scion.</ErrorMessage> : <ScionCreation token={token} onSaved={saved} onCancel={() => navigate('/scions')} onDirty={setDirty} />
      : page === 'connect-worker' ? <WorkerPairing key={`${principal.org_id}:${parts[2]}`} token={token} principal={principal} code={parts[2] || ''} onNavigate={navigate} />
      : (page === 'agents' || page === 'skills') && workspace.data ? <NativeAgents token={token} page={page} route={route} data={workspace.data} canWrite={canManage} canExecute={canWrite} canPrepare={canPrepare} onNavigate={navigate} onChanged={workspace.refresh} onDirty={setDirty} />
      : <WorkspacePage key={page} page={pageNames[page] ? page : 'dashboard'} connection={workspace} onNavigate={navigate} canWrite={canManage} />}
    </main></div>
  </div></LayoutProvider>;
}
function ErrorMessage({ children }: { children: ReactNode }) { return <div className="error-message" role="alert"><Icon name="alert" size={19} /><div>{children}</div></div>; }
const scionViewNames: Record<string, string> = { overview: 'Overview', tasks: 'Tasks', research: 'Research', proposals: 'Deliverables', comparisons: 'Comparisons', sources: 'Evidence', 'agent-work': 'Agent work', graph: 'Dependency graph', activity: 'Watchtower', record: 'Brief', history: 'Revisions', scope: 'Physical scope', offers: 'Supplier offers' };

function CaseRecord({ runtime, nativeAgents, token, scion: initialScion, view: requestedView, focusedId, onNavigate, principalId, onEdit, canManage, canWrite, canPrepare, onDirty }: { runtime?: AgentRuntime; nativeAgents: NativeAgent[]; token: string; scion: Scion; view: string; focusedId: string | null; onNavigate: (route: string) => void; principalId: string; canManage: boolean; canWrite: boolean; canPrepare: boolean; onEdit: (current: Scion) => void; onDirty: (value: boolean) => void }) {
  const [scion, setScion] = useState(initialScion);
  const connection = useControlSurface(token, initialScion.id);
  const physical = scion.revision.product_category !== 'digital';
  const view = !physical && requestedView === 'default' ? 'tasks'
    : !scionViewNames[requestedView] || (!physical && ['scope', 'offers'].includes(requestedView)) ? physical ? 'overview' : 'tasks' : requestedView;
  useEffect(() => { setScion(initialScion); }, [initialScion]);
  useEffect(() => {
    if (!connection.data || connection.data.scion_revision === scion.current_revision) return;
    const controller = new AbortController(); let active = true;
    const deadline = window.setTimeout(() => controller.abort(), 2500);
    request<Scion>(token, `/scions/${encodeURIComponent(initialScion.id)}`, { signal: controller.signal, cache: 'no-store' }).then(result => { if (active) setScion(result); }).catch(() => undefined).finally(() => window.clearTimeout(deadline));
    return () => { active = false; controller.abort(); window.clearTimeout(deadline); };
  }, [token, initialScion.id, connection.data?.scion_revision, scion.current_revision]);
  const sourceDirty = useRef(false);
  const markSourceDirty = useCallback((value: boolean) => { sourceDirty.current = value; onDirty(value); }, [onDirty]);
  function leaveSource() {
    if (sourceDirty.current && !window.confirm('Discard this unsaved case edit?')) return false;
    markSourceDirty(false); return true;
  }
  function openView(next: string, id?: string) {
    if (!leaveSource() || (!physical && ['scope', 'offers'].includes(next))) return;
    onNavigate(`/scions/${scion.id}/${!physical && next === 'agent-work' ? 'tasks' : next}${id ? '/' + id : ''}`);
  }
  function editIntake() { if (leaveSource()) onEdit(scion); }
  function nodeAction(node: CaseNode) {
    if (!node.safe_next_action.enabled) return;
    if (node.safe_next_action.kind === 'edit_intake') { editIntake(); return; }
    if (node.kind === 'scion' || node.id === 'connector:handler_intake') { openView('record'); return; }
    if (node.kind === 'evidence_source' || node.kind === 'data_connector') { openView('sources'); return; }
    if (node.kind === 'agent_task') { const taskId = node.id.replace(/^task:/, ''); const task = connection.data?.operations.tasks.find(item => item.id === taskId); openView(task?.task_kind === 'research_public_web' ? 'research' : 'agent-work', taskId); return; }
    if (node.kind === 'human_review') { openView('activity'); return; }
    openView(node.kind === 'comparison' ? 'comparisons' : 'proposals', node.id.replace(/^(plan|comparison):/, ''));
  }
  const primaryViews = physical ? ['overview', 'agent-work', 'research', 'proposals', 'sources', 'activity'] : ['tasks', 'research', 'record', 'sources', 'activity'];
  const focusedTask = Boolean(focusedId && focusedId !== 'new' && (view === 'tasks' || view === 'agent-work' || view === 'research'));
  return <div className={`work-scion${focusedTask ? ' work-scion-task-detail' : ''}`}>
    {!focusedTask && <>
    <div className="work-scion-heading"><span className="work-muted">{category(scion.revision.product_category)} · Revision {scion.current_revision}</span><div><h1>{scion.revision.name}</h1><button className="button secondary" onClick={editIntake} disabled={!canManage}><Icon name="edit" size={15} />Edit brief</button></div></div>
    <nav className="work-scion-tabs" aria-label="Scion views">{primaryViews.map(item => <button key={item} aria-current={view === item ? 'page' : undefined} className={view === item ? 'selected' : ''} onClick={() => openView(item)}>{scionViewNames[item]}</button>)}<label className="work-more"><select aria-label="More Scion views" value={primaryViews.includes(view) ? '' : view} onChange={event => { if (event.target.value) openView(event.target.value); }}><option value="">More…</option><option value="proposals">Deliverables</option><option value="comparisons">Evidence comparisons</option><option value="graph">Dependency graph</option><option value="record">Full brief</option><option value="history">Revision history</option>{physical && <><option value="scope">Physical scope</option><option value="offers">Supplier offers</option></>}</select></label></nav>
    </>}
    <div className="work-scion-body">
    {view === 'research' ? <ResearchWorkspace key={`${token}:${scion.id}`} token={token} scion={scion} nativeAgents={nativeAgents} runtime={runtime} canPrepare={canPrepare} preferredTaskId={focusedId} onNavigate={onNavigate} onDirty={markSourceDirty} />
    : physical && focusedTask && focusedId ? <TaskRunDetail token={token} scion={scion} preferredTaskId={focusedId} nativeAgents={nativeAgents} runtime={runtime} canWrite={canWrite} canPrepare={canPrepare} control={connection} onNavigate={onNavigate} onDirty={markSourceDirty} />
    : view === 'tasks' || !physical && view === 'agent-work' ? <TaskWorkspace key={`${token}:${scion.id}`} token={token} scion={scion} nativeAgents={nativeAgents} runtime={runtime} canManage={canManage} canWrite={canWrite} canPrepare={canPrepare} preferredTaskId={focusedId} control={connection} onNavigate={onNavigate} onScionSaved={async next => { setScion(next); await connection.refresh(); }} onDirty={markSourceDirty} />
    : view === 'overview' ? <ScionOverview scion={scion} connection={connection} onOpen={openView} onEdit={editIntake} canWrite={canManage} />
    : view === 'graph' ? <ControlSurface graphOnly connection={connection} onAction={nodeAction} />
    : view === 'activity' ? <ScionActivity connection={connection} onOpenTask={id => openView(connection.data?.operations.tasks.find(task => task.id === id)?.task_kind === 'research_public_web' ? 'research' : physical ? 'agent-work' : 'tasks', id)} />
    : view === 'record' ? <section className="work-brief-page"><div className="work-section-title"><h2>Brief</h2><span className="work-muted">Handler-provided · unverified</span></div><RecordFacts revision={scion.revision} /></section>
    : view === 'history' ? <History token={token} scion={scion} />
    : view === 'sources' ? <Evidence token={token} scion={scion} canWrite={canPrepare} onDirty={markSourceDirty} />
    : view === 'scope' ? <PhysicalScope token={token} scion={scion} principalId={principalId} canWrite={canWrite} onDirty={markSourceDirty} onSources={() => openView('sources')} onOfferProposal={id => openView('offers', id)} onCapabilityProposal={id => openView('proposals', id)} preferredProposalId={focusedId} />
    : view === 'offers' ? <Offers token={token} scion={scion} canWrite={canWrite} preferredProposalId={focusedId} onDirty={markSourceDirty} onSources={() => openView('sources')} onScopeProposal={id => openView('scope', id)} onCapabilityProposal={id => openView('proposals', id)} />
    : <AdaptiveScion runtime={runtime} nativeAgents={nativeAgents} token={token} scion={scion} canWrite={canWrite} canPrepare={canPrepare} view={view === 'agent-work' ? 'agent-work' : view === 'comparisons' ? 'comparisons' : 'plans'} preferredPlanId={view === 'proposals' ? focusedId : null} preferredComparisonId={view === 'comparisons' ? focusedId : null} onView={openView} onDirty={markSourceDirty} onSources={() => openView('sources')} onScopeProposal={id => openView('scope', id)} onOfferProposal={id => openView('offers', id)} />}
    </div>
  </div>;
}
function IntakeCoverage({ revision }: { revision: Intake }) {
  const count = [Boolean(revision.product_description?.trim()), revision.product_category !== 'unspecified', Boolean(revision.decision?.trim()), revision.requirements !== null, revision.questions !== null].filter(Boolean).length;
  const questions = revision.questions === null
    ? 'Questions not assessed'
    : revision.questions.length === 0
      ? 'No unresolved questions recorded'
      : `${revision.questions.length} unresolved question${revision.questions.length === 1 ? '' : 's'}`;
  return <p className="intake-coverage">{count} field{count === 1 ? '' : 's'} entered · {questions}</p>;
}

function Missing({ children = 'Not provided' }: { children?: ReactNode }) { return <span className="missing-inline"><span />{children}</span>; }
function RecordFacts({ revision }: { revision: Revision }) {
  return <dl className="facts-list"><div><dt>Product description</dt><dd>{revision.product_description || <Missing />}</dd></div><div><dt>Product category</dt><dd>{revision.product_category === 'unspecified' ? <Missing>Not selected</Missing> : category(revision.product_category)}</dd></div><div><dt>Decision to be made</dt><dd>{revision.decision || <Missing />}</dd></div><div><dt>Known requirements</dt><dd><FactItems items={revision.requirements} none="Explicitly no known requirements recorded." /></dd></div><div><dt>Unresolved questions</dt><dd><FactItems items={revision.questions} none="Explicitly no unresolved questions recorded." /></dd></div></dl>;
}
function FactItems({ items, none }: { items: string[] | null; none: string }) { return items === null ? <Missing>Not assessed</Missing> : items.length === 0 ? <span className="explicit-none">{none}</span> : <ul className="fact-items">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>; }
function History({ token, scion }: { token: string; scion: Scion }) {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [snapshot, setSnapshot] = useState<Revision>(scion.revision);
  const [authors, setAuthors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fetching, setFetching] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    request<RevisionHistory>(token, `/scions/${scion.id}/revisions`).then(value => {
      if (!active) return;
      const history = [...value.revisions].sort((a, b) => b.number - a.number);
      setRevisions(history);
      setSnapshot(history[0] ?? scion.revision);
      setAuthors(Object.fromEntries((value.authors ?? []).map(author => [author.principal_id, author.display_name])));
    }).catch(failure => { if (active) setError(errorText(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, scion.id, scion.revision, retry]);
  async function open(number: number) {
    setFetching(true); setError('');
    try { setSnapshot(await request<Revision>(token, `/scions/${scion.id}/revisions/${number}`)); } catch (failure) { setError(errorText(failure)); } finally { setFetching(false); }
  }
  function handlerName(principalId: string) {
    return authors[principalId] || (loading ? 'Loading Handler name…' : 'Handler name unavailable');
  }
  return <div className="history-layout">
    <section className="history-list">
      <div className="section-heading"><h2>Revision history</h2><Icon name="history" size={19} /></div>
      <p className="section-description">The current revision opens first. Select any revision to read its unchanged snapshot.</p>
      {error && <ErrorMessage>{error}<button className="text-button" onClick={() => setRetry(value => value + 1)}>Retry history</button></ErrorMessage>}
      {loading ? <p role="status">Loading revision history…</p> : <ol className="timeline">{revisions.map(revision => <li key={revision.number}>
        <button className={`revision-choice ${snapshot.number === revision.number ? 'active' : ''}`} aria-pressed={snapshot.number === revision.number} disabled={fetching} onClick={() => open(revision.number)}>
          <span className="revision-node">{revision.number}</span>
          <div>
            <div className="revision-title"><strong>Revision {revision.number}</strong>{revision.number === revisions[0]?.number && <span className="badge emphasis">Current</span>}</div>
            <p>{revision.change_summary || 'Intake revision'}</p>
            <time dateTime={revision.created_at}>{date(revision.created_at)}</time>
            <small className="revision-author">Saved by {handlerName(revision.created_by)}</small>
          </div>
          <Icon name="arrow" size={16} />
        </button>
      </li>)}</ol>}
    </section>
    <section className="snapshot-card" aria-label={`Revision ${snapshot.number} snapshot`} aria-live="polite">
      {fetching ? <div className="snapshot-empty" role="status">Loading saved revision…</div> : <>
        <div className="section-heading"><div><p className="eyebrow">SAVED SNAPSHOT</p><h2>{snapshot.name}</h2></div><span className="badge">Revision {snapshot.number}</span></div>
        <p className="section-description">{date(snapshot.created_at)} · Read only</p>
        <p className="snapshot-author">Saved by <strong>{handlerName(snapshot.created_by)}</strong></p>
        <details className="revision-details" key={snapshot.number}>
          <summary>Revision details</summary>
          <dl><dt>Handler principal ID</dt><dd><code>{snapshot.created_by}</code></dd><dt>Change summary</dt><dd>{snapshot.change_summary || 'Intake revision'}</dd></dl>
          <p>The Handler name is the current organization directory label. The principal ID is preserved with this revision.</p>
        </details>
        {snapshot.product_category === 'digital' && <p className="snapshot-disclaimer">Digital intake supports capability proposals and evidence comparison drafts. Vendor comparison is unavailable.</p>}
        <RecordFacts revision={snapshot} />
      </>}
    </section>
  </div>;
}

type FormValues = { name: string; description: string; category: Category; decision: string; requirements: string; requirementsNone: boolean; questions: string; questionsNone: boolean; summary: string };
function valuesFrom(scion?: Scion): FormValues {
  const revision = scion?.revision;
  return { name: revision?.name ?? '', description: revision?.product_description ?? '', category: revision?.product_category ?? 'unspecified', decision: revision?.decision ?? '', requirements: revision?.requirements?.join('\n') ?? '', requirementsNone: revision?.requirements?.length === 0, questions: revision?.questions?.join('\n') ?? '', questionsNone: revision?.questions?.length === 0, summary: '' };
}
function payloadFrom(values: FormValues, editing: boolean): Intake {
  const list = (value: string, none: boolean) => none ? [] : value.trim() ? value.split('\n').map(item => item.trim()).filter(Boolean) : null;
  return { name: values.name.trim(), product_description: values.description.trim() || null, product_category: values.category, decision: values.decision.trim() || null, requirements: list(values.requirements, values.requirementsNone), questions: list(values.questions, values.questionsNone), change_summary: values.summary.trim() || (editing ? 'Intake updated by Handler' : 'Initial intake draft') };
}
function IntakeForm({ token, scion, onSaved, onCancel, onDirty }: { token: string; scion?: Scion; onSaved: (scion: Scion) => void; onCancel: () => void; onDirty: (dirty: boolean) => void }) {
  const [values, setValues] = useState<FormValues>(() => valuesFrom(scion));
  const [baseRevision, setBaseRevision] = useState(scion?.current_revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [latest, setLatest] = useState<Scion | null>(null);
  const [preserved, setPreserved] = useState<FormValues | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const retry = useRef<{ body: string; base: number | undefined; key: string } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  function update<K extends keyof FormValues>(key: K, value: FormValues[K]) { setValues(previous => ({ ...previous, [key]: value })); onDirty(true); setUncertain(false); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || stale) return;
    setError('');
    const payload = payloadFrom(values, Boolean(scion));
    for (const [label, items] of [['Requirements', payload.requirements], ['Questions', payload.questions]] as const) {
      if (items && (items.length > 100 || items.some(item => item.length > 2000))) {
        setError(`${label} must contain no more than 100 items, with at most 2,000 characters per item.`);
        return;
      }
    }
    setBusy(true);
    const body = JSON.stringify(payload);
    if (retry.current?.body !== body || retry.current.base !== baseRevision) retry.current = { body, base: baseRevision, key: crypto.randomUUID() };
    try {
      const result = await request<Scion>(token, scion ? `/scions/${scion.id}/revisions` : '/scions', { method: 'POST', headers: { 'Idempotency-Key': retry.current.key, ...(baseRevision ? { 'If-Match': `"${baseRevision}"` } : {}) }, body });
      onDirty(false); onSaved(result);
    } catch (failure) {
      setError(errorText(failure));
      if (failure instanceof ApiError && failure.status === 412) setStale(true);
      if (failure instanceof ApiError && (failure.status === 0 || failure.status >= 500)) setUncertain(true);
    } finally { setBusy(false); }
  }
  async function loadLatest() {
    if (!scion) return; setLoadingLatest(true);
    try { setLatest(await request<Scion>(token, `/scions/${scion.id}`)); } catch (failure) { setError(errorText(failure)); } finally { setLoadingLatest(false); }
  }
  function startLatest() {
    if (!latest) return;
    setPreserved(values); setValues(valuesFrom(latest)); setBaseRevision(latest.current_revision); setStale(false); setError(''); retry.current = null; onDirty(true);
  }
  return <><div className="page-heading form-heading"><div><p className="eyebrow">{scion ? `SCION INTAKE · EDITING REVISION ${baseRevision}` : 'A NEW CASE RECORD'}</p><h1>{scion ? 'Revise the intake' : 'Create a Scion'}</h1><p>{scion ? 'Save a new revision. The previous record will remain unchanged.' : 'Begin with a name. Add what you know and leave the unknowns visible.'}</p></div><span className="badge">Intake draft</span></div>
    <form className="intake-form" onSubmit={save}><fieldset disabled={busy} className="form-fieldset">
      <div className="form-main">
        {error && <ErrorMessage>{error}</ErrorMessage>}
        {uncertain && <div className="info-notice"><p>The save result is uncertain. Retry without editing to reuse the same request key and avoid a duplicate revision. If you change the draft, check the case record before saving again.</p></div>}
        {stale && <div className="conflict-panel"><h2>A newer revision is already saved.</h2><p>Your unsaved draft is still in the fields below. Load the latest record before starting a fresh edit.</p><button className="button secondary" type="button" onClick={loadLatest} disabled={loadingLatest}>{loadingLatest ? 'Loading…' : 'Load latest revision'}</button>{latest && <div className="latest-preview"><h3>Latest saved record · Revision {latest.current_revision}</h3><p><strong>{latest.revision.name}</strong></p><RecordFacts revision={latest.revision} /><p>Start from this record, then manually reapply your intended changes. Your unsaved draft will be kept below for reference.</p><button className="button secondary" type="button" onClick={startLatest}>Start a new edit from revision {latest.current_revision}</button></div>}</div>}
        {preserved && <details className="preserved-draft" open><summary>Your previous unsaved draft · reference only</summary><p>These values were not saved. Copy only the changes you intend into the latest intake below.</p><dl><dt>Name</dt><dd>{preserved.name}</dd><dt>Product description</dt><dd>{preserved.description || 'Not provided'}</dd><dt>Category</dt><dd>{category(preserved.category)}</dd><dt>Decision</dt><dd>{preserved.decision || 'Not provided'}</dd><dt>Requirements</dt><dd>{preserved.requirementsNone ? 'Explicitly none' : preserved.requirements || 'Not assessed'}</dd><dt>Questions</dt><dd>{preserved.questionsNone ? 'Explicitly none' : preserved.questions || 'Not assessed'}</dd><dt>Change summary</dt><dd>{preserved.summary || 'Not provided'}</dd></dl></details>}
        <section className="form-section"><div className="form-section-title"><span className="subtle-icon"><Icon name="file" /></span><div><h2>Scion identity</h2><p>A stable name for the product you’re considering.</p></div></div><label htmlFor="name">Scion name <span className="required-label">Required</span></label><input id="name" value={values.name} onChange={event => update('name', event.target.value)} maxLength={160} required autoFocus placeholder="Give this Scion a recognizable name" /><label htmlFor="category">Product category</label><select id="category" value={values.category} onChange={event => update('category', event.target.value as Category)}><option value="unspecified">Not yet specified</option><option value="physical">Physical product</option><option value="digital">Digital product</option></select>{values.category === 'digital' && <p className="digital-notice">Describe a digital product in your own words. After saving, use Capability plan to prepare a proposal and review evidence gaps. Digital vendor comparison is unavailable.</p>}</section>
        <section className="form-section"><div className="form-section-title"><span className="subtle-icon"><Icon name="book" /></span><div><h2>The product and the decision</h2><p>Use your own words. An empty answer remains missing.</p></div></div><label htmlFor="description">Product description <span className="optional-label">Optional</span></label><textarea id="description" value={values.description} onChange={event => update('description', event.target.value)} rows={4} maxLength={12000} placeholder="What is the product, who is it for, and what should it do?" /><label htmlFor="decision">Decision to be made <span className="optional-label">Optional</span></label><textarea id="decision" value={values.decision} onChange={event => update('decision', event.target.value)} rows={3} maxLength={4000} placeholder="What does the Handler need to decide?" /></section>
        <section className="form-section"><div className="form-section-title"><span className="subtle-icon"><Icon name="check" /></span><div><h2>Requirements and open questions</h2><p>Record each item on its own line.</p></div></div><label htmlFor="requirements">Known requirements <span className="optional-label">Optional</span></label><textarea id="requirements" value={values.requirements} onChange={event => update('requirements', event.target.value)} disabled={values.requirementsNone} rows={4} maxLength={200100} placeholder="One requirement per line" aria-describedby="requirements-help" /><p id="requirements-help" className="field-help">Leave blank if requirements have not been assessed.</p><label className="checkbox-label"><input type="checkbox" checked={values.requirementsNone} onChange={event => update('requirementsNone', event.target.checked)} /><span>Explicitly record no known requirements</span></label><label htmlFor="questions">Unresolved questions <span className="optional-label">Optional</span></label><textarea id="questions" value={values.questions} onChange={event => update('questions', event.target.value)} disabled={values.questionsNone} rows={4} maxLength={200100} placeholder="One question per line" aria-describedby="questions-help" /><p id="questions-help" className="field-help">Leave blank if open questions have not been assessed.</p><label className="checkbox-label"><input type="checkbox" checked={values.questionsNone} onChange={event => update('questionsNone', event.target.checked)} /><span>Explicitly record no unresolved questions</span></label></section>
        {scion && <section className="form-section"><label htmlFor="summary">What changed? <span className="optional-label">Optional</span></label><input id="summary" value={values.summary} onChange={event => update('summary', event.target.value)} maxLength={1000} placeholder="A short note for the revision history" /></section>}
        <div className="form-actions"><span><Icon name="lock" size={16} />{scion ? `Creates revision ${(baseRevision ?? 0) + 1}` : 'Creates revision 1'}</span><div><button className="button secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button><button className="button primary" type="submit" disabled={busy || stale || !values.name.trim()}>{busy ? 'Saving…' : scion ? 'Save new revision' : 'Save intake draft'}<Icon name="arrow" size={17} /></button></div></div>
      </div><aside className="form-aside"><div className="draft-guide"><span className="badge emphasis">FACTS FIRST</span><h2>Unknown is a valid starting point.</h2><p>You can save this Scion before every section is complete.</p><IntakeCoverage revision={payloadFrom(values, Boolean(scion))} /><ul><li><Icon name="check" size={17} /><span>Only the Scion name is required.</span></li><li><Icon name="check" size={17} /><span>Missing information stays visible.</span></li><li><Icon name="check" size={17} /><span>Every saved revision is preserved.</span></li></ul><div className="draft-boundary"><Icon name="lock" size={18} /><p>This is an intake record. Saving does not qualify a product or approve a sourcing decision.</p></div></div></aside>
    </fieldset></form></>;
}
