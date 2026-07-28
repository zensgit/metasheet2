# DingTalk lifecycle line closeout (T1–T3 · D1–D7) — honest status

**Updated:** 2026-07-24 (post-merge findings + owner fork A)
**All lifecycle env switches remain OFF.** Deprovision canary is **hard NO-GO** until D4 ledger wiring lands.

## Merge SHAs (durable)

| Slice | PR | Merge commit on `main` | Status |
|-------|-----|------------------------|--------|
| **T1** dual-axis + gates | [#4559](https://github.com/zensgit/metasheet2/pull/4559) | `27178ef4423dcc06446aef0d7d206687ff8ff55d` | **Landed** — invite ledger-first + dual-waiter real-DB goldens hold |
| **T2a schema + helpers** / **T3 service skeleton** / **D1–D6 helpers** / **D7 UI shell** | [#4574](https://github.com/zensgit/metasheet2/pull/4574) | `014fc23acb58feb1863f79a1c4151b0313fb654b` | **Partial** — see gaps below |
| **D7 UI mount + alias env contract** | [#4575](https://github.com/zensgit/metasheet2/pull/4575) | `71405cdb40659f31ddd0b98948c9eba646327d2d` | **Landed** env contract; D7 UI present (default collapsed) |
| Closeout SHA fill | [#4577](https://github.com/zensgit/metasheet2/pull/4577) | `8aad0ef8f7e3c66d70fbc45f4d08905f0fee5a2e` | Merged (this doc supersedes over-claims) |
| Ghost-column table fix + honesty fixes | *(this PR / follow-up)* | pending | Fixes T3/D7 writes to real tables; alias gate; fail-honest evidence |

## What is **NOT** complete (do not treat as full line)

| Gap | Severity | Owner path |
|-----|----------|------------|
| T3/D7 wrote `user_orgs.updated_at` + phantom `grant_enabled` with `.catch` → **activate with orgId/grant fails on real PG** | **P1** | Table-fix PR (from #4578 + P2s) |
| `assertAliasCutoverAllowed` not on Auth login path; cutover-status reported `ready:true` when env off | **P1** | Same honesty PR |
| Alias claim post-commit best-effort on activate | **P1** | Same (in-txn claim, fail-close) |
| Alias writers not on register / admin create / identifier change | **P1** | Follow-up alias writers PR |
| `directory-sync` deprovision still mutates access graph **without** ledger events | **P1** | **#4579 HELD** — Claude D4 path A (per-lock rebuild); **not** Grok |
| #4579 migration empty-ledger gate / down() unsafe | **P1** | Split into D3/D4/D5/D6/D7 windows; **do not merge as-is** |
| T3 **batch activate** + DingTalk SSO `intent=activate` production routes | **P2/scope** | Separate T3 completion PR or keep status **partial** |
| D7 preview is user-scoped hypothetical plan (not Apply≈Plan for selected integration) | **P2** | After D4 writer exists |

## Verified positives

- Alias env contract: `docker/app.env.example` + staging + `dingtalk-closeout-env-contract.test.mjs` local **8/8**
- D7 UI mounted on Directory admin, **default collapsed**
- T1 invite accept: ledger-first same transaction + dual waiter real-DB proof — no new issues found
- Real PG schema: `user_orgs` = `(user_id, org_id, is_active, created_at)`; grants = `user_external_auth_grants` (not `user_external_identities.grant_enabled`)

## Runtime switches (all default OFF — **keep OFF**)

| Variable | Canary order | Gate before flip |
|----------|--------------|------------------|
| `AUTH_LOGIN_USE_ALIASES` | 1 | Admin password-alias readiness **true**; Auth path enforces gate |
| `DIRECTORY_PENDING_ACTIVATION_ENABLED` | 2 | Activate path works with org membership + alias claim on **real DB** |
| `DIRECTORY_DEPROVISION_ENABLED` | 3 | **Hard NO-GO** until sync writer emits ledger events + restore drill green |

## Owner 裁断 (2026-07-24)

1. **Fork A (rebuild to lock)** for D4 writer/ledger — `directory-sync.ts` ownership stays on the D4 lane (#4579 remains HELD until split windows are reviewable).
2. **Ghost-column / `.catch` class** is not “schema variance” — it is production-breaking under real Postgres; fix by writing real tables, no swallow inside transactions.
3. **Closeout language** must say **partial** for T2b/T3/D4–D6 until the P1 table above is closed.
4. **Independent non-author review** required for any PR that claims canary readiness.

## Suggested implementation order (unchanged)

1. Keep all lifecycle switches OFF.
2. Land table-fix + #4578 P2s (membership rowcount, `granted_by` on restore) + alias Auth gate + in-txn alias claim + fail-honest evidence lists.
3. Alias full-writer coverage (register/admin create/identifier change).
4. Split #4579: D3 migration (replay-safe) → D4 ledger write → D5 mutex/generation → D6 restore → D7 Apply≈Plan / fail-honest.
5. T3 batch + SSO `intent=activate` **or** keep T3 marked partial.
6. Only then canary: alias-only → pending admission → deprovision.

See also: `docs/development/dingtalk-lifecycle-canary-separate-go-20260724.md`,
`docs/development/dingtalk-lifecycle-postmerge-findings-20260724.md` (D4 branch findings).
