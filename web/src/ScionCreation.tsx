import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, request } from './api';
import type { Category, Intake, Scion } from './api';
import './scion-creation.css';

type Props = {
  token: string;
  onSaved: (scion: Scion) => void;
  onCancel: () => void;
  onDirty: (dirty: boolean) => void;
};
type Draft = {
  name: string;
  category: Category;
  description: string;
  decision: string;
  requirements: string;
  requirementsNone: boolean;
  questions: string;
  questionsNone: boolean;
};
const categoryNames: Record<Category, string> = { unspecified: 'Not yet specified', physical: 'Physical product', digital: 'Digital product' };
const stepNames = ['Project', 'Brief', 'Review'];
const titles = ['Give this project a name.', 'What are you deciding?', 'Ready to create your Scion?'];
const descriptions = [
  'A Scion keeps a project, its evidence, and its decisions together.',
  'Add what you know. You can fill in the rest later.',
  'Check the brief. Missing information will stay visible.',
];

function intakeFrom(draft: Draft): Intake {
  const list = (value: string, none: boolean) => none ? [] : value.trim() ? value.split('\n').map(item => item.trim()).filter(Boolean) : null;
  return {
    name: draft.name.trim(), product_category: draft.category,
    product_description: draft.description.trim() || null,
    decision: draft.decision.trim() || null,
    requirements: list(draft.requirements, draft.requirementsNone),
    questions: list(draft.questions, draft.questionsNone),
    change_summary: 'Initial intake draft',
  };
}

function ListReview({ items }: { items: string[] | null }) {
  if (items === null) return <span className="scion-create-unknown">Not assessed</span>;
  if (!items.length) return <span>Explicitly none</span>;
  return <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
}

export default function ScionCreation({ token, onSaved, onCancel, onDirty }: Props) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>({ name: '', category: 'unspecified', description: '', decision: '', requirements: '', requirementsNone: false, questions: '', questionsNone: false });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef(false);
  const accepted = useRef(false);
  const mounted = useRef(false);
  const retry = useRef<{ body: string; key: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLDivElement>(null);
  const previousStep = useRef(step);
  const intake = intakeFrom(draft);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (previousStep.current !== step) heading.current?.focus({ preventScroll: true });
    previousStep.current = step;
  }, [step]);
  useEffect(() => { if (error) alert.current?.focus(); }, [error]);

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft(previous => ({ ...previous, [key]: value }));
    onDirty(true); setError('');
  }
  function goTo(next: number) {
    if (pending.current || accepted.current) return;
    setStep(next); setError('');
  }
  function validateLists() {
    for (const [label, items] of [['Requirements', intake.requirements], ['Questions', intake.questions]] as const) {
      if (items && (items.length > 100 || items.some(item => item.length > 2000))) {
        setError(`${label} must contain no more than 100 items, with at most 2,000 characters per item.`);
        setAdvancedOpen(true);
        return false;
      }
    }
    return true;
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || accepted.current || !intake.name) return;
    if (step === 0) { goTo(1); return; }
    if (!validateLists()) return;
    if (step === 1) { goTo(2); return; }
    const body = JSON.stringify(intake);
    // A retry of an unchanged draft keeps the same server idempotency key.
    if (retry.current?.body !== body) retry.current = { body, key: crypto.randomUUID() };
    pending.current = true; setBusy(true); setError('');
    try {
      const scion = await request<Scion>(token, '/scions', { method: 'POST', headers: { 'Idempotency-Key': retry.current.key }, body });
      accepted.current = true;
      if (mounted.current) { onDirty(false); onSaved(scion); }
    } catch (failure) {
      if (!mounted.current) return;
      setError(failure instanceof Error ? failure.message : 'The Scion could not be saved. Please retry.');
      if (failure instanceof ApiError && (failure.status === 0 || failure.status >= 500 || failure.code === 'invalid_response')) setUncertain(true);
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  return <section className="scion-creation" aria-labelledby="scion-create-heading">
    <div className="scion-create-card">
      <ol className="scion-create-steps" aria-label="Scion creation progress">{stepNames.map((name, index) => <li key={name} data-complete={index < step || undefined}>
        <button type="button" disabled={busy || index >= step} aria-current={index === step ? 'step' : undefined} onClick={() => goTo(index)}><span aria-hidden="true">{index < step ? '✓' : index + 1}</span>{name}</button>
      </li>)}</ol>
      <header className="scion-create-heading"><p className="eyebrow">STEP {step + 1} OF 3</p><h1 id="scion-create-heading" ref={heading} tabIndex={-1}>{titles[step]}</h1><p>{descriptions[step]}</p></header>
      <form onSubmit={submit} aria-label={`Create a Scion: ${stepNames[step]}`}>
        <fieldset className="scion-create-fields" disabled={busy}>
          {error && <div className="error-message" role="alert" tabIndex={-1} ref={alert}>{error}</div>}
          {uncertain && <div className="info-notice"><p>The save result is uncertain. Retry the same draft to avoid a duplicate Scion. If you change the draft, check your Scions before creating it again.</p></div>}
          <div className="scion-create-step" key={step}>
          {step === 0 && <>
            <div className="scion-create-field"><label htmlFor="name">Scion name</label><input id="name" value={draft.name} onChange={event => update('name', event.target.value)} maxLength={160} required autoFocus placeholder="e.g. Customer support website" /></div>
            <div className="scion-create-field"><label htmlFor="category">Product type</label><select id="category" value={draft.category} onChange={event => update('category', event.target.value as Category)}><option value="unspecified">Not yet specified</option><option value="digital">Digital product</option><option value="physical">Physical product</option></select><p className="scion-create-help">{draft.category === 'physical' ? 'Physical scope and supplier offers remain available after you save.' : draft.category === 'digital' ? 'Plan capabilities and review evidence. Physical scope and supplier offers do not apply.' : 'You can leave the type unknown and decide later.'}</p></div>
          </>}
          {step === 1 && <>
            <div className="scion-create-field"><label htmlFor="description">Product description <span>Optional</span></label><textarea id="description" value={draft.description} onChange={event => update('description', event.target.value)} rows={3} maxLength={12000} placeholder="What are you building, and who is it for?" /></div>
            <div className="scion-create-field"><label htmlFor="decision">Decision to be made <span>Optional</span></label><textarea id="decision" value={draft.decision} onChange={event => update('decision', event.target.value)} rows={2} maxLength={4000} placeholder="What needs to be decided?" /></div>
            <details className="scion-create-advanced" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
              <summary>Requirements and questions <span>Optional</span></summary>
              <p>Record one item per line. Blank means not assessed; “explicitly none” records that you checked.</p>
              <div className="scion-create-field"><label htmlFor="requirements">Known requirements</label><textarea id="requirements" value={draft.requirements} onChange={event => update('requirements', event.target.value)} disabled={draft.requirementsNone} rows={3} maxLength={200100} placeholder={draft.category === 'physical' ? 'e.g. Material, dimensions, quantities, or compliance requirements' : 'One requirement per line'} aria-describedby="scion-requirements-help" /><p className="scion-create-help" id="scion-requirements-help">Up to 100 items, 2,000 characters each.</p><label className="scion-create-check"><input type="checkbox" checked={draft.requirementsNone} onChange={event => update('requirementsNone', event.target.checked)} /><span>Explicitly record no known requirements</span></label></div>
              <div className="scion-create-field"><label htmlFor="questions">Unresolved questions</label><textarea id="questions" value={draft.questions} onChange={event => update('questions', event.target.value)} disabled={draft.questionsNone} rows={3} maxLength={200100} placeholder="One question per line" /><label className="scion-create-check"><input type="checkbox" checked={draft.questionsNone} onChange={event => update('questionsNone', event.target.checked)} /><span>Explicitly record no unresolved questions</span></label></div>
            </details>
          </>}
          {step === 2 && <>
            <dl className="scion-create-review"><div><dt>Scion name</dt><dd>{intake.name}</dd></div><div><dt>Product type</dt><dd>{categoryNames[intake.product_category]}</dd></div><div><dt>Product description</dt><dd>{intake.product_description ?? <span className="scion-create-unknown">Not provided</span>}</dd></div><div><dt>Decision</dt><dd>{intake.decision ?? <span className="scion-create-unknown">Not provided</span>}</dd></div><div><dt>Requirements</dt><dd><ListReview items={intake.requirements} /></dd></div><div><dt>Open questions</dt><dd><ListReview items={intake.questions} /></dd></div></dl>
            <p className="scion-create-boundary">Creates an intake draft, revision 1. Saving grants no product qualification, sourcing decision, or human approval.</p>
          </>}
          </div>
          <div className="scion-create-actions"><button className="button secondary" type="button" onClick={step === 0 ? onCancel : () => goTo(step - 1)} disabled={busy}>{step === 0 ? 'Cancel' : '← Back'}</button><button className="button primary" type="submit" disabled={busy || !intake.name} aria-label={step === 2 && !busy ? 'Create Scion' : undefined}>{busy ? 'Creating…' : step === 2 ? 'Create Scion' : step === 1 ? 'Review' : 'Continue'}{!busy && <span aria-hidden="true">→</span>}</button></div>
        </fieldset>
      </form>
    </div>
    <p className="scion-create-footnote">Your brief stays in this organization. You can revise it after saving.</p>
  </section>;
}
