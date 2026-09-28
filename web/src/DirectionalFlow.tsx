import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, request } from './api';
import type { Scion } from './api';
import { parseFlowRoute, reactionForChange, reactionForTask, recommendedFlowAction, settleNamedReads } from './flow-model';
import type { FlowAction, FlowRecordState, RevisionReaction, WorkflowReadKey } from './flow-model';
import type { ComparisonList, ComparisonProposal, OfferList, OfferView } from './offers-api';
import type { ScopeList, ScopeProposal } from './scope-api';
import './directional-flow.css';

type WorkflowData = {
  scope: ScopeList | null;
  comparisons: ComparisonList | null;
  offers: OfferList | null;
  reactions: RevisionReaction[] | null;
};
type ReadPhase = 'idle' | 'loading' | 'ready' | 'error' | 'denied' | 'offline';
type ReadStatus = { phase: ReadPhase; message: string; checkedAt: number | null };
type ReadStatuses = Record<WorkflowReadKey, ReadStatus>;
type Navigate = (route: string) => void;
type StatusKind = 'current' | 'required' | 'stale' | 'blocked' | 'restricted' | 'unknown';

const readKeys: WorkflowReadKey[] = ['scope', 'comparisons', 'offers', 'reactions'];
const emptyData = (): WorkflowData => ({ scope: null, comparisons: null, offers: null, reactions: null });
const emptyReads = (): ReadStatuses => Object.fromEntries(readKeys.map(key => [key, { phase: 'idle', message: '', checkedAt: null }])) as ReadStatuses;
const readLabels: Record<WorkflowReadKey, string> = { scope: 'exact scope', comparisons: 'comparison', offers: 'offer evidence', reactions: 'change and review state' };
const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const byNewest = <T extends { created_at: string }>(items: T[]) => [...items].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
const isScopeUsable = (proposal: ScopeProposal) => Boolean(proposal.confirmation && proposal.input && proposal.status === 'confirmed' && !proposal.computed_stale && proposal.blockers.length === 0);
const isComparisonUsable = (proposal: ComparisonProposal) => Boolean(proposal.confirmation && proposal.input && proposal.snapshot && proposal.status === 'confirmed' && !proposal.computed_stale && proposal.blockers.length === 0 && !proposal.content_redacted);
const labelProposalKind = (kind: string) => kind === 'offer_comparison' ? 'Comparison proposal' : kind === 'physical_scope' ? 'Exact scope proposal' : 'Proposal';
const routeHref = (route: string) => `#${route}`;

function scopeState(proposal: ScopeProposal | null): FlowRecordState {
  if (!proposal) return 'missing';
  if (!proposal.input) return 'restricted';
  if (proposal.computed_stale) return 'stale';
  if (proposal.status === 'blocked' || proposal.blockers.length > 0) return 'blocked';
  return isScopeUsable(proposal) ? 'usable' : 'proposed';
}
function comparisonState(proposal: ComparisonProposal | null): FlowRecordState {
  if (!proposal) return 'missing';
  if (!proposal.input || !proposal.snapshot || proposal.content_redacted) return 'restricted';
  if (proposal.computed_stale) return 'stale';
  if (proposal.status === 'blocked' || proposal.blockers.length > 0) return 'blocked';
  return isComparisonUsable(proposal) ? 'usable' : 'proposed';
}

function FlowLink({ route, rememberRoute, children, className, focusKey, current }: { route: string; rememberRoute: () => void; children: ReactNode; className?: string; focusKey?: string; current?: boolean }) {
  return <a href={routeHref(route)} onClick={rememberRoute} className={className} data-route-focus={focusKey} aria-current={current ? 'step' : undefined}>{children}</a>;
}

function StatusChip({ kind, children }: { kind: StatusKind; children: ReactNode }) {
  const mark = kind === 'current' ? '✓' : kind === 'restricted' ? '▣' : kind === 'unknown' ? '?' : '!';
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

function StatePanel({ variant, title, body, action }: { variant: 'empty' | 'error' | 'denied' | 'offline'; title: string; body: string; action?: ReactNode }) {
  return <section className={`flow-state flow-state-${variant}`} role={variant === 'error' ? 'alert' : 'status'}>
    <span className="flow-state-mark" aria-hidden="true">{variant === 'denied' ? '▣' : '!'}</span>
    <h2>{title}</h2><p>{body}</p>{action && <div>{action}</div>}
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

function ActionFooter({ back, primary, rememberRoute }: { back: FlowAction; primary?: FlowAction | null; rememberRoute: () => void }) {
  return <footer className="flow-action-footer"><FlowLink route={back.route} rememberRoute={rememberRoute} className="flow-back" focusKey={`back-${back.route}`}>← {back.label}</FlowLink>{primary && <FlowLink route={primary.route} rememberRoute={rememberRoute} className="button primary" focusKey={`primary-${primary.route}`}>{primary.label} <span aria-hidden="true">→</span></FlowLink>}</footer>;
}

function ContextStrip({ scion, reaction, status }: { scion: Scion; reaction: RevisionReaction | null; status: StatusKind }) {
  return <section className="case-context-strip" aria-label="Case context">
    <div><strong>{scion.revision.name}</strong><span>{reaction ? 'Later revision' : 'Current revision'} · Scion r{scion.current_revision}</span></div>
    <div><span>{reaction ? `Proposal pinned to Scion r${reaction.proposal_scion_revision}` : 'Current case revision'}</span><StatusChip kind={status}>{status === 'required' ? 'Review required' : status === 'stale' ? 'Stale' : status === 'blocked' ? 'Blocked' : status === 'restricted' ? 'Restricted' : status === 'unknown' ? 'Freshness unknown' : 'Current'}</StatusChip></div>
  </section>;
}

function CaseProgress({ scionId, scope, comparison, reaction, active, canPrepareScope, canPrepareComparison, rememberRoute }: { scionId: string; scope: ScopeProposal | null; comparison: ComparisonProposal | null; reaction: RevisionReaction | null; active: string; canPrepareScope: boolean; canPrepareComparison: boolean; rememberRoute: () => void }) {
  const steps: Array<{ key: string; label: string; route: string | null; state: string }> = [
    { key: 'context', label: 'Context', route: `/scions/${scionId}/context`, state: 'current' },
    { key: 'scope', label: 'Scope', route: scope ? `/scions/${scionId}/scope/${scope.id}` : canPrepareScope ? `/scions/${scionId}/workbench/scope` : null, state: scope?.computed_stale ? 'stale' : scope ? isScopeUsable(scope) ? 'current' : scopeState(scope) : 'unavailable' },
    { key: 'comparison', label: 'Offers', route: comparison ? `/scions/${scionId}/comparisons/${comparison.id}` : canPrepareComparison ? `/scions/${scionId}/workbench/offers` : null, state: comparison?.computed_stale ? 'stale' : comparison ? isComparisonUsable(comparison) ? 'current' : comparisonState(comparison) : 'unavailable' },
    { key: 'decision', label: 'Decision', route: null, state: 'unavailable' },
    { key: 'change', label: 'Changes', route: reaction ? `/scions/${scionId}/changes/${reaction.transition_id}` : null, state: reaction ? 'required' : 'unavailable' },
    { key: 'review', label: 'Review', route: reaction ? `/scions/${scionId}/reviews/${reaction.review_task.id}` : null, state: reaction ? 'required' : 'unavailable' },
  ];
  return <nav className="case-progress" aria-label="Case progress"><ol>{steps.map(step => <li key={step.key} data-state={step.state}>{step.route ? <FlowLink route={step.route} rememberRoute={rememberRoute} focusKey={`progress-${step.key}`} current={active === step.key}><span>{step.label}</span><small>{step.state}</small></FlowLink> : <span aria-disabled="true"><span>{step.label}</span><small>{step.state}</small></span>}</li>)}</ol></nav>;
}

function ReadWarnings({ reads, retry }: { reads: ReadStatuses; retry: (key: WorkflowReadKey) => void }) {
  const failures = readKeys.filter(key => ['error', 'denied', 'offline'].includes(reads[key].phase));
  if (!failures.length) return null;
  return <section className="flow-currency-warning" role="status" aria-live="polite"><div><strong>Some case records may be out of date</strong><p>Permitted records that loaded successfully remain visible. Governed forward actions stay unavailable until every required freshness check succeeds.</p></div><ul>{failures.map(key => <li key={key}><span><strong>{readLabels[key]}</strong> · {reads[key].message}</span><button type="button" className="button secondary" onClick={() => retry(key)}>Retry {readLabels[key]}</button></li>)}</ul></section>;
}

function FlowFrame({ scion, reaction, status, scope, comparison, active, canPrepareScope, canPrepareComparison, reads, retry, rememberRoute, children }: { scion: Scion; reaction: RevisionReaction | null; status: StatusKind; scope: ScopeProposal | null; comparison: ComparisonProposal | null; active: string; canPrepareScope: boolean; canPrepareComparison: boolean; reads: ReadStatuses; retry: (key: WorkflowReadKey) => void; rememberRoute: () => void; children: ReactNode }) {
  return <div className="directional-flow"><ContextStrip scion={scion} reaction={reaction} status={status} /><CaseProgress scionId={scion.id} scope={scope} comparison={comparison} reaction={reaction} active={active} canPrepareScope={canPrepareScope} canPrepareComparison={canPrepareComparison} rememberRoute={rememberRoute} /><ReadWarnings reads={reads} retry={retry} />{children}</div>;
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
  const state = scopeState(proposal);
  const kind: StatusKind = state === 'usable' ? 'current' : state === 'stale' ? 'stale' : state === 'restricted' ? 'restricted' : state === 'blocked' ? 'blocked' : 'required';
  return <section className="flow-card scope-summary"><div className="flow-card-heading"><div><p className="eyebrow">{proposal.computed_stale ? `STALE SINCE SCION R${proposal.persisted_revision_reaction?.superseded_by_revision ?? '?'}` : `SCION R${proposal.scion_revision}`}</p><h2>{input.case_title}</h2></div><StatusChip kind={kind}>{state === 'usable' ? 'Current' : state === 'stale' ? 'Stale' : state === 'blocked' ? 'Blocked' : 'Review required'}</StatusChip></div>
    <dl className="scope-summary-grid"><dt>Product configuration</dt><dd>{input.configuration.product_name} / {input.configuration.configuration_code}</dd><dt>BOM occurrence</dt><dd><code>{input.occurrence.path}</code> · qty {input.occurrence.quantity} {input.occurrence.uom}</dd><dt>Component revision</dt><dd>{input.component.part_number} · {proposal.confirmation ? 'confirmed revision' : 'not confirmed'}</dd><dt>Manufacturer</dt><dd>{input.component.manufacturer}</dd><dt>Controlled requirement</dt><dd>{input.requirement.code} · {proposal.confirmation ? 'confirmed revision' : 'not confirmed'}</dd><dt>Geometry</dt><dd>Unknown in this build — availability and rights are not represented by the current API</dd></dl>
    <div className="flow-card-subrow"><span>Evidence coverage</span><strong>{input.source_claims.length} pinned claims</strong></div><DetailsDisclosure><ScopeDetails proposal={proposal} /></DetailsDisclosure>
  </section>;
}

function ComparisonDetails({ proposal, offers }: { proposal: ComparisonProposal; offers: OfferView[] }) {
  return <dl className="flow-details-list"><dt>Comparison proposal ID</dt><dd><code>{proposal.id}</code></dd><dt>Scion revision</dt><dd>{proposal.scion_revision}</dd><dt>Prepared by</dt><dd><code>{proposal.created_by}</code></dd><dt>Comparison revision ID</dt><dd><code>{proposal.confirmation?.comparison_revision_id ?? 'Not recorded'}</code></dd><dt>Normalization reviewer</dt><dd><code>{proposal.confirmation?.confirmed_by ?? 'Not recorded'}</code></dd>{proposal.snapshot?.lines.map((line, index) => { const offer = offers.find(item => item.id === line.offer_id); return <div className="flow-detail-group" key={line.offer_revision_id}><dt>Alternative {index === 0 ? 'A' : 'B'} IDs</dt><dd>Offer <code>{line.offer_id}</code><br />Revision <code>{line.offer_revision_id}</code><br />Source claim <code>{offer?.revision.input?.source.claim_id ?? 'Not available'}</code></dd></div>; })}</dl>;
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
  const state = comparisonState(proposal);
  const kind: StatusKind = state === 'usable' ? 'current' : state === 'stale' ? 'stale' : state === 'blocked' ? 'blocked' : state === 'restricted' ? 'restricted' : 'required';
  return <section className="flow-card comparison-card"><div className="flow-card-heading"><div><p className="eyebrow">OFFERS · EXACT COMPARISON</p><h2>Two pinned offer revisions</h2></div><StatusChip kind={kind}>{state === 'usable' ? 'Confirmed · current' : state === 'stale' ? 'Stale' : state === 'blocked' ? 'Blocked' : 'Review required'}</StatusChip></div>
    <p className="comparison-basis">Basis: {snapshot.basis.quantity} {snapshot.basis.uom} · {snapshot.basis.currency} · {snapshot.basis.destination} · valid {snapshot.basis.valid_from}–{snapshot.basis.valid_until}</p>
    <div className="comparison-table-wrap"><table className="comparison-table"><caption>Exact two-offer comparison on the recorded common basis</caption><thead><tr><th scope="col">Dimension</th>{alternatives.map(({ line, offer }, index) => <th scope="col" key={line.offer_revision_id} tabIndex={-1} data-route-focus={`comparison-column-${index}`}>Alternative {index === 0 ? 'A' : 'B'}<small>{offer?.revision.input?.supplier.legal_name ?? 'Supplier not available'}</small></th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.label}><th scope="row">{row.label}</th>{row.values.map((value, index) => <td key={index}>{value}</td>)}</tr>)}</tbody></table></div>
    <div className="comparison-mobile" aria-label="Exact two-offer comparison">{rows.map(row => <section key={row.label}><h3>{row.label}</h3>{row.values.map((value, index) => <dl key={index}><dt>Alternative {index === 0 ? 'A' : 'B'} · {alternatives[index].offer?.revision.input?.supplier.legal_name ?? 'Supplier not available'}</dt><dd>{value}</dd></dl>)}</section>)}</div>
    <p className="flow-boundary">AI-proposed normalization · {proposal.confirmation ? 'confirmed by an independent human reviewer; not a sourcing decision.' : 'not a decision.'}</p><DetailsDisclosure><ComparisonDetails proposal={proposal} offers={offers} /></DetailsDisclosure>
  </section>;
}

function PageHeading({ eyebrow, title, goal, status }: { eyebrow: string; title: string; goal: string; status?: ReactNode }) {
  return <header className="flow-page-heading"><div><p className="eyebrow">{eyebrow}</p><h1 id="route-heading" tabIndex={-1}>{title}</h1><p>{goal}</p></div>{status}</header>;
}

function ContextPage({ scion, scope, scopeKnown, reaction, canWrite, onEdit, primary, rememberRoute }: { scion: Scion; scope: ScopeProposal | null; scopeKnown: boolean; reaction: RevisionReaction | null; canWrite: boolean; onEdit: () => void; primary: FlowAction | null; rememberRoute: () => void }) {
  return <><PageHeading eyebrow="CASE CONTEXT" title={scion.revision.name} goal="Verify the exact product context, then follow the single recommended next action." status={<StatusChip kind={reaction ? 'required' : scopeKnown ? 'current' : 'unknown'}>{reaction ? 'Review required' : scopeKnown ? `Current for Scion r${scion.current_revision}` : 'Freshness unknown'}</StatusChip>} />
    {reaction && <section className="action-notice" role="status"><div><strong>{labelProposalKind(reaction.proposal_kind)} is stale</strong><p>Scion r{reaction.superseded_by_revision} superseded the proposal pinned at r{reaction.proposal_scion_revision}. The historical proposal remains unchanged and cannot be reused until the required review path is available.</p></div></section>}
    {!scopeKnown ? <StatePanel variant="error" title="The exact scope could not be refreshed" body="Other permitted case records remain visible. Retry the exact-scope read before relying on freshness or preparing more work." /> : scope ? <ScopeSummary proposal={scope} /> : <StatePanel variant="empty" title="No exact scope recorded" body="Product configuration, BOM occurrence, component identity, and controlled requirement must be pinned before supplier comparison." />}
    <nav className="flow-related-actions" aria-label="Related case records"><button type="button" onClick={onEdit} disabled={!canWrite}>Edit intake</button><FlowLink route={`/scions/${scion.id}/history`} rememberRoute={rememberRoute}>Revision history</FlowLink><FlowLink route={`/scions/${scion.id}/sources`} rememberRoute={rememberRoute}>Sources and claims</FlowLink></nav>
    <ActionFooter back={{ label: 'Back to cases', route: '/' }} primary={primary} rememberRoute={rememberRoute} />
  </>;
}

function ScopePage({ scion, scope, scopeKnown, primary, rememberRoute }: { scion: Scion; scope: ScopeProposal | null; scopeKnown: boolean; primary: FlowAction | null; rememberRoute: () => void }) {
  if (!scopeKnown) return <><PageHeading eyebrow="EXACT SCOPE" title="Exact scope unavailable" goal="Retry the scoped read or return to the case context." /><StatePanel variant="error" title="The exact scope could not be refreshed" body="No missing or restricted state is inferred from a failed read." /><ActionFooter back={{ label: 'Back to case context', route: `/scions/${scion.id}/context` }} rememberRoute={rememberRoute} /></>;
  if (!scope) return <><PageHeading eyebrow="EXACT SCOPE" title="Exact scope not found" goal="Return to the case and choose an available scope record." /><StatePanel variant="error" title="This scope record is unavailable" body="It may have been removed from your permitted view or the link is no longer valid." /><ActionFooter back={{ label: 'Back to case context', route: `/scions/${scion.id}/context` }} rememberRoute={rememberRoute} /></>;
  return <><PageHeading eyebrow="EXACT SCOPE" title="Product configuration and occurrence" goal="Verify the exact configuration, BOM occurrence, component revision, and requirement." /><ScopeSummary proposal={scope} /><ActionFooter back={{ label: 'Back to case context', route: `/scions/${scion.id}/context` }} primary={primary} rememberRoute={rememberRoute} /></>;
}

function ComparisonPage({ scion, comparison, comparisonKnown, scope, offers, primary, rememberRoute }: { scion: Scion; comparison: ComparisonProposal | null; comparisonKnown: boolean; scope: ScopeProposal | null; offers: OfferView[]; primary: FlowAction | null; rememberRoute: () => void }) {
  const back = scope ? { label: 'Back to exact scope', route: `/scions/${scion.id}/scope/${scope.id}` } : { label: 'Back to case context', route: `/scions/${scion.id}/context` };
  if (!comparisonKnown) return <><PageHeading eyebrow="OFFERS" title="Comparison unavailable" goal="Retry the scoped read or return to the exact scope." /><StatePanel variant="error" title="The comparison could not be refreshed" body="No missing, current, or authorized state is inferred from a failed read." /><ActionFooter back={back} rememberRoute={rememberRoute} /></>;
  if (!comparison) return <><PageHeading eyebrow="OFFERS" title="Comparison not found" goal="Return to the exact scope and choose an available comparison." /><StatePanel variant="error" title="This comparison is unavailable" body="It may be outside your organization or the link is no longer valid." /><ActionFooter back={back} rememberRoute={rememberRoute} /></>;
  return <><PageHeading eyebrow="TWO-OFFER COMPARISON" title="Compare exact supplier offers" goal="Read decisive commercial differences and exclusions on the recorded common basis." /><ComparisonMatrix proposal={comparison} offers={offers} /><ActionFooter back={back} primary={primary} rememberRoute={rememberRoute} /></>;
}

function DecisionGatePage({ scion, comparison, offers, rememberRoute }: { scion: Scion; comparison: ComparisonProposal | null; offers: OfferView[]; rememberRoute: () => void }) {
  return <><PageHeading eyebrow="DECISION" title="Decision recording unavailable" goal="A sourcing decision can be shown only when the server returns its canonical revision and explicit Commercial Approver capability." status={<StatusChip kind="restricted">Action unavailable</StatusChip>} />
    {comparison && <ComparisonMatrix proposal={comparison} offers={offers} />}
    <StatePanel variant="denied" title="Action unavailable in this build" body="The API does not expose a canonical decision revision, granular Commercial Approver capability, idempotent decision commit, or recorded-decision readback. Comparison confirmation is not a sourcing decision." />
    <ActionFooter back={comparison ? { label: 'Back to comparison', route: `/scions/${scion.id}/comparisons/${comparison.id}` } : { label: 'Back to case context', route: `/scions/${scion.id}/context` }} rememberRoute={rememberRoute} />
  </>;
}

function ChangePage({ scion, reaction, rememberRoute }: { scion: Scion; reaction: RevisionReaction | null; rememberRoute: () => void }) {
  if (!reaction) return <><PageHeading eyebrow="CHANGE IMPACT" title="Change not found" goal="Return to the case and choose an available recorded change." /><StatePanel variant="error" title="This change record is unavailable" body="The route does not match a persisted revision reaction visible to this identity." /><ActionFooter back={{ label: 'Back to case context', route: `/scions/${scion.id}/context` }} rememberRoute={rememberRoute} /></>;
  return <><PageHeading eyebrow="CHANGE IMPACT" title={`Scion revised: r${reaction.proposal_scion_revision} → r${reaction.superseded_by_revision}`} goal="Understand the authoritative proposal reaction and open its required review task." status={<StatusChip kind="required">Review required</StatusChip>} />
    <section className="action-notice" role="status"><div><strong>{labelProposalKind(reaction.proposal_kind)} is stale</strong><p>The proposal pinned to Scion r{reaction.proposal_scion_revision} cannot be reused for r{reaction.superseded_by_revision}. No decision record or unaffected impact is inferred.</p></div></section>
    <section className="flow-card impact-card"><div className="flow-card-heading"><div><p className="eyebrow">AUTHORITATIVE REVISION REACTION</p><h2>What needs review</h2></div><StatusChip kind="stale">Stale</StatusChip></div><ul><li><span>{labelProposalKind(reaction.proposal_kind)}</span><strong>Stale</strong></li><li><span>Review task</span><strong>Required for Scion r{reaction.review_task.required_for_revision}</strong></li></ul><div className="impact-unknown"><strong>Other impacts unknown</strong><p>No authoritative unaffected impacts were returned. The browser does not infer them from a diff.</p></div><DetailsDisclosure title="Change record and IDs"><dl className="flow-details-list"><dt>Transition ID</dt><dd><code>{reaction.transition_id}</code></dd><dt>Affected proposal</dt><dd><code>{reaction.proposal_id}</code></dd><dt>Reason</dt><dd>{reaction.reason}</dd><dt>Recorded</dt><dd>{when(reaction.recorded_at)}</dd><dt>Review task ID</dt><dd><code>{reaction.review_task.id}</code></dd></dl></DetailsDisclosure></section>
    <ActionFooter back={{ label: 'Back to case context', route: `/scions/${scion.id}/context` }} primary={{ label: 'Open review task', route: `/scions/${scion.id}/reviews/${reaction.review_task.id}` }} rememberRoute={rememberRoute} />
  </>;
}

function ReviewPage({ scion, reaction, comparison, offers, rememberRoute }: { scion: Scion; reaction: RevisionReaction | null; comparison: ComparisonProposal | null; offers: OfferView[]; rememberRoute: () => void }) {
  if (!reaction) return <><PageHeading eyebrow="REQUIRED REVIEW" title="Review task not found" goal="Return to change impact and choose the persisted required task." /><StatePanel variant="error" title="This review task is unavailable" body="The route does not match a persisted task visible to this identity." /><ActionFooter back={{ label: 'Back to case context', route: `/scions/${scion.id}/context` }} rememberRoute={rememberRoute} /></>;
  return <><PageHeading eyebrow="REQUIRED REVIEW TASK" title={`Review required for Scion r${reaction.review_task.required_for_revision}`} goal="Inspect the stale proposal and current Scion revision without changing task status." status={<StatusChip kind="required">Required</StatusChip>} />
    <section className="flow-card review-task-header"><dl><dt>Task kind</dt><dd>Revision change review</dd><dt>Status</dt><dd>required</dd><dt>Required revision</dt><dd>Scion r{reaction.review_task.required_for_revision}</dd><dt>Created</dt><dd>{when(reaction.review_task.created_at)}</dd><dt>Outcome authority</dt><dd>Not returned by the current API</dd></dl></section>
    {comparison && <ComparisonMatrix proposal={comparison} offers={offers} />}
    <StatePanel variant="denied" title="Review outcome action unavailable in this build" body="The required task and stale proposal are readable. The API constrains this task to required-only and does not expose granular review authority, an idempotent outcome commit, or canonical outcome readback." />
    <ActionFooter back={{ label: 'Back to change impact', route: `/scions/${scion.id}/changes/${reaction.transition_id}` }} rememberRoute={rememberRoute} />
  </>;
}

export default function DirectionalFlow({ token, scion, route, canWrite, onEdit, navigate: _navigate, rememberRoute }: { token: string; scion: Scion; route: string; canWrite: boolean; onEdit: () => void; navigate: Navigate; rememberRoute: () => void }) {
  const parsed = useMemo(() => parseFlowRoute(route), [route]);
  const [data, setData] = useState<WorkflowData>(emptyData);
  const [reads, setReads] = useState<ReadStatuses>(emptyReads);

  const load = useCallback(async (keys: WorkflowReadKey[] = readKeys, signal?: AbortSignal) => {
    if (scion.revision.product_category !== 'physical') return;
    if (!navigator.onLine) {
      setData(emptyData());
      setReads(previous => ({ ...previous, ...Object.fromEntries(keys.map(key => [key, { phase: 'offline', message: 'Offline. Freshness cannot be checked.', checkedAt: previous[key].checkedAt }])) } as ReadStatuses));
      return;
    }
    setReads(previous => ({ ...previous, ...Object.fromEntries(keys.map(key => [key, { ...previous[key], phase: 'loading', message: '' }])) } as ReadStatuses));
    const base = `/scions/${scion.id}`;
    const loaders: Record<WorkflowReadKey, () => Promise<unknown>> = {
      scope: () => request<ScopeList>(token, `${base}/scope`, { cache: 'no-store', signal }),
      comparisons: () => request<ComparisonList>(token, `${base}/comparisons`, { cache: 'no-store', signal }),
      offers: () => request<OfferList>(token, `${base}/offers`, { cache: 'no-store', signal }),
      reactions: () => request<{ items: RevisionReaction[] }>(token, `${base}/revision-reviews`, { cache: 'no-store', signal }).then(value => value.items),
    };
    const results = await settleNamedReads(keys.map(key => [key, loaders[key]] as const));
    if (signal?.aborted) return;
    const checkedAt = Date.now();
    setData(previous => {
      const next = { ...previous };
      for (const result of results) {
        if (result.status === 'fulfilled') (next as unknown as Record<WorkflowReadKey, unknown>)[result.key] = result.value;
        else if (result.reason instanceof ApiError && [0, 401, 403, 404].includes(result.reason.status)) (next as unknown as Record<WorkflowReadKey, unknown>)[result.key] = null;
      }
      return next;
    });
    setReads(previous => {
      const next = { ...previous };
      for (const result of results) {
        if (result.status === 'fulfilled') next[result.key] = { phase: 'ready', message: '', checkedAt };
        else {
          const failure = result.reason;
          const phase: ReadPhase = failure instanceof ApiError && failure.status === 0 ? 'offline' : failure instanceof ApiError && [401, 403, 404].includes(failure.status) ? 'denied' : 'error';
          next[result.key] = { phase, message: failure instanceof Error ? failure.message : `The ${readLabels[result.key]} could not be loaded.`, checkedAt: previous[result.key].checkedAt };
        }
      }
      return next;
    });
  }, [scion.id, scion.revision.product_category, token]);

  useEffect(() => {
    if (scion.revision.product_category !== 'physical') return;
    const controller = new AbortController();
    void load(readKeys, controller.signal);
    return () => controller.abort();
  }, [load, scion.revision.product_category]);
  useEffect(() => {
    const hidden = () => { if (document.visibilityState !== 'visible') { setData(emptyData()); setReads(emptyReads()); } else void load(); };
    const offline = () => { setData(emptyData()); setReads(Object.fromEntries(readKeys.map(key => [key, { phase: 'offline', message: 'Offline. Freshness cannot be checked.', checkedAt: null }])) as ReadStatuses); };
    const online = () => void load();
    document.addEventListener('visibilitychange', hidden); window.addEventListener('offline', offline); window.addEventListener('online', online);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('offline', offline); window.removeEventListener('online', online); };
  }, [load]);

  if (scion.revision.product_category !== 'physical') return <div className="directional-flow"><PageHeading eyebrow="CASE CONTEXT" title={scion.revision.name} goal="Digital Scions retain intake, history, and evidence only." /><StatePanel variant="empty" title="Physical sourcing flow unavailable" body="This Scion is digital. Exact physical scope, supplier comparison, decision, change-impact, and review routes are not applicable." /><ActionFooter back={{ label: 'Back to cases', route: '/' }} rememberRoute={rememberRoute} /></div>;

  const hasData = Object.values(data).some(value => value !== null);
  const loading = readKeys.some(key => reads[key].phase === 'idle' || reads[key].phase === 'loading');
  if (!hasData && loading) {
    const label = parsed.kind === 'scope' ? 'Loading exact scope…' : parsed.kind === 'comparison' || parsed.kind === 'decision-new' ? 'Loading exact comparison…' : parsed.kind === 'change' ? 'Loading change impact…' : parsed.kind === 'review' ? 'Loading review task…' : 'Loading case context…';
    return <LoadingFlow label={label} onRetry={() => void load()} />;
  }
  if (!hasData) {
    const failed = readKeys.map(key => reads[key]).find(read => ['offline', 'denied', 'error'].includes(read.phase));
    const variant = failed?.phase === 'offline' ? 'offline' : failed?.phase === 'denied' ? 'denied' : 'error';
    return <div className="directional-flow"><PageHeading eyebrow="CASE WORKFLOW" title={variant === 'denied' ? 'Access restricted' : 'Workflow unavailable'} goal="Retry the reads without changing any canonical record." /><StatePanel variant={variant} title={variant === 'offline' ? 'Offline · freshness unknown' : variant === 'denied' ? 'You don’t have access to this case workflow' : 'The case workflow couldn’t be loaded'} body={failed?.message || 'No workflow response was returned.'} action={<button className="button primary" type="button" onClick={() => void load()}>Retry case workflow</button>} /><ActionFooter back={{ label: 'Back to cases', route: '/' }} rememberRoute={rememberRoute} /></div>;
  }

  const reactions = data.reactions ?? [];
  const reaction = parsed.kind === 'change' ? reactionForChange(reactions, parsed.objectId) : parsed.kind === 'review' ? reactionForTask(reactions, parsed.objectId) : reactionForChange(reactions, null);
  const scopes = data.scope?.proposals ?? [];
  const selectedScope = parsed.kind === 'scope' ? scopes.find(item => item.id === parsed.objectId) ?? null : byNewest(scopes).find(isScopeUsable) ?? byNewest(scopes)[0] ?? null;
  const comparisonId = parsed.kind === 'comparison' ? parsed.objectId : parsed.kind === 'decision-new' ? parsed.comparisonId : reaction?.proposal_kind === 'offer_comparison' ? reaction.proposal_id : null;
  const comparisons = data.comparisons?.proposals ?? [];
  const selectedComparison = comparisonId ? comparisons.find(item => item.id === comparisonId) ?? null : byNewest(comparisons).find(isComparisonUsable) ?? byNewest(comparisons)[0] ?? null;
  const freshnessKnown = reads.reactions.phase === 'ready';
  const scopeKnown = reads.scope.phase === 'ready';
  const comparisonKnown = reads.comparisons.phase === 'ready';
  const canPrepareScope = freshnessKnown && scopeKnown && canWrite && data.scope?.can_propose === true;
  const canPrepareComparison = freshnessKnown && comparisonKnown && canWrite && data.comparisons?.can_propose === true && Boolean(selectedScope && isScopeUsable(selectedScope));
  const canConfirmComparison = freshnessKnown && comparisonKnown && data.comparisons?.can_confirm === true && selectedComparison?.can_confirm_this_proposal === true;
  const baseAction = {
    scionId: scion.id,
    scopeId: selectedScope?.id ?? null,
    scopeState: scopeState(selectedScope),
    comparisonId: selectedComparison?.id ?? null,
    comparisonState: comparisonState(selectedComparison),
    reactionId: reaction?.transition_id ?? null,
    canPrepareScope,
    canPrepareComparison,
    canConfirmComparison,
    freshnessKnown,
  };
  const contextAction = recommendedFlowAction({ ...baseAction, page: 'context' });
  const scopeAction = recommendedFlowAction({ ...baseAction, page: 'scope' });
  const comparisonAction = recommendedFlowAction({ ...baseAction, page: 'comparison' });
  const hasReadFailure = readKeys.some(key => reads[key].phase !== 'ready');
  const status: StatusKind = !freshnessKnown || hasReadFailure ? 'unknown' : reaction ? 'required' : selectedScope?.computed_stale || selectedComparison?.computed_stale ? 'stale' : selectedScope?.blockers.length || selectedComparison?.blockers.length ? 'blocked' : 'current';
  const active = parsed.kind === 'decision-new' || parsed.kind === 'decision' ? 'decision' : parsed.kind;
  const retry = (key: WorkflowReadKey) => void load([key]);
  const content = parsed.kind === 'context' ? <ContextPage scion={scion} scope={selectedScope} scopeKnown={scopeKnown} reaction={reaction} canWrite={canWrite} onEdit={onEdit} primary={contextAction} rememberRoute={rememberRoute} />
    : parsed.kind === 'scope' ? <ScopePage scion={scion} scope={selectedScope} scopeKnown={scopeKnown} primary={scopeAction} rememberRoute={rememberRoute} />
    : parsed.kind === 'comparison' ? <ComparisonPage scion={scion} comparison={selectedComparison} comparisonKnown={comparisonKnown} scope={selectedScope} offers={data.offers?.offers ?? []} primary={comparisonAction} rememberRoute={rememberRoute} />
    : parsed.kind === 'decision-new' || parsed.kind === 'decision' ? <DecisionGatePage scion={scion} comparison={selectedComparison} offers={data.offers?.offers ?? []} rememberRoute={rememberRoute} />
    : parsed.kind === 'change' ? <ChangePage scion={scion} reaction={reaction} rememberRoute={rememberRoute} />
    : parsed.kind === 'review' ? <ReviewPage scion={scion} reaction={reaction} comparison={selectedComparison} offers={data.offers?.offers ?? []} rememberRoute={rememberRoute} />
    : <><PageHeading eyebrow="CASE WORKFLOW" title="Page not found" goal="Use the stable case context route to continue." /><StatePanel variant="error" title="This route is not part of the supported flow" body="No record was changed." /><ActionFooter back={{ label: 'Back to case context', route: `/scions/${scion.id}/context` }} rememberRoute={rememberRoute} /></>;
  return <FlowFrame scion={scion} reaction={reaction} status={status} scope={selectedScope} comparison={selectedComparison} active={active} canPrepareScope={canPrepareScope} canPrepareComparison={canPrepareComparison} reads={reads} retry={retry} rememberRoute={rememberRoute}>{content}</FlowFrame>;
}
