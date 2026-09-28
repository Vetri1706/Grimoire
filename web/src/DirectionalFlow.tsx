import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, request } from './api';
import type { Scion } from './api';
import { parseFlowRoute, reactionForChange, reactionForTask } from './flow-model';
import type { RevisionReaction } from './flow-model';
import type { ComparisonList, ComparisonProposal, OfferList, OfferView } from './offers-api';
import type { ScopeList, ScopeProposal } from './scope-api';
import './directional-flow.css';

type WorkflowData = {
  scope: ScopeList;
  comparisons: ComparisonList;
  offers: OfferList;
  reactions: RevisionReaction[];
};

type LoadState = 'loading' | 'ready' | 'error' | 'denied' | 'offline';
type Navigate = (route: string) => void;
type StatusKind = 'current' | 'required' | 'stale' | 'blocked' | 'completed' | 'restricted' | 'unknown';

const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const byNewest = <T extends { created_at: string }>(items: T[]) => [...items].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
const isScopeUsable = (proposal: ScopeProposal) => Boolean(proposal.confirmation && proposal.input && proposal.status === 'confirmed' && !proposal.computed_stale && proposal.blockers.length === 0);
const isComparisonUsable = (proposal: ComparisonProposal) => Boolean(proposal.confirmation && proposal.input && proposal.snapshot && proposal.status === 'confirmed' && !proposal.computed_stale && proposal.blockers.length === 0 && !proposal.content_redacted);
const labelProposalKind = (kind: string) => kind === 'offer_comparison' ? 'Comparison' : kind === 'physical_scope' ? 'Exact scope' : 'Recorded conclusion';

function StatusChip({ kind, children }: { kind: StatusKind; children: ReactNode }) {
  const mark = kind === 'completed' || kind === 'current' ? '✓' : kind === 'restricted' ? '▣' : kind === 'unknown' ? '?' : '!';
  return <span className={`flow-status flow-status-${kind}`}><span aria-hidden="true">{mark}</span>{children}</span>;
}

function DetailsDisclosure({ title = 'Evidence and pinned IDs', children }: { title?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  function closed() { setOpen(false); trigger.current?.focus(); }
  return <>
    <button ref={trigger} className="flow-details-trigger" type="button" onClick={() => setOpen(true)} aria-haspopup="dialog">{title}<span aria-hidden="true">→</span></button>
    <dialog ref={dialog} className="flow-details" aria-labelledby="flow-details-title" onClose={closed} onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
      <div className="flow-details-panel">
        <header><div><p className="eyebrow">INSPECTABLE RECORD</p><h2 id="flow-details-title">Details</h2></div><button className="flow-close" type="button" onClick={() => dialog.current?.close()} aria-label="Close details">×</button></header>
        <div className="flow-details-body">{children}</div>
      </div>
    </dialog>
  </>;
}

function StatePanel({ variant, title, body, action }: { variant: 'empty' | 'error' | 'denied' | 'offline' | 'complete'; title: string; body: string; action?: ReactNode }) {
  return <section className={`flow-state flow-state-${variant}`} aria-labelledby={`flow-state-${variant}`} role={variant === 'error' ? 'alert' : 'status'}>
    <span className="flow-state-mark" aria-hidden="true">{variant === 'complete' ? '✓' : variant === 'denied' ? '▣' : '!'}</span>
    <h2 id={`flow-state-${variant}`}>{title}</h2><p>{body}</p>{action && <div>{action}</div>}
  </section>;
}

function LoadingFlow({ label, onRetry }: { label: string; onRetry: () => void }) {
  const [elapsed, setElapsed] = useState<'initial' | 'label' | 'long'>('initial');
  useEffect(() => {
    const labelTimer = window.setTimeout(() => setElapsed('label'), 400);
    const longTimer = window.setTimeout(() => setElapsed('long'), 10_000);
    return () => { window.clearTimeout(labelTimer); window.clearTimeout(longTimer); };
  }, []);
  return <div className="flow-loading" role="status" aria-live="polite"><span className="sr-only">{label}</span><div className="flow-skeleton flow-skeleton-context" /><div className="flow-skeleton flow-skeleton-title" /><div className="flow-skeleton flow-skeleton-card" />{elapsed !== 'initial' && <div className="flow-loading-message"><strong>{elapsed === 'long' ? 'This is taking longer than expected' : label}</strong>{elapsed === 'long' && <button className="button secondary" type="button" onClick={onRetry}>Retry</button>}</div>}</div>;
}

function ActionFooter({ backLabel, onBack, primary }: { backLabel: string; onBack: () => void; primary?: { label: string; onClick: () => void } }) {
  return <footer className="flow-action-footer"><button className="flow-back" type="button" onClick={onBack}>← {backLabel}</button>{primary && <button className="button primary" type="button" onClick={primary.onClick}>{primary.label} <span aria-hidden="true">→</span></button>}</footer>;
}

function ContextStrip({ scion, reaction, status }: { scion: Scion; reaction: RevisionReaction | null; status: StatusKind }) {
  return <section className="case-context-strip" aria-label="Case context">
    <div><strong>{scion.revision.name}</strong><span>{reaction ? 'Event 2' : 'Event 1'} · Scion r{scion.current_revision}</span></div>
    <div><span>{reaction ? `Changed from Scion r${reaction.proposal_scion_revision}` : 'Current case revision'}</span><StatusChip kind={status}>{status === 'required' ? 'Review required' : status === 'stale' ? 'Stale' : status === 'blocked' ? 'Blocked' : status === 'completed' ? 'Complete' : status === 'restricted' ? 'Restricted' : status === 'unknown' ? 'Freshness unknown' : 'Current'}</StatusChip></div>
  </section>;
}

function CaseProgress({ scionId, scope, comparison, reaction, active, navigate }: { scionId: string; scope: ScopeProposal | null; comparison: ComparisonProposal | null; reaction: RevisionReaction | null; active: string; navigate: Navigate }) {
  const steps: Array<{ key: string; label: string; route: string | null; state: string }> = [
    { key: 'context', label: 'Context', route: `/scions/${scionId}/context`, state: 'complete' },
    { key: 'scope', label: 'Scope', route: scope ? `/scions/${scionId}/scope/${scope.id}` : `/scions/${scionId}/workbench/scope`, state: scope?.computed_stale ? 'stale' : scope ? 'complete' : 'unavailable' },
    { key: 'comparison', label: 'Offers', route: comparison ? `/scions/${scionId}/comparisons/${comparison.id}` : scope ? `/scions/${scionId}/workbench/offers` : null, state: comparison?.computed_stale ? 'stale' : comparison ? 'complete' : 'unavailable' },
    { key: 'decision', label: 'Decision', route: comparison ? `/scions/${scionId}/decisions/new?comparison=${comparison.id}` : null, state: reaction ? 'blocked' : comparison?.confirmation ? 'current' : 'unavailable' },
    { key: 'change', label: 'Changes', route: reaction ? `/scions/${scionId}/changes/${reaction.transition_id}` : null, state: reaction ? 'required' : 'unavailable' },
    { key: 'review', label: 'Review', route: reaction ? `/scions/${scionId}/reviews/${reaction.review_task.id}` : null, state: reaction?.review_task.status === 'completed' ? 'complete' : reaction ? 'required' : 'unavailable' },
  ];
  return <nav className="case-progress" aria-label="Case progress"><ol>{steps.map(step => <li key={step.key} data-state={step.state}>{step.route ? <button type="button" onClick={() => navigate(step.route!)} aria-current={active === step.key ? 'step' : undefined}><span>{step.label}</span><small>{step.state}</small></button> : <span aria-disabled="true"><span>{step.label}</span><small>{step.state}</small></span>}</li>)}</ol></nav>;
}

function FlowFrame({ scion, reaction, status, scope, comparison, active, navigate, children }: { scion: Scion; reaction: RevisionReaction | null; status: StatusKind; scope: ScopeProposal | null; comparison: ComparisonProposal | null; active: string; navigate: Navigate; children: ReactNode }) {
  return <div className="directional-flow"><ContextStrip scion={scion} reaction={reaction} status={status} /><CaseProgress scionId={scion.id} scope={scope} comparison={comparison} reaction={reaction} active={active} navigate={navigate} />{children}</div>;
}

function ScopeDetails({ proposal }: { proposal: ScopeProposal }) {
  const input = proposal.input;
  const confirmation = proposal.confirmation;
  if (!input) return <p>Protected scope content is unavailable.</p>;
  return <dl className="flow-details-list"><dt>Scope proposal ID</dt><dd><code>{proposal.id}</code></dd><dt>Scion revision</dt><dd>{proposal.scion_revision}</dd><dt>Prepared by</dt><dd><code>{proposal.created_by}</code></dd><dt>Configuration revision ID</dt><dd><code>{confirmation?.configuration_revision_id ?? 'Not recorded'}</code></dd><dt>Component revision ID</dt><dd><code>{confirmation?.component_revision_id ?? 'Not recorded'}</code></dd><dt>Occurrence revision ID</dt><dd><code>{confirmation?.occurrence_revision_id ?? 'Not recorded'}</code></dd><dt>Requirement revision ID</dt><dd><code>{confirmation?.requirement_revision_id ?? 'Not recorded'}</code></dd><dt>Pinned evidence</dt><dd>{input.source_claims.length} claim{input.source_claims.length === 1 ? '' : 's'}</dd>{input.source_claims.map(reference => <div className="flow-detail-group" key={`${reference.kind}-${reference.claim_id}`}><dt>{reference.kind} claim</dt><dd><code>{reference.claim_id}</code><br />Source <code>{reference.source_id}</code> · r{reference.source_revision}<br />bytes [{reference.start_byte}, {reference.end_byte})</dd></div>)}</dl>;
}

function ScopeSummary({ proposal }: { proposal: ScopeProposal }) {
  const input = proposal.input;
  if (!input) return <StatePanel variant="denied" title="Supporting scope is restricted" body="The case is visible, but its exact scope values cannot be read with this identity." />;
  return <section className="flow-card scope-summary"><div className="flow-card-heading"><div><p className="eyebrow">{proposal.computed_stale ? `STALE SINCE SCION R${proposal.persisted_revision_reaction?.superseded_by_revision ?? '?'}` : `EVENT 1 · SCION R${proposal.scion_revision}`}</p><h2>{input.case_title}</h2></div><StatusChip kind={proposal.computed_stale ? 'stale' : isScopeUsable(proposal) ? 'current' : 'blocked'}>{proposal.computed_stale ? 'Stale' : isScopeUsable(proposal) ? 'Current' : 'Blocked'}</StatusChip></div>
    <dl className="scope-summary-grid"><dt>Product configuration</dt><dd>{input.configuration.product_name} / {input.configuration.configuration_code}</dd><dt>BOM occurrence</dt><dd><code>{input.occurrence.path}</code> · qty {input.occurrence.quantity} {input.occurrence.uom}</dd><dt>Component revision</dt><dd>{input.component.part_number} · {proposal.confirmation ? 'confirmed revision' : 'not confirmed'}</dd><dt>Manufacturer</dt><dd>{input.component.manufacturer}</dd><dt>Controlled requirement</dt><dd>{input.requirement.code} · {proposal.confirmation ? 'confirmed revision' : 'not confirmed'}</dd><dt>Geometry</dt><dd>Unavailable — no suitable drawing or CAD attached</dd></dl>
    <div className="flow-card-subrow"><span>Evidence coverage</span><strong>{input.source_claims.length} pinned claims</strong></div><DetailsDisclosure><ScopeDetails proposal={proposal} /></DetailsDisclosure>
  </section>;
}

function ComparisonDetails({ proposal, offers }: { proposal: ComparisonProposal; offers: OfferView[] }) {
  return <dl className="flow-details-list"><dt>Comparison proposal ID</dt><dd><code>{proposal.id}</code></dd><dt>Scion revision</dt><dd>{proposal.scion_revision}</dd><dt>Prepared by</dt><dd><code>{proposal.created_by}</code></dd><dt>Comparison revision ID</dt><dd><code>{proposal.confirmation?.comparison_revision_id ?? 'Not recorded'}</code></dd><dt>Normalization reviewer</dt><dd><code>{proposal.confirmation?.confirmed_by ?? 'Not recorded'}</code></dd>{proposal.snapshot?.lines.map((line, index) => { const offer = offers.find(item => item.id === line.offer_id); return <div className="flow-detail-group" key={line.offer_revision_id}><dt>Alternative {index === 0 ? 'A' : 'B'} IDs</dt><dd>Offer <code>{line.offer_id}</code><br />Revision <code>{line.offer_revision_id}</code><br />Source claim <code>{offer?.revision.input?.source.claim_id ?? 'Restricted'}</code></dd></div>; })}</dl>;
}

function ComparisonMatrix({ proposal, offers }: { proposal: ComparisonProposal; offers: OfferView[] }) {
  const snapshot = proposal.snapshot;
  if (!snapshot || !proposal.input) return <StatePanel variant="denied" title="Comparison content is restricted" body="The comparison record exists, but this identity cannot read its commercial evidence." />;
  const alternatives = snapshot.lines.map(line => ({ line, offer: offers.find(item => item.id === line.offer_id) }));
  const cell = (value: string | number | null | undefined, state: 'comparable' | 'excluded', reasons: string[]) => state === 'excluded' ? <><strong>Excluded</strong><small>{reasons.join('; ') || 'Missing evidence'}</small></> : value === null || value === undefined || value === '' ? 'Missing' : value;
  const rows = [
    { label: 'Exact component', values: alternatives.map(({ line }) => cell('Match', line.state, line.exclusion_reasons)) },
    { label: 'Unit price', values: alternatives.map(({ line }) => cell(line.normalized_unit_price ? `${line.normalized_unit_price} ${line.currency ?? ''}` : null, line.state, line.exclusion_reasons)) },
    { label: 'Extended price', values: alternatives.map(({ line }) => cell(line.extended_price ? `${line.extended_price} ${line.currency ?? ''}` : null, line.state, line.exclusion_reasons)) },
    { label: 'Lead time', values: alternatives.map(({ line }) => cell(line.lead_time_days === null ? null : `${line.lead_time_days} days`, line.state, line.exclusion_reasons)) },
    { label: 'Payment terms', values: alternatives.map(({ line, offer }) => cell(offer?.revision.input?.payment_terms, line.state, line.exclusion_reasons)) },
  ];
  return <section className="flow-card comparison-card"><div className="flow-card-heading"><div><p className="eyebrow">OFFERS · EXACT COMPARISON</p><h2>Two pinned offer revisions</h2></div><StatusChip kind={proposal.computed_stale ? 'stale' : isComparisonUsable(proposal) ? 'current' : proposal.status === 'blocked' ? 'blocked' : 'required'}>{proposal.computed_stale ? 'Stale' : proposal.confirmation ? 'Confirmed · current' : 'Review required'}</StatusChip></div>
    <p className="comparison-basis">Basis: {snapshot.basis.quantity} {snapshot.basis.uom} · {snapshot.basis.currency} · {snapshot.basis.destination} · valid {snapshot.basis.valid_from}–{snapshot.basis.valid_until}</p>
    <div className="comparison-table-wrap"><table className="comparison-table"><caption>Exact two-offer comparison on the recorded common basis</caption><thead><tr><th scope="col">Dimension</th>{alternatives.map(({ line, offer }, index) => <th scope="col" key={line.offer_revision_id}>Alternative {index === 0 ? 'A' : 'B'}<small>{offer?.revision.input?.supplier.legal_name ?? 'Supplier restricted'}</small></th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.label}><th scope="row">{row.label}</th>{row.values.map((value, index) => <td key={index}>{value}</td>)}</tr>)}</tbody></table></div>
    <div className="comparison-mobile" aria-label="Exact two-offer comparison">{rows.map(row => <section key={row.label}><h3>{row.label}</h3>{row.values.map((value, index) => <dl key={index}><dt>Alternative {index === 0 ? 'A' : 'B'} · {alternatives[index].offer?.revision.input?.supplier.legal_name ?? 'Supplier restricted'}</dt><dd>{value}</dd></dl>)}</section>)}</div>
    <p className="flow-boundary">AI-proposed normalization · {proposal.confirmation ? 'confirmed by an independent human reviewer.' : 'not a decision.'}</p><DetailsDisclosure><ComparisonDetails proposal={proposal} offers={offers} /></DetailsDisclosure>
  </section>;
}

function PageHeading({ eyebrow, title, goal, status }: { eyebrow: string; title: string; goal: string; status?: ReactNode }) {
  return <header className="flow-page-heading"><div><p className="eyebrow">{eyebrow}</p><h1 id="route-heading" tabIndex={-1}>{title}</h1><p>{goal}</p></div>{status}</header>;
}

function ContextPage({ scion, scope, comparison, reaction, canWrite, onEdit, navigate }: { scion: Scion; scope: ScopeProposal | null; comparison: ComparisonProposal | null; reaction: RevisionReaction | null; canWrite: boolean; onEdit: () => void; navigate: Navigate }) {
  const primary = reaction ? { label: 'Review latest change', onClick: () => navigate(`/scions/${scion.id}/changes/${reaction.transition_id}`) } : comparison ? { label: 'Review exact comparison', onClick: () => navigate(`/scions/${scion.id}/comparisons/${comparison.id}`) } : scope ? { label: 'Compare two offers', onClick: () => navigate(`/scions/${scion.id}/workbench/offers`) } : { label: 'Complete exact scope', onClick: () => navigate(`/scions/${scion.id}/workbench/scope`) };
  return <><PageHeading eyebrow="CASE CONTEXT" title={scion.revision.name} goal="Verify the exact product context, then follow the single recommended next action." status={<StatusChip kind={reaction ? 'required' : 'current'}>{reaction ? 'Review required' : `Current for Scion r${scion.current_revision}`}</StatusChip>} />
    {reaction && <section className="action-notice" role="status"><div><strong>Decision inputs are stale</strong><p>Scion r{reaction.superseded_by_revision} changed the comparison inputs pinned at r{reaction.proposal_scion_revision}. The historical comparison is retained and must not be reused until review.</p></div><button type="button" onClick={() => navigate(`/scions/${scion.id}/changes/${reaction.transition_id}`)}>View change impact</button></section>}
    {scope ? <ScopeSummary proposal={scope} /> : <StatePanel variant="empty" title="No confirmed exact scope" body="Product configuration, BOM occurrence, component identity, and controlled requirement must be pinned before supplier comparison." action={<button className="button primary" type="button" onClick={() => navigate(`/scions/${scion.id}/workbench/scope`)}>Complete exact scope</button>} />}
    <nav className="flow-related-actions" aria-label="Related case records"><button type="button" onClick={onEdit} disabled={!canWrite}>Edit intake</button><button type="button" onClick={() => navigate(`/scions/${scion.id}/history`)}>Revision history</button><button type="button" onClick={() => navigate(`/scions/${scion.id}/sources`)}>Sources and claims</button></nav>
    <ActionFooter backLabel="Back to cases" onBack={() => navigate('/')} primary={primary} />
  </>;
}

function ScopePage({ scion, scope, reaction, navigate }: { scion: Scion; scope: ScopeProposal | null; reaction: RevisionReaction | null; navigate: Navigate }) {
  if (!scope) return <><PageHeading eyebrow="EXACT SCOPE" title="Exact scope not found" goal="Return to the case and choose an available scope record." /><StatePanel variant="error" title="This scope record is unavailable" body="It may have been removed from your permitted view or the link is no longer valid." /><ActionFooter backLabel="Back to case" onBack={() => navigate(`/scions/${scion.id}/context`)} /></>;
  const primary = scope.computed_stale && reaction ? { label: 'Review change', onClick: () => navigate(`/scions/${scion.id}/changes/${reaction.transition_id}`) } : { label: 'Compare two offers', onClick: () => navigate(`/scions/${scion.id}/workbench/offers`) };
  return <><PageHeading eyebrow="EXACT SCOPE" title="Product configuration and occurrence" goal="Verify the exact configuration, BOM occurrence, component revision, and requirement." /><ScopeSummary proposal={scope} /><ActionFooter backLabel="Back to cases" onBack={() => navigate('/')} primary={primary} /></>;
}

function ComparisonPage({ scion, comparison, offers, reaction, navigate }: { scion: Scion; comparison: ComparisonProposal | null; offers: OfferView[]; reaction: RevisionReaction | null; navigate: Navigate }) {
  if (!comparison) return <><PageHeading eyebrow="OFFERS" title="Comparison not found" goal="Return to the case and choose an available exact comparison." /><StatePanel variant="error" title="This comparison is unavailable" body="It may be outside your organization or the link is no longer valid." /><ActionFooter backLabel="Back to exact scope" onBack={() => navigate(`/scions/${scion.id}/context`)} /></>;
  const primary = comparison.computed_stale && reaction ? { label: 'Review latest change', onClick: () => navigate(`/scions/${scion.id}/changes/${reaction.transition_id}`) } : comparison.confirmation ? { label: 'Record a decision', onClick: () => navigate(`/scions/${scion.id}/decisions/new?comparison=${comparison.id}`) } : { label: 'Complete normalization review', onClick: () => navigate(`/scions/${scion.id}/workbench/offers`) };
  return <><PageHeading eyebrow="TWO-OFFER COMPARISON" title="Compare exact supplier offers" goal="Read decisive commercial differences and exclusions on the recorded common basis." /><ComparisonMatrix proposal={comparison} offers={offers} /><ActionFooter backLabel="Back to exact scope" onBack={() => navigate(`/scions/${scion.id}/context`)} primary={primary} /></>;
}

function DecisionGatePage({ scion, comparison, offers, navigate }: { scion: Scion; comparison: ComparisonProposal | null; offers: OfferView[]; navigate: Navigate }) {
  return <><PageHeading eyebrow="EVENT 1 DECISION" title="Record a sourcing decision" goal="Create an immutable human decision against the pinned comparison." status={<StatusChip kind="restricted">Action unavailable</StatusChip>} />
    {comparison && <ComparisonMatrix proposal={comparison} offers={offers} />}
    <StatePanel variant="denied" title="Action unavailable in this build" body="The API does not yet expose a canonical decision revision, granular Commercial Approver capability, idempotent decision commit, or completed readback. No client-only draft can be presented as a recorded decision." />
    <ActionFooter backLabel="Back to comparison" onBack={() => comparison ? navigate(`/scions/${scion.id}/comparisons/${comparison.id}`) : navigate(`/scions/${scion.id}/context`)} />
  </>;
}

function ChangePage({ scion, reaction, navigate }: { scion: Scion; reaction: RevisionReaction | null; navigate: Navigate }) {
  if (!reaction) return <><PageHeading eyebrow="CHANGE IMPACT" title="Change not found" goal="Return to the case and choose an available recorded change." /><StatePanel variant="error" title="This change record is unavailable" body="The route does not match a persisted revision reaction visible to this identity." /><ActionFooter backLabel="Back to case" onBack={() => navigate(`/scions/${scion.id}/context`)} /></>;
  return <><PageHeading eyebrow="CHANGE IMPACT" title={`Scion revised: r${reaction.proposal_scion_revision} → r${reaction.superseded_by_revision}`} goal="Understand the authoritative change, what became stale, and the required next action." status={<StatusChip kind="required">Review required</StatusChip>} />
    <section className="action-notice" role="status"><div><strong>Earlier decision inputs are stale</strong><p>The {labelProposalKind(reaction.proposal_kind).toLowerCase()} pinned to Scion r{reaction.proposal_scion_revision} cannot be reused for r{reaction.superseded_by_revision}. Historical records remain unchanged.</p></div></section>
    <section className="flow-card impact-card"><div className="flow-card-heading"><div><p className="eyebrow">AUTHORITATIVE REVISION REACTION</p><h2>What needs review</h2></div><StatusChip kind="stale">Stale</StatusChip></div><ul><li><span>{labelProposalKind(reaction.proposal_kind)}</span><strong>Stale</strong></li><li><span>Review task</span><strong>Required for Scion r{reaction.review_task.required_for_revision}</strong></li></ul><div className="impact-unknown"><strong>Still current</strong><p>No authoritative unaffected impacts were returned. The browser does not infer them from a diff.</p></div><DetailsDisclosure title="Change record and IDs"><dl className="flow-details-list"><dt>Transition ID</dt><dd><code>{reaction.transition_id}</code></dd><dt>Affected proposal</dt><dd><code>{reaction.proposal_id}</code></dd><dt>Reason</dt><dd>{reaction.reason}</dd><dt>Recorded</dt><dd>{when(reaction.recorded_at)}</dd><dt>Review task ID</dt><dd><code>{reaction.review_task.id}</code></dd></dl></DetailsDisclosure></section>
    <ActionFooter backLabel="Back to case context" onBack={() => navigate(`/scions/${scion.id}/context`)} primary={{ label: 'Open review task', onClick: () => navigate(`/scions/${scion.id}/reviews/${reaction.review_task.id}`) }} />
  </>;
}

function ReviewPage({ scion, reaction, comparison, offers, navigate }: { scion: Scion; reaction: RevisionReaction | null; comparison: ComparisonProposal | null; offers: OfferView[]; navigate: Navigate }) {
  if (!reaction) return <><PageHeading eyebrow="REQUIRED REVIEW" title="Review task not found" goal="Return to change impact and choose the persisted required task." /><StatePanel variant="error" title="This review task is unavailable" body="The route does not match a persisted task visible to this identity." /><ActionFooter backLabel="Back to case" onBack={() => navigate(`/scions/${scion.id}/context`)} /></>;
  const completed = reaction.review_task.status === 'completed';
  return <><PageHeading eyebrow="REQUIRED REVIEW TASK" title={completed ? 'Review complete' : `Review required for Scion r${reaction.review_task.required_for_revision}`} goal="Compare the earlier pinned record with the current Scion revision before recording a qualified outcome." status={<StatusChip kind={completed ? 'completed' : 'required'}>{completed ? 'Review complete' : 'Required'}</StatusChip>} />
    <section className="flow-card review-task-header"><dl><dt>Task kind</dt><dd>Revision change review</dd><dt>Status</dt><dd>{reaction.review_task.status}</dd><dt>Required revision</dt><dd>Scion r{reaction.review_task.required_for_revision}</dd><dt>Created</dt><dd>{when(reaction.review_task.created_at)}</dd><dt>Required capability</dt><dd>Engineering Reviewer for the exact change; Commercial Approver for any sourcing decision</dd></dl></section>
    {comparison && <ComparisonMatrix proposal={comparison} offers={offers} />}
    {completed ? <StatePanel variant="complete" title="Persisted task is complete" body="The task status is stored, but this backend slice does not expose the authoritative review outcome and Event 2 decision readback required to present them here." /> : <StatePanel variant="denied" title="Review outcome action unavailable in this build" body="The persisted task and stale inputs are readable. The API does not expose granular review authority, an idempotent outcome commit, or canonical outcome readback, so the browser cannot mark the task complete or invent an Event 2 decision." />}
    <ActionFooter backLabel="Back to change impact" onBack={() => navigate(`/scions/${scion.id}/changes/${reaction.transition_id}`)} />
  </>;
}

export default function DirectionalFlow({ token, scion, route, canWrite, onEdit, navigate }: { token: string; scion: Scion; route: string; canWrite: boolean; onEdit: () => void; navigate: Navigate }) {
  const parsed = useMemo(() => parseFlowRoute(route), [route]);
  const [state, setState] = useState<LoadState>(scion.revision.product_category === 'physical' ? 'loading' : 'ready');
  const [data, setData] = useState<WorkflowData | null>(null);
  const [message, setMessage] = useState('');
  const [retry, setRetry] = useState(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (scion.revision.product_category !== 'physical') { setState('ready'); return; }
    if (!navigator.onLine) { setData(null); setState('offline'); setMessage('Offline. Freshness cannot be checked.'); return; }
    setState('loading'); setMessage('');
    try {
      const base = `/scions/${scion.id}`;
      const [scope, comparisons, offers, reviews] = await Promise.all([
        request<ScopeList>(token, `${base}/scope`, { cache: 'no-store', signal }),
        request<ComparisonList>(token, `${base}/comparisons`, { cache: 'no-store', signal }),
        request<OfferList>(token, `${base}/offers`, { cache: 'no-store', signal }),
        request<{ items: RevisionReaction[] }>(token, `${base}/revision-reviews`, { cache: 'no-store', signal }),
      ]);
      setData({ scope, comparisons, offers, reactions: reviews.items }); setState('ready');
    } catch (failure) {
      if (signal?.aborted || failure instanceof DOMException && failure.name === 'AbortError') return;
      setData(null); setMessage(failure instanceof Error ? failure.message : 'The case workflow could not be loaded.');
      setState(failure instanceof ApiError && [401, 403, 404].includes(failure.status) ? 'denied' : failure instanceof ApiError && failure.status === 0 ? 'offline' : 'error');
    }
  }, [scion.id, scion.revision.product_category, token]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load, retry]);
  useEffect(() => {
    const hidden = () => { if (document.visibilityState !== 'visible') setData(null); else setRetry(value => value + 1); };
    const offline = () => { setData(null); setState('offline'); setMessage('Offline. Freshness cannot be checked.'); };
    const online = () => setRetry(value => value + 1);
    document.addEventListener('visibilitychange', hidden); window.addEventListener('offline', offline); window.addEventListener('online', online);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('offline', offline); window.removeEventListener('online', online); };
  }, []);
  useEffect(() => { window.requestAnimationFrame(() => document.getElementById('route-heading')?.focus()); }, [route, state]);

  if (scion.revision.product_category !== 'physical') return <div className="directional-flow"><PageHeading eyebrow="CASE CONTEXT" title={scion.revision.name} goal="Digital Scions retain intake, history, and evidence only." /><StatePanel variant="empty" title="Physical sourcing flow unavailable" body="This Scion is digital. Exact physical scope, supplier comparison, decision, change-impact, and review routes are not applicable." /><ActionFooter backLabel="Back to cases" onBack={() => navigate('/')} /></div>;
  if (state === 'loading') {
    const label = parsed.kind === 'scope' ? 'Loading exact scope…' : parsed.kind === 'comparison' || parsed.kind === 'decision-new' ? 'Loading exact comparison…' : parsed.kind === 'change' ? 'Loading change impact…' : parsed.kind === 'review' ? 'Loading review task…' : 'Loading case context…';
    return <LoadingFlow label={label} onRetry={() => setRetry(value => value + 1)} />;
  }
  if (state === 'offline') return <div className="directional-flow"><PageHeading eyebrow="CASE WORKFLOW" title={scion.revision.name} goal="Reconnect before relying on freshness or recording a governed action." /><StatePanel variant="offline" title="Offline · freshness unknown" body={message || 'Freshness cannot be checked. Protected workflow content has been cleared; drafts in governed forms are not submitted.'} action={<button className="button primary" type="button" onClick={() => setRetry(value => value + 1)}>Retry connection</button>} /><ActionFooter backLabel="Back to cases" onBack={() => navigate('/')} /></div>;
  if (state === 'denied') return <div className="directional-flow"><PageHeading eyebrow="CASE WORKFLOW" title="Access restricted" goal="Use the named safe destination without exposing protected evidence." /><StatePanel variant="denied" title="You don’t have access to this case workflow" body={message} /><ActionFooter backLabel="Back to cases" onBack={() => navigate('/')} /></div>;
  if (state === 'error' || !data) return <div className="directional-flow"><PageHeading eyebrow="CASE WORKFLOW" title="Workflow unavailable" goal="Retry the read without changing any canonical record." /><StatePanel variant="error" title="The case workflow couldn’t be loaded" body={message || 'No workflow response was returned.'} action={<button className="button primary" type="button" onClick={() => setRetry(value => value + 1)}>Retry</button>} /><ActionFooter backLabel="Back to cases" onBack={() => navigate('/')} /></div>;

  const reaction = parsed.kind === 'change' ? reactionForChange(data.reactions, parsed.objectId) : parsed.kind === 'review' ? reactionForTask(data.reactions, parsed.objectId) : reactionForChange(data.reactions, null);
  const selectedScope = parsed.kind === 'scope' ? data.scope.proposals.find(item => item.id === parsed.objectId) ?? null : byNewest(data.scope.proposals).find(isScopeUsable) ?? byNewest(data.scope.proposals)[0] ?? null;
  const selectedComparisonId = parsed.kind === 'comparison' ? parsed.objectId : parsed.kind === 'decision-new' ? parsed.comparisonId : reaction?.proposal_kind === 'offer_comparison' ? reaction.proposal_id : null;
  const selectedComparison = selectedComparisonId ? data.comparisons.proposals.find(item => item.id === selectedComparisonId) ?? null : byNewest(data.comparisons.proposals).find(isComparisonUsable) ?? byNewest(data.comparisons.proposals)[0] ?? null;
  const status: StatusKind = reaction ? reaction.review_task.status === 'completed' ? 'completed' : 'required' : selectedScope?.computed_stale || selectedComparison?.computed_stale ? 'stale' : selectedScope?.blockers.length || selectedComparison?.blockers.length ? 'blocked' : 'current';
  const active = parsed.kind === 'decision-new' || parsed.kind === 'decision' ? 'decision' : parsed.kind;
  const content = parsed.kind === 'context' ? <ContextPage scion={scion} scope={selectedScope} comparison={selectedComparison} reaction={reaction} canWrite={canWrite} onEdit={onEdit} navigate={navigate} />
    : parsed.kind === 'scope' ? <ScopePage scion={scion} scope={selectedScope} reaction={reaction} navigate={navigate} />
    : parsed.kind === 'comparison' ? <ComparisonPage scion={scion} comparison={selectedComparison} offers={data.offers.offers} reaction={reaction} navigate={navigate} />
    : parsed.kind === 'decision-new' || parsed.kind === 'decision' ? <DecisionGatePage scion={scion} comparison={selectedComparison} offers={data.offers.offers} navigate={navigate} />
    : parsed.kind === 'change' ? <ChangePage scion={scion} reaction={reaction} navigate={navigate} />
    : parsed.kind === 'review' ? <ReviewPage scion={scion} reaction={reaction} comparison={selectedComparison} offers={data.offers.offers} navigate={navigate} />
    : <><PageHeading eyebrow="CASE WORKFLOW" title="Page not found" goal="Use the stable case context route to continue." /><StatePanel variant="error" title="This route is not part of the supported flow" body="No record was changed." /><ActionFooter backLabel="Back to case context" onBack={() => navigate(`/scions/${scion.id}/context`)} /></>;
  return <FlowFrame scion={scion} reaction={reaction} status={status} scope={selectedScope} comparison={selectedComparison} active={active} navigate={navigate}>{content}</FlowFrame>;
}
