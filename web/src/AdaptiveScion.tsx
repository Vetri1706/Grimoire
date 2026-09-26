import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, request } from './api';
import type { Scion } from './api';
import type { AdaptiveState, CapabilityPlan, EvidenceComparison, EvidenceComparisonInput } from './adaptive-api';
import type { SourceDetail, SourceList, SourceSummary } from './evidence-api';
import type { AgentTask, AgentTaskList, ScopeReference } from './scope-api';
import AgentTasks from './AgentTasks';
import { ClaimSelector, useScopeWrite } from './PhysicalScope';
import './adaptive.css';

const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const errorText = (value: unknown) => value instanceof Error ? value.message : 'The request failed.';
const lostAccess = (value: unknown) => value instanceof ApiError && ([0, 401, 403, 404].includes(value.status) || value.status >= 500);
function blockedExplanation(reason: string | null) {
  const explanations: Record<string, string> = {
    SOURCE_RIGHTS_DENIED: 'Permission to use a linked source is absent or has been revoked. The comparison and its quoted claims are withheld.',
    STALE_REVISION: 'The Scion has a newer intake revision. This comparison remains in history; prepare a new plan and comparison for the current revision.',
    CAPABILITY_INPUT_STALE: 'The capability plan or a linked source revision has changed. Review the current inputs and prepare a new comparison with exact current claims.',
    SOURCE_OBJECT_MISSING: 'The exact stored version of a linked source cannot be found. Its comparison and claims are withheld until that version can be verified.',
    SOURCE_STORAGE_UNAVAILABLE: 'The source object store is unavailable. The comparison and claims are withheld until access and bytes can be checked again.',
    SOURCE_STORAGE_MIGRATION_REQUIRED: 'A linked source has not completed the required storage migration. The comparison and claims are withheld until its exact stored bytes can be verified.',
    SOURCE_INTEGRITY_FAILED: 'A linked source failed its content hash or exact quote check. The comparison and claims are withheld; integrity must be resolved before review.',
    SCION_NOT_FOUND: 'A required case record or source is unavailable to this identity. The comparison and claims are withheld.',
    INTAKE_WRITE_DENIED: 'The current identity is not permitted to access a required record. The comparison and claims are withheld.',
    UNAUTHENTICATED: 'Current access could not be authenticated. Reconnect and recheck permission before viewing this comparison.',
    DATABASE_UNAVAILABLE: 'The database could not verify the comparison inputs. Content is withheld until the check succeeds.',
  };
  return reason && explanations[reason] || 'The plan, intake or source is no longer available for this comparison. Content is withheld; audit identifiers are retained.';
}
function Gaps({ items }: { items: string[] }) { return items.length ? <ul className="adaptive-gaps">{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="field-help">No additional gaps recorded. Evidence and agent proposals remain unverified.</p>; }

export default function AdaptiveScion({ token, scion, canWrite, preferredPlanId, onDirty, onSources, onScopeProposal, onOfferProposal }: {
  token: string; scion: Scion; canWrite: boolean; preferredPlanId: string | null; onDirty: (dirty: boolean) => void; onSources: () => void;
  onScopeProposal: (id: string) => void; onOfferProposal: (id: string) => void;
}) {
  const [data, setData] = useState<AdaptiveState | null>(null);
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [tasks, setTasks] = useState<AgentTask[] | null>(null);
  const [taskError, setTaskError] = useState('');
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false); const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(preferredPlanId);
  const [composing, setComposing] = useState(false);
  const [synthetic, setSynthetic] = useState(false); const [timeoutSeconds, setTimeoutSeconds] = useState(240);
  const [queueBusy, setQueueBusy] = useState(false);
  const selectedRef = useRef(preferredPlanId); const dirty = useRef(false);
  const pending = useRef(new Set<AbortController>()); const generation = useRef(0);
  const leaseTimer = useRef<number | undefined>(undefined); const leaseEnd = useRef(0);
  const write = useScopeWrite(token); const base = `/scions/${scion.id}`;
  const markDirty = useCallback((value: boolean) => { dirty.current = value; onDirty(value); }, [onDirty]);
  const clear = useCallback((reason: string) => {
    generation.current++; pending.current.forEach(controller => controller.abort()); pending.current.clear();
    window.clearTimeout(leaseTimer.current); leaseEnd.current = 0;
    setData(null); setSources([]); setTasks(null); setReady(false); setLoading(false); setComposing(false); setNotice('');
    markDirty(false); setError(reason);
  }, [markDirty]);
  const refresh = useCallback(async (force = false) => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) { clear('Capability and comparison content is paused while this tab is hidden or offline. Unsaved comparison content has been cleared.'); return; }
    if (pending.current.size && !force) return;
    if (force) { generation.current++; pending.current.forEach(controller => controller.abort()); pending.current.clear(); }
    const epoch = generation.current; const started = Date.now();
    const read = async <T,>(path: string): Promise<T> => {
      const controller = new AbortController(); pending.current.add(controller);
      const timer = window.setTimeout(() => controller.abort(), 2000);
      try { return await request<T>(token, path, { cache: 'no-store', signal: controller.signal }); }
      finally { window.clearTimeout(timer); pending.current.delete(controller); }
    };
    const [adaptive, sourceResult, taskResult] = await Promise.allSettled([
      read<AdaptiveState>(`${base}/capabilities`), read<SourceList>(`${base}/sources`), read<AgentTaskList>(`${base}/agent-tasks`),
    ]);
    if (epoch !== generation.current) return;
    if (adaptive.status === 'rejected' || sourceResult.status === 'rejected') {
      clear(`Permission or evidence could not be checked. Derived content and unsaved comparisons have been cleared. ${errorText(adaptive.status === 'rejected' ? adaptive.reason : sourceResult.status === 'rejected' ? sourceResult.reason : undefined)}`); return;
    }
    if (Date.now() >= started + 5000 || document.visibilityState !== 'visible' || !navigator.onLine) { clear('The access check expired. Derived content and unsaved comparison content have been cleared.'); return; }
    setData(adaptive.value); setSources(sourceResult.value.sources);
    const selected = adaptive.value.plans.find(plan => plan.id === selectedRef.current) ?? adaptive.value.plans[0];
    selectedRef.current = selected?.id ?? null; setSelectedId(selected?.id ?? null);
    if (!selected?.input || selected.status !== 'current' || adaptive.value.scion_revision !== scion.current_revision) { setComposing(false); markDirty(false); }
    if (taskResult.status === 'fulfilled') { setTasks(taskResult.value.tasks); setTaskError(''); }
    else { setTasks(null); setTaskError('Task queue is unavailable. Recheck it before queuing or dispatching a task.'); }
    setReady(true); setLoading(false); setError('');
    leaseEnd.current = started + 5000; window.clearTimeout(leaseTimer.current);
    leaseTimer.current = window.setTimeout(() => { if (Date.now() >= leaseEnd.current) clear('Access could not be rechecked in time. Derived content and unsaved comparisons have been cleared.'); }, Math.max(0, leaseEnd.current - Date.now()));
  }, [token, base, scion.current_revision, clear, markDirty]);
  useEffect(() => {
    void refresh(); const interval = window.setInterval(() => void refresh(), 2000);
    const visibility = () => { if (document.visibilityState !== 'visible') clear('This tab is hidden. Derived content and unsaved comparisons have been cleared.'); else void refresh(true); };
    const offline = () => clear('The page is unavailable or offline. Derived content and unsaved comparisons have been cleared.');
    const online = () => void refresh(true); const focus = () => void refresh();
    const restored = (event: PageTransitionEvent) => { if (event.persisted) void refresh(true); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('offline', offline); window.addEventListener('online', online); window.addEventListener('focus', focus); window.addEventListener('pagehide', offline); window.addEventListener('pageshow', restored);
    return () => {
      generation.current++; pending.current.forEach(controller => controller.abort()); pending.current.clear(); window.clearTimeout(leaseTimer.current); window.clearInterval(interval); onDirty(false);
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('offline', offline); window.removeEventListener('online', online); window.removeEventListener('focus', focus); window.removeEventListener('pagehide', offline); window.removeEventListener('pageshow', restored);
    };
  }, [refresh, clear, onDirty]);
  const epoch = generation.current;
  const current = ready && data?.scion_revision === scion.current_revision;
  const plan = data?.plans.find(item => item.id === selectedId);
  const usablePlan = plan?.status === 'current' && plan.input !== null && current;
  const accessLost = useCallback(() => clear('The selected source or its bytes are no longer available. Derived content and unsaved comparisons have been cleared.'), [clear]);
  function discard() { if (dirty.current && !window.confirm('Discard this unsaved evidence comparison?')) return false; markDirty(false); return true; }
  function openPlan(id: string) { if (!discard()) return; selectedRef.current = id; setSelectedId(id); setComposing(false); void refresh(true); }
  async function queue(event: FormEvent) {
    event.preventDefault(); if (!current || !synthetic || queueBusy || !scion.revision.product_description?.trim()) return;
    setQueueBusy(true); setError('');
    try {
      await write<AgentTask>(`${base}/agent-tasks`, { task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, timeout_seconds: timeoutSeconds }, scion.current_revision);
      if (epoch !== generation.current || Date.now() >= leaseEnd.current) return;
      setNotice('Capability planning task queued. Dispatch it below to let your local Codex CLI prepare a proposal for this exact intake revision.');
      await refresh(true);
    } catch (failure) { if (epoch === generation.current) { setError(errorText(failure)); if (lostAccess(failure)) accessLost(); } }
    finally { setQueueBusy(false); }
  }
  async function saved() {
    if (epoch !== generation.current || Date.now() >= leaseEnd.current || document.visibilityState !== 'visible') return;
    markDirty(false); setComposing(false); setNotice('Evidence comparison draft saved. Its alternatives, claims and gaps remain unverified; no approval or ranking was created.'); await refresh(true);
  }
  return <section className="scope-workspace" aria-label="Adaptive Scion capability planning">
    <div className="scope-toolbar"><div><p className="eyebrow">FROM HANDLER INTENT TO REVIEWABLE EVIDENCE</p><h2>Capability plan</h2><p>Start from your product description. Your coding agent can propose what the product needs and which evidence is still missing.</p></div><span className="badge">Synthetic proposals · no approval</span></div>
    <div className="scope-boundary"><strong>Plans and comparisons stay bound to one Scion revision.</strong><p>Agent output is a proposal. Authorized source claims remain unverified. This flow creates no vendor listings, prices, physical scope confirmation, or sourcing approval.</p></div>
    {error && <div className="error-message" role="alert"><div>{error}<button type="button" className="text-button" onClick={() => void refresh(true)}>Recheck access</button></div></div>}
    {notice && <div className="info-notice" role="status">{notice}</div>}
    {loading && <p role="status">Reading enabled connectors and revision-bound proposals…</p>}
    {ready && data && <>
      {!current && <div className="info-notice"><p>The intake is now at revision {data.scion_revision}. Reopen the case before preparing new work.</p><button className="button secondary" onClick={() => window.location.reload()}>Reopen current case</button></div>}
      <section className="scope-card adaptive-intake"><p className="eyebrow">HANDLER-PROVIDED STARTING POINT · REVISION {scion.current_revision}</p><h3>Product description</h3>{scion.revision.product_description ? <blockquote>{scion.revision.product_description}</blockquote> : <p className="scope-gap">Product description missing. Edit the intake and describe the product in your own words before queuing a plan.</p>}<p className="field-help">Unspecified requirements stay missing. The agent receives this saved intake revision and the actual local connector registry.</p>
        <form onSubmit={queue}><label className="scope-attestation"><input type="checkbox" checked={synthetic} onChange={event => setSynthetic(event.target.checked)} disabled={!current || !canWrite || queueBusy} /><span>This Scion describes a synthetic test product. Prepare a capability proposal without treating assumptions as facts.</span></label><div className="adaptive-queue-controls"><label htmlFor="capability-timeout">Runtime limit · seconds<input id="capability-timeout" type="number" min={30} max={300} step={1} value={timeoutSeconds} onChange={event => setTimeoutSeconds(Number(event.target.value))} disabled={queueBusy} /></label><button className="button primary" disabled={!current || !canWrite || !synthetic || !scion.revision.product_description?.trim() || tasks === null || queueBusy}>{queueBusy ? 'Queuing…' : 'Queue capability plan with Codex CLI'}</button></div></form>
      </section>
      <section className="scope-card"><div className="section-heading"><h3>Enabled data connectors</h3><span className="badge">Reported by the Rust API</span></div><p className="section-description">These are local data capabilities available to this organization. A coding agent adapter is separate from a data connector.</p><div className="adaptive-connectors">{data.connectors.map(connector => <article key={connector.id}><h4>{connector.name}</h4><span className="badge">{connector.enabled ? 'Enabled' : 'Disabled'} · {connector.status}</span><p>{connector.description}</p><p className="field-help">Connector ID <code>{connector.id}</code></p></article>)}</div><p className="scope-gap">External data connectors are unavailable. No provider catalog, supplier search or external website evidence has been fetched.</p><Gaps items={data.unresolved_gaps} /></section>
      <section className="scope-card"><div className="section-heading"><h3>Immutable capability proposals</h3><span className="badge">{data.plans.length} recorded</span></div>{data.plans.length === 0 ? <p className="scope-empty">No capability proposal yet. Queue and dispatch a task below; completed agent output appears here for review.</p> : <><label htmlFor="capability-plan-choice">Recorded proposal</label><select id="capability-plan-choice" value={selectedId ?? ''} onChange={event => openPlan(event.target.value)}>{data.plans.map(item => <option key={item.id} value={item.id}>Scion revision {item.scion_revision} · {item.status === 'stale' ? 'Stale' : 'Current proposal'} · {when(item.created_at)}</option>)}</select>{plan && <PlanRecord plan={plan} />}</>}</section>
      <section className="adaptive-comparisons"><div className="section-heading"><div><h3>Evidence comparison drafts</h3><p className="section-description">Compare Handler-named alternatives against proposed capabilities using exact source claims. Missing support stays visible.</p></div><button type="button" className="button secondary" disabled={!canWrite || !usablePlan || composing} onClick={() => { if (discard()) setComposing(true); }}>Prepare evidence comparison</button></div><p className="field-help">This is a review worksheet. It does not compare vendors, choose a winner, verify claims or approve an implementation.</p>
        {composing && plan?.input && usablePlan && <ComparisonForm key={plan.id} token={token} scion={scion} plan={plan} sources={sources} onDirty={markDirty} onSources={onSources} onAccessLost={accessLost} onCancel={() => { if (discard()) setComposing(false); }} onSaved={saved} />}
        {data.comparisons.length === 0 && <p className="scope-empty">No evidence comparison recorded. Alternative labels and evidence are never generated to fill this space.</p>}
        {data.comparisons.map(comparison => <ComparisonRecord key={comparison.id} comparison={comparison} plan={data.plans.find(item => item.id === comparison.plan_id)} />)}
      </section>
    </>}
    <AgentTasks token={token} scionId={scion.id} currentRevision={data?.scion_revision ?? scion.current_revision} canWrite={canWrite && current && !composing} tasks={tasks} error={taskError} onOpen={(id, kind) => kind === 'prepare_capability_plan' ? openPlan(id) : kind === 'prepare_physical_scope' ? onScopeProposal(id) : onOfferProposal(id)} onChanged={() => refresh(true)} />
    <p className="scope-footnote">Access is rechecked every 2 seconds while visible. Hidden, offline or expired access clears source-dependent content and unsaved comparisons; the permission lease is at most 5 seconds from the start of a successful check.</p>
  </section>;
}

function PlanRecord({ plan }: { plan: CapabilityPlan }) {
  return <div><div className="section-heading"><p className="section-description">Scion revision {plan.scion_revision} · {when(plan.created_at)}</p><span className={`badge ${plan.status === 'stale' ? 'scope-status-blocked' : ''}`}>{plan.status === 'stale' ? 'Stale · content withheld' : 'Agent proposal · unverified'}</span></div>{plan.status !== 'current' || !plan.input ? <p className="scope-gap">The intake changed. This proposal is retained as an immutable audit record; prepare a new plan for the current revision.</p> : <><p>{plan.input.summary}</p><ol className="adaptive-plan-list">{plan.input.capabilities.map(capability => <li key={capability.key}><h4>{capability.title}</h4><p>{capability.reason}</p><strong>Evidence needed</strong><Gaps items={capability.evidence_needed} /><p className="field-help">Proposed connectors: {capability.connector_ids.length ? capability.connector_ids.join(', ') : 'None · data access missing'}</p></li>)}</ol><h4>Unresolved plan gaps</h4><Gaps items={plan.input.unresolved_gaps} /><p className="field-help">Preparation note: {plan.input.change_summary}</p></>}<details className="revision-details"><summary>Proposal provenance</summary><dl><dt>Plan ID</dt><dd><code>{plan.id}</code></dd><dt>Agent task ID</dt><dd><code>{plan.agent_task_id}</code></dd><dt>Recorded by principal</dt><dd><code>{plan.created_by}</code></dd></dl></details></div>;
}

type Alternative = { label: string; claims: Record<string, ScopeReference[]> };
function ComparisonForm({ token, scion, plan, sources, onDirty, onSources, onAccessLost, onCancel, onSaved }: {
  token: string; scion: Scion; plan: CapabilityPlan; sources: SourceSummary[]; onDirty: (dirty: boolean) => void; onSources: () => void; onAccessLost: () => void; onCancel: () => void; onSaved: () => Promise<void>;
}) {
  const [alternatives, setAlternatives] = useState<Alternative[]>([{ label: '', claims: {} }, { label: '', claims: {} }]);
  const [activeAlternative, setActiveAlternative] = useState(0); const [criterion, setCriterion] = useState(plan.input?.capabilities[0]?.key ?? '');
  const [gaps, setGaps] = useState(''); const [summary, setSummary] = useState(''); const [synthetic, setSynthetic] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [stale, setStale] = useState(false);
  const write = useScopeWrite(token); const capabilities = plan.input?.capabilities ?? [];
  const eligible = sources.filter(source => source.synthetic && source.rights_status === 'granted' && source.scion_revision === scion.current_revision && source.claim_count > 0);
  const referenceKey = JSON.stringify(alternatives.flatMap(alternative => Object.values(alternative.claims).flat()));
  useEffect(() => {
    if (alternatives.some(alternative => Object.values(alternative.claims).flat().some(reference => !eligible.some(source => source.id === reference.source_id && source.current_revision === reference.source_revision)))) onAccessLost();
  }, [alternatives, sources, scion.current_revision, onAccessLost]);
  // Recheck every assigned source, including one no longer selected in the picker.
  // A missing object must also clear unsaved source-derived comparison content.
  useEffect(() => {
    const references = JSON.parse(referenceKey) as ScopeReference[];
    if (!references.length) return;
    let alive = true; let inFlight = false; let lease: number | undefined;
    const controllers = new Set<AbortController>();
    const recheck = async () => {
      if (!alive || inFlight) return;
      inFlight = true; const started = Date.now();
      try {
        await Promise.all([...new Set(references.map(reference => reference.source_id))].map(async sourceId => {
          const controller = new AbortController(); controllers.add(controller);
          const timer = window.setTimeout(() => controller.abort(), 2000);
          try {
            const detail = await request<SourceDetail>(token, `/scions/${scion.id}/sources/${sourceId}`, { cache: 'no-store', signal: controller.signal });
            if (detail.source.rights_status !== 'granted' || detail.source.scion_revision !== scion.current_revision || references.filter(reference => reference.source_id === sourceId).some(reference => {
              const revision = detail.revisions.find(item => item.number === reference.source_revision);
              const claim = detail.claims.find(item => item.id === reference.claim_id);
              return detail.source.current_revision !== reference.source_revision || !revision || revision.content_sha256 !== reference.content_sha256 || !claim || claim.source_revision !== reference.source_revision || claim.locator.start_byte !== reference.start_byte || claim.locator.end_byte !== reference.end_byte;
            })) throw new Error('Assigned source access changed.');
          } finally { window.clearTimeout(timer); controllers.delete(controller); }
        }));
        if (!alive) return;
        if (Date.now() >= started + 5000) { onAccessLost(); return; }
        window.clearTimeout(lease); lease = window.setTimeout(() => { if (alive) onAccessLost(); }, Math.max(0, started + 5000 - Date.now()));
      } catch { if (alive) onAccessLost(); }
      finally { inFlight = false; }
    };
    void recheck(); const interval = window.setInterval(() => void recheck(), 2000);
    return () => { alive = false; window.clearInterval(interval); window.clearTimeout(lease); controllers.forEach(controller => controller.abort()); };
  }, [referenceKey, token, scion.id, scion.current_revision, onAccessLost]);
  function assign(reference: ScopeReference) {
    if (!criterion) return;
    setAlternatives(previous => previous.map((alternative, index) => index !== activeAlternative ? alternative : { ...alternative, claims: { ...alternative.claims, [criterion]: [...(alternative.claims[criterion] ?? []).filter(item => item.claim_id !== reference.claim_id), reference] } })); onDirty(true);
  }
  function remove(alternativeIndex: number, capabilityKey: string, claimId: string) {
    setAlternatives(previous => previous.map((alternative, index) => index !== alternativeIndex ? alternative : { ...alternative, claims: { ...alternative.claims, [capabilityKey]: (alternative.claims[capabilityKey] ?? []).filter(item => item.claim_id !== claimId) } })); onDirty(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || stale || !synthetic) return;
    const labels = alternatives.map(alternative => alternative.label.trim());
    if (labels.some(label => !label) || new Set(labels.map(label => label.toLowerCase())).size !== labels.length || !summary.trim()) { setError('Enter distinct alternative labels and a change summary. Unsupported criteria may remain empty.'); return; }
    const input: EvidenceComparisonInput = { synthetic: true, plan_id: plan.id, alternatives: alternatives.map((alternative, index) => ({ label: labels[index], criteria: capabilities.map(capability => ({ capability_key: capability.key, claim_ids: (alternative.claims[capability.key] ?? []).map(reference => reference.claim_id) })) })), unresolved_gaps: gaps.split('\n').map(value => value.trim()).filter(Boolean), change_summary: summary.trim() };
    setBusy(true); setError('');
    try { await write<EvidenceComparison>(`/scions/${scion.id}/evidence-comparisons`, input, scion.current_revision); await onSaved(); }
    catch (failure) { setError(errorText(failure)); setStale(failure instanceof ApiError && failure.status === 412); if (lostAccess(failure)) onAccessLost(); }
    finally { setBusy(false); }
  }
  return <form className="scope-form adaptive-comparison" onSubmit={save}><fieldset disabled={busy || stale}><section className="scope-card"><h3>Prepare a synthetic evidence comparison</h3><p className="section-description">Use descriptions of your own alternatives, such as implementation approaches. Every capability starts without support; select only source claims the Handler is authorized to inspect.</p><p className="field-help">Hiding this tab or losing permission clears this form. No prices, scores or vendor identities are generated.</p><label className="scope-attestation"><input type="checkbox" checked={synthetic} onChange={event => { setSynthetic(event.target.checked); onDirty(true); }} required /><span>All alternatives and evidence in this worksheet are synthetic. This comparison is for review only.</span></label><div className="adaptive-alternatives">{alternatives.map((alternative, index) => <div className="adaptive-alternative" key={index}><label htmlFor={`adaptive-alternative-${index}`}>Alternative {index + 1} · Handler-entered label</label><input id={`adaptive-alternative-${index}`} value={alternative.label} maxLength={160} required onChange={event => { setAlternatives(previous => previous.map((item, at) => at === index ? { ...item, label: event.target.value } : item)); onDirty(true); }} />{capabilities.map(capability => <div className="adaptive-criterion" key={capability.key}><strong>{capability.title}</strong>{(alternative.claims[capability.key] ?? []).length === 0 ? <p className="scope-gap">No claim linked · evidence gap</p> : alternative.claims[capability.key].map(reference => <div className="adaptive-reference" key={reference.claim_id}><p className="field-help">Claim <code>{reference.claim_id}</code><br />Source revision {reference.source_revision} · UTF-8 [{reference.start_byte}, {reference.end_byte})</p><button className="text-button" type="button" onClick={() => remove(index, capability.key, reference.claim_id)}>Remove</button></div>)}</div>)}</div>)}</div>{alternatives.length < 6 && <button className="button secondary" type="button" onClick={() => { setAlternatives(previous => [...previous, { label: '', claims: {} }]); onDirty(true); }}>Add alternative</button>}</section>
      <section className="scope-card"><h3>Inspect and assign an exact source claim</h3><div className="scope-form-grid"><div><label htmlFor="adaptive-target">Assign to alternative</label><select id="adaptive-target" value={activeAlternative} onChange={event => setActiveAlternative(Number(event.target.value))}>{alternatives.map((alternative, index) => <option value={index} key={index}>{alternative.label.trim() || `Alternative ${index + 1}`}</option>)}</select></div><div><label htmlFor="adaptive-criterion">Proposed capability</label><select id="adaptive-criterion" value={criterion} onChange={event => setCriterion(event.target.value)}>{capabilities.map(capability => <option key={capability.key} value={capability.key}>{capability.title}</option>)}</select></div></div>{eligible.length ? <ClaimSelector token={token} scionId={scion.id} sources={eligible} onAccessLost={onAccessLost} onAssign={assign} singleAssignmentLabel="Link this exact unverified claim" /> : <p className="scope-gap">No permitted current synthetic source with a claim is available. The comparison can record this gap. <button className="text-button" type="button" onClick={onSources}>Open sources and claims</button></p>}</section>
      <section className="scope-card"><label htmlFor="adaptive-gaps">Additional unresolved gaps · one per line</label><textarea id="adaptive-gaps" rows={3} maxLength={12000} value={gaps} onChange={event => { setGaps(event.target.value); onDirty(true); }} /><p className="field-help">The API also records unsupported criteria as explicit gaps.</p><label htmlFor="adaptive-summary">Comparison change summary</label><input id="adaptive-summary" required maxLength={1000} value={summary} onChange={event => { setSummary(event.target.value); onDirty(true); }} /></section>
      {error && <div className="error-message" role="alert">{error}</div>}{stale && <p className="scope-gap">The intake changed. Reopen its current revision before preparing a new comparison.</p>}<div className="scope-form-actions"><button type="button" className="button secondary" onClick={onCancel}>Cancel</button><button className="button primary" disabled={!synthetic}>{busy ? 'Saving…' : 'Save evidence comparison draft'}</button></div>
    </fieldset></form>;
}

function ComparisonRecord({ comparison, plan }: { comparison: EvidenceComparison; plan?: CapabilityPlan }) {
  const input = comparison.status === 'reviewable' ? comparison.input : null;
  return <section className="scope-card adaptive-comparison"><div className="section-heading"><h3>Evidence comparison · revision {comparison.scion_revision}</h3><span className={`badge ${!input ? 'scope-status-blocked' : ''}`}>{input ? 'Reviewable draft · unverified' : 'Blocked · content withheld'}</span></div><p className="section-description">Recorded {when(comparison.created_at)}. Reviewable means the evidence can be inspected; it is not verification or approval.</p>{!input ? <p className="scope-gap">{blockedExplanation(comparison.blocked_reason)}</p> : <><div className="adaptive-alternatives">{input.alternatives.map((alternative, index) => <article className="adaptive-alternative" key={index}><h4>{alternative.label}</h4>{alternative.criteria.map(criterion => <div className="adaptive-criterion" key={criterion.capability_key}><strong>{plan?.input?.capabilities.find(capability => capability.key === criterion.capability_key)?.title || criterion.capability_key}</strong>{criterion.claim_ids.length === 0 ? <p className="scope-gap">No authorized claim linked · support missing</p> : criterion.claim_ids.map(id => {
      const evidence = comparison.evidence.find(item => item.id === id);
      return evidence ? <div key={id}><p>{evidence.statement}</p><blockquote>{evidence.locator.quote}</blockquote><p className="field-help">Unverified Handler claim · source revision {evidence.source_revision} · UTF-8 [{evidence.locator.start_byte}, {evidence.locator.end_byte})<br />Source <code>{evidence.source_id}</code><br />SHA-256 <code>{evidence.content_sha256}</code></p></div> : <p className="scope-gap" key={id}>Claim content unavailable · do not infer support.</p>;
    })}</div>)}</article>)}</div><h4>Unresolved evidence gaps</h4><Gaps items={comparison.unresolved_gaps} /><p className="field-help">Handler note: {input.change_summary}</p></>}<details className="revision-details"><summary>Immutable comparison identifiers</summary><dl><dt>Comparison ID</dt><dd><code>{comparison.id}</code></dd><dt>Plan ID</dt><dd><code>{comparison.plan_id}</code></dd><dt>Recorded by principal</dt><dd><code>{comparison.created_by}</code></dd>{comparison.blocked_reason && <><dt>Access check code</dt><dd><code>{comparison.blocked_reason}</code></dd></>}</dl></details></section>;
}
