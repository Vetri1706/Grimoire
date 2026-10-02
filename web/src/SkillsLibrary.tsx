import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { request } from './api';
import type { NativeAgent, NativeSkill, SkillConfig } from './agents-api';
import { starterSkills } from './skillCatalog';
import type { StarterSkill } from './skillCatalog';
import { WorkIcon } from './Workbench';
import './skills-library.css';

type Props = {
  token: string; route: string; canWrite: boolean;
  data: { skills: NativeSkill[]; agents: NativeAgent[] };
  onNavigate: (path: string) => void; onChanged: () => Promise<void>;
  onDirty: (dirty: boolean) => void;
};
const bytes = (value: string) => new TextEncoder().encode(value).length;
const catalogMatch = (skill: NativeSkill) => starterSkills.find(item => item.instructions === skill.config.instructions);
const installedMatch = (skills: NativeSkill[], item: StarterSkill) => skills.find(skill => skill.config.instructions === item.instructions);
const message = (failure: unknown) => failure instanceof Error ? failure.message : 'The skill could not be saved.';

// The route and organization key discard drafts and pending response handlers on
// navigation. Requests remain bound to the organization in the session token.
export default function SkillsLibrary(props: Props) {
  return <Library key={`${props.token}:${props.route}`} {...props} />;
}

function Library(props: Props) {
  const { route, data, onNavigate } = props;
  const [, , recordId, catalogId] = route.split('/');
  const view = recordId === 'discover' ? 'discover' : recordId === 'studio' || recordId === 'new' ? 'authored' : 'installed';
  const skill = data.skills.find(item => item.id === recordId);
  const catalog = recordId === 'discover' && catalogId ? starterSkills.find(item => item.id === catalogId) : undefined;
  return <div className="skills-library">
    <nav className="skills-local-nav" aria-label="Skills navigation">
      <button aria-current={view === 'installed' ? 'page' : undefined} onClick={() => onNavigate('/skills')}><WorkIcon name="instructions" />Installed<span>{data.skills.length}</span></button>
      <button aria-current={view === 'discover' ? 'page' : undefined} onClick={() => onNavigate('/skills/discover')}><WorkIcon name="search" />Discover</button>
      <div className="skills-author-label"><strong>Author</strong><p>Write instructions for your agents.</p></div>
      <button aria-current={view === 'authored' ? 'page' : undefined} onClick={() => onNavigate('/skills/studio')}><WorkIcon name="skills" />My Skills</button>
    </nav>
    <div className="skills-library-content">
      {recordId === 'new' || skill ? <SkillEditor {...props} skill={skill ?? null} />
        : catalog ? <CatalogPreview {...props} item={catalog} />
        : (!recordId || recordId === 'studio' || (recordId === 'discover' && !catalogId)) ? <Directory {...props} view={view} />
        : <Empty><h1>Skill unavailable</h1><p>This skill is not available in this organization.</p><button className="button secondary" onClick={() => onNavigate('/skills')}>Back to skills</button></Empty>}
    </div>
  </div>;
}

function Empty({ children }: { children: ReactNode }) { return <div className="skills-empty">{children}</div>; }

function Directory({ data, canWrite, onNavigate, view }: Props & { view: 'installed' | 'discover' | 'authored' }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'name' | 'agents'>('name');
  const search = query.trim().toLocaleLowerCase();
  const assigned = (id: string) => data.agents.filter(agent => agent.config.skill_ids.includes(id)).length;
  const ownSkills = view === 'authored' ? data.skills.filter(skill => !catalogMatch(skill)) : data.skills;
  const skills = ownSkills.filter(skill => `${skill.config.name} ${skill.config.description}`.toLocaleLowerCase().includes(search))
    .sort((a, b) => (sort === 'agents' ? assigned(b.id) - assigned(a.id) : 0) || a.config.name.localeCompare(b.config.name));
  const catalog = starterSkills.filter(item => `${item.name} ${item.description}`.toLocaleLowerCase().includes(search));
  const count = view === 'discover' ? catalog.length : skills.length;
  const title = view === 'discover' ? 'Discover skills' : view === 'authored' ? 'My Skills' : 'Installed skills';
  return <>
    <header className="skills-heading"><div><h1>{title}</h1><p>{view === 'discover' ? 'Reviewed instructions for product planning and evidence review.' : view === 'authored' ? 'Custom skills in this organization.' : 'Skills available to this organization.'}</p></div><button className="button primary" disabled={!canWrite} onClick={() => onNavigate('/skills/new')}><WorkIcon name="new" />Create skill</button></header>
    <div className="skills-toolbar"><label className="skills-search"><WorkIcon name="search" /><input type="search" aria-label="Search skills" placeholder={`Search ${view === 'discover' ? 'starter' : view === 'authored' ? 'your' : 'installed'} skills…`} value={query} onChange={event => setQuery(event.target.value)} /></label>{view !== 'discover' && <label className="skills-sort">Sort<select aria-label="Sort skills" value={sort} onChange={event => setSort(event.target.value as 'name' | 'agents')}><option value="name">Name</option><option value="agents">Most agents</option></select></label>}</div>
    <p className="skills-result-count" role="status">{count} {count === 1 ? 'skill' : 'skills'}</p>
    {count ? <div className="skills-card-grid">{view === 'discover' ? catalog.map(item => {
      const installed = installedMatch(data.skills, item);
      return <SkillCard key={item.id} title={item.name} description={item.description} badge={installed ? 'Installed' : 'Starter skill'} detail={`Adapted from skills.sh · ${item.source.license}`} usage={installed ? `${assigned(installed.id)} agents assigned` : 'Preview before installing'} onOpen={() => onNavigate(`/skills/discover/${item.id}`)} />;
    }) : skills.map(skill => <SkillCard key={skill.id} title={skill.config.name} description={skill.config.description || 'Custom preparation instructions.'} badge={`Revision ${skill.revision}`} detail={catalogMatch(skill) ? 'Reviewed starter' : 'Organization skill'} usage={`${assigned(skill.id)} ${assigned(skill.id) === 1 ? 'agent' : 'agents'} assigned`} onOpen={() => onNavigate(`/skills/${skill.id}`)} />)}</div>
      : <Empty><h2>{search ? 'No matching skills' : view === 'authored' ? 'Make a skill your own' : 'Give your agent a starting point'}</h2><p>{search ? 'Try another name or description.' : 'Choose reviewed planning instructions or write a skill for your workflow.'}</p><button className="button secondary" onClick={() => search ? setQuery('') : onNavigate(view === 'authored' ? '/skills/new' : '/skills/discover')}>{search ? 'Clear search' : view === 'authored' ? 'Create a skill' : 'Discover skills'}</button></Empty>}
    <p className="skills-footer-note">Assign up to eight skills to an agent. Tasks retain the exact instructions and revisions assigned to them.</p>
  </>;
}

function SkillCard({ title, description, badge, detail, usage, onOpen }: { title: string; description: string; badge: string; detail: string; usage: string; onOpen: () => void }) {
  return <button type="button" className="skills-card" onClick={onOpen}><span className="skills-card-heading"><span className="skills-card-icon"><WorkIcon name="skills" /></span><strong>{title}</strong><WorkIcon name="arrow" /></span><span className="skills-card-description">{description}</span><span className="skills-card-usage">{usage}</span><span className="skills-card-meta"><span>{badge}</span><span>{detail}</span></span></button>;
}

function useSaveSkill(token: string, onChanged: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const retry = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  async function save(config: SkillConfig, current: NativeSkill | null, committed?: () => void) {
    if (pending.current) return null;
    pending.current = true; setBusy(true); setError('');
    const body = JSON.stringify(config);
    if (retry.current?.body !== body) retry.current = { body, key: crypto.randomUUID() };
    controller.current = new AbortController();
    try {
      const result = await request<NativeSkill>(token, current ? `/skills/${current.id}` : '/skills', { method: current ? 'PUT' : 'POST', body, signal: controller.current.signal, headers: { 'Idempotency-Key': retry.current.key, ...(current ? { 'If-Match': `"${current.revision}"` } : {}) } });
      if (!alive.current) return null;
      committed?.();
      await onChanged();
      return alive.current ? result : null;
    } catch (failure) { if (alive.current) setError(message(failure)); return null; }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return { save, busy, error };
}

function CatalogPreview({ token, data, item, canWrite, onChanged, onNavigate }: Props & { item: StarterSkill }) {
  const { save, busy, error } = useSaveSkill(token, onChanged);
  const [created, setCreated] = useState<NativeSkill | null>(null);
  const installed = installedMatch(data.skills, item) ?? created;
  async function install() {
    if (!canWrite || installed) return;
    const result = await save({ name: item.name, description: item.description, instructions: item.instructions }, null);
    if (result) setCreated(result);
  }
  return <>
    <button className="text-button skills-back" onClick={() => onNavigate('/skills/discover')}>← Discover skills</button>
    <header className="skills-heading"><div><span className="skills-eyebrow">Reviewed starter · v{item.adaptationVersion}</span><h1>{item.name}</h1><p>{item.description}</p></div><button className={`button ${installed ? 'secondary' : 'primary'}`} disabled={!installed && (!canWrite || busy || bytes(item.instructions) > 12000)} onClick={() => installed ? onNavigate(`/skills/${installed.id}`) : void install()}>{installed ? 'Open installed skill' : busy ? 'Installing…' : 'Install skill'}</button></header>
    {error && <p className="skills-error" role="alert">{error}</p>}
    {created && <p className="skills-success" role="status">Installed in this organization. Assign it to an agent to use it on new tasks.</p>}
    <div className="skills-detail-grid"><section className="skills-instructions"><h2>Instructions</h2><p>{bytes(item.instructions).toLocaleString()} / 12,000 bytes · Included in the agent’s task instructions.</p><pre>{item.instructions}</pre></section><aside><Provenance item={item} /><section className="skills-detail-card"><h2>Works with</h2><p>Codex capability proposals from your Scion brief.</p><p>Instruction-only. Installing a skill does not enable tools, external access or approval authority.</p></section>{installed && <AssignmentLinks agents={data.agents} skillId={installed.id} onNavigate={onNavigate} />}</aside></div>
  </>;
}

function Provenance({ item }: { item: StarterSkill }) {
  return <section className="skills-detail-card"><h2>Source &amp; review</h2><dl><div><dt>Discovery</dt><dd><a href={item.source.catalogUrl} target="_blank" rel="noreferrer">View on skills.sh ↗</a></dd></div><div><dt>Upstream</dt><dd><a href={item.source.repository.startsWith('https://') ? item.source.repository : 'https://github.com/' + item.source.repository} target="_blank" rel="noreferrer">Source repository ↗</a></dd></div><div><dt>Commit</dt><dd><code>{item.source.commit}</code></dd></div><div><dt>File</dt><dd><code>{item.source.path}</code></dd></div><div><dt>License</dt><dd>{item.source.license}</dd></div><div><dt>Upstream SHA-256</dt><dd><code>{item.source.sha256}</code></dd></div></dl><p>Adapted for Grimoire’s planning workflow. Attribution and source details remain in the saved instructions.</p></section>;
}

function AssignmentLinks({ agents, skillId, onNavigate }: { agents: NativeAgent[]; skillId: string; onNavigate: (path: string) => void }) {
  return <section className="skills-detail-card"><h2>Assign to an agent</h2><p>Open an agent’s Skills, select this skill, then save its configuration.</p>{agents.length ? <div className="skills-agent-links">{agents.map(agent => <button className="text-button" key={agent.id} onClick={() => onNavigate(`/agents/${agent.id}/skills`)}><span>{agent.config.name}</span><span>{agent.config.skill_ids.includes(skillId) ? 'Assigned' : 'Configure'} →</span></button>)}</div> : <button className="text-button" onClick={() => onNavigate('/agents/new')}>Create an agent →</button>}</section>;
}

function SkillEditor({ skill, token, data, canWrite, onChanged, onNavigate, onDirty }: Props & { skill: NativeSkill | null }) {
  const [config, setConfig] = useState<SkillConfig>(skill?.config ?? { name: '', description: '', instructions: '' });
  const base = useRef(skill);
  const { save, busy, error } = useSaveSkill(token, onChanged);
  const size = bytes(config.instructions);
  const valid = !!config.name.trim() && !!config.instructions.trim() && bytes(config.name) <= 100 && bytes(config.description) <= 2000 && size <= 12000 && !Object.values(config).some(value => value.includes('\0'));
  const original = skill && catalogMatch(skill);
  const changedElsewhere = !!skill && skill.revision !== base.current?.revision;
  const change = (key: keyof SkillConfig, value: string) => { setConfig(current => ({ ...current, [key]: value })); onDirty(true); };
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!canWrite || !valid || changedElsewhere) return;
    const result = await save(config, base.current, () => onDirty(false));
    if (result) onNavigate('/skills');
  }
  return <>
    <button className="text-button skills-back" onClick={() => onNavigate('/skills')}>← Installed skills</button>
    <header className="skills-heading"><div><h1>{skill ? skill.config.name : 'Create a skill'}</h1><p>{skill ? `Revision ${skill.revision} · Edits apply to future assignments.` : 'Give your agent reusable instructions for product planning.'}</p></div></header>
    <div className="skills-detail-grid"><form className="native-config-form skills-editor" onSubmit={event => void submit(event)}>
      <label>Name<input aria-label="Name" required maxLength={100} value={config.name} disabled={!canWrite || busy} onChange={event => change('name', event.target.value)} /></label>
      <label>Description<input aria-label="Description" maxLength={2000} value={config.description} disabled={!canWrite || busy} onChange={event => change('description', event.target.value)} /></label>
      <label>Instructions<textarea aria-label="Instructions" required rows={18} maxLength={12000} value={config.instructions} disabled={!canWrite || busy} aria-describedby="skill-instruction-size" onChange={event => change('instructions', event.target.value)} /></label>
      <p id="skill-instruction-size" className={size > 12000 ? 'skills-error' : 'skills-byte-count'} role={size > 12000 ? 'alert' : undefined}>{size.toLocaleString()} / 12,000 UTF-8 bytes{size > 12000 ? ' — shorten the instructions before saving.' : ''}</p>
      <p>Keep source content and secrets out of skills. Saved revisions become part of new task instructions; they grant no extra authority.</p>
      {changedElsewhere && <p role="alert" className="skills-error">This skill changed while you were editing. Keep a copy of your draft, then reopen the skill before saving.</p>}
      {error && <p role="alert" className="skills-error">{error}</p>}
      <div className="native-form-actions"><button type="button" className="button secondary" onClick={() => onNavigate('/skills')}>Cancel</button><button className="button primary" disabled={!canWrite || busy || !valid || changedElsewhere}>{busy ? 'Saving…' : skill ? 'Save skill revision' : 'Create skill'}</button></div>
    </form><aside>{original && <Provenance item={original} />}{skill ? <AssignmentLinks agents={data.agents} skillId={skill.id} onNavigate={onNavigate} /> : <section className="skills-detail-card"><h2>A useful skill has a clear job</h2><p>Describe when to use it, the inputs it needs, the steps to follow and the evidence expected in its result.</p><p>Keep unknowns visible and leave decisions requiring approval to the Handler.</p><button type="button" className="text-button" onClick={() => onNavigate('/skills/discover')}>Explore starter skills →</button></section>}</aside></div>
  </>;
}
