package main

// S3 administrative access is confined to a disposable bucket for fault injection.
// All application behavior is asserted through the real Rust HTTP API. No mock
// API, mock object store, database edits, or forged application responses are used.
import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type storedRevision struct {
	sourceInput
	SourceID            string `json:"source_id"`
	Number              int    `json:"number"`
	ContentSHA256       string `json:"content_sha256"`
	ByteLength          int    `json:"byte_length"`
	StorageBackend      string `json:"storage_backend"`
	ObjectKey           string `json:"object_key"`
	ObjectVersionID     string `json:"object_version_id"`
	ContentHashVerified bool   `json:"content_hash_verified"`
}

type storageFixture struct {
	admin    *minio.Client
	runtime  *minio.Client
	bucket   string
	endpoint string
	script   string
}

func newStorageFixture() (*storageFixture, error) {
	for _, key := range []string{"GRIMOIRE_S3_ENDPOINT", "GRIMOIRE_S3_BUCKET", "GRIMOIRE_S3_ACCESS_KEY", "GRIMOIRE_S3_SECRET_KEY", "GRIMOIRE_S3_TEST_ADMIN_ACCESS_KEY", "GRIMOIRE_S3_TEST_ADMIN_SECRET_KEY", "GRIMOIRE_STORAGE_SCRIPT"} {
		if os.Getenv(key) == "" {
			return nil, fmt.Errorf("%s required: storage checks unexecuted", key)
		}
	}
	endpoint, err := url.Parse(os.Getenv("GRIMOIRE_S3_ENDPOINT"))
	if err != nil || endpoint.Scheme != "http" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Path != "" {
		return nil, fmt.Errorf("storage fault tests require an explicit local HTTP endpoint")
	}
	ip := net.ParseIP(endpoint.Hostname())
	if ip == nil || !ip.IsLoopback() {
		return nil, fmt.Errorf("storage fault tests require loopback")
	}
	if endpoint.String() != "http://127.0.0.1:19000" {
		return nil, fmt.Errorf("fault lifecycle helper is scoped to http://127.0.0.1:19000; refusing a different instance")
	}
	bucket := os.Getenv("GRIMOIRE_S3_BUCKET")
	if bucket != "grimoire-sources-test" {
		return nil, fmt.Errorf("storage fault tests refuse bucket %q; only grimoire-sources-test is disposable", bucket)
	}
	makeClient := func(access, secret string) (*minio.Client, error) {
		return minio.New(endpoint.Host, &minio.Options{Creds: credentials.NewStaticV4(access, secret, ""), Secure: false, Region: os.Getenv("GRIMOIRE_S3_REGION")})
	}
	admin, err := makeClient(os.Getenv("GRIMOIRE_S3_TEST_ADMIN_ACCESS_KEY"), os.Getenv("GRIMOIRE_S3_TEST_ADMIN_SECRET_KEY"))
	if err != nil {
		return nil, err
	}
	runtime, err := makeClient(os.Getenv("GRIMOIRE_S3_ACCESS_KEY"), os.Getenv("GRIMOIRE_S3_SECRET_KEY"))
	if err != nil {
		return nil, err
	}
	script, err := filepath.Abs(os.Getenv("GRIMOIRE_STORAGE_SCRIPT"))
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(script); err != nil {
		return nil, err
	}
	return &storageFixture{admin: admin, runtime: runtime, bucket: bucket, endpoint: endpoint.String(), script: script}, nil
}

func (s *storageFixture) bytes(client *minio.Client, revision storedRevision) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	obj, err := client.GetObject(ctx, s.bucket, revision.ObjectKey, minio.GetObjectOptions{VersionID: revision.ObjectVersionID})
	if err != nil {
		return nil, err
	}
	defer obj.Close()
	return io.ReadAll(io.LimitReader(obj, 32001))
}

func (s *storageFixture) versions(prefix string) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var versions []string
	for obj := range s.admin.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true, WithVersions: true}) {
		if obj.Err != nil {
			return nil, obj.Err
		}
		versions = append(versions, obj.Key+"@"+obj.VersionID)
	}
	sort.Strings(versions)
	return versions, nil
}

func (s *storageFixture) task(task string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
	defer cancel()
	all := append([]string{"-NoProfile", "-File", s.script, "-Task", task}, args...)
	cmd := exec.CommandContext(ctx, "pwsh", all...)
	// Windows background services can inherit pipe handles even when the helper
	// has exited. File-backed capture avoids waiting for the persistent service
	// to close the Go runner's output pipes.
	log, err := os.CreateTemp("", "grimoire-storage-task-*.log")
	if err != nil {
		return err
	}
	defer os.Remove(log.Name())
	cmd.Stdout, cmd.Stderr = log, log
	err = cmd.Run()
	_ = log.Close()
	output, readErr := os.ReadFile(log.Name())
	if readErr != nil {
		return readErr
	}
	if err != nil {
		return fmt.Errorf("local object-store task %s failed: %w; %s", task, err, output)
	}
	fmt.Printf("Object-store task %s: completed\n", task)
	return nil
}

func (h *harness) stored(path string) (storedRevision, response, error) {
	res, err := h.sourceReq("GET", path, h.tokenA, nil, "", "", 200)
	if err != nil {
		return storedRevision{}, res, err
	}
	rev, err := decode[storedRevision](res)
	if err != nil {
		return rev, res, err
	}
	if rev.StorageBackend != "s3" || rev.ObjectKey == "" || rev.ObjectVersionID == "" || rev.ObjectVersionID == "null" || !rev.ContentHashVerified {
		return rev, res, fmt.Errorf("revision missing private versioned storage identity or verified read")
	}
	if rev.ContentSHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte(rev.SourceText))) || rev.ByteLength != len([]byte(rev.SourceText)) {
		return rev, res, fmt.Errorf("retrieved text does not match recorded SHA-256/length")
	}
	var fields map[string]any
	_ = json.Unmarshal(res.body, &fields)
	for key := range fields {
		if strings.Contains(strings.ToLower(key), "url") {
			return rev, res, fmt.Errorf("source response unexpectedly issued a URL field %q", key)
		}
	}
	return rev, res, nil
}

func (h *harness) runStorage() error {
	s, err := newStorageFixture()
	if err != nil {
		return err
	}
	fmt.Printf("Layer 2B object store: %s; disposable bucket: %s\n", s.endpoint, s.bucket)
	if err := h.check("real object-store test bucket has versioning enabled", func() error {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		versioning, err := s.admin.GetBucketVersioning(ctx, s.bucket)
		if err != nil {
			return err
		}
		if !versioning.Enabled() {
			return fmt.Errorf("test bucket is not versioned")
		}
		return nil
	}); err != nil {
		return err
	}
	draftRes, err := h.req("POST", "/api/scions", h.tokenA, intake{Name: "Synthetic storage checks " + h.runID, ProductCategory: "physical", ChangeSummary: "Disposable storage checks"}, "storage-scion", "", 201)
	if err != nil {
		return err
	}
	draft, err := decode[scion](draftRes)
	if err != nil {
		return err
	}
	listPath := "/api/scions/" + draft.ID + "/sources"
	input := sourceInput{Title: "Synthetic versioned note", Origin: "synthetic://storage/" + h.runID, Owner: "Synthetic Handler", Synthetic: true, SourceText: "SYNTHETIC storage fixture — café.\nTarget width: 120 mm.\n", RightsStatus: "granted", PermissionBasis: "Synthetic note authored for disposable local testing.", PermittedUse: "scion_review", ChangeSummary: "Initial versioned source"}
	if err := h.check("missing rights do not create any object key or version", func() error {
		before, err := s.versions("")
		if err != nil {
			return err
		}
		denied := objectMap(input)
		delete(denied, "rights_status")
		if _, err := h.sourceReq("POST", listPath, h.tokenA, denied, "storage-no-rights", `"1"`, 403); err != nil {
			return err
		}
		after, err := s.versions("")
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(before, after) {
			return fmt.Errorf("missing-rights input wrote object bytes")
		}
		return nil
	}); err != nil {
		return err
	}
	var sourcePath string
	var first storedRevision
	var snapshot, createReceipt response
	if err := h.check("upload and pinned retrieval match SHA-256 and exact UTF-8 bytes in real storage", func() error {
		var err error
		createReceipt, err = h.sourceReq("POST", listPath, h.tokenA, input, "storage-source", "\"1\"", 201)
		if err != nil {
			return err
		}
		receipt, err := decode[sourceReceipt](createReceipt)
		if err != nil {
			return err
		}
		sourcePath = listPath + "/" + receipt.SourceID
		first, snapshot, err = h.stored(sourcePath + "/revisions/1")
		if err != nil {
			return err
		}
		data, err := s.bytes(s.admin, first)
		if err != nil {
			return err
		}
		if string(data) != input.SourceText || first.SourceText != input.SourceText {
			return fmt.Errorf("API/storage bytes differ")
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("idempotent upload retry preserves the same receipt and object version count", func() error {
		// Include every key: a faulty retry could create a new UUID-key orphan
		// while still replaying the old application receipt.
		before, err := s.versions("")
		if err != nil {
			return err
		}
		replay, err := h.sourceReq("POST", listPath, h.tokenA, input, "storage-source", "\"1\"", 201)
		if err != nil {
			return err
		}
		if err := equalReplay(createReceipt, replay); err != nil {
			return err
		}
		after, err := s.versions("")
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(before, after) {
			return fmt.Errorf("retry uploaded an extra object version")
		}
		return nil
	}); err != nil {
		return err
	}
	quote := "Target width: 120 mm."
	start := strings.Index(input.SourceText, quote)
	claim := claimInput{Statement: "Synthetic target only; unverified.", Locator: claimLocator{StartByte: start, EndByte: start + len(quote), Quote: quote}}
	if _, err := h.sourceReq("POST", sourcePath+"/revisions/1/claims", h.tokenA, claim, "storage-claim", "", 201); err != nil {
		return err
	}
	secondInput := input
	secondInput.SourceText = strings.Replace(input.SourceText, "120", "125", 1)
	secondInput.ChangeSummary = "Synthetic revision two"
	var second storedRevision
	if err := h.check("source revisions preserve old object versions and immutable revision metadata", func() error {
		if _, err := h.sourceReq("POST", sourcePath+"/revisions", h.tokenA, secondInput, "storage-revision", "\"1\"", 201); err != nil {
			return err
		}
		var err error
		second, _, err = h.stored(sourcePath + "/revisions/2")
		if err != nil {
			return err
		}
		if second.ObjectVersionID == first.ObjectVersionID {
			return fmt.Errorf("new revision reused version ID")
		}
		_, after, err := h.stored(sourcePath + "/revisions/1")
		if err != nil {
			return err
		}
		if !equalJSON(snapshot.body, after.body) {
			return fmt.Errorf("historical revision changed")
		}
		data, err := s.bytes(s.admin, first)
		if err != nil {
			return err
		}
		if string(data) != input.SourceText {
			return fmt.Errorf("old object bytes changed")
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("a newer object at the same key cannot replace the exact version pinned in PostgreSQL", func() error {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		wrong := []byte("SYNTHETIC unrelated newer bytes")
		uploaded, err := s.admin.PutObject(ctx, s.bucket, first.ObjectKey, bytes.NewReader(wrong), int64(len(wrong)), minio.PutObjectOptions{ContentType: "text/plain"})
		if err != nil {
			return err
		}
		if uploaded.VersionID == first.ObjectVersionID || uploaded.VersionID == "" {
			return fmt.Errorf("store did not preserve versions")
		}
		_, after, err := h.stored(sourcePath + "/revisions/1")
		if err != nil {
			return err
		}
		if !equalJSON(snapshot.body, after.body) {
			return fmt.Errorf("API fetched latest object instead of pinned version")
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("anonymous version reads are denied and runtime credentials cannot delete versions", func() error {
		res, err := (&http.Client{Timeout: 10 * time.Second}).Get(s.endpoint + "/" + s.bucket + "/" + first.ObjectKey + "?versionId=" + url.QueryEscape(first.ObjectVersionID))
		if err != nil {
			return err
		}
		defer res.Body.Close()
		if res.StatusCode != 403 {
			return fmt.Errorf("anonymous object read status %d", res.StatusCode)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		err = s.runtime.RemoveObject(ctx, s.bucket, first.ObjectKey, minio.RemoveObjectOptions{VersionID: first.ObjectVersionID})
		if err == nil {
			return fmt.Errorf("runtime deleted immutable object version")
		}
		if minio.ToErrorResponse(err).Code != "AccessDenied" {
			return fmt.Errorf("runtime deletion failed for unexpected reason: %w", err)
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("object-backed source endpoints retain organization hiding", func() error { return h.sourceHiding("/api/scions/"+draft.ID, sourcePath, input, claim) }); err != nil {
		return err
	}
	if err := h.check("Rust restart recovers exact recorded object versions and claims", func() error {
		if err := h.restartSources(); err != nil {
			return err
		}
		_, after, err := h.stored(sourcePath + "/revisions/1")
		if err != nil {
			return err
		}
		if !equalJSON(snapshot.body, after.body) {
			return fmt.Errorf("object-backed revision changed after API restart")
		}
		_, err = h.sourceClaims(sourcePath, 1, claim)
		return err
	}); err != nil {
		return err
	}
	if err := h.check("object-store outage fails closed and restarting it recovers the exact version", func() error {
		if err := s.task("Down"); err != nil {
			return err
		}
		// Always bring the local service back even when the denial assertion fails.
		faultErr := func() error {
			for _, suffix := range []string{"", "/revisions/1/claims"} {
				res, err := h.sourceReq("GET", sourcePath+suffix, h.tokenA, nil, "", "", 503)
				if err != nil {
					return err
				}
				if err := rejectContentFields(res.body); err != nil {
					return err
				}
			}
			_, err := h.sourceReq("GET", sourcePath, h.tokenB, nil, "", "", 404)
			return err
		}()
		if err := s.task("Up"); err != nil {
			return err
		}
		if faultErr != nil {
			return faultErr
		}
		_, after, err := h.stored(sourcePath + "/revisions/1")
		if err != nil {
			return err
		}
		if !equalJSON(snapshot.body, after.body) {
			return fmt.Errorf("revision changed after storage outage")
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("object-store restart preserves versioned bytes and the running API recovers", func() error {
		if err := s.task("Restart"); err != nil {
			return err
		}
		_, after, err := h.stored(sourcePath + "/revisions/1")
		if err != nil {
			return err
		}
		if !equalJSON(snapshot.body, after.body) {
			return fmt.Errorf("revision changed after object-store restart")
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("revocation blocks object-backed content and quotes while retaining versions", func() error {
		if _, err := h.sourceReq("POST", sourcePath+"/revoke", h.tokenA, map[string]string{"reason": "Synthetic storage permission withdrawn"}, "storage-revoke", "\"2\"", 201); err != nil {
			return err
		}
		for _, suffix := range []string{"", "/revisions", "/revisions/1", "/revisions/2", "/revisions/1/claims"} {
			res, err := h.sourceReq("GET", sourcePath+suffix, h.tokenA, nil, "", "", 403)
			if err != nil {
				return err
			}
			if err := rejectContentFields(res.body); err != nil {
				return err
			}
		}
		data, err := s.bytes(s.admin, first)
		if err != nil {
			return err
		}
		if string(data) != input.SourceText {
			return fmt.Errorf("revocation erased or modified retained version")
		}
		return nil
	}); err != nil {
		return err
	}
	if err := h.check("revoked object access stays denied after API and store restart", func() error {
		if err := s.task("Restart"); err != nil {
			return err
		}
		if err := h.restartSources(); err != nil {
			return err
		}
		res, err := h.sourceReq("GET", sourcePath, h.tokenA, nil, "", "", 403)
		if err != nil {
			return err
		}
		return rejectContentFields(res.body)
	}); err != nil {
		return err
	}
	// Faults target fresh disposable sources, never the retained development demo.
	makeFaultSource := func(label string) (string, storedRevision, error) {
		value := input
		value.Title = "Synthetic " + label + " fault"
		value.SourceText += "Fault fixture: " + label + "\n"
		res, err := h.sourceReq("POST", listPath, h.tokenA, value, "storage-fault-"+label, "\"1\"", 201)
		if err != nil {
			return "", storedRevision{}, err
		}
		receipt, err := decode[sourceReceipt](res)
		if err != nil {
			return "", storedRevision{}, err
		}
		path := listPath + "/" + receipt.SourceID
		if _, err := h.sourceReq("POST", path+"/revisions/1/claims", h.tokenA, claim, "storage-fault-claim-"+label, "", 201); err != nil {
			return "", storedRevision{}, err
		}
		rev, _, err := h.stored(path + "/revisions/1")
		return path, rev, err
	}
	assertFault := func(path string) error {
		for _, suffix := range []string{"", "/revisions", "/revisions/1", "/revisions/1/claims"} {
			res, err := h.sourceReq("GET", path+suffix, h.tokenA, nil, "", "", 503)
			if err != nil {
				return err
			}
			if err := rejectContentFields(res.body); err != nil {
				return err
			}
		}
		res, err := h.sourceReq("POST", path+"/revisions/1/claims", h.tokenA, claim, "fault-new-claim", "", 503)
		if err != nil {
			return err
		}
		if err := rejectContentFields(res.body); err != nil {
			return err
		}
		foreign, err := h.sourceReq("GET", path, h.tokenB, nil, "", "", 404)
		if err != nil {
			return err
		}
		return rejectContentFields(foreign.body)
	}
	if err := h.check("missing pinned version denies detail/history/claims without PostgreSQL or latest-version fallback", func() error {
		path, rev, err := makeFaultSource("missing")
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.admin.RemoveObject(ctx, s.bucket, rev.ObjectKey, minio.RemoveObjectOptions{VersionID: rev.ObjectVersionID}); err != nil {
			return err
		}
		return assertFault(path)
	}); err != nil {
		return err
	}
	if err := h.check("corrupt real object bytes deny content/quotes and remain hidden across organizations", func() error {
		path, rev, err := makeFaultSource("corrupt")
		if err != nil {
			return err
		}
		if err := s.task("CorruptTestObject", "-Key", rev.ObjectKey, "-Version", rev.ObjectVersionID); err != nil {
			return err
		}
		return assertFault(path)
	}); err != nil {
		return err
	}
	return nil
}
