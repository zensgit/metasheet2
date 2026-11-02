# PLM BOM successful-load depth snapshot - 2026-11-02

Source commit: `0d1d6cced23baeec9644d5127892ab9226a3eff5`  
Parent: `e28acaf9409437a811f0befcae1518e686e405d4`  
Branch: `codex/plm-bom-applied-depth-tree-20261102`

The ordinary depth-3 tree ROOT-S-L and ROOT-A-B-S contains five relationship
records. Rebuilding global adjacency can otherwise attach the shallow L below
the clipped deep S, synthesizing a depth-4 row. Real relationship-ID dedup alone
does not prevent this because the five input relationships are distinct.

The composable now keeps a nullable applied depth. ProductView captures the
finite, floored, minimum-1 request depth before awaiting the existing getBom;
an invalid or empty depth input uses the existing DEFAULT_BOM_DEPTH=2. The same
captured value bounds the successful payload. Traversal retains frontier rows
and stops their descendants at that depth. Initial null preserves existing
composable callers that have no successful-load snapshot.

Changing the draft depth alone leaves the accepted tree unchanged. After await,
`result.items || []` is evaluated before either publication, then the captured
cap and items are assigned. Existing request or result-property-read failures
therefore retain both prior values through the existing catch. No request
generation mechanism, payload validator, fallback write, or new error handler
was introduced. Existing last-completion ordering remains.

The source change is limited to three state sites and two ProductView fragments.
Root reassembled the full View from those literal fragments; inverse replacement
restores all original 281151 bytes. Prior shared-relationship dedup, raw records,
quantities, sorting, filters, selection, collapse and existing consumers retain
their source bytes. No Native, adapter, provider, workflow or policy was changed.

Six finite composable regressions were appended after the complete existing
8313-byte spec prefix. They describe null callers, applied depths 3 and 2,
draft changes, an accepted depth-4 payload and cycle/path/quantity controls.
The duplicate L quantities 7/9 case checks first-occurrence retention; it is a
synthetic control. These tests do not execute ProductView requests or directly
assert every visible/filter/export consumer.

Grok requested model/effort: grok-4.7/medium. Literal CLI footer: Grok4.7/xhigh;
backend deployment ID UNKNOWN. Author report effort UNKNOWN remains separate.
Independent Sol requested gpt-6.1-sol/high, actual UNKNOWN, accepted with no
blockers. Root made no implementation changes to the frozen author bytes.

Frozen seven-member ZIP SHA256:
`2624e3d826765570a6e6e106d544d8dbdd1a32f4d10aba7a7d44e8cafa2925f9`.
Independent review SHA256:
`84a04bb41dc4f56df7000f9ea1a4a40ea2d1b28fffc86853043e180305da94d3`.
Static byte/inverse/prefix checks and git diff --check passed. One observed
Grok pre_tool_use hook timed out and was ignored; no global trace or host-idle
claim is made.

Tests, types, lint, product imports, build, install, HTTP/PG, browser and product
runtime: NOT_RUN. Prior Draft6686 CI qualifies its fixed 5e3b2372 head only.
This increment is local-only, with no new push, PR or CI. Its source and this
single document consume this slice's commit scope; later results belong in
external records/state or a separately authorized PR body.

N2 lease, all HOLD boundaries and all seven OPEN delivery packages remain.
No merge, deployment, product enablement, real notification or goal-panel
change is authorized by this static delivery.
