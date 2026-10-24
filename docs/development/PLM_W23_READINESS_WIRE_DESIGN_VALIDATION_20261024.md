# W23 readiness wire, first slice

Branch `codex/plm-w23-readiness-wire-r2-20261024` stays on `db6d1797f2a2e7f3541f5c5133dca7afaffb895a`. Nonce `56df7428587d4b779b04ca5e4be10a31`. This slice adds one strict parser sibling for a Native release-readiness collaboration envelope. It does not persist a row, call Native HTTP, mount a route, or open the reserved `readiness` source kind.

The human choice “采用提案，先做只读持久协作” authorizes the readonly phase only. The historical plan remains immutable. The root freeze is `/tmp/plm-w23-readiness-root-technical-freeze-20261024.json`, sha256 `6a9c5a259abf8877944e84d5a3dfaaa86039f874df64b9ecc82ae1d06e8eb158`. The binding amendment is `/tmp/plm-w23-readiness-wire-contract-amendment-r2-20261024.json`. The peer review is `/tmp/plm-w23-readiness-wire-peer-plan-review-20261024.json`, sha256 `4b04cf3dc0221b8711d642b7b2b82e77e65d2256451409ab56613e870cad5894`.

## Native objects read

Git objects `a9b901dcc71bfe8cc24524a63b868f8aeb612ce1` and `967d564370ac942d3f8d0451bd0de880084a1bf2` have the same bytes for these four files. No Native tree was edited. Live Native HTTP was not called.

| Path | sha256 |
| --- | --- |
| `src/yuantus/meta_engine/services/plm_collaboration_readiness_source_service.py` | `b96b2eb9ae24a49992c49a9914173a5eebe79c9733f2bc3f07dc2f885bb711a6` |
| `src/yuantus/meta_engine/services/plm_collaboration_source_service.py` | `0febca568642259261f32d9700de46faf46fbce491af323e9c4992c34996dd2a` |
| `src/yuantus/meta_engine/services/release_validation.py` | `ef44b82fcb15e215c13f14d3f5add8613786fd41c766de7353710b8ccb138bc5` |
| `src/yuantus/meta_engine/web/plm_collaboration_source_router.py` | `4b1d24d75fb1e6f0eeeb5ce77392ca972f8e26bf6699dbbb41db8908cb2215fb` |

The first, third, and fourth hashes are the freeze pins. The second hash is the peer pin for the shared id and feature helpers. `FEATURE_KEY` is `collaboration_source_read`. The readiness projection contract is `release_readiness_collaboration_source.v1`. Coverage is `bounded_not_proven_complete`. `FAMILY_CAP` is 20. Kinds are `mbom_release`, `routing_release`, `baseline_release`, and `item_release`. `_bounded_id` accepts a non-empty string of at most 128 Python code points whose ends are outside the Python 3.11 `str.strip` set, and it rejects NUL. That set has 29 code points. It includes U+0085 and U+001C through U+001F. It does not include U+FEFF. `String.prototype.trim` is the other way around for those characters, so request ids do not call it. It does not require a UUID. `_issues` keeps `code` and `rule_id` in input order and drops `message` and `details`. `_resource` emits `kind`, `name`, `state`, `resource_type`, `resource_id`, `errors`, and `warnings`. Summary `resources` is the list length. `ok_resources` counts resources whose `errors` list is empty. `error_count` and `warning_count` sum issue entries. The optional item resource uses `item.id` and `get_item_number(item.properties)`. `_utc_text` is `isoformat(timespec="microseconds")` with `+00:00` replaced by `Z`. An unentitled envelope sets `entitled` false and `source`, `snapshot_at`, and `readiness` to null.

## Name and state limits

Request item, ruleset, and nullable version ids use the 128-code-point rule and the 29-code-point Python 3.11 boundary set. A leading or trailing member of that set is rejected. The same character inside the id is kept, including U+0085. A leading U+FEFF is kept. Tenant and organization ids stay on the existing 64-code-point header-safe scope rule: `String.trim`, no NUL, no CR or LF. `Tenant.id` and `Organization.id` are `String(64)`. The scope rule was not switched to the Python set.

Resource `name`, `state`, issue `code`, and `rule_id` take no added 64, 128, 200, or 50 cap. The columns are not one limit. `ManufacturingBOM.name`, `Routing.name`, and `Baseline.name` are `String(200)`. Their `state` columns are `String(50)`. Their `id` columns are unbounded `String`. `Item.id` is unbounded `String`. `Item.state` is unbounded `String`. The item resource name is `get_item_number`, not those name columns. The wire therefore accepts nullable name and state, rejects NUL and non-strings, and does not invent a length cap. Resource ids are non-empty and reject NUL, with no added maximum. A 300-character name and rule id are accepted in the unit file.

## Parser

`packages/core-backend/src/multitable/plm-collaboration-readiness-wire.ts` does not import the ECO wire. The ECO file is unchanged. The three local fields are duplicated constants and match `ECO_COLLABORATION_LOCAL_FIELDS`: `collaboration_owner` person, `followup_due_at` dateTime, and `review_note` longText. No other business field is added.

Public exports:

- `ReadinessCollaborationSourceError`
- `READINESS_COLLABORATION_PROJECTION_CONTRACT`
- `READINESS_COLLABORATION_FEATURE_KEY`
- `READINESS_COLLABORATION_COVERAGE_STATUS`
- `READINESS_COLLABORATION_SOURCE_FIELD_TYPE` (`string`)
- `READINESS_COLLABORATION_SOURCE_FIELDS`
- `READINESS_COLLABORATION_LOCAL_FIELDS`
- `READINESS_COLLABORATION_RESOURCE_CAPS`
- `parseReadinessCollaborationSourceInput`
- `parseReadinessCollaborationSource`
- `readinessCollaborationRowKey`
- `readinessCollaborationBusinessMaterial`
- `readinessCollaborationBusinessHash`
- `readinessCollaborationSourceCells`

Typed interfaces are `ReadinessCollaborationIssue`, `ReadinessCollaborationResource`, `ReadinessCollaborationSourceInput`, `ReadinessCollaborationAnchor`, `ReadinessCollaborationSource`, `ReadinessCollaborationBusinessMaterial`, and `ReadinessCollaborationSourceCells`.

Whitelist objects are strict at the envelope, source, readiness, summary, resource, and issue. Extra keys such as `properties`, `esign`, and `details` are `502` `READINESS_SOURCE_REJECTED`. Arrays where an object is required, wrong types, a non-literal coverage value, a kind and type pair outside the four Native pairs, a family over 20/20/20/1, a duplicate `kind` plus `resource_type` plus `resource_id`, and a summary that does not match the returned resources are the same `502`. Duplicate issue entries stay and are counted. Warning-only resources count as ok. An empty resource list with four zero counts stays `bounded_not_proven_complete`.

Timestamps use the six-microsecond `Z` form and a manual Gregorian check. `Date.UTC` is not used. Year 0001 can pass the year check. Year 0000 does not. Safe counts are nonnegative safe integers.

`entitled: false` on a non-array object is `403` `READINESS_SOURCE_UNLICENSED` before the success schema. It is not an empty success. Input failures, including an extra request key or a `dataSourceId` outside 1..128 code points, are `422` `READINESS_SOURCE_INPUT_INVALID`.

After a schema success, tenant, org, item, nullable version, `readiness.item_id`, and `ruleset_id` must equal the expected anchor. An `item_release` / `item` resource id must equal `expected.itemId`, which is already equal to `source.item_id` and `readiness.item_id`. At most one such resource is allowed by the cap. A foreign item id with an otherwise consistent summary is `409` `READINESS_SOURCE_ANCHOR_MISMATCH`. The expected tenant and org are source-config coordinates supplied by the caller. This module does not authenticate a Native admin, a membership, or an entitlement grant.

The five-part row key is `dataSourceId`, Native tenant, Native org, item id, and ruleset id.

## Hash and cells

The business material is the typed row key, the fixed item id, the exact nullable version, coverage, the typed summary, and the whitelisted resources. `snapshot_at` and `generated_at` are the only excluded clocks. Resource and issue arrays keep their order. Canonical JSON sorts object keys and does not reorder arrays. The hash is the sha256 hex of that text. The same clocks produce the same hash. A changed resource, issue order, rule, state, version, or tuple changes it.

The nine cells are `item_id`, `ruleset_id`, `generated_at`, `coverage_status`, `resources_count`, `ok_resources`, `error_count`, `warning_count`, and `resources`. Each value is a string. Counts are canonical decimal text. `resources` is canonical JSON of the validated resource list. The physical field type constant is the existing readonly string. This file does not create fields or write records.

## Measured checks

The first slice, before the Python strip repair, ran from `packages/core-backend` after the disk floor `4563402752`. Those two results are not the current proof:

- `node node_modules/typescript/bin/tsc --noEmit --pretty false` exited 0. Free space before it was 12364804096 bytes and after it was 12372164608 bytes.
- `node node_modules/vitest/vitest.mjs run tests/unit/plm-collaboration-readiness-wire.test.ts` used Vitest 1.6.1, started `2026-10-24T00:23:38.821167+00:00`, and exited 0. One file passed 7 tests in 295 ms.

Root then ran three request-id cases against source sha256 `eb5c7e9e0158c1b9f609e7b08d6bc59cbc8c21c8fdf05d8cab687a2f94214b79`. The log sha256 is `01b120ff6a5974dde880cedd476dd17f901cd23f56e39299f87131ea8d89e208`. U+0085 and U+001C prefixes were accepted, and a U+FEFF prefix was rejected. The Native oracle at `/tmp/plm-w23-readiness-native-whitespace-root-oracle-20261024.json` says the opposite. Its first Python call missed `PYTHONPATH` and failed before import. That miss is not a business failure. The corrected oracle uses `PYTHONPATH=src`.

Current proof, again from `packages/core-backend` and after the same disk floor:

- `node node_modules/typescript/bin/tsc --noEmit --pretty false` exited 0. It started `2026-10-24T00:32:40.416673+00:00`. Free space before it was 12294406144 bytes and after it was 12295307264 bytes. `tsconfig.json` includes `src` and excludes `**/*.test.ts`.
- `node node_modules/vitest/vitest.mjs run tests/unit/plm-collaboration-readiness-wire.test.ts` used Vitest 1.6.1, started `2026-10-24T00:32:48.236850+00:00`, and exited 0. One file passed 8 tests in 289 ms. Free space before it was 12295282688 bytes and after it was 12299460608 bytes. The added case checks all 29 boundary code points, a U+FEFF prefix and version, an internal U+0085 that stays in the item id and its cell, and a 128-code-point id.

No PostgreSQL, Docker, browser, build, CI, commit, or push ran. The prior service, route, and realdb suites were not rerun. The removed root probe file was not recreated.

## Not in this slice

`PLMAdapter`, the collaboration snapshot service, a new forward migration, real PostgreSQL, source HTTP, UI, flags, route enablement, a new purpose grant, a shared credential fallback, and a third manager are not implemented. The accepted collaboration migration is unchanged. Source kind `readiness` still rejects readiness writes until a later migration and API slice. Installed acceptance is not claimed. Parent publication stays untouched. This branch is not pushed.

## Root qualification current

This remains the first, pure-wire Readiness slice. Actual Grok4.7(xhigh) implemented the parser, types, five-part row key, clock-independent business hash and exactly nine canonical string cells. Its first body was independently reviewed: Codex and the peer found Python `str.strip()` versus JavaScript `trim()` protocol drift. Root executed the actual Native `_bounded_id` helper, reproduced three failing wire cases (NEL/control prefix refusal and BOM acceptance), and retained immutable RED evidence. Grok implemented the finite29-character Python3.11 boundary set and added the load-bearing unit matrix.

Root simplified only the new whitespace-boundary helper to two code-unit membership checks: all29 oracle characters are BMP, so surrogate traversal adds no value. This small integration is attributed to Codex, not to Grok. Final source SHA-256 is `87a547b7d9915ed10dc48ba5498c9bb16f58d88aaa663e74b6a1d658d705576a`. Existing64-character header policy, Native1..128-code-point request bounds, NUL rejection, nullable version, fixed Item-resource identity and all snapshot/hash semantics remain intact.

Root reran the identical frozen three-case oracle probe:3PASS. Then only the eight new wire tests plus six independently prepared protocol controls ran:14PASS/0FAIL/0ERROR/0SKIP. The extra controls cover cross-family raw-ID reuse with typed identities, repeated warnings/ok-resource semantics, foreign Item resources, Meta-scope substitution/extra identity data, strict nullable-version/source/issue whitelists, per-family caps below61, detached outputs, typed row-key delimiter collisions and clock-independent hash with9stringcells. Final backend TypeScript `--noEmit --pretty false` exited0. No old passing suite was rerun. Root temporary test files were removed.

The root parity GREEN log SHA-256 is `6d436ee2207db7a588961f7944c8f2b171e1fa806a1fd5ee58eba4f915f8d5d2`; root14 log is `49f2e041272525201a4a15c9394e0db4a092944e954eed8bab71afbce12b2ee3`. Immutable RED manifest: `067922f3125142af6fcc0f12757343c2aeef9afe02960f37b1c586d2c1c0b88a`. Immutable final GREEN17+tsc manifest: `f9db7f78e2fa0540b406d3461be67b616a613c10b14678e8fcb168dc49bba6ec`. Those are protocol/helper proofs, not live Native HTTP, authority/grant, PostgreSQL or installed acceptance. Two preparation refusals occurred before imports/tests (missing PYTHONPATH; old executor owner-phase check), and are explicitly not business counterexamples.

The existing listener workflow already triggers on the new paths but named only old test files. Root added exactly `tests/unit/plm-collaboration-readiness-wire.test.ts` to its existing regression command so current-head CI exercises the new8 tests. YAML parsed and an exact one-argument append was verified; all old test arguments, steps, jobs, permissions, triggers and gates remain. This expands the source slice from4newpaths to4newpaths+1existingworkflow; the other41 original pins remain unchanged. No new CI or management engine was introduced.

Parent Draft6519 exactdb6 is all-terminal16success/1known private-checkout-token failure; its record-ingress guard job succeeded. After SOURCE and one separate closeout, this pure-wire child still needs its own head CI. Source kind `readiness` remains closed to persistence. Adapter/service/forward migration/realPG/sourceHTTP/workspaceUI/browser/installation and the whole master goal remain unfinished. No merge/deploy/enablement/business-notification/issue closure.
