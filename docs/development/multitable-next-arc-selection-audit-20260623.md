# Multitable Next-Arc Selection — fuller-pass audit (2026-06-23)

> Internal research (references 飞书/Lark for 对标 only). Scope: **next-arc selection validation** — after the
> restore line shipped, decide which arc to open next, scoped to three candidate areas (cross-base · dashboards ·
> history-restore continuations). Method: code deep-read (decisive) + a targeted 飞书/Lark benchmark refresh
> (confidence-tagged). Conclusion is a **single pick + why not the other two**.
>
> **Headline (and a reversal of my own light pass):** the "open cross-base / dashboards" instinct is wrong — both
> are already substantially built. The genuine unbuilt 对标 gaps are in **history-restore** (config history T9,
> table-PIT T8). **Recommended next arc: T9 config/schema history (read-side first).**

## 1. Current Baseline — shipped restore/history, layered

- **Read:** PIT view (T7, reconstruct as-of T) · per-record version history + value-diff (before→after) ·
  record-version preview (T5-2).
- **Write:** single-record restore-execute (forward revision) · per-field restore · scoped **batch** restore
  (BS-1 identity → BS-2 preview → BS-3 execute) · forward-only (`source='restore'`).
- **UI:** history drawer · single restore preview dialog · batch panel (BS-4, mix entry) · per-record outcomes.
- **Security:** per-subject field write gate (layer-3) · row-deny fan-out · version-bound `scopeHash` identity ·
  preview-identity binds the masked diff · reveal never composes · `expectedVersion` CAS.
- **Audit:** history audit log + reveal grant · stores field-ids/scope/reason, **never values** · formula-taint drop.

## 2. Benchmark Delta vs 飞书 Time Machine (history-restore) — confidence: HIGH (feishu.cn docs)

飞书's Time Machine: 180-day history of **table configuration AND data**; one-click **restore the table to a
historical version**; per-record + per-cell history view; restore is append-only; permissions are NOT restored.

| Capability | 飞书 Time Machine | MetaSheet | Delta |
|---|---|---|---|
| Per-cell / per-field history view | ✅ | ✅ value-diff | parity |
| Per-record history view | ✅ | ✅ | parity |
| **Granular per-record restore-to-version** | ✗ (view only) | ✅ preview→execute | **SURPASS** |
| **Batch (selected records) restore** | ✗ | ✅ BS-1..BS-4 | **SURPASS** |
| **Per-subject field/row write gate on restore** | ✗ (table-level; perms not restored) | ✅ layer-3 + row-deny | **SURPASS** |
| Restore append-only / logged | ✅ | ✅ | parity |
| **Table-level PIT restore (whole table → version)** | ✅ headline | ✗ (gated **T8**) | **GAP** |
| **Config/schema change history** | ✅ | ✗ (gated **T9**) | **GAP** |
| 180-day retention window | ✅ | ~ (retention/aging partial) | minor gap |

**Reading:** we have *surpassed* 飞书 on granular + batch + security; we are *behind* on table-PIT (T8) and
config/schema history (T9). The earlier "restore is purely ahead → continuations are icing" was wrong — T8/T9 are
real 对标 gaps.

## 3. The other two candidate areas — ruled out as the next arc

**Cross-base — relations are SHIPPED; only sync is a (niche) gap. Confidence: HIGH (code) / MEDIUM (benchmark).**
- Built: `foreignBaseId` cross-base links with the §2a.2 claim==truth permission wall; two-way/mirror links;
  cross-base **lookups** with mandatory foreign-field masking; **rollups**; relation functions
  (RELLOOKUP/RELSUMIF/RELAVGIF/RELCOUNTIF/RELVALUES); filter-by-link/lookup (design-locked + shipped).
- Not built: cross-base **data-sync** (snapshot-copy of records across bases). But 飞书's own cross-base sync is
  **beta**, and our live-link/lookup/rollup model is arguably superior to denormalized sync. → a narrow, low-urgency
  gap, **not** a Tier-1 arc. Opening "cross-base" as a big arc would be the *actually-decided* pitfall.

**Dashboards — RICH already; polish-away, not a gap. Confidence: MEDIUM-HIGH (code).**
- `dashboardWidgetSchema` + `/dashboard/query` + group-by/aggregate + numeric-metric gate; FE `MetaDashboardView`
  + `MetaChartRenderer` rendering number/table/gauge/pie/funnel/bar/line via ECharts. 飞书's dashboards are rich
  too, but this is **chart-variety / UX parity**, not a backend gap — a polish backlog, not an arc. (Per your rule:
  "if only UI polish, don't take the arc slot.")

## 4. Open gated items (the real candidates) — risk / value / dependency / entry

| Item | Risk | Value (对标) | Dependency | Recommended entry |
|---|---|---|---|---|
| **T9 config/schema history** | MED (new history surface for schema) | **HIGH** — real 飞书 gap; uncommon elsewhere → surpass-ceiling | independent program | **read-side first**: config-change history view, then restore; design-lock |
| **T8 table-level PIT restore** | **HIGH** — destructive (deletes post-T records) | HIGH — 飞书's headline Time Machine feature | needs rollback-semantics sign-off | owner decision + rollback design-lock; build last |
| **BS-3.1 all-or-nothing batch** | LOW (hugs merged batch write; `patchRecords` atomic) | LOW — no 飞书 pressure (they have no batch); completes our batch semantics | none (on BS-3) | mode flag + response shape; directly-buildable, opportunistic |

## 5. Newly-surfaced (non-restore) gaps — parked

- **Cross-base data-sync** — niche (see §3); park unless a named multi-base-aggregation need appears.
- **Dashboard chart-variety / UX polish** — backlog, not an arc.
- **Retention-window UX** — our retention/aging is partial vs 飞书's clean 180-day window; small, folds into T9/T8.

## 6. Ranked ladder + recommendation

| Rank | Arc | Readiness |
|---|---|---|
| **1 (recommended)** | **T9 config/schema history (read-side first)** | **needs design-lock** |
| 2 | T8 table-level PIT restore | needs owner decision + rollback design-lock |
| 3 | BS-3.1 all-or-nothing batch | directly-buildable (opportunistic) |
| — (parked) | cross-base data-sync · dashboard polish | design-lock / backlog, low urgency |

**Recommendation: open T9 config/schema history, read-side first (a config-change history view before any restore).**

- **Why T9, not cross-base:** cross-base *relations* are already shipped (links/lookups/rollups/functions/filters/
  masking/two-way). The only cross-base gap is sync, which is niche (飞书 beta; we have superior live-links). There
  is no big net-new cross-base arc left.
- **Why T9, not dashboards:** dashboards are already rich (ECharts multi-type backend+FE). The gap is polish, not an
  arc.
- **Why T9, not just "keep surpassing on restore writes (BS-3.1):** BS-3.1 has zero 对标 leverage (飞书 has no
  batch) and no named demand; it's a cheap opportunistic refinement, not the next *arc*.
- **Why read-side first:** T9's value is the config-change *history* (uncommon, high 对标 leverage); the destructive
  restore-config path is the heavy/risky half — defer it behind the read view + a design-lock, same discipline as
  the record line (read T5/T7 before write BS-1..BS-3).

**Caveat / where the owner overrules:** this picks a history-line continuation over a net-new arc *because the
net-new candidates are built* — not from inertia. If the strategic priority is net-new user-facing capability over
closing 对标 gaps, **cross-base data-sync** is the only net-new candidate left (but low-urgency). And the T9-vs-T8
order assumes config-*history* (read) outvalues table-*PIT* (write) as the first cut — flip it only if a destructive
"undo the whole table to yesterday" is the louder customer ask.

## 7. Confidence summary

- Cross-base relations shipped / dashboards rich: **HIGH** (direct code evidence) — these rule-outs are solid.
- 飞书 Time Machine has table-PIT + config-history: **HIGH** (feishu.cn docs).
- "Cross-base sync is niche / 飞书's is beta" and dashboard parity specifics: **MEDIUM** (light benchmark) — would
  firm up with a deeper Lark dashboard/sync feature sweep, but it does not change the pick (the code rule-outs do).
