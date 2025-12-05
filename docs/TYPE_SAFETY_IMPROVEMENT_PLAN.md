# Type Safety Improvement Plan

**Date**: 2025-12-02
**Status**: Draft

## 1. Current Status Analysis

Based on an in-depth analysis of 24 files currently using `@ts-nocheck`, the issues fall into the following categories:

| Type | Count | Description |
|------|-------|-------------|
| **1. Kysely Date Types** | ~8 | `Date` cannot be assigned to `ValueExpression<Database, table, never>` (Update type is `never`). |
| **2. Dynamic Table Names** | ~6 | Using tables not defined in the `Database` interface (e.g., `users`, `cells`). |
| **3. Express Request** | ~5 | Missing type definitions for extended properties like `req.user`. |
| **4. JSON Compatibility** | ~3 | Mismatch between `JSONColumnType` and runtime types (manual stringify vs auto-handling). |
| **5. Plugin Refactor** | ~2 | Type mismatches caused by architectural changes. |

## 2. Recommended Solution Strategy

We will adopt a **Hybrid Approach (A + B + Express)** to resolve these issues with minimal disruption while maximizing type safety.

### Step 1: Fix Core Type Definitions (Priority P0)
Modify `packages/core-backend/src/db/types.ts` to correct `ColumnType` definitions.
- **Issue**: `ColumnType<Select, Insert, Update>` often has `Update` set to `never`.
- **Fix**: Change `never` to `Date | string` for timestamp columns to allow updates.
- **Action**: Add missing table definitions (`users`, `cells`, etc.) to the `Database` interface.

### Step 2: Create Type Helpers (Priority P0)
Create `packages/core-backend/src/db/type-helpers.ts` for complex SQL conversions.

```typescript
import { sql } from 'kysely'

// Solves Date assignment issues
export function toDateValue(date: Date | null | undefined) {
  if (date == null) return null
  return sql<Date>`${date.toISOString()}::timestamptz`
}

// Solves JSON compatibility if manual stringify is needed
export function toJsonValue<T>(value: T) {
  return sql`${JSON.stringify(value)}::jsonb`
}
```

### Step 3: Global Express Types (Priority P1)
Create `packages/core-backend/src/types/express.d.ts` to strictly type the Request object.

```typescript
declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email?: string; [key: string]: unknown }
    }
  }
}
```

## 3. Implementation Roadmap

| Phase | Task | Target Files | Effort |
|-------|------|--------------|--------|
| **Phase 1** | Fix `db/types.ts` (Update types & missing tables) | 6 files | Low |
| **Phase 2** | Implement `type-helpers.ts` & Express types | 13+ files | Medium |
| **Phase 3** | Remove `@ts-nocheck` from files one by one | 24 files | Medium |

## 4. Future Considerations

### 4.1 Automatic Type Generation
Consider migrating to `kysely-codegen` to generate types directly from the database schema.
- **Pros**: Guaranteed sync between DB and Types.
- **Cons**: Adds build step dependency.
- **Command**: `npx kysely-codegen --dialect postgres --out-file src/db/generated-types.ts`

### 4.2 Prevention
- Establish a **pre-commit hook** (husky) to prevent committing new files with `@ts-nocheck`.
- Add a CI check to count and cap the number of `@ts-nocheck` occurrences.

### 4.3 Documentation
- Document Kysely type best practices in `docs/BACKEND_GUIDE.md`.
- Standardize JSON handling (auto-parsing vs manual stringify).
