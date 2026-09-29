package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

type managedRecord struct {
	ID       string         `json:"id"`
	Revision int            `json:"revision"`
	Config   map[string]any `json:"config"`
}
type nativeDetail struct {
	Agent managedRecord `json:"agent"`
	Tasks []struct {
		ID            string `json:"id"`
		Status        string `json:"status"`
		AgentRevision int    `json:"agent_revision"`
	} `json:"tasks"`
	Revisions []managedRecord   `json:"revisions"`
	Events    []json.RawMessage `json:"events"`
	Runtime   struct {
		Backend string `json:"backend"`
		Status  string `json:"status"`
	} `json:"runtime"`
}

func (h *harness) nativeDetail(id string) (nativeDetail, error) {
	result, err := h.sourceReq("GET", "/api/agents/"+id, h.tokenA, nil, "", "", 200)
	if err != nil {
		return nativeDetail{}, err
	}
	return decode[nativeDetail](result)
}
func (h *harness) nativeClaim(id string) (agentTask, json.RawMessage, error) {
	response, err := h.client.request("POST", "/api/agent/tasks/"+id+"/claim", h.agent, map[string]any{}, map[string]string{"X-Grimoire-Worker-Protocol": "2"})
	if err != nil {
		return agentTask{}, nil, err
	}
	if err = expectStatus(response, 200); err != nil {
		return agentTask{}, nil, err
	}
	task, err := decode[agentTask](response)
	var payload struct {
		Profile json.RawMessage `json:"agent_profile"`
	}
	if err == nil {
		err = json.Unmarshal(response.body, &payload)
	}
	return task, payload.Profile, err
}
func (h *harness) runNativeAgents() error {
	fixture, err := h.newAdaptiveFixture("native-agent")
	if err != nil {
		return err
	}
	skillBody := map[string]any{"name": "Evidence skill " + h.runID, "description": "Synthetic native skill test", "instructions": "NATIVE_SKILL_ONE: keep unknowns explicit."}
	agentBody := map[string]any{"name": "Native planner " + h.runID, "role": "planner", "title": "Scion preparation", "capabilities": "Bounded proposals only", "instructions": "NATIVE_AGENT_ONE: be concise.", "reports_to": nil, "adapter": "codex_cli", "timeout_seconds": 120, "skill_ids": []string{}, "paused": false}
	var agent, skill managedRecord
	if err = h.check("native agents and skills are persisted by Grimoire with idempotent creation", func() error {
		result, err := h.sourceReq("POST", "/api/skills", h.tokenA, skillBody, "native-skill", "", 201)
		if err != nil {
			return err
		}
		skill, err = decode[managedRecord](result)
		if err != nil {
			return err
		}
		agentBody["skill_ids"] = []string{skill.ID}
		result, err = h.sourceReq("POST", "/api/agents", h.tokenA, agentBody, "native-agent", "", 201)
		if err != nil {
			return err
		}
		agent, err = decode[managedRecord](result)
		if err != nil {
			return err
		}
		replay, err := h.sourceReq("POST", "/api/agents", h.tokenA, agentBody, "native-agent", "", 201)
		if err != nil {
			return err
		}
		if !bytes.Equal(result.body, replay.body) {
			return fmt.Errorf("native create retry duplicated or changed record")
		}
		detail, err := h.nativeDetail(agent.ID)
		if err != nil {
			return err
		}
		if detail.Runtime.Backend != "grimoire" || len(detail.Tasks) != 0 || len(detail.Revisions) != 1 {
			return fmt.Errorf("agent invented runs or used another backend")
		}
		return nil
	}); err != nil {
		return err
	}
	if err = h.check("native profiles enforce authentication, Handler writes and foreign organization hiding", func() error {
		for _, path := range []string{"/api/agents", "/api/skills", "/api/agents/" + agent.ID} {
			if _, err := h.sourceReq("GET", path, "", nil, "", "", 401); err != nil {
				return err
			}
		}
		for _, token := range []string{h.agent, h.reviewer} {
			if _, err := h.sourceReq("POST", "/api/agents", token, agentBody, "native-denied", "", 403); err != nil {
				return err
			}
		}
		for _, path := range []string{"/api/agents", "/api/skills", "/api/workspace"} {
			result, err := h.sourceReq("GET", path, h.tokenB, nil, "", "", 200)
			if err != nil {
				return err
			}
			if bytes.Contains(result.body, []byte(agent.ID)) || bytes.Contains(result.body, []byte(skill.ID)) || bytes.Contains(result.body, []byte("NATIVE_AGENT_ONE")) {
				return fmt.Errorf("foreign profile metadata escaped RLS")
			}
		}
		_, err := h.sourceReq("GET", "/api/agents/"+agent.ID, h.tokenB, nil, "", "", 404)
		return err
	}); err != nil {
		return err
	}
	var task agentTask
	var pinned json.RawMessage
	taskBody := map[string]any{"task_kind": "prepare_capability_plan", "candidate_proposal": map[string]any{"synthetic": true}, "timeout_seconds": 120, "agent_id": agent.ID}
	if err = h.check("native task assignment pins configuration and requires a compatible worker", func() error {
		result, err := h.sourceReq("POST", fixture.path+"/agent-tasks", h.tokenA, taskBody, "native-task", `"1"`, 201)
		if err != nil {
			return err
		}
		task, err = decode[agentTask](result)
		if err != nil {
			return err
		}
		if _, err = h.sourceReq("POST", fixture.path+"/agent-tasks/"+task.ID+"/dispatch", h.tokenA, nil, "", `"1"`, 200); err != nil {
			return err
		}
		if _, err = h.sourceReq("POST", "/api/agent/tasks/"+task.ID+"/claim", h.agent, nil, "", "", 409); err != nil {
			return err
		}
		task, pinned, err = h.nativeClaim(task.ID)
		if err != nil {
			return err
		}
		if !bytes.Contains(pinned, []byte("NATIVE_AGENT_ONE")) || !bytes.Contains(pinned, []byte("NATIVE_SKILL_ONE")) {
			return fmt.Errorf("worker did not receive pinned native preparation instructions")
		}
		return nil
	}); err != nil {
		return err
	}
	if err = h.check("agent and skill edits are immutable revisions and cannot alter assigned work", func() error {
		skillBody["instructions"] = "NATIVE_SKILL_TWO: preserve unknowns."
		if _, err := h.sourceReq("PUT", "/api/skills/"+skill.ID, h.tokenA, skillBody, "native-skill-two", `"1"`, 200); err != nil {
			return err
		}
		agentBody["instructions"] = "NATIVE_AGENT_TWO: use headings."
		if _, err := h.sourceReq("PUT", "/api/agents/"+agent.ID, h.tokenA, agentBody, "native-agent-two", `"1"`, 200); err != nil {
			return err
		}
		if _, err := h.sourceReq("PUT", "/api/agents/"+agent.ID, h.tokenA, agentBody, "native-stale", `"1"`, 412); err != nil {
			return err
		}
		detail, err := h.nativeDetail(agent.ID)
		if err != nil {
			return err
		}
		if detail.Agent.Revision != 2 || len(detail.Revisions) != 2 || len(detail.Tasks) != 1 || detail.Tasks[0].AgentRevision != 1 {
			return fmt.Errorf("configuration revision or pinned task history changed")
		}
		return nil
	}); err != nil {
		return err
	}
	if err = h.check("pause cancels active native work and retries create no duplicate audit effects", func() error {
		agentBody["paused"] = true
		if _, err := h.sourceReq("PUT", "/api/agents/"+agent.ID, h.tokenA, agentBody, "native-pause", `"2"`, 200); err != nil {
			return err
		}
		before, err := h.nativeDetail(agent.ID)
		if err != nil {
			return err
		}
		if len(before.Tasks) != 1 || before.Tasks[0].Status != "cancel_requested" {
			return fmt.Errorf("pause did not request worker cancellation")
		}
		result, err := h.client.request("GET", "/api/agent/tasks/"+task.ID+"/control", h.agent, nil, map[string]string{"X-Grimoire-Task-Lease": task.Lease, "X-Grimoire-Worker-Protocol": "2"})
		if err != nil {
			return err
		}
		if err = expectStatus(result, 200); err != nil {
			return err
		}
		var control struct {
			Continue bool `json:"continue"`
		}
		if err = json.Unmarshal(result.body, &control); err != nil {
			return err
		}
		if control.Continue {
			return fmt.Errorf("paused task still permitted execution")
		}
		if _, err = h.sourceReq("PUT", "/api/agents/"+agent.ID, h.tokenA, agentBody, "native-pause", `"2"`, 200); err != nil {
			return err
		}
		after, err := h.nativeDetail(agent.ID)
		if err != nil {
			return err
		}
		if len(before.Events) != len(after.Events) || len(after.Revisions) != 3 {
			return fmt.Errorf("pause retry created duplicate audit")
		}
		result, err = h.client.request("POST", "/api/agent/tasks/"+task.ID+"/cancelled", h.agent, map[string]any{}, map[string]string{"X-Grimoire-Task-Lease": task.Lease})
		if err != nil {
			return err
		}
		return expectStatus(result, 200)
	}); err != nil {
		return err
	}
	if err = h.check("paused agents, cyclic reporting and foreign skills cannot expand execution authority", func() error {
		if _, err := h.sourceReq("POST", fixture.path+"/agent-tasks", h.tokenA, taskBody, "native-paused-task", `"1"`, 409); err != nil {
			return err
		}
		agentBody["reports_to"] = agent.ID
		if _, err := h.sourceReq("PUT", "/api/agents/"+agent.ID, h.tokenA, agentBody, "native-cycle", `"3"`, 422); err != nil {
			return err
		}
		agentBody["reports_to"] = nil
		foreignResult, err := h.sourceReq("POST", "/api/skills", h.tokenB, skillBody, "native-foreign-skill", "", 201)
		if err != nil {
			return err
		}
		foreignSkill, err := decode[managedRecord](foreignResult)
		if err != nil {
			return err
		}
		agentBody["skill_ids"] = []string{foreignSkill.ID}
		if _, err := h.sourceReq("PUT", "/api/agents/"+agent.ID, h.tokenA, agentBody, "native-foreign-assignment", `"3"`, 404); err != nil {
			return err
		}
		agentBody["skill_ids"] = []string{"00000000-0000-4000-8000-000000000000"}
		if _, err := h.sourceReq("PUT", "/api/agents/"+agent.ID, h.tokenA, agentBody, "native-missing-skill", `"3"`, 404); err != nil {
			return err
		}
		agentBody["skill_ids"] = []string{skill.ID}
		agentBody["can_approve"] = true
		if _, err := h.sourceReq("PUT", "/api/agents/"+agent.ID, h.tokenA, agentBody, "native-authority", `"3"`, 422); err != nil {
			return err
		}
		delete(agentBody, "can_approve")
		_, err = h.sourceReq("POST", "/api/agents/"+agent.ID+"/tasks/"+task.ID, h.tokenB, nil, "", "", 404)
		return err
	}); err != nil {
		return err
	}
	if err = h.check("resumed agent consumes new skill revisions and completion remains proposal-only", func() error {
		agentBody["paused"] = false
		if _, err := h.sourceReq("PUT", "/api/agents/"+agent.ID, h.tokenA, agentBody, "native-resume", `"3"`, 200); err != nil {
			return err
		}
		result, err := h.sourceReq("POST", fixture.path+"/agent-tasks", h.tokenA, taskBody, "native-resumed-task", `"1"`, 201)
		if err != nil {
			return err
		}
		task, err = decode[agentTask](result)
		if err != nil {
			return err
		}
		if _, err = h.sourceReq("POST", fixture.path+"/agent-tasks/"+task.ID+"/dispatch", h.tokenA, nil, "", `"1"`, 200); err != nil {
			return err
		}
		task, pinned, err = h.nativeClaim(task.ID)
		if err != nil {
			return err
		}
		if !bytes.Contains(pinned, []byte("NATIVE_AGENT_TWO")) || !bytes.Contains(pinned, []byte("NATIVE_SKILL_TWO")) {
			return fmt.Errorf("new assignment ignored current configuration")
		}
		candidate, err := h.adaptiveRead(fixture.path)
		if err != nil {
			return err
		}
		result, err = h.agentProposal(fixture.path+"/capability-plans", adaptivePlanBody(candidate.UnresolvedGaps), "native-plan", task, 201)
		if err != nil {
			return err
		}
		plan, err := decode[adaptivePlan](result)
		if err != nil {
			return err
		}
		if err = h.adaptiveComplete(task, plan.ID); err != nil {
			return err
		}
		state, _, err := h.controlRead(fixture.path)
		if err != nil {
			return err
		}
		if state.ApprovalAvailable {
			return fmt.Errorf("native completion created approval")
		}
		return nil
	}); err != nil {
		return err
	}
	return h.check("native agents, skill revisions and task assignments survive actual Rust restart", func() error {
		before, err := h.nativeDetail(agent.ID)
		if err != nil {
			return err
		}
		if err = h.restartSources(); err != nil {
			return err
		}
		after, err := h.nativeDetail(agent.ID)
		if err != nil {
			return err
		}
		if before.Agent.ID != after.Agent.ID || after.Agent.Revision != 4 || len(after.Tasks) != 2 || len(after.Events) != len(before.Events) {
			return fmt.Errorf("native state was not restored")
		}
		raw, err := h.sourceReq("GET", "/api/workspace", h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		if !bytes.Contains(raw.body, []byte(agent.ID)) || strings.Contains(string(raw.body), `"paperclip":`) {
			return fmt.Errorf("workspace not native")
		}
		return nil
	})
}
