# K3 WISE Setup Guard Verification - 2026-04-29

## Scope

Verified the K3 WISE setup helper rejects invalid numeric transport fields before saving operator configuration, and the setup route is protected by the same admin feature used by the shell nav entry.

Changed files:

- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/tests/k3WiseSetup.spec.ts`
- `apps/web/tests/platform-shell-nav.spec.ts`
- `docs/development/integration-k3wise-setup-numeric-guard-design-20260429.md`
- `docs/development/integration-k3wise-setup-numeric-guard-verification-20260429.md`

## Checks

### Focused Frontend Helper Test

Command:

```bash
NODE_PATH=/Users/chouhua/Downloads/Github/metasheet2/node_modules:/Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules \
  /Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules/.bin/vitest run apps/web/tests/k3WiseSetup.spec.ts --watch=false
```

Expected result:

```text
apps/web/tests/k3WiseSetup.spec.ts: 15 tests passed
```

Coverage added:

- `lcid: "zh-CN"` is rejected with `lcid must be a positive integer`.
- `timeoutMs: "0"` is rejected with `timeoutMs must be a positive integer`.
- Direct payload building also throws instead of silently replacing invalid `lcid`.
- `/integrations/k3-wise` keeps `requiredFeature: 'attendanceAdmin'`.

### Vue SFC Compile

Command:

```bash
node -e "const { parse, compileScript, compileTemplate } = require('/Users/chouhua/Downloads/Github/metasheet2/node_modules/.pnpm/@vue+compiler-sfc@3.5.24/node_modules/@vue/compiler-sfc'); const fs = require('fs'); const file = 'apps/web/src/views/IntegrationK3WiseSetupView.vue'; const source = fs.readFileSync(file, 'utf8'); const parsed = parse(source, { filename: file }); if (parsed.errors.length) throw parsed.errors[0]; compileScript(parsed.descriptor, { id: 'k3-wise-setup' }); if (parsed.descriptor.template) { const compiled = compileTemplate({ id: 'k3-wise-setup', source: parsed.descriptor.template.content, filename: file }); if (compiled.errors.length) throw compiled.errors[0]; } console.log('SFC compile ok')"
```

Expected result:

```text
SFC compile ok
```

### Diff Hygiene

Command:

```bash
git diff --check
```

Result:

```text
passed
```

## Live Validation

This change does not require a live K3 WISE tenant. It is a local setup-form contract guard; live connection testing remains blocked on the customer GATE response.
