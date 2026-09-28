import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiError, request } from './api';
import Evidence from './Evidence';
import PhysicalScope from './PhysicalScope';
import Offers from './Offers';
import DirectionalFlow from './DirectionalFlow';
import { parseFlowRoute, scionIdFromRoute } from './flow-model';
import type { Category, Intake, Principal, Revision, RevisionHistory, Scion } from './api';

type IconName = 'book' | 'plus' | 'arrow' | 'history' | 'file' | 'check' | 'search' | 'lock' | 'edit' | 'alert' | 'logout' | 'sun' | 'moon' | 'monitor' | 'layers' | 'columns';
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
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" /></>,
    moon: <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" />,
    monitor: <><rect x="3" y="3" width="18" height="13" rx="2" /><path d="M12 16v5M8 21h8" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
    columns: <><rect x="3" y="4" width="7" height="16" rx="1" /><rect x="14" y="4" width="7" height="16" rx="1" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
const storageKey = 'grimoire.local-handler-token';
const date = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const category = (value: Category) => value === 'unspecified' ? 'Category missing' : value === 'digital' ? 'Digital product' : 'Physical product';
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The request failed. Please retry.';
const routeFromHash = () => window.location.hash.replace(/^#/, '') || '/';
const enteredFieldCount = (revision: Intake) => [Boolean(revision.product_description?.trim()), revision.product_category !== 'unspecified', Boolean(revision.decision?.trim()), revision.requirements !== null, revision.questions !== null].filter(Boolean).length;

type ThemePreference = 'system' | 'dark' | 'light';
type ThemeControl = { theme: ThemePreference; onChangeTheme: (theme: ThemePreference) => void };
const themeKey = 'grimoire.theme-preference';
const parseTheme = (value: string | null | undefined): ThemePreference => value === 'light' || value === 'dark' ? value : 'system';
function ThemePicker({ theme, onChangeTheme }: ThemeControl) {
  return <label className="theme-picker"><Icon name={theme === 'system' ? 'monitor' : theme === 'dark' ? 'moon' : 'sun'} size={18} /><select aria-label="Appearance" value={theme} onChange={event => onChangeTheme(parseTheme(event.target.value))}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>;
}

function Connection({ onConnect, theme, onChangeTheme }: ThemeControl & { onConnect: (token: string, principal: Principal) => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function connect(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const principal = await request<Principal>(token.trim(), '/me');
      onConnect(token.trim(), principal);
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  }
  return <main className="connection-page">
    <div className="connection-brand"><span className="brand-icon"><Icon name="book" size={27} /></span><span>GRIMOIRE</span><span className="local-tag">LOCAL WORKSPACE</span><ThemePicker theme={theme} onChangeTheme={onChangeTheme} /></div>
    <div className="connection-layout">
      <section className="connection-intro"><p className="eyebrow">A considered beginning</p><h1>Every decision starts<br />with what you know.</h1><p>Create a Scion. Capture the product, make the gaps visible, and keep a record of how the understanding changes.</p><div className="intro-note"><Icon name="history" /><span>One case record.<br /><strong>Every revision preserved.</strong></span></div></section>
      <form className="connection-card" onSubmit={connect}><span className="subtle-icon"><Icon name="lock" size={24} /></span><h2>Open your workspace</h2><p>Use your local Handler token to access your organization’s Scions.</p><label htmlFor="token">Handler access token</label><input id="token" type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" required autoFocus placeholder="Paste your local token" />{error && <ErrorMessage>{error}</ErrorMessage>}<button className="button primary full" disabled={!token.trim() || busy}>{busy ? 'Connecting…' : 'Open workspace'}<Icon name="arrow" size={18} /></button><p className="connection-footnote">Your token stays in this browser tab’s session. The API checks your organization access.</p></form>
    </div><footer className="connection-footer">SCION INTAKE <span>Local development · Layer 1</span></footer>
  </main>;
}

export default function App() {
  const [theme, setTheme] = useState<ThemePreference>(() => parseTheme(document.documentElement.dataset.themePreference));
  const [token, setToken] = useState(() => sessionStorage.getItem(storageKey) ?? '');
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [route, setRoute] = useState(routeFromHash);
  const [scions, setScions] = useState<Scion[]>([]);
  const [selected, setSelected] = useState<Scion | null>(null);
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState('');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationPanel = useRef<HTMLElement>(null);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const dirty = useRef(false);
  const routeRef = useRef(route);
  const id = scionIdFromRoute(route);
  const routeLabel = route === '/new' ? 'New case' : id ? ({ context: 'Case context', scope: 'Exact scope', comparison: 'Offer comparison', 'decision-new': 'Record decision', decision: 'Decision', change: 'Change impact', review: 'Review task', history: 'Revision history', sources: 'Sources and claims', 'scope-workbench': 'Scope workbench', 'offers-workbench': 'Offer workbench', unknown: 'Case' } as const)[parseFlowRoute(route).kind] : 'Cases';
  const canWrite = principal?.can_write !== false;

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.dataset.themePreference = theme;
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#171717' : '#ffffff');
    };
    apply();
    if (theme !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === themeKey || event.key === null) setTheme(parseTheme(event.newValue)); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  function changeTheme(value: ThemePreference) {
    setTheme(value);
    try { localStorage.setItem(themeKey, value); } catch { /* Still applies for this visit. */ }
  }

  useEffect(() => {
    const change = () => {
      const next = routeFromHash();
      if (next === routeRef.current) return;
      if (dirty.current && !window.confirm('Leave this edit? Your unsaved changes will be lost.')) {
        window.history.replaceState(null, '', `#${routeRef.current}`); return;
      }
      dirty.current = false; routeRef.current = next; setRoute(next); setEdit(false); setNotice(''); setNavigationOpen(false);
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, []);
  useEffect(() => {
    if (!navigationOpen) return;
    const panel = navigationPanel.current;
    const focusable = () => [...(panel?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled)') ?? [])];
    window.requestAnimationFrame(() => focusable()[0]?.focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setNavigationOpen(false); window.requestAnimationFrame(() => navigationTrigger.current?.focus()); return; }
      if (event.key !== 'Tab') return;
      const items = focusable(); if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [navigationOpen]);
  useEffect(() => {
    if (!token) return;
    let active = true;
    request<Principal>(token, '/me').then(value => { if (active) setPrincipal(value); }).catch(failure => {
      if (active) { setError(errorText(failure)); sessionStorage.removeItem(storageKey); setToken(''); }
    });
    return () => { active = false; };
  }, [token]);
  useEffect(() => {
    if (!token || !principal) return;
    let active = true; setListLoading(true);
    request<{ scions: Scion[] }>(token, '/scions').then(value => { if (active) setScions(value.scions); }).catch(failure => { if (active) setError(errorText(failure)); }).finally(() => { if (active) setListLoading(false); });
    return () => { active = false; };
  }, [token, principal, refresh]);
  useEffect(() => {
    setError(''); setSelected(null);
    if (!id || !token || !principal) { setLoading(false); return; }
    let active = true; setLoading(true);
    request<Scion>(token, `/scions/${encodeURIComponent(id)}`).then(value => { if (active) setSelected(value); }).catch(failure => { if (active) setError(errorText(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, token, principal, refresh]);
  const setDirty = useCallback((value: boolean) => { dirty.current = value; }, []);
  function navigate(next: string) { window.location.hash = next; }
  function disconnect() {
    if (dirty.current && !window.confirm('Disconnect and discard this unsaved edit?')) return;
    dirty.current = false; sessionStorage.removeItem(storageKey); setToken(''); setPrincipal(null); setScions([]); setSelected(null); setEdit(false); setError('');
  }
  function saved(scion: Scion) {
    dirty.current = false; setEdit(false); setSelected(scion); setRefresh(value => value + 1);
    navigate(`/scions/${scion.id}`);
    setNotice(`Revision ${scion.current_revision} saved. The case record is up to date.`);
  }
  if (!token) return <Connection theme={theme} onChangeTheme={changeTheme} onConnect={(value, identity) => { sessionStorage.setItem(storageKey, value); setToken(value); setPrincipal(identity); setError(''); }} />;
  if (!principal) return <div className="boot-state" role="status"><Icon name="book" size={34} /><p>Opening your workspace…</p></div>;
  return <div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to content</a>
    {navigationOpen && <button className="navigation-backdrop" type="button" aria-label="Close navigation" onClick={() => setNavigationOpen(false)} />}
    <aside ref={navigationPanel} className={`sidebar ${navigationOpen ? 'open' : ''}`} aria-label="Workspace navigation" role={navigationOpen ? 'dialog' : undefined} aria-modal={navigationOpen || undefined}>
      <button className="brand" onClick={() => navigate('/')} aria-label="Grimoire home"><span className="brand-icon"><Icon name="book" size={25} /></span><span>GRIMOIRE<small>THE CASE WORKSPACE</small></span></button>
      <p className="organization-label">{principal.organization_name}</p>
      <p className="nav-label">WORKSPACE</p><nav aria-label="Main navigation"><button className={`nav-item ${route !== '/new' ? 'active' : ''}`} onClick={() => navigate('/')}><Icon name="file" /><span>Cases</span><span className="nav-count">{scions.length}</span></button></nav>
      <div className="identity"><span className="avatar">{principal.display_name?.charAt(0) || 'H'}</span><span><strong>{principal.display_name}</strong><small>Handler</small></span><button className="icon-button" onClick={disconnect} aria-label="Disconnect workspace" title="Disconnect"><Icon name="logout" size={18} /></button></div>
    </aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumb"><button ref={navigationTrigger} className="navigation-toggle" type="button" onClick={() => setNavigationOpen(true)} aria-label="Open navigation" aria-expanded={navigationOpen}>☰</button><button onClick={() => navigate('/')}>Cases</button>{id && <><span>/</span><button onClick={() => navigate(`/scions/${id}/context`)}>{selected?.revision.name ?? 'Case'}</button></>}{route !== '/' && <><span>/</span><span>{routeLabel}</span></>}</div><div className="topbar-actions"><span className="environment"><span />Local development</span><ThemePicker theme={theme} onChangeTheme={changeTheme} /></div></header><main id="main-content" tabIndex={-1}>
      {!canWrite && <div className="info-notice"><Icon name="lock" size={18} /><p>This identity has read-only access. A Handler must create and revise Scion intakes.</p></div>}{notice && <div className="success-notice" role="status"><Icon name="check" size={18} />{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notification">×</button></div>}
      {error && <ErrorMessage>{error}<button className="text-button" onClick={() => setRefresh(value => value + 1)}>Retry</button></ErrorMessage>}
      {loading ? <div className="loading-panel" role="status">Loading the case record…</div> : route === '/new' ? !canWrite ? <ErrorMessage>A Handler identity is required to create a Scion.</ErrorMessage> : <IntakeForm token={token} onSaved={saved} onCancel={() => navigate('/')} onDirty={setDirty} /> : selected && id ? edit ? <IntakeForm key={`${selected.id}-edit`} token={token} scion={selected} onSaved={saved} onDirty={setDirty} onCancel={() => { if (!dirty.current || window.confirm('Discard this unsaved revision?')) { dirty.current = false; setEdit(false); } }} /> : <CaseRecord key={selected.id} token={token} scion={selected} route={route} navigate={navigate} principalId={principal.principal_id} canWrite={canWrite} onDirty={setDirty} onEdit={() => setEdit(true)} /> : !id ? <ScionList scions={scions} canWrite={canWrite} loading={listLoading} onOpen={value => navigate(`/scions/${value}/context`)} onNew={() => navigate('/new')} /> : !error && <div className="loading-panel">Choose a case to open its record.</div>}
    </main><footer className="workspace-footer"><span>GRIMOIRE <b>·</b> SCION INTAKE</span><span>Facts first. Decisions remain with the Handler.</span></footer></div>
  </div>;
}

function ErrorMessage({ children }: { children: ReactNode }) { return <div className="error-message" role="alert"><Icon name="alert" size={19} /><div>{children}</div></div>; }
function IntakeCoverage({ revision }: { revision: Intake }) {
  const count = enteredFieldCount(revision);
  const questions = revision.questions === null
    ? 'Questions not assessed'
    : revision.questions.length === 0
      ? 'No unresolved questions recorded'
      : `${revision.questions.length} unresolved question${revision.questions.length === 1 ? '' : 's'}`;
  return <p className="intake-coverage">{count} field{count === 1 ? '' : 's'} entered · {questions}</p>;
}
function ScionList({ scions, loading, onOpen, onNew, canWrite }: { scions: Scion[]; canWrite: boolean; loading: boolean; onOpen: (id: string) => void; onNew: () => void }) {
  const [query, setQuery] = useState('');
  const visible = scions.filter(scion => `${scion.revision.name} ${scion.id}`.toLowerCase().includes(query.toLowerCase()));
  return <><div className="page-heading"><div><p className="eyebrow">YOUR SOURCING CASES</p><h1>Cases</h1><p>Open a case by product context and follow its single recommended next action.</p></div>{scions.length > 0 && <button className="text-button" onClick={onNew} disabled={!canWrite}><Icon name="plus" size={18} />Create a case</button>}</div>
    <div className="list-toolbar"><h2>All cases <span>{scions.length}</span></h2><label className="search-field"><Icon name="search" size={18} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search cases" aria-label="Search cases" /></label></div>
    {loading ? <div className="case-list-skeleton" role="status" aria-live="polite"><span className="sr-only">Loading cases</span><i /><i /><i /></div> : scions.length === 0 ? <div className="empty-state"><span className="empty-symbol"><Icon name="file" size={36} /></span><h2>No cases yet.</h2><p>Create a case to begin with a product configuration.</p><button className="button primary" onClick={onNew} disabled={!canWrite}><Icon name="plus" size={18} />Create a case</button><small>No sourcing decision is made when you save an intake.</small></div> : visible.length === 0 ? <div className="empty-state compact"><h2>No cases match “{query}”</h2><p>Clear the search to return to all permitted cases.</p><button className="button primary" onClick={() => setQuery('')}>Clear search</button></div> : <div className="scion-list">{visible.map(scion => <button key={scion.id} className="scion-row" onClick={() => onOpen(scion.id)}><div className="scion-row-main"><div className="scion-row-title"><h3>{scion.revision.name}</h3><span className="badge">{scion.revision.product_category === 'physical' ? 'Current' : 'Intake only'}</span></div><p>{scion.revision.product_category === 'physical' ? 'Scope status available in case' : category(scion.revision.product_category)}<span>·</span>Scion r{scion.current_revision}</p><p className="case-row-action">{scion.revision.product_category === 'physical' ? 'Open the exact sourcing context' : 'Open intake and evidence'} </p></div><div className="scion-row-end"><Icon name="arrow" size={20} /></div></button>)}</div>}
  </>;
}

function CaseRecord({ token, scion, route, navigate, principalId, onEdit, canWrite, onDirty }: { token: string; scion: Scion; route: string; navigate: (route: string) => void; principalId: string; canWrite: boolean; onEdit: () => void; onDirty: (value: boolean) => void }) {
  const parsed = parseFlowRoute(route);
  const [scopeProposalId, setScopeProposalId] = useState<string | null>(null);
  const [comparisonProposalId, setComparisonProposalId] = useState<string | null>(null);
  const sourceDirty = useRef(false);
  const markSourceDirty = useCallback((value: boolean) => { sourceDirty.current = value; onDirty(value); }, [onDirty]);
  function leave(next: string) { if (sourceDirty.current && !window.confirm('Discard this unsaved case edit?')) return; sourceDirty.current = false; onDirty(false); navigate(next); }
  function openScopeProposal(id: string) { setScopeProposalId(id); leave(`/scions/${scion.id}/scope/${id}`); }
  function openOfferProposal(id: string) { setComparisonProposalId(id); leave(`/scions/${scion.id}/comparisons/${id}`); }
  if (parsed.kind === 'history') return <><UtilityHeading scion={scion} title="Revision history" onBack={() => leave(`/scions/${scion.id}/context`)} /><History token={token} scion={scion} /></>;
  if (parsed.kind === 'sources') return <><UtilityHeading scion={scion} title="Sources and claims" onBack={() => leave(`/scions/${scion.id}/context`)} /><Evidence token={token} scion={scion} canWrite={canWrite} onDirty={markSourceDirty} /></>;
  if (parsed.kind === 'scope-workbench') return <><UtilityHeading scion={scion} title="Complete exact scope" onBack={() => leave(`/scions/${scion.id}/context`)} /><PhysicalScope token={token} scion={scion} principalId={principalId} canWrite={canWrite} onDirty={markSourceDirty} onSources={() => leave(`/scions/${scion.id}/sources`)} onOfferProposal={openOfferProposal} preferredProposalId={scopeProposalId} /></>;
  if (parsed.kind === 'offers-workbench') return <><UtilityHeading scion={scion} title="Prepare exact comparison" onBack={() => leave(`/scions/${scion.id}/context`)} /><Offers token={token} scion={scion} canWrite={canWrite} preferredProposalId={comparisonProposalId} onDirty={markSourceDirty} onSources={() => leave(`/scions/${scion.id}/sources`)} onScopeProposal={openScopeProposal} /></>;
  return <DirectionalFlow token={token} scion={scion} route={route} canWrite={canWrite} onEdit={onEdit} navigate={navigate} />;
}

function UtilityHeading({ scion, title, onBack }: { scion: Scion; title: string; onBack: () => void }) {
  return <div className="utility-heading"><button className="flow-back" type="button" onClick={onBack}>← Back to case context</button><p className="eyebrow">{scion.revision.name} · SCION R{scion.current_revision}</p><h1>{title}</h1></div>;
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
        {snapshot.product_category === 'digital' && <p className="snapshot-disclaimer">Digital intake only. Vendor comparison is unavailable.</p>}
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
        <section className="form-section"><div className="form-section-title"><span className="subtle-icon"><Icon name="file" /></span><div><h2>Scion identity</h2><p>A stable name for the product you’re considering.</p></div></div><label htmlFor="name">Scion name <span className="required-label">Required</span></label><input id="name" value={values.name} onChange={event => update('name', event.target.value)} maxLength={160} required autoFocus placeholder="Give this Scion a recognizable name" /><label htmlFor="category">Product category</label><select id="category" value={values.category} onChange={event => update('category', event.target.value as Category)}><option value="unspecified">Not yet specified</option><option value="physical">Physical product</option><option value="digital">Digital product</option></select>{values.category === 'digital' && <p className="digital-notice">Digital products can be saved as intake drafts. Digital vendor comparison is unavailable.</p>}</section>
        <section className="form-section"><div className="form-section-title"><span className="subtle-icon"><Icon name="book" /></span><div><h2>The product and the decision</h2><p>Use your own words. An empty answer remains missing.</p></div></div><label htmlFor="description">Product description <span className="optional-label">Optional</span></label><textarea id="description" value={values.description} onChange={event => update('description', event.target.value)} rows={4} maxLength={12000} placeholder="What is the product, who is it for, and what should it do?" /><label htmlFor="decision">Decision to be made <span className="optional-label">Optional</span></label><textarea id="decision" value={values.decision} onChange={event => update('decision', event.target.value)} rows={3} maxLength={4000} placeholder="What does the Handler need to decide?" /></section>
        <section className="form-section"><div className="form-section-title"><span className="subtle-icon"><Icon name="check" /></span><div><h2>Requirements and open questions</h2><p>Record each item on its own line.</p></div></div><label htmlFor="requirements">Known requirements <span className="optional-label">Optional</span></label><textarea id="requirements" value={values.requirements} onChange={event => update('requirements', event.target.value)} disabled={values.requirementsNone} rows={4} maxLength={200100} placeholder="One requirement per line" aria-describedby="requirements-help" /><p id="requirements-help" className="field-help">Leave blank if requirements have not been assessed.</p><label className="checkbox-label"><input type="checkbox" checked={values.requirementsNone} onChange={event => update('requirementsNone', event.target.checked)} /><span>Explicitly record no known requirements</span></label><label htmlFor="questions">Unresolved questions <span className="optional-label">Optional</span></label><textarea id="questions" value={values.questions} onChange={event => update('questions', event.target.value)} disabled={values.questionsNone} rows={4} maxLength={200100} placeholder="One question per line" aria-describedby="questions-help" /><p id="questions-help" className="field-help">Leave blank if open questions have not been assessed.</p><label className="checkbox-label"><input type="checkbox" checked={values.questionsNone} onChange={event => update('questionsNone', event.target.checked)} /><span>Explicitly record no unresolved questions</span></label></section>
        {scion && <section className="form-section"><label htmlFor="summary">What changed? <span className="optional-label">Optional</span></label><input id="summary" value={values.summary} onChange={event => update('summary', event.target.value)} maxLength={1000} placeholder="A short note for the revision history" /></section>}
        <div className="form-actions"><span><Icon name="lock" size={16} />{scion ? `Creates revision ${(baseRevision ?? 0) + 1}` : 'Creates revision 1'}</span><div><button className="button secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button><button className="button primary" type="submit" disabled={busy || stale || !values.name.trim()}>{busy ? 'Saving…' : scion ? 'Save new revision' : 'Save intake draft'}<Icon name="arrow" size={17} /></button></div></div>
      </div><aside className="form-aside"><div className="draft-guide"><span className="badge emphasis">FACTS FIRST</span><h2>Unknown is a valid starting point.</h2><p>You can save this Scion before every section is complete.</p><IntakeCoverage revision={payloadFrom(values, Boolean(scion))} /><ul><li><Icon name="check" size={17} /><span>Only the Scion name is required.</span></li><li><Icon name="check" size={17} /><span>Missing information stays visible.</span></li><li><Icon name="check" size={17} /><span>Every saved revision is preserved.</span></li></ul><div className="draft-boundary"><Icon name="lock" size={18} /><p>This is an intake record. Saving does not qualify a product or approve a sourcing decision.</p></div></div></aside>
    </fieldset></form></>;
}
