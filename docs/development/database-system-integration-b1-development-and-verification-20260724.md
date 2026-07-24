# 数据库及系统对接线 — B1 自动化开发与验证报告（2026-07-24）

**Status:** RECORD of an automated development round. Every claim below is head-scoped and reproducible.
**Authorization boundary:** this round produced code, docs and tooling on branches. It **merged nothing**,
**armed nothing**, **wired nothing to a runtime path**, and **deployed nothing**. Every owner gate on this
line remains exactly where the owner set it. The line ledger — `database-system-integration-line-design-and-verification-20260724.md`
(PR #4590) — remains the single evidence ledger; this document reports what was BUILT and HOW IT WAS VERIFIED.

---

## 1. 加速方案审阅结论

The owner-set M0→M1→M2 route is **sound and adopted**. It inverts the earlier "decide the endgame first"
framing into an evidence-driven one: M0 buys a one-tenant usable proof with zero product code, M1 produces
the real counts and the real pain, and M2 is only built if that evidence demands it — so "do we need
`sealed_snapshot`?" becomes a conclusion rather than a prior. Two structural properties are worth naming:
M0 needs **no GIP arming at all** (the feeder already carries `short_page` semantics; `bridge.bounded_read.v2`
stays latent), so it collides with none of the standing HOLDs; and the critical path is **owner decisions,
not engineering throughput**.

Three review rounds were absorbed into the ledger before this build round started — see #4590 for the
⟲P/⟲C/⟲R marker table. The one correction this round adds to that ledger is in §4 below.

## 2. 剩余开发量（实测基线，非估计）

Landed GIP governance layer on `main` — measured, not guessed:

| module | lib | test |
|---|---:|---:|
| `gip-profile-certification-contracts` | 569 | 350 |
| `gip-binding-qualification-spike` | 520 | 424 |
| `gip-profile-compliance-harness` | 319 | 210 |
| `gip-bridge-bounded-read-profile` | 243 | 546 |
| `gip-canonical-json` | 153 | 161 |
| **total** | **1804** | **1691** |

≈3.5k lines of governance already on `main`, with **zero production consumers** (fully latent).

Remaining slices and their sizes:

| slice | scale (lib+test) | difficulty | model | state after this round |
|---|---:|---|---|---|
| **B1a** latent contract + harness | ~2 200 | highest (security core) | Opus×3 impl, Sonnet wire, Opus×3 review | **built + reviewed** (§3) |
| **B1b** MySQL/MSSQL probe strategies | ~450 | medium | Sonnet + Opus review | **built + reviewed** (§4.3) |
| **B1c** page-sequence execution design | doc | medium | Fable + Opus review | **built + reviewed** → PR #4593 |
| exposure-inventory tooling | ~1 400 | medium | Sonnet + Opus review | **built + reviewed** → PR #4594 |
| **B1-observability** wiring | ~300 | medium | — | **owner declined to open early** |
| customer migration | ops | — | — | awaits inventory results |
| **B2** enforcement | done | — | — | PR #4591, merges LAST |

**Conclusion: the remaining *coding* volume is modest; the cost is certification discipline** — every guard
mutation-tested, every negative control paired with a positive one, every frozen vocabulary pinned in both
directions. That discipline is what this round spent its effort on, and it is what found §4.

## 3. 本轮构建与验证

### 3.1 模型分派（按难度自动调度）

| slice | author | reviewer | rationale |
|---|---|---|---|
| B1a R5 combinations | **Opus 5** | Opus 5 ×3 lenses | touches a ratified certified module |
| B1a R6+R3+R2 resolver | **Opus 5** | Opus 5 ×3 lenses | security core — the forgery surface |
| B1a qualification binding | **Opus 5** | Opus 5 ×3 lenses | must not break a ratified signature |
| B1a wiring + latency proof | **Sonnet 5** | — | mechanical, high-volume verification |
| B1c design doc | **Fable 5** | Opus 5 | documentation-heavy reasoning |
| inventory script | **Sonnet 5** | Opus 5 | implementation with a hard correctness spec |

Total: **22 agents**, ~2.9M subagent tokens, ~890 tool calls across seven workflows. Six of those
agents were adversarial reviewers or re-verifiers — **more review capacity than implementation capacity**,
which is what this line's history calls for.

### 3.2 B1a — what was built

- **R5** `PAGED_READ_LEGAL_COMBINATIONS` — a frozen table consulted **only** when
  `acquisitionMode === 'PAGED_READ'`, implemented as rule 5 inside the existing
  `assertCertificateCrossDimensionLegal` (the established scale-D0 pattern). Two deliberate refinements the
  implementer made beyond spec: an **array of frozen rows, not a keyed object** (a `table[proof]` lookup
  would walk the prototype chain for names like `constructor`), and **every declared proof must anchor the
  declared lifetime**, not merely one — because `validateConsistencyEvidence` only checks `used ⊆ supported`,
  so an unmapped proof riding along could later be claimed alone as a run's proof class.
- **R6** `orderingKeySpec` closed schema — canonical `fieldId`s only, non-empty, no duplicates,
  `direction ∈ {ASC, DESC}`, every id resolvable through the same approved config version's mapping.
  NULLability deliberately stays with the qualification probe, where it is observable against the source.
- **R3+R2** `gip-approved-binding-resolver.cjs` — derives the **complete six-field tuple** from one immutable
  approved version plus its tenant's system record; re-verifies approval/tenant/scope through
  `getForRuntime`; **recomputes** `configContentKey` and compares (never trusts the stored column); returns
  an **owned clone in the strict canonical-JSON domain, recursively frozen**, trusted by module-private
  WeakSet identity.
- **Qualification binding** — purely **additive** (`verifyBindingQualificationFromResolution`,
  `probeFromResolution`, `assertResolutionInputKeys`), so the ratified entry points and their tests are
  untouched.

### 3.3 B1a — adversarial verification (3 independent Opus lenses)

- **Lens 2 (combinations)** ran a mechanical **288-cell grid** (4 modes × 8 consistency subsets × 3 lifetimes
  × 3 completeness sets) through the real normalizer on HEAD *and* on the pre-R5 base: 54 cells changed
  verdict and **not one non-`PAGED_READ` cell moved**; exactly the two frozen rows certify; the ratified
  `CHANGE_FEED + MONOTONIC_VERSION_PIN + DURABLE_TOKEN` is unchanged; **no silent-downgrade path exists**
  (every certifying cell returns its declared mode/lifetime byte-identical; refused certs throw rather than
  earning a recovery strategy).
- **Lens 3 (vacuity)** designed and ran **15 of its own mutations** — 10 red with exact assertion text. It
  proved the owner-mandated **async-window negative control is load-bearing in both directions** (green
  against the real lib; red against a shallow freeze; red against a deep-freeze-in-place variant), retiring
  the implementer's own caveat that it could only be shown by hand-copy.
- **Lens 1 (forgery)** ran 19 trust attacks + 5 scope attacks with positive controls first. **18/19 and 5/5
  failed closed** — hand-built clone, Proxy, duck-typed brand, prototype impostor, all three `Object.keys`
  blind spots (non-enumerable / symbol / prototype-chain), accessor identity-swap, async-window mutation,
  cross-binding replay, prototype pollution, sparse arrays, tenant/workspace scope forgery.
  **It also found the one blocking defect — §4.**

## 4. 本轮最重要的发现

### 4.1 P1（B1a，已发现并修复中）— 系统身份哈希建立在有损投影上

`deriveSystemContentKey` hashed `systemRecord.config`, but that config is returned as
`sanitizeIntegrationPayload(row.config)` — a **lossy projection** (sensitive-named keys redacted; depth 6 /
50 array items / 2000 chars truncated). Two systems differing only inside a redacted or truncated region hash
**identically**. The reviewer proved the consequence end-to-end: a qualification minted against a production
system still verified `verified: true` after that system was **repointed at an attacker endpoint** through
the production upsert path — five collision classes, three of them key-name-**independent**, so no allowlist
can close them. And because `canonicalObjectVersion` derives from `systemContentKey`, both system-identity
fields of the tuple collapsed together.

R3's core claim — "config A + system B is inexpressible" — did not hold as designed. The asymmetry that makes
the fix obvious: the **config plane already has the right guard** (recompute-and-compare against the stored
column, confirmed working), while the **system plane had neither a stored key nor a comparison**.

**Fixed and independently re-verified — CLOSED.** The fix reads identity from a **lossless** source
(`getExternalSystemForAdapter`, *required by the resolver factory* so the lossy path is unwireable), narrows
the record so decrypted credentials never reach assembly, and adds a **fail-closed witness**
(`assertLosslessSystemIdentityConfig`) that refuses any projected record before hashing. A fourth-round
reviewer built the attack from scratch — a memory DB that JSON-round-trips every write so the prototype
premise is **executed** rather than reasoned about, with the repoint driven through the production upsert
path and the stored row re-read and asserted changed — and all **5/5 collision classes now fail closed**
with `QUALIFICATION_DIGEST_MISMATCH`, with positive controls in both directions (a config the sanitizer
would mangle four ways still binds; credential rotation does not move the key). 25 mutations applied,
24 killed, 1 proven equivalent.

**A regression introduced by that fix was then found and fixed.** Reading identity losslessly put
unbounded-depth JSONB onto the **recursive** canonical codec: depth 5000 threw `RangeError`, **escaping the
frozen error vocabulary** — still fail-closed, but unclassified, which a wiring gate would surface as a 500
rather than a closed refusal (the pre-fix *lossy* read had hidden this by truncating at depth 6). Depth is
now a **rule** (`SYSTEM_IDENTITY_CONFIG_TOO_DEEP`, bound 64) enforced in the guard's iterative walk before
any hashing, plus a `RangeError`→closed-reason conversion as defense in depth. Mutation-verified both ways:
removing the rule reds the refusal tests; tightening the bound to 1 reds the depth-60 positive control, so
the bound is not "refuse everything". Two header sentences the reviewer falsified were corrected rather than
left standing.

### 4.2 P1（线文档,我的错,已更正）— 暴露面被我说小了

I told the owner that `copyData` "has no live caller" and framed the plugin offset path as merely
*reachable*. Independent review caught this, and I re-verified the chain myself:
`pipeline-runner.cjs` runs `while (page < maxPages)` advancing `cursor = readResult.nextCursor`, and the
`data-source:sql-readonly` adapter's non-watermark branch emits `nextCursor = String(offset + records.length)`
on a full page — so a pipeline over a SQL data source **already pages by OFFSET with no `orderBy` on any
page**, terminating on a short page evaluated against **live** data. The adapter's own guardrails self-declare
`offsetPagingOnly: true`. The gate is `!hasOwnKeys(request.watermark)`, **not** the pipeline mode — so an
*incremental* run also pages by offset until a watermark has been stored.

This **raises** the priority of the B1a ordering contract and of the migration that must precede B2. The
ledger (#4590) has been corrected at three sites.

### 4.3 探针只读守卫的方言化（已实证 → 已在 B1b 修复）

The qualification probe's read-only guard is **PostgreSQL-flavoured**. Running the real regex against probe
strings: `WAITFOR`, `EXEC xp_cmdshell`, `OPENROWSET`, `GET_LOCK`, `BENCHMARK`, `SLEEP`, `LOAD_FILE` **all
pass**, while the `INTO OUTFILE` control is correctly blocked and a legitimate probe still passes.
**Honest framing:** the guard is defense-in-depth and today only sees SQL from server-registered strategy
builders, so this is **not currently exploitable** — it is a latent hardening gap that becomes material the
moment non-PG dialects are registered, which is exactly what B1b does.

**B1b closed it, and its own review found more.** The implementer added a dialect token pattern plus an
MSSQL procedure-prefix pattern, and independently found PG's own members of the same classes
(`pg_sleep`, `pg_read_file`, `lo_import`/`lo_export`) that my list had missed. I re-ran the seven constructs
against the hardened guard myself: **7 → 0 pass**, with the legitimate probe positive control still passing.

The adversarial review then found **2 P1 + 4 P2 more**, the sharpest being that **SQL Server's lock-taking
class had ZERO coverage**: T-SQL has no `FOR UPDATE`/`FOR SHARE`, so the ratified token matches nothing a
T-SQL client can write — locks are taken with table hints (`WITH (UPDLOCK)`, `(NOLOCK)`, …), and
`WITH (NOLOCK)` is precisely the hint that destroys the read the new `sqlserver` strategy's snapshot token
describes. Also: the MySQL snapshot claim was **unpinned** (an overclaiming token survived every suite), and
`\b`-terminated tokens cannot match longer identifiers sharing a prefix (`pg_sleep_for`, `pg_ls_dir`,
`lo_get`, and the pre-existing `pg_advisory_lock_shared` all passed). These are in a fix round.

The two dialect snapshot claims are **honest rather than prestige-copied** — MySQL:
`single_statement_consistent_read_conditional_on_innodb_autocommit`; SQL Server:
`no_single_statement_snapshot_under_default_read_committed`, which states the guarantee is **absent** under
the engine default. Both tokens are digest-bearing, so they are permanent checkable markers rather than
disclaimers.

## 5. 交付物

| PR | content | state |
|---|---|---|
| **#4590** | line ledger — three review rounds absorbed + three corrections this round | all checks green |
| **#4591** | **B2** enforcement (offset guard + typed closed 422 + MSSQL fallback deletion) | Draft, 19/19 green, **merges LAST** |
| **#4593** | **B1c** page-sequence execution design (design-first) | 12/12 review findings closed |
| **#4594** | exposure-inventory tooling (schema-probing, values-free) | tests 53 → 89 |
| **#4596** | **B1a** latent contract + harness (883 lib + 1448 test) | Draft, latent, P1 closed |
| **#4597** | **B1b** dialect probe strategies + guard hardening | Draft, stacked on #4596 |

**All five open PRs: 0 failing checks.**

## 5b. 对抗审的净收益（本轮最值得记住的一点）

Automated adversarial review found **four defects the implementers did not**, each of a kind that reads
"fine" until someone builds the attack:

1. **B1a P1** — a system-identity hash over a *lossy* projection; proven by repointing a live system at an
   attacker endpoint and watching the stale qualification still verify.
2. **B1a regression** — the fix for (1) put unbounded-depth data on a *recursive* codec, so a hostile depth
   left the frozen error vocabulary as a bare `RangeError`.
3. **B1b P1** — SQL Server's lock-taking class had **zero** coverage, because T-SQL simply has no
   `FOR UPDATE`/`FOR SHARE` for the ratified token to match.
4. **B1b P1** — the MySQL snapshot claim was *unpinned*: an overclaiming token survived every suite that
   could observe it.

Three of the four were **false or over-strong claims**, not broken code — the class this line has been
burned by repeatedly. Every one is now either fixed with a mutation-proven guard, or narrowed in place to
what is actually measured, with the retraction written *first* so a reader who stops at line one is not
misled.

## 6. 剩余工作与门

1. **Owner decisions on the critical path** — (a) #4437 package policy execution (ruled: build+checksum+freeze
   a new complete RC-A exact-SHA containing `7bf2bd7a1`; authorization stops at build+verify+pointer, **not**
   deploy, **not** flag-ON); (b) ratify #4590 (unlocks B1a latent only); (c) inventory results decide whether
   migration is required.
2. **B1b (#4597)** — built and reviewed; retarget to `main` once B1a lands.
3. **B1-observability** — owner declined to open early; the M1 inventory therefore carries an explicit
   runtime residual rather than claiming a proven zero.
4. **B2 (#4591)** — merges LAST, after telemetry, coverage-mapped inventory, and customer migration.

**Nothing in this round authorizes runtime wiring, arming, `sealed_snapshot`, rollout, deployment, or a
flag flip.**
