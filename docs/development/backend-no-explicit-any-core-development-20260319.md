# Backend no-explicit-any core cleanup development report

Date: 2026-03-19

## Scope

Final backend cleanup slice for `@typescript-eslint/no-explicit-any`, covering the two remaining high-risk hotspots:

- `packages/core-backend/src/di/identifiers.ts`
- `packages/core-backend/src/routes/univer-meta.ts`

Follow-up support changes were also applied in:

- `packages/core-backend/src/di/container.ts`
- `packages/core-backend/src/services/CollabService.ts`

## Implementation summary

### `packages/core-backend/src/di/identifiers.ts`

- Replaced all remaining `any`-based service contracts with explicit `unknown`-based interfaces.
- Added concrete adapter interfaces for PLM, Athena, Dedup, CAD ML, and Vision services.
- Added typed comment DTO contracts instead of `any` payloads and `any[]` result shapes.
- Switched collab service signatures to concrete `HttpServer` and `Socket` types.

### `packages/core-backend/src/di/container.ts`

- Extended `AdapterStub` to satisfy the stronger adapter contracts introduced in `identifiers.ts`.
- Added lifecycle methods and typed placeholder query results for adapter APIs used by federation routes.

### `packages/core-backend/src/services/CollabService.ts`

- Removed the last explicit-any socket callback signature from `onConnection`.

### `packages/core-backend/src/routes/univer-meta.ts`

- Introduced local query row helper types (`MetaFieldRow`, `MetaRecordRow`, `MetaViewRow`, `MetaLinkRow`, etc.).
- Added small typed helpers for row extraction, row counts, and error code/message reads.
- Replaced all `as any`, `rows as any[]`, and `catch (err: any)` sites with typed row access or `unknown` error handling.
- Kept the route behavior unchanged while narrowing the type surface around database reads and error handling.

## Outcome

- Backend `@typescript-eslint/no-explicit-any` warnings reduced from `92` to `0`.
- Backend-wide ESLint warnings reduced to `0`.
- Remaining work is no longer `no-explicit-any` cleanup; this rule is now fully closed for backend TypeScript sources.
