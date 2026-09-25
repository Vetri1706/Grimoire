package main

// This exercises the real task API as a scoped protocol client. It does not
// pretend to execute an LLM. The actual Codex CLI run is recorded separately.
import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

type agentTask struct {
	ID         string          `json:"id"`
	Status     string          `json:"status"`
	ProposalID *string         `json:"proposal_id"`
	Lease      string          `json:"lease_token"`
	Input      json.RawMessage `json:"input"`
	Revision   int             `json:"scion_revision"`
	Timeout    int             `json:"timeout_seconds"`
	ClaimedAt  time.Time       `json:"claimed_at"`
	LeaseUntil time.Time       `json:"lease_until"`
}

func (h *harness) dispatchTask(path, id string) error {
	_, e := h.sourceReq("POST", path+"/agent-tasks/"+id+"/dispatch", h.tokenA, nil, "", `"1"`, 200)
	return e
}
func (h *harness) agentProposal(path string, body any, key string, task agentTask, status int) (response, error) {
	r, e := h.client.request("POST", path, h.agent, body, map[string]string{"If-Match": `"1"`, "Idempotency-Key": h.runID + "-" + key, "X-Grimoire-Task-Id": task.ID, "X-Grimoire-Task-Lease": task.Lease})
	if e != nil {
		return r, e
	}
	return r, expectStatus(r, status)
}

func (h *harness) runAgentQueue() error {
	f, e := h.newScopeFixture("agent-queue")
	if e != nil {
		return e
	}
	body := map[string]any{"task_kind": "prepare_physical_scope", "candidate_proposal": f.proposal}
	var task agentTask
	var created response
	if e = h.check("BYOA task queue requires Handler authority and preserves one task on retry", func() error {
		if _, err := h.sourceReq("POST", f.path+"/agent-tasks", h.agent, body, "agent-enqueue-denied", `"1"`, 403); err != nil {
			return err
		}
		var err error
		created, err = h.sourceReq("POST", f.path+"/agent-tasks", h.tokenA, body, "agent-enqueue", `"1"`, 201)
		if err != nil {
			return err
		}
		task, err = decode[agentTask](created)
		if err != nil {
			return err
		}
		replay, err := h.sourceReq("POST", f.path+"/agent-tasks", h.tokenA, body, "agent-enqueue", `"1"`, 201)
		if err != nil {
			return err
		}
		again, err := decode[agentTask](replay)
		if err != nil {
			return err
		}
		if task.ID == "" || task.Status != "queued" || again.ID != task.ID || task.ProposalID != nil || len(task.Input) > 0 || task.Lease != "" {
			return fmt.Errorf("invalid queue state or task content leaked")
		}
		return nil
	}); e != nil {
		return e
	}
	taskPath := "/api/agent/tasks/" + task.ID
	if e = h.check("BYOA hides task lists across organizations and restricts worker polling", func() error {
		if _, err := h.sourceReq("GET", f.path+"/agent-tasks", h.tokenB, nil, "", "", 404); err != nil {
			return err
		}
		if _, err := h.sourceReq("GET", "/api/agent/tasks/next", h.tokenA, nil, "", "", 403); err != nil {
			return err
		}
		_, err := h.sourceReq("POST", taskPath+"/claim", h.tokenA, nil, "", "", 403)
		return err
	}); e != nil {
		return e
	}
	var claimed agentTask
	if e = h.check("BYOA queued work requires explicit Handler dispatch before a worker can claim it", func() error {
		if _, err := h.sourceReq("POST", taskPath+"/claim", h.agent, nil, "", "", 409); err != nil {
			return err
		}
		if _, err := h.sourceReq("POST", f.path+"/agent-tasks/"+task.ID+"/dispatch", h.agent, nil, "", `"1"`, 403); err != nil {
			return err
		}
		if _, err := h.sourceReq("POST", f.path+"/agent-tasks/"+task.ID+"/dispatch", h.tokenB, nil, "", `"1"`, 404); err != nil {
			return err
		}
		return h.dispatchTask(f.path, task.ID)
	}); e != nil {
		return e
	}
	if e = h.check("BYOA atomic claim returns scoped input once and denies a competing claim", func() error {
		res, err := h.sourceReq("POST", taskPath+"/claim", h.agent, nil, "", "", 200)
		if err != nil {
			return err
		}
		claimed, err = decode[agentTask](res)
		if err != nil {
			return err
		}
		if claimed.Status != "running" || claimed.Lease == "" || len(claimed.Input) == 0 {
			return fmt.Errorf("claim lacks lease and authorized input")
		}
		_, err = h.sourceReq("POST", taskPath+"/claim", h.agent, nil, "", "", 409)
		return err
	}); e != nil {
		return e
	}
	var p scopeProposal
	if e = h.check("BYOA agent submits a proposal without conferring human confirmation", func() error {
		res, err := h.agentProposal(f.path+"/scope/proposals", f.proposal, "agent-result-proposal", claimed, 201)
		if err != nil {
			return err
		}
		p, err = decode[scopeProposal](res)
		if err != nil {
			return err
		}
		if p.ID == "" || string(p.Confirmation) != "null" || p.CreatedBy != "10000000-0000-4000-8000-000000000018" {
			return fmt.Errorf("proposal lacks correct agent provenance")
		}
		_, err = h.sourceReq("POST", f.path+"/scope/proposals/"+p.ID+"/confirm", h.agent, confirmationBody(), "agent-cannot-confirm-own-output", `"1"`, 403)
		return err
	}); e != nil {
		return e
	}
	result := map[string]any{"proposal_id": p.ID, "provider_run_id": "protocol-check-no-llm", "output_sha256": strings.Repeat("0", 64), "preparation_note": "Synthetic Go protocol test only; actual Codex execution is a separate smoke check."}
	if e = h.check("BYOA task result requires current lease and cannot substitute another Scion proposal", func() error {
		if _, err := h.sourceReq("POST", taskPath+"/result", h.agent, result, "", "", 409); err != nil {
			return err
		}
		foreign, err := h.newScopeFixture("agent-other")
		if err != nil {
			return err
		}
		res, err := h.sourceReq("POST", foreign.path+"/scope/proposals", h.tokenA, foreign.proposal, "agent-other-proposal", `"1"`, 201)
		if err != nil {
			return err
		}
		other, err := decode[scopeProposal](res)
		if err != nil {
			return err
		}
		wrong := cloneScope(result)
		wrong["proposal_id"] = other.ID
		res, err = h.client.request("POST", taskPath+"/result", h.agent, wrong, map[string]string{"X-Grimoire-Task-Lease": claimed.Lease})
		if err != nil {
			return err
		}
		return expectStatus(res, 409)
	}); e != nil {
		return e
	}
	if e = h.check("BYOA task completion and retry retain proposal-only status across API restart", func() error {
		for i := 0; i < 2; i++ {
			res, err := h.client.request("POST", taskPath+"/result", h.agent, result, map[string]string{"X-Grimoire-Task-Lease": claimed.Lease})
			if err != nil {
				return err
			}
			if err = expectStatus(res, 200); err != nil {
				return err
			}
			done, err := decode[agentTask](res)
			if err != nil {
				return err
			}
			if done.Status != "completed" || done.ProposalID == nil || *done.ProposalID != p.ID {
				return fmt.Errorf("task did not retain proposal link")
			}
		}
		if err := h.process.stop(); err != nil {
			return err
		}
		if err := h.process.start(h.client); err != nil {
			return err
		}
		res, err := h.sourceReq("GET", f.path+"/agent-tasks", h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		list, err := decode[struct {
			Tasks []agentTask `json:"tasks"`
		}](res)
		if err != nil {
			return err
		}
		if len(list.Tasks) != 1 || list.Tasks[0].Status != "completed" {
			return fmt.Errorf("task not durable")
		}
		res, err = h.sourceReq("GET", f.path+"/scope/proposals/"+p.ID, h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		saved, err := decode[scopeProposal](res)
		if err != nil {
			return err
		}
		if string(saved.Confirmation) != "null" {
			return fmt.Errorf("agent completion became confirmation")
		}
		return nil
	}); e != nil {
		return e
	}
	if e = h.check("BYOA revoked queued input is denied and terminally failed without exposing content", func() error {
		revoked, err := h.newScopeFixture("agent-revoked")
		if err != nil {
			return err
		}
		payload := map[string]any{"task_kind": "prepare_physical_scope", "candidate_proposal": revoked.proposal}
		res, err := h.sourceReq("POST", revoked.path+"/agent-tasks", h.tokenA, payload, "agent-revoked-queue", `"1"`, 201)
		if err != nil {
			return err
		}
		job, err := decode[agentTask](res)
		if err != nil {
			return err
		}
		if err = h.dispatchTask(revoked.path, job.ID); err != nil {
			return err
		}
		if _, err = h.sourceReq("POST", revoked.sourcePaths[0]+"/revoke", h.tokenA, map[string]string{"reason": "Synthetic task source permission withdrawn"}, "agent-revoke-source", `"1"`, 201); err != nil {
			return err
		}
		res, err = h.sourceReq("POST", "/api/agent/tasks/"+job.ID+"/claim", h.agent, nil, "", "", 403)
		if err != nil {
			return err
		}
		if strings.Contains(string(res.body), "candidate_proposal") {
			return fmt.Errorf("revoked task input leaked")
		}
		res, err = h.sourceReq("GET", revoked.path+"/agent-tasks", h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		list, err := decode[struct {
			Tasks []agentTask `json:"tasks"`
		}](res)
		if err != nil {
			return err
		}
		if len(list.Tasks) != 1 || list.Tasks[0].Status != "failed" {
			return fmt.Errorf("revoked task remains in runnable queue: %s", res.body)
		}
		return nil
	}); e != nil {
		return e
	}
	if e = h.check("BYOA stale claimed task cannot complete after intake changes", func() error {
		stale, err := h.newScopeFixture("agent-stale")
		if err != nil {
			return err
		}
		payload := map[string]any{"task_kind": "prepare_physical_scope", "candidate_proposal": stale.proposal}
		res, err := h.sourceReq("POST", stale.path+"/agent-tasks", h.tokenA, payload, "agent-stale-queue", `"1"`, 201)
		if err != nil {
			return err
		}
		job, err := decode[agentTask](res)
		if err != nil {
			return err
		}
		if err = h.dispatchTask(stale.path, job.ID); err != nil {
			return err
		}
		res, err = h.sourceReq("POST", "/api/agent/tasks/"+job.ID+"/claim", h.agent, nil, "", "", 200)
		if err != nil {
			return err
		}
		lease, err := decode[agentTask](res)
		if err != nil {
			return err
		}
		res, err = h.agentProposal(stale.path+"/scope/proposals", stale.proposal, "agent-stale-proposal", lease, 201)
		if err != nil {
			return err
		}
		proposal, err := decode[scopeProposal](res)
		if err != nil {
			return err
		}
		if _, err = h.req("POST", stale.path+"/revisions", h.tokenA, stale.draft, "agent-stale-edit", `"1"`, 201); err != nil {
			return err
		}
		output := cloneScope(result)
		output["proposal_id"] = proposal.ID
		res, err = h.client.request("POST", "/api/agent/tasks/"+job.ID+"/result", h.agent, output, map[string]string{"X-Grimoire-Task-Lease": lease.Lease})
		if err != nil {
			return err
		}
		if err = expectStatus(res, 412); err != nil {
			return err
		}
		res, err = h.client.request("POST", "/api/agent/tasks/"+job.ID+"/fail", h.agent, map[string]string{"failure_code": "SYNTHETIC_STALE_INPUT"}, map[string]string{"X-Grimoire-Task-Lease": lease.Lease})
		if err != nil {
			return err
		}
		return expectStatus(res, 200)
	}); e != nil {
		return e
	}
	return h.runTaskControls()
}

func (h *harness) runTaskControls() error {
	f, e := h.newScopeFixture("worker-controls")
	if e != nil {
		return e
	}
	queue := func(key string, timeout int) (agentTask, error) {
		r, e := h.sourceReq("POST", f.path+"/agent-tasks", h.tokenA, map[string]any{"task_kind": "prepare_physical_scope", "candidate_proposal": f.proposal, "timeout_seconds": timeout}, key, `"1"`, 201)
		if e != nil {
			return agentTask{}, e
		}
		return decode[agentTask](r)
	}
	var running, waiting agentTask
	if e = h.check("task bounds reject unlimited execution and record exact Scion revision", func() error {
		for _, timeout := range []int{0, 29, 301} {
			_, err := h.sourceReq("POST", f.path+"/agent-tasks", h.tokenA, map[string]any{"task_kind": "prepare_physical_scope", "candidate_proposal": f.proposal, "timeout_seconds": timeout}, fmt.Sprintf("worker-bad-bound-%d", timeout), `"1"`, 422)
			if err != nil {
				return err
			}
		}
		var err error
		running, err = queue("worker-running", 30)
		if err != nil {
			return err
		}
		waiting, err = queue("worker-waiting", 30)
		if err != nil {
			return err
		}
		if running.Timeout != 30 || running.Revision != 1 {
			return fmt.Errorf("execution bounds or revision missing")
		}
		return nil
	}); e != nil {
		return e
	}
	if e = h.check("organization concurrency limit holds across distinct dispatched tasks", func() error {
		for _, t := range []agentTask{running, waiting} {
			if err := h.dispatchTask(f.path, t.ID); err != nil {
				return err
			}
		}
		tasks := []agentTask{running, waiting}
		rs := make([]response, 2)
		errs := make([]error, 2)
		var wg sync.WaitGroup
		start := make(chan struct{})
		for i, t := range tasks {
			wg.Add(1)
			go func(i int, t agentTask) {
				defer wg.Done()
				<-start
				rs[i], errs[i] = h.client.request("POST", "/api/agent/tasks/"+t.ID+"/claim", h.agent, nil, nil)
			}(i, t)
		}
		close(start)
		wg.Wait()
		wins := 0
		for i, r := range rs {
			if errs[i] != nil {
				return errs[i]
			}
			if r.status == 200 {
				wins++
				var err error
				running, err = decode[agentTask](r)
				if err != nil {
					return err
				}
				waiting = tasks[1-i]
			} else if r.status != 409 {
				return fmt.Errorf("claim race HTTP%d: %s", r.status, r.body)
			}
		}
		if wins != 1 {
			return fmt.Errorf("%d active worker winners", wins)
		}
		return nil
	}); e != nil {
		return e
	}
	if e = h.check("running cancellation blocks proposal/results and retains slot until worker acknowledges termination", func() error {
		if _, err := h.sourceReq("POST", f.path+"/agent-tasks/"+running.ID+"/cancel", h.tokenA, nil, "", "", 202); err != nil {
			return err
		}
		if _, err := h.agentProposal(f.path+"/scope/proposals", f.proposal, "worker-cancelled-proposal", running, 409); err != nil {
			return err
		}
		lateResult, err := h.client.request("POST", "/api/agent/tasks/"+running.ID+"/result", h.agent, map[string]any{"proposal_id": "00000000-0000-4000-8000-000000000001", "provider_run_id": "cancelled-protocol-check", "output_sha256": strings.Repeat("2", 64), "preparation_note": "Cancellation must reject results before proposal resolution."}, map[string]string{"X-Grimoire-Task-Lease": running.Lease})
		if err != nil {
			return err
		}
		if err = expectStatus(lateResult, 409); err != nil {
			return err
		}
		if _, err := h.sourceReq("POST", "/api/agent/tasks/"+waiting.ID+"/claim", h.agent, nil, "", "", 409); err != nil {
			return err
		}
		r, err := h.client.request("POST", "/api/agent/tasks/"+running.ID+"/cancelled", h.agent, nil, map[string]string{"X-Grimoire-Task-Lease": running.Lease})
		if err != nil {
			return err
		}
		if err = expectStatus(r, 200); err != nil {
			return err
		}
		job, err := decode[agentTask](r)
		if err != nil {
			return err
		}
		if job.Status != "cancelled" {
			return fmt.Errorf("cancellation not durable")
		}
		r, err = h.sourceReq("POST", "/api/agent/tasks/"+waiting.ID+"/claim", h.agent, nil, "", "", 200)
		if err != nil {
			return err
		}
		waiting, err = decode[agentTask](r)
		return err
	}); e != nil {
		return e
	}
	if e = h.check("task event audit hides cross-organization access and preserves dispatch/cancellation history", func() error {
		path := f.path + "/agent-tasks/" + running.ID + "/events"
		if _, err := h.sourceReq("GET", path, h.tokenB, nil, "", "", 404); err != nil {
			return err
		}
		r, err := h.sourceReq("GET", path, h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		for _, state := range []string{"queued", "dispatched", "running", "cancel_requested", "cancelled"} {
			if !strings.Contains(string(r.body), `"status":"`+state+`"`) {
				return fmt.Errorf("missing %s event: %s", state, r.body)
			}
		}
		return nil
	}); e != nil {
		return e
	}
	if e = h.check("bounded task lease expires terminally after a real elapsed deadline; late proposals are rejected", func() error {
		// A 30s execution bound plus 30s cleanup grace is exercised against the DB clock.
		// Timed wait is intentional acceptance evidence; no test-only clock or DB mutation.
		executionDeadline := waiting.ClaimedAt.Add(31 * time.Second)
		for time.Now().Before(executionDeadline) {
			time.Sleep(time.Second)
		}
		control, err := h.client.request("GET", "/api/agent/tasks/"+waiting.ID+"/control", h.agent, nil, map[string]string{"X-Grimoire-Task-Lease": waiting.Lease})
		if err != nil {
			return err
		}
		if err = expectStatus(control, 200); err != nil {
			return err
		}
		state, err := decode[struct {
			Continue bool `json:"continue"`
		}](control)
		if err != nil {
			return err
		}
		if state.Continue {
			return fmt.Errorf("execution continues past declared timeout")
		}
		if _, err = h.agentProposal(f.path+"/scope/proposals", f.proposal, "worker-past-deadline-proposal", waiting, 409); err != nil {
			return err
		}
		deadline := waiting.LeaseUntil.Add(time.Second)
		for time.Now().Before(deadline) {
			time.Sleep(2 * time.Second)
		}
		if _, err := h.sourceReq("GET", "/api/agent/tasks/next", h.agent, nil, "", "", 200); err != nil {
			return err
		}
		r, err := h.sourceReq("GET", f.path+"/agent-tasks", h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		list, err := decode[struct {
			Tasks []agentTask `json:"tasks"`
		}](r)
		if err != nil {
			return err
		}
		for _, t := range list.Tasks {
			if t.ID == waiting.ID && t.Status != "failed" {
				return fmt.Errorf("expired task status=%s", t.Status)
			}
		}
		_, err = h.agentProposal(f.path+"/scope/proposals", f.proposal, "worker-expired-proposal", waiting, 409)
		return err
	}); e != nil {
		return e
	}
	if e = h.check("undispatched cancellation prevents provider execution and is idempotent", func() error {
		t, err := queue("worker-queued-cancel", 30)
		if err != nil {
			return err
		}
		for i := 0; i < 2; i++ {
			if _, err = h.sourceReq("POST", f.path+"/agent-tasks/"+t.ID+"/cancel", h.tokenA, nil, "", "", 200); err != nil {
				return err
			}
		}
		_, err = h.sourceReq("POST", "/api/agent/tasks/"+t.ID+"/claim", h.agent, nil, "", "", 409)
		return err
	}); e != nil {
		return e
	}
	return nil
}
