# W6 summary fidelity verification — 2026-10-26

The saved group's canonical aggregate already contains schedule strategy, optional flex mode, rule and punch sources, and the three request postures. This change renders those existing facts, corrects the two parent English literals, and distinguishes mutable editor/settings references from saved-group policy while the existing gate is ON. The seven domains and five source labels are unchanged.

Based on Draft #6554 at 9a8d2ec5cb70a9eeda634e1a01e21718cbc063a7. This PR deliberately includes that unmerged dependency when compared to main; review this slice as the delta from #6554.

## Reproduction and local gates

Original production sources produced six matching requirement failures and two passing original controls across phases. The first control targeted a nonexistent test-only attribute; it was corrected to the existing row class/navigation attribute, and only that control was retried. The original six failures and passing OFF control were retained.

- New formatter and real mounted presentation specs: 102/102 actual assertions passed, zero skip.
- Affected labels/panel/workspace/stage/host neighbors: 116/116; frontend registration: 39/39; backend lane guards: 63/63.
- Four mutations: absent optional mode changed to strict; unknown rule source changed to valid fallback; details binding removed; OFF copy guard removed. Each yielded its matching failure with seven filtered cases excluded, followed by exact source restoration.
- Official required-token manifest check and shell syntax exit0. Both new specs registered in domain workflow paths/classifier/live command and reachable required command.
- Scoped lint, validate:all and web build exit0. Whole AttendanceView lint has the same 17 baseline diagnostics, introduced zero; this is not a full-file-clean claim.

Commands used the isolated Node20.20.2/pnpm9.15.9 wrapper with blank environment and Stream/lifecycle OFF. The new/affected Vitest reports were counted by assertionResults.status; filtered cases were never counted as passing. The local affected suite commands were vitest run tests/attendanceGroupEffectivePolicyPresentation.spec.ts tests/attendanceGroupEffectivePolicyDetails.spec.ts and the five affected labels/panel/workspace/stage/host specs; see the machine-readable local-verification artifact for separate counts.

## Actual-entry synthetic browser

Four selected phases: original OFF, candidate OFF, candidate ON English1440, candidate ON Chinese768. All load actual main.ts/router/AttendanceView with strict synthetic API fixtures. Source hashes were pinned before and after each phase; original and candidate AV used the same absolute filename. Six saved/unsaved drawer/workspace OFF DOM snapshots are byte-identical and the complete request multiset is equal, including two auth reads in each phase. No ordered-request or full-page screenshot equality is claimed.

ON shows seven closed domain labels and seven existing detail fields. Explicit Open and Refresh each trigger one aggregate GET. Native rule selection changes local editor reference, while the saved canonical rule source remains organization default; drawers identify the distinction. No application writes, provider IO, forwarded external requests or page errors. Ports closed, own servers stopped and candidate source restored. English1440 and Chinese768 representatives were visually inspected. Mobile navigation was not repeated and human AT is not proved.

Synthetic viewport screenshots and local-verification.json are in artifacts/attendance-w6-summary-fidelity-20261026. They contain synthetic data only.

## Remaining boundaries

Public current-head required CI is pending publication; parent-head green checks cannot qualify a new head. Dated calculation-membership visibility, all actor contexts, whole FE04/FE05/FE06, owner approval, manual/soak/live acceptance remain separate. This PR does not change APIs, writers, calculation policy or flags, and does not certify the whole parent. All PRs Draft/HOLD; no merge, deploy, R71/tag/release/config change. Real UAT and business50004 remain excluded; historical08PUT INCONCLUSIVE.
