# PLM BOM zero quantity filter - 2026-11-02

Source: `666b150f0d63edc70cc9b0cd12b0a3fe56ea14a0`  
Parent: `fd0ada49a093ffd51027b905123154f44f109e7c`  
Branch: `codex/plm-bom-zero-quantity-filter-20261102`

Ordinary Native BOM child input accepts numeric quantity 0 and persists it
without a positive-only constraint. The read/adapter path preserves that zero.
The existing shared filter converter used token || empty-string, which erased
numeric zero before substring matching. A quantity filter of "0" consequently
matched 10 but omitted 0.

Only the converter expression now preserves numeric zero explicitly:
`String(token === 0 ? token : token || '')`.
All other falsy conversion semantics remain, including false, null, undefined,
NaN and empty strings. No quantity, record, schema, API, provider or workflow
is rewritten. Inverse replacement restores the entire original 19682-byte
state module. Prior relationship dedup and applied-depth implementation bytes
remain unchanged.

Two finite public-composable regression cases were appended after the complete
21778-byte existing spec prefix. They describe table quantity0/10 matches,
quantity7 exclusion, tree matching paths and required ancestors, and synthetic
non-numeric falsy compatibility controls. The false/nan queries distinguish
this fix from a broader nullish-coalescing change. These controls do not imply
Native normally emits nonnumeric quantities.

Grok requested grok-4.7/medium. Literal CLI footer observed Grok4.7/xhigh;
backend deployment UNKNOWN. Author-report actual model/effort UNKNOWN remains
separate. Independent Sol requested gpt-6.1-sol/high, actual UNKNOWN, accepted
with blockers[]. Root copied the frozen author bytes without implementation
changes. Frozen six-member ZIP SHA256:
`342f57c481b7c7662402bf5c1a4c5374f3b53af892f72a83dadc5cb12fa5ce2e`.
Independent review SHA256:
`a9d1bcef24a1159d22395633e9a22554f53805e3f72060df79dadba7f3ab89d1`.

Full inverse, old-prefix and readonly-input byte checks and git diff --check
passed. Tests, types, lint, product imports, build, install, HTTP/PG, browser,
API, CI and product runtime: NOT_RUN. Old Draft6686 CI qualifies only its fixed
5e3b2372 head. This new source is local-only: no push, PR or CI.

N2 lease, every HOLD and all seven OPEN packages remain. This source plus this
single document consume this slice's commit scope. Later results belong in
external records/state or a separately authorized PR body. No merge,
deployment, production enablement, real notification or panel change follows.
