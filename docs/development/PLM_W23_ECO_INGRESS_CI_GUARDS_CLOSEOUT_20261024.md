# ECO fixed-source ingress guard closeout

SOURCE: `f56bd78870dfb1fc36704b48671a000ebb936ea5` on parent `b7581fcf393bbafde767297d780e24bcce4905b5` (Draft PR 6518). This separate closeout is the only post-source document commit for this slice.

The only production change renames the private helper and call to `appendEcoSnapshot`; reversing those two substitutions reproduces the parent bytes. Six actual ECO holder keys/eight sites and five C2 keys are explicitly dispositioned; the conservative analyzer is unchanged. Fixed-source SAFE classification requires eleven readOnly string source cells, immutable maps/types, exact source-only writes and existing canonical authority/fence/mint/history/seal/commit boundaries. A discovered additive-DML structural-guard gap was reproduced and repaired with an exact whole-service literal-write/payload census. This finite syntactic guard does not claim dynamic SQL or arbitrary runtime alias coverage.

Root verification:

- Original nine failed CI nodes independently reproduced; 42 selected original/new/affected nodes then passed.
- Root independently reproduced both additive-query counterexamples in an owned test copy; final 9 revision nodes passed (one overlaps the first 42). No retained passing CI cohort was rerun.
- One actual PostgreSQL 16.15 two-service concurrent-confirm test passed on production SHA-256 `b76af548aa185d9bd83147023da06dd5f8a7b20d94a603bf7a34ad09ee6163c7`: B visibly blocked on A's actual source advisory; A committed version 2, B rolled back with VERSION_CONFLICT/409; retained row/history/receipt invariants were asserted.
- Owned database explicitly dropped, fresh database/role catalog restored, server stopped/status3/PID absent/no open files; owned root/runtime copy/lock removed. Root temporary tests/config/cache removed. Original runtime unchanged.

Design, exact commands/pins and compact evidence: `PLM_W23_ECO_INGRESS_CI_GUARDS_20261024.md` and `artifacts/plm-w23-eco-ingress-ci-20261024/verification.json`. Immutable manifests: first root42+PG1 `5c26741c85917e04a434d496c31afd025968cdccc347bf772db768bfcf76caf5`; additive RED2/GREEN9 `956405290be65e35622618bc12f9351cbf28ab7c8118d8de4a0d6c85ecf1b9ea`; owned PG cleanup `69faca7180ccf8964ca46e27c10c37f11090cd4dedd8aa531577dc8b3a182d7f`.

The exact parent 6518 snapshot had 44 successful and two failed checks. Its known separate private Native checkout-token failure remains; current child CI must be checked after explicit publication. Grok4.7(xhigh) provider500/no-edits was retained truthfully; this source was implemented by Sol6.1high fallback and independently reviewed/verified by Codex.

Draft/HOLD is preserved. No merge, deployment, production enablement, real business notices or issue closure. Readiness wire/persistence/transport/UI, installed image/MinIO/real customer acceptance and the entire master goal remain open.
