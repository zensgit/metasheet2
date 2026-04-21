# Yjs Client Validation

The validation script has moved to `packages/core-backend/scripts/ops/yjs-node-client.mjs`
so it can resolve `yjs`, `y-protocols`, and `socket.io-client` from the
core-backend package's `node_modules`.

## Run via npm script (recommended)

```bash
YJS_BASE_URL=http://<host>:<port> \
YJS_TOKEN=<jwt> \
RECORD_ID=<recordId> \
pnpm --filter @metasheet/core-backend run yjs:validate
```

## Run directly

```bash
cd packages/core-backend
YJS_BASE_URL=... YJS_TOKEN=... RECORD_ID=... node scripts/ops/yjs-node-client.mjs
```

## Run via CI (dispatch workflow)

See `.github/workflows/yjs-staging-validation.yml` — triggered via
`gh workflow run yjs-staging-validation.yml`.
