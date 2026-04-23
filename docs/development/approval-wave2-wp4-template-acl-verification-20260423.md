# Approval Wave 2 WP4 Template ACL Verification

Date: 2026-04-23

Scope: focused verification for template visibility ACL, delayed OpenAPI contract coverage, and the compatibility hardening that keeps legacy singular `req.user.role` actors eligible for role-scoped templates.

## Local Verification

Backend route unit coverage:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-template-routes.test.ts --watch=false --reporter=dot
```

Result: `5/5` passed.

Frontend template and permission coverage:

```bash
pnpm --filter @metasheet/web exec vitest run tests/approvalTemplateCenterCategory.spec.ts tests/approval-e2e-permissions.spec.ts --watch=false --reporter=dot
```

Result: `45/45` passed (`7/7` template center + `38/38` permission regression). The run prints an existing Vue warning for the stubbed `el-badge` default slot; it does not fail the suite.

Backend type check:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: exit `0`.

Frontend type check:

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result: exit `0`.

OpenAPI YAML parse smoke:

```bash
node -e "const fs=require('fs'); const yaml=require('js-yaml'); for (const f of ['packages/openapi/src/base.yml','packages/openapi/src/paths/approvals.yml']) { yaml.load(fs.readFileSync(f,'utf8')); console.log(f + ' ok') }"
```

Result:

```text
packages/openapi/src/base.yml ok
packages/openapi/src/paths/approvals.yml ok
```

## Database-Backed Integration

Command attempted:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/approval-wp4-template-categories.api.test.ts --watch=false --reporter=dot
```

Local result: `10` tests skipped because this machine does not have `DATABASE_URL` configured and the default local PostgreSQL database `chouhua` does not exist. This matches the current local environment limitation; CI or a PG-backed developer environment should run this integration gate before merge.

## Compatibility Note

The route actor resolver was hardened after review to include both `req.user.role` and `req.user.roles`. This keeps older JWT/session shapes compatible with role-scoped template visibility while preserving the new multi-role behavior.
