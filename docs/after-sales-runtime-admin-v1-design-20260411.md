# After-Sales Runtime Admin V1 Design

Date: 2026-04-11

## Summary

This slice adds a plugin-local runtime admin surface for `plugin-after-sales`.

It deliberately does not introduce a generic platform-wide plugin admin layer. The implementation stays inside the after-sales plugin and uses the existing runtime seams that already landed on `main`:

- `services.automationRegistry`
- `services.rbacProvisioning`
- `plugin_automation_rule_registry`
- `plugin_field_policy_registry`

The goal is to let admins change two runtime concerns without reinstalling the plugin:

1. Toggle the 4 default after-sales automation rules on or off.
2. Edit the role-based `serviceTicket.refundAmount` field policy matrix.

## Scope And Non-Goals

In scope:

- `GET /api/after-sales/runtime-admin`
- `PUT /api/after-sales/runtime-admin/automations`
- `PUT /api/after-sales/runtime-admin/field-policies`
- `AfterSalesView` admin UI for the two controls above
- manifest/runtime sync for the missing `sla-watcher` workflow declaration

Out of scope:

- generic plugin runtime admin APIs
- editing automation trigger/action DSL
- editing arbitrary field policies outside `serviceTicket.refundAmount`
- changing install-time provisioning semantics

## Backend Design

### Route contract

All three runtime-admin routes are admin-only and reuse the existing after-sales install admin gate:

- missing user: `401 UNAUTHORIZED`
- non-admin: `403 FORBIDDEN`
- after-sales not in `installed|partial`: `409 AFTER_SALES_NOT_INSTALLED`

Routes added:

- `GET /api/after-sales/runtime-admin`
- `PUT /api/after-sales/runtime-admin/automations`
- `PUT /api/after-sales/runtime-admin/field-policies`

### State model

Runtime admin state is reconstructed from blueprint defaults plus registry overlay.

Automation state:

- source of truth for shape: `buildDefaultBlueprint(appManifest).automations`
- source of truth for enabled state: `automationRegistry.listRules(...)`
- persisted updates: `automationRegistry.upsertRules(...)`

Field-policy state:

- source of truth for role list and labels: `buildDefaultBlueprint(appManifest).roles`
- source of truth for default policy rows: `buildDefaultBlueprint(appManifest).fieldPolicies`
- source of truth for persisted overrides: `plugin_field_policy_registry`
- persisted updates: `rbacProvisioning.applyRoleMatrix(...)`

### Response shape

`GET /api/after-sales/runtime-admin` returns:

```json
{
  "projectId": "tenant:after-sales",
  "automations": [
    {
      "id": "ticket-triage",
      "name": "Ticket Triage",
      "triggerEvent": "ticket.created",
      "enabled": true
    }
  ],
  "fieldPolicies": {
    "objectId": "serviceTicket",
    "field": "refundAmount",
    "roles": [
      {
        "roleSlug": "finance",
        "roleLabel": "财务",
        "visibility": "visible",
        "editability": "editable"
      }
    ]
  }
}
```

### Update semantics

`PUT /api/after-sales/runtime-admin/automations`

- accepts `{ automations: Array<{ id, enabled }> }`
- requires the exact default rule id set
- rebuilds full rule drafts from blueprint defaults
- only `enabled` is mutable

`PUT /api/after-sales/runtime-admin/field-policies`

- accepts `{ roles: Array<{ roleSlug, visibility, editability }> }`
- requires the exact default role set
- rewrites a full replacement matrix for `serviceTicket.refundAmount`
- coerces `hidden -> readonly` before persistence

### Helper split

Two plugin helpers now carry the logic that should not live inline in `index.cjs`:

- `lib/runtime-admin.cjs`
  - runtime-admin state assembly
  - automation update validation
  - field-policy update payload construction
- `lib/field-policies.cjs`
  - registry/default merge
  - role-matrix assembly
  - full replacement field-policy validation

## Frontend Design

`AfterSalesView.vue` now loads runtime-admin state only when all of these are true:

- current install state is `installed` or `partial`
- manifest includes `sla-watcher`, which acts as the runtime-admin capability marker

Behavior:

- `403` from `/api/after-sales/runtime-admin`: hide the admin section silently
- other load failures: keep the rest of the page usable and show a panel-local error
- separate save/reset flows for:
  - automation toggles
  - field policy matrix
- after field-policy save:
  - reload `/api/after-sales/runtime-admin`
  - reload `/api/after-sales/field-policies`
  - this immediately refreshes refund field visibility/editability in the ticket UI

## Testing Strategy

Backend:

- unit coverage for helper normalization and validation
- route tests for admin access, 409 guard, update payloads, and coercion
- real Postgres integration for runtime-admin GET/PUT behavior

Frontend:

- `AfterSalesView.spec.ts` coverage for:
  - runtime-admin render
  - `403` hide behavior
  - automation save payload
  - field-policy save payload
  - post-save refund control refresh

The design intentionally keeps the surface narrow enough that route tests plus one real integration file provide strong regression coverage without introducing a new generic admin subsystem.
