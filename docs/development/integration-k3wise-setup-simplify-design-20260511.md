# K3 WISE Setup Page Simplification Design - 2026-05-11

## Goal

Reduce first-run operator friction on the K3 WISE integration page without changing backend contracts, stored payloads, plugin APIs, migrations, or deployment packaging.

The page had grown from a connection form into a full integration cockpit:

- K3 WISE WebAPI configuration
- WebAPI credentials
- endpoint path tuning
- SQL Server channel setup
- staging multitable installation
- pipeline template creation
- dry-run/live execution
- run/dead-letter observation

All of those capabilities are useful, but showing them all at once made the first deployment path look harder than it is.

## Product Position

The ERP page should not become a mini ERP administration system. It should be the control surface for:

1. Connecting K3 WISE.
2. Preparing staging multitables.
3. Creating the PLM-to-K3 cleansing pipelines.
4. Running dry-run/live execution after explicit operator review.

The actual data cleaning experience remains in the multitable staging layer. This keeps the product centered on MetaSheet rather than turning the integration page into the place where users fix material and BOM data row by row.

## Implementation

Changed file:

- `apps/web/src/views/IntegrationK3WiseSetupView.vue`

Test file:

- `apps/web/tests/IntegrationK3WiseSetupView.spec.ts`

The UI is reorganized as follows:

1. Added a four-step journey strip:
   - connect K3
   - prepare multitables
   - create cleansing pipelines
   - dry-run before push

2. Merged the first-run fields into one primary `基础连接` section:
   - tenant/workspace
   - system name
   - K3 version/environment
   - WebAPI base URL
   - auth mode
   - authority code or login credentials

3. Folded expert-only WebAPI controls into `高级 WebAPI 设置`:
   - token/login/health paths
   - LCID
   - timeout
   - Submit/Audit flags
   - material/BOM endpoint paths

4. Folded SQL Server channel setup into `SQL Server 通道`.

5. Renamed and narrowed the visible pipeline section to `多维表清洗准备`.
   It now foregrounds staging and pipeline preparation instead of live execution knobs.

6. Folded pipeline IDs and run controls into `Pipeline 执行参数`.

7. Folded side-rail `执行 Pipeline` and `运行观察` panels by default.

## Non-Goals

No changes were made to:

- `plugins/plugin-integration-core`
- backend routes
- API request/response schemas
- migrations
- K3 adapter behavior
- pipeline payload builders
- deployment package scripts

The existing field models and `buildK3WiseSetupPayloads()` / `buildK3WisePipelinePayloads()` behavior remain intact.

## Expected Operator Flow

1. Fill `基础连接`.
2. Save and test WebAPI.
3. Install or confirm staging multitables.
4. Create draft material/BOM pipelines.
5. Open execution/observation panels only when ready to dry-run or inspect failures.

This is intentionally closer to an operator checklist than a raw configuration dump.
