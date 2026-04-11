# PLM Yuantus Document Semantics Pact Wave 2

## Goal

Extend the existing Metasheet2 -> Yuantus PLM pact artifact so it locks the
document semantics calls already used by `PLMAdapter.getProductDocuments()` in
`apiMode='yuantus'`.

Before this slice, the implementation already merged:

- physical file attachments via `GET /api/v1/file/item/{item_id}`
- file metadata enrichment via `GET /api/v1/file/{file_id}`
- AML related documents via `POST /api/v1/aml/query` + `expand: ['Document Part']`

But the pact artifact still covered only the original 6 Wave 1 interactions.

## Design

### Canonical contract surface

The pact artifact now includes 9 interactions total:

1. `POST /api/v1/auth/login`
2. `GET /api/v1/health`
3. `GET /api/v1/search/`
4. `POST /api/v1/aml/apply`
5. `GET /api/v1/bom/{id}/tree`
6. `GET /api/v1/bom/compare`
7. `GET /api/v1/file/item/{item_id}`
8. `GET /api/v1/file/{file_id}`
9. `POST /api/v1/aml/query`

### Contract-first rule

The artifact still follows the same rule as Wave 1:

- freeze only endpoints the live consumer actually calls
- do not add aspirational endpoints
- keep drift detection against `PLMAdapter.ts`

That is why document semantics is now in scope, but unrelated Wave 2 candidates
such as `where-used`, `compare/schema`, and ECO approval mutations remain out.

### New assertions

The static vitest sanity test now also verifies that:

- `PLMAdapter.ts` still references `file/item`, `aml/query`, and the file
  metadata enrichment helper
- the AML query interaction still locks `expand: ['Document Part']`

## Files Changed

- `packages/core-backend/tests/contract/pacts/metasheet2-yuantus-plm.json`
- `packages/core-backend/tests/contract/plm-adapter-yuantus.pact.test.ts`
- `packages/core-backend/tests/contract/README.md`

## Verification

### Clean worktree contract test

Command:

```bash
cd /tmp/metasheet2-docs-wave2-V3Ytr1
npx vitest run packages/core-backend/tests/contract/plm-adapter-yuantus.pact.test.ts
```

Result:

```text
1 file passed, 8 tests passed
```

### Unit coverage against installed workspace deps

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2/packages/core-backend
npx vitest run \
  tests/unit/plm-adapter-yuantus.test.ts \
  tests/unit/federation.contract.test.ts
```

Result:

```text
2 files passed, 20 tests passed
```

Note:
the clean worktree inherited pnpm symlink-resolution issues for package-local
dependencies such as `uuid`, so the unchanged unit suites were verified against
the primary repo's installed dependency graph instead. The code under test for
those suites was unchanged by this slice.
