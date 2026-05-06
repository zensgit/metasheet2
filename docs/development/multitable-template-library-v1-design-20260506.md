# Multitable Template Library V1 Design - 2026-05-06

## Goal

Close the Phase 7 Feishu-parity backlog item `Template library V1` with a small, durable slice:

- list built-in multitable templates;
- install a selected template as a new base;
- expose a minimal Workbench entry for users with multitable write access;
- keep installation atomic so users never see a half-created template.

## Scope

Implemented:

- `GET /api/multitable/templates`
- `POST /api/multitable/templates/:templateId/install`
- Static checked-in template catalog with:
  - `project-tracker`
  - `sales-crm`
  - `issue-tracker`
- Atomic install pipeline:
  - create `meta_bases`;
  - create template sheets;
  - create template fields;
  - create template views with field-id remapping for kanban/calendar/timeline config.
- Frontend API client methods:
  - `listTemplates()`
  - `installTemplate(templateId, input)`
- Workbench `Templates` panel that installs a template and switches to the new base.
- OpenAPI source and generated dist updates.
- Focused backend/frontend tests and OpenAPI parity guard.

Not implemented in V1:

- user-authored template persistence;
- template marketplace/search/rating;
- installing into an existing base;
- sample records;
- cross-sheet linked template graphs.

## Design Decisions

### Static Catalog First

Templates live in `packages/core-backend/src/multitable/template-library.ts`.

Reason: V1 needs a reliable product entry point, not a new authoring subsystem. A checked-in catalog avoids migrations, permission rules for template ownership, and extra admin UI.

### Install Creates A New Base

The install route creates a new base and installs sheets/fields/views inside one backend transaction.

Reason: creating a new base mirrors the expected template-library flow and avoids partial frontend orchestration such as `createBase -> createSheet -> createFields -> createViews`.

### Provisioning Helpers Are Reused

The service reuses:

- `createSheet()`
- `ensureFields()`
- `createView()`

Reason: existing provisioning helpers already normalize field property JSON, select options, and view config persistence.

### Stable Child IDs Under Random Base IDs

The route generates a fresh base ID. Template sheet, field, and view IDs are stable hashes under that base ID.

Reason: repeated installs produce distinct bases, while each installed base has deterministic internal references for field-id remapping.

### Permission Model

Catalog list requires `multitable:read`.

Install requires `multitable:write`, and installed base ownership is assigned to the authenticated user.

Reason: this matches current base creation semantics without introducing a separate template permission model.

## Files Changed

- `packages/core-backend/src/multitable/template-library.ts`
- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/tests/unit/multitable-template-library.test.ts`
- `packages/core-backend/tests/integration/multitable-context.api.test.ts`
- `apps/web/src/multitable/api/client.ts`
- `apps/web/src/multitable/types.ts`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/tests/multitable-phase3.spec.ts`
- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/multitable.yml`
- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/openapi.yaml`
- `scripts/ops/multitable-openapi-parity.test.mjs`

## Follow-Ups

- Add a richer template gallery route if the number of built-in templates grows.
- Add sample record seeding after record templates have a validated owner/source/audit strategy.
- Add install-into-existing-base only after product decides how conflicts and sheet ownership should behave.
