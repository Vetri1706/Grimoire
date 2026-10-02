import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { request, organizationSession, SESSION_AUTH, type SessionState } from './api';
import { useTheme, type ThemePreference } from './theme';
import type { WorkspaceState } from './workspace-api';
import './settings.css';
import { WorkerConnections } from './WorkerConnections';
import { WorkIcon } from './Workbench';
import { useLayoutPreferences } from './LayoutPreferences';
import LayoutResizeHandle from './LayoutResizeHandle';
import { layoutLimits } from './layout-preferences';
import type { InspectorDock } from './layout-preferences';

type SettingsProps = {
  session: SessionState;
  connection: { data: WorkspaceState | null; loading: boolean; error: string; refresh: () => Promise<void> };
  route: string;
  onSession: (session: SessionState) => void;
  onSwitchOrganization: (id: string) => void;
  onCreateOrganization: () => void;
  onNavigate: (path: string) => void;
  onBack: () => void;
  onDisconnect: () => void;
  onDirty: (dirty: boolean) => void;
  feedback?: ReactNode;
  busy?: boolean;
};

const sections = [['account', 'Account'], ['organization', 'Organization'], ['appearance', 'Appearance'], ['runtime', 'Runtime'], ['about', 'Guide & about']] as const;
function Fact({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? 'settings-mono' : undefined}>{children}</dd></div>;
}
const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'Never reported';

export function Settings({ session, connection, route, onSession, onSwitchOrganization, onCreateOrganization, onNavigate, onBack, onDisconnect, onDirty, feedback, busy = false }: SettingsProps) {
  const layout = useLayoutPreferences();
  const [layoutNotice, setLayoutNotice] = useState('');
  const section = route.startsWith('/profile') ? 'account' : route.split('/')[2] || 'account';
  const editing = route === '/profile/edit';
  const { theme, changeTheme } = useTheme();
  const [name, setName] = useState(session.handler.display_name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const context = `${route}:${session.handler.identity_id}:${session.active_organization?.org_id || ''}`;
  const currentContext = useRef(context);
  const pendingSave = useRef<AbortController | null>(null);
  currentContext.current = context;
  const dirty = editing && name !== session.handler.display_name;
  useEffect(() => { setName(session.handler.display_name); setError(''); }, [session.handler.identity_id, session.handler.display_name, editing]);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  useEffect(() => { setSaving(false); return () => { pendingSave.current?.abort(); pendingSave.current = null; }; }, [context]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setError(''); setNotice('');
    const controller = new AbortController();
    pendingSave.current = controller;
    const submittedContext = context;
    const current = () => !controller.signal.aborted && currentContext.current === submittedContext && pendingSave.current === controller;
    try {
      const next = await request<SessionState>(SESSION_AUTH, '/session/profile', { method: 'POST', body: JSON.stringify({ display_name: name.trim() }), signal: controller.signal });
      if (!current()) return;
      setName(next.handler.display_name); onDirty(false); onSession(next); setNotice('Profile saved.');
    } catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : 'Your profile could not be saved.'); }
    finally { if (current()) { setSaving(false); pendingSave.current = null; } }
  }
  const active = session.active_organization;
  const data = connection.data;
  const initials = session.handler.display_name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase();
  const sectionIcons: Record<string, string> = { account: 'profile', organization: 'agents', appearance: 'sun', runtime: 'runtime', about: 'instructions' };
  return <div className="settings-app">
    <a className="settings-skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to settings content</a>
    <div className="settings-layout">
      <aside className="settings-sidebar" aria-label="Settings workspace">
        <LayoutResizeHandle label="Resize settings navigation" value={layout.sidebarWidth} min={layoutLimits.sidebar.min} max={layoutLimits.sidebar.max} initial={layoutLimits.sidebar.initial} onChange={layout.setSidebarWidth} className="layout-sidebar-resize" />
        <div className="settings-sidebar-header"><button type="button" className="settings-back" onClick={onBack}><span aria-hidden="true">←</span>Back to workspace</button></div>
        <nav className="settings-navigation" aria-label="Settings">
          <span className="settings-nav-label">Settings</span>
          {sections.map(([key, label]) => <button key={key} type="button" aria-current={section === key ? 'page' : undefined} onClick={() => onNavigate(`/settings/${key}`)}><WorkIcon name={sectionIcons[key]} /><span>{label}</span></button>)}
        </nav>
        <div className="settings-sidebar-footer"><div className="settings-sidebar-identity"><span className="settings-sidebar-avatar" aria-hidden="true">{initials}</span><div><strong>{session.handler.display_name}</strong><span>Handler account</span></div></div><button type="button" className="settings-signout" disabled={busy} onClick={onDisconnect}><WorkIcon name="exit" /><span>{busy ? 'Signing out…' : 'Sign out'}</span></button></div>
      </aside>
      <div className="settings-workspace">
        <header className="settings-topbar"><nav aria-label="Settings breadcrumb"><span>{active?.organization_name || 'Grimoire'}</span><span aria-hidden="true">›</span><strong>Settings</strong></nav></header>
        <main className="settings-scroll" id="main-content" tabIndex={-1}><div className="settings-content">
      {feedback}
      {section === 'account' && <>
        <header className="settings-heading"><div><h1>{editing ? 'Edit profile' : 'Your profile'}</h1><p>Your Handler identity across your Grimoire organizations.</p></div>{!editing && <button className="button secondary" type="button" onClick={() => onNavigate('/profile/edit')}>Edit profile</button>}</header>
        <section className="settings-profile-summary"><span className="settings-avatar" aria-hidden="true">{session.handler.display_name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase()}</span><div><h2>{session.handler.display_name}</h2><p>Handler · {session.organizations.length} {session.organizations.length === 1 ? 'organization' : 'organizations'}</p></div></section>
        {editing ? <form className="settings-form" onSubmit={save} aria-label="Edit profile">
          <label htmlFor="profile-display-name">Display name</label><input id="profile-display-name" name="display_name" value={name} onChange={event => { setName(event.target.value); setNotice(''); }} required maxLength={120} autoComplete="name" disabled={saving} aria-describedby="profile-name-hint" />
          <p id="profile-name-hint">This is the name shown beside your work. Your sign-in identity and permissions stay the same.</p>
          {error && <p className="error-message" role="alert">{error}</p>}{notice && <p className="settings-notice" role="status">{notice}</p>}
          <div className="settings-actions"><button className="button secondary" type="button" disabled={saving} onClick={() => onNavigate('/profile')}>Back to profile</button><button className="button primary" type="submit" disabled={!dirty || !name.trim() || saving}>{saving ? 'Saving…' : 'Save changes'}</button></div>
        </form> : <dl className="settings-facts"><Fact label="Display name">{session.handler.display_name}</Fact><Fact label="Account identifier" mono>{session.handler.identity_id}</Fact><Fact label="Installation access">{session.handler.installation_owner ? 'Installation owner' : 'Handler'}</Fact><Fact label="Current organization">{active?.organization_name || 'No organization selected'}</Fact></dl>}
      </>}
      {section === 'organization' && <>
        <header className="settings-heading"><div><h1>Organization</h1><p>Choose where you work. Each organization keeps its own Scions, agents, and evidence.</p></div><button className="button secondary" type="button" disabled={busy} onClick={onCreateOrganization}>New organization</button></header>
        <section className="settings-section"><h2>Your organizations</h2><div className="settings-organization-list">{session.organizations.map(org => <div className="settings-organization" key={org.org_id}><span className="settings-org-mark" aria-hidden="true">{Array.from(org.organization_name)[0]?.toUpperCase()}</span><div><strong>{org.organization_name}</strong><p>Joined {new Date(org.joined_at).toLocaleDateString()}</p></div>{org.org_id === active?.org_id ? <span className="settings-status">Current</span> : <button className="button secondary" type="button" disabled={busy} onClick={() => onSwitchOrganization(org.org_id)}>Open</button>}</div>)}</div></section>
        {active && <section className="settings-section"><h2>Access in {active.organization_name}</h2><dl className="settings-facts"><Fact label="Workspace management">{active.can_manage_workspace ? 'Allowed' : 'Not granted'}</Fact><Fact label="Digital preparation">{active.can_prepare_workspace ? 'Allowed' : 'Not granted'}</Fact><Fact label="Physical / supplier preparation">{active.can_write ? 'Allowed' : 'Not granted'}</Fact><Fact label="Physical scope proposal">{active.can_propose_scope ? 'Allowed' : 'Not granted'}</Fact><Fact label="Physical scope confirmation">{active.can_confirm_scope ? 'Allowed' : 'Not granted'}</Fact><Fact label="Organization ID" mono>{active.org_id}</Fact></dl><p className="settings-footnote">Organization membership does not itself grant engineering, sourcing, commercial, or approval authority.</p></section>}
      </>}
      {section === 'appearance' && <>
        <header className="settings-heading"><div><h1>Appearance</h1><p>Choose the look of Grimoire on this browser.</p></div></header>
        <fieldset className="settings-theme-options"><legend>Color theme</legend>{([['light', 'Pearl', 'A clear, bright workspace.'], ['dark', 'Midnight Blue', 'Deep blue with crisp, bright text.'], ['system', 'System', 'Follow your device appearance.']] as [ThemePreference, string, string][]).map(([value, label, description]) => <label key={value} className="settings-theme-option" data-selected={theme === value}><input type="radio" name="settings-theme" value={value} checked={theme === value} onChange={() => changeTheme(value)} /><span className={`settings-theme-preview settings-theme-${value}`} aria-hidden="true"><i /><i /><i /></span><span><strong>{label}</strong><span>{description}</span></span></label>)}</fieldset>
        <p className="settings-footnote">Saved automatically in this browser. Grimoire also respects your device’s reduced-motion preference.</p>
        <section className="settings-section"><h2>Workspace layout</h2><p>Set your desktop panel widths and placement. Your layout is saved for this account and organization on this browser.</p>
          <div className="settings-layout-controls">
            <label className="settings-layout-control"><span>Navigation width <output>{layout.sidebarWidth}px</output></span><input type="range" min={layoutLimits.sidebar.min} max={layoutLimits.sidebar.max} step="1" aria-label="Navigation width" value={layout.sidebarWidth} onChange={event => { setLayoutNotice(''); layout.setSidebarWidth(Number(event.target.value)); }} /></label>
            <label className="settings-layout-control"><span>Task panel width <output>{layout.inspectorWidth}px</output></span><input type="range" min={layoutLimits.inspector.min} max={layoutLimits.inspector.max} step="1" aria-label="Task panel width" value={layout.inspectorWidth} onChange={event => { setLayoutNotice(''); layout.setInspectorWidth(Number(event.target.value)); }} /></label>
            <label className="settings-layout-control"><span>Task panel placement</span><select aria-label="Task panel placement" value={layout.inspectorDock} onChange={event => { setLayoutNotice(''); layout.setInspectorDock(event.target.value as InspectorDock); }}><option value="right">Right</option><option value="left">Left</option><option value="hidden">Hidden</option></select></label>
          </div>
          <p className="settings-footnote">On narrow screens, panels stack and navigation uses a drawer.</p>
          <div className="settings-layout-reset"><button type="button" className="button secondary" onClick={() => { layout.resetLayout(); setLayoutNotice('Default layout restored.'); }}>Reset workspace layout</button><span role="status">{layoutNotice}</span></div>
        </section>
      </>}
      {section === 'runtime' && <>
        <header className="settings-heading"><div><h1>Runtime</h1><p>Your agent connections and workspace health.</p></div><button className="button secondary" type="button" onClick={() => void connection.refresh()} disabled={connection.loading}>Refresh</button></header>
        {connection.error && <p className="error-message" role="alert">{connection.error}</p>}
        <WorkerConnections key={active?.org_id} token={active ? organizationSession(active.org_id) : ''} principal={active} />
        <div className="settings-links"><button type="button" onClick={() => onNavigate('/agents')}>Manage agents →</button><button type="button" onClick={() => onNavigate('/tasks')}>View agent work →</button></div>
        <section className="settings-section worker-runtime-health"><details><summary>Workspace health <span>{data ? 'API connected' : connection.loading ? 'Checking…' : 'API disconnected'}</span></summary><dl className="settings-facts"><Fact label="Last successful refresh">{data ? date(data.generated_at) : 'Awaiting a successful check'}</Fact><Fact label="Display refresh">Authenticated polling while this page is visible</Fact><Fact label="Organization worker">{data ? data.agent_runtime.status === 'connected' ? 'Online' : 'Offline' : 'Unknown — workspace unavailable'}</Fact><Fact label="Last heartbeat">{data ? date(data.agent_runtime.last_seen) : 'Unavailable'}</Fact><Fact label="Concurrent tasks">{data ? data.agent_runtime.concurrency : 'Unavailable'}</Fact></dl></details></section>
        <section className="settings-section"><h2>Watchtower</h2><p>Internal checks and watch state are persisted by Grimoire. Page refreshes display their results; they do not provide continuous monitoring.</p><div className="settings-links"><button type="button" onClick={() => onNavigate('/watchtower')}>View watches and last checks →</button><button type="button" onClick={() => onNavigate('/connectors')}>Inspect connector availability →</button></div></section>
      </>}
      {section === 'about' && <>
        <header className="settings-heading"><div><h1>Guide & about</h1><p>A short guide to your Grimoire workspace.</p></div><a className="button secondary" href="/demo" target="_blank" rel="noreferrer">Explore judge demo ↗</a></header>
        <section className="settings-section"><h2>Start with a Scion</h2><p>Give your product decision a name. Add the requirements and questions you already know; missing information can remain open. Each saved change creates a revision.</p><div className="settings-links"><button type="button" onClick={() => onNavigate('/scions')}>Open Scions →</button></div></section>
        <section className="settings-section"><h2>Connect evidence, then prepare a plan</h2><p>The case graph shows sources, proposed work, and review gates. A changed revision can make a plan stale. Revoked evidence is withheld and dependent work is blocked until reviewed.</p><div className="settings-links"><button type="button" onClick={() => onNavigate('/proposals')}>Review proposals →</button></div></section>
        <section className="settings-section"><h2>Keep the human decision visible</h2><p>An agent completing a task creates a result to review. It does not approve a proposal or replace a Handler decision. Your Inbox shows the work that still needs a human.</p><div className="settings-links"><button type="button" onClick={() => onNavigate('/inbox')}>Open Inbox →</button></div></section>
        <section className="settings-section"><h2>Grimoire</h2><p>Native agents, organization-scoped PostgreSQL records, persistent watches, and human review in one workspace.</p><dl className="settings-facts"><Fact label="Signed in as">{session.handler.display_name}</Fact><Fact label="Workspace">{active?.organization_name || 'No organization selected'}</Fact></dl></section>
      </>}
        </div></main>
      </div>
    </div>
  </div>;
}
