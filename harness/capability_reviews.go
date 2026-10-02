package main

// Handler review receipts exercise the real API/database. Known protocol
// output is a synthetic fixture, never a model invocation or approval.
import (
	"bytes"
	"fmt"
	"strings"
)

type capabilityReview struct {
	ID            string `json:"id"`
	PlanID        string `json:"plan_id"`
	ScionRevision int    `json:"scion_revision"`
	ReviewerID    string `json:"reviewer_id"`
	Note          string `json:"note"`
	CreatedAt     string `json:"created_at"`
}

func (h *harness) reviewFixture(label string) (adaptiveFixture, agentTask, adaptivePlan, string, sourceInput, error) {
	f, err := h.newAdaptiveFixture(label)
	if err != nil {
		return f, agentTask{}, adaptivePlan{}, "", sourceInput{}, err
	}
	source, _, input, err := h.adaptiveSource(f.path, label, "Synthetic reviewed workflow: a visitor requests a workshop place.")
	if err != nil {
		return f, agentTask{}, adaptivePlan{}, source, input, err
	}
	task, err := h.adaptiveTask(f.path, label, 1)
	if err != nil {
		return f, task, adaptivePlan{}, source, input, err
	}
	task, err = h.adaptiveClaim(f.path, task, 1)
	if err != nil {
		return f, task, adaptivePlan{}, source, input, err
	}
	state, err := h.adaptiveRead(f.path)
	if err != nil {
		return f, task, adaptivePlan{}, source, input, err
	}
	r, err := h.agentProposal(f.path+"/capability-plans", adaptivePlanBody(state.UnresolvedGaps), label+"-plan", task, 201)
	if err != nil {
		return f, task, adaptivePlan{}, source, input, err
	}
	plan, err := decode[adaptivePlan](r)
	if err == nil {
		err = h.adaptiveComplete(task, plan.ID)
	}
	return f, task, plan, source, input, err
}

func (h *harness) reviewWorkspace(taskID string, expected bool) error {
	r, err := h.sourceReq("GET", "/api/workspace", h.tokenA, nil, "", "", 200)
	if err != nil {
		return err
	}
	value, err := decode[struct {
		Tasks []struct {
			ID             string  `json:"id"`
			ReviewRecorded bool    `json:"review_recorded"`
			CompletedAt    *string `json:"completed_at"`
		} `json:"tasks"`
	}](r)
	if err != nil {
		return err
	}
	for _, task := range value.Tasks {
		if task.ID == taskID {
			if task.ReviewRecorded != expected || task.CompletedAt == nil {
				return fmt.Errorf("workspace review metadata wrong: %+v", task)
			}
			return nil
		}
	}
	return fmt.Errorf("review task absent from workspace")
}

func (h *harness) runCapabilityReviews() error {
	f, task, plan, sourcePath, source, err := h.reviewFixture("handler-review")
	if err != nil {
		return err
	}
	reviewPath := f.path + "/capability-plans/" + plan.ID + "/reviews"
	note := "SYNTHETIC_HANDLER_REVIEW_" + h.runID + ": reviewed capability hypotheses; unknowns remain and no approval is granted."
	body := map[string]any{"note": note}
	var receipt capabilityReview
	var initial response
	var before controlSurface
	if err = h.check("completed capability task accepts an immutable human review receipt without approval or alert resolution", func() error {
		var e error
		before, _, e = h.controlRead(f.path)
		if e != nil {
			return e
		}
		initial, e = h.sourceReq("POST", reviewPath, h.tokenA, body, "handler-review-receipt", `"1"`, 201)
		if e != nil {
			return e
		}
		receipt, e = decode[capabilityReview](initial)
		if e != nil {
			return e
		}
		if receipt.ID == "" || receipt.PlanID != plan.ID || receipt.ScionRevision != 1 || receipt.ReviewerID == "" || receipt.Note != note || receipt.CreatedAt == "" {
			return fmt.Errorf("review provenance missing: %+v", receipt)
		}
		state, e := h.adaptiveRead(f.path)
		if e != nil {
			return e
		}
		p, e := adaptiveFindPlan(state, plan.ID)
		if e != nil {
			return e
		}
		if p.Status != "current" || len(p.Reviews) != 1 || p.Reviews[0] != receipt {
			return fmt.Errorf("review changed proposal state or failed persistence")
		}
		after, _, e := h.controlRead(f.path)
		if e != nil {
			return e
		}
		if after.ApprovalAvailable || len(after.Operations.HumanReview) != len(before.Operations.HumanReview) {
			return fmt.Errorf("review altered approval or required alert count")
		}
		for _, item := range after.Operations.HumanReview {
			if item.Status != "required" {
				return fmt.Errorf("review resolved a Watchtower gate")
			}
		}
		if _, e = after.oneEvent("capability_plan_reviewed", plan.ID); e != nil {
			return e
		}
		return h.reviewWorkspace(task.ID, true)
	}); err != nil {
		return err
	}
	if err = h.check("review retry returns one receipt and one audit event; changed keys cannot rewrite a receipt", func() error {
		r, e := h.sourceReq("POST", reviewPath, h.tokenA, body, "handler-review-receipt", `"1"`, 201)
		if e != nil {
			return e
		}
		if !equalJSON(initial.body, r.body) || r.header.Get("Idempotency-Replayed") != "true" {
			return fmt.Errorf("review replay changed receipt")
		}
		if _, e = h.sourceReq("POST", reviewPath, h.tokenA, map[string]any{"note": "Changed note"}, "handler-review-receipt", `"1"`, 409); e != nil {
			return e
		}
		after, _, e := h.controlRead(f.path)
		if e != nil {
			return e
		}
		if len(after.Operations.Events) != len(before.Operations.Events)+1 || len(after.Operations.HumanReview) != len(before.Operations.HumanReview) {
			return fmt.Errorf("review retry duplicated audit effects")
		}
		_, e = after.oneEvent("capability_plan_reviewed", plan.ID)
		return e
	}); err != nil {
		return err
	}
	if err = h.check("review requires authentication, human preparation authority, current precondition and bounded note", func() error {
		for _, entry := range []struct {
			token  string
			status int
		}{{"", 401}, {h.agent, 403}, {h.tokenB, 404}} {
			if _, e := h.sourceReq("POST", reviewPath, entry.token, body, "review-denied-"+fmt.Sprint(entry.status), `"1"`, entry.status); e != nil {
				return e
			}
		}
		if _, e := h.sourceReq("POST", reviewPath, h.tokenA, body, "review-no-match", "", 428); e != nil {
			return e
		}
		for index, bad := range []map[string]any{{"note": ""}, {"note": strings.Repeat("x", 2001)}, {"note": "Review", "approved": true}} {
			if _, e := h.sourceReq("POST", reviewPath, h.tokenA, bad, fmt.Sprintf("review-invalid-%d", index), `"1"`, 422); e != nil {
				return e
			}
		}
		return nil
	}); err != nil {
		return err
	}
	if err = h.check("a new task intent can prepare another capability proposal while original task retries remain idempotent", func() error {
		replay, e := h.adaptiveTask(f.path, "handler-review", 1)
		if e != nil {
			return e
		}
		if replay.ID != task.ID || replay.Status != "completed" {
			return fmt.Errorf("original task retry lost completion")
		}
		fresh, e := h.adaptiveTask(f.path, "handler-review-new-intent", 1)
		if e != nil {
			return e
		}
		if fresh.ID == task.ID || fresh.Status != "queued" {
			return fmt.Errorf("distinct task key did not create replacement work")
		}
		_, e = h.sourceReq("POST", f.path+"/agent-tasks/"+fresh.ID+"/cancel", h.tokenA, nil, "", `"1"`, 200)
		return e
	}); err != nil {
		return err
	}
	if err = h.check("review receipt and single audit event survive real Rust restart", func() error {
		if e := h.restartSources(); e != nil {
			return e
		}
		state, e := h.adaptiveRead(f.path)
		if e != nil {
			return e
		}
		p, e := adaptiveFindPlan(state, plan.ID)
		if e != nil {
			return e
		}
		if len(p.Reviews) != 1 || p.Reviews[0] != receipt {
			return fmt.Errorf("review receipt lost across restart")
		}
		after, _, e := h.controlRead(f.path)
		if e != nil {
			return e
		}
		_, e = after.oneEvent("capability_plan_reviewed", plan.ID)
		return e
	}); err != nil {
		return err
	}
	if err = h.check("source revision change hides review notes and blocks review replay without duplicating audit", func() error {
		source.SourceText += "Synthetic changed workflow.\n"
		source.ChangeSummary = "Change reviewed source revision"
		if _, e := h.sourceReq("POST", sourcePath+"/revisions", h.tokenA, source, "review-source-r2", `"1"`, 201); e != nil {
			return e
		}
		if _, e := h.sourceReq("POST", reviewPath, h.tokenA, body, "handler-review-receipt", `"1"`, 409); e != nil {
			return e
		}
		r, e := h.sourceReq("GET", f.path+"/capabilities", h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		state, e := decode[adaptiveState](r)
		if e != nil {
			return e
		}
		p, e := adaptiveFindPlan(state, plan.ID)
		if e != nil {
			return e
		}
		if len(p.Reviews) != 0 || string(p.Input) != "null" || bytes.Contains(r.body, []byte(note)) {
			return fmt.Errorf("stale review content leaked")
		}
		return h.reviewWorkspace(task.ID, false)
	}); err != nil {
		return err
	}
	if err = h.check("new Scion revision permits new preparation while old plan review remains stale", func() error {
		f.draft.ChangeSummary = "Record revised synthetic review brief"
		if _, e := h.sourceReq("POST", f.path+"/revisions", h.tokenA, f.draft, "review-scion-r2", `"1"`, 201); e != nil {
			return e
		}
		if _, e := h.sourceReq("POST", reviewPath, h.tokenA, body, "review-old-plan", `"2"`, 412); e != nil {
			return e
		}
		fresh, e := h.adaptiveTask(f.path, "review-r2-task", 2)
		if e != nil {
			return e
		}
		if fresh.Revision != 2 {
			return fmt.Errorf("replacement task not pinned to revision2")
		}
		_, e = h.sourceReq("POST", f.path+"/agent-tasks/"+fresh.ID+"/cancel", h.tokenA, nil, "", `"2"`, 200)
		return e
	}); err != nil {
		return err
	}
	return h.check("source revocation blocks new reviews and retries and hides existing notes after restart", func() error {
		g, t, p, source, _, e := h.reviewFixture("review-revocation")
		if e != nil {
			return e
		}
		endpoint := g.path + "/capability-plans/" + p.ID + "/reviews"
		if _, e = h.sourceReq("POST", endpoint, h.tokenA, body, "revocation-review", `"1"`, 201); e != nil {
			return e
		}
		if _, e = h.sourceReq("POST", source+"/revoke", h.tokenA, map[string]string{"reason": "Synthetic source permission withdrawal"}, "review-source-revoke", `"1"`, 201); e != nil {
			return e
		}
		for _, key := range []string{"revocation-review", "revocation-new-review"} {
			if _, e = h.sourceReq("POST", endpoint, h.tokenA, body, key, `"1"`, 403); e != nil {
				return e
			}
		}
		if e = h.restartSources(); e != nil {
			return e
		}
		r, e := h.sourceReq("GET", g.path+"/capabilities", h.tokenA, nil, "", "", 200)
		if e != nil {
			return e
		}
		state, e := decode[adaptiveState](r)
		if e != nil {
			return e
		}
		hidden, e := adaptiveFindPlan(state, p.ID)
		if e != nil {
			return e
		}
		if hidden.Status != "blocked" || len(hidden.Reviews) != 0 || bytes.Contains(r.body, []byte(note)) {
			return fmt.Errorf("revocation restored review content")
		}
		return h.reviewWorkspace(t.ID, false)
	})
}
