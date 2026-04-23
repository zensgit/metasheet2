# Approval Wave 2 WP4 Template ACL Development

Scope: WP4 slice 2 adds approval template visibility ACL and fills the deferred OpenAPI contract for template category, clone, categories, and visibility metadata.

## Design

- `approval_templates.visibility_scope JSONB NOT NULL DEFAULT '{"type":"all","ids":[]}'` stores the visibility metadata on the parent template row.
- Shape: `{ type: 'all' | 'dept' | 'role' | 'user', ids: string[] }`.
- Existing templates remain compatible because old rows default to `all` and service reads also coalesce missing/invalid values to `all`.
- `list/get/categories` filter by current actor unless the actor is a template manager.
- Template managers are actors with `role=admin`, `roles` containing `admin`, `*:*`, or `approval-templates:manage`; they can still manage and see every template.
- Route actor resolution accepts both legacy `req.user.role` and array `req.user.roles`, then de-duplicates them before visibility matching.
- Non-manager visibility match rules:
  - `all`: visible to everyone authenticated.
  - `user`: current user id appears in `ids`.
  - `role`: any current role appears in `ids`.
  - `dept`: any current department id appears in `ids`.

## API Notes

- `POST /api/approval-templates` accepts optional `visibilityScope`; missing means all visible.
- `PATCH /api/approval-templates/:id` can update `visibilityScope` without creating a new version.
- `GET /api/approval-templates`, `GET /api/approval-templates/categories`, and `GET /api/approval-templates/:id` require `approvals:read`, then apply template ACL filtering. The ACL is not a replacement for route-level RBAC.
- `POST /api/approvals` now checks the template ACL before initiating from a published template.
- `POST /api/approval-templates/:id/clone` copies category and visibility scope into the draft clone.
- The migration uses the Kysely migrator signature (`up(db: Kysely<unknown>)`) rather than a raw `pg.Pool`.

## Verification

Focused commands:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-template-routes.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/approval-wp4-template-categories.api.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/approvalTemplateCenterCategory.spec.ts --watch=false
pnpm --filter @metasheet/core-backend type-check
pnpm --filter @metasheet/web type-check
```

Manual UI path:

1. Open `/approval-templates`.
2. Confirm visible templates show category and visibility summary.
3. Open a template detail page as a template manager.
4. Edit 可见范围 with `all`, `dept`, `role`, or `user`; for scoped modes enter comma-separated ids.
5. Reload as a non-manager actor and verify only matching templates appear.
