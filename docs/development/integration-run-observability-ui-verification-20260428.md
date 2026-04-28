# Integration Run Observability UI Verification - 2026-04-28

## Scope

Verified the frontend-only run observability slice for the K3 WISE setup page.

Changed files:

- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/tests/k3WiseSetup.spec.ts`
- `docs/development/integration-run-observability-ui-design-20260428.md`
- `docs/development/integration-run-observability-ui-verification-20260428.md`

## Checks Run

### Helper Unit Tests

Command:

```bash
NODE_PATH=/Users/chouhua/Downloads/Github/metasheet2/node_modules:/Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules \
  /Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules/.bin/vitest run apps/web/tests/k3WiseSetup.spec.ts --watch=false
```

Result:

```text
apps/web/tests/k3WiseSetup.spec.ts: 13 tests passed
```

Coverage added:

- Builds run/dead-letter observation queries for selected material/BOM pipelines.
- Rejects missing tenant ID before loading run history.
- Rejects missing material/BOM pipeline IDs before loading run history.

### Vue SFC Compile

Command:

```bash
node -e "const { parse, compileScript, compileTemplate } = require('/Users/chouhua/Downloads/Github/metasheet2/node_modules/.pnpm/@vue+compiler-sfc@3.5.24/node_modules/@vue/compiler-sfc'); const fs = require('fs'); const file = 'apps/web/src/views/IntegrationK3WiseSetupView.vue'; const source = fs.readFileSync(file, 'utf8'); const parsed = parse(source, { filename: file }); if (parsed.errors.length) throw parsed.errors[0]; compileScript(parsed.descriptor, { id: 'k3-wise-setup' }); if (parsed.descriptor.template) { const compiled = compileTemplate({ id: 'k3-wise-setup', source: parsed.descriptor.template.content, filename: file }); if (compiled.errors.length) throw compiled.errors[0]; } console.log('SFC compile ok')"
```

Result:

```text
SFC compile ok
```

### Frontend Type Check

Command:

```bash
ln -s /Users/chouhua/Downloads/Github/metasheet2/node_modules node_modules 2>/dev/null || true
ln -s /Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules apps/web/node_modules 2>/dev/null || true
/Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules/.bin/vue-tsc -p apps/web/tsconfig.app.json --noEmit
code=$?
rm -rf node_modules apps/web/node_modules
exit $code
```

Result:

```text
passed
```

### Whitespace Check

Command:

```bash
git diff --check
```

Result:

```text
passed
```

## Manual Contract Review

The UI helper uses existing backend routes:

- `GET /api/integration/runs`
- `GET /api/integration/dead-letters`

The frontend only sends:

- `tenantId`
- `workspaceId`
- `pipelineId`
- `status`
- `limit`
- `offset`

The UI does not request `includePayload=true`, so dead-letter payloads remain
redacted by default.

## Remaining Validation

Live run/dead-letter content still depends on the customer M2 GATE response and
the K3 WISE PoC environment. This slice verifies the UI contract and type
surface, not real K3 WISE data.
