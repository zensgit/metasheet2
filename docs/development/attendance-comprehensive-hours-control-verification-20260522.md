# Attendance Comprehensive Working Hours Control Verification

Date: 2026-05-22
Branch: `codex/attendance-comprehensive-hours-rfc-20260522`
Scope: docs-only RFC. No runtime code, migration, route, UI, test, staging, or production operation.

## Files

| File | Purpose |
| --- | --- |
| `docs/development/attendance-comprehensive-hours-control-rfc-20260522.md` | Product/technical RFC and staged PR roadmap for comprehensive working-hours control. |
| `docs/development/attendance-comprehensive-hours-control-verification-20260522.md` | This verification note. |

## Boundary Verification

| Boundary | Result |
| --- | --- |
| Runtime code | PASS: no plugin, backend, frontend, script, or test file changed. |
| Migration | PASS: no migration file added or modified. |
| `attendance_*` fact writes | PASS: no runtime writer added. |
| Direct `meta_*` writes | PASS: no runtime writer added. |
| Multitable writes | PASS: no report object or sync writer added. |
| Advanced scheduling write paths | PASS: RFC explicitly keeps grid edit, Excel import, copy/paste, temporary shifts, and dispatch out of scope. |
| Data Factory / Bridge Agent | PASS: not mentioned as an implementation target and no files in those domains changed. |
| Strong save blocking | PASS: explicitly deferred until customer opt-in or GATE decision. |

## RFC Cross-Checks

| Check | Result |
| --- | --- |
| DingTalk benchmark linkage | PASS: RFC starts from `综合工时制` gap identified in the advanced-scheduling research, not from generic scheduling write-path work. |
| Planned vs actual separation | PASS: planned scheduled minutes and actual attendance minutes are defined as separate metric producers. |
| Existing MetaSheet anchors | PASS: RFC maps to rule sets, effective calendar, payroll cycles, period summaries, and advanced scheduling read-only workbench. |
| Safe first runtime step | PASS: first runtime work is helper calculation and read-only preview, not enforcement. |
| Review contract | PASS: future runtime PRs have an explicit independent-review checklist. |
| Test roadmap | PASS: PR1 through PR6 test responsibilities are enumerated. |

## Commands

The staged verification for this docs-only slice is:

```bash
git diff --cached --check

git diff --cached | rg -n "<standard secret and local-path patterns>" || true
```

Runtime tests are intentionally not applicable for this slice because no runtime files changed. The RFC lists the runtime test matrix that future implementation PRs must run.

## Expected Result

| Check | Expected |
| --- | --- |
| `git diff --cached --check` | Exit 0 |
| staged secret/home-path scan | 0 matches |
| runtime tests | Not run; not applicable to docs-only PR |

## Follow-Up

If this RFC is accepted, the next implementation slice should be PR1: pure calculator helpers for period resolution, planned-minutes aggregation, actual-minutes aggregation, and cap comparison. That PR should request independent review before merge because it defines the semantics that later weak/strong control will reuse.
