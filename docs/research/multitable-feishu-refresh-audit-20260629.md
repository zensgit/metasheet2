# Multitable — Feishu refresh audit (2026-06-29)

**Purpose:** refresh the 对标飞书 capability ladder after the Time Machine / config-restore arc and the OAPI write runtime landed, and pick the next build arc. Supersedes the ranking in `multitable-feishu-benchmark-20260522.md` (this is a re-rank, not a re-derivation). Method: 4 parallel code surveys of origin/main + reconciliation against the on-main test suite (the surveys undercounted ~5 recently-shipped items; corrected below).

## 1. What changed since the 2026-05-22 benchmark
- **OAPI write shipped** (#3365, `225964451`): `records:write` (create/update/upsert/soft-delete) + `comments:write`, fail-closed allowlist, per-token rate-limit, in-txn fail-closed audit. The old "no write API" gap is now "runtime done; **ecosystem** remains" (HMAC signing, scoped tokens, fields/views scopes, SDK, docs site).
- **Time Machine / config-restore shipped** (Tier 1 sheet_config · Tier 2 field-retype · Tier 3 un-create · Tier 4 field-undelete · permission-revert de-escalation-only) — all on main, **default-off flags**. A prior ladder item, now built (enablement pending, not build).
- **Formula-over-lookup** arc closed; **cross-base read-only mirror v1** landed (`b3ac8c692`).

## 2. Reconciled capability map (current, on main)
**Mature / shipped:**
- **Views (9):** grid, kanban, calendar, gallery, form, timeline, gantt, hierarchy, dashboard — all shipped.
- **Fields (35):** text/longText(rich)/number/currency/percent/select/multiSelect/date/dateTime/boolean/link(two-way + cross-base read-only mirror)/person/attachment/rating/barcode/qrcode/location/url/email/phone/button + system (autoNumber/created·modified time·by). **Computed:** formula (43 fns + dry-run), lookup, rollup. **Conditional formatting** (operator + scale rules).
- **Permissions:** sheet/view/field/record scopes + **conditional-read-rules + row-level read-deny** ✓ + public forms. Field-mask-aware reads/history. *(Surveys wrongly marked conditional-read/row-deny absent — confirmed shipped: `multitable-rowlevel-readdeny-enforce`, `multitable-conditional-rule-enforce-realdb`.)*
- **Automation:** triggers (record/field-change/schedule/webhook), actions (CRUD incl. **cross-base write** via `evaluateCrossBaseWrite`, notification/email/webhook/DingTalk, lock, start-approval), conditions, condition/parallel branches, suspend/resume. **Approvals** (graph executor, templates, SLA). **Webhooks** (HMAC outbound, retry/lease, event bridge).
- **AI:** shortcuts (preview/run, masked), **bulk-fill (preview/commit/job)** ✓, suggest-formula, usage ledger/quota. *(Survey wrongly marked bulk-fill absent — confirmed: `multitable-ai-bulk-commit`.)*
- **Collaboration:** comments/reactions/mentions/inbox/presence-summary; history (record-version + field-level value-diff, masked) + operation audit; **restore** (record-version + **scoped/batch** ✓ + **recycle-bin** ✓ + config-restore). *(Surveys wrongly marked recycle-bin/batch-restore/config-restore absent — confirmed: `multitable-record-recycle-bin`, `multitable-restore-batch-execute-realdb`.)*
- **Integration:** read data-source adapters (MySQL/PG/Mongo/ES/HTTP/Athena/MSSQL-rw/PLM); federation cross-base read.

**Partial:**
- **Cross-base:** read (federation, layer-1/2 gates) ✓ + write-via-automation ✓ + link read-only mirror v1 ✓. **Missing:** cross-base **two-way** links (lift in progress), cross-base automation **triggers**, **cascade** delete/sync, per-target-base **governance/quota**.
- **Real-time co-editing:** Yjs/CRDT persistence + field-level presence + REST→Yjs invalidation ✓. **Missing:** live cursors, cell-level awareness broadcast (presence is on-demand, not pushed).
- **OAPI ecosystem:** runtime done; missing HMAC request signing, per-base scoped tokens, `fields:write`/`views:*` scopes, bulk, SDK publish, docs site, rate-limit dashboard.

**Notable absences (polish):** richText-as-distinct-type (uses `longText.rich`), time-only/duration fields, **live-reactive** formula recompute (on-save only), public **read** links (forms are submit-only), grid **virtualization** at 100k+ rows, BI per-group aggregation footer, rich notification content.

## 3. Genuine remaining gaps vs Feishu (reconciled)
The feature surface is broad; the real gaps are **depth/scale/polish**, not breadth:
1. **Cross-base relational completion** — two-way links, automation triggers, cascade, governance. (Partial today.)
2. **Real-time co-editing feel** — live cursors + cell presence. (Backbone exists; awareness layer missing.)
3. **OAPI ecosystem** — HMAC signing, scoped tokens, fields/views scopes, SDK, docs. (Runtime done.)
4. **Grid performance/virtualization** — 100k+ rows. (Scale, not feature; measure-first.)
5. **Permission golden matrix** — the 5-class capabilities exist but lack a unified parity/contract test (also the #3365 allowlist⟺guard dual-reachability test).
6. **AI field types** — native summarize/classify/extract/generate fields (shortcuts+bulk exist; field-types don't).
7. **Bulk import** (CSV/XLSX) + polish (richText type, time/duration fields, live formulas, public read links, BI footer).

## 4. Re-ranked ladder (next build arc candidates)
**Tier A — strongest next-arc candidates:**
1. **Cross-base relational completion** — *foundation in place* (read + automation-write + read-only mirror), clear multi-slice lift (mirror→two-way → triggers → cascade/governance), and the core "relational beyond one table" differentiator. Pre-teed; prereqs met. **Highest capability value at lowest greenfield risk.**
2. **Real-time co-editing (live cursors / cell presence)** — highest *perceived* value (the "feels collaborative" parity gap); Yjs backbone exists; but frontend-heavy + an awareness-broadcast protocol.
3. **OAPI ecosystem** — runtime done; remaining slices are small and high-leverage for integration (webhook HMAC = days; scoped tokens next). Lower differentiation; good as quick-wins between bigger arcs.

**Tier B — important, not the immediate arc:**
4. Permission golden matrix (hardening/enterprise-trust; includes the #3365 dual-reachability test).
5. Grid performance/virtualization (scale; **measure-first** to size it).
6. AI field types (provider-readiness already shipped; ~4–6wk arc).
7. Bulk import + field/formula polish (richText type, time/duration, live formulas, public read links, BI footer).

## 5. Recommendation
**Next build arc: cross-base relational completion.** It is the pre-teed candidate, it's *partial-with-a-clear-lift* (not greenfield), it advances the strongest strategic axis (relational data is core to surpassing Feishu), and the foundation (federation read, automation cross-base write, read-only mirror v1) de-risks it. Suggested slice order, each design-lock-first like the config-restore arc: **(1)** lift the read-only mirror → cross-base **two-way** links; **(2)** cross-base automation **triggers** (base-A rule on base-B change); **(3)** cross-base **cascade** (delete/sync) + per-target-base **governance/quota**. Slice (1) alone is a shippable increment.

*Alternatives, if priorities differ:* pick **real-time co-editing** if UX-parity perception is the priority this quarter; pick **OAPI ecosystem** (start: webhook HMAC + scoped tokens) if third-party integration / partner enablement is the priority — both are defensible, smaller-footprint arcs.

## 6. Launch gates (NOT ladder items)
These are enablement/hardening, decoupled from the next build arc:
- **T9-W flag-on enablement** — a flag-on live smoke per tier before enabling any config-restore flag.
- **permission-revert TOCTOU** — forward grant/revoke routes must take the same sheet lock as the revert (or a conditional/versioned write) + a two-concurrent-writers golden, before `MULTITABLE_ENABLE_PERMISSION_REVERT` is enabled.
- **#3365 allowlist⟺guard dual-reachability test** — pin that the OAPI allowlist set equals the set of `apiTokenAuth`-guarded routes (currently lockstep-by-hand).
