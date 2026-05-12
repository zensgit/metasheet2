# K3 WISE Generic Workbench Link Design - 2026-05-12

## Purpose

The K3 WISE setup page is still the fast path for the first customer PoC. The generic integration workbench is now the reusable surface for source/target selection, mapping, preview, pipeline execution, and observation.

This slice adds a direct bridge from the K3 WISE preset page to the generic workbench so operators do not need to know or type `/integrations/workbench`.

## Change

`apps/web/src/views/IntegrationK3WiseSetupView.vue` adds a header action:

```html
<router-link to="/integrations/workbench">打开通用工作台</router-link>
```

The link uses the existing `k3-setup__btn` visual style and is intentionally placed next to refresh/save actions, not inside the setup form.

## Product Boundary

This keeps the product model clear:

- K3 WISE page: guided preset for K3 WebAPI / SQL channel setup and Material/BOM bootstrap.
- Generic workbench: reusable CRM/PLM/ERP/SRM mapping, preview, pipeline run, and observation surface.

No K3 connection payload, pipeline payload, route permission, or backend behavior changes in this slice.

## Non-Goals

- No main navigation change.
- No redirect from K3 to the workbench.
- No migration.
- No backend API change.
