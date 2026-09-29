import { useEffect, useState } from 'react';
import ControlSurface from './ControlSurface';
import { useControlSurface } from './control-api';
import { demoRequest, isDemoCatalog } from './demo-api';
import type { DemoCatalog, DemoScenario } from './demo-api';
import { ThemePicker } from './theme';
import './public-demo.css';

const selectedHash = () => window.location.hash.replace(/^#/, '');

// Mounted instead of App: opening the public demo never loads account state or
// changes a signed-in visitor's session or active organization.
export default function PublicDemo() {
  const [catalog, setCatalog] = useState<DemoCatalog | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [slug, setSlug] = useState(selectedHash);
  useEffect(() => {
    document.title = 'Grimoire · Synthetic judge demo';
    const changed = () => setSlug(selectedHash());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setCatalog(null); setError('');
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    demoRequest<unknown>('/demo', controller.signal).then(value => {
      if (!isDemoCatalog(value)) throw new Error('The synthetic demo catalog could not be verified.');
      if (active) setCatalog(value);
    }).catch(failure => { if (active) setError(controller.signal.aborted ? 'The demo service did not respond in time. Please retry.' : failure instanceof Error ? failure.message : 'The demo is unavailable.'); })
      .finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [retry]);
  const selected = catalog?.scenarios.find(scenario => scenario.slug === slug) ?? catalog?.scenarios.find(scenario => scenario.slug === 'current');
  return <main className="public-demo">
    <header className="demo-header"><a className="demo-brand" href="/" aria-label="Grimoire home"><span aria-hidden="true">G</span>GRIMOIRE</a><span className="demo-readonly">SYNTHETIC JUDGE DEMO · READ ONLY</span><ThemePicker /><a className="button secondary" href="/">Sign in / open workspace <span aria-hidden="true">↗</span></a></header>
    <section className="demo-intro"><p className="eyebrow">A PLAN. ITS EVIDENCE. YOUR DECISION.</p><h1>See why a plan needs review.</h1><p>Explore a website plan, the sources it depends on, and the decisions that still need a person.</p><details className="demo-boundary"><summary>How this demo works <span>Read-only · synthetic records</span></summary><p>{catalog?.description ?? 'These are saved synthetic examples of the review workflow.'}</p><p>Each case is a separate saved record. Selecting one reads its current state; it does not revise a requirement or revoke a source. No actual Codex or Paperclip run was executed. No personal login or private workspace is shared.</p><dl><div><dt>Project (Scion)</dt><dd>The brief and requirements being reviewed.</dd></div><div><dt>Watchtower</dt><dd>Server checks that record changes to requirements, sources and tasks.</dd></div><div><dt>Provenance</dt><dd>Where a record came from and which revision it uses.</dd></div></dl></details></section>
    {error ? <section className="demo-unavailable" role="alert"><h2>Demo unavailable</h2><p>{error}</p><p>Case content is hidden. No simulated state is substituted.</p><button className="button secondary" type="button" onClick={() => setRetry(value => value + 1)}>Retry demo</button></section> : !catalog ? <p className="demo-loading" role="status">Loading the published synthetic cases…</p> : <>
      <nav className="demo-scenarios" aria-label="Synthetic case scenarios">{catalog.scenarios.map((scenario, index) => <a key={scenario.slug} href={`#${scenario.slug}`} aria-current={scenario.slug === selected?.slug ? 'page' : undefined}><span className="demo-step">0{index + 1}</span><div><h2>{scenario.title}</h2><p>{scenario.description}</p></div><span aria-hidden="true">↗</span></a>)}</nav>
      {selected && <section className="demo-case" aria-label={selected.title}><div className="demo-case-heading"><div><p className="eyebrow">SELECTED CASE</p><h2>{selected.title}</h2></div><p>Select a node to see its sources, blockers and next step.<br />A person must still review the plan.</p></div><DemoCase key={selected.scion_id} scenario={selected} /></section>}
    </>}
    <footer className="demo-footer"><span>Public synthetic data only · workspace actions disabled</span><a href="/">Create your own private workspace <span aria-hidden="true">→</span></a></footer>
  </main>;
}

function DemoCase({ scenario }: { scenario: DemoScenario }) {
  const connection = useControlSurface('', scenario.scion_id, scenario.slug);
  return <ControlSurface connection={connection} readOnly onAction={() => undefined} />;
}
