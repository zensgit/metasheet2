# Time Machine LOCAL APFS standalone verification — 2026-10-01

Status: bounded local repair PASS; Draft/HOLD; own main-target remote CI pending. Tested runtime `d2bc43765620c6b7e753f4c0152a8c6b943f1152` is based on current main `ef9eb2d86cf4cbef7327036368f92ca3eb0f53d3`. This report-only child changes no tested runtime. It supersedes the private-base publication PR #6198: that publication's eleven advisory greens did not execute the main-only required backend/web workflows and are not CI acceptance.

Actual local APFS provisioning refused before the repair because Darwin's numeric filesystem type was `26` while the prior check admitted only `25`. The shared helper invokes `/bin/df` on the exact resolved root without a shell, requires one native JSON record with literal type `apfs`, and checks mount/root device and root realpath/inode around the bounded probe. The local/type arguments alone are not name proof. Linux keeps its prior supported numeric set without invoking a child. Errors preserve the existing values-free refusal shapes.

| Gate | Evidence |
| --- | --- |
| Frozen standalone scope | Design lock plus six code/test files; no DCD cleanup protocol, binding migration or fence-ledger additions. Main private-database drain and ordinary manual/object-store bytes are retained. Helper SHA256 `dcd94db07ecff54705aeab590402a2912c8f5e45ce1e7d771b074809b4c0baf8`. |
| Focused units and neighbors | Fresh cache-disabled 7 files / 252 passed / zero skips: helper42, archive22, custody8, object19, receipt10, schema guard31, schema behavior120. APFS/provider subtotal101, not the old stacked125. |
| Independent review | No actionable P1/P2; repeated 101 focused plus31 guard =132 PASS. This repeated full result was tool-observed; its full log was not retained. |
| Fresh discriminating mutations | In a reviewer-owned copy, name, local argv census, mount device and post-root checks each caused corresponding negatives to fail. Exact bytes restored;42 PASS before and after. The argv mutation is selection-shape evidence, not a separate physical locality attestation. |
| Validation | `pnpm validate:all`, backend/acceptance type checks, explicit touched-test typing and49 CI wiring contracts PASS. |

Implementation commands/source/log hashes are in `artifacts/tm-apfs-native-main/`; independent report and six positive/mutation/restored logs were copied there before temporary-copy removal. No migration, workflow selection, route, provider default or feature flag changed.

## Fresh standalone same-generation APFS recovery

Test-only composite `2d616eeee3b11b651a6ac8abdc62a23731934007` differs from the frozen standalone runtime only in six acceptance-helper paths from PR #6183 runtime `7c6c79aae7c67c19ecbc22ca065348c6f3330d05`. Five helper blobs match exactly; the acceptance tsconfig includes the exact union with current main's private-database drain declaration, with other options unchanged. Historical DCD composites and their evidence remain separate.

On actual owned APFS roots and disposable PostgreSQL, the same authenticated manual generation was backed up, imported into an initially empty target and restored through the official FD3-unlock launcher after the source database and roots were unavailable. Exact scalar data, attachment bytes and history recovered. Two fresh ordinary flag-OFF processes compared equal HTTP bodies and canonical contents/counts across21 ordinary archive tables, then stopped without listeners. The old DCD composite's22-table count is not substituted: its extra binding table is absent from this standalone runtime. A separate seeded5001-row control completed two chunks and5001 derived effects; this is not a5001-row manual-capture claim.

Driver and runner exited0; scoped database/backend census was `0|0`. Independent owned cluster/root/child counts were zero. Log SHA256 `63757e440f20b8ec40f91bde41c5245a6df8ec861735a7b166a04fec65650a97`. Full source/helper correspondence, runner, logs and manifest are in the root-owned test checkout's `artifacts/timemachine-apfs-native-main-20261001/`. Driver explicitly set `TSX_DISABLE_CACHE=1`; no per-child cache-activity instrumentation is claimed.

## Remaining gates

Own exact-head required CI and actual archive-file execution census remain pending. Expected existing realDB archive census is14files/306tests; it must be observed rather than inferred. PR #6195 cleanup evidence and its CI are separate.

No remount/process-crash/power-loss or independent physical fault-domain proof is supplied by this admission repair. It does not attest remote or physical storage identity. Expired-builder terminalization and process-death cleanup acceptance, full D7/D-L verified/pinned/legacy expiry and slow-provider cases, Phase5 live scheduled attribution, actual staging deployment/window/rollback and production acceptance remain OPEN. No retention/lease policy, key-reference release/destruction, customer data, remote provider/KMS call, GitHub merge or deployment occurred. Defaults stay OFF; Ready/merge remain owner gated.
