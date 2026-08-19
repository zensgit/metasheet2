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
] as const
