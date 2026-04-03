# Run28 On-Prem Workspace Hotfix Design

## Problem

`attendance-onprem-run28-20260402` shipped the repository workspace manifest unchanged. The packaged `pnpm-workspace.yaml` still included:

- `packages/openapi/dist-sdk`
- `apps/*`
- `plugins/*`

At the same time, the packaged `apps/web/package.json` still depended on `@metasheet/sdk` via `workspace:*`.

That is acceptable in the source repository, but wrong for an on-prem delivery bundle because:

1. `apps/web` is already prebuilt and should not participate in deployment-time `pnpm install`.
2. `packages/openapi/dist-sdk` is not shipped in the on-prem bundle.
3. Once `pnpm install` walks into `apps/web`, deployment fails on missing workspace packages before plugin dependencies finish installing.

## Decision

Keep the source repository workspace unchanged, but overwrite the packaged `pnpm-workspace.yaml` with an on-prem-specific manifest during packaging.

Packaged on-prem workspace must include only:

- `packages/*`
- `plugins/*`

Packaged on-prem workspace must exclude:

- `apps/*`
- `packages/openapi/dist-sdk`

## Why this fix

This is the smallest safe change because it:

- does not change application runtime behavior
- does not change source-repo developer workflows
- directly fixes deployment-time `pnpm install`
- keeps plugin workspaces available so `plugin-attendance` dependencies like `zod` still install correctly

## Guardrail

`attendance-onprem-package-verify.sh` now validates the packaged workspace manifest and fails if the bundle still includes `apps/*` or `packages/openapi/dist-sdk`.
