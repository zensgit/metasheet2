# Baseline Abstraction Strategy - ViewService & RBAC

**PR Purpose**: Establish common baseline interfaces to reduce merge conflicts across multiple feature branches

**Status**: Foundation PR (stub implementations)

**Target**: Enable safe, incremental rollout of ViewService unification and table-level RBAC

---

## Problem Statement

Three major PRs (#155, #158, #246) are attempting to modify the same core files simultaneously:
- `packages/core-backend/src/routes/views.ts`
- `packages/core-backend/src/metrics/metrics.ts`
- `packages/core-backend/src/services/view-service.ts` (new)
- `packages/core-backend/src/rbac/table-perms.ts` (new)

This creates:
- ❌ Merge conflicts across all PRs
- ❌ Risk of breaking changes during integration
- ❌ Difficulty in incremental testing and rollback

## Solution: Baseline Abstraction "Landing PR"

Create empty interface definitions and feature flags BEFORE the three feature PRs:

### What This PR Adds

1. **`services/view-service.ts`** - Stub interface for ViewService abstraction
   - Defines TypeScript interfaces for unified view operations
   - All methods return no-op/empty results
   - Feature flag: `FEATURE_VIEWSERVICE_UNIFICATION` (default: `false`)

2. **`rbac/table-perms.ts`** - Stub interface for table-level permissions
   - Defines permission check interfaces (`canReadTable`, `canWriteTable`, etc.)
   - MVP implementation: Returns "allow all" for authenticated users
   - Feature flag: `FEATURE_TABLE_RBAC_ENABLED` (default: `false`)

3. **Feature Flags in `.env.example`**
   - Documents both feature flags with clear defaults
   - Enables safe incremental rollout

### What This PR Does NOT Change

✅ **No behavioral changes** - All existing routes continue to work exactly as before
✅ **No breaking changes** - Stub implementations are non-invasive
✅ **No production impact** - Feature flags default to `false`

---

## Benefits

### 1. Reduced Merge Conflicts
- Future PRs import from the same baseline files
- No need to create the same files in multiple branches
- Conflicts limited to implementation details, not file structure

### 2. Safe Incremental Rollout
- Feature flags allow gradual activation
- Easy rollback if issues arise
- Can test in development before enabling in production

### 3. Clear Migration Path
```
Phase 1: Merge baseline abstraction PR (this PR)
         └─ Establish interfaces, no behavioral changes

Phase 2: Merge metrics & RBAC PR
         └─ Add observability, keep feature flags OFF

Phase 3: Merge ViewService implementation PR
         └─ Implement query methods, test with flag ON in dev

Phase 4: Merge routes integration PR
         └─ Update routes to use ViewService when flag is ON

Phase 5: Production rollout
         └─ Enable flags in production after validation
```

---

## Implementation Details

### ViewService Interface

```typescript
// All methods are stubs that return empty/null
export async function getViewById(viewId: string): Promise<ViewConfig | null>
export async function getViewConfig(viewId: string): Promise<ViewConfig | null>
export async function updateViewConfig(viewId: string, config: Partial<ViewConfig>): Promise<ViewConfig | null>
export async function queryGrid(viewId: string, options: ViewQueryOptions): Promise<ViewDataResult>
export async function queryKanban(viewId: string, options: ViewQueryOptions): Promise<ViewDataResult>

// Feature flag check
export function isViewServiceEnabled(): boolean
```

### RBAC Permission Interface

```typescript
// MVP: All checks return { allowed: true } when flag is OFF
export async function canReadTable(userId: string, tableId: string): Promise<PermissionResult>
export async function canWriteTable(userId: string, tableId: string): Promise<PermissionResult>
export async function canDeleteFromTable(userId: string, tableId: string): Promise<PermissionResult>

// Feature flag check
export function isTableRBACEnabled(): boolean

// Helper for throwing errors on permission denial
export function assertPermission(result: PermissionResult, operation: string): void
```

---

## Usage Examples

### Future PR: Implementing ViewService

```typescript
// In a future PR, replace stub with real implementation
export async function queryGrid(viewId: string, options: ViewQueryOptions): Promise<ViewDataResult> {
  // Check feature flag
  if (!isViewServiceEnabled()) {
    return { data: [], meta: { total: 0, page: 1, pageSize: 50, hasMore: false } }
  }

  // Real implementation
  const view = await db.selectFrom('views').where('id', '=', viewId).executeTakeFirst()
  const rows = await db.selectFrom('table_rows').where('table_id', '=', view.tableId).execute()
  return { data: rows, meta: { ... } }
}
```

### Future PR: Using RBAC in Routes

```typescript
// In routes/views.ts
import { canReadTable, assertPermission } from '../rbac/table-perms'

router.get('/:viewId/data', async (req, res) => {
  const view = await getViewById(req.params.viewId)

  // Permission check (no-op when flag is OFF)
  const perm = await canReadTable(req.user.id, view.tableId)
  assertPermission(perm, 'Read view data')

  // Rest of implementation...
})
```

---

## Testing Strategy

### 1. Baseline PR (this PR)
- ✅ Verify stub files compile without errors
- ✅ Verify feature flags default to `false`
- ✅ Verify no existing functionality is broken
- ✅ CI: All tests pass with flags OFF

### 2. Future Implementation PRs
- ✅ Test with feature flags ON in development
- ✅ Verify backward compatibility with flags OFF
- ✅ Smoke tests for each view type
- ✅ Performance benchmarks vs. old implementation

### 3. Production Rollout
- ✅ Enable flags in staging environment
- ✅ Monitor metrics and error rates
- ✅ Gradual rollout with canary deployment
- ✅ Rollback plan: Set flags to `false`

---

## Related PRs and Issues

### Upstream (This PR)
- Establishes baseline interfaces
- Zero behavioral changes
- Enables downstream PR development

### Downstream (Future PRs)
- **Metrics & RBAC PR**: Add observability instrumentation to stub methods
- **ViewService Implementation PR**: Replace stubs with real query logic
- **Routes Integration PR**: Update routes to use ViewService
- **Production Rollout PR**: Enable feature flags after validation

---

## Success Criteria

✅ All three baseline files compile without errors
✅ Feature flags documented in `.env.example`
✅ No behavioral changes to existing functionality
✅ CI passes: lints, typecheck, migrations, observability tests
✅ Provides clear interfaces for downstream PRs to implement

---

## Rollback Plan

If issues arise:
1. Set feature flags to `false` in environment
2. Restart application
3. Functionality reverts to original behavior
4. No code changes needed

---

## References

- Original issue tracking: [Link to issue]
- Conflicting PRs: #155, #158, #246
- Architecture doc: `docs/VIEW_SERVICE_ARCHITECTURE.md` (to be created)

---

**Next Steps After Merge**:
1. Rebase downstream PRs (#155, #158, #246) onto this baseline
2. Split large PRs into focused, incremental changes
3. Merge in order: Metrics → ViewService → Routes → RBAC
4. Test each phase with feature flags before proceeding
