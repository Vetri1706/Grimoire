import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { request } from './api';
import type { AgentConfig, NativeAgent } from './agents-api';
import type { WorkspaceState } from './workspace-api';
import { WorkIcon, WorkStatus, workTime } from './Workbench';
import './scion-creation.css';

type Props = { token: string; data: WorkspaceState; canWrite: boolean; onNavigate: (path: string) => void; onChanged: () => Promise<void>; onDirty: (dirty: boolean) => void };
export default function AgentCreation({ token, data, canWrite, onNavigate, onChanged, onDirty }: Props) {
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState<AgentConfig>({ name: '', role: 'planner', title: '', capabilities: '', instructions: 'Prepare evidence-bound Scion proposals. Keep unknowns explicit and require human review.', reports_to: null, adapter: 'codex_cli', timeout_seconds: 240, skill_ids: [], paused: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  const pending = useRef(false);
  const retry = useRef<{ body: string; key: string } | null>(null);
  const change = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => { setConfig(current => ({ ...current, [key]: value })); onDirty(true); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { heading.current?.focus(); }, [step]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !canWrite) return;
    if (!config.name.trim() || !config.role.trim()) { setError('Enter a name and role for this agent.'); setStep(0); return; }
    if (step < 2) { setError(''); setStep(step + 1); return; }
    pending.current = true; setBusy(true); setError('');
    const body = JSON.stringify(config);
    if (retry.current?.body !== body) retry.current = { body, key: crypto.randomUUID() };
    try {
      const agent = await request<NativeAgent>(token, '/agents', { method: 'POST', body, headers: { 'Idempotency-Key': retry.current.key } });
      if (!mounted.current) return;
      onDirty(false); await onChanged();
      if (mounted.current) onNavigate(`/agents/${agent.id}`);
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Agent could not be saved.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <section className="agent-creation">
    <div className="creation-progress" role="progressbar" aria-label="Create agent" aria-valuemin={1} aria-valuemax={3} aria-valuenow={step + 1} aria-valuetext={`Step ${step + 1} of 3`}><span className={step === 0 ? 'current' : 'complete'} /><span className={step === 1 ? 'current' : step > 1 ? 'complete' : ''} /><span className={step === 2 ? 'current' : ''} /></div>
    <span className="agent-creation-avatar" aria-hidden="true">{config.name.trim().charAt(0).toUpperCase() || <WorkIcon name="agents" />}</span>
    <h1 tabIndex={-1} ref={heading}>{step === 0 ? 'Create your agent' : step === 1 ? 'Choose its runtime' : 'Give it direction'}</h1>
    <p className="agent-creation-intro">{step === 0 ? 'A name and a role for the work ahead.' : step === 1 ? 'Your agent uses the Grimoire worker and its authorized Codex login.' : 'Set its instructions. You can add skills and refine them later.'}</p>
    <form onSubmit={event => void submit(event)}>
      <fieldset disabled={busy}>
        {step === 0 && <><label>Agent name<input required maxLength={100} value={config.name} placeholder="e.g. Research lead" onChange={event => change('name', event.target.value)} /></label><label>Role<input required maxLength={100} value={config.role} onChange={event => change('role', event.target.value)} /></label><details><summary>More about this agent</summary><label>Title<input maxLength={160} value={config.title} onChange={event => change('title', event.target.value)} /></label><label>Capabilities<textarea maxLength={2000} rows={3} value={config.capabilities} onChange={event => change('capabilities', event.target.value)} /></label><label>Reports to<select value={config.reports_to ?? ''} onChange={event => change('reports_to', event.target.value || null)}><option value="">Handler board</option>{data.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.config.name}</option>)}</select></label></details></>}
        {step === 1 && <><div className="agent-runtime-choice"><WorkIcon name="runtime" /><div><strong>Codex CLI</strong><p>Local Grimoire worker</p></div><span>Selected</span></div><div className="agent-runtime-health"><span>Worker connection</span><WorkStatus value={data.agent_runtime.status} /></div><p className="agent-creation-note">Last seen {workTime(data.agent_runtime.last_seen)}. Provider login is confirmed by a real task outcome. Creating an agent does not start a run.</p><label>Task timeout (seconds)<input required type="number" min={30} max={300} value={config.timeout_seconds} onChange={event => change('timeout_seconds', Number(event.target.value))} /></label></>}
        {step === 2 && <><label>Instructions<textarea required maxLength={12000} rows={5} value={config.instructions} onChange={event => change('instructions', event.target.value)} /></label>{data.skills.length > 0 && <details><summary>Assign skills · {config.skill_ids.length} selected</summary>{data.skills.map(skill => <label className="native-checkbox" key={skill.id}><input type="checkbox" checked={config.skill_ids.includes(skill.id)} disabled={!config.skill_ids.includes(skill.id) && config.skill_ids.length >= 8} onChange={event => change('skill_ids', event.target.checked ? [...config.skill_ids, skill.id] : config.skill_ids.filter(id => id !== skill.id))} /><span>{skill.config.name}</span></label>)}</details>}<p className="agent-creation-note">{config.name || 'This agent'} prepares proposals with Codex. Human review remains required. Keep secrets and source content out of instructions.</p></>}
      </fieldset>
      {error && <p role="alert" className="error-message">{error}</p>}
      <div className="agent-creation-actions"><button type="button" className="text-button" disabled={busy} onClick={() => step ? setStep(step - 1) : onNavigate('/agents')}>{step ? '← Back' : 'Cancel'}</button><button className="button primary" disabled={!canWrite || busy}>{busy ? 'Creating…' : step === 2 ? 'Create agent' : 'Continue'}<WorkIcon name="arrow" /></button></div>
    </form>
  </section>;
}
