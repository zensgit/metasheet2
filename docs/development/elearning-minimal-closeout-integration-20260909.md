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

These results do not replace combined-tree real-DB, remote CI or staging acceptance.
Earlier parent evidence remains recorded in the installation and notification reports.

## Remaining acceptance gates

1. Finish #5579 exact-head remote CI, then reconcile then-current main without losing
   either workflow union. Main advanced to an unrelated automation change during review.
2. Run combined-tree installation/notification database gates in an isolated database.
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
