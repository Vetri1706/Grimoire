import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiError, request } from './api';
import type { Scion } from './api';
import { MAX_QUOTE_MATCHES, quoteLocators } from './evidence-api';
import type { SourceClaim, SourceDetail, SourceInput, SourceList, SourceRevision, SourceSummary } from './evidence-api';

const message = (failure: unknown) => failure instanceof Error ? failure.message : 'The request failed. Please retry.';
const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function Failure({ children }: { children: ReactNode }) { return <div className="error-message" role="alert"><div>{children}</div></div>; }

// A network retry of the same operation keeps its key. Changed input starts a new operation.
function useWrite(token: string) {
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const pending = useRef(new Set<AbortController>());
  useEffect(() => {
    const requests = pending.current;
    return () => { requests.forEach(controller => controller.abort()); requests.clear(); };
  }, []);
  return async function write<T>(path: string, payload: unknown, base?: number): Promise<T> {
    const body = JSON.stringify(payload);
    const signature = JSON.stringify([path, base, body]);
    if (retry.current?.signature !== signature) retry.current = { signature, key: crypto.randomUUID() };
    const controller = new AbortController();
    pending.current.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    try {
      return await request<T>(token, path, { method: 'POST', body, signal: controller.signal, cache: 'no-store', headers: { 'Idempotency-Key': retry.current.key, ...(base !== undefined ? { 'If-Match': `"${base}"` } : {}) } });
    } finally { window.clearTimeout(timeout); pending.current.delete(controller); }
  };
}

// This is a display lease, not an authorization cache. The Rust API authorizes
// every read and write. Its successful response permits a brief visible view;
// a new authenticated metadata request must renew it before it expires.
const ACCESS_LEASE_MS = 5000;
const RIGHTS_POLL_MS = 2000;
const READ_TIMEOUT_MS = 2000;
const contentCleared = 'Source and claim content, including unsaved source forms, has been cleared.';
const accessFailure = (failure: unknown) => failure instanceof ApiError && failure.status === 0
  ? `Source access could not be confirmed. ${contentCleared}`
  : `${message(failure)} ${contentCleared}`;
const accessUncertain = (failure: unknown) => failure instanceof ApiError && ([0, 401, 403, 404].includes(failure.status) || failure.status >= 500);

export default function Evidence({ token, scion, canWrite, onDirty }: { token: string; scion: Scion; canWrite: boolean; onDirty: (value: boolean) => void }) {
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revisionNumber, setRevisionNumber] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<'new' | 'edit' | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [accessReady, setAccessReady] = useState(false);
  const [accessNotice, setAccessNotice] = useState('');
  const dirty = useRef(false);
  const generation = useRef(0);
  const selectedRef = useRef<string | null>(null);
  const activeReads = useRef(new Set<AbortController>());
  const accessExpiresAt = useRef(0);
  const leaseTimer = useRef<number | undefined>(undefined);
  const basePath = `/scions/${scion.id}/sources`;
  const selected = sources.find(source => source.id === selectedId);
  const snapshot = detail?.revisions.find(revision => revision.number === revisionNumber);
  const claims = detail?.claims.filter(claim => claim.source_revision === revisionNumber) ?? [];
  const markDirty = useCallback((value: boolean) => { dirty.current = value; onDirty(value); }, [onDirty]);

  const clearAccess = useCallback((reason: string, retainedSources?: SourceSummary[]) => {
    generation.current++;
    activeReads.current.forEach(controller => controller.abort());
    activeReads.current.clear();
    window.clearTimeout(leaseTimer.current);
    accessExpiresAt.current = 0;
    setAccessReady(false); setDetail(null); setRevisionNumber(null);
    setForm(null); setRevoking(false); setLoading(false); markDirty(false);
    setSources(retainedSources ?? []);
    setAccessNotice(reason);
  }, [markDirty]);

  const renewLease = useCallback((startedAt: number) => {
    if (document.visibilityState !== 'visible' || !navigator.onLine || Date.now() >= startedAt + ACCESS_LEASE_MS) return false;
    accessExpiresAt.current = startedAt + ACCESS_LEASE_MS;
    window.clearTimeout(leaseTimer.current);
    leaseTimer.current = window.setTimeout(() => {
      if (Date.now() >= accessExpiresAt.current) clearAccess(`Source access expired before it could be rechecked. ${contentCleared}`);
    }, Math.max(0, accessExpiresAt.current - Date.now()));
    setAccessReady(true); setAccessNotice('');
    return true;
  }, [clearAccess]);

  const read = useCallback(async <T,>(path: string): Promise<T> => {
    const controller = new AbortController();
    activeReads.current.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
    try { return await request<T>(token, path, { signal: controller.signal, cache: 'no-store' }); }
    finally { window.clearTimeout(timeout); activeReads.current.delete(controller); }
  }, [token]);

  const reload = useCallback(async (preferredId?: string | null) => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) {
      clearAccess(`${document.visibilityState !== 'visible' ? 'This tab is hidden.' : 'The browser is offline.'} ${contentCleared}`);
      return;
    }
    activeReads.current.forEach(controller => controller.abort());
    activeReads.current.clear();
    const current = ++generation.current;
    const startedAt = Date.now();
    setLoading(true); setError(''); setDetail(null); setForm(null); setRevoking(false); markDirty(false);
    try {
      const result = await read<SourceList>(basePath);
      if (current !== generation.current) return;
      setSources(result.sources);
      const chosen = result.sources.find(source => source.id === (preferredId ?? selectedRef.current)) ?? result.sources[0];
      setSelectedId(chosen?.id ?? null); selectedRef.current = chosen?.id ?? null;
      if (chosen?.rights_status === 'granted') {
        const loaded = await read<SourceDetail>(`${basePath}/${chosen.id}`);
        if (current !== generation.current) return;
        if (loaded.source.id !== chosen.id || loaded.source.rights_status !== 'granted') throw new Error('Source permission could not be confirmed.');
        if (!renewLease(startedAt)) { clearAccess(`Source access expired during the check. ${contentCleared}`); return; }
        setDetail(loaded); setRevisionNumber(loaded.source.current_revision);
      } else if (!renewLease(startedAt)) clearAccess(`Source access expired during the check. ${contentCleared}`);
    } catch (failure) {
      if (current !== generation.current) return;
      clearAccess(accessFailure(failure)); setError(accessFailure(failure));
    } finally { if (current === generation.current) setLoading(false); }
  }, [basePath, read, markDirty, clearAccess, renewLease]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
      activeReads.current.forEach(controller => controller.abort());
      activeReads.current.clear();
      window.clearTimeout(leaseTimer.current);
      accessExpiresAt.current = 0;
      onDirty(false);
    };
  }, [reload, onDirty]);

  useEffect(() => {
    const recheck = async () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine || activeReads.current.size > 0) return;
      if (accessExpiresAt.current <= Date.now()) { void reload(); return; }
      const current = generation.current;
      const startedAt = Date.now();
      try {
        const result = await read<SourceList>(basePath);
        if (current !== generation.current) return;
        setSources(result.sources);
        const source = result.sources.find(item => item.id === selectedRef.current);
        if (selectedRef.current && (!source || source.rights_status !== 'granted')) {
          clearAccess(`Source permission changed. ${contentCleared}`, result.sources);
          // Metadata is still readable. A new source form can start with no
          // selected source; the revoked source stays an audit-only tombstone.
          if (source?.rights_status === 'revoked') renewLease(startedAt);
          return;
        }
        if (!renewLease(startedAt)) clearAccess(`Source access expired during the check. ${contentCleared}`);
        setError('');
      } catch (failure) {
        if (current !== generation.current) return;
        clearAccess(accessFailure(failure)); setError(accessFailure(failure));
      }
    };
    const visible = () => {
      if (document.visibilityState !== 'visible') clearAccess(`This tab is hidden. ${contentCleared}`);
      else void reload();
    };
    const offline = () => clearAccess(`The browser is offline. ${contentCleared}`);
    const online = () => void reload();
    const restored = (event: PageTransitionEvent) => { if (event.persisted) void reload(); };
    const focused = () => void recheck();
    const interval = window.setInterval(() => void recheck(), RIGHTS_POLL_MS);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', focused);
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    window.addEventListener('pagehide', offline);
    window.addEventListener('pageshow', restored);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', focused);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      window.removeEventListener('pagehide', offline);
      window.removeEventListener('pageshow', restored);
    };
  }, [reload, read, basePath, clearAccess, renewLease]);

  function discard() {
    if (dirty.current && !window.confirm('Discard this unsaved source or claim edit?')) return false;
    markDirty(false); return true;
  }
  function cancel() { if (discard()) { setForm(null); setRevoking(false); void reload(); } }
  const renderedGeneration = generation.current;
  function denied() {
    if (renderedGeneration !== generation.current) return;
    clearAccess(`Source access could not be confirmed. ${contentCleared}`);
  }
  async function saved(id: string, text: string) {
    if (renderedGeneration !== generation.current || accessExpiresAt.current <= Date.now() || document.visibilityState !== 'visible' || !navigator.onLine) return;
    markDirty(false); setForm(null); setRevoking(false); setNotice(text);
    await reload(id);
  }

  return <section className="source-workspace" aria-label="Sources and claims">
    <div className="source-toolbar"><div><h2>Sources and claims</h2><p>Synthetic source records linked to this intake draft. Permission to review does not establish truth.</p></div><button className="button primary" disabled={!canWrite || loading || !accessReady} onClick={() => { if (discard()) { selectedRef.current = null; setSelectedId(null); setDetail(null); setRevisionNumber(null); setForm('new'); setRevoking(false); setNotice(''); } }}>Link synthetic source</button></div>
    <div className="source-state-strip"><span><strong>Source text</strong> · recorded separately</span><span><strong>Handler claims</strong> · unverified</span><span><strong>Extracted claims</strong> · not implemented</span><span><strong>Verified facts</strong> · 0</span></div>
    <p className="source-access-status" role="status">{accessNotice || (accessReady ? 'Source access is rechecked every 2 seconds. Content is cleared if permission cannot be confirmed, this tab is hidden, or the browser goes offline.' : 'Confirming source access before content is displayed…')}</p>
    {notice && <div className="success-notice" role="status">{notice}<button aria-label="Dismiss source notification" onClick={() => setNotice('')}>×</button></div>}
    {error && <Failure>{error} <button className="text-button" onClick={() => void reload()}>Recheck access</button></Failure>}
    {form === 'new' && accessReady ? <SourceForm key="new" token={token} path={basePath} baseRevision={scion.current_revision} onDirty={markDirty} onCancel={cancel} onSaved={id => saved(id, 'Synthetic source linked. The Scion intake revision is unchanged.')} onDenied={denied} /> : <div className="source-layout">
      <aside className="source-list"><div className="section-heading"><h3>Linked sources</h3><span className="badge">{sources.length}</span></div>{loading && <p className="section-description" role="status">Checking source access…</p>}{!loading && sources.length === 0 && <p className="section-description">No sources linked. Add a synthetic text you have permission to use.</p>}<ul>{sources.map(source => <li key={source.id}><button className={`source-choice ${source.id === selectedId ? 'active' : ''}`} aria-pressed={source.id === selectedId} disabled={loading} onClick={() => { if (discard()) { setForm(null); setRevoking(false); void reload(source.id); } }}><strong>{source.title}</strong><span>Source revision {source.current_revision} · Synthetic</span><span className={source.rights_status === 'revoked' ? 'source-revoked-label' : ''}>{source.rights_status === 'revoked' ? 'Permission revoked · content hidden' : `${source.claim_count} unverified claim${source.claim_count === 1 ? '' : 's'}`}</span></button></li>)}</ul></aside>
      <div className="source-content">{selected?.rights_status === 'revoked' ? <section className="source-card source-tombstone"><p className="eyebrow">AUDIT METADATA ONLY</p><h2>{selected.title}</h2><span className="badge">Permission revoked</span><p>Source text, revision content, locator quotes, and claims are unavailable. This source cannot be used for review or restored in this slice.</p><SourceMetadata source={selected} /><dl className="source-metadata"><dt>Revocation reason</dt><dd>{selected.revocation_reason}</dd></dl><p className="field-help">Revocation blocks subsequent API access. It cannot retract content previously viewed or copied.</p></section> : form === 'edit' && detail && accessReady ? <SourceForm key={`${selectedId}-edit`} token={token} path={`${basePath}/${selectedId}/revisions`} baseRevision={detail.source.current_revision} initial={detail.revisions.find(revision => revision.number === detail.source.current_revision)} onDirty={markDirty} onCancel={cancel} onSaved={id => saved(id, 'New source revision saved. Earlier revisions and their claim locators remain unchanged.')} onDenied={denied} /> : selected && revoking && accessReady ? <RevokeForm token={token} source={selected} path={`${basePath}/${selected.id}/revoke`} onDirty={markDirty} onCancel={cancel} onBeforeSend={() => setDetail(null)} onSaved={() => saved(selected.id, 'Permission revoked. Source and claim content have been cleared from this view.')} onDenied={denied} /> : snapshot && detail && accessReady ? <>
        <section className="source-card"><div className="source-heading"><div><p className="eyebrow">SYNTHETIC SOURCE · UNVERIFIED</p><h2>{snapshot.title}</h2><p className="section-description">Linked to Scion revision {detail.source.scion_revision}. Saved {when(snapshot.created_at)}.</p></div><span className="badge">Source revision {snapshot.number}</span></div><SourceMetadata source={snapshot} /><SourceStorage revision={snapshot} /><div className="source-history"><label htmlFor="source-revision">Immutable source revision</label><select id="source-revision" value={revisionNumber ?? ''} onChange={event => { if (discard()) setRevisionNumber(Number(event.target.value)); }}>{[...detail.revisions].sort((a, b) => b.number - a.number).map(revision => <option key={revision.number} value={revision.number}>Revision {revision.number}{revision.number === detail.source.current_revision ? ' · Current' : ''} · {revision.change_summary}</option>)}</select><p className="field-help">{snapshot.change_summary} · {snapshot.byte_length} UTF-8 bytes. Earlier snapshots are read only.</p></div><h3 className="source-subheading">Source text</h3><pre className="source-text">{snapshot.source_text}</pre><p className="field-help">Recorded source content. No extraction or independent verification has occurred.</p><div className="source-actions"><button className="button secondary" disabled={!canWrite} onClick={() => { if (discard()) setForm('edit'); }}>Add source revision</button><button className="text-button source-revoke-button" disabled={!canWrite} onClick={() => { if (discard()) { setRevoking(true); setDetail(null); } }}>Revoke permission</button></div></section>
        <section className="source-card"><div className="section-heading"><h2>Handler-entered claim</h2><span className="badge">Unverified</span></div><p className="section-description">One manual claim may refer to an exact locator in this source revision. It does not become a verified fact.</p>{claims.map(claim => <ClaimSnapshot key={claim.id} claim={claim} />)}{claims.length === 0 && (canWrite ? <ClaimForm key={`${snapshot.source_id}-${snapshot.number}`} token={token} path={`${basePath}/${snapshot.source_id}/revisions/${snapshot.number}/claims`} revision={snapshot} onDirty={markDirty} onSaved={() => saved(snapshot.source_id, 'Handler claim saved as unverified. No fact or sourcing approval was created.')} onDenied={denied} /> : <p className="section-description">No claim recorded for this revision.</p>)}</section>
      </> : <section className="source-card source-placeholder"><h2>{loading ? 'Loading source…' : 'Source record'}</h2><p>{loading ? 'Permission is checked before content is displayed.' : 'Select a source, or link your first synthetic note.'}</p></section>}</div>
    </div>}
    <p className="source-boundary">Evidence readiness remains not assessed. No supplier offers, sourcing case, or human approval is created here.</p>
  </section>;
}

function SourceMetadata({ source }: { source: SourceSummary | SourceRevision }) {
  return <dl className="source-metadata"><dt>Origin</dt><dd>{source.origin}</dd><dt>Owner</dt><dd>{source.owner}</dd><dt>Rights status</dt><dd>{source.rights_status === 'revoked' ? 'Revoked' : 'Handler-declared permission for local Scion review'}</dd><dt>Permission basis</dt><dd>{source.permission_basis}</dd><dt>Permitted use</dt><dd>Scion review only <code>(scion_review)</code></dd><dt>Content SHA-256</dt><dd><code>{source.content_sha256}</code></dd></dl>;
}

function SourceStorage({ revision }: { revision: SourceRevision }) {
  const verified = revision.storage_backend === 's3' && Boolean(revision.object_key) && Boolean(revision.object_version_id) && revision.content_hash_verified === true;
  return <div className="source-storage-status"><p>{verified ? 'Private versioned storage · content hash checked by the API' : 'Object-storage integrity has not been confirmed by this API response.'}</p><p className="field-help">{verified ? 'This checks the stored bytes, not the truth of the source or its claims.' : 'A recorded hash alone does not establish storage integrity or evidence readiness.'}</p>{verified && <details className="revision-details"><summary>Storage details</summary><dl><dt>Storage backend</dt><dd>Private S3-compatible object storage</dd><dt>Object version ID</dt><dd><code>{revision.object_version_id}</code></dd><dt>Content hash</dt><dd>SHA-256 matched by the API when this version was read.</dd></dl></details>}</div>;
}

function SourceForm({ token, path, baseRevision, initial, onDirty, onCancel, onSaved, onDenied }: { token: string; path: string; baseRevision: number; initial?: SourceRevision; onDirty: (value: boolean) => void; onCancel: () => void; onSaved: (id: string) => Promise<void>; onDenied: () => void }) {
  const [values, setValues] = useState({ title: initial?.title ?? '', origin: initial?.origin ?? '', owner: initial?.owner ?? '', source_text: initial?.source_text ?? '', permission_basis: initial?.permission_basis ?? '', change_summary: '' });
  const [permitted, setPermitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const write = useWrite(token);
  const byteLength = new TextEncoder().encode(values.source_text).length;
  function update(key: keyof typeof values, value: string) { setValues(previous => ({ ...previous, [key]: value })); onDirty(true); setUncertain(false); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || stale) return;
    if (!permitted) { setError('Permission must be explicitly recorded before source content can be submitted.'); return; }
    if (byteLength > 32000) { setError('Use at most 32,000 UTF-8 bytes for this synthetic source.'); return; }
    setBusy(true); setError('');
    const payload: SourceInput = { ...values, synthetic: true, rights_status: 'granted', permitted_use: 'scion_review' };
    try { const result = await write<{ source_id: string }>(path, payload, baseRevision); onDirty(false); await onSaved(result.source_id); }
    catch (failure) {
      setError(message(failure)); setStale(failure instanceof ApiError && failure.status === 412);
      setUncertain(failure instanceof ApiError && (failure.status === 0 || failure.status >= 500));
      if (accessUncertain(failure)) onDenied();
    } finally { setBusy(false); }
  }
  return <form className="source-card source-form" onSubmit={save}><h2>{initial ? 'Add a source revision' : 'Link a synthetic source'}</h2><p className="section-description">{initial ? `Appends after source revision ${baseRevision}. Existing source text and claims remain unchanged.` : `Links to Scion revision ${baseRevision}. Its intake snapshot stays unchanged.`}</p>{error && <Failure>{error}</Failure>}{stale && <div className="conflict-panel"><h3>The saved record has changed.</h3><p>Your text is still here. Copy any changes you need, then cancel and reopen the current {initial ? 'source' : 'Scion'} before saving. This edit cannot overwrite a newer revision.</p></div>}{uncertain && <div className="info-notice"><p>The result is uncertain. Retry unchanged to reuse the same request key. Check the source list before changing and resubmitting this draft.</p></div>}<fieldset disabled={busy}>
    <label htmlFor="source-title">Source title</label><input id="source-title" value={values.title} onChange={event => update('title', event.target.value)} required maxLength={160} autoFocus />
    <div className="source-form-pair"><div><label htmlFor="source-origin">Origin</label><input id="source-origin" value={values.origin} onChange={event => update('origin', event.target.value)} required maxLength={2000} placeholder="synthetic://handler/example-note" /></div><div><label htmlFor="source-owner">Owner</label><input id="source-owner" value={values.owner} onChange={event => update('owner', event.target.value)} required maxLength={300} /></div></div>
    <label htmlFor="source-text-input">Synthetic source text</label><textarea id="source-text-input" value={values.source_text} onChange={event => update('source_text', event.target.value)} rows={6} required maxLength={32000} aria-describedby="source-size" /><p className="field-help" id="source-size">{byteLength.toLocaleString()} / 32,000 UTF-8 bytes. The API hashes the exact submitted text. Use synthetic content only.</p>
    <label htmlFor="source-permission">Permission basis</label><textarea id="source-permission" value={values.permission_basis} onChange={event => update('permission_basis', event.target.value)} required maxLength={4000} rows={2} placeholder="Record who permits this use and why you have the right to submit the text." />
    <label className="checkbox-label source-permission-check"><input type="checkbox" checked={permitted} onChange={event => { setPermitted(event.target.checked); onDirty(true); }} required /><span>I have permission to use this synthetic source for local Scion review. This does not establish approved evidence.</span></label><p className="field-help">Permitted use: <code>scion_review</code>. Missing permission is denied by the API; no content is submitted without this attestation.</p>
    <label htmlFor="source-change">Change summary</label><input id="source-change" value={values.change_summary} onChange={event => update('change_summary', event.target.value)} required maxLength={1000} />
    <div className="source-actions"><button className="button secondary" type="button" onClick={onCancel}>Cancel</button><button className="button primary" disabled={stale || !permitted || byteLength > 32000} type="submit">{busy ? 'Saving…' : initial ? 'Save source revision' : 'Link source'}</button></div>
  </fieldset></form>;
}

function ClaimForm({ token, path, revision, onDirty, onSaved, onDenied }: { token: string; path: string; revision: SourceRevision; onDirty: (value: boolean) => void; onSaved: () => Promise<void>; onDenied: () => void }) {
  const [statement, setStatement] = useState('');
  const [quote, setQuote] = useState('');
  const [occurrence, setOccurrence] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const write = useWrite(token);
  const matches = quoteLocators(revision.source_text, quote);
  const tooManyMatches = matches.length > MAX_QUOTE_MATCHES;
  const locator = tooManyMatches ? undefined : matches[occurrence];
  async function save(event: FormEvent) {
    event.preventDefault(); if (!locator || busy) return;
    setBusy(true); setError('');
    try { await write(path, { statement, locator }); onDirty(false); await onSaved(); }
    catch (failure) {
      setError(message(failure)); setUncertain(failure instanceof ApiError && (failure.status === 0 || failure.status >= 500));
      if (accessUncertain(failure)) onDenied();
    } finally { setBusy(false); }
  }
  return <form className="source-form claim-form" onSubmit={save}>{error && <Failure>{error}</Failure>}{uncertain && <p className="field-help">Retry unchanged to keep the request key. Check the source before editing an uncertain submission.</p>}<fieldset disabled={busy}><label htmlFor="claim-statement">Claim statement</label><textarea id="claim-statement" value={statement} onChange={event => { setStatement(event.target.value); onDirty(true); setUncertain(false); }} required maxLength={4000} rows={3} placeholder="Enter your claim. It will remain unverified." /><label htmlFor="claim-quote">Exact source quote</label><textarea id="claim-quote" value={quote} onChange={event => { setQuote(event.target.value); setOccurrence(0); onDirty(true); setUncertain(false); }} required maxLength={32000} rows={2} placeholder="Copy the exact supporting text from the source above." />{quote && matches.length === 0 && <p className="source-locator-error" role="status">This quote does not exactly match the saved source text.</p>}{tooManyMatches && <p className="source-locator-error" role="status">This quote has more than {MAX_QUOTE_MATCHES} matches. Use a longer exact quote to identify its location.</p>}{matches.length > 1 && !tooManyMatches && <><label htmlFor="claim-occurrence">Quote occurrence</label><select id="claim-occurrence" value={occurrence} onChange={event => { setOccurrence(Number(event.target.value)); onDirty(true); }}>{matches.map((match, index) => <option key={match.start_byte} value={index}>Occurrence {index + 1} · UTF-8 bytes [{match.start_byte}, {match.end_byte})</option>)}</select></>}{locator && <p className="field-help">Exact locator: source revision {revision.number}, UTF-8 bytes [{locator.start_byte}, {locator.end_byte}). End byte is excluded.</p>}<div className="source-actions"><button className="button primary" disabled={!locator || !statement.trim()} type="submit">{busy ? 'Saving…' : 'Record unverified claim'}</button></div></fieldset></form>;
}

function ClaimSnapshot({ claim }: { claim: SourceClaim }) {
  return <article className="claim-snapshot"><p className="claim-statement">{claim.statement}</p><p className="field-help">Handler-entered · Unverified · Source revision {claim.source_revision}</p><blockquote>{claim.locator.quote}</blockquote><dl className="source-metadata"><dt>Exact locator</dt><dd>UTF-8 bytes [{claim.locator.start_byte}, {claim.locator.end_byte}) · zero-based, end excluded</dd></dl><details className="revision-details"><summary>Claim details</summary><dl><dt>Claim ID</dt><dd><code>{claim.id}</code></dd><dt>Handler principal ID</dt><dd><code>{claim.created_by}</code></dd><dt>Recorded</dt><dd>{when(claim.created_at)}</dd></dl></details></article>;
}

function RevokeForm({ token, path, source, onDirty, onCancel, onBeforeSend, onSaved, onDenied }: { token: string; path: string; source: SourceSummary; onDirty: (value: boolean) => void; onCancel: () => void; onBeforeSend: () => void; onSaved: () => Promise<void>; onDenied: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const write = useWrite(token);
  async function revoke(event: FormEvent) {
    event.preventDefault(); if (busy || stale) return;
    setBusy(true); setError(''); onBeforeSend();
    try { await write(path, { reason }, source.current_revision); onDirty(false); await onSaved(); }
    catch (failure) { setError(message(failure)); setStale(failure instanceof ApiError && failure.status === 412); if (accessUncertain(failure)) onDenied(); }
    finally { setBusy(false); }
  }
  return <form className="source-card source-form" onSubmit={revoke}><p className="eyebrow">PERMISSION CHANGE</p><h2>Revoke permission for {source.title}</h2><p className="section-description">Revocation blocks source text, every revision, and all claims from subsequent API access. Audit metadata remains. This source cannot be restored in this slice; previously viewed or copied content cannot be retracted.</p>{error && <Failure>{error}</Failure>}{stale && <p className="field-help">The source has changed. Cancel and reopen its current revision before revoking.</p>}<fieldset disabled={busy}><label htmlFor="revocation-reason">Reason for revocation</label><textarea id="revocation-reason" value={reason} onChange={event => { setReason(event.target.value); onDirty(true); }} required maxLength={1000} rows={3} /><div className="source-actions"><button className="button secondary" type="button" onClick={onCancel}>Cancel</button><button className="button primary" disabled={stale || !reason.trim()} type="submit">{busy ? 'Revoking…' : 'Revoke source permission'}</button></div></fieldset></form>;
}
