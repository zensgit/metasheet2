/**
 * Explicit, reviewable exemption list for `approval-ci-coverage-enumeration.test.ts` (the FAIL-0
 * enumeration guard). A file is exempt from the guard's coverage requirement IFF it is BOTH (a)
 * genuinely failing its tier's coverage rule AND (b) listed here with a real `why` — an allowlist
 * entry for an already-covered file is harmless but the guard warns on it (keeps this from turning
 * into a dump). This file is a typed const, not JSON/YAML, so the exemption is diff-visible and the
 * guard can assert each entry still points at a file that exists on disk.
 *
 * Seeding note: every entry below was produced by an ACTUAL guard run against a fresh
 * `origin/main` checkout (2026-08-19), not guessed. Do not hand-add an entry without first running
 * the guard and reading its failure message; do not remove an entry without first confirming (by
 * running the guard) that the file is now genuinely covered.
 */
export interface ApprovalCiCoverageAllowlistEntry {
  /** Path relative to the repo root, exactly as the guard reports it. */
  readonly file: string
  /** A real reason, not "n/a" — must explain why this specific file is deliberately unwired. */
  readonly why: string
  /** ISO date (YYYY-MM-DD) the entry was added or last reconfirmed. */
  readonly date: string
}

export const APPROVAL_CI_COVERAGE_ALLOWLIST: readonly ApprovalCiCoverageAllowlistEntry[] = [
  {
    file: 'apps/web/tests/approvalStaticPicker.spec.ts',
    why:
      'Genuinely RED on main today (5/7 tests fail: TypeError reading .value off a null pick() ' +
      'result) — already documented as deliberately excluded in run-required-web-tests.sh\'s own ' +
      '"19 pre-existing red files" note. Wiring a red file would break this gate\'s own ' +
      'green-on-arrival guarantee. Tracked under its own opt-in fix, not this slice.',
    date: '2026-08-19',
  },
  {
    file: 'apps/web/tests/approvalMobileDetailActions.spec.ts',
    why:
      'Genuinely RED on main today (3/11 tests fail + 2 unhandled render errors) — already ' +
      'documented in run-required-web-tests.sh\'s own "19 pre-existing red files" note. Same ' +
      'green-on-arrival rationale as approvalStaticPicker above.',
    date: '2026-08-19',
  },
  {
    file: 'apps/web/tests/approval-ui-workspace.spec.ts',
    why:
      'Genuinely RED on main today (1/4 tests fail: source-text assertion "presents template ' +
      'authoring as a four-step workspace" does not match TemplateAuthoringView.vue\'s current ' +
      'shape) — already documented in run-required-web-tests.sh\'s P7-R1 FAIL-0 sweep note as a ' +
      '"newly-found third red file", left for triage same as the pre-existing quarantine list.',
    date: '2026-08-19',
  },
  {
    file: 'packages/core-backend/tests/integration/approval-template-groups-backfill-down-guard.db.test.ts',
    why:
      'New real-DB test for a CANDIDATE, unratified guard (design MD §23 / migration ' +
      'zzzz20260919090000_create_approval_template_group_backfill_batches.ts down()) added by ' +
      'implementation-gate fix round `impl-gate-A3-guarded-down-round1-20260921.md` P2-1. That ' +
      'same round\'s task explicitly required `.github/workflows/plugin-tests.yml` and the s6a ' +
      'package-provenance pin to stay byte-identical this round (the guard itself is not merged, ' +
      'not applied to any shared/staging/prod database). Two-point wiring (vitest.config.ts ' +
      'exclude + plugin-tests.yml whitelist) plus this file\'s own `*-ci-wiring.test.mjs` guard ' +
      'and the s6a re-pin it would force are deferred to whichever round actually proposes ' +
      'merging the candidate guard, per that gate report\'s own P2-1 "修法" suggestion to do both ' +
      'in one commit rather than re-pin twice. Until then this file is `describeIfDatabase`-gated ' +
      '(same as every sibling backfill file) so the no-DB required job discovers-and-skips it, ' +
      'never runs it for real, and never goes red on it.',
    date: '2026-09-21',
  },
] as const
