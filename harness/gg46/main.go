package main

// GG-46 is a focused PostgreSQL guard harness. It uses only synthetic fixture
// identifiers and invokes the real migration functions/triggers through psql.
// It does not contact suppliers, dispatch RFQs, or exercise production data.
import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type fixture struct {
	FixtureKind  string `json:"fixture_kind"`
	Organization string `json:"organization_id"`
	Scion        struct {
		ID                    string `json:"id"`
		Revision              int    `json:"revision"`
		CaseRevision          string `json:"sourcing_case_revision_id"`
		ConfigurationRevision string `json:"product_configuration_revision_id"`
		OccurrenceRevision    string `json:"bom_occurrence_revision_id"`
		ComponentRevision     string `json:"component_revision_id"`
		RequirementRevision   string `json:"requirement_revision_id"`
	} `json:"scion"`
	Proposal struct {
		ID                  string  `json:"id"`
		Comparison          string  `json:"canonical_comparison_revision_id"`
		Packet              string  `json:"decision_packet_revision_id"`
		Authority           string  `json:"authority"`
		Provider            string  `json:"provider"`
		Agent               string  `json:"agent_principal_id"`
		SelectedOffer       *string `json:"selected_offer_revision_id"`
		RecommendedSupplier *string `json:"recommended_supplier"`
	} `json:"normalization_proposal"`
	Offers []struct {
		OfferRevision  string `json:"offer_revision_id"`
		OfferLine      string `json:"offer_line_id"`
		SourceDocument string `json:"source_document_id"`
		SourceRevision string `json:"source_revision_id"`
		Currentness    string `json:"currentness"`
	} `json:"offers"`
	Matrix []struct {
		Term            string  `json:"term"`
		Result          string  `json:"result"`
		ExclusionReason *string `json:"exclusion_reason"`
	} `json:"comparability_matrix"`
	Authority struct {
		ReviewID      string `json:"review_id"`
		Reviewer      string `json:"reviewer_principal_id"`
		OfferRevision string `json:"selected_offer_revision_id"`
		OfferLine     string `json:"selected_offer_line_id"`
		Label         string `json:"label"`
	} `json:"synthetic_positive_authority"`
	Decision struct {
		Receipt          string `json:"receipt_id"`
		Decision         string `json:"decision_id"`
		DecisionRevision string `json:"decision_revision_id"`
		StateEvent       string `json:"state_event_id"`
		State            string `json:"state"`
		Submitted        bool   `json:"submitted"`
		Approved         bool   `json:"approved"`
	} `json:"synthetic_draft_decision"`
}

type result struct {
	Name     string `json:"name"`
	Expected string `json:"expected"`
	Actual   string `json:"actual"`
	Passed   bool   `json:"passed"`
}

type report struct {
	Schema           string   `json:"schema"`
	GeneratedAt      string   `json:"generated_at"`
	Command          string   `json:"command"`
	CodeRevision     string   `json:"code_revision"`
	FixturePath      string   `json:"fixture_path"`
	FixtureSHA256    string   `json:"fixture_sha256"`
	DatabaseVersion  string   `json:"database_version"`
	SyntheticOnly    bool     `json:"synthetic_only"`
	SourcingApproval bool     `json:"sourcing_approval"`
	Results          []result `json:"results"`
	Passed           int      `json:"passed"`
	Failed           int      `json:"failed"`
	ResidualGaps     []string `json:"residual_gaps"`
}

type harness struct {
	psql    string
	dsn     string
	fixture fixture
	results []result
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func (h *harness) sql(statement string) (string, error) {
	cmd := exec.Command(h.psql, h.dsn, "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", statement)
	cmd.Env = append(os.Environ(), "PGCLIENTENCODING=UTF8")
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	err := cmd.Run()
	return strings.TrimSpace(output.String()), err
}

func sqlLiteral(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }

func context(org, actor, role, endpoint string) string {
	return fmt.Sprintf(`DO $context$ BEGIN
  PERFORM set_config('app.current_org_id', %s, false);
  PERFORM set_config('app.current_principal_id', %s, false);
  PERFORM set_config('app.request_id', gen_random_uuid()::text, false);
  PERFORM set_config('app.effective_role', %s, false);
  PERFORM set_config('app.endpoint_scope', %s, false);
  PERFORM set_config('app.input_hash', repeat('4',64), false);
  PERFORM set_config('app.action_reason', 'GG-46 synthetic software behavior check', false);
  PERFORM set_config('app.action_outcome', 'committed', false);
END $context$;`, sqlLiteral(org), sqlLiteral(actor), sqlLiteral(role), sqlLiteral(endpoint))
}

func caught(statement string) string {
	return fmt.Sprintf(`DO $test$ BEGIN
  BEGIN
    %s;
    RAISE NOTICE 'GG46_RESULT|00000|unexpected success';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'GG46_RESULT|%%|%%', SQLSTATE, SQLERRM;
  END;
END $test$;`, statement)
}

func marker(output string) string {
	index := strings.LastIndex(output, "GG46_RESULT|")
	if index < 0 {
		return strings.TrimSpace(output)
	}
	line := output[index:]
	if end := strings.IndexByte(line, '\n'); end >= 0 {
		line = line[:end]
	}
	return strings.TrimSpace(line)
}

func (h *harness) check(name, expected string, fn func() (string, error)) {
	actual, err := fn()
	if err != nil {
		actual = "command_error: " + actual
	}
	actual = marker(actual)
	h.results = append(h.results, result{Name: name, Expected: expected, Actual: actual, Passed: err == nil && actual == expected})
}

func (h *harness) reviewCall(review, offerRevision, offerLine, rationale, key string) string {
	f := h.fixture
	return fmt.Sprintf(`PERFORM app.record_synthetic_sourcing_authority_review(%s,%s,%s,%s,%s,%s,%s,%s,true)`,
		sqlLiteral(review), sqlLiteral(f.Proposal.Comparison), sqlLiteral(f.Scion.CaseRevision),
		sqlLiteral(f.Scion.RequirementRevision), sqlLiteral(offerRevision), sqlLiteral(offerLine),
		sqlLiteral(rationale), sqlLiteral(key))
}

func (h *harness) decisionCall(review, rationale, key string) string {
	f := h.fixture
	return fmt.Sprintf(`app.create_synthetic_draft_decision(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,true)`,
		sqlLiteral(f.Decision.Receipt), sqlLiteral(f.Decision.Decision), sqlLiteral(f.Decision.DecisionRevision),
		sqlLiteral(f.Decision.StateEvent), sqlLiteral("GG46-SYNTHETIC-DRAFT"), sqlLiteral(f.Proposal.Packet),
		sqlLiteral(f.Proposal.Comparison), sqlLiteral(f.Scion.CaseRevision), sqlLiteral(f.Scion.RequirementRevision),
		sqlLiteral(f.Authority.OfferRevision), sqlLiteral(f.Authority.OfferLine), sqlLiteral(review),
		sqlLiteral(rationale), sqlLiteral(key))
}

func loadFixture(path string) (fixture, string, error) {
	var value fixture
	data, err := os.ReadFile(path)
	if err != nil {
		return value, "", err
	}
	if err = json.Unmarshal(data, &value); err != nil {
		return value, "", err
	}
	hash := sha256.Sum256(data)
	return value, hex.EncodeToString(hash[:]), nil
}

func (h *harness) run() {
	f := h.fixture
	h.check("fixture exposes stable exact identifiers and proposal-only authority", "valid synthetic fixture", func() (string, error) {
		ids := []string{f.Organization, f.Scion.ID, f.Scion.CaseRevision, f.Scion.ConfigurationRevision,
			f.Scion.OccurrenceRevision, f.Scion.ComponentRevision, f.Scion.RequirementRevision,
			f.Proposal.ID, f.Proposal.Comparison, f.Proposal.Packet, f.Proposal.Agent,
			f.Authority.ReviewID, f.Authority.Reviewer, f.Authority.OfferRevision, f.Authority.OfferLine}
		for _, offer := range f.Offers {
			ids = append(ids, offer.OfferRevision, offer.OfferLine, offer.SourceDocument, offer.SourceRevision)
		}
		for _, id := range ids {
			if !uuidPattern.MatchString(id) {
				return "invalid identifier " + id, nil
			}
		}
		if f.FixtureKind != "synthetic_software_behavior_only" || f.Scion.Revision != 1 ||
			f.Proposal.Authority != "proposal_only" || f.Proposal.Provider != "codex_cli" ||
			f.Proposal.SelectedOffer != nil || f.Proposal.RecommendedSupplier != nil ||
			f.Decision.State != "draft" || f.Decision.Submitted || f.Decision.Approved || len(f.Offers) != 2 {
			return "fixture authority or state is not bounded", nil
		}
		return "valid synthetic fixture", nil
	})

	h.check("comparability matrix explains comparable, excluded, and unknown terms", "explicit matrix with unknowns preserved", func() (string, error) {
		if len(f.Matrix) < 7 {
			return fmt.Sprintf("only %d matrix rows", len(f.Matrix)), nil
		}
		hasComparable, hasExcluded, hasUnknown := false, false, false
		for _, row := range f.Matrix {
			switch row.Result {
			case "comparable", "comparable_at_recorded_revision":
				hasComparable = true
			case "excluded_from_normalized_price_and_selection":
				hasExcluded = row.ExclusionReason != nil && *row.ExclusionReason != ""
			case "unknown_and_excluded":
				hasUnknown = row.ExclusionReason != nil && strings.Contains(*row.ExclusionReason, "unknown")
			}
		}
		if !hasComparable || !hasExcluded || !hasUnknown {
			return "matrix omits a required state", nil
		}
		return "explicit matrix with unknowns preserved", nil
	})

	h.check("database contains the exact configuration, occurrence, component, sources, offers, and comparison", "GG46_RESULT|OK|exact revision chain present", func() (string, error) {
		query := fmt.Sprintf(`SELECT 'GG46_RESULT|OK|exact revision chain present'
WHERE EXISTS (SELECT 1 FROM grimoire.product_configuration_revisions WHERE id=%s)
  AND EXISTS (SELECT 1 FROM grimoire.bom_occurrence_revisions WHERE id=%s AND configuration_revision_id=%s AND component_revision_id=%s)
  AND EXISTS (SELECT 1 FROM grimoire.requirement_revisions WHERE id=%s AND occurrence_revision_id=%s AND component_revision_id=%s)
  AND 2=(SELECT count(*) FROM grimoire.offer_revisions WHERE id IN (%s,%s))
  AND 2=(SELECT count(*) FROM grimoire.source_document_revisions WHERE id IN (%s,%s))
  AND EXISTS (SELECT 1 FROM grimoire.comparison_revisions WHERE id=%s AND sourcing_case_revision_id=%s AND requirement_revision_id=%s);`,
			sqlLiteral(f.Scion.ConfigurationRevision), sqlLiteral(f.Scion.OccurrenceRevision),
			sqlLiteral(f.Scion.ConfigurationRevision), sqlLiteral(f.Scion.ComponentRevision),
			sqlLiteral(f.Scion.RequirementRevision), sqlLiteral(f.Scion.OccurrenceRevision),
			sqlLiteral(f.Scion.ComponentRevision), sqlLiteral(f.Offers[0].OfferRevision),
			sqlLiteral(f.Offers[1].OfferRevision), sqlLiteral(f.Offers[0].SourceRevision),
			sqlLiteral(f.Offers[1].SourceRevision), sqlLiteral(f.Proposal.Comparison),
			sqlLiteral(f.Scion.CaseRevision), sqlLiteral(f.Scion.RequirementRevision))
		return h.sql(query)
	})

	preparer := "00000000-0000-4000-8000-000000000011"
	quality := "00000000-0000-4000-8000-000000000013"
	agent := "00000000-0000-4000-8000-000000000016"
	authority := f.Authority.Reviewer

	h.check("decision write without an authority review is rejected", "GG46_RESULT|G3301|matching independent human-authority review required before decision write", func() (string, error) {
		sql := context(f.Organization, preparer, "procurement_preparer", "gg46:decision-negative") + caught("PERFORM "+h.decisionCall("46000000-0000-4000-8000-000000000799", "Synthetic draft with no authority review", "gg46-decision"))
		return h.sql(sql)
	})

	h.check("quality review cannot masquerade as sourcing authority", "GG46_RESULT|G3302|distinct enabled human sourcing authority required", func() (string, error) {
		sql := context(f.Organization, quality, "quality_reviewer", "gg46:authority-negative") + caught(h.reviewCall("46000000-0000-4000-8000-000000000715", f.Authority.OfferRevision, f.Authority.OfferLine, "Synthetic QA fixture", "gg46-review-qa"))
		return h.sql(sql)
	})

	h.check("agent review cannot masquerade as sourcing authority", "GG46_RESULT|G3302|distinct enabled human sourcing authority required", func() (string, error) {
		sql := context(f.Organization, agent, "read_only_agent", "gg46:authority-negative") + caught(h.reviewCall("46000000-0000-4000-8000-000000000716", f.Authority.OfferRevision, f.Authority.OfferLine, "Synthetic agent fixture", "gg46-review-agent"))
		return h.sql(sql)
	})

	h.check("stale scope revision is rejected", "GG46_RESULT|G3305|scope revision stale", func() (string, error) {
		wrongCase := "46000000-0000-4000-8000-000000000199"
		statement := fmt.Sprintf(`PERFORM app.record_synthetic_sourcing_authority_review(%s,%s,%s,%s,%s,%s,%s,%s,true)`,
			sqlLiteral("46000000-0000-4000-8000-000000000717"), sqlLiteral(f.Proposal.Comparison),
			sqlLiteral(wrongCase), sqlLiteral(f.Scion.RequirementRevision), sqlLiteral(f.Authority.OfferRevision),
			sqlLiteral(f.Authority.OfferLine), sqlLiteral("Synthetic stale-scope fixture"), sqlLiteral("gg46-review-stale-scope"))
		return h.sql(context(f.Organization, authority, "commercial_approver", "gg46:stale-scope") + caught(statement))
	})

	h.check("stale offer/source revision is rejected", "GG46_RESULT|G3305|offer or source revision stale", func() (string, error) {
		return h.sql(context(f.Organization, authority, "commercial_approver", "gg46:stale-source") + caught(h.reviewCall("46000000-0000-4000-8000-000000000718", f.Offers[0].OfferRevision, f.Offers[0].OfferLine, "Synthetic stale-source fixture", "gg46-review-stale-source")))
	})

	h.check("revoked source is rejected", "GG46_RESULT|G3305|scope revision stale", func() (string, error) {
		sql := context(f.Organization, authority, "commercial_approver", "gg46:revoked-source") + `BEGIN;
INSERT INTO grimoire.source_access_events(org_id,source_document_id,state,reason,effective_at,actor_id)
VALUES (` + sqlLiteral(f.Organization) + `,` + sqlLiteral(f.Offers[1].SourceDocument) + `,'revoked','GG-46 synthetic rollback-only revocation',clock_timestamp(),` + sqlLiteral(authority) + `);
` + caught(h.reviewCall("46000000-0000-4000-8000-000000000719", f.Authority.OfferRevision, f.Authority.OfferLine, "Synthetic revoked-source fixture", "gg46-review-revoked")) + `
ROLLBACK;`
		return h.sql(sql)
	})

	h.check("commercial authority review succeeds and retry returns the same immutable review", "GG46_RESULT|OK|one review 46000000-0000-4000-8000-000000000714", func() (string, error) {
		call := strings.TrimPrefix(h.reviewCall(f.Authority.ReviewID, f.Authority.OfferRevision, f.Authority.OfferLine, f.Authority.Label, "gg46-review-positive"), "PERFORM ")
		sql := context(f.Organization, authority, "commercial_approver", "gg46:authority-positive") + fmt.Sprintf(`SELECT %s; SELECT %s;
SELECT 'GG46_RESULT|OK|one review '||min(id::text) FROM grimoire.sourcing_authority_reviews
WHERE org_id=%s AND idempotency_key='gg46-review-positive' HAVING count(*)=1;`, call, call, sqlLiteral(f.Organization))
		return h.sql(sql)
	})

	h.check("review idempotency key rejects contradictory retry", "GG46_RESULT|G3303|idempotency key reused with different authority review", func() (string, error) {
		return h.sql(context(f.Organization, authority, "commercial_approver", "gg46:authority-replay") + caught(h.reviewCall(f.Authority.ReviewID, f.Authority.OfferRevision, f.Authority.OfferLine, "Changed rationale must not overwrite review", "gg46-review-positive")))
	})

	h.check("cross-organization attempts return the same non-leaking error as absent inputs", "GG46_RESULT|OK|G3304|decision inputs unavailable=G3304|decision inputs unavailable", func() (string, error) {
		orgB := "46000000-0000-4000-8000-000000000901"
		actorB := "46000000-0000-4000-8000-000000000914"
		setup := context(f.Organization, preparer, "migration_fixture", "gg46:cross-org-setup") + fmt.Sprintf(`
INSERT INTO grimoire.organizations(id,name) VALUES (%s,'Synthetic GG-46 isolation org') ON CONFLICT DO NOTHING;
INSERT INTO grimoire.org_security_epochs(org_id) VALUES (%s) ON CONFLICT DO NOTHING;
INSERT INTO grimoire.principals(id,org_id,external_subject,display_name) VALUES (%s,%s,'synthetic:gg46:commercial','Synthetic GG-46 Commercial Authority') ON CONFLICT DO NOTHING;
INSERT INTO grimoire.principal_roles(org_id,principal_id,role) VALUES (%s,%s,'commercial_approver') ON CONFLICT DO NOTHING;`,
			sqlLiteral(orgB), sqlLiteral(orgB), sqlLiteral(actorB), sqlLiteral(orgB), sqlLiteral(orgB), sqlLiteral(actorB))
		if output, err := h.sql(setup); err != nil {
			return output, err
		}
		foreign := context(orgB, actorB, "commercial_approver", "gg46:cross-org") + caught(h.reviewCall("46000000-0000-4000-8000-000000000915", f.Authority.OfferRevision, f.Authority.OfferLine, "Foreign synthetic review", "gg46-review-foreign"))
		absent := context(orgB, actorB, "commercial_approver", "gg46:cross-org") + caught(`PERFORM app.record_synthetic_sourcing_authority_review('46000000-0000-4000-8000-000000000916','46000000-0000-4000-8000-000000000999','46000000-0000-4000-8000-000000000998','46000000-0000-4000-8000-000000000997','46000000-0000-4000-8000-000000000996','46000000-0000-4000-8000-000000000995','Absent synthetic review','gg46-review-absent',true)`)
		one, err := h.sql(foreign)
		if err != nil {
			return one, err
		}
		two, err := h.sql(absent)
		if err != nil {
			return two, err
		}
		one, two = strings.TrimPrefix(marker(one), "GG46_RESULT|"), strings.TrimPrefix(marker(two), "GG46_RESULT|")
		return "GG46_RESULT|OK|" + one + "=" + two, nil
	})

	h.check("authorized review permits one draft decision and retries create no duplicate facts or audit transitions", "GG46_RESULT|OK|1 decision;1 revision;2 inputs;1 receipt;1 state;audits stable 6=6", func() (string, error) {
		call := h.decisionCall(f.Authority.ReviewID, "Synthetic draft selected only to prove the authority gate; not submitted or approved", "gg46-decision")
		sql := context(f.Organization, preparer, "procurement_preparer", "gg46:decision-positive") + fmt.Sprintf(`SELECT %s;
SELECT set_config('gg46.audit_count',(SELECT count(*)::text FROM grimoire.audit_events WHERE object_id IN (%s,%s,%s)),false);
SELECT %s;
SELECT 'GG46_RESULT|OK|'||
 (SELECT count(*) FROM grimoire.decisions WHERE id=%s)||' decision;'||
 (SELECT count(*) FROM grimoire.decision_revisions WHERE id=%s)||' revision;'||
 (SELECT count(*) FROM grimoire.decision_offer_inputs WHERE decision_revision_id=%s)||' inputs;'||
 (SELECT count(*) FROM grimoire.synthetic_decision_receipts WHERE decision_revision_id=%s)||' receipt;'||
 (SELECT count(*) FROM grimoire.decision_state_events WHERE decision_revision_id=%s)||' state;'||
 'audits stable '||current_setting('gg46.audit_count')||'='||
 (SELECT count(*) FROM grimoire.audit_events WHERE object_id IN (%s,%s,%s))
WHERE (SELECT state FROM grimoire.current_decision_state WHERE decision_revision_id=%s)='draft'
	  AND NOT EXISTS (SELECT 1 FROM grimoire.decision_approvals WHERE decision_revision_id=%s);`, call,
			sqlLiteral(f.Decision.Decision), sqlLiteral(f.Decision.DecisionRevision), sqlLiteral(f.Decision.StateEvent), call,
			sqlLiteral(f.Decision.Decision), sqlLiteral(f.Decision.DecisionRevision),
			sqlLiteral(f.Decision.DecisionRevision), sqlLiteral(f.Decision.DecisionRevision),
			sqlLiteral(f.Decision.DecisionRevision), sqlLiteral(f.Decision.Decision),
			sqlLiteral(f.Decision.DecisionRevision), sqlLiteral(f.Decision.StateEvent),
			sqlLiteral(f.Decision.DecisionRevision),
			sqlLiteral(f.Decision.DecisionRevision))
		return h.sql(sql)
	})

	h.check("decision idempotency key rejects contradictory retry", "GG46_RESULT|G3303|idempotency key reused with different decision input", func() (string, error) {
		return h.sql(context(f.Organization, preparer, "procurement_preparer", "gg46:decision-replay") + caught("PERFORM "+h.decisionCall(f.Authority.ReviewID, "Changed selection rationale must not overwrite decision", "gg46-decision")))
	})
}

func main() {
	fixturePath := flag.String("fixture", "fixtures/gg46-two-offer.json", "synthetic fixture path")
	psql := flag.String("psql", "psql", "psql executable")
	dsn := flag.String("dsn", os.Getenv("GG46_DSN"), "PostgreSQL DSN")
	revision := flag.String("code-revision", "working-tree", "code revision under test")
	reportedCommand := flag.String("reported-command", "", "human-readable invocation recorded in evidence")
	flag.Parse()
	if *dsn == "" {
		fmt.Fprintln(os.Stderr, "-dsn or GG46_DSN is required")
		os.Exit(2)
	}
	f, fixtureHash, err := loadFixture(*fixturePath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	h := harness{psql: *psql, dsn: *dsn, fixture: f}
	h.run()
	version, versionErr := h.sql("SHOW server_version;")
	if versionErr != nil {
		version = "unavailable: " + version
	}
	passed, failed := 0, 0
	for _, item := range h.results {
		if item.Passed {
			passed++
		} else {
			failed++
		}
	}
	absFixture, _ := filepath.Abs(*fixturePath)
	command := *reportedCommand
	if command == "" {
		command = strings.Join(os.Args, " ")
	}
	r := report{
		Schema: "grimoire.gg46.harness-evidence.v1", GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Command: command, CodeRevision: *revision,
		FixturePath: absFixture, FixtureSHA256: fixtureHash, DatabaseVersion: version,
		SyntheticOnly: true, SourcingApproval: false, Results: h.results, Passed: passed, Failed: failed,
		ResidualGaps: []string{
			"Focused execution validates PostgreSQL behavior only; the existing full HTTP harness was not rerun on this macOS worker.",
			"Synthetic authority identities establish software separation, not a real person's qualification or sourcing approval.",
			"No customer value, production readiness, security certification, supplier contact, RFQ, deployment, or external write is established.",
		},
	}
	encoded, _ := json.MarshalIndent(r, "", "  ")
	fmt.Println(string(encoded))
	if failed != 0 {
		os.Exit(1)
	}
}
