import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { HandlerIdentity, OrganizationSummary, Principal, Scion } from './api';
import { useTheme } from './theme';
import type { ControlSurfaceConnection } from './control-api';
import { proposalPath } from './workspace-api';
import type { ProposalSummary, WorkspaceState, useWorkspace } from './workspace-api';
import TaskDirectory from './TaskDirectory';
import AgentAvatar from './AgentAvatar';
import { taskWorkflow } from './task-workflow';
import WorkStateGlyph from './WorkStateGlyph';
import { useLayoutPreferences } from './LayoutPreferences';
import LayoutResizeHandle from './LayoutResizeHandle';
import { layoutLimits } from './layout-preferences';
import type { WorkState } from './WorkStateGlyph';

export const pageNames: Record<string, string> = { dashboard: 'Dashboard', inbox: 'Inbox', search: 'Search', proposals: 'Deliverables', scions: 'Scions', tasks: 'Tasks', watchtower: 'Watchtower', agents: 'Agents', skills: 'Skills', connectors: 'Connectors', audit: 'Activity', settings: 'Settings', profile: 'Profile', 'connect-worker': 'Connect Codex' };
const humanize = (text: string) => text.replaceAll('_', ' ');
export const workTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never checked';
export function WorkIcon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    inbox: <><path d="m3 14 3-10h12l3 10v6H3Z" /><path d="M3 14h5l2 3h4l2-3h5" /></>,
    proposals: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
    scions: <path d="M3 7V4h7l2 3h9v13H3Z" />,
    tasks: <><path d="m4 6 2 2 3-4M12 6h8M4 13l2 2 3-4M12 13h8M12 20h8" /></>,
    watchtower: <><path d="M2 12h4l3-7 6 14 3-7h4" /></>,
    agents: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5" /></>,
    instructions: <><path d="M12 5v16M3 3h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z" /></>,
    runtime: <><path d="M3 6h8m4 0h6M3 12h2m4 0h12M3 18h12m4 0h2" /><circle cx="13" cy="6" r="2" /><circle cx="7" cy="12" r="2" /><circle cx="17" cy="18" r="2" /></>,
    permissions: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>,
    credentials: <><circle cx="8" cy="8" r="5" /><path d="m12 12 9 9m-5-5 3-3m-6 0 3-3" /></>,
    runs: <><circle cx="12" cy="12" r="9" /><path d="m10 8 6 4-6 4Z" /></>,
    usage: <><path d="M4 3v18h17M8 17v-5M13 17V8M18 17V4" /></>,
    skills: <><path d="m12 3 9 5-9 5-9-5ZM3 12l9 5 9-5M3 16l9 5 9-5" /></>,
    connectors: <><path d="m9 5 10 10M7 7l8 8-3 3H7l-3-3v-5ZM16 3l-4 4M21 8l-4 4M4 20l3-3" /></>,
    audit: <><path d="M4 10a8 8 0 1 1 1 8M3 4v7h7M12 7v5l3 2" /></>,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>,
    new: <><path d="M12 5v14M5 12h14" /></>,
    arrow: <><path d="M5 12h14m-5-5 5 5-5 5" /></>,
    exit: <><path d="M9 3H3v18h6M9 12h12m-5-5 5 5-5 5" /></>,
    settings: <><path d="M10 3h4l1 3 3-1 2 3-2 3 2 3-2 3-3-1-1 3h-4l-1-3-3 1-2-3 2-3-2-3 2-3 3 1Z" /><circle cx="12" cy="11" r="3" /></>,
    profile: <><circle cx="12" cy="7" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
    edit: <><path d="m14 4 6 6M4 20l4-1L21 6l-4-4L4 15Z" /></>,
    moon: <path d="M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" /></>,
    chevrons: <><path d="m8 8 4-4 4 4m-8 8 4 4 4-4" /></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.proposals}</svg>;
}
export function WorkStatus({ value }: { value: string }) {
  const label: Record<string, string> = { proposed: 'Needs review', inspect: 'Open record', completed: 'Prepared', permission_checked_on_read: 'Checked on access', todo: 'To do', in_progress: 'In progress', needs_input: 'Needs input', needs_review: 'Needs review' };
  const tone = /blocked|stale|failed|revoked/.test(value) ? 'danger' : /healthy|connected|current|available|completed/.test(value) && value !== 'disconnected' && value !== 'unavailable' ? 'good' : /required|pending|proposed|delayed|running|queued/.test(value) ? 'attention' : 'neutral';
  const exact: Record<string, WorkState> = { todo: 'todo', queued: 'todo', in_progress: 'in_progress', running: 'in_progress', dispatched: 'in_progress', needs_input: 'needs_input', 'decision required': 'needs_input', needs_review: 'needs_review', proposed: 'needs_review', 'review required': 'needs_review', 'review recorded': 'completed', cancelled: 'cancelled', inspect: 'neutral' };
  const state: WorkState = exact[value] ?? (tone === 'danger' ? 'blocked' : tone === 'good' ? 'completed' : tone === 'attention' ? 'todo' : 'neutral');
  return <span className={`work-status ${tone}`} data-status={value}><WorkStateGlyph state={state} />{label[value] ?? humanize(value)}</span>;
}

export function CompanyNavigation({ principal, handler, organizations, data, route, onNavigate, onSwitchOrganization, onCreateOrganization, onDisconnect, disconnectBusy, canWrite }: { principal: Principal; handler: HandlerIdentity; organizations: OrganizationSummary[]; data: WorkspaceState | null; route: string; onNavigate: (route: string) => void; onSwitchOrganization: (id: string) => void; onCreateOrganization: () => void; onDisconnect: () => void; disconnectBusy: boolean; canWrite: boolean }) {
  const layout = useLayoutPreferences();
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 850px)').matches);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pointerMotion, setPointerMotion] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const bottomNavigation = useRef<HTMLElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const closeTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 850px)');
    const resize = () => { setNarrow(media.matches); setDrawerOpen(false); };
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, []);
  useEffect(() => setDrawerOpen(false), [route, principal.org_id]);
  useEffect(() => {
    if (!narrow || !drawerOpen) return;
    const main = document.querySelector<HTMLElement>('.company-main');
    const previousInert = main?.inert ?? false;
    if (main) main.inert = true;
    if (bottomNavigation.current) bottomNavigation.current.inert = true;
    const focus = requestAnimationFrame(() => closeTrigger.current?.focus());
    return () => {
      cancelAnimationFrame(focus);
      if (main) main.inert = previousInert;
      if (bottomNavigation.current) bottomNavigation.current.inert = false;
      if (window.matchMedia('(max-width: 850px)').matches) menuTrigger.current?.focus();
    };
  }, [narrow, drawerOpen]);
  const navigate = (next: string) => { setDrawerOpen(false); onNavigate(next); };
  const page = route === '/' || /^\/scions\/[^/]+\/(tasks|agent-work|research)(\/|$)/.test(route) ? 'tasks' : route.split('/')[1];
  const inboxCount = data ? data.reviews.length + data.scions.filter(scion => !scion.revision.decision?.trim()).length : null;
  function item(name: string, count?: number | null) { return <button key={name} title={pageNames[name]} aria-label={pageNames[name]} aria-current={page === name ? 'page' : undefined} className={`company-nav-item ${page === name ? 'active' : ''}`} onClick={() => navigate(`/${name}`)}><WorkIcon name={name} /><span>{pageNames[name]}</span>{typeof count === 'number' && count > 0 && <small>{count}</small>}</button>; }
  return <>
    {narrow && <div className="company-drawer-backdrop" data-open={drawerOpen} data-motion={pointerMotion} aria-hidden="true" onPointerDown={() => setDrawerOpen(false)} />}
    <aside ref={sidebar} id="company-navigation" className="company-sidebar" data-open={drawerOpen} data-motion={pointerMotion} role={narrow ? 'dialog' : undefined} aria-modal={narrow && drawerOpen ? true : undefined} aria-label={narrow ? 'Workspace navigation' : undefined} aria-hidden={narrow && !drawerOpen ? true : undefined} inert={narrow && !drawerOpen} onKeyDown={event => {
      if (!narrow || !drawerOpen) return;
      setPointerMotion(false);
      if (event.key === 'Escape') {
        // A nested account or organization menu handles its own Escape first.
        if (sidebar.current?.querySelector('#account-options, #organization-options')) return;
        event.preventDefault(); setPointerMotion(false); setDrawerOpen(false);
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(sidebar.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, textarea, [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0);
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    {!narrow && <LayoutResizeHandle label="Resize navigation" value={layout.sidebarWidth} min={layoutLimits.sidebar.min} max={layoutLimits.sidebar.max} initial={layoutLimits.sidebar.initial} onChange={layout.setSidebarWidth} className="layout-sidebar-resize" controls="company-navigation" />}
    {narrow && <div className="company-drawer-heading"><strong>Workspace</strong><button ref={closeTrigger} type="button" aria-label="Close navigation" onClick={event => { setPointerMotion(event.detail > 0); setDrawerOpen(false); }}><WorkIcon name="close" /></button></div>}
    <OrganizationMenu principal={principal} organizations={organizations} route={route} onNavigate={navigate} onSwitch={id => { setDrawerOpen(false); onSwitchOrganization(id); }} onCreate={() => { setDrawerOpen(false); onCreateOrganization(); }} busy={disconnectBusy} />
    <nav aria-label="Company navigation"><div className="company-nav-group"><button className="company-nav-item" aria-label="New Scion" title="New Scion" disabled={!canWrite} onClick={() => navigate('/new')}><WorkIcon name="new" /><span>New Scion</span></button>{item('search')}{item('dashboard')}{item('inbox', inboxCount)}</div>
      <div className="company-nav-group"><h2>Work</h2>{item('tasks')}{item('scions')}{item('proposals')}{item('watchtower')}</div>
      <div className="company-nav-group"><h2>Organization</h2>{item('agents')}{item('skills')}{item('connectors')}{item('audit')}</div>
      {data && data.scions.length > 0 && <div className="company-nav-group company-recents"><h2>Recent Scions</h2>{data.scions.slice(0, 3).map(scion => <button className="company-nav-item" key={scion.id} title={scion.revision.name} onClick={() => navigate(`/scions/${scion.id}`)}><span className="work-record-dot" /><span>{scion.revision.name}</span></button>)}</div>}
    </nav><AccountMenu handler={handler} route={route} onNavigate={navigate} onDisconnect={onDisconnect} disconnectBusy={disconnectBusy} /></aside>
    {narrow && <nav ref={bottomNavigation} className="company-bottom-navigation" aria-label="Quick navigation">{['tasks', 'scions', 'agents'].map(name => <button key={name} type="button" aria-current={page === name ? 'page' : undefined} onClick={() => navigate(`/${name}`)}><WorkIcon name={name} /><span>{pageNames[name]}</span></button>)}<button ref={menuTrigger} type="button" aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={drawerOpen} aria-controls="company-navigation" onClick={event => { setPointerMotion(event.detail > 0); setDrawerOpen(true); }}><WorkIcon name="menu" /><span>Menu</span></button></nav>}
  </>;
}

function OrganizationMenu({ principal, organizations, route, onNavigate, onSwitch, onCreate, busy }: { principal: Principal; organizations: OrganizationSummary[]; route: string; onNavigate: (route: string) => void; onSwitch: (id: string) => void; onCreate: () => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => setOpen(false), [route, principal.org_id]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const act = (action: () => void) => { setOpen(false); trigger.current?.focus(); action(); };
  return <div className="company-organization" ref={root} onBlur={event => { if (!root.current?.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <button ref={trigger} className="company-brand" aria-label="Organization menu" title={principal.organization_name} data-organization-id={principal.org_id} aria-expanded={open} aria-controls={open ? 'organization-options' : undefined} onClick={() => setOpen(value => !value)}><span className="company-avatar">G</span><span><strong>Grimoire</strong><small>{principal.organization_name}</small></span><WorkIcon name="chevrons" /></button>
    {open && <div id="organization-options" className="company-organization-options" role="group" aria-label="Organizations" aria-busy={busy}>
      <p className="company-menu-label">Your organizations</p>
      <div className="company-organization-list">{organizations.map(organization => <button key={organization.org_id} autoFocus={organization.org_id === principal.org_id} aria-label={`Switch to ${organization.organization_name}`} aria-current={organization.org_id === principal.org_id ? 'true' : undefined} data-organization-id={organization.org_id} disabled={busy} onClick={() => act(() => { if (organization.org_id !== principal.org_id) onSwitch(organization.org_id); })}><span className="company-avatar">{organization.organization_name.charAt(0)}</span><span>{organization.organization_name}</span>{organization.org_id === principal.org_id && <span className="company-organization-check" aria-hidden="true">✓</span>}</button>)}</div>
      <div className="company-organization-actions"><button onClick={() => act(() => onNavigate('/settings/organization'))}><WorkIcon name="settings" />Organization settings</button><button disabled={busy} onClick={() => act(onCreate)} aria-label="Create another organization"><WorkIcon name="new" />Create organization</button></div>
    </div>}
  </div>;
}

function AccountMenu({ handler, route, onNavigate, onDisconnect, disconnectBusy }: { handler: HandlerIdentity; route: string; onNavigate: (route: string) => void; onDisconnect: () => void; disconnectBusy: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { changeTheme } = useTheme();
  const dark = document.documentElement.dataset.theme === 'dark';
  useEffect(() => setOpen(false), [route]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const go = (path: string) => { setOpen(false); onNavigate(path); };
  return <div className="company-user" ref={root}>
    {open && <div id="account-options" className="company-account-options" aria-label="Account options" onBlur={event => { if (!root.current?.contains(event.relatedTarget as Node)) setOpen(false); }}>
      <div className="company-account-identity"><span className="company-avatar">{handler.display_name.charAt(0)}</span><span><strong>{handler.display_name}</strong><small>{handler.login_name}</small></span></div>
      <button autoFocus onClick={() => go('/settings/account')}><WorkIcon name="settings" />Settings</button>
      <button onClick={() => go('/profile')}><WorkIcon name="profile" />View profile</button>
      <button onClick={() => go('/profile/edit')}><WorkIcon name="edit" />Edit profile</button>
      <button onClick={() => go('/settings/appearance')}><WorkIcon name="sun" />Appearance</button>
      <button onClick={() => go('/settings/about')}><WorkIcon name="instructions" />Documentation</button>
      <a href="/demo" target="_blank" rel="noreferrer" onClick={() => { setOpen(false); trigger.current?.focus(); }}><WorkIcon name="arrow" />Judge demo ↗</a>
      <button onClick={() => { changeTheme(dark ? 'light' : 'dark'); setOpen(false); trigger.current?.focus(); }}><WorkIcon name={dark ? 'sun' : 'moon'} />Switch to {dark ? 'Pearl' : 'Midnight Blue'}</button>
      <button className="company-account-signout" disabled={disconnectBusy} onClick={() => { setOpen(false); onDisconnect(); }}><WorkIcon name="exit" />{disconnectBusy ? 'Signing out…' : 'Sign out'}</button>
    </div>}
    <button ref={trigger} className="company-account-trigger" aria-label="Account menu" aria-expanded={open} aria-controls={open ? 'account-options' : undefined} onClick={() => setOpen(value => !value)}><span className="company-avatar">{handler.display_name.charAt(0)}</span><span><strong>{handler.display_name}</strong><small>Handler account</small></span><WorkIcon name="chevrons" /></button>
  </div>;
}

function Empty({ children }: { children: ReactNode }) { return <div className="work-empty">{children}</div>; }
function PageHeading({ title, description, children }: { title: string; description: string; children?: ReactNode }) { return <div className="work-page-heading"><div><h1>{title}</h1><p>{description}</p></div>{children}</div>; }
function CollectionNote({ count, limit }: { count: number; limit: number }) { return count >= limit ? <p className="work-muted">Showing the most recent {limit} records. Open a Scion for its detailed history.</p> : null; }

function RecentAgentWork({ data, onNavigate }: { data: WorkspaceState; onNavigate: (route: string) => void }) {
  const tasks = [...data.tasks].sort((a, b) => (b.completed_at ?? b.created_at).localeCompare(a.completed_at ?? a.created_at)).slice(0, 4);
  return <section className="work-agent-activity" aria-labelledby="recent-agent-work">
    <div className="work-section-title"><h2 id="recent-agent-work">Recent agent work</h2><button onClick={() => onNavigate('/tasks')}>View tasks →</button></div>
    {tasks.length ? <div className="work-agent-cards">{tasks.map(task => {
      const agent = data.agents.find(item => item.id === task.agent_id);
      const scion = data.scions.find(item => item.id === task.scion_id);
      const agentName = agent?.config.name ?? (task.agent_id ? 'Assigned agent' : 'Codex worker');
      const workflow = taskWorkflow({ status: task.status, blocked: task.blocked, stale: task.stale || Boolean(scion && task.scion_revision !== scion.current_revision), reviewed: task.review_recorded, needsInput: Boolean(task.task_kind === 'prepare_capability_plan' && scion && (scion.revision.questions?.length || !scion.revision.decision?.trim())) });
      const title = task.task_kind === 'research_public_web' ? 'Research procurement' : task.task_kind === 'prepare_capability_plan' ? 'Plan product capabilities' : task.task_kind === 'prepare_physical_scope' ? 'Prepare physical scope' : task.task_kind === 'prepare_offer_normalization' ? 'Prepare supplier offer worksheet' : humanize(task.task_kind);
      const reviewNote = task.blocked ? 'Evidence access blocks this work.' : task.stale || Boolean(scion && task.scion_revision !== scion.current_revision) ? 'Inputs changed · replacement work needed.' : task.proposal_id ? task.review_recorded ? 'Human review recorded · no approval granted.' : 'Result prepared · human review required.' : task.status === 'failed' ? 'An attempt failed · inspect the task to retry.' : null;
      return <article className="work-agent-card" key={task.id}>
        <div className="work-agent-card-header"><AgentAvatar name={agentName} id={task.agent_id ?? 'codex-worker'} size="sm" /><div><strong>{agentName}</strong><small>{agent?.config.title || 'Codex CLI'}</small></div></div>
        <button className="work-agent-card-task" onClick={() => onNavigate(`/scions/${task.scion_id}/${task.task_kind === 'research_public_web' ? 'research' : task.task_kind === 'prepare_capability_plan' ? 'tasks' : 'agent-work'}/${task.id}`)}><span><strong>{title}</strong><small>{scion?.revision.name ?? 'Scion'} · Revision {task.scion_revision}</small></span><WorkIcon name="arrow" /></button>
        <div className="work-agent-card-footer"><WorkStatus value={workflow.state === 'completed' ? 'review recorded' : workflow.state} /><time dateTime={task.completed_at ?? task.created_at}>{workTime(task.completed_at ?? task.created_at)}</time></div>
        {reviewNote && <p className="work-agent-review-note">{reviewNote}</p>}
      </article>;
    })}</div> : <Empty>No agent tasks recorded yet. Start a task in a Scion to prepare its first result.</Empty>}
  </section>;
}

export function WorkspacePage({ page, connection, onNavigate, canWrite }: { page: string; connection: ReturnType<typeof useWorkspace>; onNavigate: (route: string) => void; canWrite: boolean }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const { data, loading, error, refresh } = connection;
  if (!data) return <section className="work-page"><PageHeading title={pageNames[page] ?? 'Workspace'} description="Organization-scoped Grimoire state" />{loading ? <p role="status">Loading workspace…</p> : <div className="work-empty" role="alert"><h2>Workspace disconnected</h2><p>{error || 'Current access could not be checked. Records are hidden.'}</p><button className="button secondary" onClick={() => void refresh()}>Reconnect</button></div>}</section>;
  const scionName = (id: string) => data.scions.find(scion => scion.id === id)?.revision.name ?? 'Scion';
  const deliverablePath = (proposal: ProposalSummary) => {
    const task = data.tasks.find(item => item.scion_id === proposal.scion_id && item.proposal_id === proposal.id);
    return task && proposal.kind === 'capability_proposal' && data.scions.find(item => item.id === proposal.scion_id)?.revision.product_category === 'digital'
      ? `/scions/${task.scion_id}/tasks/${task.id}` : proposalPath(proposal);
  };
  const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase());
  const decisions = data.scions.filter(scion => !scion.revision.decision?.trim());
  const attention = data.scions.flatMap(scion => {
    const reviews = data.reviews.filter(review => review.scion_id === scion.id);
    const missingDecision = !scion.revision.decision?.trim();
    if (!reviews.length && !missingDecision) return [];
    return [{ id: scion.id, scionId: scion.id, priority: reviews.length ? 0 : 1,
      status: reviews.length ? 'review required' : 'decision required',
      text: reviews.length ? `${reviews.length} required reviews${missingDecision ? ' · Handler decision missing' : ''}` : 'Record what the Handler needs to decide.',
      route: `/scions/${scion.id}${reviews.length ? '/activity' : ''}` }];
  }).sort((first, second) => first.priority - second.priority);
  const active = data.tasks.filter(task => ['queued', 'dispatched', 'running', 'cancel_requested'].includes(task.status) && !task.blocked && !task.stale);
  const search = (label: string) => <label className="work-search"><WorkIcon name="search" /><input aria-label={label} placeholder={label} value={query} onChange={event => setQuery(event.target.value)} /></label>;
  const tabs = (options: [string, string][]) => <div className="work-filters" role="group" aria-label="Filter records">{options.map(([value, label]) => <button key={value} aria-pressed={filter === value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>;
  const scionRows = (scions: Scion[]) => <div className="work-list">{scions.map(scion => <button className="work-row" key={scion.id} onClick={() => onNavigate(`/scions/${scion.id}`)}><WorkIcon name="scions" /><span className="work-row-body"><strong>{scion.revision.name}</strong><small>{humanize(scion.revision.product_category)} · Revision {scion.current_revision}</small></span><WorkStatus value={!scion.revision.decision?.trim() ? 'decision required' : 'intake draft'} /><time>{workTime(scion.revision.created_at)}</time><WorkIcon name="arrow" /></button>)}</div>;
  const proposalRows = (proposals: ProposalSummary[]) => <div className="work-list">{proposals.map(proposal => <button className="work-row" key={proposal.id} onClick={() => onNavigate(deliverablePath(proposal))}><WorkIcon name="proposals" /><span className="work-row-body"><strong>{proposal.title}</strong><small>{scionName(proposal.scion_id)} · r{proposal.scion_revision}</small></span><WorkStatus value={proposal.status} /><time>{workTime(proposal.created_at)}</time><WorkIcon name="arrow" /></button>)}</div>;
  if (page === 'dashboard') return <section className="work-page work-dashboard">
    <PageHeading title="Dashboard" description="Your organization's Scions, proposed work, and decisions." />
    <div className="work-metrics">{[{ label: 'Needs your attention', count: decisions.length + data.reviews.length, target: 'inbox' }, { label: 'Recorded proposals', count: data.proposals.length, target: 'proposals' }, { label: 'Active agent work', count: active.length, target: 'tasks' }, { label: 'Scions', count: data.scions.length, target: 'scions' }].map(metric => <button key={metric.target} onClick={() => onNavigate(`/${metric.target}`)}><span>{metric.label}</span><strong>{metric.count}{metric.target === 'proposals' && metric.count >= data.collection_limit ? '+' : ''}</strong><WorkIcon name="arrow" /></button>)}</div>
    <RecentAgentWork data={data} onNavigate={onNavigate} />
    <div className="work-dashboard-attention">
      <section><div className="work-section-title"><h2>Needs attention</h2><button onClick={() => onNavigate('/inbox')}>Open inbox →</button></div>{attention.length ? attention.slice(0, 4).map(item => <button className="work-attention-row" key={item.id} onClick={() => onNavigate(item.route)}><WorkStatus value={item.status} /><strong>{scionName(item.scionId)}</strong><span>{item.text}</span></button>) : <Empty>No outstanding Handler decisions or watch reviews.</Empty>}</section>
    </div>
    <div className="work-section-title"><h2>Recent Scions</h2><button onClick={() => onNavigate('/scions')}>View all →</button></div>{data.scions.length ? scionRows(data.scions.slice(0, 5)) : <Empty>Create a Scion to start organizing a product decision. <button className="text-button" disabled={!canWrite} onClick={() => onNavigate('/new')}>New Scion</button></Empty>}
  </section>;
  if (page === 'scions' || page === 'search') {
    const found = data.scions.filter(scion => matches(`${scion.revision.name} ${scion.id}`));
    const proposals = data.proposals.filter(proposal => matches(`${proposal.title} ${scionName(proposal.scion_id)} ${proposal.id}`));
    return <section className="work-page"><PageHeading title={pageNames[page]} description={page === 'search' ? 'Find a Scion or proposal in this organization.' : 'One product decision per Scion. Open a record to work on it.'}>{page === 'scions' && <button className="button primary" disabled={!canWrite} onClick={() => onNavigate('/new')}>New Scion</button>}</PageHeading><div className="work-list-toolbar">{search(page === 'scions' ? 'Search Scions' : 'Search workspace')}<span className="work-muted">{found.length} Scions</span></div>{found.length ? scionRows(found) : <Empty>No matching Scions.</Empty>}{page === 'search' && query && <><div className="work-section-title"><h2>Proposals</h2></div>{proposals.length ? proposalRows(proposals) : <Empty>No matching proposals.</Empty>}</>}</section>;
  }
  if (page === 'proposals') {
    const proposals = data.proposals.filter(proposal => matches(`${proposal.title} ${scionName(proposal.scion_id)}`) && (filter === 'all' || proposal.status === filter));
    return <section className="work-page"><PageHeading title="Deliverables" description="Task results prepared for human review." /><div className="work-list-toolbar">{tabs([['all', 'All'], ['proposed', 'Needs review'], ['stale', 'Stale'], ['blocked', 'Blocked']])}{search('Search deliverables')}</div>{proposals.length ? proposalRows(proposals) : <Empty>No deliverables in this view. Start a planning task in a Scion.</Empty>}<CollectionNote count={data.proposals.length} limit={data.collection_limit} /></section>;
  }
  if (page === 'inbox') return <section className="work-page"><PageHeading title="Inbox" description="Human decisions and review obligations. No automated approvals." /><h2 className="work-group-heading">Handler decisions <span>{decisions.length}</span></h2>{decisions.length ? scionRows(decisions) : <Empty>No missing Handler decisions.</Empty>}<h2 className="work-group-heading">Watchtower reviews <span>{data.reviews.length}</span></h2>{data.reviews.length ? <div className="work-list">{data.reviews.map(review => <button className="work-row" key={review.id} onClick={() => onNavigate(`/scions/${review.scion_id}/activity/${review.id}`)}><WorkIcon name="inbox" /><span className="work-row-body"><strong>{scionName(review.scion_id)}</strong><small>{review.reason}</small></span><WorkStatus value={review.status} /><time>{workTime(review.created_at)}</time><WorkIcon name="arrow" /></button>)}</div> : <Empty>No watch-generated reviews. Scion decision gates still apply.</Empty>}<CollectionNote count={data.reviews.length} limit={data.collection_limit} /></section>;
  if (page === 'tasks') {
    return <TaskDirectory data={data} canWrite={canWrite} onNavigate={onNavigate} />;
  }
  if (page === 'watchtower') return <section className="work-page"><PageHeading title="Watchtower" description="Persisted internal monitoring. Server checks continue when this page is closed." /><div className="work-list-toolbar">{search('Filter watched Scions')}<span className="work-muted">3 internal watches per Scion</span></div><div className="work-list">{data.scions.filter(scion => matches(scion.revision.name)).map(scion => {
    const watches = data.watches.filter(watch => watch.scion_id === scion.id); const checked = watches.map(watch => watch.last_successful_check).filter((value): value is string => Boolean(value)).sort();
    const status = watches.length !== 3 || checked.length !== 3 ? 'pending' : watches.every(watch => watch.status === 'healthy') ? 'healthy' : 'delayed';
    return <details className="work-watch" key={scion.id}><summary><WorkIcon name="watchtower" /><strong>{scion.revision.name}</strong><WorkStatus value={status} /><span>Checked {workTime(checked.length === 3 ? checked[0] : null)}</span></summary><div className="work-watch-detail">{watches.map(watch => <div key={watch.id}><span>{humanize(watch.kind)}</span><WorkStatus value={watch.status} /><time>{workTime(watch.last_successful_check)}</time></div>)}<button className="text-button" onClick={() => onNavigate(`/scions/${scion.id}/activity`)}>Open Scion activity →</button></div></details>;
  })}</div>{!data.scions.length && <Empty>No Scions are being watched yet.</Empty>}<p className="work-muted work-endnote">External monitoring is unavailable until an authorized connector implements it. No vendor checks are simulated.</p></section>;

  if (page === 'connectors') {
    const connectors = data.connectors.filter(connector => matches(`${connector.name} ${connector.description}`));
    const external = matches('External provider connector No authorized provider or monitoring implementation configured');
    return <section className="work-page"><PageHeading title="Connectors" description="Evidence sources available to this organization."><button className="button secondary" onClick={() => onNavigate('/settings/runtime')}>Runtime settings</button></PageHeading><div className="work-list-toolbar">{search('Search connectors')}<span className="work-muted">{data.connectors.length} internal sources</span></div><div className="work-connectors">{connectors.map(connector => <article className="work-connector" key={connector.id}><span className="work-connector-icon"><WorkIcon name="connectors" /></span><div><h2>{connector.name}</h2><p>{connector.description}</p></div><WorkStatus value={connector.status} /></article>)}{external && <article className="work-connector"><span className="work-connector-icon"><WorkIcon name="connectors" /></span><div><h2>External provider connector</h2><p>No authorized provider or monitoring implementation configured.</p></div><WorkStatus value="unavailable" /></article>}{!connectors.length && !external && <Empty>No matching connectors.</Empty>}</div></section>;
  }
  return <section className="work-page"><PageHeading title="Activity" description="Auditable internal watch events. Source content is never included here." /><div className="work-list-toolbar">{search('Filter activity')}<span className="work-muted">Newest first</span></div>{data.events.filter(event => matches(`${event.kind} ${scionName(event.scion_id)}`)).map(event => <div className="work-audit-row" key={event.id}><WorkIcon name="audit" /><div><strong>{humanize(event.kind)}</strong><button className="work-link" onClick={() => onNavigate(`/scions/${event.scion_id}/activity`)}>{scionName(event.scion_id)}</button><p>{event.summary}</p><details><summary>Audit reference</summary><code>{event.event_key}</code></details></div><time>{workTime(event.recorded_at)}</time></div>)}{data.events.length === 0 && <Empty>No watch events have been recorded.</Empty>}<CollectionNote count={data.events.length} limit={data.collection_limit} /></section>;
}

export function ScionOverview({ scion, connection, onOpen, onEdit, canWrite }: { scion: Scion; connection: ControlSurfaceConnection; onOpen: (view: string, id?: string) => void; onEdit: () => void; canWrite: boolean }) {
  const { data, error, loading } = connection;
  const proposal = data?.nodes.find(node => node.kind === 'capability_proposal');
  const tasks = data?.operations.tasks.filter(task => ['queued', 'dispatched', 'running', 'cancel_requested'].includes(task.status));
  const sourceNodes = data?.nodes.filter(node => node.kind === 'evidence_source') ?? [];
  return <div className="scion-overview"><div className="scion-story"><section className="scion-brief"><h2>Brief</h2><p>{scion.revision.product_description || 'Describe the product so proposed work has a clear starting point.'}</p></section><section className="scion-decision"><div><WorkStatus value={scion.revision.decision?.trim() ? 'handler provided' : 'decision required'} /><h2>{scion.revision.decision?.trim() ? 'The decision' : 'What do you need to decide?'}</h2><p>{scion.revision.decision || 'Give this Scion a specific decision. Agent work can prepare evidence, but it cannot decide for you.'}</p></div><button className="button secondary" disabled={!canWrite} onClick={onEdit}>{scion.revision.decision ? 'Edit brief' : 'Set decision'} <WorkIcon name="arrow" /></button></section>
    {scion.revision.product_category !== 'digital' && <section><div className="work-section-title"><h2>Physical workflow</h2></div><button className="work-property-link" onClick={() => onOpen('scope')}>Physical scope and engineering review →</button><button className="work-property-link" onClick={() => onOpen('offers')}>Supplier offers and comparison →</button></section>}
    <section><div className="work-section-title"><h2>Latest proposal</h2><button onClick={() => onOpen('proposals')}>View proposals →</button></div>{!data ? <p className="work-muted" role={error ? 'alert' : 'status'}>{loading ? 'Checking current case state…' : 'Case disconnected. Proposal and source state are hidden until rechecked.'}</p> : proposal ? <button className="work-proposal-preview" onClick={() => onOpen('proposals', proposal.id.replace(/^plan:/, ''))}><WorkIcon name="proposals" /><span><strong>Capability plan</strong><small>Prepared by agent · Revision {String(proposal.provenance.scion_revision)}</small></span><WorkStatus value={proposal.stale && proposal.status !== 'blocked' ? 'stale' : proposal.status === 'current' ? 'proposed' : proposal.status} /><WorkIcon name="arrow" /></button> : <Empty>No capability proposal yet. <button className="text-button" onClick={() => onOpen('agent-work')}>Prepare with Codex →</button></Empty>}</section>
    <section><div className="work-section-title"><h2>Evidence</h2><button onClick={() => onOpen('sources')}>Open sources →</button></div>{sourceNodes.length ? sourceNodes.slice(0, 4).map(source => <button className="work-row" key={source.id} onClick={() => onOpen('sources')}><WorkIcon name="connectors" /><span className="work-row-body"><strong>{source.title}</strong><small>Internal Scion source</small></span><WorkStatus value={source.status} /></button>) : <p className="work-muted">{data ? 'No internal sources recorded.' : 'Current source access is not available.'}</p>}</section>
  </div><aside className="scion-properties"><h2>Properties</h2><dl><div><dt>Status</dt><dd><WorkStatus value="intake draft" /></dd></div><div><dt>Product</dt><dd>{humanize(scion.revision.product_category)}</dd></div><div><dt>Revision</dt><dd>{scion.current_revision}</dd></div><div><dt>Human review</dt><dd>Required · no approval</dd></div><div><dt>Agent work</dt><dd><button onClick={() => onOpen('agent-work')}>{data ? `${tasks?.length ?? 0} active tasks` : 'Unavailable'}</button></dd></div><div><dt>Monitoring</dt><dd><WorkStatus value={data?.watchtower.health ?? (loading ? 'checking' : 'disconnected')} /></dd></div><div><dt>Last checked</dt><dd>{data ? workTime(data.watchtower.last_successful_check) : 'Not available'}</dd></div></dl><button className="work-property-link" onClick={() => onOpen('graph')}>View dependency graph <WorkIcon name="arrow" /></button><details className="work-disclosure"><summary>Missing information · {scion.missing_information.length}</summary><ul>{scion.missing_information.map(gap => <li key={gap.field}>{gap.message}</li>)}</ul></details><details className="work-disclosure"><summary>Record identity</summary><code>{scion.id}</code></details></aside></div>;
}

export function ScionActivity({ connection, onOpenTask }: { connection: ControlSurfaceConnection; onOpenTask?: (id: string) => void }) {
  const { data, error, loading } = connection;
  if (!data) return <Empty>{loading ? 'Checking activity…' : error || 'Case disconnected.'}</Empty>;
  const affected = (subject: string) => {
    const direct = data.operations.tasks.filter(task => task.id === subject || task.proposal_id === subject);
    if (direct.length) return direct;
    if (subject === data.scion_id) return data.operations.tasks.filter(task => task.stale);
    const targets = data.edges.filter(edge => edge.source === `source:${subject}`).map(edge => edge.target);
    return data.operations.tasks.filter(task => targets.includes(`task:${task.id}`) || targets.includes(`plan:${task.proposal_id}`));
  };
  return <section className="work-case-activity">
    <div className="work-section-title"><h2>Watchtower activity</h2><WorkStatus value={data.watchtower.health} /></div>
    <p className="work-muted">Last server check {workTime(data.watchtower.last_successful_check)}</p>
    {data.operations.events.map(event => <div className="work-audit-row" key={event.id}><WorkIcon name="audit" /><div><strong>{humanize(event.kind)}</strong><p>{event.summary}</p>
      {onOpenTask && affected(event.subject_id).map(task => <button className="work-link" key={task.id} onClick={() => onOpenTask(task.id)}>Open affected task · revision {task.scion_revision} →</button>)}
      <details><summary>Audit reference</summary><code>{event.event_key}</code></details></div><time>{workTime(event.recorded_at)}</time></div>)}
    {!data.operations.events.length && <Empty>No watch events recorded.</Empty>}
    <details className="work-disclosure"><summary>Required watch reviews · {data.operations.human_review.length}</summary>{data.operations.human_review.map(review => <div className="work-audit-row" key={review.id}><WorkStatus value={review.status} /><p>{review.reason}</p><time>{workTime(review.created_at)}</time></div>)}</details>
  </section>;
}
