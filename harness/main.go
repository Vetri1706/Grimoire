// The harness only talks to a real Rust HTTP process. It never implements an API
// server, reads database tables, or substitutes an in-memory persistence layer.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"reflect"
	"strings"
	"time"
)

type intake struct {
	Name               string    `json:"name"`
	ProductDescription *string   `json:"product_description"`
	ProductCategory    string    `json:"product_category"`
	Decision           *string   `json:"decision"`
	Requirements       *[]string `json:"requirements"`
	Questions          *[]string `json:"questions"`
	ChangeSummary      string    `json:"change_summary"`
}

type scion struct {
	ID                 string          `json:"id"`
	CurrentRevision    int             `json:"current_revision"`
	Revision           json.RawMessage `json:"revision"`
	MissingInformation []struct {
		Field      string `json:"field"`
		Message    string `json:"message"`
		NextAction string `json:"next_action"`
	} `json:"missing_information"`
	NextSafeAction string  `json:"next_safe_action"`
	CategoryNotice *string `json:"category_notice"`
}

type principal struct {
	PrincipalID string `json:"principal_id"`
	OrgID       string `json:"org_id"`
	DisplayName string `json:"display_name"`
	CanWrite    bool   `json:"can_write"`
}

type health struct {
	Status   string `json:"status"`
	Database struct {
		Name             string `json:"name"`
		ServerVersion    string `json:"server_version"`
		ServerVersionNum int    `json:"server_version_num"`
		RuntimeRole      string `json:"runtime_role"`
	} `json:"database"`
}

type harness struct {
	client          *apiClient
	process         *apiProcess
	tokenA          string
	tokenB          string
	reviewer        string
	agent           string
	runID           string
	passed          int
	knownRevisions  map[string]map[int]json.RawMessage
	expectedAuthors map[string]string
}

func main() {
	binary := flag.String("api-binary", os.Getenv("GRIMOIRE_API_BINARY"), "path to the compiled Rust grimoire-api binary (required)")
	bind := flag.String("bind", "", "loopback IP:port for the child Rust API; default selects a free port")
	scopeOnly := flag.Bool("scope-only", false, "run Layer 3 and BYOA protocol checks only; full regression remains the default")
	offersOnly := flag.Bool("offers-only", false, "run Layer 4 exact offer checks only; full regression remains the default")
	adaptiveOnly := flag.Bool("adaptive-only", false, "run adaptive Scion and disabled approval HTTP checks only; full regression remains the default")
	controlSurfaceOnly := flag.Bool("control-surface-only", false, "run Grimoire OS graph, Watchtower and operations HTTP checks only; full regression remains the default")
	flag.Parse()
	if err := execute(*binary, *bind, *scopeOnly, *offersOnly, *adaptiveOnly, *controlSurfaceOnly); err != nil {
		fmt.Fprintf(os.Stderr, "\nFAIL: %v\n", err)
		os.Exit(1)
	}
}

func execute(binary, bind string, scopeOnly, offersOnly, adaptiveOnly, controlSurfaceOnly bool) error {
	selected := 0
	for _, enabled := range []bool{scopeOnly, offersOnly, adaptiveOnly, controlSurfaceOnly} {
		if enabled {
			selected++
		}
	}
	if selected > 1 {
		return fmt.Errorf("select at most one focused harness slice")
	}
	if binary == "" {
		return fmt.Errorf("provide -api-binary or GRIMOIRE_API_BINARY; a real process restart is required")
	}
	for _, name := range []string{"DATABASE_URL", "GRIMOIRE_TOKEN_A", "GRIMOIRE_TOKEN_B", "GRIMOIRE_TOKEN_REVIEWER_A", "GRIMOIRE_TOKEN_AGENT_A"} {
		if strings.TrimSpace(os.Getenv(name)) == "" {
			return fmt.Errorf("%s is required; checks were not executed", name)
		}
	}
	if os.Getenv("GRIMOIRE_TOKEN_A") == os.Getenv("GRIMOIRE_TOKEN_B") {
		return fmt.Errorf("GRIMOIRE_TOKEN_A and GRIMOIRE_TOKEN_B must identify different organizations")
	}
	process, err := newProcess(binary, bind)
	if err != nil {
		return err
	}
	id := make([]byte, 8)
	if _, err := rand.Read(id); err != nil {
		return err
	}
	h := &harness{client: newClient("http://" + process.bind), process: process,
		tokenA: os.Getenv("GRIMOIRE_TOKEN_A"), tokenB: os.Getenv("GRIMOIRE_TOKEN_B"), runID: hex.EncodeToString(id),
		reviewer: os.Getenv("GRIMOIRE_TOKEN_REVIEWER_A"), agent: os.Getenv("GRIMOIRE_TOKEN_AGENT_A"),
		knownRevisions: make(map[string]map[int]json.RawMessage)}
	fmt.Printf("Grimoire Layers 1-4, adaptive Scions, OS control surface, BYOA and local MCP acceptance harness\nRust binary: %s\nAPI: %s\n", process.binary, h.client.baseURL)
	if err := process.start(h.client); err != nil {
		_ = process.stop()
		return err
	}
	defer process.stop()
	started := time.Now()
	if controlSurfaceOnly {
		if err := h.verifyDatabase(); err != nil {
			return err
		}
		if err := h.runControlSurface(); err != nil {
			return fmt.Errorf("%d control surface checks passed before failure: %w", h.passed, err)
		}
		fmt.Printf("PASS: %d Grimoire OS checks (control-surface-only; physical workflow regressions not run).\n", h.passed)
		if err := h.runNativeAgents(); err != nil {
			return err
		}
		fmt.Printf("PASS: %d OS and native agent checks.\n", h.passed)
		return nil
	}
	if adaptiveOnly {
		if err := h.verifyDatabase(); err != nil {
			return err
		}
		if err := h.runAdaptive(); err != nil {
			return fmt.Errorf("%d adaptive checks passed before failure: %w", h.passed, err)
		}
		fmt.Printf("PASS: %d adaptive Scion checks (adaptive-only; physical workflow regressions not run).\n", h.passed)
		return nil
	}
	if offersOnly {
		if err := h.verifyDatabase(); err != nil {
			return err
		}
		if err := h.runOffers(); err != nil {
			return fmt.Errorf("%d offer checks passed before failure: %w", h.passed, err)
		}
		fmt.Printf("PASS: %d Layer 4 checks (offers-only; earlier layer regressions not run).\n", h.passed)
		return nil
	}
	if scopeOnly {
		if err := h.verifyDatabase(); err != nil {
			return err
		}
		if err := h.runScope(); err != nil {
			return fmt.Errorf("%d scope checks passed before failure: %w", h.passed, err)
		}
		fmt.Printf("PASS: %d Layer 3/BYOA protocol checks (scope-only; earlier layer regressions not run).\n", h.passed)
		return nil
	}
	if err := h.run(); err != nil {
		return fmt.Errorf("%d checks passed before failure: %w", h.passed, err)
	}
	if err := h.runLayer2(); err != nil {
		return fmt.Errorf("%d checks passed before failure: %w", h.passed, err)
	}
	if err := h.runStorage(); err != nil {
		return fmt.Errorf("%d checks passed before failure: %w", h.passed, err)
	}
	if err := h.runScope(); err != nil {
		return fmt.Errorf("%d checks passed before failure: %w", h.passed, err)
	}
	if err := h.runOffers(); err != nil {
		return fmt.Errorf("%d checks passed before failure: %w", h.passed, err)
	}
	if err := h.runAdaptive(); err != nil {
		return fmt.Errorf("%d checks passed before failure: %w", h.passed, err)
	}
	if err := h.runControlSurface(); err != nil {
		return fmt.Errorf("%d checks passed before failure: %w", h.passed, err)
	}
	if err := h.runNativeAgents(); err != nil {
		return err
	}
	fmt.Printf("\nPASS: %d checks against the running Rust API, PostgreSQL 17, and real versioned object store (%s).\n", h.passed, time.Since(started).Round(time.Millisecond))
	fmt.Println("The child API was terminated and restarted; the database stayed running. Synthetic fixture loading and database reset are external setup steps.")
	return nil
}

func (h *harness) check(label string, fn func() error) error {
	if err := fn(); err != nil {
		return fmt.Errorf("%s: %w", label, err)
	}
	h.passed++
	fmt.Printf("PASS %02d  %s\n", h.passed, label)
	return nil
}

func (h *harness) req(method, path, token string, body any, key, match string, status int) (response, error) {
	headers := map[string]string{}
	if key != "" {
		headers["Idempotency-Key"] = h.runID + "-" + key
	}
	if match != "" {
		headers["If-Match"] = match
	}
	res, err := h.client.request(method, path, token, body, headers)
	if err == nil {
		err = expectStatus(res, status)
	}
	return res, err
}

func (h *harness) verifyDatabase() error {
	res, err := h.req("GET", "/api/health", "", nil, "", "", 200)
	if err != nil {
		return err
	}
	health, err := decode[health](res)
	if err != nil {
		return err
	}
	if health.Status != "ok" || health.Database.ServerVersionNum < 170000 || health.Database.ServerVersionNum >= 180000 {
		return fmt.Errorf("requires healthy PostgreSQL 17, got status=%q server_version=%q version_num=%d", health.Status, health.Database.ServerVersion, health.Database.ServerVersionNum)
	}
	if !strings.HasSuffix(health.Database.Name, "_test") {
		return fmt.Errorf("refusing database %q: harness databases must end in _test; no mutation checks executed", health.Database.Name)
	}
	if health.Database.RuntimeRole != "grimoire_intake_app" {
		return fmt.Errorf("expected least-privilege runtime role grimoire_intake_app, got %q", health.Database.RuntimeRole)
	}
	fmt.Printf("Database: %s; PostgreSQL %s; runtime role: %s\n", health.Database.Name, health.Database.ServerVersion, health.Database.RuntimeRole)
	return nil
}

func (h *harness) run() error {
	if err := h.check("real PostgreSQL 17 health and disposable-database guard", h.verifyDatabase); err != nil {
		return err
	}
	var actorA, actorB principal
	if err := h.check("independent authenticated organizations", func() error {
		for _, entry := range []struct {
			token string
			out   *principal
		}{{h.tokenA, &actorA}, {h.tokenB, &actorB}} {
			res, err := h.req("GET", "/api/me", entry.token, nil, "", "", 200)
			if err != nil {
				return err
			}
			*entry.out, err = decode[principal](res)
			if err != nil {
				return err
			}
			if entry.out.PrincipalID == "" || entry.out.OrgID == "" || strings.TrimSpace(entry.out.DisplayName) == "" || !entry.out.CanWrite {
				return fmt.Errorf("seed each token with a named Handler and writable organization membership")
			}
		}
		if actorA.OrgID == actorB.OrgID {
			return fmt.Errorf("tokens resolved to the same organization")
		}
		return nil
	}); err != nil {
		return err
	}
	h.expectedAuthors = map[string]string{actorA.PrincipalID: actorA.DisplayName, actorB.PrincipalID: actorB.DisplayName}
	initial := intake{Name: "Harness Scion " + h.runID, ProductCategory: "unspecified", ChangeSummary: "Handler saved an incomplete intake draft"}
	if err := h.check("missing and invalid authentication are rejected", func() error {
		for _, token := range []string{"", "invalid-" + h.runID} {
			if _, err := h.req("GET", "/api/scions", token, nil, "", "", 401); err != nil {
				return err
			}
			if _, err := h.req("POST", "/api/scions", token, initial, "unauthorized", "", 401); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}
	var created response
	var current scion
	var revisionOne json.RawMessage
	if err := h.check("create an incomplete Scion; unknown fields remain null", func() error {
		var err error
		created, err = h.req("POST", "/api/scions", h.tokenA, initial, "create", "", 201)
		if err != nil {
			return err
		}
		current, err = decode[scion](created)
		if err != nil {
			return err
		}
		if current.ID == "" || current.CurrentRevision != 1 || created.header.Get("ETag") != `"1"` {
			return fmt.Errorf("create must return an ID, revision 1, and ETag \"1\"")
		}
		revisionOne = append(json.RawMessage(nil), current.Revision...)
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(current.Revision, &fields); err != nil {
			return err
		}
		for _, field := range []string{"product_description", "decision", "requirements", "questions"} {
			if !bytes.Equal(bytes.TrimSpace(fields[field]), []byte("null")) {
				return fmt.Errorf("unknown %s was not retained as explicit null", field)
			}
		}
		if len(current.MissingInformation) == 0 || current.NextSafeAction == "" {
			return fmt.Errorf("an incomplete draft must expose missing information and a next safe action")
		}
		for _, missing := range current.MissingInformation {
			if missing.Field == "" || missing.Message == "" || missing.NextAction == "" {
				return fmt.Errorf("missing-information entries must be actionable: %+v", missing)
			}
		}
		var author string
		if err := json.Unmarshal(fields["created_by"], &author); err != nil || author != actorA.PrincipalID {
			return fmt.Errorf("revision author must be the authenticated Handler")
		}
		return rejectSourcingFields(fields)
	}); err != nil {
		return err
	}
	path := "/api/scions/" + current.ID
	if err := h.check("reopen the saved Scion and history with authenticated Handler names", func() error {
		res, err := h.req("GET", path, h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		if res.header.Get("ETag") != `"1"` || !equalJSON(created.body, res.body) {
			return fmt.Errorf("reopened Scion differs from creation response")
		}
		return h.history(path, 1, revisionOne)
	}); err != nil {
		return err
	}
	if err := h.check("idempotent create retry returns original status, body, and ETag", func() error {
		res, err := h.req("POST", "/api/scions", h.tokenA, initial, "create", "", 201)
		if err != nil {
			return err
		}
		return equalReplay(created, res)
	}); err != nil {
		return err
	}
	if err := h.check("reusing a create idempotency key with changed content returns 409", func() error {
		changed := initial
		changed.Name += " changed"
		_, err := h.req("POST", "/api/scions", h.tokenA, changed, "create", "", 409)
		return err
	}); err != nil {
		return err
	}
	description := "A repairable desk lamp; no bill of materials or vendor has been selected."
	decision := "Clarify the operating environment before evaluating any sourcing path."
	requirements := []string{"Must be repairable by the owner"}
	questions := []string{"Which electrical region and certification requirements apply?"}
	second := intake{Name: initial.Name, ProductDescription: &description, ProductCategory: "physical", Decision: &decision,
		Requirements: &requirements, Questions: &questions, ChangeSummary: "Handler added known facts and an unresolved question"}
	if err := h.check("revision creation without If-Match returns 428", func() error {
		_, err := h.req("POST", path+"/revisions", h.tokenA, second, "missing-match", "", 428)
		return err
	}); err != nil {
		return err
	}
	var revisionTwo response
	if err := h.check("edit creates revision 2 without changing revision 1", func() error {
		var err error
		revisionTwo, err = h.req("POST", path+"/revisions", h.tokenA, second, "revision-two", `"1"`, 201)
		if err != nil {
			return err
		}
		edited, err := decode[scion](revisionTwo)
		if err != nil {
			return err
		}
		if edited.ID != current.ID || edited.CurrentRevision != 2 || revisionTwo.header.Get("ETag") != `"2"` {
			return fmt.Errorf("revision edit must preserve Scion identity and advance to revision 2")
		}
		return h.history(path, 2, revisionOne)
	}); err != nil {
		return err
	}
	if err := h.check("stale If-Match returns 412 and leaves history unchanged", func() error {
		if _, err := h.req("POST", path+"/revisions", h.tokenA, second, "stale-revision", `"1"`, 412); err != nil {
			return err
		}
		return h.history(path, 2, revisionOne)
	}); err != nil {
		return err
	}
	if err := h.check("concurrent edits from revision 2 produce one revision 3 and one 412", func() error {
		type result struct {
			response response
			err      error
		}
		results := make(chan result, 2)
		for i := 0; i < 2; i++ {
			go func(i int) {
				payload := second
				payload.ChangeSummary = fmt.Sprintf("Concurrent Handler edit %d", i+1)
				res, err := h.client.request("POST", path+"/revisions", h.tokenA, payload, map[string]string{
					"Idempotency-Key": fmt.Sprintf("%s-concurrent-%d", h.runID, i), "If-Match": `"2"`,
				})
				results <- result{res, err}
			}(i)
		}
		counts := map[int]int{}
		for i := 0; i < 2; i++ {
			result := <-results
			if result.err != nil {
				return result.err
			}
			counts[result.response.status]++
		}
		if counts[201] != 1 || counts[412] != 1 {
			return fmt.Errorf("expected one 201 and one 412, got %v", counts)
		}
		return h.history(path, 3, revisionOne)
	}); err != nil {
		return err
	}
	if err := h.check("older idempotent writes replay exactly after later revisions", func() error {
		res, err := h.req("POST", path+"/revisions", h.tokenA, second, "revision-two", `"1"`, 201)
		if err != nil {
			return err
		}
		if err := equalReplay(revisionTwo, res); err != nil {
			return err
		}
		res, err = h.req("POST", "/api/scions", h.tokenA, initial, "create", "", 201)
		if err != nil {
			return err
		}
		if err := equalReplay(created, res); err != nil {
			return err
		}
		return h.history(path, 3, revisionOne)
	}); err != nil {
		return err
	}
	if err := h.check("changed revision payload cannot reuse an idempotency key", func() error {
		changed := second
		changed.ChangeSummary = "Conflicting retry content"
		_, err := h.req("POST", path+"/revisions", h.tokenA, changed, "revision-two", `"1"`, 409)
		return err
	}); err != nil {
		return err
	}
	if err := h.check("cross-organization lists do not expose the Scion", func() error {
		for _, entry := range []struct {
			token string
			want  bool
		}{{h.tokenA, true}, {h.tokenB, false}} {
			res, err := h.req("GET", "/api/scions", entry.token, nil, "", "", 200)
			if err != nil {
				return err
			}
			list, err := decode[struct {
				Scions []scion `json:"scions"`
			}](res)
			if err != nil {
				return err
			}
			found := false
			for _, candidate := range list.Scions {
				found = found || candidate.ID == current.ID
			}
			if found != entry.want {
				return fmt.Errorf("Scion presence was %t, want %t for organization", found, entry.want)
			}
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("cross-organization latest, history, revision, and writes conceal existence", func() error {
		unknown := "/api/scions/00000000-0000-4000-8000-000000000000"
		for _, endpoint := range []struct{ method, suffix string }{{"GET", ""}, {"GET", "/revisions"}, {"GET", "/revisions/1"}, {"POST", "/revisions"}} {
			var body any
			match := ""
			if endpoint.method == "POST" {
				body, match = second, `"3"`
			}
			foreign, err := h.req(endpoint.method, path+endpoint.suffix, h.tokenB, body, "foreign-write", match, 404)
			if err != nil {
				return fmt.Errorf("%s %s: %w", endpoint.method, endpoint.suffix, err)
			}
			missing, err := h.req(endpoint.method, unknown+endpoint.suffix, h.tokenB, body, "unknown-write", match, 404)
			if err != nil {
				return err
			}
			if !bytes.Equal(foreign.body, missing.body) || foreign.header.Get("ETag") != "" || foreign.header.Get("Location") != "" {
				return fmt.Errorf("foreign resource leaked existence via body or resource headers at %s %s", endpoint.method, endpoint.suffix)
			}
			if err := h.rejectAuthorMetadata(foreign); err != nil {
				return fmt.Errorf("foreign %s %s: %w", endpoint.method, endpoint.suffix, err)
			}
		}
		return h.history(path, 3, revisionOne)
	}); err != nil {
		return err
	}
	if err := h.check("history and individual revisions require authentication", func() error {
		for _, suffix := range []string{"/revisions", "/revisions/1"} {
			res, err := h.req("GET", path+suffix, "", nil, "", "", 401)
			if err != nil {
				return err
			}
			if err := h.rejectAuthorMetadata(res); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("a forged organization header cannot grant access", func() error {
		res, err := h.client.request("GET", path, h.tokenB, nil, map[string]string{"X-Organization-ID": actorA.OrgID})
		if err != nil {
			return err
		}
		return expectStatus(res, 404)
	}); err != nil {
		return err
	}
	if err := h.check("idempotency keys are isolated between organizations", func() error {
		res, err := h.req("POST", "/api/scions", h.tokenB, initial, "create", "", 201)
		if err != nil {
			return err
		}
		other, err := decode[scion](res)
		if err != nil {
			return err
		}
		if other.ID == "" || other.ID == current.ID || strings.EqualFold(res.header.Get("Idempotency-Replayed"), "true") {
			return fmt.Errorf("organization B received organization A's idempotent response")
		}
		_, err = h.req("GET", "/api/scions/"+other.ID, h.tokenA, nil, "", "", 404)
		return err
	}); err != nil {
		return err
	}
	if err := h.check("reopen after actual Rust process termination and restart", func() error {
		before, err := h.req("GET", path, h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		oldPID := h.process.cmd.Process.Pid
		if err := h.process.stop(); err != nil {
			return err
		}
		if err := h.process.start(h.client); err != nil {
			return err
		}
		newPID := h.process.cmd.Process.Pid
		fmt.Printf("Rust restart: PID %d terminated; PID %d started\n", oldPID, newPID)
		if oldPID == newPID {
			return fmt.Errorf("could not establish a distinct process after restart")
		}
		if err := h.verifyDatabase(); err != nil {
			return err
		}
		after, err := h.req("GET", path, h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		if before.header.Get("ETag") != `"3"` || after.header.Get("ETag") != `"3"` || !equalJSON(before.body, after.body) {
			return fmt.Errorf("Scion contents or current revision changed across restart")
		}
		return h.history(path, 3, revisionOne)
	}); err != nil {
		return err
	}
	if err := h.check("idempotency records survive the Rust process restart", func() error {
		res, err := h.req("POST", path+"/revisions", h.tokenA, second, "revision-two", `"1"`, 201)
		if err != nil {
			return err
		}
		return equalReplay(revisionTwo, res)
	}); err != nil {
		return err
	}
	return h.check("digital drafts explicitly disclose unavailable vendor comparison", func() error {
		digital := intake{Name: "Digital draft " + h.runID, ProductCategory: "digital", ChangeSummary: "Record intake only"}
		res, err := h.req("POST", "/api/scions", h.tokenA, digital, "digital", "", 201)
		if err != nil {
			return err
		}
		draft, err := decode[scion](res)
		if err != nil {
			return err
		}
		if draft.CategoryNotice == nil {
			return fmt.Errorf("digital draft lacks its category notice")
		}
		notice := strings.ToLower(*draft.CategoryNotice)
		explicitlyUnavailable := strings.Contains(notice, "unavailable") || strings.Contains(notice, "not implemented") || strings.Contains(notice, "not supported") || strings.Contains(notice, "intake only")
		if !strings.Contains(notice, "digital") || !strings.Contains(notice, "comparison") || !explicitlyUnavailable {
			return fmt.Errorf("digital notice does not state the comparison limitation: %q", *draft.CategoryNotice)
		}
		return nil
	})
}

func (h *harness) history(path string, count int, revisionOne json.RawMessage) error {
	res, err := h.req("GET", path+"/revisions", h.tokenA, nil, "", "", 200)
	if err != nil {
		return err
	}
	list, err := decode[struct {
		Revisions []json.RawMessage `json:"revisions"`
		Authors   []struct {
			PrincipalID string `json:"principal_id"`
			DisplayName string `json:"display_name"`
		} `json:"authors"`
	}](res)
	if err != nil {
		return err
	}
	if len(list.Revisions) != count {
		return fmt.Errorf("history length=%d, want %d", len(list.Revisions), count)
	}
	seen := map[int]bool{}
	authors := map[string]string{}
	for _, author := range list.Authors {
		if _, duplicate := authors[author.PrincipalID]; duplicate {
			return fmt.Errorf("history contains duplicate author metadata")
		}
		if want, known := h.expectedAuthors[author.PrincipalID]; !known || author.DisplayName != want {
			return fmt.Errorf("history author does not match authenticated /api/me identity")
		}
		authors[author.PrincipalID] = author.DisplayName
	}
	referencedAuthors := map[string]bool{}
	if h.knownRevisions[path] == nil {
		h.knownRevisions[path] = make(map[int]json.RawMessage)
	}
	for _, raw := range list.Revisions {
		var revision struct {
			Number    int    `json:"number"`
			CreatedAt string `json:"created_at"`
			CreatedBy string `json:"created_by"`
		}
		if err := json.Unmarshal(raw, &revision); err != nil {
			return err
		}
		if revision.Number < 1 || revision.Number > count || seen[revision.Number] || revision.CreatedAt == "" || revision.CreatedBy == "" {
			return fmt.Errorf("history has invalid or duplicate revision metadata: %+v", revision)
		}
		if strings.TrimSpace(authors[revision.CreatedBy]) == "" {
			return fmt.Errorf("revision %d lacks a readable Handler name in separate author metadata", revision.Number)
		}
		referencedAuthors[revision.CreatedBy] = true
		var snapshot map[string]json.RawMessage
		if err := json.Unmarshal(raw, &snapshot); err != nil {
			return err
		}
		for _, field := range []string{"display_name", "created_by_name", "authors"} {
			if _, exists := snapshot[field]; exists {
				return fmt.Errorf("current-directory field %q was mixed into immutable revision %d", field, revision.Number)
			}
		}
		seen[revision.Number] = true
		if revision.Number == 1 && !equalJSON(raw, revisionOne) {
			return fmt.Errorf("immutable revision 1 changed in the history endpoint")
		}
		if previous, exists := h.knownRevisions[path][revision.Number]; exists && !equalJSON(previous, raw) {
			return fmt.Errorf("immutable revision %d changed after a later write or restart", revision.Number)
		}
		h.knownRevisions[path][revision.Number] = append(json.RawMessage(nil), raw...)
		single, err := h.req("GET", fmt.Sprintf("%s/revisions/%d", path, revision.Number), h.tokenA, nil, "", "", 200)
		if err != nil {
			return err
		}
		if !equalJSON(raw, single.body) || single.header.Get("ETag") != fmt.Sprintf(`"%d"`, revision.Number) {
			return fmt.Errorf("individual revision %d does not match history or ETag", revision.Number)
		}
	}
	if len(authors) != len(referencedAuthors) {
		return fmt.Errorf("history exposed author metadata unrelated to this Scion's revisions")
	}
	return nil
}

func (h *harness) rejectAuthorMetadata(res response) error {
	var payload any
	if err := json.Unmarshal(res.body, &payload); err != nil {
		return err
	}
	var inspect func(any) error
	inspect = func(value any) error {
		switch value := value.(type) {
		case map[string]any:
			for key, nested := range value {
				switch key {
				case "authors", "principal_id", "display_name", "created_by":
					return fmt.Errorf("denial response exposed author metadata %q", key)
				}
				if err := inspect(nested); err != nil {
					return err
				}
			}
		case []any:
			for _, nested := range value {
				if err := inspect(nested); err != nil {
					return err
				}
			}
		case string:
			for id, name := range h.expectedAuthors {
				if strings.Contains(value, id) || strings.Contains(value, name) {
					return fmt.Errorf("denial response exposed a Handler identity")
				}
			}
		}
		return nil
	}
	return inspect(payload)
}

func equalReplay(original, replay response) error {
	if original.status != replay.status || !bytes.Equal(original.body, replay.body) || original.header.Get("ETag") != replay.header.Get("ETag") {
		return fmt.Errorf("idempotent retry did not preserve exact status, body bytes, and ETag")
	}
	if !strings.EqualFold(replay.header.Get("Idempotency-Replayed"), "true") {
		return fmt.Errorf("retry lacks Idempotency-Replayed: true")
	}
	return nil
}

func equalJSON(a, b []byte) bool {
	var left, right any
	return json.Unmarshal(a, &left) == nil && json.Unmarshal(b, &right) == nil && reflect.DeepEqual(left, right)
}

func rejectSourcingFields(fields map[string]json.RawMessage) error {
	for _, forbidden := range []string{"bom", "bill_of_materials", "supplier", "suppliers", "price", "prices", "approval", "approved"} {
		if _, exists := fields[forbidden]; exists {
			return fmt.Errorf("draft revision unexpectedly contains sourcing field %q", forbidden)
		}
	}
	return nil
}
