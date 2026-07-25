# Database & System Integration Line — Design and Verification (2026-07-24)

**Status:** §1 is a **RECORD** of landed, verified facts (head-scoped SHAs). §2–§6 are **PROPOSED / design-first**; the document itself ships no code. What its approval unlocks is defined in **Gate** immediately below — a bounded **authority-substrate** gate, **not** "latent only". **§4 is the single authoritative slice order** and is currently **PENDING RE-RATIFICATION**.

**Gate (owner, 2026-07-24; ⟲B2 REVISED).** The earlier wording — *"unlocks only the B1a latent contract + harness slice"* — is **WITHDRAWN as self-contradictory**: §3.0's boundaries cannot be met inside a latent slice. A real **config v2** changes a **live approved-config validation path**, and the identity read / canonical contract registry / server-bound source executor add **internal derivation and connection paths**. Calling that "contract + harness only" would have let production-path changes land under a gate that never authorized them. The gate is therefore renamed for what it actually is:

> **B1a AUTHORITY-SUBSTRATE gate — PERMITTED, bounded:**
> - **additive** `orderingKeySpec` / `actionProfileVersion` acceptance in the approved-config validator — closed rejection on shape, and **no behaviour change for any config that omits them**;
> - a purpose-built **system identity read** that does **not** decrypt credentials (B-2);
> - a **first-party canonical object contract registry** and its version lookup (B-3);
> - a **server-bound source executor** — resolution-derived handle, first-party statement builders, restricted statement seam — plus certified source-column translation (B-1, B-4, B-6). ⟲B2-self This bullet **includes the bounded core-backend statement seam** of §3.2 (not request-reachable, accepts only strategy-minted statements); it is named here because every other bullet is plugin-layer, and a second-package production change permitted only by implication is the very thing owner finding P1-1 was raised about. ⟲B2-self **Credential and connection scope, stated rather than left silent:** this executor unavoidably needs connection material, so the "no credential decryption" line above governs the *identity read* and cannot govern the executor. Under this gate the executor may derive and hold a handle and may execute **only against a harness / fixture source**; **any connection to a live customer system is outside this gate** and belongs to §4 step 2's real-DB capability spike;
> - **removal or privatisation** of the legacy `probe()` entry point — ⟲B2-self this closes **B-1**'s first residual (the caller-supplied tuple / `keyColumns` path), **not B-4**; B-4 is closed in §4 step 3 by admitting builders on module-private identity;
> - the previously-designed B1a internals that are **not** request-reachable and are unchanged by ⟲B: full-tuple resolver (**minus** `canonicalObjectVersion`, which now comes from bullet 3's registry), deep-immutable resolution, `PAGED_READ_LEGAL_COMBINATIONS`, closed errors, hermetic harness (§4 step 1, "Retained") — **plus** §3.4's counter and handshake **contract shapes**, hermetic tests only, **no wiring**. ⟲B2-self This bullet exists because withdrawing the "latent contract + harness" clause withdrew the only sentence that authorized these artefacts, while §4 and §3.4 still schedule them — a regression this revision introduced, not an inherited one.
>
> **STILL FORBIDDEN — each its own later gate:** any HTTP route or otherwise request-reachable surface over the above **beyond the one carve-out below**; any **runtime consumer** of a GIP profile; arming / activation / rollout; telemetry or handshake **wiring** (B1-observability); the **B2 enforcement merge** (**#4591**); sealed-snapshot implementation; page-size ceiling changes; CDC / external write-back / D2 / W3 / G1 (frozen).
>
> **Boundary test — stated as a permission and a prohibition, not as a one-line slogan.** ⟲B2-self Two earlier drafts failed here. The first said *"reachable from a request or a scheduled run ⇒ outside the gate"*, which **excludes the gate's own first permitted item**; the second tried to save it with an "additive acceptance" carve-out, which still leaves *"config v2 makes a save request behave differently"* true and the test self-contradicting. The gate is therefore stated directly:
> - **PERMITTED on the existing draft/save path:** validation and persistence of the **new fields only**. Nothing else about that path changes.
> - **FORBIDDEN, reachable from a request or a scheduled run:** any **qualification execution**; any **read of an external source**; any **new side effect**; any **new route**.
>
> The approved-config validator is request-reachable — `POST /api/integration/read-source-configs` → `read-source-config-store.cjs` L212 `saveVersion` → `read-source-config.cjs` L139 `ALLOWED_CONFIG_KEYS` (`http-routes.cjs` L21, all @ `774bdb5e6`) — and §4 step 1.1 is the **only** in-gate item that touches it.

This is the line's single design-and-verification document (owner directive: consolidate closeout facts into one MD; stop letting working memos drift). It absorbs and supersedes the session working memos (`/tmp/gip-decision-memo-20260724.md`, `/tmp/b1-paged-read-certification-design-20260724.md` rev‑1) and the retired ad-hoc inventory SQL (NO-GO; §5).

Owner-review absorption markers used below: ⟲P1-a (ordering-key layering), ⟲P1-b (probe ≠ paged execution), ⟲P2-a (frozen combinations / no silent downgrade), ⟲P2-b (latent vs telemetry), ⟲P3-a (sealed snapshot not the sole exit). Codex-review absorptions (2026-07-24) are marked ⟲C1 (M0 exact-SHA package policy — BLOCKING), ⟲C2 (inventory-zero coverage map), ⟲C3 (#4580 re-cut + typed 422 as merge condition), ⟲C4 (orderBy = fail-fast, not stable pagination), ⟲C5 (per-capability routing, not per-brand). Owner ratify-review absorptions (2026-07-24, round 2) are marked ⟲R1 (exact-SHA exits: two-proof-only + freeze the new SHA), ⟲R2 (deep-immutable resolution, not provenance-only), ⟲R3 (full-tuple resolver), ⟲R4 (M1 = evidence only; the §4 order wins), ⟲R5 (combinations scoped to PAGED_READ), ⟲R6 (orderingKeySpec closed schema). Package/decision round (owner, 2026-07-24 late): ⟲R7 (complete-package two-SHA structure), plus three recorded decisions — package policy (b) with a build-only authorization boundary; B1-observability NOT opened early; B2 re-cut now as Draft **#4591**, superseding #4580. Qualification-authenticity round (owner, 2026-07-24, round 3): ⟲B (the six §3.0 boundaries). Boundary-review round (owner, 2026-07-24, round 4): ⟲B2 — authority-substrate gate replaces the self-contradictory "latent only" wording; `canonicalObjectVersion` = first-party contract version, drift belongs elsewhere; `systemContentKey` freeze material completed; §4 becomes the single authoritative order and is un-ratified until re-approved. ⟲Codex marks the doc-charter absorption. **⟲B2-self** marks defects **this revision itself introduced**, found in self-review before submission and corrected in place — they are tagged rather than silently fixed so a reader can see which sentences have already been wrong once.

**Upstream contracts this ledger defers to** (⟲B2-self added — their absence is how an implementation artefact
came to be quoted here as "the ratified formula"): **`GIP-D0` general integration platform design lock**
(`docs/development/gip-d0-general-integration-platform-design-lock-20260723.md`, landed on main via #4553
`a53a199b1`) — authoritative for `systemContentKey` / `roleBindingFingerprint` / `secretVersionId` and the
system-vs-config identity split; and the ratified certification contracts in
`gip-profile-certification-contracts.cjs`. Where this ledger and an upstream lock disagree, **the lock wins**
and this ledger is the thing to fix.

**Doc charter** ⟲Codex: this document is an **execution index + evidence ledger**. Authoritative contracts live in code and their own frozen design docs — referenced here by symbol + SHA, never copied — so this file cannot drift into another competing fact source. Model task cards derived from it must carry **symbol + exact head + acceptance predicate**, not bare line numbers.

---

## 1. RECORD — landed and verified

- **`bridge.bounded_read.v2` MERGED = `7bf2bd7a1`** (PR #4573, squash). **#4565 CLOSED unmerged** — its head `828aeb4d6` carries the pre-hardening fail-open and must never merge.
  - P1a (applied-limit): adapter `read()` verifies the agent-echoed applied limit — `data.limit` present ∧ positive integer ∧ equal to the requested clamp; missing / non-integer / divergent ⇒ fail-closed. `metadata.limit` is sourced from the **verified echo**, so downstream `short_page` reasoning is evidence-backed.
  - P1b (lineage): `profileId`/`actionProfileVersion` bumped to `.v2` — the qualification digest keys on `actionProfileVersion` only, so an authenticated old-v1 qualification now recomputes to `QUALIFICATION_DIGEST_MISMATCH` instead of surviving the hardening.
  - The profile remains **LATENT** (zero runtime consumers, proven by tree-wide grep at merge time). **Agent/protocol-version pin is a hard gate before any activation / arming / runtime wiring** (owner ruling: certification-scoped preflight; NOT the shared adapter; NOT a #4553 digest input).
- **#4583 MERGED = `68bcd9a670`** (data-source read-boundary A-knife):
  - MySQL A5 row bound enforced (previously **none**: an omitted limit issued a whole-table `SELECT`; an over-max limit was served verbatim — `manager.select` passes options straight through, so the adapter is the only chokepoint).
  - **Single frozen adapter registry**: `DEFAULT_ADAPTER_REGISTRY` is the one source; `SUPPORTED_DATA_SOURCE_TYPES` is derived from its keys; both `Object.freeze`d, with mutation-verified negative controls (assignment / replace / delete / push / splice all rejected at runtime).
  - Registry-derived A5 conformance: the suite instantiates from the production registry and derives the SQL set via `isSqlDialect()` — a newly registered SQL adapter is auto-covered (mutation-proven: an unbounded fake adapter grew the suite 11→14 and failed its three A5 cases with zero test edits).
  - Follow-up (P3, no dedicated PR): one freeze negative control keeps a literal six-type anchor (does not participate in coverage derivation); convert to a comment-marked deliberate anchor at next touch of that file.
- **B2 enforcement = #4591 (DRAFT, merges LAST)** ⟲C3 — pure re-cut from current main per owner ruling; **#4580 CLOSED as superseded** (its branch carried the A-half already landed via #4583 and went `DIRTY`). #4591 contents, exactly the owner-listed three: adapter-layer OFFSET-ordering fail-fast guard (offset > 0 without `orderBy` ⇒ fail-closed, all three SQL adapters; registry-derived conformance roster) + **typed closed 422** (`DataSourceOffsetOrderingError` / `DATA_SOURCE_OFFSET_ORDERING_REQUIRED` — previously every non-not-found `/select` failure surfaced as `SELECT_ERROR` 500; the mapping is closed, generic errors still 500, pinned by test) + deletion of MSSQL's non-deterministic `ORDER BY (SELECT NULL)` fallback. **Observability contracts deliberately excluded** (owner ruling — B1-observability slice, own gate). Mutation-verified both ways (guard-neuter reds the fail-closed cases; mapping-removal reds exactly the 422 case); suite 16/16; full unit suite green; `tsc` clean. ⟲C4 honest claim unchanged: fail-fast hardening only — uniqueness, same-order-from-page-1, and same-snapshot remain unproven until B1b/B1c. **Merge order and preconditions: §4 item 7** ⟲B2-self — this RECORD bullet previously carried a three-item precondition set of its own, which §4 (six preceding items) contradicts; §1 records landed facts and schedules nothing. M1 itself takes no merge decision.
- **Retired NO-GO**: the ad-hoc inventory SQL — four schema-fact errors (wrong status vocabulary — external-system status is `active/inactive/error`; `integration_pipeline_runs` does not exist, the real table is `integration_runs` per migration 057; no `metrics.pageCount`, real fields are `details`/`rows_read`; `data_sources` shape is inconsistent across migrations ⇒ schema probe first). Replacement: an **in-repo, tested** script run **per customer deployment**, combining DB counts + local `/select` access logs (+ the B1-observability counter once separately authorized). A central-DB count alone cannot prove the absence of on-site HTTP callers.

## 2. M0–M2 acceleration route (owner-set; amendments marked PROPOSED)

**M0 — ⟲B2-self TWO PHASES (§4's parallel track names both).** The old "24–48h, zero product code" headline
is stale against exit (b) below, which requires building, checksumming and controlled-deploying a new complete
package. **M0-A = authorized now** (build + verify the package, revise the #4437 pointer, prepare the bounded
config). **M0-B = ops-gated** (controlled deploy → flag-OFF health → preflight → flag-ON window → 11-item
PASS). The rest of this paragraph describes M0-B's acceptance content. Config owner creates a NEW approved config version (old versions untouched) bound to a provably single-page object — actual rows strictly below the agent-echoed effective limit. Flag-OFF preflight ⇒ `SHORT_PAGE`; then one C-stage flag-ON window; 11-item PASS ⇒ close #4437. ⟲C1 closure claim: that PASS closes #4437 as a **bounded-subset mechanism acceptance** — one tenant, one source; it claims **no large-scale capability**. Stop-loss: if no object can be safely narrowed, stop repeat acceptance and enter the M2 spike.
- ⟲C1 **BLOCKING package-policy decision (owner) — must be made BEFORE M0 runs.** #4437 froze RC-A at release `stock-prep-onprem-rc-a-20260717-d87e086fd` / exact SHA `d87e086fd12…` (2026-07-17, **predates** `7bf2bd7a1`) and forbids repackaging — so rev‑1's precheck "confirm the deployed image includes `7bf2bd7a1`" was **wrong**: it silently swaps the acceptance package against a frozen exact-SHA contract. Worse, the frozen package carries the **pre-hardening adapter**, whose `metadata.limit` is locally fabricated rather than echo-verified — the exact provenance hole #4573 closed — so its `SHORT_PAGE` result alone cannot close a completeness acceptance. ⟲R1 Sound options — **two mutually exclusive exits**: **(a)** keep `d87e086fd` — the old package is acceptable **only** with trusted `DECLARED_TOTAL` or a same-read-bound applied-limit proof; **for the legacy-SQL bridge both are structurally absent** (`DECLARED_TOTAL` is unreachable per the certified `bridge.bounded_read.v2`; the old package carries no in-band applied-limit proof) — so **(a) is empty for this source class**; **(b) recommended: the owner formally revises #4437 — publish, checksum, and FREEZE a new RC-A exact-SHA containing `7bf2bd7a1` — then run the narrowed `SHORT_PAGE` M0.** The config owner can prepare the bounded approved config in parallel under either option.
- ⟲R7 **"New RC-A package" = the COMPLETE on-prem deployment package, NOT the C-stage sidecar.** The sidecar ZIP carries only smoke helpers / PowerShell wrapper / PM2 sample / provenance — it does **not** contain `bridge-agent-readonly-adapter.cjs`; the #4573 fix lives in the server-side plugin. Exit (b) therefore means: build the complete on-prem package at the owner-chosen main SHA (recommended `7bf2bd7a1`, to avoid enlarging the runtime change surface); regenerate manifest + SHA256 + provenance + loopback verification; revise #4437 to record **`serviceRuntimeSha` and `clientHelperSha` separately** — the two smoke helpers are blob-identical between `d87e086fd` and `7bf2bd7a1`, so the helper content hash may carry over, but one `exactSha` must no longer conflate client and server; controlled deploy of the new service package; flag-OFF health verification; only then the bounded-config preflight. **Owner decision recorded — package policy = (b), authorization boundary strict: "build and verify the new complete RC-A package + revise the #4437 pointer" only; NOT deployment, NOT flag-ON — those remain ops-gated steps.**
- `/health` `version` capture (currently `0.1.0`): **asset inventory only** — it records which agent build is deployed; it proves nothing about protocol capability, limit-echo behaviour, or qualification compatibility.

**M1 (3–5 dev days, exactly two dev lines).**
- *Qualification line:* agent/protocol-version **certification-scoped preflight** (hard gate before activation/arming/runtime; does not block #4437).
- *Direct-DB line:* values-free inventory first — and ⟲C2 **"0" only carries migration meaning once the coverage relations and the observation window are explicit.** The evidence set and what each piece covers:
  1. DB inventory (approved configs / pipelines / `integration_runs`) — config-driven plugin reads;
  2. the deployment's full `/select` access log, **with stated retention scope and time window** — ad-hoc HTTP callers, within that window only;
  3. a static tree-wide enumeration of `manager.select` / `adapter.select` callers — in-repo direct entry
     points. ⚠️ **CORRECTED (verified 2026-07-24, independent review + my own re-verification): this group is
     materially LARGER than earlier stated in this document.** Beyond the `/select` route and
     `copyData` (which indeed has no live in-tree caller), there is a **shipped, live multi-page OFFSET
     reader**: `pipeline-runner.cjs` runs `while (page < maxPages)` advancing `cursor = readResult.nextCursor`,
     and the `data-source:sql-readonly` adapter's NON-watermark branch emits
     `nextCursor = String(offset + records.length)` on a full page — so a pipeline over a SQL data source
     pages by OFFSET **with no `orderBy` anywhere on the path**, stopping on a short page
     (`done: !fullPage`) evaluated against LIVE data. Earlier wording in this line implied the offset path
     was merely *reachable*; it is **exercised by shipped pipeline code**. Note the gate precisely: the
     adapter takes the offset branch whenever the request carries no watermark keys (`!hasOwnKeys(request.watermark)`),
     NOT merely when the pipeline mode is non-incremental — so an *incremental* run also pages by offset
     until a watermark has been stored. This raises, not lowers, the priority of the B1a ordering contract
     and the migration that must precede B2;
  4. values-free `unorderedOffsetAttemptCount` at **both** the route and the adapter entries — closes the runtime blind spot, but it is instrumentation. **Owner decision recorded: the B1-observability gate is NOT opened early** — it cannot accelerate #4437 and would add a new runtime deployment surface. M1's inventory therefore rests on items 1–3 and **must state this runtime residual explicitly** in the migration decision, not gloss it; the counter arrives in its §4 slot behind its own gate.

  ⟲R4 **M1 produces inventory evidence only — the B2 merge decision is NOT taken in M1.** Per §4, **#4591** (which superseded #4580) merges **LAST**, and only after adapter-chokepoint telemetry (B1-observability), the coverage-mapped caller inventory, and customer migration are complete: an HTTP access log cannot see plugin-internal or direct adapter callers, so "log-zero" alone can never green-light enforcement. This supersedes the earlier "inventory = 0 ⇒ merge B2" fast path (the conflict between that fast path and the §4 order is adjudicated in favour of §4). Standing rules regardless of counts: new paginated configs must declare a stable **unique** `orderBy` — ⟲C4 **fail-fast hardening, not stable-pagination certification** (presence-only; uniqueness, same-order-from-page-1, and same-snapshot remain unproven until B1b/B1c); any live configs found ⇒ versioned config migration + preflight rejection first; never auto-guess a primary-key order.
- Keep the existing Integration Workbench config/probe/approve UI — **no second connector configurator**. `stock-prep:read/operate` permission split at M1 end; the pilot runs under a controlled admin.

**M2 (only on real-scale evidence from M0/M1).** Ratify scale-D0 first; run the `bridge.sealed_snapshot` feasibility spike; compare "export + signed manifest" vs interactive paging on true change surface; only then decide async job / staging / generation flip / multiset SQL diff. CDC, external write-back, D2 reconciliation, W3 suggestion dates, G1 notifications stay **off** the critical path (frozen).

## 3. B1 design (REVISED — owner findings absorbed)

### 3.0 ⟲B — B1a REDO REQUIRED: six boundaries frozen (redo NOT started)

**Status.** ⟲B2-self Stated per slice — an earlier revision lumped both PRs together as "the first B1a
attempt", which #4597 is not:
- **First B1a attempt: #4596 `774bdb5e6` — HELD; redo REQUIRED and NOT STARTED.**
- **First B1b attempt: #4597 `d0313feec`** (stacked on it) — **HELD, and superseded by §4 steps 2-3**, which
  require the real-DB capability spike before any strategy may be registered. B-4 and B-5 below are findings
  against *this* PR; it is not retargeted to main.

⟲B2 The earlier heading "B1a IS REDONE" was misread-able as *implementation already redone* — it was never
that. What is done is that the boundaries below are **frozen into the design**; no redo code exists. Owner
review found four P1s and two P2s; they are written up as **six** boundaries because two of the P1s each
carry two independent requirements (B-1's source handle and field set; B-5's SQL Server and MySQL
guarantees), and B-6 collects the round's two P2s. Every finding is verified — three of them by me re-running
the reviewer's probe and, in one case, finding the defect to be *wider* than reported. The slice's own stated
goal — *forgery is inexpressible by construction* — was **not met**.

**B-1 · A qualification must prove the evidence came from the bound system.**
Two residuals, both **measured by the first attempt's own suite** and both pinned in
`__tests__/gip-binding-qualification-spike.test.cjs` **@ `774bdb5e6`** (⟲B2 symbol + exact head, per the doc
charter — the line numbers alone will rot, and the redo rewrites this file; ⟲B2 also: *not* the resolver
test, which is where an earlier revision of this paragraph wrongly pointed):
- `ratifiedPathRemainsAnOpenConstruction()` **L752-L805** — a qualification minted through the ratified
  `probe()` path over a **foreign field set** still verifies against the resolution, because evidence is
  values-free (`checkedKeyColumnCount` only) and verify therefore cannot see the field set;
- `callerSuppliedQueryRemainsAnOpenConstruction()` **L813-L847** — ONE caller-side answer that touches no
  system at all satisfies **two resolutions bound to different systems**, and both verify.

Both were recorded as accepted "residuals". That grading was wrong: **latency does not make an untrue
qualification trustworthy** — a qualification that verifies against evidence never observed on the bound
system is a false qualification whether or not anything consumes it yet. Required boundary: the source
handle is **derived from the resolution's own system record by a server-bound source executor**, and the
probed field set is derived from the resolution too; no caller may supply the query path. This is a
*precondition* of B1a, not a follow-up to it.

**B-2 · System identity comes from a dedicated lossless identity read — not from hashing the whole config.**

⟲B2-self **RETRACTION FIRST: this section previously said "the ratified formula hashes `config` whole." That
is FALSE.** It described **#4596's first implementation**, not the ratified spec, and the two are different —
which is the same mis-attribution class as citing the wrong test file, one layer up. The ledger had never
cited the design lock at all, which is how an implementation artefact came to be quoted as the contract.

**RATIFIED — `GIP-D0` design lock §6, landed on main via #4553** (`a53a199b1`,
`docs/development/gip-d0-general-integration-platform-design-lock-20260723.md`):

```
systemContentKey = hash( system/connector kind
                       + endpoint identity
                       + stable authPrincipalKey
                       + authTenantScopeKey )
```
with the boundaries fixed in the same lock: **object / filter / data-selection scope belongs to
`configContentKey`**; **`secretVersionId` enters security evidence and runtime re-verification only, never
business baseline lineage** (same principal, rotated key ⇒ **no** baseline rebuild; principal or data-permission
scope changes ⇒ re-verify and produce new lineage); and **`actionProfileVersion` must not move
`systemContentKey`** — upgrading the read implementation is not "the external system changed" (the profile is
pinned separately in `roleBindings[]`).

**WHAT #4596 ACTUALLY BUILT — a deviation from that lock, not an instance of it** (`deriveSystemContentKey`,
`lib/gip-approved-binding-resolver.cjs` L153-L169 @ `774bdb5e6`):

```
{ domain tag, systemId, tenantId, workspaceId, kind, role, config }      // `config` enters WHOLE
```

Three deviations, and the middle one is the one that matters:
- **`config` enters whole.** The external-system config is an open-shaped JSON object
  (`external-systems.cjs` L93 `config: jsonObject(input.config, 'config')` — no key allowlist), so every
  non-identity field a connector stores there joins the system identity. A config carrying a default object or
  filter makes an ordinary **config edit move the system content key** — precisely the split GIP-D0 §6 draws
  between `systemContentKey` and `configContentKey`.
- **`role` and the raw `systemId` / `tenantId` / `workspaceId` are added.** ⟲B2-self An earlier revision of
  this section proposed **keeping** `kind` *and* `role` and called it "completing the ratified formula". Wrong
  twice over: the ratified formula contains neither `role` nor the raw ids, so this was an **amendment
  presented as a completion**. Owner ruling: **do not add them** — `role` is an admission / capability
  re-verification item, and the binding + config already pin which system record is in play. If they are ever
  wanted, that is a **new amendment requiring its own ratification**, never a "completion".
- it obtains **decrypted credentials** through the adapter read only to discard them at the boundary — an
  unnecessarily wide permission surface for an identity derivation.

**The redo implements the ratified formula.** So the material below is not a new spec; it is GIP-D0 §6:

| INCLUDED (GIP-D0 §6) | note |
|---|---|
| system / connector **kind** | the same endpoint reached through a different connector kind is a **different** system |
| **endpoint identity** | a repoint must invalidate qualifications taken against the old endpoint |
| stable **`authPrincipalKey`** | the principal's identity — never its secret |
| **`authTenantScopeKey`** | the authenticated principal's **tenant / permission domain** — not our internal `tenantId`/`workspaceId` |

| EXCLUDED | why (per the lock) |
|---|---|
| object / filter / data-selection scope | carried by **`configContentKey`**; including it makes a config edit look like a system repoint |
| `secretVersionId`, credential material | security evidence + runtime re-verification only; a key rotation must **not** rebuild the business baseline |
| `actionProfileVersion` | pinned separately in `roleBindings[]`; upgrading the read implementation must not read as "the external system changed" |
| `role`, raw `systemId` / `tenantId` / `workspaceId` | ⟲B2-self not in the ratified formula; `role` is an admission/capability re-verification item, and binding/config already pin the system record. Adding them = a new **amendment**, not a completion |
| `name`, `status`, `capabilities`, `lastTestedAt`, `lastError` | mutable label and operational state; `status` is an **admission gate**, not identity |

**The implementation obligation the narrow formula carries — and it is real.** "Endpoint identity" and
"`authPrincipalKey`" must be *extracted* from the stored system record, and the config has **no schema**:
nothing states where a given connector kind keeps its endpoint or principal (`baseUrl`, `connectionString`,
`jdbcUrl`, `host`+`port`, something nested). An extraction that guesses is **silently blind** — a system
repointed through an undeclared key would keep its identity, which is the realized forgery #4596 was fixing.
Two mandatory conditions, and they are the reason #4596 over-corrected into hashing everything:
1. **A per-connector-kind certified identity declaration** — for each `kind`, which stored keys carry endpoint
   and principal. First-party and versioned, like the canonical object contract of B-3.
2. **Fail closed on an undeclared kind.** A system whose kind has no declaration is **refused**, never
   best-guessed, never hashed over a partial selection. Losslessness stays enforced at the read: the record is
   the **stored** one, never a sanitized projection — `assertLosslessSystemIdentityConfig`'s refusals are
   retained, since hashing `sanitizeIntegrationPayload`'s output was a **realized** forgery reproduced in five
   classes, three of them key-name-independent truncation.

**B-3 · `canonicalObjectVersion` pins a FIRST-PARTY canonical object contract version.**
⟲B2 **The earlier wording in this section was wrong about the field's job** and is withdrawn: it argued from
*"the code admits it cannot detect source-side schema drift"* (`gip-approved-binding-resolver.cjs`
L232-L252 @ `774bdb5e6`), which invites exactly the wrong
fix — an implementer would try to satisfy it by pushing **external database schema identity into the
canonical contract**. Correct division of responsibility:
- `canonicalObjectVersion` names the version of **our own first-party canonical object contract** — the
  declared canonical fields and semantics of the object, registered and versioned as a first-party artefact.
  Detecting source-side drift is **not** its job and never was.
- **External source schema drift** is carried by **source-catalog evidence**, by the **BindingQualification**,
  and by the **field-mapping qualification proof** — the artefacts actually observed against the live source.

So the real defect in the first attempt is not "it cannot witness the source schema"; it is that it
**invented the version locally**, deriving it from `systemContentKey + objectKey + fieldMap` — a pure
function of inputs **already present elsewhere in the same tuple**, which therefore adds no contract identity
whatsoever. It must be looked up from the first-party canonical object contract registry.

**B-4 · A probe SQL denylist is NOT a security boundary.**
`createProbeStrategyRegistry()` accepts an arbitrary `buildTotalOrderProbeSql`, so SQL-text inspection is the
wrong control surface. Verified — the owner supplied one bypass, and re-running it I found two more of the
same class. ⟲B2 Attribution, so this block is reproducible rather than asserted: guard =
`__internals.assertReadOnlySql` in `lib/gip-binding-qualification-spike.cjs` **@ `d0313feec`** (B1b lane),
whose token list is `RATIFIED_WRITE_TOKEN_PATTERN` + five dialect patterns.
```
control-pass  SELECT 1                                                  <- positive control: the guard is
                                                                           not a blanket refuser
PASSES        SELECT * FROM dblink('conn', 'DE' || 'LETE FROM x') AS t(x int)
PASSES        SELECT * FROM dblink('c', 'DR'||'OP TABLE x') AS t(x int)
PASSES        SELECT * FROM dblink('c', chr(68)||chr(69)||'LETE FROM x') AS t(x int)
BLOCKED       SELECT * FROM dblink('c', 'DELETE FROM x') AS t(x int)    <- negative control
              (PROBE_SQL_NOT_READ_ONLY)
```
Both controls are load-bearing: without the `SELECT 1` pass the block would also be produced by a guard that
refuses everything, and without the un-concatenated `DELETE` refusal it would also be produced by a guard
that is not wired at all. (First re-run of this probe reported all four as BLOCKED — a `TypeError` from
calling a non-exported symbol, caught by the same `catch` that was meant to observe refusals. The controls
are what exposed it.)
String concatenation defeats the token list; `chr()` defeats it with no literal keyword at all. The
7-constructs-to-0 result reported for B1b therefore measures resistance to **accidents, not construction**.
Required boundary: **only first-party builders registered by module-private identity**, or a **restricted
structured query constructor**. The denylist may remain as defense-in-depth; it may never be cited as the
boundary.

**B-5 · "Certified" requires a VERIFIED guarantee, not an honest label.**
B1b registered a SQL Server strategy whose own token reads
`no_single_statement_snapshot_under_default_read_committed` — and it still mints a candidate (verified).
Naming the absence of a guarantee does not fail closed; under the engine default it must **refuse
certification**. MySQL's token names three conditions (InnoDB, autocommit, isolation ≥ READ COMMITTED) and
the code checks **none** — they must be established **empirically on the same connection**. B1b's
certification gate does not open until a **real MySQL / SQL Server capability spike** passes.

**B-6 · Two namespace/closure gaps** (⟲B2-self retagged: these are the **round-3 ⟲B** set's two P2s — an
earlier revision marked them with a bare ⟲P2, which the legend already assigns to round-1 items).
⟲B `orderingKeySpec` `fieldId`s are canonical TARGET fields (the
resolver says so at `gip-approved-binding-resolver.cjs` L102-L120 @ `774bdb5e6`) but were passed straight to
the SQL builder — a **certified source-column translation** is required. ⟲B The production approved-config
allowlist (`read-source-config.cjs` `ALLOWED_CONFIG_KEYS`) does not accept `orderingKeySpec` or
`actionProfileVersion`, so the hermetic suite never exercised the real **save → approve → re-read → qualify**
loop; B1a is not provable until a real **config v2** carries these fields.

⟲B2-self **The translation's INPUT ARTEFACT DOES NOT EXIST — do not schedule this as a sub-bullet without
saying so.** The resolver header states it outright: the target → source-column translation *"needs a
per-system column mapping that does not exist today"* and *"a probe strategy may NOT guess it"*
(`gip-approved-binding-resolver.cjs` L102-L120 @ `774bdb5e6`). Worse than unbuilt, it may be **categorically
absent for this config shape**: a `fieldMap.source` is a **dotted HTTP response path** (`'Data.FQty'`) and a
`target` is a cleansing-zone column id (`'material_code'`), while the approved-config plane is HTTP-shaped
(`readPath` / `readMethod` / `containerPaths` are the allowlisted keys) and the probe emits **SQL identifiers**
against `objectKey` — so for an HTTP-shaped config **neither side of `fieldMap` is a SQL column**.
**Owner decision required, and it is a scope question, not an implementation detail:** either (a) name the
artefact that supplies per-system source column names and build it inside step 1.4, or (b) scope the
server-bound executor to **SQL-shaped sources only** for B1a and split the translation into its own gated
step. Until one is chosen, step 1.4 is **not** startable, and §4 says so rather than implying otherwise.

**Owner-set redo order for B1a:** real config v2 → system identity read with no credential decryption →
first-party canonical contract version → server-bound source executor with field translation → remove or
privatise the legacy `probe()` entry point. ⟲B2 It is transcribed into **§4 step 1**, which is the single
authoritative order; if this line and §4 ever disagree, **§4 wins**.

**Consequence for this line's status:** the earlier conclusion that *"the remaining critical path is owner
decisions, not engineering"* is **withdrawn** — there is real qualification-authenticity implementation work
remaining, and it is the largest unbuilt item on the line. The on-prem M0 track (complete RC-A package build
+ bounded approved config) is independent of B1a/B1b and may proceed in parallel.

### 3.1 ⟲P1-a — the certificate holds the REQUIREMENT; the config holds the FIELDS

The ratified certificate model already carries **`orderingKeyRequirement`** (contracts §certificate fields) — a capability-level *requirement*, never the customer's concrete columns. The concrete **`orderingKeySpec`** (ordered field list + directions) belongs to the **approved config version** (customer/binding-scoped, immutable per version). rev‑1 of this design put `orderingKeyFields` in the certificate — wrong layer; withdrawn.

**B1a core — server-side approved-binding resolver.** Input: `approvedConfigVersionId` (+ principal for authz). ⟲R3 The server derives the **complete qualification input tuple** — `{ actionProfileVersion, systemContentKey, configContentKey, objectKey, canonicalObjectVersion, orderingKeySpec }` — from the same tenant's approved **binding + config + system** records — ⟲B2-self **and, after ⟲B, from one
further first-party source: `canonicalObjectVersion` is LOOKED UP from the canonical object contract registry
(§3.0 B-3), never derived here.** The pre-⟲B formulation ("and from nothing else") reinstated exactly the
locally-invented derivation B-3 withdraws, in a paragraph §4 endorses as retained; the registry is a fourth
**server-side** source and is still never caller-suppliable, which is the property that clause existed to
protect. Apart from that field: from those records and nothing else. Binding only three fields (rev‑2's `{objectKey, orderingKeySpec, configContentKey}`) was insufficient: **any** digest input left caller-supplied re-opens the forgery as "config A + system-or-profile B". Requirements:
  - at resolution time, re-verify the version is STILL approved — **and still within the caller's tenant and scope** — through the existing **`getForRuntime()`** path (`readSourceConfigStore.getForRuntime`, called with scoped input; throws `NOT_APPROVED` for a non-approved version — approval, tenancy and scope are re-checked at resolution time, never assumed from the id);
  - the server **recomputes `configContentKey` from the immutable version body and compares** — it never blindly trusts a stored column;
  - **both probe and verify** re-enter through the resolver — no cached caller-side tuple is honoured;
  - callers cannot override **any** field of the tuple.

  The prober and the qualification-digest inputs accept ONLY this resolution object. Probe evidence stays values-free (`checkedKeyColumnCount` only — field names never enter evidence), so none of these forgeries could be detected after the fact — they must be **inexpressible**, not detectable.
- ⟲R2 **The resolution is deep-immutable, not merely provenance-checked.** WeakSet identity proves where the object came from; it does NOT stop a caller mutating a nested array (e.g. an `orderingKeySpec` entry) inside the probe's **async query window** — a shallow `Object.freeze` leaves nested structures writable. The resolution is therefore built as an **owned clone in the strict canonical-JSON domain, recursively frozen** — Proxy / accessor properties / sparse arrays / symbol keys **rejected** (`deepCloneFrozenCanonical` in `gip-canonical-json` is the reference primitive). **Mandated harness negative control:** mutate the ORIGINAL field array from inside the async query callback and prove the probe still uses the parse-time copy.
- Trust is **object identity** (module-private WeakSet), mirroring the existing probe-strategy registry pattern — a hand-built resolution object is refused.
- Owner adjudication recorded: `configContentKey` being a digest input is **necessary but not sufficient**; the resolver is what turns it into an actual binding.

⟲R6 **`orderingKeySpec` closed schema (frozen in B1a — a contract slice ships an implementable schema, not a slogan):**
- canonical `fieldId`s only — never raw SQL, expressions, or aliases;
- non-empty; duplicate `fieldId`s rejected;
- `direction ∈ {ASC, DESC}` only;
- every `fieldId` must resolve through the SAME approved config version's field mapping — unresolvable ⇒ closed rejection;
- NULLability is deliberately NOT a schema check: NULL keys stay **fail-closed at the qualification probe** (the duplicate/NULL probes), where they are observable against the live source.

### 3.2 ⟲P1-b — a probe certifies ORDER; it does not certify PAGING

`single_statement_mvcc` (and any B1b analog) certifies exactly **one probe statement** under one snapshot claim. It says nothing about a page *sequence*: `DataSourceManager.select()` is pool-per-call — no transaction or connection spans two pages today, and transaction objects cannot be passed into `select()`/`query()`.

Consequences, stated as scope:
- **B1b** (MySQL/MSSQL strategies) closes **total-order qualification** for those dialects — nothing more.
- **PAGED_READ certification additionally requires a page-sequence execution seam**: one certified consistency context spanning all pages (same-connection snapshot transaction, or a token-addressed immutable snapshot), with dialect-certified semantics and its own profile gate. That is **B1c**, design-first, not implied by B1a+B1b.
- Probe-execution seam note: probe SQL uses `GROUP BY`/`HAVING` shapes the structured facade cannot express, so a **restricted internal probe-executor seam** is needed — accepts ONLY strategy-minted statements (object-identity trust), read-only, statement-bounded, never reachable from HTTP input. Per the owner's dependency direction, core-backend contributes this bounded seam and nothing else; qualification definitions stay in the GIP layer. ⟲B2-self **Which slice owns it: B1a step 1.4** — it is named in the Gate's fourth permitted bullet, and **B1b merely consumes it**. The earlier wording ("B1b needs…") put the same artefact behind a different gate than the one authorizing it, and left a second-package (core-backend) production change permitted only by implication.

### 3.3 ⟲P2-a — frozen legal combinations; rejection, never silent downgrade

"`PAGED_READ` ⇒ consistency proofs non-empty" is too weak. The certifiable combinations are a **FROZEN table** (extending the existing scale-D0 §2 cross-dimension legality pattern), ⟲R5 **named `PAGED_READ_LEGAL_COMBINATIONS` and consulted ONLY when `acquisitionMode === 'PAGED_READ'`** — it is not a global gate over all modes:

| consistency proof | continuation lifetime |
|---|---|
| `SOURCE_SNAPSHOT_TXN` | `CONNECTION_BOUND` |
| `IMMUTABLE_SNAPSHOT_TOKEN` | `DURABLE_TOKEN` |

`MONOTONIC_VERSION_PIN` is deliberately **unmapped for `PAGED_READ`** in v1: a version pin *detects* drift; it does not make pages mutually consistent — abort-on-drift is a weaker, different contract that would need its own ratification before appearing here. ⟲R5 It **remains legal where already ratified in other modes** — specifically, the ratified `CHANGE_FEED + MONOTONIC_VERSION_PIN + DURABLE_TOKEN` combination is untouched. **Mandated harness negative-control pair:** the existing `CHANGE_FEED` combination still certifies, while an out-of-table `PAGED_READ` combination is refused.

Any other `PAGED_READ` combination ⇒ **closed rejection at certification time** (e.g. `PAGED_READ_COMBINATION_UNSUPPORTED`). **Never silently downgrade to `BOUNDED_READ`**: the profile is refused; a caller that wants bounded semantics certifies a separate bounded profile (the `bridge.bounded_read.v2` pattern — one door per capability).

### 3.4 ⟲P2-b — contracts may be latent; counters cannot

`unorderedOffsetAttemptCount` only means something as **runtime instrumentation**, and a capability handshake is only real at a **wired endpoint** — both are incompatible with "latent" by definition. Therefore B1a freezes the **counter and handshake contract shapes only** — ⟲B2 a statement about *these two artefacts*, not a claim that B1a as a whole is contract-only (see Gate) — with hermetic harness tests:
- counter: name + values-free semantics (counts only, no identifiers);
- handshake: request/response schema — `clientBuild` / `connectorProtocolVersion` / `profileId` / `configVersion` → `READY` / `UPGRADE_REQUIRED` / `CONFIG_MIGRATION_REQUIRED`, version-incompatible ⇒ refuse to run.

**Wiring either is B1-observability — §4 item 5, a separate runtime-authorization gate.** Freezing the two
shapes is **§4 step 1.6**, inside B1a. ⟲B2 Precision, since the authority-substrate gate does permit an
additive change to the approved-config validator: B1a **wires neither** the counter nor the handshake into any
live path, and the only thing it changes on a request path is **validation and persistence of the two new
config fields** (Gate). ⟲B2-self Two earlier formulations were false here — *"nothing in B1a touches a live
path"*, and its replacement *"adds no request-reachable surface"* — both for the same reason: the
approved-config validator is behind a live route.

### 3.5 ⟲P3-a — sealed snapshot's true scope

Sealed export is the **preferred** exit for the bridge / big-data / non-paginatable class (#4437's blocker class). It is **not** the sole exit for SQL sources: a direct SQL database may certify `PAGED_READ` once the B1c connection-bound snapshot reader exists. rev‑1's "multi-page consistency ⇒ sealed-export territory" is corrected to per-source-class — and ⟲C5 the routing decision is made **per capability spike** (does THIS source hold durable snapshots / stable cursors?), never uniformly per database brand.

## 4. Slice order — ⟲B2 PENDING RE-RATIFICATION; this section is the SINGLE authoritative order

**The previous order was ratified BEFORE §3.0 and is superseded.** It described B1a as *latent* and let B1b
register *certified* strategies directly — both now false. It is **un-ratified until the owner re-approves
this section**. Precedence rule, stated once and covering the whole document so two orders cannot coexist:
**§1 records landed facts only and schedules nothing; all sequencing and scope — including B2's
preconditions — is §4's.** Where §1, §2 or §3.x implies a different sequencing or scope, **§4 wins**.

1. **B1a (REDO)** — the authority substrate, in the owner-set order, each step landing behind the
   authority-substrate gate:
   1. **real config v2** — `orderingKeySpec` (closed schema, §3.1⟲R6) + `actionProfileVersion` accepted by
      the approved-config validator, additively; the existing test that asserts today's rejection **flips in
      the same PR**, and configs omitting the fields are unaffected. ⟲B2-self **Record the direction-case
      decision here, because this step is where the code says it belongs:** the same validator already carries
      a LOWERCASE vocabulary — `RESOLVER_SORT_DIRECTIONS = ['asc','desc']` for `resolverSortDirection`
      (`read-source-config.cjs` L27 @ `774bdb5e6`) — while ⟲R6 freezes `orderingKeySpec.direction` as
      UPPERCASE `ASC`/`DESC`, and the resolver header assigns the reconciliation to *"the gated change that
      adds `orderingKeySpec` to the config allowlist"*, i.e. this step. **Decision to ratify: keep both as
      they are** — `orderingKeySpec` uppercase-strict, `resolverSortDirection` lowercase — because a
      read-time normalizer would let two textually different approved bodies (different `configContentKey`s,
      different digests) behave identically, and the content key would stop pinning behaviour. Pin the choice
      by test in the same PR; do not leave the two vocabularies unremarked in one config body.
   2. **system identity read** — purpose-built, lossless, **no credential decryption**, implementing the
      **ratified GIP-D0 §6 formula** (§3.0 B-2) plus the per-connector-kind certified identity declaration and
      its fail-closed refusal for an undeclared kind;
   3. **first-party canonical object contract registry** + version lookup (**B-3**) — no locally invented
      version. ⟲B2-self **Open, and it must be closed before this step starts:** who registers a canonical
      object contract, what admits one, and what a **lookup miss** does. A lookup-only version needs a
      registered contract for every bindable `objectKey`; today every approved config derives one, so after
      the redo an unregistered object becomes **unbindable**. The miss must be a **named closed reason**, and
      the migration for currently-bindable configs must be stated, not discovered;
   4. **server-bound source executor** — handle and field set derived from the resolution, first-party
      statement builders admitted by **module-private identity** (**B-4**), restricted statement seam
      (including the bounded core-backend seam of §3.2), plus **certified source-column translation** for
      `orderingKeySpec` (**B-1**, **B-6**). ⟲B2-self **NOT STARTABLE until the owner picks (a) or (b) in
      §3.0 B-6** — the translation's input artefact, a per-system source column mapping, **does not exist**,
      and for an HTTP-shaped read-source config neither side of `fieldMap` is a SQL column at all;
   5. **remove or privatise the legacy `probe()` entry point** — ⟲B2-self this closes **B-1**'s first
      residual (the caller-supplied tuple / `keyColumns` path). It is **not** B-4's closure; B-4 is closed by
      1.4's builder identity and by step 3. An earlier revision tagged this (B-4) in two places;
   6. **freeze the counter + handshake contract shapes** (§3.4) — hermetic tests only, **no wiring**.
      ⟲B2-self Listed as a substep because withdrawing the "latent contract + harness" clause removed the only
      sentence that scheduled them.
   - Retained from the prior design, unchanged: approved-binding resolver over the full six-field tuple,
     deep-immutable (§3.1⟲R2/⟲R3) — **minus `canonicalObjectVersion`, which now comes from step 1.3's
     registry rather than being derived**; qualification input binding through the resolution object for
     **probe AND verify**; `PAGED_READ_LEGAL_COMBINATIONS` (§3.3⟲R5); closed errors; hermetic harness.
   - **Acceptance predicate — construction-level, split per residual.** ⟲B2-self An earlier version said
     simply "both residuals must invert", which fails twice: residual 1's construction goes through the
     exported `probe()` that step 1.5 removes, so it yields a **missing symbol**, not a refusal — and the
     cheapest way to satisfy "must produce a closed refusal" literally would be to **keep** `probe()` and add
     a check, i.e. *detection*, which B-1 explicitly rejects in favour of inexpressibility. Residual 2, by
     contrast, inverts the moment `query` leaves the resolution-bound input allowlist — so on its own it only
     measures "step 1.4 was performed":
     - **residual 1** (`ratifiedPathRemainsAnOpenConstruction`, L752-L805 @ `774bdb5e6`): `probe()` **absent
       from the module's exports**, pinned by a test that reds if it is ever re-exported — the case is
       **RETIRED as inexpressible**, not "refused". If it is privatised rather than removed, a **named closed
       reason** instead;
     - **residual 2** (`callerSuppliedQueryRemainsAnOpenConstruction`, L813-L847 @ `774bdb5e6`): a
       caller-supplied `query`/handle is refused with a **named closed reason**;
     - **NEW negative control, which is the one that actually carries B-1:** two resolutions bound to
       **different systems** must **not** both qualify from a single executor answer — i.e. the handle
       demonstrably derives from each resolution's own system record. Without this, the pair above proves
       only that an argument was removed;
     - **positive control:** a probe executed **through the server-bound executor against the harness
       source** still qualifies.
2. **B1b capability spike — REAL MySQL and SQL Server, before any certification.** Empirical only, on the
   **same connection**; mints **no certification** and registers **no strategy**. ⟲B2 This step did not exist
   in the ratified order and is the reason B1b shipped a strategy whose own token names the **absence** of a
   guarantee (**B-5**).
   - **MySQL:** InnoDB, autocommit, isolation ≥ READ COMMITTED — all three established empirically, not named
     in a token.
   - **SQL Server — ⟲B2-self freeze THREE outcomes, not one.** An earlier version asked only whether a
     single-statement snapshot is obtainable *under the engine default*, which fails safe but **silently
     discards two legitimate capabilities**:
     1. **default READ COMMITTED, no RCSI** ⇒ **refuse certification**;
     2. **RCSI enabled** ⇒ certifiable as its **own separate profile**, after same-connection empirical proof;
     3. **explicit SNAPSHOT transaction** ⇒ **must be proven by the later connection-bound seam (B1c)** — a
        single-statement B1b strategy may **not** claim it.
3. **B1b certification — opens ONLY if step 2 passes**, per dialect and per capability, never per brand.
   Each strategy carries a **verified** snapshot-semantics guarantee, registered per `actionProfileVersion`;
   where the guarantee is unobtainable it must **refuse certification** rather than mint a candidate.
   Builders are admitted by **module-private identity**; the SQL denylist is defence-in-depth and **may never
   be cited as the boundary** (**B-4**). Unbound ⇒ `PROBE_STRATEGY_UNBOUND` (existing, fail-closed by name).
   PostgreSQL reuses the shipped reference strategy.
4. **B1c** — cross-page snapshot/session executor: design + per-dialect certification of a page-sequence
   consistency context; and the only place an explicit SNAPSHOT transaction claim may be established.
5. **B1-observability** — counter + field-client handshake **wiring**. Separate runtime gate; owner decision
   recorded: **not opened early**. ⟲B2-self **Precondition, carried here because §4 wins over §2 and would
   otherwise unschedule an owner-ruled hard gate:** the **agent/protocol-version certification-scoped
   preflight** (§2 M1, §1) is a **hard gate before this item and before any activation / arming / runtime
   wiring**.
6. **Customer migration** — in-repo inventory script per deployment; migrate any live configs to the
   versioned shape.
7. **B2 = #4591 enforcement** (adapter ordering guard + typed closed 422 + MSSQL fallback deletion).
   **LAST**, after items 1-6. (#4580 CLOSED as superseded — see §1.)

**Out of this order, deliberately:** §2's **M2** is an evidence-gated track (scale-D0 ratification, sealed-
snapshot feasibility spike) — nothing in it is scheduled here, and it enters on M0/M1 evidence.

**Parallel and unblocked by all of the above: the on-prem M0 track, in TWO phases** — ⟲B2-self named as two,
because an earlier version listed only the first, and since §4 wins on scope that silently deleted the
preflight, the flag-ON window and #4437 closure from everything this document schedules:
- **M0-A (authorized now):** build and verify the complete RC-A package at the owner-chosen SHA, regenerate
  manifest / SHA256 / provenance / loopback verification, revise the #4437 pointer, and prepare the bounded
  approved config. **Not** deployment, **not** flag-ON.
- **M0-B (ops-gated, its own authorization):** controlled deploy of the new service package → flag-OFF health
  verification → bounded-config flag-OFF preflight (`SHORT_PAGE`) → one C-stage flag-ON window → 11-item PASS
  ⇒ closes #4437 as a bounded-subset mechanism acceptance.

## 5. Implementer landmines (session-verified; read before touching)

- **apps/web error-code tripwire**: `integrationErrorCodeLabels.spec.ts` pins the bridge-adapter error-code array (`length===4` + set equality). A new adapter-owned code requires the FE mirror in the same PR.
- **Agent/protocol version must NOT enter the #4553 qualification digest** (`actionProfileVersion` is the certified single version identity). It is a certification-scoped preflight (owner ruling).
- **The PG probe builder is PG-shaped** (double-quoted identifiers, `LIMIT 1`, `::int` casts) — not portable. MySQL (backticks/`LIMIT`) and MSSQL (brackets/`TOP`/`OFFSET…FETCH`, different isolation story) need their own certified builders (B1b).
- **Trust is object identity** (module-private WeakSet) for strategy registries and the B1a resolver — never duck-type or "brand" objects with public fields.
- **`/select` error mapping** (`routes/data-sources.ts`): the catch maps only "not found" → 404; everything else → 500. The closed-422 mapping is IMPLEMENTED in #4591 (`DataSourceOffsetOrderingError` → 422, closed: generic errors still 500).
- **Inventory scripts: schema-probe FIRST.** Real run table = `integration_runs` (migration 057); there is no `metrics.pageCount` (real fields `details`/`rows_read`); `data_sources` shape varies across migrations. Central-DB counts cannot prove the absence of on-site `/select` callers — per-deployment access logs are required.
- **The offset path is EXERCISED, not merely reachable** — `pipeline-runner.cjs`'s `while (page < maxPages)`
  loop pages the `data-source:sql-readonly` adapter's non-watermark branch via `nextCursor = offset + n`,
  with no `orderBy`. Any statement that the exposure is limited to `copyData` (no live caller) is WRONG.
- **#4580's branch carried the pre-split A-half** — RESOLVED: re-cut from current main as #4591; #4580 CLOSED as superseded. Do not revive the old branch.
- **Bridge feeder test fixtures must echo `data.limit`** — adapter v2 fail-closes without the echo (a fixture that omits it is not "the real agent", which always echoes).
- **Do not raise the 500 single-page bound; do not wire the latent GIP profile** — both owner-gated.
- ⟲B2 **Config v2 is now IN scope, and it is a LIVE validation path.** `read-source-config.cjs`'s
  `ALLOWED_CONFIG_KEYS` does not contain `orderingKeySpec` / `actionProfileVersion`, so a body carrying them
  is rejected **at save time today**, and the B1a suite asserts that rejection *behaviourally*. Adding the
  keys is **additive only** — closed rejection on shape, no behaviour change for configs that omit them —
  and the assertion that pins today's rejection must be **flipped in the same PR**, never deleted.
- ⟲B2 **`canonicalObjectVersion` is a first-party contract version.** Do not attempt to make it witness the
  external source's schema; drift belongs to source-catalog evidence / BindingQualification / field-mapping
  proof (§3.0 B-3). A derivation that is a pure function of the other tuple fields adds nothing.
- ⟲B2-self **`systemContentKey`'s contract is `GIP-D0` §6, NOT `deriveSystemContentKey` as shipped in
  #4596.** The ratified formula is `hash(kind + endpoint identity + authPrincipalKey + authTenantScopeKey)`;
  the shipped code hashes the whole `config` plus `role` and the raw ids, which is a **deviation**. Do not
  read the implementation as the spec — that mistake is what produced a whole round of this document. `role`
  and the raw ids stay **out**; adding them would be a new amendment needing its own ratification.

## 6. Fences

Nothing in this document authorizes: runtime enforcement (#4591/B2), arming or runtime wiring of any GIP
profile, telemetry/handshake wiring, sealed-snapshot implementation, page-size ceiling changes, CDC /
external write-back / D2 / W3 / G1 work (frozen), or rollout.

⟲B2 Approval unlocks the **B1a authority-substrate gate** as defined verbatim in **Gate** at the head of this
document — **not** "latent contract + harness only", which is withdrawn. That gate permits the **six** bounded
internal changes of §4 item 1 (⟲B2-self *six*, not five: the sixth covers the retained resolver / combinations
/ closed errors / harness and the counter-and-handshake shapes, which the withdrawn clause had been the only
thing authorizing). On the request path it permits **validation and persistence of the two new config fields
and nothing else**; qualification execution, external-source reads, new side effects and new routes stay
forbidden from any request or scheduled run. Every later slice re-enters its own gate. **§4 is itself pending
re-ratification** — until the owner re-approves it, nothing after **B1a (§4 item 1)** is scheduled by this
document, other than the parallel **M0-A** track.
