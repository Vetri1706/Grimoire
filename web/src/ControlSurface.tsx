import { useState } from 'react';
import type { CaseNode, ControlSurfaceConnection, ControlSurfaceState } from './control-api';
import './control-surface.css';

const labels: Record<CaseNode['kind'], string> = { scion: 'Project intake (Scion)', capability_proposal: 'Agent proposal', agent_task: 'Agent task', evidence_source: 'Evidence source', data_connector: 'Data connector', comparison: 'Comparison', human_review: 'Human review gate' };
const descriptions: Record<CaseNode['kind'], string> = { scion: 'The project requirements and their recorded revisions.', capability_proposal: 'A proposed plan. Completion does not grant approval.', agent_task: 'Work assigned to an agent, with its current recorded outcome.', evidence_source: 'A source that this case depends on. Access permissions still apply.', data_connector: 'An authorized connection to a data provider, when available.', comparison: 'A comparison grounded in this case’s permitted evidence.', human_review: 'A decision that requires an authorized person.' };
const glyphs: Record<CaseNode['kind'], string> = { scion: 'S', capability_proposal: 'P', agent_task: 'A', evidence_source: 'E', data_connector: 'C', comparison: '≍', human_review: 'H' };
const humanize = (value: string) => value.replaceAll('_', ' ');
const when = (value: string | null | undefined) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : 'Never checked';
function tone(status: string) { return /revok|blocked|failed|denied|stale/.test(status) ? 'danger' : /disconnect|unavailable|missing|require|pending|delay|queued/.test(status) ? 'warning' : /connected|healthy|current|granted|available|complete|running|active|monitoring/.test(status) ? 'good' : 'neutral'; }
function Status({ value, stale = false }: { value: string; stale?: boolean }) { return <span className={`os-status ${tone(stale ? 'stale' : value)}`}><i />{humanize(value)}{stale && value !== 'stale' ? ' · stale' : ''}</span>; }

type Positioned = CaseNode & { x: number; y: number };
const NODE_WIDTH = 246;
const NODE_HEIGHT = 112;
const LANE_WIDTH = 282;
function layout(nodes: CaseNode[]): { nodes: Positioned[]; width: number; height: number } {
  const columns: CaseNode[][] = [[], [], []];
  nodes.forEach(node => columns[node.kind === 'scion' || node.kind === 'evidence_source' || node.kind === 'data_connector' ? 0 : node.kind === 'agent_task' || node.kind === 'capability_proposal' ? 1 : 2].push(node));
  const rank: Record<CaseNode['kind'], number> = { scion: 0, evidence_source: 1, data_connector: 2, capability_proposal: 0, agent_task: 1, human_review: 0, comparison: 1 };
  columns.forEach(column => column.sort((a, b) => rank[a.kind] - rank[b.kind]));
  const height = Math.max(410, ...columns.map(column => column.length * 138 + 82));
  return { width: 860, height, nodes: columns.flatMap((column, index) => column.map((node, row) => ({ ...node, x: 24 + index * LANE_WIDTH, y: 70 + row * 138 }))) };
}

export default function ControlSurface({ connection, onAction, graphOnly = false, readOnly = false }: { connection: ControlSurfaceConnection; onAction: (node: CaseNode) => void; graphOnly?: boolean; readOnly?: boolean }) {
  const { data, error, loading, receivedAt, refresh } = connection;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dock, setDock] = useState<'active' | 'blocked' | 'review' | 'events'>('review');
  const selected = data?.nodes.find(node => node.id === selectedId) ?? data?.nodes.find(node => node.kind === 'capability_proposal') ?? data?.nodes[0];
  const graph = layout(data?.nodes ?? []);
  const points = new Map(graph.nodes.map(node => [node.id, node]));
  const health = loading ? 'connecting' : !data ? 'disconnected' : data.watchtower.health;
  const select = (id: string) => { setSelectedId(id); document.getElementById('os-node-inspector')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' }); };
  return <section className="os-surface" aria-label="Grimoire OS control surface">
    <div className="os-bar"><div><span className="os-mark">G / OS</span><span className="os-bar-label">Case control surface</span><span className="os-readonly">Read-only graph</span></div><div><Status value={health} /><button className="os-refresh" type="button" onClick={() => void refresh()} aria-label={readOnly ? 'Refresh public demo case state' : 'Refresh authenticated case state'}>↻ Refresh</button></div></div>
    {loading && <div className="os-empty" role="status">{readOnly ? 'Opening the published synthetic case…' : 'Opening the authorized case projection…'}</div>}
    {error && <div className="os-disconnected" role="alert"><strong>Case view disconnected</strong><p>{error}</p><p>Nodes, evidence and operations are hidden until access can be confirmed. Last successful page refresh: {receivedAt ? when(receivedAt) : 'None'}.</p><button className="button secondary" type="button" onClick={() => void refresh()}>Reconnect case view</button></div>}
    {data && <>
      <div className="os-overview"><div><span className="os-section-number">01</span><h2>Case graph</h2><p>What this case depends on. What needs a human.</p></div><span className="os-meta">Revision {data.scion_revision} · {data.nodes.length} nodes · {data.edges.length} connections</span></div>
      <div className="os-case-grid">
        <div className="os-graph-panel"><div className="os-graph-scroll" role="region" aria-label="Case dependency graph. Select a node to inspect its current state." tabIndex={0}><div className="os-graph" style={{ width: graph.width, height: graph.height }}>
          <div className="os-lane-labels"><span><i aria-hidden="true">1</i>Context & evidence</span><span><i aria-hidden="true">2</i>Proposed work</span><span><i aria-hidden="true">3</i>Review & decisions</span></div>
          <svg width={graph.width} height={graph.height} className="os-edges" aria-hidden="true"><defs><marker id="os-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>{data.edges.map(edge => {
            const from = points.get(edge.source), to = points.get(edge.target); if (!from || !to) return null;
            const same = from.x === to.x;
            const sx = from.x + (same ? NODE_WIDTH : from.x < to.x ? NODE_WIDTH : 0), sy = from.y + NODE_HEIGHT / 2;
            const tx = to.x + (same ? NODE_WIDTH : from.x < to.x ? 0 : NODE_WIDTH), ty = to.y + NODE_HEIGHT / 2;
            const bend = same ? sx + 25 : (sx + tx) / 2;
            return <path key={edge.id} className={selected && (edge.source === selected.id || edge.target === selected.id) ? 'selected' : ''} d={`M${sx},${sy} C${bend},${sy} ${bend},${ty} ${tx},${ty}`} markerEnd="url(#os-arrow)" />;
          })}</svg>
          {graph.nodes.map(node => <button key={node.id} type="button" className={`os-node ${selected?.id === node.id ? 'selected' : ''} ${node.stale || /revoked|blocked/.test(node.status) ? 'attention' : ''}`} style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }} aria-pressed={selected?.id === node.id} onClick={() => setSelectedId(node.id)}><span className="os-node-type" title={descriptions[node.kind]}><span className={`os-node-glyph ${node.kind}`}>{glyphs[node.kind]}</span>{labels[node.kind]}</span><strong title={node.title}>{node.title}</strong><Status value={node.status} stale={node.stale} /></button>)}
        </div></div><div className="os-graph-footer"><span><i className="os-legend-line" />Recorded dependency</span><span>Select a node for its origin, blockers and next action</span></div></div>
        <aside id="os-node-inspector" className="os-inspector" aria-label="Selected node details" aria-live="polite">{selected ? <NodeInspector node={selected} edges={data.edges} nodes={data.nodes} onSelect={setSelectedId} onAction={onAction} readOnly={readOnly} /> : <p>Select a case node to inspect it.</p>}</aside>
      </div>
      {!graphOnly && <>
      <div className="os-lower-grid">
        <section className="os-watchtower" aria-label="Watchtower"><div className="os-section-heading"><div><span className="os-section-number">02</span><h2 title="Server monitoring that checks for changes to this project, its sources and its agent tasks.">Watchtower <span className="os-heading-helper">Change monitoring</span></h2></div><Status value={data.watchtower.health} /></div><p className="os-description">Monitors changes to this project, its sources and agent tasks. The server records checks independently of this page.</p><div className="os-watch-health"><span>Last successful server check</span><strong>{when(data.watchtower.last_successful_check)}</strong></div><ul className="os-watches">{data.watchtower.watches.map(watch => <li key={watch.id}><div><strong>{watch.label}</strong><Status value={watch.status} /></div><span>Last checked <time>{when(watch.last_successful_check)}</time></span>{watch.last_event_at && <span>Last change <time>{when(watch.last_event_at)}</time></span>}</li>)}</ul>{data.watchtower.watches.length === 0 && <p className="os-empty-small">No saved watches were returned for this project (Scion).</p>}<div className="os-watch-footnote"><span className="os-mini-lock">◇</span><p>External monitoring requires an authorized connector with monitoring support. No live vendor checks are simulated.</p></div>{data.watchtower.alerts.length > 0 && <button type="button" className="os-alert-link" onClick={() => setDock('review')}>{data.watchtower.alerts.length} watch alert{data.watchtower.alerts.length === 1 ? '' : 's'} require human review <span>→</span></button>}</section>
        <section className="os-operations" aria-label="Operations dock"><div className="os-section-heading"><div><span className="os-section-number">03</span><h2>Operations dock</h2></div><span className="os-meta">Recorded task state</span></div><div className="os-paperclip"><span><i />Grimoire worker · {humanize(data.operations.agent_runtime.status)}</span><p>Worker heartbeat last seen {when(data.operations.agent_runtime.last_seen)}. Runtime and agent configuration are owned by Grimoire.</p></div><div className="os-dock-tabs" role="tablist" aria-label="Operation views">{(['active', 'blocked', 'review', 'events'] as const).map(item => <button type="button" key={item} role="tab" aria-selected={dock === item} aria-controls="os-dock-panel" id={`os-dock-${item}`} onClick={() => setDock(item)}>{item === 'review' ? 'Human review' : item === 'events' ? 'Event feed' : item === 'active' ? 'Active work' : 'Blocked'}<span>{item === 'events' ? data.operations.events.length : item === 'review' ? data.operations.human_review.length : data.operations.tasks.filter(task => item === 'blocked' ? task.blocked || task.stale || task.status === 'failed' : ['queued', 'dispatched', 'running', 'cancel_requested'].includes(task.status) && !task.blocked && !task.stale).length}</span></button>)}</div><div id="os-dock-panel" role="tabpanel" aria-labelledby={`os-dock-${dock}`} className="os-dock-panel"><Operations data={data} view={dock} onSelect={select} /></div><p className="os-approval-note">Agent completion creates a proposal. Human review and approval remain separate.</p></section>
      </div>
      </>}<div className="os-sync-footer"><span>{readOnly ? 'Public snapshot polling' : 'Authenticated polling'} · 2s</span><span>Page refreshed {when(receivedAt)}</span></div>
    </>}
  </section>;
}

function NodeInspector({ node, edges, nodes, onSelect, onAction, readOnly }: { node: CaseNode; edges: ControlSurfaceState['edges']; nodes: CaseNode[]; onSelect: (id: string) => void; onAction: (node: CaseNode) => void; readOnly: boolean }) {
  const withheld = node.stale || /revoked|denied|blocked/.test(node.status);
  const connections = edges.filter(edge => edge.source === node.id || edge.target === node.id);
  return <>
    <p className="os-inspector-eyebrow">Selected node <span>{labels[node.kind]}</span></p>
    <h3>{node.title}</h3>
    <Status value={node.status} stale={node.stale} />
    <p className="os-node-explanation">{descriptions[node.kind]}</p>
    <div className="os-inspector-section">
      <h4>Safe next action</h4>
      <p>{node.safe_next_action.label}</p>
      {readOnly ? <div className="os-readonly-action"><span>Read-only preview</span><p>Actions are available in an authorized workspace.</p></div> : <button className="button primary" type="button" disabled={!node.safe_next_action.enabled} onClick={() => onAction(node)}>{node.safe_next_action.enabled ? node.safe_next_action.kind === 'edit_intake' ? 'Update intake' : 'Open workspace' : 'Unavailable'}<span aria-hidden="true">↗</span></button>}
    </div>
    <div className="os-inspector-section">
      <h4>What is blocking this?</h4>
      {node.blockers.length ? <ul className="os-blockers">{node.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul> : <p className="os-muted">No blocker reported. Human approval is still a separate decision.</p>}
    </div>
    <details className="os-provenance os-inspector-section" key={`provenance:${node.id}`}>
      <summary title="The recorded origin, revision and identifiers for this node.">Origin & revision · provenance</summary>
      <p>Where this record came from and which version it belongs to.</p>
      <RecordDetails value={node.provenance} />
    </details>
    {withheld ? <p className="os-withheld">Source-dependent content is withheld while this node is stale, blocked or permission-restricted.</p> : node.details && <details className="os-node-details" key={node.id}><summary>Current record details</summary><RecordDetails value={node.details} /></details>}
    <div className="os-inspector-section"><h4>Connected records <span>{connections.length}</span></h4><ul className="os-connections">{connections.map(edge => { const relatedId = edge.source === node.id ? edge.target : edge.source; const related = nodes.find(item => item.id === relatedId); return related ? <li key={edge.id}><button type="button" onClick={() => onSelect(relatedId)}><span>{humanize(edge.kind)}</span><strong>{related.title}</strong><span aria-hidden="true">↗</span></button></li> : null; })}</ul></div>
  </>;
}
function RecordValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span>Not recorded</span>;
  if (Array.isArray(value)) return value.length ? <ul className="os-record-items">{value.map((entry, index) => <li key={index}><RecordValue value={entry} /></li>)}</ul> : <span>None recorded</span>;
  if (typeof value === 'object') return <RecordDetails value={value as Record<string, unknown>} />;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  return <span>{String(value)}</span>;
}
function RecordDetails({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  const isTechnical = (key: string) => /(^id$|_ids?$|hash|sha256|^table$|^locator$)/i.test(key);
  const ordinary = entries.filter(([key]) => !isTechnical(key));
  const technical = entries.filter(([key]) => isTechnical(key));
  const fields = (items: [string, unknown][]) => <dl className="os-record-details">{items.map(([key, entry]) => <div key={key}><dt>{humanize(key)}</dt><dd><RecordValue value={entry} /></dd></div>)}</dl>;
  if (!entries.length) return <p className="os-muted">No additional details recorded.</p>;
  return <>{ordinary.length > 0 && fields(ordinary)}{technical.length > 0 && <details className="os-technical-details"><summary>Technical references <span>{technical.length}</span></summary>{fields(technical)}</details>}</>;
}

function Operations({ data, view, onSelect }: { data: ControlSurfaceState; view: 'active' | 'blocked' | 'review' | 'events'; onSelect: (id: string) => void }) {
  if (view === 'events') return data.operations.events.length ? <ol className="os-event-feed">{data.operations.events.map(event => <li key={event.id}><span className="os-event-dot" /><div><strong>{humanize(event.kind)}</strong><p>{event.summary}</p><time dateTime={event.recorded_at}>{when(event.recorded_at)}</time><details><summary>Audit reference</summary><code>{event.event_key}</code></details></div></li>)}</ol> : <p className="os-empty-small">No auditable watch event has been recorded.</p>;
  if (view === 'review') return data.operations.human_review.length ? <ul className="os-work-list">{data.operations.human_review.map(review => <li key={review.id}><div><Status value={review.status} /><strong>{review.reason}</strong><time dateTime={review.created_at}>{when(review.created_at)}</time></div><button className="os-open" type="button" onClick={() => onSelect(data.nodes.find(node => node.id === `review:${review.id}`)?.id ?? data.nodes.find(node => node.kind === 'human_review')?.id ?? '')}>Inspect <span>↗</span></button></li>)}</ul> : <p className="os-empty-small">No watch-generated review task is recorded. The case's human decision gate still applies.</p>;
  const tasks = data.operations.tasks.filter(task => view === 'blocked' ? task.blocked || task.stale || task.status === 'failed' : ['queued', 'dispatched', 'running', 'cancel_requested'].includes(task.status) && !task.blocked && !task.stale);
  return tasks.length ? <ul className="os-work-list">{tasks.map(task => <li key={task.id}><div><Status value={task.blocked ? 'blocked' : task.status} stale={task.stale} /><strong>{humanize(task.task_kind)}</strong><span>Revision {task.scion_revision} · {when(task.created_at)}</span>{task.failure_code && <span>{task.failure_code}</span>}</div><button className="os-open" type="button" onClick={() => onSelect(`task:${task.id}`)}>Inspect <span>↗</span></button></li>)}</ul> : <p className="os-empty-small">{view === 'blocked' ? 'No blocked agent task is recorded.' : 'No active agent work. Completed tasks remain in the graph.'}</p>;
}
