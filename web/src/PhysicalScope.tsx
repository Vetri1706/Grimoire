import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiError, request } from './api';
import { useCaseInvalidation } from './control-api';
import type { Scion } from './api';
import type { SourceDetail, SourceList, SourceSummary } from './evidence-api';
import { scopeKinds } from './scope-api';
import type { AgentTask, AgentTaskList, ScopeConfirmation, ScopeInput, ScopeKind, ScopeList, ScopeProposal, ScopeReference } from './scope-api';
import './physical-scope.css';
import AgentTasks from './AgentTasks';

const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const failureText = (error: unknown) => error instanceof ApiError && error.status === 0 ? 'The local API could not be reached. Scope content and unsaved scope forms have been cleared.' : error instanceof Error ? error.message : 'The request failed.';
const labels: Record<ScopeKind, string> = { configuration: 'Product configuration', component: 'Component identity', occurrence: 'Exact BOM occurrence', requirement: 'Controlled requirement' };
const bindingBlocked = (proposal: ScopeProposal) => proposal.status === 'blocked' || proposal.blockers.length > 0 || proposal.input === null;
const proposalStatus = (proposal: ScopeProposal) => bindingBlocked(proposal)
  ? proposal.confirmation ? 'Binding blocked · confirmation retained' : 'Blocked for confirmation'
  : proposal.confirmation ? 'Synthetic confirmation recorded' : 'Awaiting independent review';
function Failure({ children }: { children: ReactNode }) { return <div className="error-message" role="alert"><div>{children}</div></div>; }

// An uncertain retry reuses its key. A confirmed successful command retires it
// so a later, explicit submission can create new work even with the same input.
export function useScopeWrite(token: string) {
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const pending = useRef(new Set<AbortController>());
  useEffect(() => {
    const controllers = pending.current;
    return () => { controllers.forEach(controller => controller.abort()); controllers.clear(); };
  }, []);
  return async <T,>(path: string, input: unknown, revision: number): Promise<T> => {
    const body = JSON.stringify(input);
    const signature = JSON.stringify([path, revision, body]);
    if (retry.current?.signature !== signature) retry.current = { signature, key: crypto.randomUUID() };
    const command = retry.current;
    const controller = new AbortController();
    pending.current.add(controller);
    const timer = window.setTimeout(() => controller.abort(), 10000);
    try {
      const result = await request<T>(token, path, { method: 'POST', body, signal: controller.signal, cache: 'no-store', headers: { 'Idempotency-Key': command.key, 'If-Match': `"${revision}"` } });
      if (retry.current === command) retry.current = null;
      return result;
    }
    finally { window.clearTimeout(timer); pending.current.delete(controller); }
  };
}

export default function PhysicalScope({ token, scion, principalId, canWrite, onDirty, onSources, onOfferProposal, onCapabilityProposal, preferredProposalId }: {
  token: string; scion: Scion; principalId: string; canWrite: boolean; onDirty: (value: boolean) => void; onSources: () => void; onOfferProposal: (id: string) => void; onCapabilityProposal: (id: string) => void; preferredProposalId: string | null;
}) {
  const [scope, setScope] = useState<ScopeList | null>(null);
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [tasks, setTasks] = useState<AgentTask[] | null>(null);
  const [taskError, setTaskError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(preferredProposalId);
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(composing);
  composingRef.current = composing;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [accessReady, setAccessReady] = useState(false);
  const selectedRef = useRef<string | null>(preferredProposalId);
  const pending = useRef(new Set<AbortController>());
  const generation = useRef(0);
  const leaseTimer = useRef<number | undefined>(undefined);
  const leaseEnd = useRef(0);
  const dirty = useRef(false);
  const base = `/scions/${scion.id}`;
  const markDirty = useCallback((value: boolean) => { dirty.current = value; onDirty(value); }, [onDirty]);
  const clear = useCallback((reason: string) => {
    generation.current++;
    pending.current.forEach(controller => controller.abort()); pending.current.clear();
    window.clearTimeout(leaseTimer.current); leaseEnd.current = 0;
    setScope(null); setSources([]); setTasks(null); setComposing(false); setAccessReady(false); setLoading(false);
    markDirty(false); setError(reason);
  }, [markDirty]);
  useCaseInvalidation(scion.id, clear);
  const refresh = useCallback(async (force = false) => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) {
      clear('Scope access is paused while this tab is hidden or offline. Scope content and unsaved forms have been cleared.'); return;
    }
    if (pending.current.size && !force) return;
    if (force) { generation.current++; pending.current.forEach(controller => controller.abort()); pending.current.clear(); }
    const current = generation.current;
    const started = Date.now();
    const read = async <T,>(path: string): Promise<T> => {
      const controller = new AbortController(); pending.current.add(controller);
      const timer = window.setTimeout(() => controller.abort(), 2000);
      try { return await request<T>(token, path, { cache: 'no-store', signal: controller.signal }); }
      finally { window.clearTimeout(timer); pending.current.delete(controller); }
    };
    const [scopeResult, sourceResult, taskResult] = await Promise.allSettled([
      read<ScopeList>(`${base}/scope`), read<SourceList>(`${base}/sources`), read<AgentTaskList>(`${base}/agent-tasks`),
    ]);
    if (current !== generation.current) return;
    if (scopeResult.status === 'rejected' || sourceResult.status === 'rejected') {
      clear(failureText(scopeResult.status === 'rejected' ? scopeResult.reason : sourceResult.status === 'rejected' ? sourceResult.reason : undefined)); return;
    }
    if (Date.now() >= started + 5000 || document.visibilityState !== 'visible' || !navigator.onLine) { clear('Scope access expired. Content and unsaved forms have been cleared.'); return; }
    setScope(scopeResult.value); setSources(sourceResult.value.sources);
    if (!scopeResult.value.can_propose && composingRef.current) { setComposing(false); markDirty(false); }
    if (taskResult.status === 'fulfilled') { setTasks(taskResult.value.tasks); setTaskError(''); }
    else { setTasks(null); setTaskError('Task queue status is unavailable. A local bridge connection has not been established by this screen.'); }
    const preferred = scopeResult.value.proposals.find(proposal => proposal.id === selectedRef.current) ?? scopeResult.value.proposals[0];
    if (preferred) { selectedRef.current = preferred.id; setSelectedId(preferred.id); }
    else { selectedRef.current = null; setSelectedId(null); }
    setAccessReady(true); setLoading(false); setError('');
    leaseEnd.current = started + 5000;
    window.clearTimeout(leaseTimer.current);
    leaseTimer.current = window.setTimeout(() => { if (Date.now() >= leaseEnd.current) clear('Scope access expired before it could be rechecked. Content and unsaved forms have been cleared.'); }, Math.max(0, leaseEnd.current - Date.now()));
  }, [base, token, clear, markDirty]);
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2000);
    const visibility = () => { if (document.visibilityState !== 'visible') clear('This tab is hidden. Scope content and unsaved forms have been cleared.'); else void refresh(true); };
    const focus = () => void refresh();
    const offline = () => clear('The browser is offline. Scope content and unsaved forms have been cleared.');
    const online = () => void refresh(true);
    const restored = (event: PageTransitionEvent) => { if (event.persisted) void refresh(true); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', focus); window.addEventListener('offline', offline); window.addEventListener('online', online); window.addEventListener('pagehide', offline); window.addEventListener('pageshow', restored);
    return () => {
      generation.current++; pending.current.forEach(controller => controller.abort()); pending.current.clear(); window.clearTimeout(leaseTimer.current); window.clearInterval(interval); leaseEnd.current = 0; onDirty(false);
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus); window.removeEventListener('offline', offline); window.removeEventListener('online', online); window.removeEventListener('pagehide', offline); window.removeEventListener('pageshow', restored);
    };
  }, [refresh, clear, onDirty]);

  const epoch = generation.current;
  const proposal = scope?.proposals.find(item => item.id === selectedId);
  const physical = scion.revision.product_category === 'physical';
  const canPropose = physical && canWrite && scope?.can_propose === true && accessReady;
  function discard() { if (dirty.current && !window.confirm('Discard this unsaved physical scope edit?')) return false; markDirty(false); return true; }
  function openProposal(id: string) { if (!discard()) return; selectedRef.current = id; setSelectedId(id); setComposing(false); void refresh(true); }
  async function saved(result: ScopeProposal | AgentTask, queued: boolean) {
    if (epoch !== generation.current || Date.now() >= leaseEnd.current || document.visibilityState !== 'visible' || !navigator.onLine) return;
    markDirty(false); setComposing(false);
    if (!queued) { selectedRef.current = result.id; setSelectedId(result.id); }
    setNotice(queued ? 'Candidate queued for the local Codex CLI bridge. Agent completion can produce only a proposal; Engineering Reviewer confirmation is separate.' : 'confirmation' in result && result.confirmation ? 'Synthetic physical scope confirmation recorded. No supplier offer or sourcing decision was created.' : 'Synthetic physical scope proposal saved for independent Engineering Reviewer confirmation.');
    await refresh(true);
  }
  function accessLost() { if (epoch === generation.current) clear('Source access changed or could not be confirmed. Derived scope content and unsaved forms have been cleared.'); }

  return <section className="scope-workspace" aria-label="Physical scope">
    <div className="scope-toolbar"><div><p className="eyebrow">SYNTHETIC ENGINEERING REVIEW</p><h2>Physical scope</h2><p>Pin the product configuration, exact BOM occurrence, component identity, and requirement before independent review.</p></div><button className="button primary" disabled={!canPropose} onClick={() => { if (discard()) { setComposing(true); setNotice(''); } }}>Prepare synthetic proposal</button></div>
    <div className="scope-boundary"><strong>Required authority: synthetic Engineering Reviewer</strong><p>The proposer cannot confirm their own proposal. A local synthetic reviewer identity is for testing; it does not establish qualified authority for a real product. Agent completion never counts as human confirmation or sourcing approval.</p></div>
    {!physical && <div className="info-notice"><p>This Scion is {scion.revision.product_category === 'digital' ? 'digital' : 'not yet categorized'}. Physical scope proposals are unavailable; the intake remains a draft.</p></div>}
    {notice && <div className="success-notice" role="status">{notice}<button aria-label="Dismiss scope notification" onClick={() => setNotice('')}>×</button></div>}
    {error && <Failure>{error} <button className="text-button" onClick={() => void refresh(true)}>Recheck scope access</button></Failure>}
    {loading ? <div className="loading-panel" role="status">Checking physical scope access…</div> : composing && accessReady ? <ScopeForm token={token} scion={scion} sources={sources} onDirty={markDirty} onAccessLost={accessLost} onSources={onSources} onCancel={() => { if (discard()) setComposing(false); }} onSaved={saved} queueAvailable={tasks !== null} /> : scope && accessReady ? <div className="scope-layout">
      <aside className="scope-proposals"><div className="section-heading"><h3>Saved proposals</h3><span className="badge">{scope.proposals.length}</span></div><p className="section-description">Immutable candidates and their exact review outcome.</p>{scope.proposals.length === 0 ? <p className="scope-empty">No scope proposed. Enter synthetic identities and pin the supporting claims; missing values are never generated.</p> : <ol>{scope.proposals.map(item => <li key={item.id}><button className={`scope-proposal-choice ${item.id === selectedId ? 'active' : ''}`} aria-pressed={item.id === selectedId} onClick={() => openProposal(item.id)}><strong>{item.input?.case_title || 'Scope content unavailable'}</strong><span className={bindingBlocked(item) ? 'scope-status-blocked' : ''}>{proposalStatus(item)}</span><span>Scion revision {item.scion_revision} · {when(item.created_at)}</span></button></li>)}</ol>}</aside>
      <div className="scope-detail">{proposal ? <ProposalView key={proposal.id} token={token} scion={scion} proposal={proposal} canConfirm={scope.can_confirm && proposal.can_confirm_this_proposal === true} isProposer={proposal.reviewer_conflict || proposal.created_by === principalId} onDirty={markDirty} onAccessLost={accessLost} onSaved={result => saved(result, false)} /> : <section className="scope-card"><h2>Exact identities come first</h2><p className="section-description">A proposal records explicitly entered synthetic scope. Confirmation requires current source rights, exact locators, no unresolved gaps, and a separate enrolled Engineering Reviewer.</p></section>}</div>
    </div> : null}
    <AgentTasks token={token} scionId={scion.id} currentRevision={scion.current_revision} canWrite={canWrite} tasks={tasks} error={taskError} onOpen={(id, kind) => kind === 'prepare_capability_plan' ? onCapabilityProposal(id) : kind === 'prepare_offer_normalization' ? onOfferProposal(id) : openProposal(id)} onChanged={() => refresh(true)} />
    <p className="scope-footnote">No supplier offer, price, quality release, or sourcing decision is produced here. Source text, Handler claims, and verified facts remain separate; verified facts remain zero.</p>
  </section>;
}

function JsonValue({ value }: { value: Record<string, unknown> }) { return <pre className="scope-json">{JSON.stringify(value, null, 2)}</pre>; }
function EvidenceReference({ reference }: { reference: ScopeReference }) {
  return <div className="scope-reference"><strong>{labels[reference.kind]} evidence</strong><dl><dt>Source revision</dt><dd><code>{reference.source_id}</code> · revision {reference.source_revision}</dd><dt>Handler claim ID</dt><dd><code>{reference.claim_id}</code></dd><dt>Content SHA-256</dt><dd><code>{reference.content_sha256}</code></dd><dt>Exact locator</dt><dd>UTF-8 bytes [{reference.start_byte}, {reference.end_byte}) · zero-based, end excluded</dd></dl><p>Provenance link only. The Engineering Reviewer must assess whether this claim supports this identity.</p></div>;
}

function InputSnapshot({ input, confirmation, blocked = false }: { input: ScopeInput; confirmation?: ScopeConfirmation | null; blocked?: boolean }) {
  const reference = (kind: ScopeKind) => input.source_claims.find(item => item.kind === kind);
  const section = (kind: ScopeKind, children: ReactNode, revision?: string) => <section className="scope-card scope-identity"><div className="section-heading"><h3>{labels[kind]}</h3><span className="badge">{revision ? blocked ? 'Recorded revision · binding blocked' : 'Confirmed synthetic revision' : 'Proposed · no revision allocated'}</span></div>{revision && <p className="scope-revision-id">Revision ID <code>{revision}</code></p>}{children}{reference(kind) ? <EvidenceReference reference={reference(kind)!} /> : <p className="scope-gap">Evidence locator missing.</p>}</section>;
  return <div className="scope-identities">
    {section('configuration', <dl className="scope-values"><dt>Product code</dt><dd>{input.configuration.product_code}</dd><dt>Product name</dt><dd>{input.configuration.product_name}</dd><dt>Configuration code</dt><dd>{input.configuration.configuration_code}</dd><dt>Specification</dt><dd><JsonValue value={input.configuration.specification} /></dd></dl>, confirmation?.configuration_revision_id)}
    {section('component', <dl className="scope-values"><dt>Internal part code</dt><dd>{input.component.internal_part_code}</dd><dt>Manufacturer identity</dt><dd>{input.component.manufacturer}</dd><dt>Orderable part number</dt><dd>{input.component.part_number}</dd><dt>Attributes</dt><dd><JsonValue value={input.component.attributes} /></dd></dl>, confirmation?.component_revision_id)}
    {section('occurrence', <dl className="scope-values"><dt>Exact occurrence path</dt><dd><code>{input.occurrence.path}</code></dd><dt>Quantity</dt><dd>{input.occurrence.quantity}</dd><dt>Unit of measure</dt><dd>{input.occurrence.uom}</dd></dl>, confirmation?.occurrence_revision_id)}
    {section('requirement', <dl className="scope-values"><dt>Requirement code</dt><dd>{input.requirement.code}</dd><dt>Controlled criteria</dt><dd><JsonValue value={input.requirement.criteria} /></dd></dl>, confirmation?.requirement_revision_id)}
  </div>;
}

function ProposalView({ token, scion, proposal, canConfirm, isProposer, onDirty, onAccessLost, onSaved }: {
  token: string; scion: Scion; proposal: ScopeProposal; canConfirm: boolean; isProposer: boolean; onDirty: (value: boolean) => void; onAccessLost: () => void; onSaved: (proposal: ScopeProposal) => Promise<void>;
}) {
  const input = proposal.input;
  return <>
    <section className="scope-card"><div className="section-heading"><div><p className="eyebrow">SAVED SYNTHETIC PROPOSAL</p><h2>{input?.case_title || 'Scope content unavailable'}</h2></div><span className={bindingBlocked(proposal) ? 'badge scope-status-blocked' : 'badge'}>{proposalStatus(proposal)}</span></div><p className="section-description">Pinned to Scion revision {proposal.scion_revision} · {when(proposal.created_at)}</p><details className="revision-details"><summary>Proposal details</summary><dl><dt>Proposal ID</dt><dd><code>{proposal.id}</code></dd><dt>Prepared by principal</dt><dd><code>{proposal.created_by}</code></dd><dt>Proposed case code</dt><dd>{input?.case_code || 'Content withheld'}</dd><dt>Change summary</dt><dd>{input?.change_summary || 'Content withheld'}</dd></dl></details></section>
    <section className="scope-card"><div className="section-heading"><h3>Identity and unresolved gaps</h3><span className="badge">{input?.identity_match === 'exact' ? 'Exact identity proposed' : input?.identity_match === 'ambiguous' ? 'Ambiguous identity' : 'Content withheld'}</span></div>{proposal.blockers.length > 0 && <ul className="scope-blockers">{proposal.blockers.map((blocker, i) => <li key={i}>{blocker}</li>)}</ul>}{input ? input.unresolved_gaps.length > 0 ? <><p className="section-description">Handler-recorded gaps</p><ul className="scope-blockers">{input.unresolved_gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></> : <p className="section-description">No unresolved scope gaps were recorded. This does not replace engineering judgment or establish verified facts.</p> : <p className="scope-gap">Derived scope fields are hidden because source access or integrity is unavailable.</p>}</section>
    {input && <InputSnapshot input={input} confirmation={proposal.confirmation} blocked={bindingBlocked(proposal)} />}
    {proposal.confirmation ? <ConfirmationSnapshot confirmation={proposal.confirmation} blocked={bindingBlocked(proposal)} /> : input && <section className="scope-card scope-review"><p className="eyebrow">SEPARATE HUMAN ACTION</p><h2>Engineering Reviewer confirmation</h2><p className="section-description">Required role: synthetic Engineering Reviewer. Confirmation allocates exact synthetic GG-40 revisions and a linked synthetic sourcing case. It does not authorize sourcing or endorse the truth of every cited statement.</p>{isProposer ? <p className="scope-gap">A different synthetic Engineering Reviewer must confirm work you prepared or queued.</p> : !canConfirm ? <p className="scope-gap">This identity is not permitted to confirm. Sign in as the separately enrolled synthetic Engineering Reviewer to perform this action.</p> : bindingBlocked(proposal) ? <p className="scope-gap">Confirmation is blocked until the listed source, identity, and revision gaps are resolved.</p> : <ConfirmationForm token={token} scion={scion} proposal={proposal} onDirty={onDirty} onAccessLost={onAccessLost} onSaved={onSaved} />}</section>}
  </>;
}

function ConfirmationSnapshot({ confirmation, blocked }: { confirmation: ScopeConfirmation; blocked: boolean }) {
  return <section className="scope-card scope-review"><p className="eyebrow">HUMAN CONFIRMATION RECORD</p><h2>{blocked ? 'Confirmation retained · binding blocked' : 'Synthetic scope confirmation recorded'}</h2>{blocked && <p className="scope-gap">This prior confirmation remains as an audit record. Its binding is currently blocked for the reasons above.</p>}<p className="section-description">This records a local test of engineering authority. It is not sourcing approval, quality release, or real reviewer qualification.</p><dl className="scope-values"><dt>Engineering Reviewer principal</dt><dd><code>{confirmation.confirmed_by}</code></dd><dt>Confirmed</dt><dd>{when(confirmation.confirmed_at)}</dd><dt>Review note</dt><dd>{confirmation.review_note ?? 'Withheld while source access is unavailable'}</dd><dt>Synthetic sourcing case ID</dt><dd><code>{confirmation.sourcing_case_id}</code></dd><dt>Synthetic case revision ID</dt><dd><code>{confirmation.sourcing_case_revision_id}</code></dd></dl></section>;
}

function ConfirmationForm({ token, scion, proposal, onDirty, onAccessLost, onSaved }: {
  token: string; scion: Scion; proposal: ScopeProposal; onDirty: (value: boolean) => void; onAccessLost: () => void; onSaved: (proposal: ScopeProposal) => Promise<void>;
}) {
  const [note, setNote] = useState(''); const [acknowledged, setAcknowledged] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [stale, setStale] = useState(false);
  const write = useScopeWrite(token);
  async function confirm(event: FormEvent) {
    event.preventDefault(); if (!acknowledged || !note.trim() || busy || stale) return;
    setBusy(true); setError('');
    try { await onSaved(await write<ScopeProposal>(`/scions/${scion.id}/scope/proposals/${proposal.id}/confirm`, { confirm_synthetic_scope: true, review_note: note.trim() }, scion.current_revision)); }
    catch (failure) { setError(failureText(failure)); setStale(failure instanceof ApiError && failure.status === 412); if (failure instanceof ApiError && [0, 401, 403, 404, 503].includes(failure.status)) onAccessLost(); }
    finally { setBusy(false); }
  }
  return <form className="scope-confirm-form" onSubmit={confirm}>{error && <Failure>{error}</Failure>}<fieldset disabled={busy || stale}><label htmlFor="scope-review-note">Engineering review rationale</label><textarea id="scope-review-note" rows={4} value={note} onChange={event => { setNote(event.target.value); onDirty(true); }} maxLength={4000} required /><label className="scope-attestation"><input type="checkbox" checked={acknowledged} onChange={event => { setAcknowledged(event.target.checked); onDirty(true); }} required /><span>I independently reviewed this exact synthetic configuration, occurrence, component and requirement, their claim locators, and the absence of unresolved scope gaps. This is a test confirmation, not a sourcing decision.</span></label><button className="button primary" disabled={!acknowledged || !note.trim()}>{busy ? 'Recording confirmation…' : 'Confirm this synthetic physical scope'}</button></fieldset>{stale && <p className="scope-gap">The Scion revision changed. Reopen the current intake and review a current proposal before confirming.</p>}</form>;
}

type Fields = { productCode: string; productName: string; configurationCode: string; specification: string; partCode: string; manufacturer: string; partNumber: string; attributes: string; occurrencePath: string; quantity: string; uom: string; requirementCode: string; criteria: string; caseCode: string; caseTitle: string; identity: '' | 'exact' | 'ambiguous'; gaps: string; summary: string };
const blankFields: Fields = { productCode: '', productName: '', configurationCode: '', specification: '', partCode: '', manufacturer: '', partNumber: '', attributes: '', occurrencePath: '', quantity: '', uom: '', requirementCode: '', criteria: '', caseCode: '', caseTitle: '', identity: '', gaps: '', summary: '' };
function jsonObject(text: string, field: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${field} must be a valid JSON object with explicit synthetic values.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) throw new Error(`${field} must be a nonempty JSON object.`);
  return value as Record<string, unknown>;
}

function ScopeForm({ token, scion, sources, queueAvailable, onDirty, onAccessLost, onSources, onCancel, onSaved }: {
  token: string; scion: Scion; sources: SourceSummary[]; queueAvailable: boolean; onDirty: (value: boolean) => void; onAccessLost: () => void; onSources: () => void; onCancel: () => void; onSaved: (result: ScopeProposal | AgentTask, queued: boolean) => Promise<void>;
}) {
  const [fields, setFields] = useState<Fields>(blankFields); const [references, setReferences] = useState<Partial<Record<ScopeKind, ScopeReference>>>({}); const [synthetic, setSynthetic] = useState(false); const [noGaps, setNoGaps] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [stale, setStale] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState(240);
  const write = useScopeWrite(token);
  const eligible = sources.filter(source => source.rights_status === 'granted' && source.synthetic && source.scion_revision === scion.current_revision && source.claim_count > 0);
  useEffect(() => {
    if (Object.values(references).some(reference => !sources.some(source => source.id === reference.source_id && source.rights_status === 'granted' && source.current_revision === reference.source_revision && source.scion_revision === scion.current_revision))) onAccessLost();
  }, [sources, references, scion.current_revision, onAccessLost]);
  function update<K extends keyof Fields>(key: K, value: Fields[K]) { setFields(previous => ({ ...previous, [key]: value })); onDirty(true); }
  function payload(): ScopeInput {
    if (!synthetic) throw new Error('Explicitly attest that every proposed value is synthetic.');
    if (!fields.identity) throw new Error('Record whether the proposed identity is exact or ambiguous.');
    if (Object.entries(fields).some(([key, value]) => key !== 'gaps' && !value.trim())) throw new Error('Enter every explicit identity, specification, requirement, case identifier, and change summary. Empty values are not generated.');
    const links = scopeKinds.map(kind => { const item = references[kind]; if (!item) throw new Error(`${labels[kind]} needs an exact Handler-claim locator.`); return item; });
    const gaps = fields.gaps.split('\n').map(value => value.trim()).filter(Boolean);
    if (!gaps.length && !noGaps) throw new Error('Record the unresolved scope gaps or explicitly record none.');
    return { synthetic: true, identity_match: fields.identity, configuration: { product_code: fields.productCode.trim(), product_name: fields.productName.trim(), configuration_code: fields.configurationCode.trim(), specification: jsonObject(fields.specification, 'Configuration specification') }, component: { internal_part_code: fields.partCode.trim(), manufacturer: fields.manufacturer.trim(), part_number: fields.partNumber.trim(), attributes: jsonObject(fields.attributes, 'Component attributes') }, occurrence: { path: fields.occurrencePath.trim(), quantity: fields.quantity.trim(), uom: fields.uom.trim() }, requirement: { code: fields.requirementCode.trim(), criteria: jsonObject(fields.criteria, 'Requirement criteria') }, case_code: fields.caseCode.trim(), case_title: fields.caseTitle.trim(), source_claims: links, unresolved_gaps: noGaps ? [] : gaps, change_summary: fields.summary.trim() };
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || stale) return;
    const queued = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'queue';
    setError('');
    let input: ScopeInput; try { input = payload(); } catch (failure) { setError(failureText(failure)); return; }
    setBusy(true);
    try {
      const path = `/scions/${scion.id}/${queued ? 'agent-tasks' : 'scope/proposals'}`;
      const result = await write<ScopeProposal | AgentTask>(path, queued ? { task_kind: 'prepare_physical_scope', candidate_proposal: input, timeout_seconds: timeoutSeconds } : input, scion.current_revision);
      await onSaved(result, queued);
    } catch (failure) { setError(failureText(failure)); setStale(failure instanceof ApiError && failure.status === 412); if (failure instanceof ApiError && [0, 401, 403, 404, 503].includes(failure.status)) onAccessLost(); }
    finally { setBusy(false); }
  }
  const field = (key: keyof Fields, label: string, textarea = false) => <div className="scope-field" key={key}><label htmlFor={`scope-${key}`}>{label}</label>{textarea ? <textarea id={`scope-${key}`} value={fields[key]} onChange={event => update(key, event.target.value as Fields[typeof key])} rows={4} required maxLength={12000} spellCheck={false} /> : <input id={`scope-${key}`} value={fields[key]} onChange={event => update(key, event.target.value as Fields[typeof key])} required maxLength={1000} />}</div>;
  return <form className="scope-form" onSubmit={submit}><fieldset disabled={busy || stale}><section className="scope-card"><h2>Prepare a synthetic physical scope</h2><p className="section-description">Every physical value starts empty. Enter the exact synthetic scope you want reviewed, then choose the claim locator supporting each identity. Saving does not allocate governed revision IDs.</p><p className="field-help">Keep this tab visible while editing. Hiding it, going offline, or losing source access clears unsaved scope content.</p><label className="scope-attestation"><input type="checkbox" checked={synthetic} onChange={event => { setSynthetic(event.target.checked); onDirty(true); }} required /><span>All proposed product, component, occurrence, requirement and case values are synthetic test data.</span></label></section>
    <section className="scope-card"><h3>Product configuration</h3><div className="scope-form-grid">{field('productCode', 'Synthetic product code')}{field('productName', 'Synthetic product name')}{field('configurationCode', 'Exact configuration code')}</div>{field('specification', 'Explicit specification · JSON object', true)}</section>
    <section className="scope-card"><h3>Component identity</h3><div className="scope-form-grid">{field('partCode', 'Synthetic internal part code')}{field('manufacturer', 'Synthetic manufacturer identity')}{field('partNumber', 'Exact synthetic orderable part number')}</div>{field('attributes', 'Explicit component attributes · JSON object', true)}</section>
    <section className="scope-card"><h3>Exact BOM occurrence</h3><div className="scope-form-grid">{field('occurrencePath', 'Exact occurrence path')}{field('quantity', 'Explicit quantity')}{field('uom', 'Unit of measure')}</div><p className="field-help">This is an explicitly entered occurrence. A BOM is never inferred from an empty intake field.</p></section>
    <section className="scope-card"><h3>Controlled requirement</h3>{field('requirementCode', 'Synthetic requirement code')}{field('criteria', 'Explicit controlled criteria · JSON object', true)}</section>
    <section className="scope-card"><h3>Evidence locators</h3><p className="section-description">Choose a current permitted synthetic source and its Handler claim. Assign an exact locator to each scope identity. Reusing a locator records provenance; the reviewer must decide whether the statement supports every assigned use.</p>{eligible.length ? <ClaimSelector token={token} scionId={scion.id} sources={eligible} onAccessLost={onAccessLost} onAssign={reference => { setReferences(previous => ({ ...previous, [reference.kind]: reference })); onDirty(true); }} /> : <p className="scope-gap">No current permitted source with a Handler claim is available for this intake revision. <button type="button" className="text-button" onClick={onSources}>Open sources and claims</button></p>}<div className="scope-reference-list">{scopeKinds.map(kind => references[kind] ? <EvidenceReference key={kind} reference={references[kind]!} /> : <p className="scope-gap" key={kind}>{labels[kind]} · locator missing</p>)}</div></section>
    <section className="scope-card"><h3>Identity and gaps</h3><label htmlFor="scope-identity">Identity match</label><select id="scope-identity" required value={fields.identity} onChange={event => update('identity', event.target.value as Fields['identity'])}><option value="">Choose an explicit assessment</option><option value="exact">Exact identities proposed</option><option value="ambiguous">Ambiguous · cannot be confirmed</option></select><label htmlFor="scope-gaps">Unresolved scope gaps · one per line</label><textarea id="scope-gaps" rows={3} value={fields.gaps} onChange={event => update('gaps', event.target.value)} disabled={noGaps} maxLength={12000} /><label className="scope-attestation"><input type="checkbox" checked={noGaps} onChange={event => { setNoGaps(event.target.checked); onDirty(true); }} /><span>Explicitly record no unresolved scope gaps. Source support and engineering judgment still require independent review.</span></label></section>
    <section className="scope-card"><h3>Proposed synthetic case identity</h3><div className="scope-form-grid">{field('caseCode', 'Synthetic case code')}{field('caseTitle', 'Synthetic case title')}</div>{field('summary', 'Proposal change summary')}<p className="field-help">A linked GG-40 case and exact revisions are created only by separate human confirmation. This proposal creates no supplier offers or sourcing decision.</p></section>
    <section className="scope-card"><label htmlFor="scope-task-timeout">Local Codex task runtime limit · seconds</label><input id="scope-task-timeout" type="number" min={30} max={300} step={1} value={timeoutSeconds} onChange={event => { setTimeoutSeconds(Number(event.target.value)); onDirty(true); }} /><p className="field-help">Used only when queuing. A Handler must dispatch the saved task before it can run; organization concurrency is limited to one running task.</p></section>{error && <Failure>{error}</Failure>}{stale && <p className="scope-gap">The Scion revision changed. Reopen the current intake before preparing a new proposal.</p>}<div className="scope-form-actions"><button className="button secondary" type="button" onClick={onCancel}>Cancel</button><button className="button secondary" type="submit" value="queue" disabled={!synthetic || !queueAvailable}>{busy ? 'Submitting…' : 'Queue with local Codex CLI'}</button><button className="button primary" type="submit" value="direct" disabled={!synthetic}>{busy ? 'Submitting…' : 'Save synthetic proposal'}</button></div><p className="field-help">Both actions submit these explicit fields. The Codex CLI route prepares a proposal through the server queue; it cannot perform reviewer confirmation.</p></fieldset></form>;
}

export function ClaimSelector({ token, scionId, sources, onAccessLost, onAssign, singleAssignmentLabel }: { token: string; scionId: string; sources: SourceSummary[]; onAccessLost: () => void; onAssign: (reference: ScopeReference) => void; singleAssignmentLabel?: string }) {
  const [sourceId, setSourceId] = useState(''); const [detail, setDetail] = useState<SourceDetail | null>(null); const [claimId, setClaimId] = useState(''); const [loading, setLoading] = useState(false);
  const onDenied = useRef(onAccessLost); onDenied.current = onAccessLost;
  useEffect(() => {
    if (!sourceId) { setDetail(null); setClaimId(''); return; }
    let alive = true; let controller: AbortController | null = null; let deadline: number | undefined; let lease: number | undefined;
    const load = async () => {
      if (!alive || controller) return;
      const started = Date.now(); controller = new AbortController(); const signal = controller.signal;
      deadline = window.setTimeout(() => controller?.abort(), 2000);
      try {
        const value = await request<SourceDetail>(token, `/scions/${scionId}/sources/${sourceId}`, { signal, cache: 'no-store' });
        if (!alive) return;
        if (Date.now() >= started + 5000 || value.source.rights_status !== 'granted') { onDenied.current(); return; }
        setDetail(value); setLoading(false);
        window.clearTimeout(lease); lease = window.setTimeout(() => { setDetail(null); onDenied.current(); }, Math.max(0, started + 5000 - Date.now()));
      } catch { if (alive) { setDetail(null); onDenied.current(); } }
      finally { window.clearTimeout(deadline); controller = null; }
    };
    setDetail(null); setClaimId(''); setLoading(true); void load(); const interval = window.setInterval(() => void load(), 2000);
    return () => { alive = false; controller?.abort(); window.clearTimeout(deadline); window.clearTimeout(lease); window.clearInterval(interval); };
  }, [token, scionId, sourceId]);
  const sourceAvailable = sources.some(source => source.id === sourceId && source.rights_status === 'granted' && (!detail || source.current_revision === detail.source.current_revision));
  const revision = sourceAvailable ? detail?.revisions.find(item => item.number === detail.source.current_revision) : undefined;
  const claims = detail?.claims.filter(claim => claim.source_revision === detail.source.current_revision) ?? [];
  const claim = sourceAvailable ? claims.find(item => item.id === claimId) : undefined;
  return <div className="scope-claim-selector"><label htmlFor="scope-source">Current permitted source</label><select id="scope-source" value={sourceId} onChange={event => setSourceId(event.target.value)}><option value="">Select a source to inspect its claim locator</option>{sources.map(source => <option key={source.id} value={source.id}>{source.title} · source revision {source.current_revision}</option>)}</select>{loading && <p className="field-help" role="status">Checking source access and stored bytes…</p>}{detail && <><label htmlFor="scope-claim">Exact Handler claim</label><select id="scope-claim" value={claimId} onChange={event => setClaimId(event.target.value)}><option value="">Select an unverified Handler claim</option>{claims.map(item => <option key={item.id} value={item.id}>{item.id} · UTF-8 [{item.locator.start_byte}, {item.locator.end_byte})</option>)}</select>{claims.length === 0 && <p className="scope-gap">The current source revision has no Handler claim. Record one in Sources and claims.</p>}</>}{claim && revision && <div className="scope-inspected-claim"><p><strong>Unverified Handler claim</strong></p><p>{claim.statement}</p><blockquote>{claim.locator.quote}</blockquote><p className="field-help">Source revision {revision.number} · UTF-8 [{claim.locator.start_byte}, {claim.locator.end_byte}) · SHA-256 <code>{revision.content_sha256}</code></p><div className="scope-bind-actions">{(singleAssignmentLabel ? ['component' as const] : scopeKinds).map(kind => <button key={kind} type="button" className="button secondary" onClick={() => onAssign({ kind, source_id: sourceId, source_revision: revision.number, claim_id: claim.id, content_sha256: revision.content_sha256, start_byte: claim.locator.start_byte, end_byte: claim.locator.end_byte })}>{singleAssignmentLabel || `Use for ${kind}`}</button>)}</div></div>}</div>;
}
