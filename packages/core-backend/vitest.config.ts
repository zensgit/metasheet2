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
      'tests/integration/approval-p1c-field-permissions.api.test.ts',
      'tests/integration/approval-wp-add-reduce-sign.api.test.ts',
      'tests/integration/approval-direct-manager.api.test.ts',
      'tests/integration/approval-postgate-acceptance.api.test.ts',
      // Template authoring + version-restore real HTTP/DB acceptance. Excluded from the no-DB
      // default job so describeIfDatabase cannot skip-green it; wired as a whole file in the
      // approval real-DB workflow step.
      'tests/integration/approval-template-authoring-uat.api.test.ts',
      'tests/integration/dept-head-sync-plumbing.test.ts',
      // DT-HARDEN-02 orphan guard (real DB): proves the admission SAVEPOINT rolls back a users
      // INSERT when the bind throws after it. DATABASE_URL-gated; excluded here so the no-DB job
      // cannot skip-green it, and wired as a WHOLE FILE into the approval real-DB step.
      'tests/integration/directory-sync-admission-orphan-guard.db.test.ts',
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
      // 4c-3 RB matrix: real Postgres only — whole-file wired into `Run multitable real-DB
      // integration` in plugin-tests.yml (describeIfDatabase alone would skip-green here).
      'tests/integration/multitable-undelete-inbound-replay-realdb.test.ts',
      'tests/integration/multitable-undelete-pit-inbound-replay-realdb.test.ts',
      // 4c-3 §7 R8 absorption-audit hardening (P3-1/P3-2): PIT-resurrect inbound-replay anchor
      // heuristic goldens + PIT-reset inline-delete inbound-capture goldens. Real Postgres only —
      // whole-file wired into `Run multitable real-DB integration` in plugin-tests.yml.
      'tests/integration/multitable-undelete-inbound-resurrect-realdb.test.ts',
      'tests/integration/multitable-reset-pit-inbound-capture-realdb.test.ts',
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
