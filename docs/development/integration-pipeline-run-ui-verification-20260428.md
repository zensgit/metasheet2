# Integration Pipeline Run UI Verification - 2026-04-28

## Scope

Verified the frontend-only pipeline run slice for the K3 WISE setup page.

Changed files:

- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/tests/k3WiseSetup.spec.ts`
- `docs/development/integration-pipeline-run-ui-design-20260428.md`
- `docs/development/integration-pipeline-run-ui-verification-20260428.md`

## Checks Run

### Helper Unit Tests

Command:

```bash
NODE_PATH=/Users/chouhua/Downloads/Github/metasheet2/node_modules:/Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules \
  /Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules/.bin/vitest run apps/web/tests/k3WiseSetup.spec.ts --watch=false
```

Result:

```text
apps/web/tests/k3WiseSetup.spec.ts: 11 tests passed
```

Coverage added:

- Builds dry-run/run payloads with only public run fields.
- Resolves material and BOM pipeline IDs.
- Rejects missing tenant ID, missing pipeline ID, and non-positive sample limits.

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

## Manual Contract Review

The frontend helper calls these existing backend routes:

- `POST /api/integration/pipelines/:id/dry-run`
- `POST /api/integration/pipelines/:id/run`

The payload builder sends only:

- `tenantId`
- `workspaceId`
- `mode`
- `cursor`
- `sampleLimit`

This matches `publicRunInput()` in `plugins/plugin-integration-core/lib/http-routes.cjs`.

## Remaining Validation

This slice does not run against a live K3 WISE tenant. Live validation still
depends on the customer M2 GATE response and the K3 WISE PoC environment.
