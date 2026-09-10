# Minimal classroom closeout: integration checkpoint

Scope: finish the existing online training loop and optional installation/notification
acceptance. No new L0-L6 features are implied or authorized by this closeout.

## Exact local integration

- Commit: `443f9ec41a2b1cbcbc006f3f2fb5965c0255f905`
- Tree: `0212c3b56bb588a7453090262e133894de0e38c0`
- First parent (installation #5579): `b858e3277d7b2c9559a91b394d48659544778d97`
- Second parent (notification #5572): `1e2e05222efa813ebdca16f7ab15bc71c1073ded`
- True local merge, original PR branches untouched. Only manual resolution was the
  official package provenance fingerprint. The merged workflow retains both parent
  test/script path sets with zero missing tokens.
- Official computed change: evidenceFiles.pluginTestsWorkflow only;
  frozen/live objects equal. No product edits in the integration.

## Combined-tree verification

- Backend unit: installation, notification dispatch/channel/events, reminder-port
  scoping and pilot runtime: 6 files / 59 tests passed.
- Core `tsc --noEmit` passed.
- Media, notification delivery and notification worker wiring: 25/25 passed.
- Full plugin-elearning package test chain passed.
- Full sealed-export S5 chain, including provenance positive control, passed.
- Diff check passed; local integration commit clean.

These results do not replace remote CI or staging acceptance.
Earlier parent evidence remains recorded in the installation and notification reports.

## Combined database closeout — 2026-09-10

- Tested exact code head `e134701a7e984856234d3b2a829229e649e16699`, which
  true-merges installation test-only fix `24453acc82d8218ca885862f226b374e3605174d`
  into the integration checkpoint. Original PR branches remain separate.
- PostgreSQL 15.17: no competing active client work observed before the run;
  a new isolated database was created for this verification.
- CI-exact MIGRATION_EXCLUDE stream: 395 migrations passed, second replay passed.
- Combined installation, notification-delivery and notification-worker whole files:
  3 files / 21 tests passed. This includes organization collision, opt-in admission,
  membership serialization, delivery fencing and worker eligibility coverage.
- Official scratch drain/drop: drained=true, forced=false, residualBackends=0;
  owned database prefix residue=0 and backend residue=0. DB window released.
- No live provider credentials or external sends were used. These are database
  authority tests, not staging notification receipt evidence.

## Remaining acceptance gates

Current-main replay checkpoint: `799d82704a392a8ba020803c5ad012f46d6ae8f2`
(tree `2eebdf5806969c12a6bef57b6a69276add6a56d9`) true-merges main
`1e6e138af0750062d7237b1dab88e80cb57d3745` locally. There were no conflicts
or manual product edits. Required-Web selectors are a superset of both parents;
official provenance differenceCount=0. Focused backend/security neighbors passed
9 files / 184 tests, core typecheck passed, and media/publication wiring passed
21/21. Final required-Web passed (last invocation: 441 files / 6116 tests),
and full Web typecheck passed.
The prior combined database proof remains pinned to `e134701a7`; it is not relabeled
as a fresh database run on this newer tree. No deployment/flag changes occurred.

### Independent review correction

The fresh read-only review found P1=0/P2=1/P3=0: the event collector could queue
new deliveries for an organization whose application or notification opt-in was off,
even though worker admission blocked sending. The collector now filters canonical
same-org active installation and exact JSON boolean opt-in before LIMIT.

The owning real-DB test covers missing installation, inactive installation, opt-out,
string lookalike and foreign tenant, followed by enabled positive and batch draining.
Removing the predicate returned inserted=1 instead of 0 (RED); restored combined
installation/delivery/worker suites passed 21/21. Fresh CI-exclude migration stream
and second replay passed on this fix; test fixture initially used a nonexistent name
column, corrected to canonical project_id before the final passing run. Scratch
drain was clean, forced=false, database/backend prefix residue=0. No external send.
Final independent re-review remains required before the authorized merge.

1. Installation #5579 exact `24453acc8` remote CI was verified on 2026-09-10:
   52 SUCCESS / 1 SKIPPED, no failure or pending. Reconcile then-current main and
   verify the final integration head without losing either workflow union.
2. Combined-tree database gates are complete at the exact head recorded above;
   repeat affected gates if the final integration changes their code or dependencies.
3. Obtain the remaining merge/environment authorization; no Ready or main merge has
   been performed by this checkpoint.
4. Deploy an approved exact candidate to staging only. Use a synthetic organization,
   dedicated test recipient, explicit notification cutoff and video storage credentials.
   Do not test notifications against real employees.
5. Verify uninstalled denial, install-inactive, explicit activation, enrollment,
   video challenge/progress, exam scoring/result readback, notification opt-in/off,
   and disable-with-data-retained. API task acceptance is not proof of actual receipt.
6. Record observed runtime version and results; only then declare staging acceptance.

No production changes, flags, real messages, storage provisioning or deployment were
performed. No additional capability is required to close this minimal scope.
