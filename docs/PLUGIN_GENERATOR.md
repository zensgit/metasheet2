# Plugin Generator Tool

This document outlines the workspace plugin generator and the planned CLI package.

## Modes
- Workspace script (Phase 1): `node scripts/generate-plugin.js <name>`
- CLI (Phase 2): `pnpm dlx @metasheet/create-plugin <name>`

## Templates
- Types: `view`, `datasource`, `function`, `automation`
- Generated structure:
```
plugins/<name>/
  plugin.json
  src/index.ts
  tsconfig.json
  vitest.config.ts
  README.md
```

## Manifest (view)
```json
{
  "name": "@metasheet/plugin-view-<name>",
  "version": "0.1.0",
  "displayName": "<Name>",
  "engines": { "metasheet": ">=2.0.0" },
  "main": { "backend": "dist/index.js" },
  "permissions": ["http.addRoute", "events.on"],
  "contributes": { "views": [ { "id": "<id>", "name": "<Name>", "component": "<Component>" } ] }
}
```

## Dev Workflow
- Generate → implement → `pnpm -F @metasheet/core-backend dev:core` → `curl /api/plugins`
- Frontend renders views dynamically from `/api/plugins`.

## Best Practices
- Follow permission whitelist and groups; start with readonly/basic groups.
- Keep `activate` idempotent; wrap errors and log with PLUGIN_00x codes.
- Provide minimal tests and README for each plugin.

