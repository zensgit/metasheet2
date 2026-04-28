# K3 WISE Pipeline Template Verification

## Checks

Executed from `/tmp/ms2-integration-pipeline-template-20260428`.

```bash
NODE_PATH=/Users/chouhua/Downloads/Github/metasheet2/node_modules:/Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules \
  /Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules/.bin/vitest run \
  apps/web/tests/k3WiseSetup.spec.ts --watch=false

node -e "const { parse, compileScript, compileTemplate } = require('/Users/chouhua/Downloads/Github/metasheet2/node_modules/.pnpm/@vue+compiler-sfc@3.5.24/node_modules/@vue/compiler-sfc'); const fs = require('fs'); const file = 'apps/web/src/views/IntegrationK3WiseSetupView.vue'; const source = fs.readFileSync(file, 'utf8'); const parsed = parse(source, { filename: file }); if (parsed.errors.length) throw parsed.errors[0]; compileScript(parsed.descriptor, { id: 'k3-wise-setup' }); if (parsed.descriptor.template) { const compiled = compileTemplate({ id: 'k3-wise-setup', source: parsed.descriptor.template.content, filename: file }); if (compiled.errors.length) throw compiled.errors[0]; } console.log('SFC compile ok')"

ln -s /Users/chouhua/Downloads/Github/metasheet2/node_modules node_modules
ln -s /Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules apps/web/node_modules
/Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules/.bin/vue-tsc -p apps/web/tsconfig.app.json --noEmit
rm -rf node_modules apps/web/node_modules

git diff --check origin/main..HEAD
```

## Results

- `apps/web/tests/k3WiseSetup.spec.ts`: passed, 7 tests.
- `IntegrationK3WiseSetupView.vue` SFC parse / script compile / template compile: passed.
- `vue-tsc -p apps/web/tsconfig.app.json --noEmit`: passed after temporarily linking the main checkout dependency directories into the isolated worktree.
- `git diff --check origin/main..HEAD`: passed.

## Expected Behavior

- Existing K3 setup payload behavior remains unchanged.
- `buildK3WisePipelinePayloads()` creates material and BOM draft pipeline payloads using the selected K3 WebAPI external system as target.
- Template validation blocks creation when the PLM source system id or K3 target system id is missing.
- The setup page exposes pipeline creation without storing credentials or embedding secrets in the pipeline payload.
