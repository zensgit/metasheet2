# NiFi provenance ↔ MetaSheet DF-N2 — bounded benchmark (research) - 2026-05-26

## Status / purpose / method

**Research / 对标 only. Bounded to the provenance subsystem.** This is the
"有界 provenance 研究" alternative to a full NiFi source deep-dive — which #1838
explicitly defers to **after the K3 PoC GATE closes** ("a deep source study of
NiFi / Airbyte / Meltano connector internals = after the K3 PoC GATE closes").
It reads NiFi's provenance model from primary sources and maps it onto our
**already-merged** DF-N2 design (#1839 `ProvenanceEvent`) + the #1874 preference
(JSONB-on-existing-tables) to sharpen the DF-N2 N2-1/N2-2 tasks. **No build, no
new contract; integration-core stays frozen behind Gate 0.**

- **License:** Apache NiFi is **Apache-2.0** (permissive, not copyleft) → reading/
  adapting is legally fine. NiFi is Java/JVM, we are TS/Node → we **borrow patterns
  (ideas, not copyrightable expression), never copy code**. ALv2 attribution/NOTICE
  would only matter if we copied actual code (we won't).
- **Sources read** (master branch): `StandardProvenanceEventRecord.java`,
  `ProvenanceReporter.java`, `WriteAheadProvenanceRepository.java`, and the
  *Apache NiFi In Depth* doc (provenance section). Links in §6.
- **Scope discipline:** provenance only. No drift into connector-platform internals
  (that is the post-GATE deep study).

## 1. NiFi's provenance model (as read)

### 1a. Event record — fields
A NiFi provenance event (`StandardProvenanceEventRecord`) is an **immutable snapshot
of a FlowFile at a point in the flow**:

- **Core:** `eventId`, `eventTime`, `eventType`, **`eventDuration`**, `entryDate`, `lineageStartDate`.
- **Component (who did it):** `componentId`, `componentType`.
- **FlowFile identity + lineage graph:** `uuid`, **`parentUuids`**, **`childrenUuids`**.
- **External linkage:** `transitUri` (SEND/RECEIVE/FETCH), `sourceSystemFlowFileIdentifier`, `alternateIdentifierUri`, `sourceQueueIdentifier`.
- **Content claims (current + previous):** section/container/identifier/offset/size — **pointers to content, never the content itself**.
- **Attributes (before/after):** `previousAttributes`, `updatedAttributes`.
- **Human-readable:** `details`, `relationship` (for ROUTE).
- **Storage internals:** `storageFilename`, `storageByteOffset`.

### 1b. Event-type catalog (the verbs)
~16 types: `CREATE`, `RECEIVE`, `FETCH`, `SEND`, `REMOTE_INVOCATION`, `ADDINFO`
(associate), `FORK`, `JOIN`, `CLONE`, `CONTENT_MODIFIED`, `ATTRIBUTES_MODIFIED`,
`ROUTE`, `DROP`, `EXPIRE`, `REPLAY`, `DOWNLOAD`.

### 1c. Repository design
- **Two separated concerns:** an **EventStore** (write, durable) + an **EventIndex** (query). Write path writes to the store first, gets storage locations, then indexes.
- **EventStore:** partitioned **write-ahead log**, schema record writer, compression, 32KB blocks, unique id per event, striped across disk partitions for linear scale.
- **EventIndex:** **Apache Lucene**, sharded (to beat Lucene's 32-bit doc-id limit, enable time-range multithreaded search, and allow shard-level deletion); **periodic (not per-write) commits** → high throughput at the cost of ~1–2 min re-index on restart.
- **Rollover:** a rolling group of **16 log files**, rolled every ~30s, merged + compressed + indexed.
- **Retention is mandatory + bounded:** admin configures **max disk %** + **retention duration**; a background thread deletes oldest-first.

### 1d. Conceptual model
Per-event immutable snapshot of (attributes before/after) + (a **content pointer**, not a copy) + (lineage metadata). Lineage graph reconstructed via parent/child (FORK/JOIN/CLONE/ROUTE). Content-as-pointer enables **viewing data at a point in time and REPLAY** (re-run through a corrected flow / resend to a failed downstream). Trade-off it accepts: if content ages off before events do, you lose content-view but **keep lineage/metadata** — *durable lineage visibility over indefinite content archival*.

## 2. 对标 — NiFi ↔ our DF-N2

### 2a. Event model
| NiFi field | DF-N2 analog | Verdict |
|---|---|---|
| `eventId` / `eventTime` / `eventType` | `at` + `eventType` (+ a per-event id) | have it |
| **`eventDuration`** | — | **BORROW** → add `durationMs` (debug slow target writes) |
| `componentId` / `componentType` | — (implicit) | **BORROW** → add `step` (import/map/validate/push/writeback) + adapter/mappingVersion |
| `uuid` | **`rowId`** | direct analog |
| **`parentUuids` / `childrenUuids`** | — (we are 1:1 source→target) | **RESERVE, don't build** → extension point for future FORK/JOIN (BOM expansion / one-source→many-target) — **LOCKED** now |
| `transitUri` / `sourceSystemFlowFileIdentifier` | `sourceDatasetId`/`targetDatasetId` + `targetExternalId`/`targetBillNo` (#1839 RowResult) | already have safe identifiers |
| **content claim (pointer, not content)** | row snapshot in the cleansing multitable **raw area** (#1839) | **BORROW the discipline** → events store a *reference* (rowId+run+safe ids), **not** the payload — lightweight + natural redaction boundary |
| **`previousAttributes` / `updatedAttributes`** | — | **BORROW (redacted)** → for `row_edited`/`mapping_applied`, store a **before/after diff of field names + safe/preview values** (never raw secrets) — this is the "cleaned by step X" lineage |
| `details` / `relationship` | `errorCode`/`errorMessage` (#1839) | **BORROW `details`** as a safe human-readable per-event summary |
| `storageFilename` / `storageByteOffset` | n/a (JSONB column) | skip — NiFi WAL internals |

### 2b. Event-type catalog (16 NiFi ↔ 11 ours)
| NiFi | DF-N2 |
|---|---|
| RECEIVE / FETCH / CREATE | `source_read` / `row_imported` |
| ATTRIBUTES_MODIFIED / CONTENT_MODIFIED | `row_edited` (manual) + `mapping_applied` (transform) |
| ROUTE (+ relationship) | `validation_failed` → dead_letter routing |
| SEND | `target_write_attempted` / `_succeeded` / `_failed` |
| REPLAY | `row_retried` (we already ship replay — DF-N1.5 #1857) |
| DROP / EXPIRE | (gap) → consider adding **`row_skipped`** (maps #1839 `skipped` relationship) |
| FORK / JOIN / CLONE | none — reserved for future split/merge (locked) |
| DOWNLOAD / REMOTE_INVOCATION / ADDINFO | n/a / niche |
| — | **`dry_run_previewed`** = OUR value-add (NiFi has no dry-run-before-write) |
| — | **`validation_failed`** as a first-class event = OUR value-add (NiFi folds it into ROUTE) |

## 3. Borrow vs do-NOT-copy

**Do NOT copy (the biggest takeaway):** NiFi's **repository machinery** — WAL +
Lucene sharded index + 16 rolling logs + 30s rollover + disk partitioning — is
engineered for **massive, continuous, high-throughput streaming** at FlowFile grain.
Our scale is **bounded batch runs** (max-rows-per-run, operator-in-the-loop) on
**Postgres**. Building a Lucene-style event store for our volume = severe
over-engineering. **This directly validates the #1874 preference: JSONB on existing
tables + a by-`rowId` view, NOT a new event-store table/engine.**

**Borrow (principles, not machinery):**
1. **Write-path / query-path separation** — append events cheaply on the runner write path; serve queries via the by-`rowId` **view**. (Already our N2-2 shape — validated.)
2. **Content-pointer, not content-copy** — events reference the cleansing-table raw snapshot; never embed payloads. Lightweight + the redaction boundary falls out naturally.
3. **Mandatory bounded retention** — NiFi *always* ages off (disk% + duration). **This is a GAP in our current N2-2** (we only had a per-row cap). Add a retention/aging policy.
4. **Durability ordering** — NiFi writes the store before indexing. For us: append the event in the **same transaction** as the run/row write (don't lose events), or document at-least-once explicitly.
5. **Replay is first-class provenance** — record `row_retried` linked to the original run (already #1839's "retry creates a new run linked to the original").

## 4. Concrete deltas to fold into the DF-N2 task list (when N2 unlocks)

For **N2-1 (contract):**
- [ ] add `durationMs` (← eventDuration)
- [ ] add `step` / component identifier (← componentId/componentType)
- [ ] add a redacted **before/after diff** sub-shape for `row_edited`/`mapping_applied` (← previous/updatedAttributes)
- [ ] add `details` safe-summary string (← details)
- [ ] consider adding **`row_skipped`** event type (← DROP/EXPIRE + #1839 `skipped`)
- [ ] **reserve** (do NOT build) `parentRowId`/`childRowIds` for future FORK/JOIN — BOM/multi-target locked
- [ ] keep `dry_run_previewed` + `validation_failed` as first-class (our moat over NiFi)

For **N2-2 (runtime):**
- [ ] **NEW: provenance retention/aging policy** (run-count or time-based prune/archive) — borrow NiFi's bounded retention; our prior cap was per-row only
- [ ] confirm **content-pointer discipline** (events carry references + safe ids, not payloads)
- [ ] append events in the **same txn** as the run/row write (or document at-least-once)
- [ ] keep write-cheap / query-via-view separation

## 5. Alignment & divergence (the moat)

- **Aligned:** per-record immutable append-only history, lineage keyed by record id, content-as-pointer, bounded retention. Our DF-N2 is a faithful, **right-sized** adaptation — not a re-build of NiFi.
- **Divergent (ours to own):** NiFi is engineer-facing, headless, streaming, with **no business-validation and no dry-run**. We add `dry_run_previewed` + `validation_failed` as first-class events and surface lineage **in the operator grid** (N2-3). "Writing into a validating ERP" (MISSING_REFERENCE etc.) has no NiFi analog — it is the MetaSheet differentiator.

## 6. Sources

- `StandardProvenanceEventRecord.java` — https://github.com/apache/nifi/blob/master/nifi-commons/nifi-data-provenance-utils/src/main/java/org/apache/nifi/provenance/StandardProvenanceEventRecord.java
- `ProvenanceReporter.java` — https://github.com/apache/nifi/blob/master/nifi-api/src/main/java/org/apache/nifi/provenance/ProvenanceReporter.java
- `WriteAheadProvenanceRepository.java` — https://github.com/apache/nifi/blob/master/nifi-nar-bundles/nifi-provenance-repository-bundle/nifi-persistent-provenance-repository/src/main/java/org/apache/nifi/provenance/WriteAheadProvenanceRepository.java
- *Apache NiFi In Depth* — https://nifi.apache.org/docs/nifi-docs/html/nifi-in-depth.html
- License: Apache-2.0 (https://github.com/apache/nifi/blob/master/LICENSE)

## See also
- #1838 (direction/gating — defers deep source study to post-GATE) + #1874 (JSONB preference).
- #1839 (ProvenanceEvent design + DF-N0..N4). #1877 (阶段二 execution plan + DF-N2 task checklist — this note feeds its N2-1/N2-2 deltas). #1848/#1857 (DF-N1/N1.5 shipped).
