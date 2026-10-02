import './work-state-glyph.css';

export type WorkState = 'todo' | 'in_progress' | 'needs_input' | 'needs_review' | 'completed' | 'blocked' | 'cancelled' | 'neutral';

/** Decorative shape; callers must render the actual state as text beside it. */
export default function WorkStateGlyph({ state }: { state: WorkState }) {
  return <span className={`work-state-glyph work-state-glyph-${state}`} aria-hidden="true">{state === 'completed' ? '✓' : state === 'blocked' ? '−' : state === 'cancelled' ? '×' : state === 'needs_input' ? '?' : state === 'needs_review' ? '•' : ''}</span>;
}
