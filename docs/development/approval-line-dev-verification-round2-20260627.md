# 审批流程及自动化 — 开发及验证 MD · Round 2 (as-built 2026-06-27)

> Goal: 审阅并开发,完成后给出开发及验证MD. Round-1 detail: `approval-line-dev-verification-20260627.md`.

## 1. RA Phase A — the 4-PR stack (ALL LANDED on `main`)
| PR | What | State |
|---|---|---|
| #3288 | RA-1a publish-posture doc correction | **MERGED** `2a15f2419` |
| #3292 | dry-run preview of `requester.*` (sample context) | **MERGED** `a8df3ddf1` |
| #3294 | RA-1a test-hardening (create→reload→dispatch real-DB seam) + CI-wired (Postgres lane + no-DB exclude) | **MERGED** `f3e8930c2` |
| #3296 | requester.department wedge guard (reject-at-create 503/422, token-aware AST) | **MERGED** `4d5a388b5` |
| #3293 | parallel codex dispatch-seam test | **CLOSED — superseded by #3294** |

The merge stack landed through a fast-moving `main` (attendance burst) via a bounded retry-loop. A force-push/merge race on #3294 was collision-verified clean: the `vitest.config.ts` no-DB exclude + the `plugin-tests.yml` Postgres lane entry + the test file are all on `main`. #3296's wedge-guard code (token-aware `formulaReferencesRequesterAttribute` + create-time guard → 503 `APPROVAL_REQUESTER_DEPARTMENT_UNRESOLVED` / 422 `APPROVAL_REQUESTER_DEPARTMENT_REQUIRED`) confirmed on `main`. (This PR also closes out #3296's design lock: PROPOSED → RATIFIED + SHIPPED.)

## 2. Next-layer DESIGN — two design locks, now durable in `docs/design/`
Schema verified on `origin/main`: `directory_accounts` has `title` + `job_number` + `raw`; **no role/level column**.
- **`requester.title` / `requester.level`** — `docs/design/approval-requester-title-level-design-lock-20260627.md`. **RATIFIED**: `title` buildable now (directory-sync-sourced `title` column, server-resolved; fill-rate varies → unset title fails-closed at create). `level` DEFERRED (no numeric source).
- **RA-1b `requester.role`** — `docs/design/approval-requester-role-ra1b-design-lock-20260627.md`. **RATIFIED — RUNTIME NOT BUILT** (build after title): source = system RBAC (not directory). Decisions: provenance = **fresh `user_roles` query**; vocabulary = **approval-curated subset**; v1 boundary excludes directory `raw` role/position. Needs the `in`/array grammar.

## 3. Owner decisions (locked 2026-06-27)
D-title = **YES** · D-level = **DEFER** · D-role-provenance = **fresh `user_roles`** · D-role-vocabulary = **approval-curated subset**.

## 4. Remaining roadmap (each gated)
- **`requester.title`** — RATIFIED; **next runtime slice** (cheapest, real source, no new grammar).
- **RA-1b `requester.role`** — RATIFIED — RUNTIME NOT BUILT; needs the `in`-grammar build after title.
- **`requester.level`** — DEFERRED (no source; needs a title→rank mapping decision).
- **W7 write-back** — approved-path same-base shipped; rejection / cross-base / approverField-native-person remain (cross-base is NOT small — redo permission/lock/audit/target-resolution). Each demand-gated.
- **Amount line** (optional, product/security decisions) — overridable line amount, backend strict `amount = qty × price`, discount/tax row math, mixed `rules`+`formula` branches.
- **Canvas polish (UX tail)** — drag-connect/free-drag E2E, pan/zoom, copy/paste subgraph, template gallery, mobile, in-canvas node config.

## 5. Verification (as-built)
- RA Phase A code + CI: round-1 MD (unit 45+66 / integration 6/6 real DB / tsc clean) + each PR's CI green on its merged head; #3296 final checks green (test 18.x/20.x/coverage).
- Schema facts authoritative (file:line evidence): `directory_accounts.title` real + sync-sourced; no numeric level; RBAC = role source; resolver seam `ApprovalDirectoryOrg.ts:166-185`.
- This round's "开发" = landing the (already-tested) RA Phase A stack + the two design locks (now durable here). No new runtime built this round (the next slices are owner-gated; `requester.title` runtime follows as its own PR).
