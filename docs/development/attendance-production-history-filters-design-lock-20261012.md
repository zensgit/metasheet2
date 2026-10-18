# Attendance production history filters regression — 2026-10-12

## Frozen scope

Base: `8b2213f1fad87569d8c89497e60ef6c062dafc36`.
Branch: `codex/attendance-production-history-filters-20261012`.
Owner authorized this local script regression fix; independent review belongs to parent.

The reproduced synthetic Strict flow returns to Overview, then times out filling
`#attendance-from-date` because `details[data-attendance-history-filters]` is collapsed.
Assume the existing details/summary UI contract; preserve its default collapsed state.
No UI changes, locale assertions or new helper module. Browser/DB qualification is limited to the owner-authorized wholly synthetic isolated runtime. Public PR, merge and deployment are separate decisions.

## Minimal implementation

Export a helper from the production verification script. Before filling history
fields after returning to Overview, wait for the details to be visible, inspect
its `open` property, and click its visible summary only when closed. Recheck
`open` after the click; a closed result must throw the fixed values-free code
`ATTENDANCE_HISTORY_FILTERS_NOT_OPEN`. Missing details errors propagate.
Guard the main entry using `pathToFileURL` so direct test imports never run the flow.
Add the focused Node test command alongside existing workflow commands, retaining
all neighbors. Only the four owner-specified files are deliverable edits.

## Gates

| Gate | Required evidence |
| --- | --- |
| Closed details | Real helper clicks visible summary once and opens |
| Already open | Real helper performs no summary click |
| Ineffective click | Real helper rejects with fixed code |
| Missing details | Original locator failure propagates |
| Production wiring | Overview click → load → helper → history field fills |
| Import safety | Actual named import does not launch browser |
| Counterexample | Original source fails named-export linking before execution; restore exact bytes |
| Guard mutation | Ineffective-open guard disabled makes matching negative red; restore exact bytes |
| CI union | New focused command added, no existing commands removed |
| Whitespace | `git diff --check` succeeds |
| Quality | Focused plus neighbor tests and validate:all pass |
| Independent review | Separate reviewer checks final source/test/workflow |
| Browser reproduction | Real isolated production flow passes after helper repair |

Focused tests use the owner-provided Node 20 executable. Full quality gates,
synthetic fixture execution, PR/CI, and independent review remain parent work.

## Local implementation evidence

- Node 20 focused suite: 6/6 pass, zero skipped; restored-source rerun passed.
- Original-source counterexample: named-export module-link failure, no flow execution.
- Suppressing only the post-click rejection: ineffective-click negative failed;
  the other five tests passed. Fixed source restored byte-identically.
- CI union: removing the single added test command reproduces base workflow bytes.
- `git diff --check`: passed. No commit or push performed.
- Evidence and original/fixed source backups are under
  `artifacts/production-history-filters-20261012/` in the owned worktree.
- Real browser, DB, full quality, synthetic fixture, public PR/CI, and independent
  review are unexecuted here and remain parent responsibilities.
