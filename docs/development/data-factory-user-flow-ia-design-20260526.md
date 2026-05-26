# Data Factory — User Flow & Information Architecture Design - 2026-05-26

## Scope

The **UX / workflow information-architecture** layer of the Data Factory. **Docs-only; no runtime.** It absorbs Yida (钉钉宜搭)'s proven operator structure into MetaSheet's multitable-first model and defines the **screens / flow / navigation** — it does **not** re-derive the data model or unlock any frozen surface.

## Relationship to adjacent Data Factory decisions (family)

- `data-factory-hub-direction-20260525.md` / **#1838** = direction & gating (umbrella).
- `data-factory-nifi-inspired-run-provenance-design-20260526.md` / **#1839** = run/provenance + **core object data model** (ConnectorProfile / DatasetDefinition / CleansingTable / MappingRule / PipelineRun / RowResult / ProvenanceEvent).
- **This doc = the user-facing workflow & IA on top.** It **references, does NOT re-derive**, #1839's objects, **#1826** (K3 reference-mapping UI contract), and **#1835 / #1709** (read-only unlock decision / read-list runtime track). K3 WISE remains a **preset**, not the product center.

This is the **third and final** doc of the 阶段二 design seed set (direction + data-model + UX/IA); further detail waits for K3 PoC evidence (per #1838 gating).

## Why an IA layer (absorbing Yida's structure, not its engine)

Yida benchmarks a clean operator workflow: **数据源 → 数据集 → 数据准备 → 测试发布 → 运行监控**. We absorb that *structure* into the **multitable-first** model — the operator-in-the-loop **visual cleaning** moat — **without** Yida's heavier pieces (no flow canvas, no arbitrary user code, no raw SQL editor).

## The 5-stage operator workflow (IA)

| # | Stage (Yida → MetaSheet) | Screen / flow | Anchored to (reference, not re-derive) |
|---|---|---|---|
| 1 | **数据源 / Source** | Connect an external system; test connection; list saved sources | #1839 ConnectorProfile · auth via existing token (#1835); a source may be **import-only until read is unlocked** (#1709/S3) |
| 2 | **数据集 / Dataset** | Choose what to import (Material/BOM presets); field/object selection | #1839 DatasetDefinition · K3 Material/BOM presets |
| 3 | **数据准备 / Data prep (the moat)** | Imported rows land in a **cleansing multitable**; operator cleans visually (formula / views / manual) + **reference-completeness preview** flags unresolved + per-field **shape** config | #1839 CleansingTable · **#1828** (completeness preview, shipped) · **#1832** (A4 shape persistence, shipped) |
| 4 | **测试发布 / Test & publish** | **Dry-run** preview (no write) → bounded **Save-only** publish under GATE rules; client-side Save guard | #1826 **C5** (client-side guard) · **#1830** (Save-only rollback gate, R1–R8) · K3 = Save-only / one-record |
| 5 | **运行监控 / Run monitoring** | Run history + row-level results + provenance/lineage + dead-letters + retry of selected failed rows | #1839 PipelineRun / RowResult / ProvenanceEvent · existing `integration_run_log` / `integration_exceptions` |

## Navigation / IA principles

- One **Data Factory** entry → the 5 stages as a **guided linear flow** (a stepper, **not** a free-form flow canvas).
- Each stage is **multitable-anchored** (the grid is the working surface), keeping the operator-first, non-engineer UX that differentiates from code/canvas ETL.
- Stage availability reflects capability: e.g. stage 1/2 import works today; stage 3 cleaning + completeness is live (#1828/#1832); stage 4 publish is GATE-bounded; stage 5 monitoring surfaces existing run/exception data first (#1839 DF-N1).

## Boundaries / non-goals

- **No runtime.** UX implementation is a **later, separate gated opt-in** — each screen/feature is its own gated PR; nothing is auto-built from this design.
- **References, does not re-derive** the #1839 data model, #1826 contract, or #1709 read decision.
- No NiFi-style flow canvas · no arbitrary user code · no raw SQL editor for business users.
- No K3 Submit/Audit · no BOM · no multi-record push · no read/list unlock · no server-pipeline reference auto-composition.
- K3 WISE = preset, not product center.

## See also
- #1838 (direction/gating) · #1839 (run/provenance + data model) · #1826 (ref-mapping contract) · #1835/#1709 (read decision/track) · #1828 (completeness preview) · #1832 (A4 shape) · #1830 (rollback gate) · #1792 (GATE).
