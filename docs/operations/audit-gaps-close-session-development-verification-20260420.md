# Audit Gaps Close — Session Development & Verification Report

Date: 2026-04-20 (late session)
Parent audit: PR #944 — `docs/operations/monthly-delivery-audit-20260420.md`
Preflight checklist applied: `docs/operations/poc-preflight-checklist.md`

## Goal going in

Close all four wiring gaps surfaced by the monthly audit. Each gap
corresponded to a recently-delivered feature where the backend and/or
frontend shipped but the user could not actually reach it.

| # | Feature | Severity | This session |
|---|---|---|---|
| 1 | Chart / Dashboard V1 | 404 on click | ✅ Merged (PR #946) |
| 2 | Automation logs / stats | Silent empty list | ✅ Merged (PR #947) |
| 3 | Field Validation Panel | Orphan + no API | ✅ Merged (PR #959) |
| 4 | Yjs frontend integration | Main-path change | ⚠️ Open for review (PR #960) |

## Execution mode

Gaps #3 and #4 were the hardest — they weren't pure wiring patches,
they needed actual feature work. I launched two **parallel** agent
sessions for those, each strictly scoped, with explicit "do not
merge" instructions on the riskier one (#4).

## Independent findings and why each matters

### Gap #3 — Field Validation Panel (PR #959, merged)

The nominal change was "wire the orphan panel to an API and a UI
mount point". The agent found a deeper bug along the way:

> The panel emits flat `{ type, value, message }` rules, but the
> engine reads nested `{ type, params: { value | regex | values },
> message }`.

If we had just wired the panel as-is and shipped, **every rule except
`required` would have been silently dropped** — not at save time, not
at read time, only when `validateRecord()` actually runs on a submit.
The user would set up "email must match a regex", click save, see
their rule persisted, submit an invalid value, and nothing would
reject it.

The fix adds `applyFieldValidationNormalisation` at the top of
`sanitizeFieldProperty` — a single bi-directional normalization pass
that runs on POST `/fields`, PATCH `/fields/:fieldId`, and every read
through `serializeFieldRow`. The frontend keeps the flat shape; the
backend normalizes to the engine's expected nested shape.

Regression guard: `tests/unit/field-validation-wiring.test.ts` with 5
HTTP-level round-trip cases (create → patch validation rules → get →
submit and verify enforcement). Previous `field-validation.test.ts`
suite was green through the bug because it tested the engine with
already-nested rules directly — never exercised the path from UI
through HTTP through DB through engine.

Why this matters beyond the immediate fix: **if the audit had only
grep'd for imports and declared the gap closed by wiring up an
`import`, we would have shipped broken validation tonight**. The
preflight checklist's item 1 (end-to-end real run) is what caught
this, via the required HTTP round-trip test the agent was asked to
write.

### Gap #4 — Yjs frontend (PR #960, OPEN — needs human review)

The agent successfully wired `useYjsDocument` + `useYjsTextField`
into `MetaCellEditor`'s text-cell path, behind a build-time
`VITE_ENABLE_YJS_COLLAB=true` flag. It also handled the graceful
fallback (2.5s connect timeout → back to REST) and dual-write
suppression (keyed on `recordId::fieldId`).

However, the agent honestly reported a **significant limitation that
we had not caught before**:

> Character-level CRDT merge is NOT shipped —
> `useYjsTextField.setText` does `delete(0,length); insert(0,new)`
> per keystroke (last-write-wins). Two concurrent editors will see
> replacement, not merge, until a follow-up diffs old/new into
> proper `insertAt` / `deleteRange` ops.

This contradicts one of the main promised properties of the Yjs
design (character-level merge for concurrent text edits). The current
wiring gives you:

- ✅ Real-time single-user sync across browser sessions
- ✅ Persistence / reconnect recovery
- ✅ REST fallback
- ❌ **True character-level CRDT merge between concurrent editors**

This is a caveat the user needs to see before we merge. The fix is
not trivial — it requires replacing `setText(newValue)` with a diff
algorithm that emits proper Y.Text operations. That's a follow-up PR
with its own test cases.

**Recommendation: do not merge #960 tonight.** The wiring itself is
clean, but the semantic gap between "wired up" and "actually
collaborative" is big enough to warrant a separate design pass. The
agent's own PR body flags this clearly.

## What I actually landed tonight

### PR #946 — Chart / Dashboard V1 wiring
- Mount `dashboardRouter()`, align paths (`/sheets/:sheetId/...`),
  align list shapes (`{charts}` / `{dashboards}` not `{items}`)
- 7 new supertest HTTP-level tests
- Merged

### PR #947 — Automation test/logs/stats wiring
- Mount `createAutomationRoutes()` with lazy service resolver
  (service initializes after route mount at server startup)
- Flatten response shapes (no `{ ok, data }` envelope)
- Fix key mismatch (`{ executions }` not `{ logs }`)
- 7 new supertest HTTP-level tests
- Merged

### PR #959 — Field Validation Panel wiring
- Bi-directional shape normalization in `sanitizeFieldProperty`
  (flat UI shape ↔ nested engine shape)
- Wire `MetaFieldValidationPanel` into `MetaFieldManager` for
  string/number/select fields
- 5 new HTTP-level wiring tests + 4 new frontend tests
- Merged

### PR #960 — Yjs frontend opt-in
- New `useYjsCellBinding` composable with flag gate + timeout +
  fallback
- `MetaCellEditor` binds text input to Y.Text when Yjs active
- `MetaYjsPresenceChip` rendered when collaborators detected
- Dual-write suppression in `MetaGridTable`
- 4 new frontend tests
- **Open, not merged.** Needs decision on LWW limitation.

## Aggregate test impact

Before tonight's session:
- Field validation engine + existing suite: 81 tests

After merging #946, #947, #959 (but excluding pending #960):
- + 7 dashboard wiring tests
- + 7 automation wiring tests
- + 5 field validation wiring tests
- + 4 field manager frontend tests
- = **+23 new tests**, all HTTP-level or end-to-end integration, all
  asserting the frontend ↔ backend contract that previous tests did
  not touch.

## Pattern observation

Every single audit gap closed this session had the same shape:
- Backend service layer: correct, fully unit-tested
- Route handler: defined but not mounted
- Frontend component: defined but not imported
- **Plus, in 2 of 4 cases, a subtle contract mismatch hidden beneath
  the wiring problem** (dashboard `{items}` vs `{charts}`; field
  validation flat vs nested rules)

The mechanical audit (import-chain grep) caught the structural gap
in all 4. But it would NOT have caught the hidden contract mismatches
— only the HTTP round-trip tests each fix added would. This argues
for making the preflight checklist item "end-to-end test against a
running server" a non-optional gate, not a suggestion.

## What's left

### Technical remainder

- **PR #960 decision**: merge with caveat, hold for LWW fix, or
  discard and build proper CRDT merge directly
- **Actual staging verification**: nothing we shipped tonight has
  been run against `http://142.171.239.56:8082` yet. Deploy main,
  click Dashboard, check View Logs, check field validation save, and
  confirm no regression.
- **Yjs true-CRDT follow-up**: diff-based Y.Text ops instead of
  `delete(0,length); insert(0,new)`

### Process remainder

- Consider codifying the preflight checklist as a required PR
  template section — "Has an HTTP-level round-trip test been added?"
  would have turned tonight's fixes from retrospective audit into
  a first-time catch.

## Artifacts

- Parent audit: PR #944
- Session summaries: PR #945, PR #949, this file
- Fixes merged: PR #946, PR #947, PR #959
- Pending review: PR #960 — see the PR body for the LWW limitation
  and reviewer guidance

## Honest framing

Four gaps identified this afternoon. Three closed cleanly with
regression guards. One (Yjs frontend) is in a state where the
mechanical wiring is correct but the semantic promise (character-level
merge) is only partially delivered. The right call is to make that
explicit via an open PR and a conversation, not to merge a "wired but
LWW" version and hope nobody notices.

That decision — merge with caveat vs wait for the proper CRDT patch
— is a product call. I have deliberately left it to the user.
