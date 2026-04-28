# Integration Staging Install UI Verification

## Commands

Executed from `/tmp/ms2-integration-staging-install-ui-20260428`.

```bash
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs

NODE_PATH=/Users/chouhua/Downloads/Github/metasheet2/node_modules:/Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules \
  /Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules/.bin/vitest run \
  apps/web/tests/k3WiseSetup.spec.ts --watch=false

node -c plugins/plugin-integration-core/lib/http-routes.cjs
node -c plugins/plugin-integration-core/index.cjs

node plugins/plugin-integration-core/__tests__/staging-installer.test.cjs

node -e "const { parse, compileScript, compileTemplate } = require('/Users/chouhua/Downloads/Github/metasheet2/node_modules/.pnpm/@vue+compiler-sfc@3.5.24/node_modules/@vue/compiler-sfc'); const fs = require('fs'); const file = 'apps/web/src/views/IntegrationK3WiseSetupView.vue'; const source = fs.readFileSync(file, 'utf8'); const parsed = parse(source, { filename: file }); if (parsed.errors.length) throw parsed.errors[0]; compileScript(parsed.descriptor, { id: 'k3-wise-setup' }); if (parsed.descriptor.template) { const compiled = compileTemplate({ id: 'k3-wise-setup', source: parsed.descriptor.template.content, filename: file }); if (compiled.errors.length) throw compiled.errors[0]; } console.log('SFC compile ok')"

ln -s /Users/chouhua/Downloads/Github/metasheet2/node_modules node_modules
ln -s /Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/node_modules packages/core-backend/node_modules
node --import /Users/chouhua/Downloads/Github/metasheet2/node_modules/.pnpm/tsx@4.20.6/node_modules/tsx/dist/loader.mjs \
  plugins/plugin-integration-core/__tests__/host-loader-smoke.test.mjs
rm -rf node_modules packages/core-backend/node_modules

ln -s /Users/chouhua/Downloads/Github/metasheet2/node_modules node_modules
ln -s /Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules apps/web/node_modules
/Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules/.bin/vue-tsc -p apps/web/tsconfig.app.json --noEmit
rm -rf node_modules apps/web/node_modules

git diff --check
```

## Results

- `http-routes.test.cjs`: passed, including descriptor and install route coverage.
- `k3WiseSetup.spec.ts`: passed, 9 tests.
- `node -c` for changed CommonJS files: passed.
- `staging-installer.test.cjs`: passed.
- `IntegrationK3WiseSetupView.vue` SFC compile: passed.
- `host-loader-smoke.test.mjs`: passed after temporarily linking main checkout dependencies into the isolated worktree.
- `vue-tsc -p apps/web/tsconfig.app.json --noEmit`: passed after temporarily linking main checkout dependencies into the isolated worktree.
- `git diff --check`: passed.

## Notes

The first host-loader attempt without dependency links failed because the isolated worktree could not resolve `tsx` / backend dependencies. The linked-dependency rerun passed and the temporary links were removed.
