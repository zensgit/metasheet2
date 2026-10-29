# Published R77 organization integration - Draft/HOLD

Base: published onprem-r77, commit 7b69ee370e1329ff863458509bedae9516b80fdd, branch claude/onprem-r77-plm-guards-20261029.
Organization input: 6944e98d5e73aeb044a5d68ad5b490a183d68dbe, including both 1ed76992b8d3b69605a10b8f5322706a15ceb0df and its census-only follow-up. Original inputs: refs #6589, #6592, #6612.

The published R77 can now be composed with the native organization workspace, independent department direct-manager/head flags, and the user-management read-only relationship summary. Position remains profile text. No per-employee superior field or title-based authorization is added. Existing local/DingTalk source policies and existing approval snapshots remain unchanged.

## Source composition

A three-way composition from confirmed R76 763a559dca877fc42c1dbe1ad7ee8421687a240b adds the existing 55 organization paths to published R77. Only packages/core-backend/src/index.ts and packages/core-backend/vitest.config.ts overlap with R77's 75-path increment. The result preserves 53 organization-only paths and 73 R77-only paths byte-for-byte. The two overlapping files retain all R77 runtime/drain and test-lane changes; their organization delta is the original workspace import/mount and dedicated native-lane exclusions. No custom runtime repair, dependency alteration, budget reduction, scanner exclusion expansion, or new flag is introduced.

The 128 composition pins and the independent source review match. This document is the only extra path beyond the validated 55-path composition. Published tags/assets and the prior R76 organization package are untouched.

## Verification

| Gate | Actual evidence |
| --- | --- |
| Dependencies | Node 20.20.2 / pnpm 9.15.9; one fresh offline frozen install from the retained owned cache, using R77's vendored xlsx input. |
| Changed entry/lane inputs | Four complete registration/CI-contract files: 204 passed, zero failed, skipped, filtered or todo. Existing unrelated organization suites were not rerun. |
| Backend | Production TypeScript build exit 0. |
| Web | Type checking and production Vite build exit 0; current output contains 159 files. |
| New built organization entry | Real synthetic session plus isolated PostgreSQL; user relationship summary and maintenance navigation exercised. Four actual browser PATCH requests returned 200: head unset/set and manager unset/set, with independent readback and exact final summary. |
| Denials | Ordinary subject summary GET 403 and forged organization field PATCH 400; owned business fingerprints unchanged. |
| Browser diagnostic | The original whole harness retained a failure for two console errors. A separate read-only probe confirmed both were browser network 404s for attendance groups/shifts with plugin loading intentionally disabled. It repeated none of the four UI writes and preserved the read fingerprint. This is not a claim of a fresh zero-console-error whole-browser pass or production attendance acceptance. |
| Migration source | Complete published-R77 migration trees and runner are byte-identical to R76. This patch adds only zzzz20261027090000_add_local_department_head. The owned clone's complete existing 454-name ledger was checked; no apply/rollback rerun or target-server migration occurred. |
| Prior source evidence | Original native whole-file and mutation receipts remain limited to their prior source phases. They are not relabelled as fresh R77 execution. |
| Package/CI | Final source SHA, Draft PR checks, archive provenance, complete archive bindings and checksum results belong to the delivery manifest and PR evidence; this source document does not pre-claim them. |

The dependency copy attempt timed out before any install/test; the owned partial copy and failure log were retained. The continuation performed the fresh install once and completed the affected guards/builds. All original browser/harness failures remain preserved. No passed build or unchanged suite was repeated.

## Package and operation boundary

Use only a newly named r77-org-DRAFT test package whose provenance names the final source SHA and whose manifest pins this exact published R77 base. Do not overlay whole source files into a running installation. Follow the supplied checksum, dependency activation, migration comparison, operation and rollback notes only after target authorization. Package building/checking is separate from target installation, Windows native acceptance and business UAT.

The single head migration defaults existing rows to false and keeps is_manager independent. Its down migration drops head values: preserve them before rollback; rollback is not lossless.

Draft/HOLD only. No merge, Ready, deployment, R71 change, target migration, tag/release, business policy switch or provider/live writes. Stream/lifecycle/external writes stay OFF. Real UAT/50004 remains excluded and historical 08 PUT remains INCONCLUSIVE. Full DingTalk, Redis/provider/manual/owner acceptance remains separate and incomplete.
