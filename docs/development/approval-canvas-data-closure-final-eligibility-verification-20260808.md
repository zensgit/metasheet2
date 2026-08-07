# Approval Canvas + Data Closure — Final Eligibility Verification (2026-08-08)

**Status:** ENGINEERING-READY FOR PRODUCT FINAL (owner UAT + staged flag ON **not** done)  
**Product-code base:** `origin/main@7c7d550dbfba175a8c29afe0f59ba06b2287303d`  
**Exact product head (this delivery):** `2332454ba0edadbabe72737143ded109d8a8522f` (includes live-graph history fix; base feature `6e98b36cfc`)  
**Branch:** `claude/approval-canvas-final-engineering-20260808`  
**Development companion:** `docs/development/approval-canvas-data-closure-final-eligibility-development-20260808.md`

This verification MD maps acceptance criteria to exact commands and counts. It does **not** claim product FINAL while owner gates remain open.

## 1. Acceptance criteria map

| # | Criterion | Evidence | Result |
|---|---|---|---|
| 1 | Ordinary-user authoring (flag default OFF) builds form + linear/condition/parallel without JSON/raw IDs; topology via typed commands; invalid fail-closed; undo/redo restores graph + selection | `approval-authoring-history.test.ts` + `approval-g5c-authoring-scenarios.test.ts` + mounted inspector + `TemplateAuthoringView` undo/redo wiring | **PASS** |
| 2 | G5-C S1–S12 automated product-path tests | `approval-g5c-authoring-scenarios.test.ts` (10 tests covering S1–S12 + fail-closed) | **PASS** |
| 3 | G5-R engineering holds: FWB gates, attachment flag-OFF, number fail-closed, flags default OFF | Backend unit suites below; featureDefaults in `featureFlags.ts` | **PASS** |
| 4 | Development + verification MD with SHAs, commands, honest FINAL eligibility | This file + development MD | **PASS** |

## 2. Commands and counts

### 2.1 Web authoring suite (gating)

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/approval-authoring-history.test.ts \
  tests/approval-g5c-authoring-scenarios.test.ts \
  tests/approval-canvas-commands.test.ts \
  tests/approval-form-commands.test.ts \
  tests/approval-graph-topology-edit.test.ts \
  tests/approval-template-version-diff.test.ts \
  tests/approval-version-graph-overlay.test.ts \
  tests/approval-template-authoring-canvas-inspector.spec.ts \
  tests/approval-graph-layout.test.ts \
  tests/featureFlagsApprovalAttachments.spec.ts
```

| Result | Count |
|---|---:|
| Test files | 10 passed |
| Tests | **129 passed** |
| Duration | ~1.9s |

Discriminating negatives included:

- Invalid move leaves history byte-identical (`approval-authoring-history`, G5-C fail-closed).  
- Topology throw surfaces business copy only (no internal keys).  
- Empty undo/redo fail closed.  
- Canvas command algebra suite 18/18 (prior D2-b).  
- **Inspector map retention:** reseed → mutate `approvalNodeEdits` → move on **live** graph retains `approvalMode`/`assigneeSources`; same move on stale `history.graph` wipe is the negative control (`approval-authoring-history` product-path case).  

Log capture (implementer scratch): `web-authoring-full.log`.

### 2.2 Backend / data-closure suite (gating)

```bash
pnpm --filter @metasheet/core-backend exec vitest run --watch=false \
  tests/unit/approval-canvas-flag.test.ts \
  tests/unit/approval-fwb-number-mapping-gate.test.ts \
  tests/unit/approval-fwb-permission-gates.test.ts \
  tests/unit/approval-attachment-validation.test.ts \
  tests/unit/approval-attachment-routes.test.ts \
  tests/unit/approval-template-routes.test.ts
```

| Suite focus | Result |
|---|---|
| Canvas flag defaults OFF | 6/6 |
| FWB number mapping rejected | 1/1 |
| FWB permission gates | 4/4 |
| Attachment validation + routes + flag-OFF | included in 68 tests across attachment/template route files |
| Combined listed run | **3 files / 68 tests** on last attachment/template batch; prior flag/number/permission batch **3 files / 11 tests** |

Observations:

- `hasUnavailableFwbNumberMapping` still rejects number targets.  
- Attachment flag OFF installs no delete/refs routes.  
- Canvas V2 enablement is explicit env only.  

Log capture: `data-closure.log`.

### 2.3 Required gates (gating)

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

| Gate | Result |
|---|---|
| `vue-tsc --noEmit` | **pass** (exit 0) |
| backend `tsc --noEmit` | **pass** (exit 0) |

Log capture: `required-gates.log`.

Full `run-required-web-tests.sh` was not re-run end-to-end in this session; the focused approval suites above are the load-bearing gates for this delta. CI required set remains the merge gate on PR.

### 2.4 Playwright (evidence / optional)

```text
Playwright not installed as a project dependency for apps/web;
no authoring page-load runner available in this environment.
Relied on mounted + unit gates.
```

Log capture: `playwright-unavailable.log`.

## 3. G5-C S1–S12 evidence index

| Scenario | Test location | Mechanism |
|---|---|---|
| S1 Form authoring | `approval-g5c-authoring-scenarios` + `approval-form-commands` | Real `addFormField` / `moveFormFieldByOffset` for all `AUTHORABLE_FIELD_TYPES` |
| S2 Linear | G5-C topology | `promoteLinearDraftToGraphAuthoring` + validity empty |
| S3 Condition | G5-C topology | `insertConditionGateway` via session |
| S4/S5 Parallel | G5-C topology | `insertParallelGateway` + `hasEmptyParallelBranch` false |
| S6 Dynamic assignee | G5-C S6 | `emptyAssigneePolicy` / `direct_manager` round-trip |
| S7 Route preview | G5-C S7 structural | Controller source does not create instances |
| S8 Hidden field | G5-C S8 | `fieldPermissions` hidden on approval config |
| S9 Version | G5-C S9 + version-diff tests | `diffApprovalTemplateVersions` + `buildVersionGraphOverlay` |
| S10 Legacy | G5-C S10 | Complex `draftFromTemplate` → `buildApprovalGraph` byte-stable |
| S11 Scale | G5-C S11 | 100-node `computeLayout` unique coords |
| S12 Accessible | G5-C S12 structural | List alternative + undo/redo + canvas default in view source |

## 4. Flag default proof (product code)

| Surface | Default |
|---|---|
| `apps/web/src/stores/featureFlags.ts` `DEFAULT_FEATURES` | `approvalCanvasV2: false`, `approvalFwbWriteback: false`, `approvalAttachments: false` |
| `isApprovalCanvasV2Enabled` | `APPROVAL_CANVAS_V2_ENABLED === 'true'` only |
| FWB / attachments | env `=== 'true'` only |

No product-code change in this delivery flips a default to ON.

## 5. FINAL eligibility verdict

| Claim | Allowed? |
|---|---|
| Engineering stack complete for G5-C product-path + mounted undo/history + canvas-first under flag | **YES** |
| G5-R number fail-closed + flag defaults + attachment flag-OFF still hold on this head | **YES** |
| Documentation with SHAs + command evidence | **YES** |
| **Product FINAL** (real-tenant UAT + staged flag ON + G0 ratify) | **NO** |

**Authoritative status string:**

> **ENGINEERING-READY FOR PRODUCT FINAL; NOT PRODUCT FINAL — owner UAT and staged flag enablement remain open.**

## 6. Owner-only remaining gates

1. G0 ratify of `approval-canvas-v2-interaction-design-lock-20260721.md` (and O3 layout engine choice if renderer migration is desired).  
2. Real-tenant UAT: form authoring, linear/condition/parallel publish+execute, route preview, FWB create/update, attachments, version restore.  
3. Staged enablement: durable → Class A → Class B → FWB → attachments / Canvas V2, with observation windows.  
4. Optional residual product polish: retire node button clusters; form palette drag; editor-embedded dual-canvas version UX.
