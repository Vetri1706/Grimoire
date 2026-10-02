import type { Intake } from './api';

export type TaskWorkflowState = 'todo' | 'in_progress' | 'needs_input' | 'needs_review' | 'completed' | 'blocked' | 'cancelled';
export type TaskWorkflow = { state: TaskWorkflowState; label: string; action: 'start' | 'wait' | 'answer' | 'review' | 'retry' | 'resolve' | 'none' };
export function taskWorkflow(input: { status: string; blocked?: boolean; stale?: boolean; reviewed?: boolean; needsInput?: boolean }): TaskWorkflow {
  if (input.status === 'cancelled') return { state: 'cancelled', label: 'Cancelled', action: 'none' };
  if (input.blocked || input.stale) return { state: 'blocked', label: 'Blocked', action: 'resolve' };
  if (input.status === 'failed') return { state: 'blocked', label: 'Blocked', action: 'retry' };
  if (input.status === 'queued') return { state: 'todo', label: 'To do', action: 'start' };
  if (['dispatched', 'running', 'cancel_requested'].includes(input.status)) return { state: 'in_progress', label: 'In progress', action: 'wait' };
  if (input.status === 'completed' && input.reviewed) return { state: 'completed', label: 'Completed', action: 'none' };
  if (input.status === 'completed' && input.needsInput) return { state: 'needs_input', label: 'Needs input', action: 'answer' };
  if (input.status === 'completed') return { state: 'needs_review', label: 'Needs review', action: 'review' };
  return { state: 'blocked', label: 'Blocked', action: 'resolve' };
}

export function taskWorkflowPriority(workflow: TaskWorkflow): number {
  return { needs_input: 0, needs_review: 1, todo: 2, in_progress: 3, blocked: 4, completed: 5, cancelled: 6 }[workflow.state];
}

/** An uncertain earlier write must be replayed, even if a later request is denied. */
export function taskCreationRejected(status: number, code: string, earlierOutcomeUnknown: boolean): boolean {
  if (code === 'IDEMPOTENCY_CONFLICT') return false;
  // The create endpoint checks its existing receipt before returning stale.
  if (status === 412) return true;
  return !earlierOutcomeUnknown && [400, 401, 403, 404, 409, 422].includes(status);
}

export function taskFailureExplanation(code: string | null): string {
  const known: Record<string, string> = {
    RESEARCH_UNAVAILABLE: 'Codex did not return a usable public web search. Check the connected computer and retry with a narrower question.',
    UNOBSERVED_RESEARCH_SOURCE: 'The report cited a URL missing from the recorded search results. No report was accepted.',
    RESEARCH_QUERY_LIMIT: 'The research exceeded its query limit. Narrow the question before retrying.',
    RESEARCH_TOOL_LIMIT: 'The research exceeded its tool limit. Narrow the question before retrying.',
    UNEXPECTED_AGENT_TOOL_USE: 'The agent attempted a tool outside this task?s allowed capabilities. Execution was stopped.',
    INVALID_RESEARCH_REPORT: 'The research result did not meet the required report format. No result was accepted.',
    INVALID_CODEX_EVENT: 'The worker could not validate Codex?s execution record. No result was accepted.',
    CODEX_TIMEOUT: 'Codex reached this task’s time limit before returning a usable result.',
    CODEX_TASK_FAILED: 'Codex exited without a usable result. Check its local terminal before retrying.',
    CODEX_START_FAILED: 'The worker could not start Codex. Check the installation and login on that computer.',
    CODEX_BINARY_UNAVAILABLE: 'The worker could not find the Codex executable on its computer.',
    CODEX_OUTPUT_LIMIT: 'The response exceeded the bounded result size. Narrow the brief before retrying.',
    INVALID_AGENT_OUTPUT: 'The response did not match the required proposal format. No result was accepted.',
    INVALID_CAPABILITY_CANDIDATE: 'The proposed capability input was invalid. Review the current brief before preparing another task.',
    INPUT_UNAVAILABLE: 'The task’s inputs could not be used. Check the current brief and source permissions before retrying.',
    LEASE_EXPIRED: 'The worker stopped reporting within this task’s allowed execution window.',
  };
  return code && known[code] || 'The task did not produce an accepted result. Inspect its recorded failure and check the local worker before retrying.';
}

/** Handler-authored answers create a new brief revision; they never amend a proposal. */
export function answeredIntake(base: Intake, answers: Record<number, string>, description: string, decision: string): Intake {
  const answered = (base.questions ?? []).flatMap((question, index) => {
    const answer = answers[index]?.trim();
    return answer ? [`Handler answer — ${question}\n${answer}`] : [];
  });
  const requirements = answered.length ? [...(base.requirements ?? []), ...answered] : base.requirements;
  if (requirements && (requirements.length > 100 || requirements.some(item => item.length > 2000))) throw new Error('The brief supports up to 100 requirements, each up to 2,000 characters including the question and answer. Shorten the answer or edit the brief.');
  return {
    name: base.name, product_category: base.product_category,
    product_description: description.trim() || base.product_description,
    decision: decision.trim() || base.decision,
    requirements,
    questions: base.questions === null ? null : base.questions.filter((_, index) => !answers[index]?.trim()),
    change_summary: 'Handler supplied task inputs and answered brief questions',
  };
}
