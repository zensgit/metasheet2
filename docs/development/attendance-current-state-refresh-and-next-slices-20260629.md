# Attendance current-state refresh + next-slice proposal

> Date: 2026-06-29
> Baseline: `origin/main@3e349cf29` (`#3366`, BOM multi-table write-back loop closeout)
> Scope: docs-only refresh for returning to the attendance development line. This is a short operational ledger; it does not replace the long benchmark tracker
> `docs/development/attendance-dingtalk-benchmark-target-and-tracker-20260601.md`.

## 1. Why this refresh exists

The attendance line has moved through several parallel arcs since the last broad benchmark tracker update. Before opening another runtime slice, this note re-grounds the current state against `origin/main`, open PRs, and open issues so the next action does not start from a stale plan snapshot.

Verification inputs used for this snapshot:

- `git log origin/main --grep='attendance|overtime|makeup|anomaly|digest|report tier|team availability|cross-midnight'`
- `gh pr list --repo zensgit/metasheet2 --state open --search 'attendance OR overtime OR makeup OR anomaly OR digest OR 考勤'`
- `gh issue list --repo zensgit/metasheet2 --state open --search 'attendance OR overtime OR makeup OR anomaly OR digest OR 考勤'`
- targeted `git grep` over `plugins/plugin-attendance/index.cjs`, `packages/core-backend/tests`, and `apps/web/src/views/AttendanceView.vue`
- the closeout docs listed in §5.

## 2. Current main: closed lines

| Line | Current state on `origin/main` | Evidence |
|---|---|---|
| Annual leave / statutory annual leave | ✅ L0-L6 closed, including staging smoke | tracker §0.4 says L6 staging PASS with stamp `annual-l6-mqnv0lnv-f47084`; runtime/UI symbols are on main |
| H2/H2+/C5 benchmark waves | ✅ closed | tracker §0.1-§0.3 records multi-shift, publishing, temporary shift, overtime segmentation, A2 auto-write, C5 real work-notification delivery as staging-proven |
| #5 report tiering | ✅ closed | RT-0/RT-1/RT-1a landed; severe/absence late thresholds are live in settings and report meta |
| #6 team availability | ✅ TA-0/1/2/3 + TA-4 staging closed | tracker §0.5 records TA-4 PASS `ns4-ta4-mqro9by8` |
| #7 leave cancellation | ✅ closed | tracker §0.5 records design/runtime + real-DB proof; balance reversal shipped |
| #8 cross-midnight overtime | ✅ NS-0/1/2/3 + NS-4 staging closed | tracker §0.5 records one-midnight acceptance and NS-4 PASS |
| HMR manual missed-punch reminders | ✅ closed | `#3268`-`#3273` merged; runbook on main |
| SR self-service rules transparency | ✅ code closed; test debt closed | `#3277`-`#3284` merged; issue `#3302` is closed after follow-up coverage |
| RD report digest | ✅ config/preview + RD-3 producer closed | `#3275/#3281/#3282/#3283/#3313` merged; producer writes C5 outbox only, gated/default-off |
| MP makeup-punch policy runtime | ✅ runtime closed | `#3276/#3280/#3314` merged; issue `#3315` is closed after follow-up coverage |
| AE anomaly-result edit | ✅ AE-1 backend route closed | `#3274/#3316/#3318/#3322` merged; remaining durability item tracked in `#3317` |
| Overtime bank / 加班银行 facts engine | ✅ core facts + settlement mechanism closed | `attendance-overtime-bank-design-verification-20260624.md`: v1-1 through v1-6 and v1-5 settlement snapshot are landed; v1-5b-iii e2e proof landed |

## 3. Live open attendance items

### Open PRs

| PR | State | Recommendation |
|---|---|---|
| `#3303` — unconditional settings restore in v1-5b-iii must-pay e2e | OPEN, checks green at last run | **Review/merge first.** It is a one-file test hygiene fix: always restores `overtimeBankPolicy` after the must-pay e2e test so a global/org setting cannot leak into sibling attendance cases. Low risk and directly relevant to the overtime-bank test bed. |
| `#3013` — benchmark gap candidates | OPEN, stale docs branch from 2026-06-21 | **Supersede/close or reconcile manually.** Its purpose overlaps the newer tracker updates and this refresh. Do not merge as-is without rebase + drift review. |
| `#3048` — remaining benchmark development plan | OPEN, stale docs branch from 2026-06-22 | **Supersede/close or reconcile manually.** It predates HMR/SR/RD/MP/AE and overtime-bank follow-through; merging it now risks resurrecting stale remainder language. |

### Open issues

| Issue | State | Meaning |
|---|---|---|
| `#3317` — AE-1 corrected-fact durability future slice | OPEN / on-hold | The only open attendance product-development issue found in the current search. It records the future durability gap: an admin correction can be clobbered by later recompute paths that ignore the manual edit. |
| `#3302` — SR test-completeness follow-ups | CLOSED | Follow-up coverage has been landed; no longer a blocker. |
| `#3315` — MP test-coverage follow-ups | CLOSED | Follow-up coverage has been landed; no longer a blocker. |

## 4. Real remaining development, grouped by gate

### A. Ready to do after review: test hygiene

1. **Land `#3303` if re-review stays clean.**
   This is not a product slice, but it protects the overtime-bank integration suite from fixture pollution. It should precede new overtime-bank staging or payout work.

### B. Best next runtime slice: AE corrected-fact durability

**Recommended next design-lock:** `AE-1b corrected-fact durability`.

Why this is first:

- AE-1 has an admin-visible write route already on main.
- The known gap is not cosmetic: a later recompute path can overwrite a manual correction unless a sticky marker or closed-cycle/generalized freeze is honored.
- Issue `#3317` is already the canonical tracker and all other AE-1 review decisions are resolved.
- Building AE UI before this would expose a correction surface whose durability is still intentionally incomplete.

Proposed slice shape:

| Slice | Scope | Verification bar |
|---|---|---|
| AE-1b design-lock | Choose durability model: `meta.manual_result_edit` sticky flag honored by recompute paths vs broader closed-cycle/freeze generalization | docs-only, owner ratify |
| AE-1b runtime | Ensure import / auto-absence / approved-request recompute cannot silently clobber a corrected fact | real-DB tests: edit `late->normal`, then drive each recompute path and assert the correction survives or fails closed by policy |
| AE-2 | notify affected employee only | C5 outbox producer tests; no manager fan-out by default |
| AE-3 | UI modal for anomaly correction | web tests: reason/evidence, confirm snapshot, stale state clear, reload |
| AE-4 | staging smoke | owner/staging-gated |

### C. Valuable follow-up: MP admin UI + staging

MP-2/3 backend enforcement is done, but a customer needs a config surface to safely operate it.

Suggested next after AE durability, or parallel if a frontend owner is available:

- MP-4: admin policy card for quota/window/type/reason/attachment.
- MP-5: request UX copy/hints for blocked makeup requests.
- MP-6: staging smoke.

This is less risky than AE durability, but lower priority because MP is default-off and not exposed unless configured.

### D. RD staging / production enablement

RD-3 producer is default-off and writes C5 outbox only. The config card exists.

Next work is mostly operational:

- RD-4/5 staging smoke: enable env + policy on staging, run completed-period producer, assert C5 outbox rows, delivery worker behavior, and residue=0.
- No new sender should be added here; real sending remains the existing C5 worker/channel path.

### E. Overtime bank: staging and payout boundary

The four-ledger facts mechanism is built:

- overtime bank policy + source-tagged lots
- leave offset policy + deduction wiring
- full-attendance flag
- settlement snapshot-at-close
- UI cards
- must-pay e2e proof

Remaining work is gated by consumer/environment:

| Item | Gate | Recommendation |
|---|---|---|
| `v1-8` staging smoke | staging channel | Run only after `#3303` or equivalent test-restore hygiene is settled. |
| `v1-7` payout producer / payroll export | owner product decision | Open a fresh design-lock only when the payout consumer shape is known. Do not add event vocabulary or payout rows without a consumer. |

### F. Benchmark-surpass / humanization backlog

`docs/research/attendance-humanization-opportunities-20260622.md` is still useful, but several rows have since moved:

- HMR covers manual missed-punch reminder capability.
- RD covers report digest subscription / producer.
- AE-1 covers the backend correction route.
- SR covers self-service rule visibility.

The remaining useful humanization candidates should be re-ranked after AE durability:

1. anomaly correction UI polish (`AE-3`)
2. batch anomaly processing
3. owed-punch-only semantic filter
4. copy/paste or range-paint scheduling gestures
5. half-day leave definition helper

## 5. Files that should be read before starting the next slice

| Topic | File |
|---|---|
| Benchmark tracker | `docs/development/attendance-dingtalk-benchmark-target-and-tracker-20260601.md` |
| RD/MP/AE closeout | `docs/development/attendance-rd3-mp-ae-development-verification-20260627.md` |
| AE design lock | `docs/development/attendance-anomaly-result-edit-guard-design-lock-20260626.md` |
| MP design lock | `docs/development/attendance-makeup-punch-policy-design-lock-20260626.md` |
| RD design lock | `docs/development/attendance-report-digest-subscription-design-lock-20260626.md` |
| Overtime-bank verification | `docs/development/attendance-overtime-bank-design-verification-20260624.md` |
| Overtime-bank v1-5 lock | `docs/development/attendance-overtime-bank-v1-5-settlement-snapshot-designlock-20260625.md` |
| Humanization backlog | `docs/research/attendance-humanization-opportunities-20260622.md` |

## 6. Proposed queue

1. **Re-review / land `#3303`** — test hygiene, tiny and green.
2. **Open AE-1b corrected-fact durability design-lock** — owner ratifies sticky/manual correction semantics.
3. **Build AE-1b runtime** — real-DB matrix over recompute paths.
4. **Build AE-2/AE-3/AE-4** — notification, UI, staging.
5. **Then choose MP UI/staging or overtime-bank v1-8 staging** depending on environment availability.

This queue keeps the next runtime work attached to the only open correctness issue (`#3317`) and avoids reopening already closed benchmark arcs.
