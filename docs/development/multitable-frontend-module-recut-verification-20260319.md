## Multitable Frontend Module Recut Verification

Date: 2026-03-19

### Local Verification

1. `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
   - PASS
2. `pnpm exec vitest run $(find tests -maxdepth 1 -name 'multitable-*.spec.ts' | sort)` in `apps/web`
   - PASS
   - `18` files passed
   - `266` tests passed
3. `pnpm --filter @metasheet/web build`
   - PASS
4. `pnpm exec tsx packages/openapi/tools/build.ts`
   - PASS
   - `multitable.yml` included in generated OpenAPI parts

### Contract Validation Note

`./scripts/ops/attendance-run-gate-contract-case.sh openapi` will report dist drift before commit because the recut intentionally regenerates `packages/openapi/dist/*`. After the regenerated artifacts are committed, the same contract check becomes the authoritative CI validation for the PR.
