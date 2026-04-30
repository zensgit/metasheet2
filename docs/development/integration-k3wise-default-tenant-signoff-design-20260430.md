# K3 WISE Default Tenant Signoff Design

## Context

The K3 WISE internal-trial smoke reached production successfully after the
failure-evidence fix, but the first authenticated signoff attempt was blocked
because no tenant scope was provided:

- `METASHEET_K3WISE_SMOKE_TOKEN` was not configured;
- `METASHEET_TENANT_ID` was not configured;
- singleton integration-tenant auto-discovery found no integration rows yet.

That behavior is correct for safety. The resolver must not invent a tenant from
empty integration state.

The 142 deployment is currently a single-tenant internal trial. Existing
MetaSheet routes commonly use `default` as the single-tenant scope, and a manual
authenticated smoke with `tenant_id=default` passed all signoff checks.

## Decision

Configure GitHub repository variable:

```text
METASHEET_TENANT_ID=default
```

This makes manual K3 WISE signoff repeatable without asking an operator to type
the tenant every time. The workflow input still overrides the variable, so
customer-specific or future multi-tenant runs can explicitly provide another
tenant.

## Boundaries

- This is a non-secret repository variable.
- It does not configure K3 WISE credentials.
- It does not make public-only smoke a signoff.
- It does not make production deploy hard-fail on K3 authenticated smoke;
  `K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH=true` remains the separate hard-gate
  switch.
- It does not change tenant auto-discovery rules.

## Result

After setting the variable, the manual workflow passed with no explicit
`tenant_id` input. Evidence shows:

- `authenticated=true`;
- `signoff.internalTrial=pass`;
- `auth-me.tenantId=default`;
- `integration-route-contract=pass`;
- all four control-plane list probes passed;
- `staging-descriptor-contract=pass`.
