# Data Factory hub — direction confirmation & 阶段二 gating (research) - 2026-05-25

## Status / purpose

**Direction confirmation — NOT an architecture, NOT a build.** Captures the confirmed Data Factory hub model + prior-art takeaways (incl. Apache NiFi) + the open questions that MUST close (via the K3 PoC) **before** any full 阶段二 platform design. Docs/research only; no runtime; no full design; no build (Stage 1 Lock + PoC mid-flight).

## Confirmed model — multitable-as-hub (canonical中枢, N²→N)

```
external system ──import (source adapter)──▶  multitable HUB  ──export (target adapter)──▶ any target system
                                              (clean / validate;
                                               visible grid + formula + permissions)
success/fail today = pipeline run status + targetWriteSummaries (row-level, #1813) + dead-letters (replayable)
```

**Already-built skeleton (we are not starting from zero):** `metasheet-multitable-target` (import → multitable) · `metasheet-staging-source` (multitable → export) · `k3-wise-webapi` / `sqlserver` / `bridge-agent` / `plm-yuantus` / generic `http` adapters · `transform-engine` (clean DSL) · `contracts.cjs` (adapter contract) · `operations`/`capabilities` model · pipelines + runs + dead-letters + targetWriteSummaries.

**Moat / differentiator:** operator-in-the-loop **visual cleaning in the grid** (vs headless/engineer-only ETL). The K3 "reference completeness preview" (#1828) is the first instance.

## Prior-art takeaways (borrow, don't copy)

### Apache NiFi — strongest borrowables
- **Data provenance / per-record lineage** ← the #1 idea. Upgrade "success/fail records" from run/row-level to **per-record end-to-end lineage**: *this record → from system A → cleaned by step X → exported to B @ T → result + reason*. Best-in-class for cross-system trust + debugging, and directly answers the "对接成功/失败记录" goal at a deeper grain than today's run/row summaries.
- **Processor + controller-service split** ← config-driven connectors + **shared "controller services" for auth/transport** (e.g. a reusable K3 token/connection config referenced by many flows). Maps onto our adapter contract + the pluggable-auth lever.
- **Guaranteed delivery (content repo + write-ahead log) + back-pressure** ← durable, no-loss flow + throttling a slow / rate-limited target (like K3) — relevant once multi-record export unlocks.
- **Record processing + schema registry** ← informs the canonical model + per-system schema mapping.
- **Do NOT copy:** NiFi's engineer-facing flow-canvas UX + JVM heaviness — keep our **grid** (operator-friendly) + lightweight runtime; and NiFi has no ERP-write business-validation semantics (our K3 reference-object + row-level Save-evidence layer is ours to own).

### Yida (钉钉宜搭) FaaS connector — the custom-connector **escape-hatch**
Yida's "FaaS (云) 连接器" lets an integrator author a function (`execute()`, Java/Node/Python); the platform injects a context (`FaasInputs`: user/corp/token) + a helper SDK (call HTTP / other connectors / platform APIs), manages identity (RAM/SAML), and the connector is usable **both as a data source and inside automation flows**.
- **Borrowable — two-tier connector strategy:** (1) a **config-driven** generic connector covers most regular systems; (2) a **function escape-hatch** (author-written code + platform SDK + managed auth) covers the *weird long tail*. The weird system then needs **an integrator-written function, not a core-team PR** — the most direct cut to the "every new customer system = big core dev" problem (config tier ⇒ O(N); function tier ⇒ near-O(1) for the tail).
- **Also borrow:** platform-injected **context + helper SDK**, **managed credentials** (author never handles secrets — echoes NiFi controller-services), connector-level **logging / quota / governance**, and the **data-source + flow dual-use**.
- **Do NOT copy / avoid the traps:** don't bind to one cloud's function runtime (Yida hard-binds Aliyun FC + DingTalk identity — use a runtime/plugin model *we* control); don't replicate its **10s timeout** (the doc itself flags it as a common failure — design for longer/async); and a user-code connector demands real **sandboxing + resource limits + secret isolation**. Heavy → **阶段二+**, not now.

### Others
- **Singer tap/target spec + Meltano** — standardize the connector contract + incremental state (our `contracts.cjs` / `operations` / cursor = same idea; tighten toward it).
- **Airbyte / Fivetran** — connector catalog + schema discovery + CDC/incremental.
- **Hightouch / Census (reverse-ETL)** — hub → business-system write-back = exactly our multitable → K3 export.
- **dbt** — the transform layer (ours is visual/formula → more accessible to non-engineers).
- **EIP canonical model + hub-and-spoke** — the N²→N cost reduction.

## 阶段二 gating — design these AFTER the PoC answers them (NOT now)

Designing the full platform before these close = designing on sand. The K3 PoC is the evidence engine; let it finish first.

- **Read model** ← K3 O1/O5/O6 (customer) → the connector read shape.
- **Strict-target write-back semantics** ← K3 reference objects + row-level success (the PoC is validating this now) → the "writes into a validating system" connector pattern.
- **Reference / master-data resolution** ← #1711 → the reference-resolution engine.
- **Idempotency / dedup keys + incremental cursor / CDC.**
- **Permission / governance** (who may export to a production system) + the **provenance/audit** surface (NiFi-style lineage).
- **Back-pressure / batching** (when multi-record unlocks).

## Boundary

- Research / direction only; **no runtime, no full architecture, no build.**
- Full 阶段二 Connector-platform architecture + a deep source study of NiFi / Airbyte / Meltano connector internals = **after the K3 PoC GATE closes** (evidence in, search current).

## See also
- Project roadmap (4-stage ERP integration platform; currently 阶段一 K3 PoC).
- K3 read/list: #1709 (runtime track), #1711 (relationship/master mapping), #1593 (contract), #1792 (GATE).
- Today's K3 hub-proving chain: #1817 → #1824 → #1826 → #1828 → #1830 → #1832 → #1835.

## Addendum — 2026-05-26: implementation-path preferences (still gated, docs-only)

Two refinements recorded after a maintainer review of the NiFi-provenance and Yida-FaaS angles above. These are preferences for **if/when** each unlocks — **not** a build authorization. DF-N2 (provenance event) and the FaaS escape-hatch both remain **阶段二+**, gated on K3 PoC GATE evidence. No runtime, no migration, no full architecture in this note.

### NiFi provenance — when DF-N2 lands, prefer JSONB-on-existing-tables over a new event table
- #1839 deliberately leaves the implementation open ("existing logs vs JSONB vs new migration"). **Recommended first cut:** extend `integration_run_log` / `integration_exceptions` with a JSONB lineage field + a by-`rowId` query view, so per-record lineage (*this row → from system A → cleaned by step X → exported to B @ T → result + reason, **across runs/time/systems***) becomes queryable **without** a new table or new write path.
- Today's grain (`run.details.targetWriteSummaries`, capped 50 + sanitized; per-failure dead-letters) is **run-scoped** — tracing one record across multiple runs needs manual cross-reference. JSONB-by-`rowId` closes exactly that gap at the lowest migration cost — the priority under the K3 Stage-1 lock.
- A dedicated provenance table is the **heavy** version: defer until the PoC proves a cross-system, audit-grade need. Payload redaction stays mandatory (no tokens / passwords / connection strings).

### Yida FaaS escape-hatch — build on our own plugin sandbox, not a cloud FC
- **Whom it simplifies:** the operator-facing simplification is **already** the config tier (ConnectorProfile / DatasetDefinition / MappingRule / dry-run, #1839) + the 5-stage flow (#1844). FaaS does **not** simplify the operator — it cuts the **new-system onboarding cost** (long-tail system ⇒ an integrator-written function, not a core-team PR). Different axis, still valuable; don't conflate the two.
- **Substrate (when it unlocks):** host the function tier on the **existing microkernel sandbox** — `packages/core-backend/src/core/plugin-sandbox.ts` + `PluginIsolationManager.ts` + `enhanced-plugin-context.ts` — implementing the `plugins/plugin-integration-core/lib/contracts.cjs` 5-method contract (`testConnection` / `listObjects` / `getSchema` / `read` / `upsert`). **Not** Aliyun FC. (contracts.cjs already says the shape is plugin-local for M1, "wider platform exposure can come later after the K3 WISE PoC proves the shape" — same gate.)
- **Sequencing:** config tier first (O(N), covers regular systems); reserve the code tier for the long tail (≈O(1)).
- **Avoid Yida's traps:** no single-cloud runtime binding; no 10s-timeout copy (design long/async); treat user-code as a real security surface (sandbox + resource limits + secret isolation). Never expose an arbitrary-JS / raw-SQL transform editor to business users (also forbidden by #1839).
