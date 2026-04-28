# K3 WISE Pipeline Template Design

## Context

The K3 WISE setup page already saves and tests ERP external-system records. The next missing operator step was turning a saved PLM source system and K3 target system into the first runnable cleansing pipelines.

## Design

The cleansing chain is split deliberately:

- Multitable sheets are the user-visible staging and audit surface: raw PLM rows, standardized material rows, BOM cleanse rows, exception queues, and run logs.
- The integration pipeline runner owns automated execution: adapter read, field mapping, transform, validation, idempotency, watermark, ERP write, dead letter, and feedback writeback.

This change adds draft pipeline template creation to the K3 WISE setup page instead of moving cleansing logic into table formulas.

## UI Flow

The `/integrations/k3-wise` page now has a `PLM -> K3 cleansing chain` section:

- `Project ID`
- `PLM Source System ID`
- read-only `K3 Target System ID` from the selected/saved WebAPI system
- material pipeline name and staging object
- BOM pipeline name and staging object

The side rail has a `Create cleansing Pipeline` action that creates two draft pipelines:

- `materials -> material`
- `bom -> bom`

They are intentionally `draft`; operators still review mappings and run dry-run before activation.

## Pipeline Defaults

Material pipeline:

- mode: `incremental`
- idempotency: `sourceId + revision`
- watermark: `updatedAt`
- feedback object: `standard_materials`
- core mappings: `code -> FNumber`, `name -> FName`, `spec -> FModel`, `uom -> FBaseUnitID`

BOM pipeline:

- mode: `manual`
- idempotency: `sourceId + revision`
- feedback object: `bom_cleanse`
- core mappings: `parentCode`, `childCode`, `quantity`, `uom`, `sequence`

The payloads use the existing `POST /api/integration/pipelines` route and require both:

- saved PLM source external-system id
- saved K3 WISE WebAPI external-system id

## Files

- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/tests/k3WiseSetup.spec.ts`
