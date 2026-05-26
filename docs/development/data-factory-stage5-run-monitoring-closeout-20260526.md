# Data Factory — Stage 5 「运行监控」 Close-out (DF-N1 + DF-N1.5) - 2026-05-26

## Summary

The **运行监控 (Run Monitoring)** stage of the Data Factory 5-stage operator flow (#1844) is shipped, as **two separately-reviewed, front-end-only slices** on top of the **existing** integration-core runtime:

| Slice | PR | Squash | Scope |
|---|---|---|---|
| **DF-N1** — run-monitoring UI (read-only) | #1848 | `be87b4d96` | run rows (status / mode / triggeredBy / read·clean·**write**·**fail** / duration / timestamps / errorSummary) + expandable per-run **row-level results** (`run.details.targetWriteSummaries`, #1813 = #1839 RowResult) + read-only open dead-letter display |
| **DF-N1.5** — dead-letter replay (single manual) | #1857 | `ab8bc8803` | a **two-step-confirm** replay action on **open** dead-letters, surfacing the existing `POST /api/integration/dead-letters/:id/replay` route |

Both merged 2026-05-26. Net surface: `IntegrationWorkbenchView` 运行观察 → 运行监控 panel.

## Why two PRs (the boundary decision)

DF-N1 was opened with replay included. On review the maintainer split it: a slice literally named "运行监控" should be **read-only**, and replay **re-runs the pipeline = a real target/ERP write**. Folding a write action (however gated) into a monitoring slice muddies the boundary and buries the safety semantics. So replay was pulled, DF-N1 shipped read-only, and replay returned as **DF-N1.5** with its write-safety as the *primary* review subject.

**Lesson recorded:** keep write affordances out of read-only "监控/observation" slices; give them their own PR where idempotency / duplicate-write / permission can be the review focus.

## Replay safety (DF-N1.5 threat model — all test-locked)

- **Idempotency** — replay re-runs with the server-held source payload (same `idempotencyKeyFields`); duplicate writes are deduped by the pipeline/target. Backend invariant; UI sends only `{id, scope, mode}`.
- **Duplicate-write** — only-open render · two-step confirm · in-flight lock · `rowsFailed`-only success verdict (a write that landed but whose `markReplayed` bookkeeping failed reads as **success**, never a false retry prompt).
- **Permission** — backend `requireAccess(req, 'write')` → `403` surfaced; letter retained (panel is refresh-driven).
- **Two-step confirm** — `准备 Replay → 确认 Replay（会真实写入）`; the prepare click issues **zero** network calls.

## Lock posture (why this was permitted under the K3 Stage-1 lock)

Both slices are **front-end only** over **already-existing** runtime: reads (`/runs`, `/dead-letters`) and one already-live, already-tested route (`/replay`). **No** backend / migration / connector / OpenAPI / RBAC change; no new战线. This is the boundary that kept Stage 5 inside the lock — it surfaced runtime that already existed rather than building new platform.

## Explicitly NOT done — frozen, each a separate gated opt-in

Per the confirmed 阶段二 direction (#1838) and DF-N phasing (#1839), the following remain **frozen pending K3 PoC evidence** — the next Data Factory step is **the K3 GATE, not more building**:

- **DF-N2** — provenance / per-record lineage event contract.
- **DF-N3** — bounded retry of selected rows + stop rules + run policy + back-pressure (the orchestration DF-N1.5's single manual replay deliberately does *not* add).
- **DF-N4** — connector template catalog.
- Cross-pipeline monitoring; K3 Submit / Audit / BOM / multi-record push / read-list unlock; server-side reference auto-composition.

## References

- IA / 5-stage flow: `data-factory-user-flow-ia-design-20260526.md` (#1844) · direction & gating: `data-factory-hub-direction-20260525.md` (#1838) · run/provenance + DF-N phasing: `data-factory-nifi-inspired-run-provenance-design-20260526.md` (#1839).
- DF-N1: `data-factory-df-n1-run-monitoring-ui-{design,verification}-20260526.md` (#1848).
- DF-N1.5: `data-factory-df-n1_5-deadletter-replay-{design,verification}-20260526.md` (#1857).
- Backend (unchanged, surfaced here): `plugins/plugin-integration-core/lib/pipeline-runner.cjs` (`replayDeadLetter`) · `lib/http-routes.cjs` (`runsList` / `deadLettersList` / `deadLettersReplay`).
