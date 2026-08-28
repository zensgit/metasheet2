import { defineConfig } from 'vitest/config'
import * as path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Fix vite SSR transformation issues - use forks pool to avoid __vite_ssr_exportName__ errors
    pool: 'forks',
    // #4154: supertest specs call `request(app)`, which spins up a fresh `app.listen(0)` ephemeral
    // listener PER REQUEST (~495 call sites across 42 files). Under full-suite event-loop load the OS
    // recycles ephemeral ports fast enough that a request occasionally lands on a DIFFERENT test's app
    // that just rebound the same port — proven by a `GET /api/approvals` returning 405 (a server that
    // knows the path but not the method = someone else's app), and by the FAILING SPEC being random
    // across runs (dashboard / ai-suggest / approval-rbac) rather than fixed. The collision is purely
    // transient: a retry gets a fresh port and hits the right server. A DETERMINISTIC product failure
    // still fails all attempts, so this absorbs the infra flake without hiding real bugs. (Tradeoff,
    // stated plainly: a genuinely NON-deterministic PRODUCT race would also be absorbed — acceptable
    // here because these are mock-dep unit tests, but flagged for review.)
    // CI-only (review of #4169): the required `test (20.x)` check runs in CI, so retry absorbs the
    // flake exactly where it reds a gate; locally retry is 0 so a developer sees a genuine failure
    // immediately instead of waiting through re-runs — and the masking tradeoff never touches local
    // debugging. GitHub Actions sets CI=true for every run.
    retry: process.env.CI ? 2 : 0,
    deps: {
      interopDefault: true
    },
    // Excluded tests - All unit tests enabled as of Session 9
    // Most integration tests require database/external services and custom PluginLoader API.
    // Mock-DB integration tests (comment-flow, collab-ux-flow) can run without a live DB.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Integration tests requiring a live DB or pluginDirs PluginLoader API:
      'tests/integration/admin-users.api.test.ts',
      'tests/integration/after-sales-plugin.install.test.ts',
      'tests/integration/after-sales-registry-backfill.test.ts',
      'tests/integration/approval-directory-endpoints.api.test.ts',
      'tests/integration/approval-participant-directory.api.test.ts',
      // member-display-identity (2026-08-19): the authorized-scope EXACT id->name batch resolver
      // (GET /api/approvals/directory/resolve). Requires real PostgreSQL (users/roles rows);
      // excluded from the no-DB job so describeIfDatabase cannot skip-green it, and wired as a
      // WHOLE FILE into the standalone .github/workflows/approval-realdb-directory-resolve.yml
      // lane (NOT plugin-tests.yml — that file is s6a sha256-pinned provenance input and stays
      // byte-identical to main; see that workflow's own header for the precedent/rationale).
      'tests/integration/approval-directory-resolve.api.test.ts',
      'tests/integration/approval-p1c-field-permissions.api.test.ts',
      'tests/integration/approval-wp-add-reduce-sign.api.test.ts',
      'tests/integration/approval-direct-manager.api.test.ts',
      'tests/integration/approval-postgate-acceptance.api.test.ts',
      // Sealed-export S3 private ingestion concurrency + transactional recovery golden. It
      // applies migration 068 in an isolated schema and requires real PostgreSQL behavior;
      // excluded from the no-DB job and wired as a whole file in plugin-tests.yml.
      'tests/integration/sealed-export-s3-private-ingestion-realdb.test.ts',
      // Sealed-export S4 generation lease/CAS, inactive apply and visibility golden. It
      // applies migrations 068+069 in an isolated schema and requires real PostgreSQL;
      // excluded from the no-DB job and wired as a whole file in plugin-tests.yml.
      'tests/integration/sealed-export-s4-generation-kernel-realdb.test.ts',
      // Template authoring + version-restore real HTTP/DB acceptance. Excluded from the no-DB
      // default job so describeIfDatabase cannot skip-green it; wired as a whole file in the
      // approval real-DB workflow step.
      'tests/integration/approval-template-authoring-uat.api.test.ts',
      // Lock-5 per-node operation policy (`操作权限`) real-DB acceptance — the §2.1 dispatch choke,
      // the `policy_denied` audit row + its CHECK migration, the two timeline exclusions, and the
      // placement / strictness / in-flight-freeze gates. Requires real PostgreSQL (it asserts a CHECK
      // constraint violation and a records-only COMMIT that survives a thrown request). Excluded from
      // the no-DB default job so `describeIfDatabase` cannot skip-green it; wired as a WHOLE FILE into
      // .github/workflows/approval-realdb-node-operation-policy.yml, which arms EXPECT_DB=1.
      'tests/integration/approval-node-operation-policy.db.test.ts',
      // Lock-5 B-2 (`'before'` honesty pin + the B-3 deferral evidence) and §1.3 commentRequired
      // (CR-1/CR-2 + the A-2 DTO carrier). Both need real PostgreSQL (the B-3 evidence test
      // constructs a mixed-epoch state and asserts the shipped structural invariant refuses it).
      // Excluded here so `describeIfDatabase` cannot skip-green them in the no-DB job; both are
      // wired as WHOLE FILES into .github/workflows/approval-realdb-node-operation-policy.yml.
      'tests/integration/approval-add-sign-honesty.db.test.ts',
      'tests/integration/approval-comment-required.db.test.ts',
      // GET /api/approvals/:id/history guard alignment (rbacGuard('approvals', 'read'), matching
      // the sibling GET /api/approvals/:id): the discriminating-negative + positive-control real-DB
      // acceptance. Requires real PostgreSQL. Excluded here so `describeIfDatabase` cannot
      // skip-green it in the no-DB job; wired as a WHOLE FILE into the standalone
      // .github/workflows/approval-realdb-history-guard.yml lane, which arms EXPECT_DB=1.
      'tests/integration/approval-history-authz-guard.db.test.ts',
      // Lock-4 F4-A (node-level auto_approve, 审批类型) real-DB acceptance — gates A-1 (server door),
      // A-2 (audit-row sentinel + byte-identical absent-config control), A-3 (dedupeHistoricalApprover
      // exemption + the disclosed mergeAdjacentApprover-suppression side effect). DB-independent logic
      // lives in tests/unit/approval-lock4-f4a-auto-decision.test.ts (not excluded — runs in the no-DB
      // job). Excluded here so `describeIfDatabase` cannot skip-green this file; wired as a WHOLE FILE
      // into .github/workflows/approval-realdb-lock4-p3a.yml, which arms EXPECT_DB=1.
      'tests/integration/approval-lock4-f4a-auto-decision.db.test.ts',
      // Lock-4 F4-C (same-person policy, 审批人=提交人) real-DB acceptance — gates C-1 (auto_skip
      // byte-identical deep-equal), C-2 (frozen managerId, real directory mutation between two
      // creates), C-3 (absent transfer target 400s, never falls back to self_approve). DB-independent
      // logic lives in tests/unit/approval-lock4-f4c-same-person.test.ts. Excluded here for the same
      // reason as the F4-A file immediately above; wired into the SAME
      // .github/workflows/approval-realdb-lock4-p3a.yml lane.
      'tests/integration/approval-lock4-f4c-same-person.db.test.ts',
      // Lock-4 F4-B (designated empty-assignee fallback, 审批人为空时) real-DB acceptance — gates
      // B-1 (both executor sites: resolveFromNode initial/re-entry, and resolveBranchAdvance via a
      // parallel branch's second node), the Gate-2 'error' negative controls on each identical
      // fixture, Gate 3 (the authoring choke, which fires at CREATE — one of its five entry points
      // — not merely publish, plus a post-publish persisted-graph tamper that proves dispatch-time
      // fail-closed), and Gate 4 (legacy-graph byte-identical deep-equal).
      // DB-independent logic lives in tests/unit/approval-p3a-f4b-designated-fallback{,-normalize}
      // .test.ts (not excluded — runs in the no-DB job). Excluded here so `describeIfDatabase`
      // cannot skip-green this file; wired as a WHOLE FILE into the standalone
      // .github/workflows/approval-realdb-f4b-designated.yml lane, which arms EXPECT_DB=1.
      'tests/integration/approval-lock4-f4b-designated.db.test.ts',
      'tests/integration/dept-head-sync-plumbing.test.ts',
      // DT-HARDEN-02 orphan guard (real DB): proves the admission SAVEPOINT rolls back a users
      // INSERT when the bind throws after it. DATABASE_URL-gated; excluded here so the no-DB job
      // cannot skip-green it, and wired as a WHOLE FILE into the approval real-DB step.
      'tests/integration/directory-sync-admission-orphan-guard.db.test.ts',
      // O2-S1 register() whole-transaction atomicity goldens: DATABASE_URL-gated; excluded here so
      // the no-DB job cannot skip-green it; wired whole-file into the auth real-DB step in plugin-tests.yml.
      'tests/integration/auth-register-atomicity.db.test.ts',
      // P2-1 (post-#3972 review): proves the create-time email existence check is
      // case-insensitive and that batchAdmitDirectoryAccountUsers enforces server-side
      // eligibility (no duplicate `users` row for a differently-cased email; no silent
      // re-admission of an already-linked account). DATABASE_URL-gated; excluded here so the
      // no-DB job cannot skip-green it, and wired as a WHOLE FILE into the approval real-DB step.
      'tests/integration/directory-admission-case-insensitive-uniqueness.db.test.ts',
      // DT-HARDEN-05 lease golden (real DB): proves the partial unique index makes the lease
      // a database invariant and that COALESCE(last_heartbeat_at, started_at) staleness never
      // reclaims a live long run. DATABASE_URL-gated; excluded here so the no-DB job cannot
      // skip-green it, and wired as a WHOLE FILE into the approval real-DB step.
      'tests/integration/directory-sync-run-lease.db.test.ts',
      // org-transfer Phase 1 §12.1: real-DB proof that corp_id is immutable once set (incl. the first-sync
      // window). DATABASE_URL-gated; excluded from the no-DB default job so it cannot skip-green, and wired
      // as a WHOLE FILE into the `Run approval real-DB integration` step in plugin-tests.yml.
      'tests/integration/directory-tenant-change-immutable.db.test.ts',
      // R1-L4 syncDirectoryIntegration orchestration harness (real DB): drives the REAL sync
      // end-to-end (mocked DingTalk pull, real Postgres apply) to cover the CALL SITES the
      // per-helper goldens cannot — heartbeat lifecycle/interval-cleared proof, H02 admission
      // wiring + per-account SAVEPOINT, OPS-01 deprovision executor wiring (both arms), and
      // the stale-lease reclaim composition (trigger path + scheduler boot sweep).
      // DATABASE_URL-gated; excluded here so the no-DB job cannot skip-green it, and wired as
      // a WHOLE FILE into the approval real-DB step in plugin-tests.yml.
      'tests/integration/directory-sync-orchestration.db.test.ts',
      // Roadmap §7.8 "Add timezone support" (real DB): proves schedule_timezone round-trips
      // through create/update/read against the REAL migrated column, and specifically the
      // absent-vs-present update semantics (omitted key preserves; explicit '' clears) that a
      // mocked-pg unit test cannot prove end-to-end. DATABASE_URL-gated; excluded here so the
      // no-DB job cannot skip-green it, and wired as a WHOLE FILE into the directory real-DB
      // step in plugin-tests.yml.
      'tests/integration/directory-sync-schedule-timezone.db.test.ts',
      // Canonical Org MVP B1 (#4215 §5.1) local-provider bootstrap (real DB): proves
      // getOrCreateLocalIntegration's concurrency-safe get-or-create, the
      // one_active_local_integration_per_org partial index (both halves: caps active rows,
      // permits inactive history), the creation audit event, and provider-scoped coexistence
      // with a dingtalk integration. DATABASE_URL-gated; excluded here so the no-DB job cannot
      // skip-green it, and wired as a WHOLE FILE into the directory real-DB step in
      // plugin-tests.yml.
      'tests/integration/directory-local-provider-bootstrap.db.test.ts',
      // Canonical Org MVP B1 owner round P2-2 (#4215 §5.1): proves, against the scheduler's REAL
      // startup-scan path (not a mock), that a `provider='local'` row forced to every
      // schedule-eligible condition is never registered as a cron job, with an identically
      // configured dingtalk row as a positive control. DATABASE_URL-gated; excluded here so the
      // no-DB job cannot skip-green it, and wired as a WHOLE FILE into the directory real-DB
      // step in plugin-tests.yml.
      'tests/integration/directory-local-provider-scheduler-exclusion.db.test.ts',
      // Canonical Org MVP B2 (local departments/accounts/memberships CRUD), design lock §5.2-5.4,
      // service layer (real DB): department create/rename/archive-keeps-history, account
      // create+link+deactivate (with a positive control proving the local account never touches
      // user_external_identities), membership add idempotency, and the explicit primary-department
      // switch (old primary demoted, exactly one is_primary per account). DATABASE_URL-gated;
      // excluded here so the no-DB job cannot skip-green it, and wired as a WHOLE FILE into the
      // directory real-DB step in plugin-tests.yml.
      'tests/integration/local-directory-org-crud.db.test.ts',
      // Canonical Org MVP B2, HTTP route layer (real DB): platform-admin gating, per-mutation
      // audit rows, and the owner hard requirement — an org_id/corp_id (snake_case AND camelCase)
      // smuggled into a B2 request body is REJECTED (400), never silently dropped. DATABASE_URL-
      // gated; excluded here so the no-DB job cannot skip-green it, and wired as a WHOLE FILE into
      // the directory real-DB step in plugin-tests.yml.
      'tests/integration/local-directory-org-crud-route.db.test.ts',
      // Canonical Org MVP PB4-2: archive → FULL read-only enforced at the WRITE POINT — direct-writer
      // archived enforcement + two-connection deterministic barriers (archive-first → 409 / write-
      // first → write-wins) + primary-switch full-read-only/cross-scope + deadlock-freedom. This is a
      // TWO-CONNECTION concurrency suite that is meaningless without a real DB. DATABASE_URL-gated;
      // excluded here so the no-DB job cannot skip-green it, and wired as a WHOLE FILE into the
      // directory real-DB step in plugin-tests.yml (both points asserted by
      // pb4-2-archive-readonly-ci-wiring.test.mjs so neither can silently drop).
      'tests/integration/local-directory-org-archive-readonly.db.test.ts',
      // Canonical Org MVP PB4-3: department cycle detection — in-transaction recursive ancestor
      // walk + per-integration serialized reparent (advisory xact lock). Includes a TWO-CONNECTION
      // barrier proving the advisory lock catches the disjoint cross-mount 4-cycle race, plus a
      // termination proof on malformed loop data — meaningless without a real DB. DATABASE_URL-gated;
      // excluded here so the no-DB job cannot skip-green it, and wired as a WHOLE FILE into the
      // directory real-DB step in plugin-tests.yml (both points asserted by
      // pb4-3-cycle-detection-ci-wiring.test.mjs so neither can silently drop).
      'tests/integration/local-directory-org-cycle-detection.db.test.ts',
      // Canonical Org MVP PB4-4: local integration REACTIVATION — getOrCreate revives the deactivated
      // canonical anchor in place (same id, children preserved) instead of a bricking name-collision.
      // Includes 2-way/5-way concurrency proving a single reactivate audit — meaningless without a
      // real DB. DATABASE_URL-gated; excluded here so the no-DB job cannot skip-green it, and wired as
      // a WHOLE FILE into the directory real-DB step in plugin-tests.yml (both points asserted by
      // pb4-4-reactivation-ci-wiring.test.mjs so neither can silently drop).
      'tests/integration/directory-local-integration-reactivation.db.test.ts',
      // Canonical Org MVP B4 (#4215 §5.5): directory_department_bindings buildable FK chain — a
      // cross-org binding is FK-IMPOSSIBLE to insert (both integrations pinned to one org_id column;
      // NOT NULL closes the MATCH SIMPLE hole). Proves rejection BY the org-chain FK by name + the
      // NOT NULL/FK mutations — meaningless without a real DB. DATABASE_URL-gated; excluded here so
      // the no-DB job cannot skip-green it, and wired as a WHOLE FILE into the directory real-DB step
      // in plugin-tests.yml (both points asserted by b4-department-bindings-ci-wiring.test.mjs).
      'tests/integration/directory-department-bindings.db.test.ts',
      // Canonical Org MVP B5-a (design lock Lock 1): org_directory_routing_policy schema — the
      // explicit (org,purpose) policy store; cross-org policy FK-impossible, closed purpose set,
      // RESTRICT posture. Real-DB constraint proofs by name — meaningless without a DB.
      // DATABASE_URL-gated; excluded here so the no-DB job cannot skip-green it, and wired as a
      // WHOLE FILE into the directory real-DB step in plugin-tests.yml (both points asserted by
      // b5a-routing-policy-ci-wiring.test.mjs so neither can silently drop).
      'tests/integration/org-directory-routing-policy-schema.db.test.ts',
      // Canonical Org MVP B5-b (design lock Lock 2 + Q4): the routing-policy RESOLVER — policy-
      // authoritative vs latest-updated guessing, fail-closed on broken canonical, multi-org
      // ambiguity, data-absence {} semantics, and the no-policy legacy control. Real-DB end-to-end
      // through resolveApprovalRequesterOrgRelations — meaningless without a DB. DATABASE_URL-gated;
      // wired as a WHOLE FILE into the directory real-DB step (both points asserted by
      // b5b-routing-resolver-ci-wiring.test.mjs).
      'tests/integration/org-directory-routing-policy-resolver.db.test.ts',
      // B5-b owner P1 (fail-open closure): broken/unreadable routing policy must fail-close ALL
      // FOUR org assignee sources at approval create (422/503, zero instances, zero assignments) —
      // real MetaSheetServer + real createApproval. DATABASE_URL-gated; wired as a WHOLE FILE into
      // the APPROVAL real-DB step (both points asserted by b5b-failclose-ci-wiring.test.mjs).
      'tests/integration/approval-routing-policy-failclose.api.test.ts',
      // Canonical Org MVP B5-c (design lock Lock 3 + §7): the routing-policy admin ROUTES —
      // platform-admin gating, PATCH write-point validations + values-free audit, clear path, and
      // the READ-ONLY preview (real resolver both legs). HTTP against real Postgres.
      // DATABASE_URL-gated; wired as a WHOLE FILE into the directory real-DB step (both points
      // asserted by b5c-routing-routes-ci-wiring.test.mjs).
      'tests/integration/org-directory-routing-policy-routes.db.test.ts',
      // Canonical Org MVP B6 (§10.1): approval-routing local/DingTalk REAL-DB equivalence — the
      // sentinel source-check + seeded-equivalent parity matrix + pinned deptHead legacy asymmetry +
      // in-flight snapshot invariance through the REAL MetaSheetServer createApproval path.
      // DATABASE_URL-gated; wired as a WHOLE FILE into the APPROVAL real-DB step (server-based,
      // like approval-direct-manager) — both points asserted by b6-equivalence-ci-wiring.test.mjs.
      'tests/integration/approval-routing-policy-equivalence.db.test.ts',
      // Canonical Org MVP B7 (§9): suggest-only reconciliation — remote disappearance stales the
      // BINDING only (local dept row byte-identical), heal/idempotent sweep, ambiguous names never
      // auto-matched, suggest read-only zero-write. DATABASE_URL-gated; wired as a WHOLE FILE into
      // the directory real-DB placement of the `Run approval real-DB integration` step (both
      // points asserted by b7-reconciliation-ci-wiring.test.mjs — named-step anchored).
      'tests/integration/directory-binding-reconciliation.db.test.ts',
      // B7 owner round (#4436): binding ADMIN routes (list/suggestions/sweep+audit) → directory
      // real-DB placement (immediately after reconciliation); Q6 POST-SYNC auto-sweep hook →
      // approval real-DB placement (immediately after approval-routing equivalence). Both live in
      // the same named step `Run approval real-DB integration` but are step-block + exact-adjacency
      // index-anchored by b7-round2-ci-wiring.test.mjs so a same-step drift or multitable move reds.
      'tests/integration/directory-binding-admin-routes.db.test.ts',
      'tests/integration/directory-binding-sync-hook.db.test.ts',
      // Transfer MVP T1 (sequencing plan §2 row T1): provider_org_transfers lifecycle state machine,
      // the schema-level FK backstops (cross-org / provider-mismatch transfers FK-impossible), the
      // §12.3 dry-run-required guard, and the no-op apply's untouched-directory fingerprint — HTTP
      // against real Postgres. DATABASE_URL-gated; excluded here so the no-DB job cannot skip-green
      // it, and wired as a WHOLE FILE into the directory real-DB step in plugin-tests.yml (both
      // points asserted by t1-org-transfer-ci-wiring.test.mjs).
      'tests/integration/provider-org-transfer-t1.api.test.ts',
      // Transfer MVP T2 (§12.2): an ACTIVE org transfer freezes its source integration's sync —
      // typed 409 before the lease claim, zero run rows on entry freeze, the destructive absence
      // sweep provably blocked (freeze_source_sync=false override = positive control),
      // scheduler/route mapping, plus two-connection advisory-lock barriers for create/refreeze
      // vs sync-apply linearization. Drives the REAL syncDirectoryIntegration with a mocked
      // DingTalk client against real Postgres. DATABASE_URL-gated; excluded here so the no-DB
      // job cannot skip-green it, and wired as a WHOLE FILE into the approval real-DB step in
      // plugin-tests.yml (both points asserted by t2-source-freeze-ci-wiring.test.mjs).
      'tests/integration/directory-org-transfer-source-freeze.db.test.ts',
      // T2 lock-correctness: canonical UUID lock key (uppercase route id must contend on the
      // transfer side's DB-canonical advisory key — proven via pg_locks same-tuple witness)
      // + explicit READ COMMITTED pin for the freeze-lock transactions, proven against a
      // repeatable-read-DEFAULT service pool (the file amends DATABASE_URL with
      // `options=-c default_transaction_isolation=repeatable\ read` before the pool is built).
      // Drives the REAL syncDirectoryIntegration / createOrgTransfer with a mocked DingTalk
      // client against real Postgres. DATABASE_URL-gated; excluded here so the no-DB job
      // cannot skip-green it, and wired as a WHOLE FILE into the directory real-DB step in
      // plugin-tests.yml (both points asserted by t2-source-freeze-ci-wiring.test.mjs).
      'tests/integration/directory-source-freeze-lock-correctness.db.test.ts',
      // Invite accept ledger-first concurrency + rollback (real DB, PR #4559 P2): two real
      // connections + row-lock barrier; user UPDATE zero-row leaves ledger pending.
      // DATABASE_URL-gated; excluded here so the no-DB job cannot skip-green; whole-file wired
      // into the approval real-DB step in plugin-tests.yml.
      'tests/integration/invite-accept-concurrency-rollback.db.test.ts',
      // Grant/membership real-table writes + restore granted_by / missing membership DRIFT
      // (PR #4581). DATABASE_URL-gated; excluded so no-DB job cannot skip-green; whole-file
      // wired into the approval real-DB step (both points asserted by
      // scripts/ops/directory-grant-table-ci-wiring.test.mjs).
      'tests/integration/directory-deprovision-grant-table.db.test.ts',
      // OPS-01 superseded creation-effect compensation: full deprovision/OAuth chain,
      // provenance drift, live-evidence veto, idempotency, and a two-connection user-mutex
      // barrier. Wired beside the grant-table suite and pinned by the same wiring contract.
      'tests/integration/directory-deprovision-compensation.db.test.ts',
      // T3 activation source read serialises against a concurrent integration deactivation
      // (post-merge review P1, FOR SHARE). Constructed pg_locks race — meaningless without a DB.
      // DATABASE_URL-gated; excluded so the no-DB job cannot skip-green; whole-file wired into
      // the approval real-DB step (both points self-asserted inside the suite).
      'tests/integration/directory-activation-source-lock.db.test.ts',
      // D3 Rev 4.3 evidence-ledger migration: isolated-schema upgrade, replay with evidence,
      // fail-before-DDL weak-data guard, FK/trigger invariants, and ownership-safe down.
      // DATABASE_URL-gated; excluded here and wired as a whole file into the approval real-DB
      // step, with both points pinned by directory-deprovision-ledger-ci-wiring.test.mjs.
      'tests/integration/directory-deprovision-ledger-schema.db.test.ts',
      // D4 access-graph writer + evidence are one transaction: real committed state, cross-org
      // split, default-off/zero-effect no-write, and fail-last ledger rollback. DATABASE_URL-gated;
      // excluded here and whole-file wired into the approval real-DB step.
      'tests/integration/directory-deprovision-writer-ledger.db.test.ts',
      // D4 two-connection goldens (adversarial-review absorption): the deterministic
      // lock-wait race that proved the stale globally-clear P1, and the §5.4 supersede
      // both-legs golden. DATABASE_URL-gated; whole-file wired into the approval real-DB step.
      'tests/integration/directory-deprovision-race-supersede.db.test.ts',
      // D5 canonical per-user access-graph mutex: supersede+generation atomicity, rollback,
      // and a pg_blocking_pids row-lock barrier. DATABASE_URL-gated; excluded here and
      // whole-file wired into the approval real-DB step.
      'tests/integration/directory-access-graph-mutex.db.test.ts',
      // DingTalk multi-corp external-key isolation: corp-scoped uniqueness, upgrade migration,
      // real-sync coexistence, and same-corp/cross-corp identity matching controls.
      // DATABASE_URL-gated; excluded here so the no-DB job cannot skip-green it, and wired as a
      // WHOLE FILE into the approval real-DB step in plugin-tests.yml (both points asserted by
      // t2gate-collision-mechanism-ci-wiring.test.mjs).
      'tests/integration/directory-account-external-key-collision-mechanism.db.test.ts',
      // Canonical Org MVP B3 (#4215 §5.4): proves ApprovalDirectoryOrg's DUAL-SOURCE direct-manager
      // resolution against real Postgres — normalized `is_manager` relation for a local integration,
      // the DingTalk `leader_in_dept` regression pin (load-bearing compat leg + is_manager=0 positive
      // control), precedence, the writer's default/no-raw and local-only boundary. DATABASE_URL-gated;
      // excluded here so the no-DB job cannot skip-green it, and wired as a WHOLE FILE into the
      // approval real-DB step in plugin-tests.yml. Two-point wiring — both points, deliberately.
      'tests/integration/directory-normalized-manager.db.test.ts',
      // Layer-2 hidden person/button masking (real DB): proves the cross-cutting visibility-key fix actually
      // masks the VALUE end-to-end, with non-vacuous controls. DATABASE_URL-gated; excluded here so the no-DB
      // job cannot skip-green it, and wired as a WHOLE FILE into the multitable real-DB step in
      // plugin-tests.yml. Two-point wiring — both points, deliberately.
      'tests/integration/multitable-layer2-hidden-person-button-realdb.test.ts',
      // Person before-side name resolution (real DB): its reason to exist is the LOCK-3 property — a
      // field_permissions-DENIED person field's members must never reach the directory resolver, so their
      // display NAMES can never surface. DATABASE_URL-gated; excluded here so the no-DB job cannot
      // skip-green it (a `describeIfDatabase` alone still gets COLLECTED and reported as skipped =
      // silently never run), and wired as a WHOLE FILE into the multitable real-DB step in plugin-tests.yml.
      // Two-point wiring — both points, deliberately.
      'tests/integration/multitable-history-person-names-realdb.test.ts',
      'tests/integration/approval-manager-chain.db.test.ts',
      'tests/integration/approval-requester-department.db.test.ts',
      'tests/integration/approval-requester-title.db.test.ts',
      'tests/integration/approval-requester-role.db.test.ts',
      // Lock-1 §K2 requester_choice real-DB acceptance (G-8/G-9/G-17/G-18). DATABASE_URL-gated;
      // excluded here so the no-DB default job cannot collect-and-skip-green it, and carried by
      // the DEDICATED .github/workflows/approval-realdb-acceptance.yml workflow (standalone per
      // the sealed-export-s6a-authority-row-lock.yml precedent — plugin-tests.yml is an s6a
      // sha256-pinned provenance input, so it is deliberately not extended). Two-point wiring —
      // both points land in the SAME commit, per the PR #4952 adversarial gate (P2-1).
      'tests/integration/approval-requester-choice.db.test.ts',
      // Lock-3 handler-node real-DB acceptance (G-4/G-6/G-7/G-8/G-9/G-10/G-11/G-12/G-16/G-17/G-18 +
      // the §1.5/G-13 backend registry). DATABASE_URL-gated; excluded here so the no-DB default job
      // cannot collect-and-skip-green it, and carried by the DEDICATED
      // .github/workflows/approval-realdb-handler.yml workflow (standalone per the same s6a precedent —
      // plugin-tests.yml is left byte-identical). Two-point wiring, both points in the SAME commit.
      'tests/integration/approval-handler-node.db.test.ts',
      // Lock-7 (docs/development/approval-lock7-field-edit-enforcement-20260817.md) field-edit
      // enforcement real-DB suite. Excluded here so the no-DB `test (18.x/20.x)` job does not
      // collect-and-skip-green it; it EXECUTES in the dedicated approval-realdb-field-edit.yml lane
      // (EXPECT_DB=1 arms the anti-skip sentinel). Two-point wiring, both points in the SAME commit;
      // plugin-tests.yml (the s6a sha256-pinned provenance input) is left byte-identical.
      'tests/integration/approval-field-edit-enforcement.db.test.ts',
      // Lock-7B (docs/development/approval-lock7b-required-at-node-20260820.md) node-level `required`
      // field tier (必填) real-DB suite. Excluded here so the no-DB `test (18.x/20.x)` job does not
      // collect-and-skip-green it; it EXECUTES in the dedicated approval-realdb-required-at-node.yml
      // lane (EXPECT_DB=1 arms the anti-skip sentinel). Two-point wiring, both points in the SAME
      // commit; plugin-tests.yml (the s6a sha256-pinned provenance input) is left byte-identical.
      'tests/integration/approval-lock7b-required-at-node.db.test.ts',
      // L6-P1 (docs/development/approval-lock6-requester-global-policy-20260817.md §1) policy
      // carrier fix — real-DB, whole-HTTP-stack publish/hydrate/PATCH/republish round trip
      // (gates P-1/P-2/P-3). DATABASE_URL-gated (describeIfDatabase); excluded here so the no-DB
      // default job cannot collect-and-skip-green it, and carried by the DEDICATED
      // .github/workflows/approval-template-policy-carrier-realdb.yml workflow (same standalone
      // rationale as the K2 lane immediately above — plugin-tests.yml is an s6a sha256-pinned
      // provenance input, deliberately not extended). Two-point wiring, same commit.
      'tests/integration/approval-template-policy-carrier.db.test.ts',
      // Lock-4 OD-L4-10(a) / Lock-6 L6-A gate A-7
      // (docs/development/approval-lock4-flow-policies-20260817.md §F4-D;
      // docs/development/approval-lock6-requester-global-policy-20260817.md §1/§3) — real-DB proof
      // that a RETURN round-scopes the dedup cascade's history (loadApprovalHistory's new
      // to_version floor + the return branch's `[]` seed). DATABASE_URL-gated (describeIfDatabase);
      // excluded here so the no-DB default job cannot collect-and-skip-green it, and carried by the
      // DEDICATED .github/workflows/approval-realdb-l6a-roundscoping.yml workflow (same standalone
      // rationale as the L6-P1 lane immediately above — plugin-tests.yml is an s6a sha256-pinned
      // provenance input, deliberately not extended). Two-point wiring, same commit.
      'tests/integration/approval-dedup-return-round-scoping.db.test.ts',
      // Lock-4 F4-E (docs/development/approval-lock4-flow-policies-20260817.md §5) — 离职自动转上级,
      // OD-L4-9(a) real-DB acceptance for `applyApprovalDepartureTransfer` (gates E-1/E-2/E-3 +
      // a constructed two-connection concurrency race). DATABASE_URL-gated (describeIfDatabase);
      // excluded here so the no-DB default job cannot collect-and-skip-green it, and carried by the
      // DEDICATED .github/workflows/approval-realdb-departure-transfer.yml workflow (same standalone
      // rationale as the L6-A lane immediately above — plugin-tests.yml is an s6a sha256-pinned
      // provenance input, deliberately not extended). Two-point wiring, same commit.
      'tests/integration/approval-departure-transfer.db.test.ts',
      // Lock-1 §K4 continuous_dept_heads real-DB acceptance (G-1/G-2/G-13, continue-past-empty,
      // freeze purity). DATABASE_URL-gated; excluded here so the no-DB default job cannot
      // collect-and-skip-green it, and carried by the SAME dedicated
      // .github/workflows/approval-realdb-acceptance.yml workflow (sibling job
      // approval-realdb-k4) — plugin-tests.yml stays byte-identical (s6a pin). Two-point wiring —
      // both points land in the SAME commit.
      'tests/integration/approval-dept-head-chain.db.test.ts',
      // Lock-1 §K5-b dept_head_at_level real-DB acceptance (G-1/G-2/core positional-not-hop-count,
      // out-of-range, freeze purity) — strictly downstream of K4, reads the SAME deptHeadChainIds
      // snapshot field. DATABASE_URL-gated; excluded here so the no-DB default job cannot
      // collect-and-skip-green it, and carried by the SAME dedicated
      // .github/workflows/approval-realdb-acceptance.yml workflow (sibling job
      // approval-realdb-k5b) — plugin-tests.yml stays byte-identical (s6a pin). Two-point wiring —
      // both points land in the SAME commit.
      'tests/integration/approval-dept-head-at-level.db.test.ts',
      // Lock-1 §K3 prior_node_approver real-DB acceptance (G-1/G-2/G-10/G-11/G-12/G-18 +
      // OD-L1-3(a) latest-round + OD-L1-4(a) skipped/auto-approved fail-closed + freeze-of-rule).
      // DATABASE_URL-gated; excluded here so the no-DB default job cannot collect-and-skip-green
      // it, and carried by the SAME dedicated .github/workflows/approval-realdb-acceptance.yml
      // workflow (sibling job approval-realdb-k3, EXPECT_DB=1 arming the top-level anti-skip
      // sentinel) — plugin-tests.yml stays byte-identical (s6a pin). Two-point wiring — both
      // points land in the SAME commit.
      'tests/integration/approval-prior-node-approver.db.test.ts',
      // Lock-1 §K1 user_group real-DB acceptance (G-1/G-5/G-6/G-7/G-17/G-18, curated bind/unbind
      // path, picker org-scoping, empty-group fail-closed/auto-approve). DATABASE_URL-gated;
      // excluded here so the no-DB default job cannot collect-and-skip-green it, and carried by
      // the SAME dedicated .github/workflows/approval-realdb-acceptance.yml workflow (sibling job
      // approval-realdb-k1, EXPECT_DB=1 arming the top-level anti-skip sentinel) —
      // plugin-tests.yml stays byte-identical (s6a pin). Two-point wiring — both points land in
      // the SAME commit.
      'tests/integration/approval-user-group.db.test.ts',
      // Lock-2 §L2-C form-field contact extensions (form_field_user_manager /
      // form_field_user_dept_head) real-DB acceptance (choke, publish pins C-1/C-2, door-2 422,
      // create-time freeze + dispatch over both pointers, C-4 distinctness, empty-vs-wedge split,
      // D-4 freeze purity, D-2 wedge, handler admission). DATABASE_URL-gated; excluded here so
      // the no-DB default job cannot collect-and-skip-green it, and carried by the SAME dedicated
      // .github/workflows/approval-realdb-acceptance.yml workflow (sibling job
      // approval-realdb-k6-contact, EXPECT_DB=1 arming the top-level anti-skip sentinel) —
      // plugin-tests.yml stays byte-identical (s6a pin). Two-point wiring — both points land in
      // the SAME commit.
      'tests/integration/approval-form-contact-extensions.db.test.ts',
      'tests/integration/approval-delegation-seam.db.test.ts',
      'tests/integration/approval-delegation-api.db.test.ts',
      'tests/integration/approval-detail-subform.db.test.ts',
      // FWB-0 Layer 2 record-link: DATABASE_URL-gated (describeIfDatabase). Excluded from the no-DB
      // default job so it doesn't skip-green, and wired as a WHOLE FILE into the
      // `Run approval real-DB integration` step in plugin-tests.yml.
      'tests/integration/approval-record-link.db.test.ts',
      'tests/integration/approval-pack1a-lifecycle.api.test.ts',
      'tests/integration/approval-common-template-presets.api.test.ts',
      // R2 hidden-field redaction guard: DATABASE_URL-gated (describeIfDatabase). Excluded from the
      // default no-DB job so it doesn't skip-green, and wired as a WHOLE FILE into the dedicated
      // `Run approval real-DB integration` step in plugin-tests.yml where it runs against real Postgres.
      'tests/integration/approval-bridge-redaction-regression.test.ts',
      // T2-3 person/team analytics: DATABASE_URL-gated. Excluded from the no-DB default job so it
      // doesn't skip-green, and wired as a WHOLE FILE into the `Run approval real-DB integration`
      // step in plugin-tests.yml where it runs against real Postgres every PR.
      'tests/integration/approval-metrics-people-teams.test.ts',
      // T1-1 node-level SLA remind (slice 1): DATABASE_URL-gated (describeIfDatabase). Excluded from the
      // no-DB default job so it doesn't skip-green, and wired as a WHOLE FILE into the `Run approval
      // real-DB integration` step in plugin-tests.yml where it runs against real Postgres every PR.
      'tests/integration/approval-node-sla-remind.test.ts',
      // T2-4 N-of-M threshold (门槛会签): DATABASE_URL-gated (describeIfDatabase). Excluded from the
      // no-DB default job so it doesn't skip-green, and wired as a WHOLE FILE into the
      // `Run approval real-DB integration` step in plugin-tests.yml where it runs against real Postgres.
      'tests/integration/approval-nofm-threshold.test.ts',
      // P7-R1 (FAIL-0/FAIL-3): T2-4 nodeEntryEpoch durable threshold round-scoping oracle — the
      // direct evidence for approval-parity-final-verification-20260817.md matrix rows I7/R8.
      // DATABASE_URL-gated (describeIfDatabase). Was NOT excluded here before this fix, so the
      // required no-DB `test (20.x)` job collected and describeIfDatabase-skip-greened it, and it
      // was named in NO real-DB lane — the exact FAIL-0 skip-green pattern. Excluded here so the
      // no-DB job cannot skip-green it, and wired as a WHOLE FILE into the dedicated
      // .github/workflows/approval-realdb-p7r1-coverage-repair.yml workflow (standalone per the
      // sealed-export-s6a-authority-row-lock.yml precedent — plugin-tests.yml is an s6a
      // sha256-pinned provenance input, deliberately not extended). Two-point wiring — both points
      // land in the SAME commit.
      'tests/integration/approval-node-entry-epoch.test.ts',
      // P7-R1 (FAIL-0/FAIL-4): WP1 或签 (any-mode) first-wins + sibling-cancellation oracle. Same
      // shape and same fix as the entry immediately above — was NOT excluded here, skip-greened in
      // the no-DB job, named in no real-DB lane. Excluded here and wired as a WHOLE FILE into the
      // SAME dedicated approval-realdb-p7r1-coverage-repair.yml workflow (sibling job
      // approval-realdb-wp1-any-mode). Two-point wiring, same commit.
      'tests/integration/approval-wp1-any-mode.api.test.ts',
      // P7-R1 (FAIL-0 §5 mechanical sweep, 2026-08-18): seven MORE approval real-DB suites found
      // by a systematic "every approval* test file vs every known lane" sweep — same skip-green
      // pattern as the two entries immediately above (describeIfDatabase-gated, referenced in NO
      // workflow, collected+skip-greened by the required no-DB job). Excluded here and wired as
      // WHOLE FILES into the SAME dedicated approval-realdb-p7r1-coverage-repair.yml workflow
      // (sibling job approval-realdb-p7r1-sweep). Two-point wiring, same commit.
      // approval-calendar-sla.test.ts was ALSO red on a fresh DB (fixture rot, same
      // grantApprovalWriteForIntegrationActor gap, fixed in the same commit); the other six were
      // already green.
      'tests/integration/approval-calendar-sla.test.ts',
      'tests/integration/approval-delegation-selfservice.db.test.ts',
      'tests/integration/approval-wp2-source-filter.api.test.ts',
      'tests/integration/approval-wp3-pending-count.api.test.ts',
      'tests/integration/approval-wp3-reads.api.test.ts',
      'tests/integration/approval-wp3-remind.api.test.ts',
      'tests/integration/approval-wp4-template-categories.api.test.ts',
      // T2-1+2 scoped approval admins + bulk handover: real-DB route/service boundary with RBAC and
      // approval_records CHECK coverage. Excluded from the no-DB default and wired into approval real-DB CI.
      'tests/integration/approval-bulk-reassign.api.test.ts',
      // T3-3 node signaturePolicy declared-inert floor: real HTTP + real DB round-trip.
      // Excluded from the no-DB default and wired into approval real-DB CI so it cannot skip-green.
      'tests/integration/approval-node-signature-policy.api.test.ts',
      // A-1 DingTalk approval-card delivery ledger (one-tap lock §3): DATABASE_URL-gated
      // (describeIfDb). Excluded from the no-DB default job so it doesn't skip-green, and wired as
      // a WHOLE FILE into the `Run approval real-DB integration` step in plugin-tests.yml where it
      // runs against real Postgres every PR.
      'tests/integration/dingtalk-approval-card-deliveries.db.test.ts',
      // §7.6 Delivery Closure — operator-initiated redelivery of a FAILED attendance-notification
      // outbox row: DATABASE_URL-gated (describeIfDb). Excluded from the no-DB default job so it
      // cannot skip-green, and wired as a WHOLE FILE into the `Run approval real-DB integration`
      // step in plugin-tests.yml where it runs against real Postgres every PR.
      'tests/integration/attendance-notification-redelivery.db.test.ts',
      // §7.6 Delivery Closure — HTTP route-level tests for the platform-admin-gated redelivery
      // endpoint (403/400/409/200 + values-free PII-free audit row). DATABASE_URL-gated
      // (describeIfDb). Excluded from the no-DB default job so it cannot skip-green, and wired as a
      // WHOLE FILE into the `Run approval real-DB integration` step in plugin-tests.yml.
      'tests/integration/attendance-notification-redelivery-route.db.test.ts',
      // DT-OPS-02 P2 follow-up: preview/apply auto-admission-candidate-count parity.
      // DATABASE_URL-gated (describeIfDatabase). Excluded from the no-DB default job so it
      // doesn't skip-green, and wired as a WHOLE FILE into the `Run approval real-DB
      // integration` step in plugin-tests.yml where it runs against real Postgres every PR.
      'tests/integration/directory-sync-preview-apply-parity.db.test.ts',
      // A-2a approval.task_created trigger chain: DATABASE_URL-gated (describeIfDatabase). Excluded
      // from the no-DB default job so it doesn't skip-green, and wired as a WHOLE FILE into the
      // automation real-DB step in plugin-tests.yml where it runs against real Postgres every PR.
      'tests/integration/automation-approval-task-created-trigger.test.ts',
      // A-2b approval-card action chain: DATABASE_URL-gated. Same two-point wiring (no skip-green).
      'tests/integration/automation-dingtalk-approval-card-action.test.ts',
      // DT-OPS-04 per-corp credential scoping: DATABASE_URL-gated. It deliberately UNSETS the
      // DingTalk env vars (the env-first short-circuit is what hid the bug), so it must never run
      // in the no-DB job. Wired as a WHOLE FILE into the multitable real-DB step.
      'tests/integration/dingtalk-person-message-integration-scoping.db.test.ts',
      // A-4 card-delivery wrapper: DATABASE_URL-gated. Same two-point wiring (no skip-green).
      'tests/integration/approval-card-delivery-wrapper.db.test.ts',
      // B-3 interactive-card callback adapter: DATABASE_URL-gated, and its per-corp test UNSETS
      // APPROVAL_CARD_LINK_SECRET (env-first short-circuit would hide the stored-secret path).
      // Same two-point wiring (no skip-green) — whole file in the multitable real-DB step.
      'tests/integration/dingtalk-approval-card-callback.db.test.ts',
      // DT-HARDEN-07 primary-department write → approval-routing golden: DATABASE_URL-gated
      // (describeIfDatabase). Excluded from the no-DB default job so it cannot skip-green, and
      // wired as a WHOLE FILE into the `Run approval real-DB integration` step in plugin-tests.yml.
      'tests/integration/directory-primary-department-write.db.test.ts',
      // DT-HARDEN-07 backfill idempotence + dry-run honesty: DATABASE_URL-gated. Same two-point
      // wiring — the script had zero coverage, which is how a non-idempotent backfill shipped.
      'tests/integration/directory-primary-department-backfill.db.test.ts',
      // DT-OPS-01 deprovision selection: DATABASE_URL-gated (describeIfDatabase). These goldens
      // exist *because* a fake client made the selection SQL untestable — running them without a
      // DB would skip-green and restore exactly that hole. Excluded here, wired as a WHOLE FILE
      // into the `Run approval real-DB integration` step in plugin-tests.yml.
      'tests/integration/directory-deprovision-selection.db.test.ts',
      // T36-1: projection per-row participant read + the #3537 fence goldens (both were previously
      // wired into NO workflow — skip-green; now run in plugin-tests' approval real-DB step).
      'tests/integration/approval-projection-visibility.db.test.ts',
      'tests/integration/approval-projection-participant-read.db.test.ts',
      // RP-1: route-preview shared substrate goldens (preview===create, zero-write, whitelist gate).
      'tests/integration/approval-route-preview-substrate.db.test.ts',
      'tests/integration/approval-route-preview-api.db.test.ts',
      'tests/integration/approval-template-route-preview-api.db.test.ts',
      // DT-OPS-03 P2-2: manager-binding coverage CTE + failure-streak ORDER BY are mock-only in
      // every unit test (corrupting either leaves all 13 unit tests green). DATABASE_URL-gated
      // (describeIfDatabase). Excluded from the no-DB default job so it doesn't skip-green, and
      // wired as a WHOLE FILE into the `Run approval real-DB integration` step in
      // plugin-tests.yml where it runs against real Postgres every PR.
      'tests/integration/directory-sync-alert-coverage.db.test.ts',
      // F5 files-orphan-blob-retention (blob_purged_at migration + sweepOrphanFileBlobs GF5-8 matrix):
      // DATABASE_URL-gated (describeDb), isolated per-test schema. Excluded from the no-DB default job
      // so it doesn't skip-green, and wired as a WHOLE FILE into the `Run attendance integration tests`
      // step in plugin-tests.yml (alongside files-storage-key-migration.db.test.ts) where it runs
      // against real Postgres every PR.
      'tests/integration/files-orphan-blob-retention.db.test.ts',
      // S6 event_fires tombstone→lease upgrade migration (backfill historical rows → done): DATABASE_URL-gated,
      // isolated per-test schema, real UPGRADE path (old schema + rows → migrate → assert). Excluded here so it
      // cannot skip-green, whole-file wired into `Run attendance integration tests` in plugin-tests.yml.
      'tests/integration/multitable-automation-event-fires-lease-migration.db.test.ts',
      // S6 event_fires LEASE claim/reclaim (window-2 fix): isolated-schema real DB. Excluded here so it cannot
      // skip-green, whole-file wired into the attendance real-DB step in plugin-tests.yml.
      'tests/integration/multitable-automation-event-fires-lease-realdb.db.test.ts',
      // P1#1 approval-bridge terminal→lease UPGRADE migration (existing rows keep status; new lease columns):
      // isolated-schema real UPGRADE path. Excluded here so it cannot skip-green, whole-file wired into
      // plugin-tests.yml's attendance real-DB step.
      'tests/integration/multitable-automation-approval-bridge-lease-migration.db.test.ts',
      // P1#1 approval-bridge LEASE claim/reclaim runtime crash matrix (terminal-early removal): real DB.
      // Excluded here so it cannot skip-green, whole-file wired into plugin-tests.yml's attendance real-DB step.
      'tests/integration/multitable-automation-approval-bridge-lease-realdb.test.ts',
      // P1#2 producer REPLACE seam same-txn goldens (enqueueRecordEventIfDurable commit/rollback/off): real DB.
      // Excluded here so it cannot skip-green, whole-file wired into plugin-tests.yml's attendance real-DB step.
      'tests/integration/multitable-automation-producer-emit-realdb.test.ts',
      // P1#2c producer family 2 (executor Class-A record events) REPLACE site goldens: real DB, same shape.
      'tests/integration/multitable-automation-producer-family2-realdb.test.ts',
      // The formal P2×ledger×FWB eight-scenario acceptance matrix (S1-S8, real DB, constructed crash/
      // concurrency) — the month plan's gate for flag enablement. Runs on merged main content.
      'tests/integration/multitable-p2-fwb-eight-scenario-matrix.test.ts',
      // Owner P1s (head 5afe30f26): REAL MetaSheetServer.start() fail-closed matrix — flag ON + missing
      // AutomationService / disabled retry scheduler must ABORT startup; flag OFF keeps legacy degrade.
      'tests/integration/multitable-durable-startup-failclosed.db.test.ts',
      // P1#2d producer family 5 (univer-meta routes ×4) durable REPLACE goldens (route-driven): real DB.
      // Excluded here so it cannot skip-green, whole-file wired into plugin-tests.yml's attendance real-DB step.
      'tests/integration/multitable-automation-producer-family5-realdb.test.ts',
      // P1#2b producer family 4 (record-service CRUD + record-write bulk) site-wiring goldens: real DB.
      // Excluded here so it cannot skip-green, whole-file wired into plugin-tests.yml's attendance real-DB step.
      'tests/integration/multitable-automation-producer-family4-realdb.test.ts',
      // P1#2e producer family 1 (approval completion + task_created) REPLACE site goldens: real DB, same shape.
      // Excluded here so it cannot skip-green, whole-file wired into plugin-tests.yml's attendance real-DB step.
      'tests/integration/multitable-automation-producer-family1-realdb.test.ts',
      // F9 owner CHANGES-REQUESTED (GF9-1/GF9-2): multitable_attachments blob_purged_at migration +
      // deleteAttachmentBinary index-free delete + sweepMultitableAttachmentBlobPurge compensating-sweep
      // matrix, same shape/rationale as the F5 entry immediately above (DATABASE_URL-gated describeDb,
      // isolated per-test schema). Excluded from the no-DB default job so it doesn't skip-green, and
      // wired as a WHOLE FILE into the `Run attendance integration tests` step in plugin-tests.yml.
      'tests/integration/multitable-attachment-blob-purge.db.test.ts',
      'tests/integration/attendance-approval-action-authorization.db.test.ts',
      // S7-1 real-DB: DATABASE_URL-gated describeIfDatabase, excluded from the no-DB default job so it
      // cannot skip-green, and wired as a WHOLE FILE into `Run attendance integration tests` below.
      'tests/integration/attendance-approval-flow-dynamic-kind-s7-1.db.test.ts',
      // S7-2 direct_manager real-DB: freeze + assignment + org-anchor + authz + flag-off. DATABASE_URL-
      // gated describeIfDatabase; excluded here so the no-DB job cannot skip-green it; wired whole-file
      // into the attendance real-DB step in plugin-tests.yml.
      'tests/integration/attendance-approval-direct-manager-s7-2.db.test.ts',
      // S7-3 dept_head real-DB: freeze + assignment + org-anchor + authz + flag-off + mixed DM+DH.
      // DATABASE_URL-gated describeIfDatabase; excluded here so the no-DB job cannot skip-green it;
      // wired whole-file into the attendance real-DB step in plugin-tests.yml.
      'tests/integration/attendance-approval-dept-head-s7-3.db.test.ts',
      // S7-4 manager_at_level real-DB: freeze managerChainIds + positional assignment + org-anchor +
      // authz + flag-off. DATABASE_URL-gated describeIfDatabase; excluded here so the no-DB job cannot
      // skip-green it; wired whole-file into the attendance real-DB step in plugin-tests.yml.
      'tests/integration/attendance-approval-manager-at-level-s7-4.db.test.ts',
      // W4-PRE-1 real-DB (§3.3 of attendance-vnext-wave4-onboarding-design-lock-20260721.md):
      // user_orgs admission write-site suites (fresh-DB/atomicity/two-org/upgrade across
      // POST /api/admin/users + directory-sync admission, plus the org-unknowable policy
      // negative controls). DATABASE_URL-gated describeIfDatabase; excluded here so the no-DB
      // job cannot skip-green them; wired whole-file into the attendance real-DB step in
      // plugin-tests.yml.
      'tests/integration/attendance-w4pre1-user-orgs-admission.db.test.ts',
      'tests/integration/attendance-w4pre1-user-orgs-directory-sync.db.test.ts',
      'tests/integration/attendance-w4pre1-user-orgs-policy.db.test.ts',
      // W4-PRE-1b real-DB (owner CHANGES_REQUESTED on the W4 re-ratify PR #4522, 2026-07-21):
      // user_orgs full LIFECYCLE — bind/auto-match writers (item A), org-scoped safe-
      // deactivation writers (item B), the real-stock backfill migration (item C), the S7-5
      // dual is_active gate (item E), and the explicit attendanceOrgId admin-users path
      // (item D). DATABASE_URL-gated describeIfDatabase; excluded here so the no-DB job
      // cannot skip-green them; wired whole-file into the attendance real-DB step in
      // plugin-tests.yml.
      'tests/integration/attendance-w4pre1b-user-orgs-lifecycle.db.test.ts',
      'tests/integration/attendance-w4pre1b-user-orgs-sync-automatch.db.test.ts',
      'tests/integration/attendance-w4pre1b-user-orgs-backfill-migration.db.test.ts',
      'tests/integration/attendance-w4pre1b-directory-readiness-gate.db.test.ts',
      'tests/integration/attendance-w4pre1b-admin-users-explicit-org.db.test.ts',
      // #4526 review addition: real-DB behavioral proof for item E's api-tokens.ts dual filter
      // (the PR's original coverage was mock-SQL-text-only).
      'tests/integration/attendance-w4pre1b-api-tokens-org-member-access.db.test.ts',
      // W4-PRE-1c real-DB (owner CHANGES_REQUESTED on the W4 re-ratify PR #4522, rev3 review,
      // 2026-07-22): controlled-departure user_orgs deactivation (owner 裁决②) — real sync
      // sweep composed with the deprovision executor (case ①), org-scoped composition with the
      // global sibling guard (cases ②/③), manual_review pending exposure (case ④), and the
      // readiness-gate + DingTalk destination permission negatives (case ⑤). DATABASE_URL-gated
      // describeIfDatabase; excluded here so the no-DB job cannot skip-green them; wired
      // whole-file into the attendance real-DB step in plugin-tests.yml.
      // W4-PRE-1d (owner candidate-set split, #4534): real-DB dual-integration departure matrix.
      // DATABASE_URL-gated describeIfDatabase; excluded here so the no-DB job cannot skip-green it;
      // wired whole-file into the attendance real-DB step in plugin-tests.yml (two-point wiring —
      // this exclude line was the missing second point, caught by the W4 wave-MD pre-review).
      'tests/integration/attendance-w4pre1d-departure-candidate-split.db.test.ts',
      'tests/integration/attendance-w4pre1c-departure-sweep-deprovision.db.test.ts',
      'tests/integration/attendance-w4pre1c-departure-org-scoped.db.test.ts',
      'tests/integration/attendance-w4pre1c-manual-review-pending.db.test.ts',
      'tests/integration/attendance-w4pre1c-departure-permission-negative.db.test.ts',
      // W4-0 real-DB (§9 of attendance-vnext-wave4-onboarding-design-lock-20260721.md): the
      // setup-readiness aggregate's G1 (two-org forgery + platform-admin bypass), G2 (SET
      // TRANSACTION READ ONLY actually rejecting a bare write / writable CTE / multi-statement
      // batch against real Postgres — a mock cannot prove this), G3 (① two positive controls), G4
      // (⑥ three notify signals + previewReady independence), and G5 (④ closed-set posture
      // against a real system_configs row) matrices. DATABASE_URL-gated describeIfDatabase;
      // excluded here so the no-DB job cannot skip-green it; wired whole-file into the attendance
      // real-DB step in plugin-tests.yml.
      'tests/integration/attendance-setup-readiness-w4-0.db.test.ts',
      // W5-0 (Wave 5 explainability design-lock 2026-07-22, RATIFIED §9): dual-host decision-trace
      // authorization matrix (G1/G7), allowlist/org-scoping negative controls (G2), the ⑤ raw
      // source_type fixture (G4), not_in_effect vs undeterminable (G5), and snapshot-exclusivity
      // (G6) against real Postgres. DATABASE_URL-gated describeIfDatabase; excluded here so the
      // no-DB job cannot skip-green it; wired whole-file into the attendance real-DB step in
      // plugin-tests.yml.
      'tests/integration/attendance-decision-trace-w5-0.db.test.ts',
      // #4561 W1: database exclusion/concurrency and effective-date transition proof.
      // Kept out of the no-DB run and explicitly wired into plugin-tests.yml.
      'tests/integration/attendance-calculation-group-membership-w1.db.test.ts',
      // #4710: isolated scratch-database proof for the SELECT-only legacy overlap audit.
      // Explicitly wired into the attendance real-DB step; exclusion prevents skip-green.
      'tests/integration/attendance-legacy-membership-overlap-audit.db.test.ts',
      // #4556 W2: shared work-date resolver real-DB matrix (overlap precedence, overnight,
      // multi-shift ambiguity, frozen recompute, overtime anchor, adapter parity).
      // DATABASE_URL-gated; excluded here so the no-DB job cannot skip-green it; wired
      // whole-file into the attendance real-DB step in plugin-tests.yml.
      'tests/integration/attendance-work-date-resolver-w2.db.test.ts',
      // #4556 W4C-0 Stage A: durable-storage migration smoke (SQL UUIDv5 golden vector,
      // derived-ID/claimed-commit/immutability refusals, P07 V1 job shape, down()
      // fail-closed). DATABASE_URL-gated; excluded here so the no-DB job cannot
      // skip-green it; wired whole-file into the attendance real-DB step in
      // plugin-tests.yml.
      'tests/integration/attendance-w4c0-durable-storage-smoke.db.test.ts',
      // #4556 W4C-0 Stage B: TS/SQL UUIDv5 golden parity (three namespaces) + real
      // pg_advisory_xact acquisition through the canonical helpers. DATABASE_URL-gated;
      // excluded here so the no-DB job cannot skip-green it; wired whole-file into the
      // attendance real-DB step in plugin-tests.yml (two-point wiring).
      'tests/integration/attendance-w4c0-identity-golden-parity.db.test.ts',
      // #4556 W4C-0 Stage C: registry service claim/seal/replay/congruence + P07 V1
      // reservation + advisory-helper deadline mapping against real Postgres.
      // DATABASE_URL-gated; excluded here so the no-DB job cannot skip-green it;
      // wired whole-file into the attendance real-DB step in plugin-tests.yml
      // (two-point wiring).
      'tests/integration/attendance-w4c0-operation-registry.db.test.ts',
      // #4556 W4C-0 Stage E1: full section 12.1 DB-gate matrix (migration lifecycle on a
      // scratch database, immutability refusal surface, transaction-bound deferred
      // constraints, pointer/lineage gates, P07 job gates + two-connection reservation
      // backstop). DATABASE_URL-gated; excluded here so the no-DB job cannot skip-green
      // it; wired whole-file into the attendance real-DB step in plugin-tests.yml
      // (two-point wiring).
      'tests/integration/attendance-w4c0-db-gates-e1.db.test.ts',
      // #4556 W4C-0 Stage E2: amendment section 2 identity-gate matrix (default/posture
      // reload doors, cross-namespace masquerade matrix, durable rehydration drift,
      // pre-lock/post-lock isolation) against real Postgres. DATABASE_URL-gated;
      // excluded here so the no-DB job cannot skip-green it; wired whole-file into the
      // attendance real-DB step in plugin-tests.yml (two-point wiring).
      'tests/integration/attendance-w4c0-identity-gates-e2.db.test.ts',
      // #4556 W4C-0 Stage E3: section 12.1 dual-connection concurrency gates (two
      // concurrent first claims, multi-key helper deadline, null-version worker
      // atomicity, rollout shared/exclusive races, P07 enqueue-vs-transition and
      // enqueue-vs-synchronous-caller in both commit orders). DATABASE_URL-gated;
      // excluded here so the no-DB job cannot skip-green it; wired whole-file into
      // the attendance real-DB step in plugin-tests.yml (two-point wiring).
      'tests/integration/attendance-w4c0-concurrency-gates-e3.db.test.ts',
      // #4556 W4C-2 (#4607 P3-4): strict IANA timezone WRITE-route guard for
      // default-rule/shift zones through the host-provided
      // attendanceW4SegmentCalculation port (lock 12.2 last sentence), boot-level
      // against the real plugin server. DATABASE_URL-gated; excluded here so the
      // no-DB job cannot skip-green it; wired whole-file into the attendance
      // real-DB step in plugin-tests.yml (two-point wiring).
      'tests/integration/attendance-w4c2-timezone-write-guard.db.test.ts',
      // #4556 W4C-2: outbox dispatcher gates (crash-after-commit-before-emit,
      // restart, TRUE two-connection concurrent dispatch, emit-failure backoff)
      // against real Postgres. DATABASE_URL-gated; excluded here so the no-DB
      // job cannot skip-green it; wired whole-file into the attendance real-DB
      // step in plugin-tests.yml (two-point wiring).
      'tests/integration/attendance-w4c2-outbox-dispatcher.db.test.ts',
      // #4556 W4C-2: canonical live/scheduled boundary WIRING gates (route-level,
      // real MetaSheetServer + plugin activate). DATABASE_URL-gated; excluded here
      // so the no-DB job cannot skip-green it; wired whole-file into the attendance
      // real-DB step in plugin-tests.yml (two-point wiring; the exclusion was
      // missed when the suite landed and is backfilled by Stage E).
      'tests/integration/attendance-w4c2-live-scheduled-boundary.db.test.ts',
      // #4556 W4C-2 (#4612 gate4 P3-3): genuine live-punch race + admin_run
      // authorization (real DB, route-level). DATABASE_URL-gated; excluded here so
      // the no-DB job cannot skip-green it; already wired whole-file into the
      // `Run attendance integration tests` step in plugin-tests.yml — this exclude
      // line was the missing SECOND point of that two-point wiring (gate4 finding:
      // present in the run-list but absent here, so the no-DB job's
      // "Run core-backend tests" step collected and skip-greened it every PR).
      'tests/integration/attendance-w4c2-p2-remediation.db.test.ts',
      // #4556 W4C-2 (#4612 gate3/gate4 P2-1 remediation): canonical/shadow
      // live-punch freeze-step anchor correctness (real DB, route-level + real
      // two-connection races — this is the PR's OWN main-line suite, L1-L7 +
      // Groups D/D-overnight/E/F/F2/G). DATABASE_URL-gated; excluded here so the
      // no-DB job cannot skip-green it; already wired whole-file into the
      // `Run attendance integration tests` step in plugin-tests.yml — this exclude
      // line was the missing SECOND point (gate4 P3-3: the PR's own primary
      // evidence file was skip-green in the no-DB lane every PR up to this point).
      'tests/integration/attendance-w4c2-p2-1-canonical-freeze-anchor.db.test.ts',
      // #4556 W4C-2: three-posture matrix + V2 freeze + env-gated outbox drain
      // (route-level, real DB). DATABASE_URL-gated; excluded here so the no-DB job
      // cannot skip-green it; wired whole-file into the attendance real-DB step in
      // plugin-tests.yml (two-point wiring; exclusion backfilled by Stage E).
      'tests/integration/attendance-w4c2-posture-matrix.db.test.ts',
      // #4556 W4C-2 Stage E: §12.3 residual gate matrix (W2 ambiguity review shape,
      // V2-cast storage backstop, same-org/cross-org isolation, forged-witness
      // zero-SQL legs, inactive membership, authoritative fail-closed, posture
      // no-rebase, outbox-before-seal SQL-order probe, durable scheduled replay,
      // P02 single-write discriminator). DATABASE_URL-gated; excluded here so the
      // no-DB job cannot skip-green it; wired whole-file into the attendance
      // real-DB step in plugin-tests.yml (two-point wiring).
      'tests/integration/attendance-w4c2-gate-matrix-e5.db.test.ts',
      // #4556 W4C-2 Gate D1 (#4844): the INERT authoritative-mode result-write CORE's §7.3
      // invariant matrix (version-uniqueness + lineage, retry idempotency, baseline + same-txn
      // atomicity, supersedes-locked-current, review hidden-placeholder, reversal restore/retire,
      // projection_effect/count, append-only) against real Postgres. DATABASE_URL-gated; excluded
      // here so the no-DB job cannot skip-green it; wired whole-file into the attendance real-DB
      // step in plugin-tests.yml (two-point wiring).
      'tests/integration/attendance-w4c2-authoritative-calculation-core.db.test.ts',
      // #4556 W4C-2 Gate D2 (#4844): the AUTHORITATIVE `live_punch` writer's real-Postgres matrix
      // — legacyOnlyTime reject with zero DML, the widened locked read, the create-if-absent F6
      // placeholder (including its concurrent poison race), the default-refuse retirement guard,
      // the split event INSERT + zero-invocation legacy-adapter pin, the canonical compat
      // fingerprint's byte identity, payloadFingerprint embedding, seal/row fingerprint equality,
      // and the synthesized wire response's golden key set. DATABASE_URL-gated; excluded here so
      // the no-DB job cannot skip-green it; wired whole-file into the attendance real-DB step in
      // plugin-tests.yml (two-point wiring).
      'tests/integration/attendance-w4c2-d2-live-punch-authoritative.db.test.ts',
      // #4556 W4C-2 Gate D3 (#4844): the AUTHORITATIVE `scheduled` writer's real-Postgres matrix —
      // the F6 placeholder + review/completed outcomes, the zero-invocation legacy-absence-adapter
      // pin, the guard-first parent seam (skip vs write vs contained 409), and above all D3's
      // PER-TARGET CONTAINMENT: rollback-to-savepoint completeness, the claimed-operation cancel
      // that makes the commit legal, the terminal `failed` outcome, the batch continuing past a
      // refusal, and the scope negatives that must still abort. DATABASE_URL-gated; excluded here so
      // the no-DB job cannot skip-green it; wired whole-file into the attendance real-DB step in
      // plugin-tests.yml (two-point wiring).
      'tests/integration/attendance-w4c2-d3-scheduled-authoritative.db.test.ts',
      // W4C-2 P1-2 (#4556, PR #4617 amendment, RATIFIED, owner Bundle A) — the schema/
      // migration half: scheduled-run identity tables, the outbox discriminated union,
      // the append-only per-target outcome side table, and their gates (1, 9, 11, 12 DB
      // half, 14 full migration matrix, 20 side-table legs). DATABASE_URL-gated;
      // excluded here so the no-DB job cannot skip-green it; wired whole-file into the
      // attendance real-DB step in plugin-tests.yml (two-point wiring).
      'tests/integration/attendance-w4c2-p12-migration-schema-gates.db.test.ts',
      // W4C-2 P1-2 second half (#4556, PR #4617 amendment, RATIFIED, owner Bundle A) — the
      // run-creation/resume transaction (section 1.7), the finalization transaction
      // (section 1.8), the O-3=(a) per-target outcome writer, the `abandoned` transition
      // (section 1.1.2), the O-4=(a) promotion-block guard, and the recovery-sweep step
      // function, plus TOCTOU/concurrent-finalization/concurrent-abandon real-DB legs.
      // DATABASE_URL-gated; excluded here so the no-DB job cannot skip-green it; wired
      // whole-file into the attendance real-DB step in plugin-tests.yml (two-point wiring).
      'tests/integration/attendance-w4c2-p12-run-transactions.db.test.ts',
      // W4C-2 P1-2 third suite (#4556, PR #4617 amendment, RATIFIED, owner Bundle A) — the
      // durable delivery / lock-order / atomicity gates: gates 2/3/4 (crash-before-emit
      // posture + dispatcher-restart exactly-once + payload/wire freeze), gate 5 (legacy
      // zero-row leg over all four W4 surfaces), gate 6 (restart completes only unfinished
      // users), gate 7's added abandon-while-finalizer-waits leg, gate 8 injected-failure
      // atomicity, gate 15 lock-order/no-class-11/no-source-DML witnesses (incl. the gate
      // 19/23 extensions), gate 17 suspended pause, and gate 22/23 controls. DATABASE_URL-
      // gated; excluded here so the no-DB job cannot skip-green it; wired whole-file into
      // the attendance real-DB step in plugin-tests.yml (two-point wiring).
      'tests/integration/attendance-w4c2-p12-durable-lock-gates.db.test.ts',
      // #4770 (W4C-2 recovery-sweep fairness/observability; owner ruling 2026-08-05) — the
      // durable-rotation scan fix (gate 1: >25 persistently-blocked candidates + a healthy
      // candidate finalizes within a bounded number of ticks; the mutation-red control is the
      // same test reverted by hand, not automated here), a steady-state parity check, and the
      // values-free tick/backlog/error observability shape (gate 3). Self-provisioned scratch
      // DB per test (the scan predicate is deliberately GLOBAL, not org-scoped — a shared DB
      // would corrupt this file's exact-count assertions). DATABASE_URL-gated; excluded here
      // so the no-DB job cannot skip-green it; wired whole-file into the attendance real-DB
      // step in plugin-tests.yml (two-point wiring).
      'tests/integration/attendance-w4c2-sweep-fairness.db.test.ts',
      // #4770 — the three named call-through legs (core host sweep/abandon port wiring, the
      // `attendance-w4-scheduled-run-sweep` scheduled job's real registration + real
      // execution, and the abandon HTTP route's auth/org/host chain), each proven against a
      // REAL booted MetaSheetServer + REAL plugin-attendance + REAL PostgreSQL (own freshly-
      // migrated scratch DB, for the same global-scan isolation reason as the fairness-fix
      // file above). DATABASE_URL-gated; excluded here so the no-DB job cannot skip-green it;
      // wired whole-file into the attendance real-DB step in plugin-tests.yml (two-point
      // wiring).
      'tests/integration/attendance-w4c2-sweep-call-through.db.test.ts',
      // W4C-3a durable legacy-plan migration: exact manifest/chunk/terminal
      // constraints, V1 frozen idempotency, direct-corruption congruence, and
      // guarded down. DATABASE_URL-gated; excluded here so the no-DB lane
      // cannot skip-green it. The whole file is wired into the attendance
      // real-DB step in plugin-tests.yml.
      'tests/integration/attendance-w4c3a-durable-legacy-plan-migration.db.test.ts',
      // W4C-3a durable plan enqueue: SERIALIZABLE authorization, reservation,
      // revision freeze, and zero-residue failures. DATABASE_URL-gated; excluded
      // here and run whole-file by the attendance real-DB workflow step.
      'tests/integration/attendance-w4c3a-durable-plan-enqueue.db.test.ts',
      // W4C-3a record-target precondition locks: two-connection present/missing
      // commit-order and lock-hold proofs. DATABASE_URL-gated; excluded here so
      // the no-DB lane cannot skip-green it. The whole file is wired into the
      // attendance real-DB step in plugin-tests.yml.
      'tests/integration/attendance-w4c3a-record-preconditions.db.test.ts',
      // W4C-3a fixed record-effect adapter: exact UPDATE/INSERT branches and
      // revision-trigger observation on migrated PostgreSQL. DATABASE_URL-gated;
      // excluded here and run whole-file by the attendance real-DB workflow step.
      'tests/integration/attendance-w4c3a-record-effects.db.test.ts',
      // W4C-3a fixed item-effect adapter: ordered apply/skip projection with
      // nullable fields and jsonb[] binding. DATABASE_URL-gated; excluded here
      // and run whole-file by the attendance real-DB workflow step.
      'tests/integration/attendance-w4c3a-item-effects.db.test.ts',
      // W4C-3a P08 child-process restart recovery: process B receives only
      // DATABASE_URL + jobId. DATABASE_URL-gated; excluded here and run
      // whole-file by the attendance real-DB workflow step.
      'tests/integration/attendance-w4c3a-p08-child-process.db.test.ts',
      // W4C-3a OD-58 group precondition races and SQL order.
      'tests/integration/attendance-w4c3a-group-preconditions.db.test.ts',
      // W4C-3a OD-60 group/batch SQL count legs.
      'tests/integration/attendance-w4c3a-group-effects.db.test.ts',
      // W4C-3a full-import authorization recovery matrix.
      'tests/integration/attendance-w4c3a-auth-recovery.db.test.ts',
      // W4C-3a canonical import execution, sync/legacy/integration route cutover,
      // append-only rollback, and rollout-control race gates. These suites require
      // real PostgreSQL and are whole-file wired into the attendance real-DB step.
      'tests/integration/attendance-w4c3a-canonical-import-kernel.db.test.ts',
      'tests/integration/attendance-w4c3a-p06-sync-import.db.test.ts',
      // W4C-3a M60 commit-token ordering uses real plugin HTTP routes and
      // PostgreSQL. Keep it out of the no-DB lane and run the whole file in
      // the attendance real-DB workflow step.
      'tests/integration/attendance-w4c3a-commit-token-ordering.db.test.ts',
      'tests/integration/attendance-w4c3a-p09-p10-p24-routes.db.test.ts',
      'tests/integration/attendance-w4c3a-import-rollback.db.test.ts',
      'tests/integration/attendance-w4c3a-rollout-control.db.test.ts',
      'tests/integration/attendance-w4c5-rollout-transition-tool.db.test.ts',
      // Gate E (#4844) first batch: real-Postgres four-state acceptance (open-read-only-refuse,
      // open-with-uncommitted-writes discriminating case, idle positive control, savepoint
      // cleanup) for the two converted category-1 sites
      // (`runAttendanceResultOperationTransactionV1` / `dispatchAttendanceResultEventOutboxV1`).
      // DATABASE_URL-gated (describeDb); excluded here so the no-DB job cannot skip-green it;
      // wired whole-file into the attendance real-DB step in plugin-tests.yml (two-point
      // wiring).
      'tests/integration/attendance-gate-e-txn-ownership-batch1.db.test.ts',
      'tests/integration/attendance-w4c3b-request-operation-routes.db.test.ts',
      'tests/integration/attendance-w4c3b-approved-leave-cancellation.db.test.ts',
      // OBS-1 (2026-08-07): the two W4C-3b suites below landed in #4716 with NEITHER wiring
      // point — absent from every real-DB run-list AND from this exclude, so the no-DB job
      // collected + skip-greened them and no job ever executed them. request-snapshots is the
      // real-DB proof of the 8-cell request-snapshot precondition (#4780, a soak entry gate);
      // central-approval is the R0 central-approval action matrix over a fully migrated DB.
      // DATABASE_URL-gated describeIfDatabase; excluded here so the no-DB job cannot
      // skip-green them; wired whole-file into the attendance real-DB step in plugin-tests.yml
      // (two-point wiring).
      'tests/integration/attendance-w4c3b-request-snapshots.db.test.ts',
      'tests/integration/attendance-w4c3b-central-approval.db.test.ts',
      'tests/integration/attendance-w4c3c-manual-recompute-retirement.db.test.ts',
      'tests/integration/attendance-w4c3c-record-operation-routes.db.test.ts',
      // #4556 W4C-4 §12.7: dual-host authorization, immutable calculation-detail/
      // DecisionTrace evidence and strict persisted-schema parsing against real Postgres.
      // Kept out of the no-DB run and invoked by whole filename in plugin-tests.yml.
      'tests/integration/attendance-w4c4-calculation-detail.db.test.ts',
      // #4709 FSER-1 desired-config migration, composite FKs, idempotent writes,
      // and reference-writer/delete lock protocol against real PostgreSQL.
      'tests/integration/attendance-group-fixed-schedule-config-migration.db.test.ts',
      // #4709 FSER-2 effectiveness read model requires real PostgreSQL and is run as a
      // whole file in the attendance real-DB workflow step.
      'tests/integration/attendance-group-fixed-schedule-effectiveness.db.test.ts',
      // #4709 FSER-3 first-config atomicity and true two-connection convergence require
      // real PostgreSQL; the whole file is explicitly run in plugin-tests.yml.
      'tests/integration/attendance-group-fixed-schedule-config-consume.db.test.ts',
      // #4709 FSER-4 prerequisite (member-safe self projection, contract amendment §2):
      // real-DB authorization matrix (liveness/activation/org-membership/group-membership,
      // cross-org isolation) and admin/self parity require real PostgreSQL; excluded here
      // so the no-DB job cannot skip-green it, and the whole file is explicitly run in
      // plugin-tests.yml's attendance-real-db-integration step.
      'tests/integration/attendance-group-fixed-schedule-self-effectiveness.db.test.ts',
      // #4556 W6-1 group effective-policy aggregate: real-DB route integration (happy path,
      // W6-R1 zero-write row-count/xmin snapshot, W6-R3 authorization ordering, W6-R4 FSER
      // fidelity, and the read-only-transaction structural backstop) requires real PostgreSQL;
      // excluded here so the no-DB job cannot skip-green it, and the whole file is explicitly
      // run in plugin-tests.yml's attendance-real-db-integration step.
      'tests/integration/attendance-w6-group-effective-policy.db.test.ts',
      // #4556 W7-1a-M (ratified per #4556 comments 5293034619 + 5293478713): the DB half
      // of the provenance-widening derive-and-diff. It reads the LIVE pg_constraint /
      // pg_proc catalogue and round-trips a w4_group row, so it needs real PostgreSQL.
      // Two-point wired: excluded from no-DB collection here, whole-file run in
      // plugin-tests.yml's attendance-real-db-integration step.
      'tests/integration/attendance-w7-1am-provenance-widening.db.test.ts',
      // #4556 W7-1b (ratified per #4556 comments 5293034619 + 5293478713): W7-R3
      // structural parity. Runs the REAL production legacy frozen-context builder
      // against real PostgreSQL over an eight-fixture corpus and compares the
      // serialized artifacts to vectors captured at the pre-1b base. Meaningless
      // without a database — the builder reads shift/segment/rule rows. Two-point
      // wired: excluded from no-DB collection here, whole-file run in
      // plugin-tests.yml's attendance-real-db-integration step.
      'tests/integration/attendance-w7-1b-legacy-arm-golden.db.test.ts',
      // #4556 W7-1b: the issuance seam and ruling-7's mirror controls. Boots a real
      // MetaSheetServer with the real plugin (so the seam under test is the one
      // activate() wired into production) and drives a real punch route. Needs real
      // PostgreSQL for the posture table, the W1 membership timeline and the
      // fixed-schedule effectiveness fixture. Two-point wired as above.
      'tests/integration/attendance-w7-1b-issuance-seam.db.test.ts',
      // #4556 W7-1b: the CUTOVER end-to-end suite. Boots a real MetaSheetServer,
      // walks the rollout state machine to `authoritative`, seeds a fully
      // effective fixed-shift group and drives a real punch route — the leg that
      // proves the mirror's outer fingerprint and the boundary's inner one AGREE
      // once both machines are on. Meaningless without real PostgreSQL.
      // Two-point wired: excluded here, whole-file run in plugin-tests.yml.
      'tests/integration/attendance-w7-1b-cutover-e2e.db.test.ts',
      // #4556 combined-soak shadow-diff FAMILY pins (transient partial-day
      // late_minutes_mismatch lifecycle + the pair-ladder all-equal contract).
      // Boots a real MetaSheetServer and drives the real punch route against a
      // W4-shadow org — meaningless without real PostgreSQL.
      // Two-point wired: excluded here, whole-file run in plugin-tests.yml.
      'tests/integration/attendance-soak-diff-families.db.test.ts',
      // Punch route's membership-derived org resolution (rules a-e). Boots a real
      // MetaSheetServer with the real plugin and drives the real punch route against
      // real `user_orgs` membership rows — meaningless without real PostgreSQL.
      // Two-point wired: excluded here, whole-file run in plugin-tests.yml.
      'tests/integration/attendance-punch-org-resolution.db.test.ts',
      // SHADOW audit of the same route's org resolution (env
      // ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1). Boots real MetaSheetServer instances (one
      // per env posture) with the real plugin and drives the real punch route against real
      // `user_orgs` membership rows and the real `attendance_org_resolution_shadow` table —
      // meaningless without real PostgreSQL.
      // Two-point wired: excluded here, whole-file run in plugin-tests.yml.
      'tests/integration/attendance-org-resolution-shadow.db.test.ts',
      // #4556 W7-1b: OD-W7-10(a)'s four-cell matrix at the recompute route.
      // Seeds prior COMPLETED calculations with specific `context_snapshot.selector`
      // values against real CHECK constraints and deferred triggers, walks the
      // rollout state machine per case, and drives the real route. Real PG only.
      'tests/integration/attendance-w7-1b-od-w7-10-recompute.db.test.ts',
      // #4556 W7-1b B9: the composite-lock re-census over the seven-producer
      // reality, with CONSTRUCTED two-connection races (a real 40P01 positive
      // control and the composed-order non-deadlock) plus T-M6's pg_locks
      // observation. Concurrency evidence is meaningless without real PostgreSQL.
      'tests/integration/attendance-w7-1b-lock-census.db.test.ts',
      // #4556 W7-4: read-side trace labeling. Boots a real MetaSheetServer with
      // the real plugin, drives real punches to persist group/legacy/shadow
      // calculations, and reads them back through the real decision-trace and
      // calculation-detail routes — including the T-K1 golden captured at the
      // pre-W7-4 base. Meaningless without real PostgreSQL. Two-point wired:
      // excluded from no-DB collection here, whole-file run in
      // plugin-tests.yml's attendance-real-db-integration step.
      'tests/integration/attendance-w7-4-read-side-labeling.db.test.ts',
      // #4556 W6-1 §7.2 fixture matrix: all eight committed aggregate fixtures are
      // reproduced from seeded rows against a dedicated disposable PostgreSQL database
      // with canonical FSER. Excluded from no-DB collection and whole-file wired below.
      'tests/integration/attendance-w6-group-effective-policy-fixture-matrix.db.test.ts',
      // #4556 W6-R5 membership-overlap counter: seeding a genuine overlap requires temporarily
      // dropping attendance_calc_group_memberships_no_overlap, so this suite runs against its
      // own dedicated ephemeral database rather than the shared metasheet_test one. Still
      // DATABASE_URL-gated (it derives its scratch connection from the same env var) and still
      // needs the two-point wiring: excluded here, whole-file run in plugin-tests.yml.
      'tests/integration/attendance-w6-group-effective-policy-membership-overlap.db.test.ts',
      // #4556 W7-1a: the group-policy posture/facts resolvers and the composite lock order.
      // Needs real PostgreSQL for every leg the ratification makes required — the ruling-7
      // persisted-row + exact-allowlist controls, the three P3-2 hard throws (each constructs
      // state the schema forbids inside a rolled-back transaction), the FOR SHARE membership
      // read, and above all the ruling-8 TWO-CONNECTION reverse-contention proof, which needs
      // the server's own deadlock detector to return 40P01. Excluded here so the no-DB job
      // cannot skip-green it; whole-file run in plugin-tests.yml's attendance step.
      'tests/integration/attendance-w7-1a-resolver.db.test.ts',
      // #4556 W7-2 (ratified per #4556 comments 5293034619 + 5293478713): the
      // compare-window exit-criteria counters. Seeds shadow-ledger rows against the
      // real CHECK matrix and the deferred segment-count trigger, and asserts
      // transaction-scoped read semantics (T-C8) — meaningless without real
      // PostgreSQL. Two-point wired: excluded from no-DB collection here,
      // whole-file run in plugin-tests.yml's attendance-real-db-integration step.
      'tests/integration/attendance-w7-2-compare-window-status.db.test.ts',
      // #4556 W7-2: the group_shadow dual-run produced-row legs. Drives the
      // production boundary factory with the plugin's real scheduled adapters and
      // the real core issuance seam over real PostgreSQL (posture rows, rollout
      // walks, FSER group fixtures, the dedup-partition probe). Two-point wired:
      // excluded from no-DB collection here, whole-file run in plugin-tests.yml's
      // attendance-real-db-integration step.
      'tests/integration/attendance-w7-2-group-shadow-dualrun.db.test.ts',
      // #4556 W7-3: the context-source TRANSITION boundary. Needs real PostgreSQL for every leg
      // that carries this slice's weight and cannot exist without a server: the 25-ordered-pair
      // sweep that proves the DB trigger's accepted set equals the imported TS constant (a text
      // comparison of the two files would pass on two identically-wrong lists), the trigger's
      // INSERT/bookkeeping/immutability clauses, the CHECK-vs-trigger exclusivity leg (which
      // DISABLEs the trigger to prove the constraint is a separate door), the plan reporter's
      // zero-write proof via `xmin`, the pg_locks observation of the session advisory lock, and
      // the TWO-CONNECTION serialization proof whose loser must see the version conflict.
      // Excluded here so the no-DB job cannot skip-green it; whole-file run in plugin-tests.yml's
      // attendance step and pinned in the CI wiring corpus.
      'tests/integration/attendance-w7-3-context-source-transition.db.test.ts',
      // #4556 W5 flex persistence and canonical writer proof requires real PostgreSQL;
      // the whole file is explicitly run in plugin-tests.yml.
      'tests/integration/attendance-shift-flex-policy-migration.db.test.ts',
      // OBS-1 completeness sweep (2026-08-07): the W3 shift-segments migration + writer-matrix
      // real-DB suites were ALREADY whole-file wired into the attendance real-DB step in
      // plugin-tests.yml, but these two exclude lines were missing (half-satisfied two-point
      // wiring) — so the no-DB job collected and skip-greened them every PR in addition to the
      // real run. Both points now present.
      'tests/integration/attendance-shift-segments-migration.db.test.ts',
      'tests/integration/attendance-shift-segments-writer-matrix.db.test.ts',
      // OBS-1 owner P1 (2026-08-08): the 加班银行 v1-5a settlement schema lock was the LAST file the
      // derived corpus still could not see — it was named `attendance-settlement-table-v1-5a.test.ts`
      // (outside the .db convention), carried by no run-list, and absent from this exclude, so the
      // no-DB job was the only job that ever collected it and its `if (!dbUrl) return` self-skip
      // green-passed there. Renamed to the .db convention, added to the attendance real-DB step's
      // run-list, and excluded here (two-point wiring); the guard's exclusion entry for it is gone,
      // so the completeness assertion now covers it like every other member.
      'tests/integration/attendance-settlement-table-v1-5a.db.test.ts',
      // #4556 W2 adds route-level work-date attribution legs to this whole-file real-DB
      // suite. Keep it out of the no-DB lane so describeDb cannot report skipped green;
      // plugin-tests.yml executes the complete file with ATTENDANCE_TEST_DATABASE_URL.
      'tests/integration/attendance-result-edit.test.ts',
      'tests/integration/attendance-comp-time-expiry-reminder.test.ts',
      'tests/integration/attendance-expiry-service.test.ts',
      'tests/integration/attendance-notification-deliveries.test.ts',
      'tests/integration/attendance-outdoor-punch.test.ts',
      'tests/integration/attendance-plugin.test.ts',
      'tests/integration/attendance-schedule-dispatch.test.ts',
      'tests/integration/attendance-shift-swap.test.ts',
      'tests/integration/attendance-unscheduled-reminder.test.ts',
      // OBS-1 completeness sweep (2026-08-07): four more non-.db attendance suites in the same
      // half-wired state — every describe in each is describeDb-gated (verified: no ungated
      // describe blocks), each is ALREADY whole-file wired into a real-DB step in
      // plugin-tests.yml (csv-export-bom in the approval step; the other three in the
      // attendance step), but these exclude lines were missing, so the no-DB job collected and
      // skip-greened them every PR. Both points now present; zero coverage moves — the same
      // required `test` job still runs every one of them, with a database.
      'tests/integration/attendance-csv-export-bom.test.ts',
      'tests/integration/attendance-files-acl.test.ts',
      'tests/integration/attendance-import-template-prefs.test.ts',
      'tests/integration/attendance-makeup-punch-policy.test.ts',
      // comment-reactions.api.test.ts needs setup.integration.ts + a live DB (real
      // MetaSheetServer on an ephemeral port + rbacGuard). It is excluded from the
      // default unit run HERE but wired as a WHOLE FILE into the dedicated
      // `Run comment-reaction keystone` step in plugin-tests.yml, where it runs
      // against real Postgres every PR — the B6 keystone (add/aggregate/idempotent
      // re-add/self-scoped DELETE/reader-deny 403/cascade) is no longer invisible debt.
      'tests/integration/comment-reactions.api.test.ts',
      'tests/integration/multitable-oapi1-comments-read-realdb.test.ts',
      // D-1 delete-revision parity goldens: real Postgres only (describeIfDatabase would merely
      // skip-green here, re-opening the "real-DB spec silently skips in the no-DB lane" hole) —
      // whole-file wired into `Run multitable real-DB integration` in plugin-tests.yml.
      'tests/integration/multitable-d1-delete-revision-parity-realdb.test.ts',
      // D-1c §0.6 HISTORY_INCOMPLETE precheck goldens (G-HI-1..4 + HI-5): real Postgres only
      // (describeIfDatabase would skip-green in the no-DB lane) — whole-file wired into
      // `Run multitable real-DB integration` in plugin-tests.yml. Two-point wiring: BOTH points
      // or the file silently never runs.
      'tests/integration/multitable-history-incomplete-precheck-realdb.test.ts',
      // W0-1 (#4269, design-lock §6 owner ruling 2026-07-14; corrected in-place by the doc-only 8d65a2a35
      // follow-up): generation-aware history contiguity goldens — replaces the live-vs-latest §0.6
      // comparator above with a per-generation occupancy proof (every version in [genStart..liveVersion] is
      // occupied by exactly one canonical chain event: a create/update revision OR a lock/unlock marker;
      // delete revisions reuse the last live version and are excluded from the count). Real Postgres only
      // (describeIfDatabase would skip-green in the no-DB lane) — excluded HERE so the no-DB job cannot
      // skip-green it, and whole-file wired into `Run multitable real-DB integration` in plugin-tests.yml.
      // Two-point wiring: BOTH points or the file silently never runs.
      'tests/integration/multitable-history-contiguity-realdb.test.ts',
      // W0 target-generation/floor strict comparator: DATABASE_URL-gated. Keep it out of the no-DB
      // default lane and pin its existing whole-file multitable real-DB invocation in the shared
      // exact-anchor wiring contract, so this suite cannot collect-and-skip-green.
      'tests/integration/multitable-history-contiguity-strict-seq-realdb.test.ts',
      // W0 L6-b exact-anchor authority goldens: DATABASE_URL-gated and meaningful only against real
      // Postgres. Exclude from the no-DB default lane so it cannot skip-green, and keep the whole file
      // wired into `Run multitable real-DB integration` in plugin-tests.yml. The no-DB wiring contract
      // pins both points.
      'tests/integration/multitable-exact-anchor-recovery-realdb.test.ts',
      // W0 L7 exact-anchor recovery-plan goldens: DATABASE_URL-gated and meaningful only against real
      // Postgres. Exclude from the no-DB default lane so it cannot skip-green; the shared exact-anchor
      // CI wiring contract pins this entry and its whole-file multitable real-DB invocation.
      'tests/integration/multitable-exact-anchor-recovery-plan-realdb.test.ts',
      // W0 L8 exact-anchor destructive-apply goldens: DATABASE_URL-gated and meaningful only against real
      // Postgres (constructed lock races, trigger-injected rollback, real advisory fence). Exclude from the
      // no-DB default lane so it cannot skip-green; the shared exact-anchor CI wiring contract pins this
      // entry and its whole-file multitable real-DB invocation.
      'tests/integration/multitable-exact-anchor-apply-realdb.test.ts',
      // W2 Express route wiring goldens: all four legacy revert/reset routes on L6/L7/L8,
      // including auth races and post-commit side effects. Real Postgres only; the shared
      // exact-anchor CI wiring contract pins both this exclusion and the whole-file CI entry.
      'tests/integration/multitable-exact-anchor-route-wiring-realdb.test.ts',
      // Time Machine closeout guard: per-subject authority leases. It is DATABASE_URL-gated and
      // pinned by the shared exact-anchor CI wiring contract.
      'tests/integration/multitable-recovery-authority-stability-realdb.test.ts',
      // O2-S3 lease-starvation backoff goldens (DATABASE_URL-gated; two-point wired via the
      // exact-anchor CI wiring contract).
      'tests/integration/multitable-recovery-lease-backoff-realdb.test.ts',
      // O2-S2 recovery-conflict classifier vs the REAL authority-trigger 40001 (DATABASE_URL-gated;
      // excluded here so the no-DB job cannot collect-skip-green it; two-point pinned via the
      // exact-anchor CI wiring contract).
      'tests/integration/recovery-conflict-classifier-realdb.test.ts',
      // TM-closeout slice goldens (DATABASE_URL-gated; two-point wired via the exact-anchor CI wiring contract).
      'tests/integration/multitable-recovery-authority-unavailable-failclosed-realdb.test.ts',
      'tests/integration/multitable-recovery-foreign-fence-availability-realdb.test.ts',
      'tests/integration/multitable-automation-marker-anchor-realdb.test.ts',
      'tests/integration/multitable-dh1-link-writer-fence-realdb.test.ts',
      // D-1c W0 slice ① (form-submit CREATE/EDIT public-form revision goldens): real Postgres only
      // (installs scoped failure/suppression triggers per site and drives the real submit route
      // end-to-end) — excluded HERE so it cannot skip-green in the no-DB lane, whole-file wired into
      // `Run multitable real-DB integration` in plugin-tests.yml.
      'tests/integration/multitable-d1c-form-submit-revision-realdb.test.ts',
      // D-1c W0 slice ② (plugin-SDK createRecord/patchRecord revision goldens + the concurrent-delete
      // P1 fix golden, which uses a genuine two-connection Postgres lock race via
      // `poolManager.get().getInternalPool().connect()`): real Postgres only — excluded HERE so it cannot
      // skip-green in the no-DB lane, whole-file wired into `Run multitable real-DB integration` in
      // plugin-tests.yml.
      'tests/integration/multitable-d1c-plugin-revision-realdb.test.ts',
      // D-1c W0 slice ③ (automation create_record/update_record revision goldens, driven through the
      // real AutomationService.executeRule entry point + the concurrent-delete zero-row fail-closed
      // golden, which uses a genuine two-connection Postgres lock race via
      // `poolManager.get().getInternalPool().connect()`): real Postgres only — excluded HERE so it cannot
      // skip-green in the no-DB lane, whole-file wired into `Run multitable real-DB integration` in
      // plugin-tests.yml.
      'tests/integration/multitable-d1c-automation-revision-realdb.test.ts',
      // #4196 Class-A same-transaction idempotency claim goldens (replay no-op for create/update, crash
      // rolls the claim back, flag-OFF positive control), driven through the real
      // AutomationService.executeRule entry point (constructor hard-wires deps.transaction to a real
      // poolManager.get().transaction). Real Postgres only — excluded HERE so it cannot skip-green in the
      // no-DB lane, whole-file wired into `Run multitable real-DB integration` in plugin-tests.yml.
      'tests/integration/multitable-4196-classa-claim-realdb.test.ts',
      // D-1c W0 slice ④ (approval resultWriteback revision goldens, driven through the real
      // dispatchAction -> approval.completed event bus -> AutomationService.handleApprovalCompletionEvent
      // -> writeApprovalResultBack chain + the concurrent-delete zero-row fail-closed golden, which uses a
      // genuine two-connection Postgres lock race via `poolManager.get().getInternalPool().connect()`):
      // real Postgres only — excluded HERE so it cannot skip-green in the no-DB lane, whole-file wired
      // into `Run multitable real-DB integration` in plugin-tests.yml.
      'tests/integration/multitable-d1c-approval-revision-realdb.test.ts',
      // D-1c W0 slice ⑤ (FINAL) (attachment-delete cell-strip revision goldens, driving the real
      // DELETE /attachments/:attachmentId route end-to-end + the zero-row RETURNING fail-closed
      // concurrent-delete golden, simulated via a scoped BEFORE UPDATE suppression trigger — a genuine
      // two-connection race is impossible here, the branch already holds a same-txn row lock): real
      // Postgres only — excluded HERE so it cannot skip-green in the no-DB lane, whole-file wired into
      // `Run multitable real-DB integration` in plugin-tests.yml.
      'tests/integration/multitable-d1c-attachment-revision-realdb.test.ts',
      // 4c-2 forward tombstone-capture cluster (design-lock #3809+#3830, owner-ratified 2026-07-08) — four
      // sibling realdb specs swept into the exclude list as the same remediation class as the two W0 entries
      // below/above (post-merge review of #4279): all four are describeIfDatabase-gated and were ALREADY
      // whole-file wired into `Run multitable real-DB integration` in plugin-tests.yml, but missing from
      // this list — so the no-DB job silently COLLECTED and skip-greened them. Two-point wiring: BOTH
      // points or the no-DB lane reports them as green-with-zero-assertions.
      // Field-delete capture point (G1 values/links/auto-number captured + causal anchor, G2 flag-off
      // byte-identical `before`, G3 over-cap 422 atomic refusal), driving dropFieldCascade end-to-end.
      'tests/integration/multitable-tombstone-field-capture-realdb.test.ts',
      // R1 rehydration on field UNDELETE (G4 values/links/auto-number rehydrate + field_permissions masking
      // unchanged, G5 no-tombstone stays definition-only), driving config-restore-execute end-to-end.
      'tests/integration/multitable-tombstone-field-rehydrate-realdb.test.ts',
      // Record-delete capture point (G2 record half flag-off zero rows, G7 inbound-only edge capture,
      // G10 version-conflict refusal before any capture), driving deleteRecord end-to-end.
      'tests/integration/multitable-tombstone-record-capture-realdb.test.ts',
      // C6/G8 tombstone-table retention sweep (bounded batch, keep-days floor at
      // META_REVISION_RETENTION_MIN_DAYS, disabled-by-default zero rows touched).
      'tests/integration/multitable-tombstone-retention-realdb.test.ts',
      // P2 durable-delivery S1 (#4203 Layer 1 / #4239): additive outbox-schema + flag golden — real Postgres
      // only (checks the migration landed both tables, the status CHECK, FK cascade, defaults). Excluded HERE
      // so it cannot skip-green in the no-DB lane, whole-file wired into plugin-tests.yml. Two-point wiring.
      'tests/integration/multitable-automation-outbox-schema-realdb.test.ts',
      // action-idempotency ledger L1 schema golden — real-DB. Excluded HERE so it cannot skip-green
      // in the no-DB lane; whole-file wired into plugin-tests.yml. Two-point wiring.
      'tests/integration/multitable-action-applied-ledger-realdb.test.ts',
      // #4196 execution-scoped applied ledger foundation (§2.2 locked table + §2 Class-A claim +
      // §6.1 derived test-run root): real Postgres only — excluded HERE so it cannot skip-green in the
      // no-DB lane, whole-file wired into `Run multitable real-DB integration` in plugin-tests.yml.
      'tests/integration/multitable-automation-execution-ledger-realdb.test.ts',
      // #4196 Class-B outbound two-phase intent/outcome (§3 table + two-phase state machine + crash-flip +
      // status='pending' single-writer guard): real Postgres only — excluded HERE so it cannot skip-green in
      // the no-DB lane, whole-file wired into `Run multitable real-DB integration` in plugin-tests.yml.
      'tests/integration/multitable-automation-outbound-intent-realdb.test.ts',
      // FWB-1 slice ③ write_approval_form_values same-txn composition — real-DB. Two-point wiring.
      'tests/integration/multitable-fwb-write-action-realdb.test.ts',
      // FWB activation — production write_approval_form_values wiring (save gate + real trigger chain +
      // atomicity/net-once/fail-closed goldens): real Postgres only — excluded HERE so it cannot
      // skip-green in the no-DB lane, whole-file wired into `Run multitable real-DB integration` in
      // plugin-tests.yml. Two-point wiring.
      'tests/integration/multitable-fwb-activation-realdb.test.ts',
      // FWB-2 production write_approval_form_values mode:update (same-base/cross-base/lock/delete/
      // net-once/atomicity): real Postgres only — excluded HERE so it cannot skip-green in the no-DB
      // lane, whole-file wired into `Run multitable real-DB integration` in plugin-tests.yml.
      // Two-point wiring.
      'tests/integration/multitable-fwb-update-activation-realdb.test.ts',
      // approval attachment GC worker (TTL sweep + purge-intent drain) — real-DB. Two-point wiring.
      'tests/integration/approval-attachment-gc-realdb.test.ts',
      // attachment bind (form-freeze) + bucket reconciler — real-DB. Two-point wiring.
      'tests/integration/approval-attachment-bind-reconcile-realdb.test.ts',
      // attachment PRODUCTION pipeline (flag-gated boot mount + submit-txn bind + template-access +
      // auth-proxied download) over a booted server — real-DB. Two-point wiring (approval real-DB lane).
      'tests/integration/approval-attachment-pipeline-realdb.test.ts',
      // attachment scan_state + purge-intent storage_key unique upgrade path (real DB, isolated schema).
      // Two-point wiring — excluded HERE so it cannot skip-green in the no-DB lane.
      'tests/integration/approval-attachment-scan-purge-upgrade-migration.db.test.ts',
      // Lock-10 (S1) instance readability — canReadApprovalInstance, all 5 arms + org pin (G-S1-1,
      // G-S1-3, G-S1-6, G-S1-10, G-S1-11, G-S1-12 partial), real DB. Excluded here so
      // describeIfDatabase cannot skip-green it in the no-DB job; wired as a WHOLE FILE into the
      // standalone .github/workflows/approval-realdb-instance-readability-s1.yml lane, which arms
      // EXPECT_DB=1. As of #5095, also wired (whole file, no EXPECT_DB) into the required
      // plugin-tests.yml "Run approval real-DB integration" step — two lanes now collect it.
      'tests/integration/approval-instance-readability-s1.db.test.ts',
      // Lock-10 (S1) CONSUMER adoption — detail/history/metrics routes (G-S1-4, G-S1-5, G-S1-7),
      // real DB. Excluded here so describeIfDatabase cannot skip-green it in the no-DB job;
      // wired as a WHOLE FILE into ONLY the standalone
      // .github/workflows/approval-realdb-instance-readability-s1.yml lane, which arms
      // EXPECT_DB=1. Unlike its sibling above, this file was NOT added to #5095's
      // plugin-tests.yml run-list — it stays single-lane by design (PR #5095: "does not claim
      // S1 'consumer adoption' is required, only the S1 predicate itself").
      'tests/integration/approval-instance-readability-s1-consumers.db.test.ts',
      // writers-stamp-org (S1 closeout slice 1) — G-W2, the PLM mirror writer's ruled
      // zero-org derivation. Real DB. Excluded here so describeIfDatabase cannot skip-green it
      // in the no-DB job; wired as a WHOLE FILE into the standalone
      // .github/workflows/approval-realdb-org-writer-plm-mirror-s1.yml lane, which arms EXPECT_DB=1.
      'tests/integration/approval-org-writer-plm-mirror-s1.db.test.ts',
      // Lock-10 (S1) Migration B — ordered org_id backfill over the residual NULL platform rows
      // left by Phase 1 (classes 2/3, ordered, prefix-guarded), real DB. Excluded here so
      // describeIfDatabase cannot skip-green it in the no-DB job; wired as a WHOLE FILE into the
      // standalone .github/workflows/approval-realdb-org-backfill-b.yml lane, which arms
      // EXPECT_DB=1.
      'tests/integration/approval-instance-org-backfill-b.db.test.ts',
      // Lock-11 §10.3 gap-closer (seventh by-reference ruling, item 1) — org_id backfill over the
      // Migration-B->W1W2 NULL-row creation window, created_at-scoped, (i)-guarded (single-active-
      // org premise self-asserted, values-free FAIL-LOUD, idempotent, prefix-guarded). Real DB.
      // Excluded here so describeIfDatabase cannot skip-green it in the no-DB job; wired as a
      // WHOLE FILE into the standalone .github/workflows/approval-realdb-org-gap-closer.yml lane,
      // which arms EXPECT_DB=1.
      'tests/integration/approval-org-instance-gap-closer.db.test.ts',
      // Lock-11 §10 W-1/W-2 create-time org stamping — the shared arm-(a) derivation
      // (deriveApprovalInstanceOrgId) as wired into ApprovalProductService.createApproval,
      // gated end-to-end through BOTH real writers: POST /api/approvals (W-1) and the
      // multitable automation start_approval bridge (W-2). G-L11-0/1/2/3/10 + refusal
      // precedence. Real DB (boots a live MetaSheetServer + drives AutomationService.executeRule).
      // Excluded here so describeIfDatabase cannot skip-green it in the no-DB job; wired as a
      // WHOLE FILE into the standalone .github/workflows/approval-realdb-org-writer-w1w2-s1.yml
      // lane, which arms EXPECT_DB=1.
      'tests/integration/approval-org-writer-w1w2-s1.db.test.ts',
      // Lock-11 §10 W-4 attendance writer org stamping — upsertAttendanceApprovalInstance's
      // arm (f) validated-selector + arm (a) fallback derivation, gated end-to-end through the
      // real MetaSheetServer + plugin-attendance HTTP routes. G-L11-0/4/5/6/8/9/10 + (β)
      // migration-ordering tripwire. Real DB. Excluded here so describeIfDatabase cannot
      // skip-green it in the no-DB job; wired as a WHOLE FILE into the standalone
      // .github/workflows/approval-realdb-org-writer-w4-s1.yml lane, which arms EXPECT_DB=1.
      'tests/integration/approval-org-writer-w4-s1.db.test.ts',
      // Lock-11 §10 W-3 after-sales refund bridge writer — G-W3, the zero-org "write nothing"
      // derivation (D-2(d)), mirroring G-W2's PLM-mirror pin. Real DB. Excluded here so
      // describeIfDatabase cannot skip-green it in the no-DB job; wired as a WHOLE FILE into the
      // standalone .github/workflows/approval-realdb-org-writer-after-sales-w3-s1.yml lane,
      // which arms EXPECT_DB=1.
      'tests/integration/approval-org-writer-after-sales-w3-s1.db.test.ts',
      // Lock-10 (S2) approval_comments — create/list/edit/delete/mention-candidates, D3 write
      // widening, D2(b1) tombstone, HISTORY-TIMELINE arm (i) exclusion, G-S1-9 notify seam, real
      // DB. Excluded here so describeIfDatabase cannot skip-green it in the no-DB job; wired as a
      // WHOLE FILE into the standalone .github/workflows/approval-realdb-comments.yml lane, which
      // arms EXPECT_DB=1. As of #5095, also wired (whole file, no EXPECT_DB) into the required
      // plugin-tests.yml "Run approval real-DB integration" step — two lanes now collect it.
      'tests/integration/approval-comments.db.test.ts',
      // Lock-9 approver process attachments — relaxation migration ordering/rollback, bind atomicity
      // (cross-instance refusal, rowCount-equality rollback), staged uploader-only reads, process-
      // scoped caps, GC reuse, and the flag-OFF byte-for-byte no-op (G-12), real DB. Excluded here so
      // describeIfDatabase cannot skip-green it in the no-DB job; wired as a WHOLE FILE into the
      // standalone .github/workflows/approval-realdb-lock9-process-attachments.yml lane, which arms
      // EXPECT_DB=1. As of #5095, also wired (whole file, no EXPECT_DB) into the required
      // plugin-tests.yml "Run approval real-DB integration" step — two lanes now collect it.
      'tests/integration/approval-lock9-process-attachments-realdb.db.test.ts',
      // P2 durable-delivery S2-a claim engine / fence-CAS — real-DB constructed-concurrency (zombie/SKIP
      // LOCKED). Excluded HERE so it cannot skip-green in the no-DB lane; whole-file wired into
      // plugin-tests.yml. Two-point wiring.
      'tests/integration/multitable-automation-dispatcher-claim-realdb.test.ts',
      // P2 durable-delivery S2-b dispatch loop (registry + tick) — real-DB. Excluded HERE so it cannot
      // skip-green in the no-DB lane; whole-file wired into plugin-tests.yml. Two-point wiring.
      'tests/integration/multitable-automation-dispatch-loop-realdb.test.ts',
      // P2 durable-delivery S4-a producer atomic enqueue — real-DB (txn atomicity + fan-out + e2e tick).
      // Excluded HERE so it cannot skip-green in the no-DB lane; whole-file wired into plugin-tests.yml.
      'tests/integration/multitable-automation-outbox-enqueue-realdb.test.ts',
      // P2 durable-delivery S4-b/S5 activation seam + S7 crash-injection V-series — real-DB. Excluded
      // HERE so it cannot skip-green in the no-DB lane; whole-file wired into plugin-tests.yml.
      'tests/integration/multitable-automation-durable-activation-realdb.test.ts',
      // W0 tail (#4279, owner MUST-WRITE OD-6, design-lock §0.5 2026-07-13): field-undelete rehydration
      // revision goldens — proves `recreateFieldFromConfig`'s tombstone-value rehydration UPDATE bumps
      // `version` and emits a `recordRecordRevision` AT THE NEW version, same transaction, for every
      // rehydrated record (full post-write snapshot, shared batchId); a zero-row concurrent-delete emits no
      // ghost revision; and the real revert-preview route 200s afterward (the W0-1 contiguity + retained
      // content-projection positive control — this site was `history-integrity-precheck.ts`'s own DEFERRED
      // content-integrity gap before this fix). Real Postgres only (describeIfDatabase would skip-green in
      // the no-DB lane) — excluded HERE so the no-DB job cannot skip-green it, and whole-file wired into
      // `Run multitable real-DB integration` in plugin-tests.yml. Two-point wiring: BOTH points or the file
      // silently never runs.
      'tests/integration/multitable-tombstone-field-rehydrate-revision-realdb.test.ts',
      // D-2 side-door delete recoverability (#4004): real Postgres only (it installs scoped failure-
      // injection triggers and drives both side doors end-to-end) — excluded HERE so it cannot skip-green
      // in the no-DB lane, and whole-file wired into `Run multitable real-DB integration` in
      // plugin-tests.yml. Two-point wiring: BOTH points or the file silently never runs.
      'tests/integration/multitable-d2-sidedoor-delete-recoverability-realdb.test.ts',
      // Time Machine D2 archive-catalog, stale-pin cleanup, section-causality, operation-binding,
      // coverage-binding, key-registry, source-pin authority, object-receipt authority,
      // D2h crypto-registry, D2e durable writer-block, D3 legal-hold authority, and D5 durable
      // restore-job proofs:
      // DATABASE_URL-gated and whole-file wired into the multitable real-DB step so the no-DB
      // job cannot skip-green them.
      'tests/integration/multitable-recovery-archive-catalog-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-stale-pin-cleanup-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-section-causality-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-operation-binding-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-coverage-binding-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-key-registry-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-claim-anchor-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-source-pin-authority-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-object-receipt-authority-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-crypto-registry-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-writer-block-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-legal-hold-authority-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-restore-jobs-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-reconstruction-realdb.test.ts',
      // 4c-3 RB matrix: real Postgres only — whole-file wired into `Run multitable real-DB
      // integration` in plugin-tests.yml (describeIfDatabase alone would skip-green here).
      'tests/integration/multitable-undelete-inbound-replay-realdb.test.ts',
      'tests/integration/multitable-undelete-pit-inbound-replay-realdb.test.ts',
      // 4c-3 §7 R8 absorption-audit hardening (P3-1/P3-2): PIT-resurrect inbound-replay anchor
      // heuristic goldens + PIT-reset inline-delete inbound-capture goldens. Real Postgres only —
      // whole-file wired into `Run multitable real-DB integration` in plugin-tests.yml.
      'tests/integration/multitable-undelete-inbound-resurrect-realdb.test.ts',
      'tests/integration/multitable-reset-pit-inbound-capture-realdb.test.ts',
      // T8-1 Revert-to-T real-DB goldens, including the retention compatibility/no-oracle contract.
      // Whole-file wired into `Run multitable real-DB integration`; exclude here so DATABASE_URL
      // gating cannot report skip-shaped green in the default no-DB lane.
      'tests/integration/multitable-revert-pit-realdb.test.ts',
      // T8-2 Reset-to-T goldens (flag-off/on, PIT-2 all-or-nothing, delete-set divergence including the
      // docket #46 capture-complete deleteScopeHash-mismatch golden, single-txn atomicity, D2 gate): real
      // Postgres only. Was ALREADY whole-file wired into `Run multitable real-DB integration` in
      // plugin-tests.yml but MISSING from this list (same pre-existing-gap class the 4c-2 tombstone
      // cluster comment above documents) — so the no-DB job silently COLLECTED and skip-greened it.
      // Two-point wiring: BOTH points or the no-DB lane reports it green-with-zero-assertions.
      'tests/integration/multitable-reset-pit-realdb.test.ts',
      // W6 full-HTTP-path approve->resume seam: mounts authRouter + approvalsRouter on an
      // ephemeral port against real Postgres, so it is excluded from the default run and wired
      // into the dedicated `Run multitable real-DB integration` job in plugin-tests.yml.
      'tests/integration/multitable-automation-start-approval-http.test.ts',
      // W6 form-submit -> start_approval operator-smoke seam: DATABASE_URL-gated and
      // wired as a WHOLE FILE into the `Run multitable real-DB integration` job in
      // plugin-tests.yml, so it runs against real Postgres instead of skip-greening here.
      'tests/integration/multitable-form-submit-start-approval-smoke.test.ts',
      // T2-6 event-driven dedup ledger: DATABASE_URL-gated. Excluded from the no-DB default job so it
      // does not skip-green, and wired as a WHOLE FILE into the `Run multitable real-DB integration`
      // job in plugin-tests.yml where it runs against real Postgres every PR.
      'tests/integration/multitable-event-dedup-trigger.test.ts',
      // T1-2 inbound webhook trigger: mounted-route + real-DB execution row. Excluded from the no-DB
      // default job so it does not skip-green, and wired as a WHOLE FILE into the multitable real-DB lane.
      'tests/integration/multitable-inbound-webhook-trigger.test.ts',
      // Audit B2 (2026-07-20): the outbound-webhook retry tick + durable-dedup suites are
      // describeIfDatabase-gated and ALREADY wired as WHOLE FILES into the `Run multitable real-DB
      // integration` step in plugin-tests.yml, but were missing from this exclude list — a
      // half-satisfied two-point wiring, so the no-DB default job COLLECTED and skip-greened them
      // (zero assertions, reported green). Both points are now present.
      'tests/integration/multitable-webhook-retry-tick.test.ts',
      'tests/integration/multitable-webhook-durable-dedup.test.ts',
      // R1 (DT-HARDEN-08 follow-up) dingtalk_group_deliveries retention sweep: DATABASE_URL-gated
      // (describeIfDatabase). Excluded from the no-DB default job so it cannot skip-green, and wired
      // as a WHOLE FILE into the `Run multitable real-DB integration` step in plugin-tests.yml where
      // it runs against real Postgres every PR.
      'tests/integration/dingtalk-group-delivery-retention.db.test.ts',
      // DT-HARDEN-08 follow-up (sibling of the above): dingtalk_approval_card_deliveries +
      // dingtalk_person_deliveries retention sweep. DATABASE_URL-gated (describeIfDatabase).
      // Excluded from the no-DB default job so it cannot skip-green, and wired as a WHOLE FILE
      // into the `Run multitable real-DB integration` step in plugin-tests.yml.
      'tests/integration/dingtalk-card-person-delivery-retention.db.test.ts',
      'tests/integration/dingtalk-card-delivery-retention-actionability.db.test.ts',
      // comments.api.test.ts needs setup.integration.ts + a live DB. It stays
      // CI-excluded (NOT wired) because 8 of its tests have a pre-existing real-wire
      // failure (CommentService.mapRowToComment drops containerId/targetId/
      // targetFieldId), tracked separately under its own opt-in fix. The reaction
      // keystone that used to live here moved to comment-reactions.api.test.ts.
      'tests/integration/comments.api.test.ts',
      'tests/integration/events-api.test.ts',
      // multitable-attachments.api.test.ts self-mocks its DB pool (no live DB needed) and its own
      // 12/12 pass standalone; it stays excluded here (unrelated to the comments.api.test.ts note
      // above) and is NOT wired into the real-DB job. Its F2 security-critical subset (attachment
      // download row-deny 404 / field-mask 403, #3973) is independently covered by a self-contained
      // real-DB file, tests/integration/multitable-attachment-readgate.security.test.ts, wired as a
      // WHOLE FILE into the `Run multitable real-DB integration` step in plugin-tests.yml — so F2
      // has a live CI regression guard even though this parent file remains excluded/unwired.
      'tests/integration/multitable-attachments.api.test.ts',
      // multitable-context.api.test.ts needs setup.integration.ts + a live DB (its template
      // catalog/install routes go through rbacGuard, which 403s under the default setup). It
      // stays excluded HERE but is now wired INTO the `Run multitable real-DB integration`
      // job (plugin-tests.yml), where it is green — so it is CI-covered, not invisible debt.
      'tests/integration/multitable-context.api.test.ts',
      'tests/integration/multitable-record-form.api.test.ts',
      // multitable-sheet-permissions.api.test.ts: 41 per-test SQL-string-matching MOCK handlers that have
      // DRIFTED — the record-context/view/delete-record routes now SELECT meta_records column-sets the mocks
      // don't match, so the handlers `throw new Error('Unhandled SQL')` → 500. Excluded HERE and NOT in the
      // real-DB job (unlike multitable-context.api above) — i.e. currently CI-invisible debt, made explicit here.
      // Robust restore = a real-DB conversion (drop the SQL mocks, like the other multitable real-DB goldens),
      // NOT re-patching 41 brittle mocks that re-drift on the next record-query change. Sheet-scoped permission
      // behavior is partly covered by multitable-permission-golden-d3d2 (real-DB, in CI); the write-own
      // owner-scoped row overrides + effective-access-from-direct/role/member-group specifics here are a
      // tracked coverage gap pending that conversion.
      'tests/integration/multitable-sheet-permissions.api.test.ts',
      'tests/integration/multitable-sheet-realtime.api.test.ts',
      // Six DB-gated specs (describeIfDatabase) that were previously NOT excluded here — meaning the
      // no-DB `test` job collected and skip-greened them (0 assertions ever executed) inside the
      // REQUIRED test (20.x) check, and no other workflow ran them for real either. Verified against a
      // real Postgres (CI's exact MIGRATION_EXCLUDE, no views/view_states dependency): 67/67 pass.
      // Excluded HERE so the no-DB job cannot skip-green them, and wired as WHOLE FILES into the
      // `Run multitable real-DB integration` step in plugin-tests.yml. Two-point wiring.
      'tests/integration/multitable-ai-write-provenance-batch-grouping-realdb.test.ts',
      'tests/integration/multitable-automation-branch-local-wait.test.ts',
      'tests/integration/multitable-cross-base-automation-delete-lock.test.ts',
      'tests/integration/multitable-crossbase-realtime-fanout.test.ts',
      'tests/integration/multitable-record-duplicate.test.ts',
      // T3-6 approval-record-as-multitable-record projection: writes directly onto meta_records (the
      // multitable substrate) via ApprovalRecordProjectionService.reconcile — multitable-relevant despite
      // the `approval-` filename prefix. Same DB-gated/never-run state and same two-point wiring as above.
      'tests/integration/approval-record-projection.test.ts',
      // P4 Option C repair proof constructs legacy partial writes against real Postgres and is wired
      // as a whole file in plugin-tests.yml. Keep it out of the no-DB default run so it cannot skip-green.
      'tests/integration/stock-preparation-p4-repair-once-realdb.test.ts',
      // multitable-view-config.api.test.ts uses an in-file MOCK pool (no live DB) and
      // self-contains its RBAC mocking — it runs under the default config + setup.ts, so
      // it stays IN the standard `test` job (runs on every PR, Node 18 + 20). Excluding it
      // here hid a #2052/#2068 redaction-wiring regression (4/7 RED) that no CI job caught.
      'tests/integration/plugin-failures.test.ts',
      'tests/integration/rooms.basic.test.ts',
      // Real-APP-ASSEMBLY guard: boots a real MetaSheetServer, so it is excluded from this no-DB default job
      // (which would skip-green it) and wired as a WHOLE FILE into the `Run real-app assembly guard` step in
      // plugin-tests.yml, where it runs on every PR. It guards an invariant that unit tests structurally
      // cannot see: no router mounted under /api may intercept traffic it does not own (a path-less
      // router.use in a router mounted at a shared prefix runs for EVERY request entering that router,
      // including other routers' traffic).
      'tests/integration/router-isolation.smoke.test.ts',
      // snapshot-protection boots a real server too, and its silent-return skips are gone (setup now
      // hard-fails and every test must assert), so it can no longer report green without doing its work.
      // It is still NOT wired into CI: the CI test database is migrated with MIGRATION_EXCLUDE, which omits
      // the view-table migrations (20250924120000_create_views_view_states, 20250925_create_view_tables,
      // 042a_core_model_views) — so `views` does not exist there and createSnapshot's captureViewState
      // cannot run. Wiring it requires untangling that excluded migration cluster, which is its own change;
      // until then this is DECLARED debt, not invisible debt. Run it locally against a fully-migrated DB.
      'tests/integration/snapshot-protection.test.ts',
      'tests/integration/spreadsheet-integration.test.ts',
      // #4783 owner review P1-1/P1-2: proves the BPMN timer poller write-gate (real
      // bpmn_timer_jobs outcome, not a mocked db) and the WAITING -> LOCKED atomic-claim
      // fix with a CONSTRUCTED real-Postgres race across two independent
      // `BPMNWorkflowEngine` instances. DATABASE_URL-gated; excluded here so the no-DB
      // default job cannot skip-green it, and wired as a WHOLE FILE into the
      // `Run BPMN timer job write-and-claim safety` step in plugin-tests.yml.
      'tests/integration/bpmn-timer-job-write-and-claim-safety.db.test.ts',
      // #4783 owner review batch 2: proves startProcess()'s entry gate leaves FOUR real
      // zeros (process/activity/incident/timer rows) — not "written then terminated" —
      // when a timer-bearing process is started with the poller disabled, driven through
      // the REAL HTTP surface (POST /api/workflow/deploy + POST /api/workflow/start/:key)
      // against a real booted MetaSheetServer + fresh-migrated scratch PostgreSQL, plus a
      // positive control that a timer-free process still starts normally. DATABASE_URL-
      // gated; excluded here so the no-DB default job cannot skip-green it, and wired as a
      // WHOLE FILE into the `Run BPMN startProcess poller-disabled zero-residue` step in
      // plugin-tests.yml.
      'tests/integration/bpmn-poller-disabled-startprocess-zero-residue.db.test.ts',
      // Recovery-authority schema drift A-vs-B floor: proves the hand-maintained constants in
      // scripts/ops/multitable-recovery-schema-containment.mjs still equal what the REAL
      // migrations (zzzz20260721121000_add_recovery_authority_locks.ts +
      // zzzz20260728120000_correct_recovery_authority_locks.ts) install, plus the subject_type
      // CHECK domain on record_permissions/field_permissions the helper does not fingerprint.
      // DATABASE_URL-gated; excluded here so the no-DB default job cannot skip-green it, and
      // wired as a WHOLE FILE into the standalone .github/workflows/multitable-recovery-schema-drift.yml
      // lane (NOT plugin-tests.yml — that file is s6a sha256-pinned and kept byte-identical to main;
      // see the seven approval-realdb-*.yml lanes' headers). That lane
      // multitable-recovery-authority-*-realdb.test.ts files already run in).
      'tests/integration/recovery-schema-drift.db.test.ts',
      // Recovery-authority search-path shadow counterexample + mutation matrix: reproduces the
      // CVE-2018-1058-shaped shadow on a real migrated DB and proves zzzz20260821120000 defeats it
      // (schema-qualified calls + fixed SET search_path, each independently sufficient). Needs real
      // Postgres (two connections, a held exclusive lease, a shadow schema, a non-transactional
      // call-counter). DATABASE_URL-gated; excluded here so the no-DB default job cannot skip-green
      // it, and wired as a WHOLE FILE into the SAME standalone
      // .github/workflows/multitable-recovery-schema-drift.yml lane as the drift guard above (NOT
      // plugin-tests.yml — that file is s6a sha256-pinned and kept byte-identical to main).
      'tests/integration/recovery-authority-search-path.db.test.ts',
      // E-learning V0.1 L0-F3A content/assessment schema gate. Requires real PostgreSQL
      // (named composite FKs, CHECKs, append-only triggers). Excluded from the no-DB job
      // so a missing DATABASE_URL cannot skip-green it; wired as a WHOLE FILE into
      // plugin-tests.yml after db:migrate on the 20.x leg.
      'tests/integration/elearning-v01-content-assessment-schema.db.test.ts',
      'tests/integration/elearning-exam-attempt-item-migration.db.test.ts',
      // E-learning V0.1 watch-progress schema gate. Requires real PostgreSQL
      // (assignment/member/session/event/progress/evidence composite FKs,
      // CHECKs, append-only + point-in-time triggers). Excluded from the
      // no-DB job so a missing DATABASE_URL cannot skip-green it; wired as
      // a WHOLE FILE sibling of the content/assessment schema gate in
      // plugin-tests.yml after db:migrate on the 20.x leg.
      'tests/integration/elearning-v01-watch-progress-schema.db.test.ts',
      // E-learning V0.1 watch-progress service gate. Requires real PostgreSQL
      // (advisory xact lock, heartbeat credit, completion evidence). Excluded
      // from the no-DB job so a missing DATABASE_URL cannot skip-green it;
      // wired as a WHOLE FILE sibling of the content/assessment + watch-progress
      // schema gates in plugin-tests.yml after db:migrate on the 20.x leg.
      'tests/integration/elearning-watch-progress-service.db.test.ts',
      // E-learning V0.1 manual direct-assignment service gate. Requires real
      // PostgreSQL (idempotency, membership, course-head/version locks).
      // Excluded from the no-DB job so a missing DATABASE_URL cannot skip-green
      // it; wired as a WHOLE FILE sibling of the content/assessment + watch
      // gates in plugin-tests.yml after db:migrate on the 20.x leg.
      'tests/integration/elearning-direct-assignment.db.test.ts',
      // E-learning V0.1 course-publish service gate. Requires real PostgreSQL
      // (composite publish). Excluded from the no-DB job so a missing
      // DATABASE_URL cannot skip-green it; wired as a WHOLE FILE sibling of
      // the content/assessment + watch gates in plugin-tests.yml after
      // db:migrate on the 20.x leg.
      'tests/integration/elearning-course-publish.db.test.ts',
      // E-learning L4 credit-ledger authority. Requires real PostgreSQL for
      // effect identity, replay/hash conflicts, bucket locking, and balances.
      // Excluded from the no-DB job and wired as a whole-file post-migrate gate.
      'tests/integration/elearning-credit-ledger-authority.db.test.ts',
      // E-learning L4 credit-rule versioning and wallet authority. Requires
      // real PostgreSQL for two-connection serialization, migration drift,
      // immutable commands, membership isolation, and stable keyset reads.
      // Excluded from no-DB collection and wired whole-file post-migrate.
      'tests/integration/elearning-credit-rules-wallet.db.test.ts',
      // E-learning V0.1 exam service gate. Requires real PostgreSQL (start/
      // submit + advisory lock). Excluded from the no-DB job so a missing
      // DATABASE_URL cannot skip-green it; wired as a WHOLE FILE sibling of
      // the content/assessment + watch gates in plugin-tests.yml after
      // db:migrate on the 20.x leg.
      'tests/integration/elearning-exam-service.db.test.ts',
      // E-learning V0.1 learner assigned-course list gate. Requires real
      // PostgreSQL. Excluded from the no-DB job so a missing DATABASE_URL
      // cannot skip-green it; wired as a WHOLE FILE sibling of the
      // content/assessment + watch gates in plugin-tests.yml after
      // db:migrate on the 20.x leg.
      'tests/integration/elearning-learner-courses.db.test.ts',
      // E-learning L1 normalized scope/access gate. Requires real PostgreSQL
      // for immutable revisions plus same-org/same-parent/XOR/RESTRICT FKs.
      // Wired as a whole file into plugin-tests.yml after db:migrate.
      'tests/integration/elearning-scope-access.db.test.ts',
      // E-learning L2 batch assignment + target-snapshot migration gates.
      // Both require real PostgreSQL and are wired as whole-file arguments
      // into plugin-tests.yml after db:migrate on the 20.x leg.
      'tests/integration/elearning-assignment-target-snapshot-migration.db.test.ts',
      'tests/integration/elearning-batch-assignment.db.test.ts',
      // E-learning L2 B1 assignment progress + explicit revocation. Requires
      // real PostgreSQL (advisory lock, UUID keyset, persistence preservation).
      // Excluded from the no-DB job so a missing DATABASE_URL cannot skip-green
      // it; wired as a WHOLE FILE sibling of the batch-assignment gate in
      // plugin-tests.yml after db:migrate on the 20.x leg.
      'tests/integration/elearning-assignment-lifecycle.db.test.ts',
      // E-learning V0.1 protected-playback service gate. Requires real
      // PostgreSQL (ticket/authorize). Excluded from the no-DB job so a
      // missing DATABASE_URL cannot skip-green it; wired as a WHOLE FILE
      // sibling of the content/assessment + watch gates in plugin-tests.yml
      // after db:migrate on the 20.x leg.
      'tests/integration/elearning-media-playback.db.test.ts',
      // E-learning L0 canonical role-template migration gate. Requires real
      // PostgreSQL (exact grants, idempotent repair, assignment-safe rollback).
      // Excluded from the no-DB job and wired as a WHOLE FILE into the same
      // post-migrate schema/service step in plugin-tests.yml.
      'tests/integration/elearning-role-templates.db.test.ts',
      // E-learning L0 plugin-owned jobs claim-lease gate. Requires real
      // PostgreSQL (UNIQUE identity, FOR UPDATE SKIP LOCKED, fenced finalize).
      // Excluded from the no-DB job so a missing DATABASE_URL cannot skip-green
      // it; wired as a WHOLE FILE sibling of the schema/service gates in
      // plugin-tests.yml after db:migrate on the 20.x leg.
      'tests/integration/elearning-jobs.db.test.ts',
      // E-learning L2 training-plan version pinning. Requires real PostgreSQL
      // for same-org composite FKs, publish guards, immutable items, and the
      // append-only request ledger. Wired as a whole-file post-migrate gate.
      'tests/integration/elearning-training-plan.db.test.ts',
      // E-learning L2 atomic plan assignment. Requires real PostgreSQL for
      // same-org composite FKs, deferred completeness, concurrency, and
      // transaction rollback. Wired as a whole-file post-migrate gate.
      'tests/integration/elearning-training-plan-assignment.db.test.ts',
      // E-learning L2 delegated administration + object collaboration ACL.
      // Requires real PostgreSQL for same-org FK chains, recursive directory
      // scope evaluation, closed actions, and one-way historical revocation.
      // Wired as a whole-file post-migrate gate in plugin-tests.yml.
      'tests/integration/elearning-admin-access.db.test.ts',
      // E-learning L2 durable notification intent. Requires real PostgreSQL
      // for same-org FK isolation, concurrent source-key idempotency, and the
      // identity guard. Wired as a whole-file post-migrate gate.
      'tests/integration/elearning-notification-delivery.db.test.ts',
      // E-learning L2 notification claim-lease worker. Requires real PostgreSQL
      // (FOR UPDATE SKIP LOCKED, expired-lease reclaim, fenced finalize).
      // Excluded from the no-DB job so a missing DATABASE_URL cannot skip-green
      // it; wired as a WHOLE FILE sibling of the ledger gate in plugin-tests.yml
      // after db:migrate on the 20.x leg.
      'tests/integration/elearning-notification-worker.db.test.ts',
      // E-learning L3 question-bank + fixed-paper revision pinning. Requires
      // real PostgreSQL for same-org composite FKs, publish-time dense-order
      // validation, and published-paper immutability. Wired as a whole-file
      // post-migrate gate in plugin-tests.yml.
      'tests/integration/elearning-assessment-catalog.db.test.ts',
      // E-learning L3 paper-bound exam rules. Requires real PostgreSQL for
      // same-org paper binding, source XOR, rule checks, and publish/retire
      // immutability. Wired as a whole-file post-migrate gate.
      'tests/integration/elearning-paper-exam.db.test.ts',
      // E-learning L3 manual-grading schema preparation. Requires real
      // PostgreSQL for state checks, same-org FKs, partial unique indexes,
      // append-only records, and guarded rollback. Wired as a whole-file
      // post-migrate gate in plugin-tests.yml.
      'tests/integration/elearning-manual-grading-schema.db.test.ts',
      'tests/integration/elearning-manual-grading-service.db.test.ts',
      'tests/integration/elearning-manual-grading-read.db.test.ts',
      // E-learning V0.1 M1 media quota reservation. Requires real PostgreSQL (advisory-lock
      // race). Excluded from the no-DB job so a missing DATABASE_URL cannot skip-green
      // it; wired as a WHOLE FILE into plugin-tests.yml after Start Postgres + db:migrate.
      'tests/integration/elearning-media-quota.db.test.ts',
      // E-learning V0.1 M1 media stale-row claim. Requires real PostgreSQL (FOR UPDATE
      // SKIP LOCKED across two connections). Excluded from the no-DB job so a missing
      // DATABASE_URL cannot skip-green it; wired as a WHOLE FILE into plugin-tests.yml
      // after Start Postgres + db:migrate (same step as the quota suite).
      'tests/integration/elearning-media-reconciler.db.test.ts',
      // Playwright E2E suites run through their own harness, not Vitest.
      'tests/e2e/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      thresholds: {
        lines: 50,
        statements: 50,
        branches: 40,
        functions: 50
      },
      exclude: [
        'node_modules/**',
        'tests/**',
        '*.config.ts',
        'src/server.js' // Mock server
      ]
    },
    testTimeout: 30000, // Increased timeout for better stability
    hookTimeout: 15000,
    setupFiles: ['./tests/setup.ts'],
    // Better error handling and debugging
    reporter: ['verbose'],
    maxConcurrency: 1, // Reduce concurrency for stability
    globalTeardown: './tests/globalTeardown.ts'
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests')
    }
  }
})
