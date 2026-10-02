import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Scion } from './api';
import type { AgentRuntime, NativeAgent } from './agents-api';
import type { AgentTask } from './scope-api';
import type { TaskWorkflow } from './task-workflow';
import AgentAvatar from './AgentAvatar';
import WorkStateGlyph from './WorkStateGlyph';
import { WorkIcon, WorkStatus } from './Workbench';
import { useLayoutPreferences } from './LayoutPreferences';
import LayoutResizeHandle from './LayoutResizeHandle';
import { layoutLimits } from './layout-preferences';
import type { InspectorSide } from './layout-preferences';
import './task-side-panel.css';

export type TaskArtifact = { id: string; title: string; kind: string; status: string; onOpen?: () => void };
export type TaskDependency = { id: string; title: string; status: string; onOpen?: () => void };
export type RelatedTask = { id: string; title: string; status: TaskWorkflow; agentName?: string; agentId?: string };

export type TaskSidePanelProps = {
  task: AgentTask;
  scion: Scion;
  agent?: NativeAgent;
  runtime?: AgentRuntime;
  workflow: TaskWorkflow;
  relatedTasks: RelatedTask[];
  artifacts: TaskArtifact[];
  dependencies: TaskDependency[];
  reviewCount?: number;
  onNavigate: (path: string) => void;
  onSelectTask: (id: string) => void;
  onClose: () => void;
};

const tabs = ['Properties', 'Artifacts', 'Tasks'] as const;
const humanize = (value: string) => value.replaceAll('_', ' ');
const when = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';

function Property({ name, children }: { name: string; children: ReactNode }) {
  return <div className="task-side-property"><dt>{name}</dt><dd>{children}</dd></div>;
}

function State({ value }: { value: TaskWorkflow }) {
  return <span className="task-side-workflow"><WorkStateGlyph state={value.state} />{value.label}</span>;
}

function PanelLayoutMenu({ onClose }: { onClose: () => void }) {
  const layout = useLayoutPreferences();
  const [open, setOpen] = useState(false);
  const [dropSide, setDropSide] = useState<InspectorSide | null>(null);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ startX: number; middle: number; pointerId: number } | null>(null);
  const moved = useRef(false);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    const frame = requestAnimationFrame(() => Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? []).find(button => button.getClientRects().length)?.focus());
    return () => { cancelAnimationFrame(frame); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const choose = (action: () => void) => { setOpen(false); trigger.current?.focus(); action(); };
  return <div ref={root} className="task-side-layout-root" onBlur={event => { if (!root.current?.contains(event.relatedTarget as Node) && !drag.current) setOpen(false); }}>
    <button ref={trigger} type="button" className="task-side-layout-trigger" aria-label="Task panel layout" title="Panel layout. Drag on desktop to dock left or right." aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => { if (moved.current) { moved.current = false; return; } setOpen(value => !value); }}
      onPointerDown={event => {
        moved.current = false;
        if (event.button !== 0 || !event.isPrimary || !window.matchMedia('(min-width: 1101px)').matches) return;
        const bounds = event.currentTarget.closest('.task-layout, .task-run-layout, .research-layout')?.getBoundingClientRect();
        if (!bounds) return;
        drag.current = { startX: event.clientX, middle: bounds.left + bounds.width / 2, pointerId: event.pointerId };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => { if (drag.current?.pointerId === event.pointerId && Math.abs(event.clientX - drag.current.startX) > 6) { moved.current = true; setOpen(false); setDropSide(event.clientX < drag.current.middle ? 'left' : 'right'); } }}
      onPointerUp={event => {
        if (drag.current?.pointerId !== event.pointerId) return;
        if (moved.current) layout.setInspectorDock(event.clientX < drag.current.middle ? 'left' : 'right');
        drag.current = null; setDropSide(null); event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; setDropSide(null); moved.current = false; }}
      onLostPointerCapture={() => { drag.current = null; setDropSide(null); }}
      onKeyDown={event => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); drag.current = null; setDropSide(null); moved.current = false; } }}><span aria-hidden="true">⋮</span></button>
    {dropSide && <span className="task-side-drop-hint" role="status">Release to dock {dropSide}</span>}
    {open && <div id={menuId} role="menu" aria-label="Task panel layout" className="task-side-layout-menu" onKeyDown={event => {
      const choices = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button')).filter(button => button.getClientRects().length);
      const current = choices.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'ArrowDown' ? (current + 1) % choices.length : event.key === 'ArrowUp' ? (current - 1 + choices.length) % choices.length : event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : null;
      if (next !== null) { event.preventDefault(); choices[next]?.focus(); }
    }}>
      <button type="button" role="menuitemradio" aria-checked={layout.inspectorSide === 'left'} data-desktop-only onClick={() => choose(() => layout.setInspectorDock('left'))}>Dock left <span aria-hidden="true">{layout.inspectorSide === 'left' ? '✓' : ''}</span></button>
      <button type="button" role="menuitemradio" aria-checked={layout.inspectorSide === 'right'} data-desktop-only onClick={() => choose(() => layout.setInspectorDock('right'))}>Dock right <span aria-hidden="true">{layout.inspectorSide === 'right' ? '✓' : ''}</span></button>
      <button type="button" role="menuitem" onClick={() => choose(() => { layout.hideInspector(); onClose(); })}>Hide task panel</button>
      <button type="button" role="menuitem" onClick={() => choose(layout.resetLayout)}>Reset layout</button>
    </div>}
  </div>;
}

/** The parent supplies only the current, authorized projection. This panel never fetches or caches source content. */
export default function TaskSidePanel({ task, scion, agent, runtime, workflow, relatedTasks, artifacts, dependencies, reviewCount, onNavigate, onSelectTask, onClose }: TaskSidePanelProps) {
  const layout = useLayoutPreferences();
  const [tab, setTab] = useState<(typeof tabs)[number]>('Properties');
  const id = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const assignedAgent = agent?.id === task.agent_id ? agent : undefined;
  const others = relatedTasks.filter(item => item.id !== task.id);

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    setTab(tabs[next]);
    buttons.current[next]?.focus();
  }

  return <aside className="task-side-panel" aria-label="Task inspector" data-side={layout.inspectorSide}>
    <LayoutResizeHandle label="Resize task inspector" value={layout.effectiveInspectorWidth} min={layoutLimits.inspector.min} max={layout.inspectorResizeMax} initial={layoutLimits.inspector.initial} direction={layout.inspectorSide === 'right' ? -1 : 1} onChange={layout.setInspectorWidth} className="layout-inspector-resize" />
    <div className="task-side-topbar">
      <div className="task-side-tabs" role="tablist" aria-label="Task inspector views">
        {tabs.map((item, index) => <button key={item} ref={element => { buttons.current[index] = element; }} id={`${id}-tab-${item}`} type="button" role="tab" aria-selected={tab === item} aria-controls={`${id}-panel-${item}`} tabIndex={tab === item ? 0 : -1} onClick={() => setTab(item)} onKeyDown={event => navigateTabs(event, index)}>{item}</button>)}
      </div>
      <PanelLayoutMenu onClose={onClose} />
      <button type="button" className="task-side-close" aria-label="Close task inspector" title="Close task inspector" onClick={() => { layout.hideInspector(); onClose(); }}><span aria-hidden="true">×</span></button>
    </div>

    {tabs.map(item => <div key={item} role="tabpanel" id={`${id}-panel-${item}`} aria-labelledby={`${id}-tab-${item}`} hidden={tab !== item} tabIndex={0} className="task-side-tab-panel">
      {item === 'Properties' && <>
        <section className="task-side-section"><h3>Work</h3><dl>
          <Property name="Status"><State value={workflow} /></Property>
          <Property name="Assigned to">{assignedAgent ? <button type="button" className="task-side-assignee task-side-link" onClick={() => onNavigate(`/agents/${assignedAgent.id}`)}><AgentAvatar name={assignedAgent.config.name} id={assignedAgent.id} size="sm" /><span>{assignedAgent.config.name}</span></button> : <span>{task.agent_id ? 'Agent profile unavailable' : 'Codex worker · no profile'}</span>}</Property>
          <Property name="Runtime">{task.adapter === 'codex_cli' ? 'Codex CLI' : humanize(task.adapter)}</Property>
          <Property name="Scion"><button type="button" className="task-side-link" onClick={() => onNavigate(`/scions/${scion.id}`)}>{scion.revision.name}</button></Property>
          <Property name="Scion revision">{task.scion_revision}{task.scion_revision !== scion.current_revision && <span className="task-side-note">Current: {scion.current_revision}</span>}</Property>
          <Property name="Agent revision">{task.agent_revision ?? (task.agent_id ? 'Not recorded' : 'No agent profile')}</Property>
        </dl></section>

        <section className="task-side-section"><h3>Relationships</h3><dl><Property name="Parent task">Not recorded</Property><Property name="Subtasks">Not recorded</Property></dl><h4>Dependencies</h4>
          {dependencies.length ? <ul className="task-side-records">{dependencies.map(dependency => <li key={dependency.id}>{dependency.onOpen ? <button type="button" className="task-side-record" onClick={dependency.onOpen}><span><strong>{dependency.title}</strong><WorkStatus value={dependency.status} /></span><WorkIcon name="arrow" /></button> : <div className="task-side-record"><span><strong>{dependency.title}</strong><WorkStatus value={dependency.status} /></span></div>}</li>)}</ul> : <p className="task-side-empty-copy">No dependency records available.</p>}
        </section>

        <section className="task-side-section"><h3>Execution</h3><dl>
          <Property name="Worker">{runtime ? <WorkStatus value={runtime.status} /> : 'Not checked'}</Property>
          <Property name="Last heartbeat">{runtime ? when(runtime.last_seen) : 'Not checked'}</Property>
          <Property name="Attempt">{task.attempt}</Property>
          <Property name="Time limit">{task.timeout_seconds} seconds</Property>
          <Property name="Model override">Not recorded</Property>
          <Property name="Human reviews">{reviewCount === undefined ? 'Not checked' : reviewCount === 0 ? 'None recorded' : `${reviewCount} recorded`}</Property>
        </dl></section>

        <section className="task-side-section"><h3>About</h3><dl>
          <Property name="Created"><time dateTime={task.created_at}>{when(task.created_at)}</time></Property>
          <Property name="Dispatched">{when(task.dispatched_at)}</Property>
          <Property name="Claimed">{when(task.claimed_at)}</Property>
          <Property name="Completed">{when(task.completed_at)}</Property>
          <Property name="Cancelled">{when(task.cancelled_at)}</Property>
        </dl><details className="task-side-technical"><summary>Technical details</summary><dl>
          <Property name="Task ID"><code>{task.id}</code></Property>
          <Property name="Scion ID"><code>{task.scion_id}</code></Property>
          <Property name="Agent ID"><code>{task.agent_id ?? 'Not assigned'}</code></Property>
          <Property name="Saved status">{humanize(task.status)}</Property>
          <Property name="Provider run"><code>{task.provider_run_id ?? 'Not recorded'}</code></Property>
          <Property name="Output hash"><code>{task.output_sha256 ?? 'Not recorded'}</code></Property>
          <Property name="Failure code"><code>{task.failure_code ?? 'None recorded'}</code></Property>
        </dl></details></section>
      </>}

      {item === 'Artifacts' && <section className="task-side-section"><h3>Artifacts <span>{artifacts.length}</span></h3>{artifacts.length ? <ul className="task-side-records task-side-artifacts">{artifacts.map(artifact => <li key={artifact.id}>{artifact.onOpen ? <button type="button" className="task-side-record" onClick={artifact.onOpen}><WorkIcon name="proposals" /><span><strong>{artifact.title}</strong><small>{humanize(artifact.kind)}</small><WorkStatus value={artifact.status} /></span><WorkIcon name="arrow" /></button> : <div className="task-side-record"><WorkIcon name="proposals" /><span><strong>{artifact.title}</strong><small>{humanize(artifact.kind)}</small><WorkStatus value={artifact.status} /></span></div>}</li>)}</ul> : <div className="task-side-empty"><WorkIcon name="proposals" /><h4>No artifacts yet</h4><p>Recorded deliverables will appear here when they are available.</p></div>}</section>}

      {item === 'Tasks' && <>
        <section className="task-side-section"><h3>Ancestors</h3><p className="task-side-empty-copy">No parent task is recorded.</p></section>
        <section className="task-side-section"><h3>Subtasks</h3><p className="task-side-empty-copy">No subtasks are recorded.</p></section>
        <section className="task-side-section"><h3>Related tasks <span>{others.length}</span></h3><p className="task-side-empty-copy">Other work in this Scion.</p>{others.length ? <ul className="task-side-records">{others.map(related => <li key={related.id}><button type="button" className="task-side-record" onClick={() => onSelectTask(related.id)}>{related.agentId && related.agentName ? <AgentAvatar name={related.agentName} id={related.agentId} size="sm" /> : <WorkIcon name="tasks" />}<span><strong>{related.title}</strong>{related.agentName && <small>{related.agentName}</small>}<State value={related.status} /></span><WorkIcon name="arrow" /></button></li>)}</ul> : <p className="task-side-empty-copy">No other tasks in this Scion.</p>}</section>
      </>}
    </div>)}
  </aside>;
}
