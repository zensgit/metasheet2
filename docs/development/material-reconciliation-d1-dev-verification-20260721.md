# Material Reconciliation D1 — Frozen Contract: Development & Verification (2026-07-21)

Charter: `stock-preparation-v2-material-master-reconciliation-charter-20260719.md` — **ratified
via #4484 (owner ruling 2026-07-21: OD-V2-1..7 all per recommendation; ratify unlocks D1 only)**.
Scope: §7 D1 row exactly — independent manifest, frozen templates for the complete §3 object
list, closed vocabularies, flag/permissions contract, and the §4.6 `canonicalRowDigest`
determinism contract. **Schema-only and latent: no routes, no sheet provisioning, no env reads,
no runtime, no migrations.** D2+ each pass their own gate (§7).

## 1. Deliverables

### 1.1 `plugins/plugin-integration-core/lib/material-reconciliation-templates.cjs`

Follows the `stock-preparation-templates.cjs` house pattern (typed error, closed vocabularies
with Set mirrors, `assertNoContentKeys` at every nesting level, normalize-then-deep-freeze,
builders returning `rows: []` always, values-free evidence summarizer, `__internals` for tests).

- **Identity/reservation**: manifest id `material.reconciliation.v1`; route namespace
  `/api/material-reconciliation` (reserved, unregistered); flag env
  `MULTITABLE_MATERIAL_RECONCILIATION_ENABLED` (OD-V2-6 default-OFF; name + pure literal-'true'
  predicate declared, no `process.env` anywhere in the module); permissions
  `material-reconciliation:read|operate|admin` (OD-V2-3).
- **Closed vocabularies (all frozen, Set-mirrored)**: run states (§5, 7 states incl
  `deduplicated`, no pending-like state) + one-way transitions; binding statuses (§4.5, five,
  deliberately **without `active`** — the derived pointed-at predicate) + one-way transitions;
  six diff buckets (§2.2); failure reasons with class (`RUN_IDENTITY_CLAIM_BUSY`=retryable,
  `READ_UNPROVABLE`/`SOURCE_SNAPSHOT_CONSISTENCY_UNPROVABLE`=fail_closed); consistency-proof
  mechanisms (§4.6 rev-4/5: `SOURCE_SNAPSHOT_TXN` / `IMMUTABLE_SNAPSHOT_TOKEN` /
  `MONOTONIC_VERSION_PIN`; dual-sweep excluded by contract); write disciplines; audit actions;
  identity-key classes; select-vocab registry (select fields reference exported vocab names only).
- **FORBIDDEN_CONTENT_KEYS**: the stock-prep 12 + `credentials`/`secret`/`token`; enforced at
  template root, field, select, uniqueness, and reference levels.
- **Nine frozen templates** (§3 complete list): `material_reconciliation_run`
  (state_machine_only; 058-precedent partial unique `(tenant, run_identity_key) WHERE
  run_identity_key IS NOT NULL`), `_source_snapshot`, `_source_snapshot_row`, `_diff`
  (create-only; snapshot handles only), `_scenario` (pointer_cas_only; composite-FK pointer
  declaration `(scenario_id, active_binding_version_id) -> binding_version(scenario_id, id)`,
  §4.1), `_binding_version` (create-only, status one-way), `_binding_member` (create-only;
  single-track `system_content_key`, rev-4), `_binding_audit` (append-only values-free, no
  free-text field), `_run_identity_claim` (claim-only; PK `(tenant_id, run_identity_key)`,
  §4.4 rev-6). Every digest/fingerprint/content-key/lineage/identity-normalized/projection
  field is normalizer-enforced `internalOnly` (no bare-SHA public exposure, §4.6).

### 1.2 `plugins/plugin-integration-core/lib/material-reconciliation-row-digest.cjs`

The §4.6 determinism codec, pure `node:crypto`, every throw carrying a closed reason code:

- single-byte type tags `missing/null/boolean/integer/decimal/string`; JS numbers accepted only
  as safe integers (`DECIMAL_FLOAT_TRANSIT` otherwise — no IEEE754 transit); decimals arrive as
  `{decimal:'<text>'}` and canonicalize via pure string ops (strip one `+`, strip leading
  zeros, trim fractional trailing zeros, fold `-0`→`0`; exponent/hex/`.5`/`1.` rejected as
  `DECIMAL_MALFORMED` — `.5` pinned reject-for-strictness); strings NFC-normalized, no case
  fold, no trim; every variable-width component 4-byte big-endian length-prefixed (no bare
  concatenation); `fieldOrder` is the digest authority — extra/duplicate row keys throw
  `FIELD_ORDER_MISMATCH` (fail closed);
- sort tuple: class byte `0x01` valid / `0x00` invalid (domain separation), valid requires
  non-empty key / invalid requires empty sentinel, fixed 4-byte BE multiplicity bounded by the
  caller-supplied read cap (`MULTIPLICITY_OUT_OF_BOUNDS`);
- snapshot content digest: byte-lexicographic multiset over length-prefixed tuples.

### 1.3 Contract tests (registered in the plugin CJS chain → CI `integration-guard`)

`__tests__/material-reconciliation-templates.test.cjs` and
`__tests__/material-reconciliation-row-digest.test.cjs`, plain-node per house pattern; both
appended to `package.json` `scripts.test` plus `test:` aliases.

## 2. Adversarial review absorption (workflow verify agents, 0 P1 / 4 P2 / 6 P3)

Implementation ran as an orchestrated two-cluster pipeline (implement → independent adversarial
verify per cluster, probe-mutation based). All four P2s were **test-strength** findings
(implementation itself clean); all absorbed:

| Finding | Fix |
|---|---|
| P2: Set mirrors never asserted against arrays (a poisoned Set passes) | per-Set `deepStrictEqual([...SET].sort(), [...ARRAY].sort())` for all 13 mirrors |
| P2: transition maps / terminal list / select registry not frozen-asserted | `Object.isFrozen` on each structure + inner arrays; transition key-sets asserted to cover every state |
| P2: row-level length-prefix drop survives (tag byte accidentally separates the naive pair) | exact splice-collision killing pair routed **through** the tag byte: `['k']{k:'vm\x05w'}` vs `['k','m']{k:'v',m:'w'}` |
| P2: multiplicity re-encoded as varint survives | exact tuple layout assertion (`1+4+keyLen+4+32+4`), fixed-width across values, BE byte-order pin (`01020304`), plus golden byte vectors for row digest / tuple / snapshot digest |
| P3: select-level forbidden-key path untested | select-descriptor injection negative added |
| P3: evidence objectIds projected pre-normalization | summarizer now normalizes before any projection |
| P3 (recorded, no code change): `fail_phase` has no charter vocabulary | implementation-lock TODO for D2/D3a — freeze a phase vocab before runtime writes it |
| P3 (recorded): diff carries `identity_key_normalized` (internalOnly) though §3 says "handles only" | needed for key-level bucketing across sides; flagged for explicit charter acknowledgment before D3b |
| P3 (recorded): charter letter "尾零裁剪到冻结精度" vs codec whole-trim | whole-trim (canonical minimal form) is the only metadata-free deterministic choice; pinned here as the D1 ruling request — owner confirm, or D3a adds per-field frozen precision |

## 3. Verification

- Both contract tests green; **full plugin CJS chain green** (`pnpm --filter
  plugin-integration-core test`, all suites incl. the two new ones).
- **Mutation battery 15/15 RED** (commit-then-mutate; verbatim restore; clean rerun green):
  templates — inject `active` status / `DUAL_SWEEP_DIGEST_MATCH` mechanism / `pending_claim`
  state, flip `RUN_IDENTITY_CLAIM_BUSY` to fail_closed, poison a Set mirror, unfreeze the run
  transition map, drop the `token` forbidden key, emit non-empty `rows`; codec — drop length
  prefixes (killed by the splice pair), varint multiplicity (killed by the layout pin), drop
  NFC, un-fold `-0` (killed at the real fold site after a first attempt hit a comment — noted
  for honesty), drop the type-tag byte, drop the multiplicity bound, drop the snapshot sort.
- Structural independence enforced **by test**: the templates module's only `require` is
  `./payload-redaction.cjs`; no `plm_stock_preparation_` string, no stock-prep/BOM/classifier/
  UOW imports, no `process.env` (§3 acceptance items 1/2/4).
- Values-free: fixtures use abstract tokens only; evidence surfaces expose ids/counts/vocab
  sizes only.

## 3b. Owner six-focus deep review — absorption (2026-07-21)

The owner directed a deep review before merge (six foci). Ran as six independent adversarial
review lanes; findings: **2 P1, ~10 P2, ~10 P3** — all absorbed in the follow-up commit:

| Focus | Outcome |
|---|---|
| ① Nine templates vs charter | **P1**: `binding_version` froze `create_only`, contradicting the §4.5 one-way status lifecycle → new `create_only_status_one_way` discipline. P2s: `binding_member` gains frozen uniqueness `(binding_version_id, role)`; `source_snapshot` gains `(attempt_id, role)`; `binding_version` gains `(scenario_id, binding_version_id)` backing the composite FK; §5 failed-record **counts** added (per-side pages/rows read); machine-readable **retention** attribute frozen per object (`claim = released_on_failed`, others `permanent`); charter-unconditional digest fields now `required`; `fail_class` **dropped** (the reason→class binding lives in `MR_FAILURE_REASONS`; a stored class could contradict the reason) |
| ② Codec byte contract | **P1**: lone surrogates were silently folded to U+FFFD by `Buffer.from(...,'utf8')` — probe-proven digest collisions at all three string ingestion points → rejected with new closed reason `STRING_ILL_FORMED` (U+FFFD itself stays a legal value; astral pairs legal). P2s: field ids now NFC-normalized before uniqueness + encoding (NFC-duplicate ids throw); string identity keys NFC-normalized on the convenience path (Buffer path = caller-owned byte authority, documented); `canonicalRowDigest` fixed 32-byte width (`DIGEST_WIDTH_INVALID`); empty-snapshot digest ruled LEGAL (chartered §8.2-4 positive control) and pinned |
| ③ fail_phase ruling | **FREEZE NOW**: `MR_RUN_PHASES = ['planned','reading_sources','snapshots_complete','compared']` — mechanically the states with an `X→failed` transition ("the run state at the moment of failure"); zero invented phases (the reviewer explicitly rejected inventing e.g. `identity_analysis`, which is chartered as a phase that cannot fail the run). `fail_phase` is now a select over it; parity with the state machine is itself asserted |
| ④ identity_key_normalized in diff | **DROP** (charter letter: handles only; keys recoverable via stored row handles). Frozen per-bucket handle discipline recorded in the template: matched = both handles; only_in = exactly one; ambiguous = per-side deterministic exemplar (**byte-lexicographically smallest `canonical_row_digest`** — never `row_index`, replay-nondeterministic per §8.2b-7) + per-side multiplicities; identity_invalid = single handle + class. The dropped field id joined the test's forbidden list |
| ⑤ decimal float-reject stance | **KEEP STRICT** (no-IEEE754-transit is itself a frozen §4.6 rule). Verified transit reality: today's http/K3/SQL adapters all JSON.parse — raw decimal text is destroyed before projection; therefore **two D3a design-gate contract items recorded**: per-source `decimalTransit` capability (decimal fields carried as text end-to-end) and upstream kind-coercion authority (per-field frozen kinds; `classifyValue` is not type inference). Both + the exponent-expansion trap (`String(1e-7)==='1e-7'`) are now in the codec header |
| ⑥ CI + mutations | CI reality PROVEN (the PR's integration-guard log contains both literal `... OK` lines — 被触发且被验证). **6/6 independent mutants SURVIVED** the original battery (interior-zero strip, boolean-false byte, fieldId NFC, multiplicity upper edge, FK arity, uniqueness scope) — each now has a killing test; re-run post-fix: **all six RED**, plus six new-defense mutants (ill-formed off, width off, retention open, phase de-select, member-uniqueness drop, binding-discipline revert) **all RED**; clean rerun green |

Honest accounting: the original "15/15 mutation battery" was real but incomplete — the
independent lane proved whole rule-edges unpinned. The battery now stands at 15 original +
12 review-round kills, with golden byte vectors extended (golden-2 carries an interior-zero
decimal, boolean false, and composed unicode).

## 4. Explicitly out of scope (per §7 gates)

D2 (scenario/binding store, pointer CAS runtime, `SET LOCAL lock_timeout` claim mechanics with
crash-injection tests), D3a (source reads, consistency-proof runtime, spike + per-source
mechanism qualification), D3b (six-bucket reconciliation, own design gate), migrations, routes,
flag wiring, provisioning. The real-PG claim/lock_timeout PoC (14/14 incl. negative control,
#4484 comment) remains pre-formal evidence to be recast as §8.2b-14/14b tests in D2.
