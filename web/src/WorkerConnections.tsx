import { useEffect, useId, useRef, useState } from 'react';
import { request, type Principal } from './api';
import './worker-connections.css';

type Connection = {
  connection_id: string; organization_id: string; device_name: string;
  adapter: string; policy_version: string; content_class: string;
  approved_at: string; revoked_at: string | null; last_seen: string | null;
  status: 'connected' | 'disconnected' | 'revoked';
};
type Pairing = {
  status: 'pending' | 'approved' | 'consumed' | 'expired';
  pairing_id: string; user_code: string; device_name: string; expires_at: string;
  organization_id: string; organization_name: string; connection_id: string | null;
  adapter: string; policy_version: string; content_class: string; consent_text: string;
};
const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'No heartbeat received';
const message = (error: unknown) => error instanceof Error ? error.message : 'Connection state is unavailable.';

function Command({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; window.clearTimeout(timer.current); }; }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      if (!mounted.current) return;
      setCopied(true); setError(''); window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch { if (mounted.current) setError('Select and copy the command below. Clipboard access is unavailable.'); }
  }
  return <div className="worker-command-wrap">
    <div className="worker-command"><pre><code>{value}</code></pre><button type="button" className="button secondary" aria-label={copied ? `${label} copied` : label} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button></div>
    {error && <p role="status">{error}</p>}
  </div>;
}

/** Shared local setup for Runtime settings and the agent creation step. */
export function CodexConnectionSetup({ compact = false, disabled = false }: { compact?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const command = `node byoa/connect.mjs --api '${window.location.origin}' --watch`;
  return <div className={`worker-provider-card${compact ? ' worker-provider-compact' : ''}`}>
    <div className="worker-provider-heading">
      <span className="worker-provider-mark" aria-hidden="true">&gt;_</span>
      <div><h3>OpenAI · Codex</h3><p>Your Codex CLI, on your computer.</p></div>
      <button type="button" className="button secondary" aria-expanded={open} aria-controls={panelId} disabled={disabled} onClick={() => setOpen(value => !value)}>{open ? 'Close setup' : 'Connect Codex'}</button>
    </div>
    {open && <div className="worker-setup" id={panelId}>
      <h3>Connect this computer</h3>
      <p>Your Codex login stays on this computer. Grimoire receives the proposal results.</p>
      <ol className="worker-setup-steps">
        <li><span>1</span><div><strong>Run the connector</strong><p>From your Grimoire checkout, run this command in a terminal.</p><Command value={command} label="Copy connect command" /></div></li>
        <li><span>2</span><div><strong>Authorize your workspace</strong><p>Open the link printed in your terminal. Match its code and approve the organization.</p></div></li>
        <li><span>3</span><div><strong>Keep the worker running</strong><p>The same command starts the worker after approval. Keep the terminal open. It handles explicitly dispatched tasks, including ones already waiting; creating an agent does not dispatch a task.</p></div></li>
      </ol>
      <details className="worker-help"><summary>Codex needs a login?</summary><p>Run <code>codex login</code> on this computer, finish signing in, then retry the connector. Check an existing login with <code>codex login status</code>.</p></details>
    </div>}
  </div>;
}

function ConnectionStatus({ connection }: { connection: Connection }) {
  const online = connection.status === 'connected';
  const revoked = connection.status === 'revoked' || Boolean(connection.revoked_at);
  const label = revoked ? 'Revoked' : online ? 'Worker online' : connection.last_seen ? 'Offline' : 'Authorized · worker not started';
  return <span className={`work-status ${revoked ? 'danger' : online ? 'good' : 'neutral'}`}><i />{label}</span>;
}

// This polling displays server-owned presence. It never creates a heartbeat or
// claims that the browser monitors tasks. Hidden/offline pages discard live state.
function useConnectionState<T>(token: string, path: string | null, revision: number) {
  const [result, setResult] = useState<{ key: string; data: T; checked: string } | null>(null);
  const [error, setError] = useState('');
  const key = `${token}:${path}`;
  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    let timer: number | undefined;
    setResult(null); setError('');
    const clear = () => { controller?.abort(); window.clearTimeout(timer); setResult(null); };
    async function refresh() {
      window.clearTimeout(timer);
      if (!active || !token || !path || document.visibilityState !== 'visible' || !navigator.onLine) {
        clear(); return;
      }
      controller?.abort();
      const current = new AbortController(); controller = current;
      const deadline = window.setTimeout(() => current.abort(), 4000);
      try {
        const data = await request<T>(token, path, { signal: current.signal, cache: 'no-store' });
        if (active && controller === current && !current.signal.aborted) {
          setResult({ key, data, checked: new Date().toISOString() }); setError('');
        }
      } catch (failure) {
        if (active && controller === current) { setResult(null); setError(message(failure)); }
      } finally {
        window.clearTimeout(deadline);
        if (active && controller === current) timer = window.setTimeout(() => void refresh(), 5000);
      }
    }
    const changed = () => { if (document.visibilityState === 'visible' && navigator.onLine) void refresh(); else clear(); };
    document.addEventListener('visibilitychange', changed);
    window.addEventListener('online', changed); window.addEventListener('offline', changed);
    void refresh();
    return () => { active = false; controller?.abort(); window.clearTimeout(timer); document.removeEventListener('visibilitychange', changed); window.removeEventListener('online', changed); window.removeEventListener('offline', changed); };
  }, [token, path, key, revision]);
  return { data: result?.key === key ? result.data : null, checked: result?.key === key ? result.checked : null, error };
}

export function WorkerConnections({ token, principal }: { token: string; principal: Principal | null }) {
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const context = useRef(token); context.current = token;
  const canManage = principal?.can_manage_workspace === true;
  const state = useConnectionState<{ connections: Connection[] }>(token, canManage ? '/worker-connections' : null, revision);
  useEffect(() => () => pending.current?.abort(), [token]);
  async function revoke(connection: Connection) {
    if (!principal || busy || !window.confirm(`Disconnect ${connection.device_name}? Its worker access will stop immediately.`)) return;
    const current = new AbortController(); pending.current = current;
    const submittedToken = token;
    setBusy(connection.connection_id); setError('');
    try {
      await request(token, `/worker-connections/${connection.connection_id}/revoke`, { method: 'POST', body: JSON.stringify({ organization_id: principal.org_id }), signal: current.signal });
      if (!current.signal.aborted && context.current === submittedToken) setRevision(value => value + 1);
    } catch (failure) { if (!current.signal.aborted && context.current === submittedToken) setError(message(failure)); }
    finally { if (!current.signal.aborted && context.current === submittedToken) setBusy(null); }
  }
  return <section className="settings-section worker-connections" aria-label="Codex connections">
    <h2>Agent connections</h2>
    <p>Connect a computer to prepare proposals with your own Codex account.</p>
    {canManage ? <>
      <CodexConnectionSetup />
      <div className="worker-list-heading"><h3>Authorized computers</h3><button className="button secondary" type="button" onClick={() => setRevision(value => value + 1)}>Check connections</button></div>
      {(error || state.error) && <p role="alert" className="error-message">{error || state.error}</p>}
      {!state.data && <p role="status">Connection state unavailable. Waiting for an authenticated check.</p>}
      {state.data?.connections.length === 0 && <p>No computer is paired with this organization yet.</p>}
      <div className="worker-connection-list">{state.data?.connections.map(connection => <article key={connection.connection_id}>
        <div className="worker-connection-heading"><strong>{connection.device_name}</strong><ConnectionStatus connection={connection} /></div>
        <p className="worker-connection-meta">Codex CLI · {connection.last_seen ? `Last heartbeat ${date(connection.last_seen)}` : 'Waiting for its first heartbeat'}</p>
        {!connection.revoked_at && connection.status !== 'revoked' && connection.status !== 'connected' && <details className="worker-resume" open={!connection.last_seen}>
          <summary>{connection.last_seen ? 'Resume worker' : 'Start worker'}</summary>
          <p>Run this on <strong>{connection.device_name}</strong> from the Grimoire checkout where you paired it. It handles explicitly dispatched tasks while the terminal stays open.</p>
          <Command value={`node byoa/bridge.mjs --connection ${connection.connection_id} --watch`} label={`Copy start command for ${connection.device_name}`} />
        </details>}
        <details className="worker-details"><summary>Connection details</summary>
          <dl><div><dt>Access</dt><dd>Synthetic proposals · Human review required</dd></div><div><dt>Authorized</dt><dd>{date(connection.approved_at)}</dd></div><div><dt>Connection ID</dt><dd><code>{connection.connection_id}</code></dd></div><div><dt>Consent version</dt><dd><code>{connection.policy_version}</code></dd></div></dl>
          {connection.revoked_at ? <p>Revoked {date(connection.revoked_at)}</p> : <button className="button secondary" type="button" disabled={busy !== null} onClick={() => void revoke(connection)}>{busy === connection.connection_id ? 'Revoking…' : 'Revoke connection'}</button>}
        </details>
      </article>)}</div>
      {state.checked && <p className="settings-footnote">Checked {date(state.checked)}. Worker presence is checked automatically. A task outcome confirms provider execution; it never grants approval.</p>}
    </> : <p>A workspace manager can pair a computer for this organization.</p>}
  </section>;
}

export function WorkerPairing({ token, principal, code, onNavigate }: { token: string; principal: Principal; code: string; onNavigate: (path: string) => void }) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [approved, setApproved] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const valid = /^[0-9A-F]{16}$/.test(code.toUpperCase());
  const path = valid ? `/worker-connections/pairings/${code.toUpperCase()}` : null;
  const state = useConnectionState<Pairing>(token, path, revision);
  useEffect(() => () => pending.current?.abort(), [token, code]);
  const review = state.data;
  const matches = review?.organization_id === principal.org_id && review?.adapter === 'codex_cli' && review?.content_class === 'synthetic_only' && review?.policy_version === 'codex-synthetic-v1';
  async function approve() {
    if (!path || !consent || !matches || review?.status !== 'pending' || busy) return;
    const current = new AbortController(); pending.current = current;
    setBusy(true); setError('');
    try {
      const result = await request<{ status: string }>(token, `${path}/approve`, { method: 'POST', body: JSON.stringify({ organization_id: principal.org_id, consent: true, policy_version: review.policy_version }), signal: current.signal });
      if (current.signal.aborted) return;
      setApproved(result.status === 'approved' || result.status === 'consumed'); setConsent(false); setRevision(value => value + 1);
    } catch (failure) { if (!current.signal.aborted) setError(message(failure)); }
    finally { if (!current.signal.aborted) setBusy(false); }
  }
  const connected = approved || review?.status === 'approved' || review?.status === 'consumed';
  return <section className="worker-pairing work-page">
    <p className="eyebrow">YOUR CODEX · YOUR COMPUTER</p>
    <h1>{connected ? 'Computer authorized' : 'Connect your Codex worker'}</h1>
    <p>Organization: <strong>{principal.organization_name}</strong>. Use the organization menu to choose a different workspace before approving.</p>
    <div className="worker-pairing-code"><span>Match this code with your terminal</span><strong>{code.toUpperCase()}</strong></div>
    {(!valid || state.error || error) && <p role="alert" className="error-message">{error || state.error || 'This pairing code is invalid.'}</p>}
    {connected ? <div role="status"><h2>Return to your terminal</h2><p>The connector saves this organization’s worker access on your computer. With <code>--watch</code>, it starts the worker and handles explicitly dispatched tasks, including work already waiting. Keep the terminal open.</p><p>If you connected without <code>--watch</code>, use the start command printed there or open this connection below.</p><button type="button" className="button primary" onClick={() => onNavigate('/settings/runtime')}>View worker connection</button></div>
      : review?.status === 'expired' ? <p role="alert">This code expired. Run the connect command again to get a new code.</p>
      : review && matches ? <>
        <dl className="settings-facts"><div><dt>Computer</dt><dd>{review.device_name}</dd></div><div><dt>Code expires</dt><dd>{date(review.expires_at)}</dd></div><div><dt>Access</dt><dd>Synthetic proposal preparation only</dd></div></dl>
        <p className="worker-consent-copy">{review.consent_text}</p>
        <label className="worker-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={busy || !principal.can_manage_workspace} /><span>I started this connection and authorize this computer to prepare synthetic proposals for <strong>{principal.organization_name}</strong> using my Codex account.</span></label>
        <div className="settings-actions"><button type="button" className="button secondary" onClick={() => onNavigate('/settings/runtime')}>Cancel</button><button type="button" className="button primary" disabled={!consent || busy || !principal.can_manage_workspace} onClick={() => void approve()}>{busy ? 'Authorizing…' : 'Authorize computer'}</button></div>
      </> : <p role="status">{review ? 'The organization or connection policy changed. Reopen the link in the correct workspace.' : 'Checking this pairing request…'}</p>}
  </section>;
}
