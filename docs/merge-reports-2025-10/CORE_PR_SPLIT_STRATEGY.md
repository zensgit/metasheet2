# 核心PR拆分策略

## 📊 PR分析总结

### PR #244 - 文档PR (lints失败分析)

**状态**: ❌ lints FAILURE
**问题**: 全局shellcheck检测到既有脚本的警告
**影响文件**:
- `scripts/migrations-lint.sh` - SC2012, SC2086等警告
- `scripts/production-organize.sh` - SC2034, SC2046警告
- `scripts/quick-ci-test.sh` - SC2155警告

**处理建议**:
```yaml
选项A (推荐): 快速修复shellcheck警告
  action: 创建小PR修复这些脚本的shellcheck警告
  effort: 低 (30分钟)
  risk: 低

选项B: 调整lint workflow只检查PR修改文件
  action: 修改.github/workflows/integration-lints.yml
  effort: 中 (1小时)
  risk: 中

选项C: 临时放松规则
  action: 临时禁用shellcheck或标记为warning
  effort: 低 (10分钟)
  risk: 低（技术债累积）
```

**推荐行动**: 选项A - 创建PR #264修复shellcheck警告

---

### PR #246 - ViewService Unification

**规模**: +819/-83行, 13文件
**分支**: `feat/viewservice-unified`
**核心修改**:

```yaml
core_changes:
  view-service:
    - metasheet-v2/packages/core-backend/src/services/view-service.ts
    - 主要实现ViewService统一逻辑

  rbac_integration:
    - metasheet-v2/packages/core-backend/src/rbac/table-perms.ts
    - RBAC权限检查集成

  routes:
    - metasheet-v2/packages/core-backend/src/routes/views.ts
    - View API endpoints更新

  metrics:
    - metasheet-v2/packages/core-backend/src/metrics/metrics.ts
    - ViewService metrics

  config:
    - metasheet-v2/packages/core-backend/src/config/index.ts
    - 配置更新

  plugin_loader:
    - metasheet-v2/packages/core-backend/src/core/plugin-loader.ts
    - Plugin集成调整

  observability:
    - metasheet-v2/packages/core-backend/src/observability/ObservabilityManager.ts
    - metasheet-v2/packages/core-backend/src/telemetry/index.ts
    - 观测性集成
```

**拆分策略**:

#### Phase 1: 基础ViewService
```yaml
branch: split/246-phase1-viewservice-core
scope: ViewService core implementation
files:
  - metasheet-v2/packages/core-backend/src/services/view-service.ts (core methods only)
  - metasheet-v2/packages/core-backend/src/config/flags.ts (FEATURE_VIEWSERVICE_UNIFICATION flag)
lines: ~250
risk: 低
feature_flag: FEATURE_VIEWSERVICE_UNIFICATION=false (default)

definition_of_done:
  - [ ] Core ViewService class structure implemented
  - [ ] Feature flag properly configured in config/flags.ts
  - [ ] Unit tests pass with >80% coverage
  - [ ] TypeScript compilation succeeds with no new errors
  - [ ] Lints pass (integration-lints green)
  - [ ] No runtime impact verified (flag disabled by default)
  - [ ] Code review approved
  - [ ] Documentation updated (API comments)

validation:
  - Unit tests pass
  - No runtime impact (flag disabled)
  - Type safety maintained
```

#### Phase 2: RBAC Integration
```yaml
branch: split/246-phase2-rbac-table-perms
depends_on: split/246-phase1-viewservice-core
scope: RBAC permission checks
files:
  - metasheet-v2/packages/core-backend/src/rbac/table-perms.ts
  - metasheet-v2/packages/core-backend/src/services/view-service.ts (RBAC methods)
  - metasheet-v2/packages/core-backend/src/config/flags.ts (FEATURE_TABLE_RBAC_ENABLED flag)
lines: ~200
risk: 中
feature_flag: FEATURE_TABLE_RBAC_ENABLED=false (default)

definition_of_done:
  - [ ] RBAC table permissions implementation complete
  - [ ] ViewService RBAC integration methods added
  - [ ] Feature flag FEATURE_TABLE_RBAC_ENABLED configured
  - [ ] RBAC unit tests pass with >80% coverage
  - [ ] Integration tests verify permission checks
  - [ ] Lints and typecheck pass
  - [ ] Permission denied scenarios properly handled
  - [ ] RBAC cache metrics present (hits/misses)
  - [ ] Code review approved
  - [ ] RBAC documentation updated

validation:
  - RBAC tests pass
  - Permission checks work with flag enabled
  - Cache metrics observable
```

#### Phase 3: API Routes
```yaml
branch: split/246-phase3-routes-views-scope
depends_on: split/246-phase2-rbac-table-perms
scope: View endpoints update
files:
  - metasheet-v2/packages/core-backend/src/routes/views.ts
  - metasheet-v2/packages/core-backend/src/config/flags.ts (FEATURE_VIEWSERVICE_ROUTES flag)
lines: ~150
risk: 中
feature_flag: FEATURE_VIEWSERVICE_ROUTES=false (default)

definition_of_done:
  - [ ] View API routes updated with ViewService integration
  - [ ] Feature flag FEATURE_VIEWSERVICE_ROUTES configured
  - [ ] Route tests pass (unit + integration)
  - [ ] Backward compatibility maintained (old routes still work)
  - [ ] Lints and typecheck pass
  - [ ] API documentation updated (OpenAPI spec)
  - [ ] Error handling properly implemented
  - [ ] Code review approved

validation:
  - Route tests pass
  - Backward compatibility maintained
  - OpenAPI spec valid
```

#### Phase 4: Metrics & Observability
```yaml
branch: split/246-phase4-metrics-compat
depends_on: split/246-phase3-routes-views-scope
scope: Metrics and telemetry
files:
  - metasheet-v2/packages/core-backend/src/metrics/metrics.ts
  - metasheet-v2/packages/core-backend/src/observability/ObservabilityManager.ts
  - metasheet-v2/packages/core-backend/src/telemetry/index.ts
  - metasheet-v2/packages/core-backend/src/config/flags.ts (FEATURE_VIEWSERVICE_METRICS flag)
lines: ~150
risk: 低
feature_flag: FEATURE_VIEWSERVICE_METRICS=false (default)

definition_of_done:
  - [ ] ViewService metrics collection implemented
  - [ ] ObservabilityManager integration complete
  - [ ] Telemetry events configured
  - [ ] Feature flag FEATURE_VIEWSERVICE_METRICS configured
  - [ ] Metrics tests pass
  - [ ] No performance degradation (benchmark tests)
  - [ ] Prometheus metrics accessible at /metrics/prom
  - [ ] Lints and typecheck pass
  - [ ] Code review approved

validation:
  - Metrics collection works
  - No performance impact
  - Prometheus endpoint responsive
```

#### Phase 5: Plugin Integration
```yaml
branch: split/246-phase5-plugin-touchpoints
depends_on: split/246-phase4-metrics-compat
scope: Plugin loader integration
files:
  - metasheet-v2/packages/core-backend/src/core/plugin-loader.ts
  - metasheet-v2/packages/core-backend/src/config/flags.ts (reuse FEATURE_VIEWSERVICE_UNIFICATION)
lines: ~70
risk: 低
feature_flag: FEATURE_VIEWSERVICE_UNIFICATION (reuse from Phase 1)

definition_of_done:
  - [ ] Plugin loader integrated with ViewService
  - [ ] ViewService plugin hooks implemented
  - [ ] Plugin tests pass
  - [ ] Existing plugins continue to work
  - [ ] Lints and typecheck pass
  - [ ] Plugin documentation updated
  - [ ] Code review approved

validation:
  - Plugin tests pass
  - ViewService plugin hooks work
  - No existing plugin breakage
```

---

### PR #158 - infra/admin/observability + ViewService

**规模**: +670/-75行, 14文件
**分支**: `fix/infra-admin-observability-rbac-views-service`
**核心修改**:

```yaml
core_changes:
  admin_routes:
    - metasheet-v2/packages/core-backend/src/routes/admin.ts
    - Admin endpoints

  jwt_middleware:
    - metasheet-v2/packages/core-backend/src/auth/jwt-middleware.ts
    - Auth improvements

  view_service:
    - metasheet-v2/packages/core-backend/src/services/view-service.ts
    - ViewService implementation (与PR #246冲突!)

  metrics:
    - metasheet-v2/packages/core-backend/src/metrics/metrics.ts
    - Metrics updates

  scripts:
    - metasheet-v2/packages/core-backend/scripts/gen-dev-token.ts
    - metasheet-v2/packages/core-backend/scripts/pre-merge-check.ts
    - Dev tools

  index:
    - metasheet-v2/packages/core-backend/src/index.ts
    - Main app wiring
```

**冲突分析**:
```yaml
conflict_with_246:
  file: metasheet-v2/packages/core-backend/src/services/view-service.ts
  severity: HIGH
  resolution: PR #246的ViewService作为source of truth

conflict_with_155:
  files:
    - metasheet-v2/packages/core-backend/src/services/view-service.ts
    - metasheet-v2/packages/core-backend/src/routes/admin.ts
    - metasheet-v2/packages/core-backend/src/metrics/metrics.ts
  severity: HIGH
  resolution: PR #155的ViewService + admin作为source of truth
```

**处理策略**:
```yaml
decision: Close PR #158, cherry-pick unique changes
reason: 与PR #246和#155高度重复，且处于中间状态

unique_changes_to_cherry_pick:
  - JWT middleware improvements (独立PR)
  - gen-dev-token.ts updates (合并到PR #246)
  - pre-merge-check.ts updates (独立PR)
  - 部分admin routes (review后决定)
```

---

### PR #155 - config/admin/db health + observability + RBAC + ViewService

**规模**: +6092/-9行, 21文件 ⚠️ **最大PR!**
**分支**: `fix/infra-admin-observability-rbac-cache`
**核心修改**:

```yaml
frontend_changes:
  view_manager:
    - metasheet-v2/apps/web/src/services/ViewManager.ts
    - Frontend ViewService integration

  types:
    - metasheet-v2/apps/web/src/types/views.ts
    - Type definitions

  registry:
    - metasheet-v2/apps/web/src/view-registry.ts
    - View registration

  components:
    - metasheet-v2/apps/web/src/views/FormView.vue
    - metasheet-v2/apps/web/src/views/GalleryView.vue
    - Form and Gallery views

backend_changes:
  view_service:
    - metasheet-v2/packages/core-backend/src/services/ViewService.ts (旧版本!)
    - metasheet-v2/packages/core-backend/src/services/view-service.ts (新版本)
    - 两个ViewService文件 (问题!)

  admin:
    - metasheet-v2/packages/core-backend/src/routes/admin.ts
    - Admin endpoints

  metrics:
    - metasheet-v2/packages/core-backend/src/metrics/metrics.ts
    - Metrics collection

  jwt:
    - metasheet-v2/packages/core-backend/src/auth/jwt-middleware.ts
    - JWT auth

  index:
    - metasheet-v2/packages/core-backend/src/index.ts
    - Main app

  scripts:
    - metasheet-v2/packages/core-backend/scripts/pre-merge-check.ts
    - Pre-merge validation

migrations:
  - metasheet-v2/packages/core-backend/migrations/037_add_gallery_form_support.sql
  - metasheet-v2/packages/core-backend/migrations/038_add_view_query_indexes.sql

workflows:
  - metasheet-v2/.github/workflows/deploy.yml
  - metasheet-v2/.github/workflows/monitoring-alert.yml
```

**问题识别**:
```yaml
major_issues:
  duplicate_viewservice:
    files:
      - ViewService.ts (PascalCase - 旧版本)
      - view-service.ts (kebab-case - 新版本)
    problem: 两个不同的ViewService实现
    resolution: 统一使用view-service.ts (kebab-case)

  scope_too_large:
    lines: 6092
    files: 21
    domains: ["frontend", "backend", "migrations", "workflows"]
    problem: 跨越太多领域，难以review和test
    resolution: 拆分为6-8个子PR
```

**拆分策略**:

#### Phase 1A: Backend Migrations
```yaml
branch: split/155-phase1a-backend-migrations
scope: Database schema changes
files:
  - metasheet-v2/packages/core-backend/migrations/037_add_gallery_form_support.sql
  - metasheet-v2/packages/core-backend/migrations/038_add_view_query_indexes.sql
lines: ~100
risk: 中 (schema changes)
feature_flag: N/A (migrations are one-way)

definition_of_done:
  - [ ] Migration scripts created with up/down SQL
  - [ ] Migration replay test passes
  - [ ] Indexes created correctly on target tables
  - [ ] No performance degradation (query benchmarks)
  - [ ] Migration documented in CHANGELOG
  - [ ] Rollback SQL tested
  - [ ] Code review approved

validation:
  - Migration replay test passes
  - Indexes created correctly
  - No performance degradation
  - Rollback works correctly
```

#### Phase 1B: Backend ViewService Core
```yaml
branch: split/155-phase1b-viewservice-unified
depends_on: split/155-phase1a-backend-migrations
scope: ViewService implementation (unified with PR #246)
files:
  - metasheet-v2/packages/core-backend/src/services/view-service.ts
  - Remove: metasheet-v2/packages/core-backend/src/services/ViewService.ts (duplicate)
  - metasheet-v2/packages/core-backend/src/config/flags.ts (FEATURE_VIEWSERVICE_UNIFICATION)
lines: ~400
risk: 中
feature_flag: FEATURE_VIEWSERVICE_UNIFICATION=false (default)
coordination: Merge/coordinate with split/246-phase1-viewservice-core

definition_of_done:
  - [ ] Duplicate ViewService.ts removed
  - [ ] Unified view-service.ts implementation complete
  - [ ] Feature flag FEATURE_VIEWSERVICE_UNIFICATION configured
  - [ ] All ViewService tests pass
  - [ ] No duplicate class references in codebase
  - [ ] TypeScript compilation succeeds
  - [ ] Lints pass
  - [ ] Integration with migrations validated
  - [ ] Code review approved

validation:
  - ViewService tests pass
  - No duplicate classes
  - Clean codebase (no ViewService.ts)
```

#### Phase 2: JWT & Auth
```yaml
branch: split/155-phase2-jwt-improvements
depends_on: split/155-phase1b-viewservice-unified
scope: JWT middleware improvements
files:
  - metasheet-v2/packages/core-backend/src/auth/jwt-middleware.ts
  - metasheet-v2/packages/core-backend/src/config/flags.ts (FEATURE_JWT_IMPROVEMENTS)
lines: ~100
risk: 高 (auth changes!)
feature_flag: FEATURE_JWT_IMPROVEMENTS=false (default)

definition_of_done:
  - [ ] JWT middleware implementation complete
  - [ ] Feature flag FEATURE_JWT_IMPROVEMENTS configured
  - [ ] Auth tests pass with >90% coverage
  - [ ] Backward compatibility maintained (old tokens work)
  - [ ] Security review completed and approved
  - [ ] Token expiry handling correct
  - [ ] Refresh token logic tested
  - [ ] Lints and typecheck pass
  - [ ] Security documentation updated
  - [ ] Code review approved

validation:
  - Auth tests pass
  - Backward compatibility maintained
  - Security review required and completed
  - No authentication bypass vulnerabilities
```

#### Phase 3: Admin Routes
```yaml
branch: split/155-phase3-admin-routes
depends_on: split/155-phase2-jwt-improvements
scope: Admin endpoints
files:
  - metasheet-v2/packages/core-backend/src/routes/admin.ts
  - metasheet-v2/packages/core-backend/src/config/flags.ts (FEATURE_ADMIN_ROUTES_V2)
lines: ~200
risk: 中
feature_flag: FEATURE_ADMIN_ROUTES_V2=false (default)

definition_of_done:
  - [ ] Admin route implementations complete
  - [ ] Feature flag FEATURE_ADMIN_ROUTES_V2 configured
  - [ ] Admin endpoint tests pass
  - [ ] Proper RBAC authentication on all admin endpoints
  - [ ] Authorization checks for admin-only operations
  - [ ] OpenAPI spec updated for admin routes
  - [ ] Lints and typecheck pass
  - [ ] Admin documentation updated
  - [ ] Code review approved

validation:
  - Admin endpoint tests pass
  - Proper authentication and authorization
  - Non-admin users properly denied
```

#### Phase 4: Metrics & Index
```yaml
branch: split/155-phase4-metrics-index
depends_on: split/155-phase3-admin-routes
scope: Metrics and main app wiring
files:
  - metasheet-v2/packages/core-backend/src/metrics/metrics.ts
  - metasheet-v2/packages/core-backend/src/index.ts
  - metasheet-v2/packages/core-backend/src/config/flags.ts (FEATURE_METRICS_V2)
lines: ~250
risk: 中
feature_flag: FEATURE_METRICS_V2=false (default)

definition_of_done:
  - [ ] Metrics V2 implementation complete
  - [ ] Main app wiring updated with new metrics
  - [ ] Feature flag FEATURE_METRICS_V2 configured
  - [ ] Metrics tests pass
  - [ ] App starts correctly with/without flag
  - [ ] No performance degradation
  - [ ] Prometheus endpoint /metrics/prom responsive
  - [ ] Grafana dashboard compatible
  - [ ] Lints and typecheck pass
  - [ ] Code review approved

validation:
  - Metrics collection works
  - App starts correctly
  - Prometheus scraping works
```

#### Phase 5: Scripts
```yaml
branch: split/155-phase5-scripts
depends_on: split/155-phase4-metrics-index
scope: Dev tools and pre-merge checks
files:
  - metasheet-v2/packages/core-backend/scripts/pre-merge-check.ts
lines: ~100
risk: 低
feature_flag: N/A (dev tools)

definition_of_done:
  - [ ] Pre-merge check script implementation complete
  - [ ] Script runs correctly in CI/CD
  - [ ] All checks pass (lints, tests, migrations, etc.)
  - [ ] Error messages clear and actionable
  - [ ] Exit codes correct (0 success, 1 failure)
  - [ ] Documentation updated
  - [ ] Code review approved

validation:
  - Scripts run correctly
  - Pre-merge checks work
  - CI integration validated
```

#### Phase 6: Frontend Types
```yaml
branch: split/155-phase6-frontend-types
depends_on: split/155-phase1b-viewservice-unified
scope: Frontend type definitions
files:
  - metasheet-v2/apps/web/src/types/views.ts
lines: ~150
risk: 低
feature_flag: N/A (types only)

definition_of_done:
  - [ ] View type definitions complete
  - [ ] TypeScript interfaces match backend contracts
  - [ ] TypeScript compilation succeeds with no errors
  - [ ] No breaking type changes (backward compatible)
  - [ ] Type exports properly configured
  - [ ] Frontend lints pass
  - [ ] Type documentation (JSDoc comments)
  - [ ] Code review approved

validation:
  - TypeScript compilation succeeds
  - No breaking type changes
  - Frontend builds successfully
```

#### Phase 7: Frontend ViewManager
```yaml
branch: split/155-phase7-frontend-viewmanager
depends_on: split/155-phase6-frontend-types
scope: Frontend ViewService integration
files:
  - metasheet-v2/apps/web/src/services/ViewManager.ts
  - metasheet-v2/apps/web/src/view-registry.ts
  - metasheet-v2/apps/web/src/config/flags.ts (FEATURE_VIEW_MANAGER_V2)
lines: ~300
risk: 中
feature_flag: FEATURE_VIEW_MANAGER_V2=false (default)

definition_of_done:
  - [ ] ViewManager implementation complete
  - [ ] View registry fully functional
  - [ ] Feature flag FEATURE_VIEW_MANAGER_V2 configured
  - [ ] ViewManager unit tests pass
  - [ ] Registry tests pass
  - [ ] Frontend lints and typecheck pass
  - [ ] Proper error handling
  - [ ] Loading states implemented
  - [ ] Code review approved

validation:
  - View management works
  - Registry functions correctly
  - Flag toggle works properly
```

#### Phase 8: Frontend Components
```yaml
branch: split/155-phase8-frontend-components
depends_on: split/155-phase7-frontend-viewmanager
scope: Form and Gallery views
files:
  - metasheet-v2/apps/web/src/views/FormView.vue
  - metasheet-v2/apps/web/src/views/GalleryView.vue
  - metasheet-v2/apps/web/src/config/flags.ts (FEATURE_FORM_GALLERY_VIEWS)
lines: ~500
risk: 中
feature_flag: FEATURE_FORM_GALLERY_VIEWS=false (default)

definition_of_done:
  - [ ] FormView component implemented
  - [ ] GalleryView component implemented
  - [ ] Feature flag FEATURE_FORM_GALLERY_VIEWS configured
  - [ ] Component unit tests pass
  - [ ] E2E tests pass
  - [ ] Components render correctly
  - [ ] User interactions work (click, form submit, etc.)
  - [ ] Responsive design validated
  - [ ] Accessibility (a11y) checks pass
  - [ ] Frontend lints and typecheck pass
  - [ ] Code review approved

validation:
  - Components render correctly
  - User interactions work
  - E2E tests pass
  - Accessibility compliant
```

#### Phase 9: Workflows
```yaml
branch: split/155-phase9-workflows
depends_on: All above phases
scope: CI/CD workflow updates
files:
  - metasheet-v2/.github/workflows/deploy.yml
  - metasheet-v2/.github/workflows/monitoring-alert.yml
lines: ~100
risk: 中 (workflow changes)
feature_flag: N/A (workflows)

definition_of_done:
  - [ ] Deploy workflow updated
  - [ ] Monitoring alert workflow updated
  - [ ] Workflows run correctly in CI/CD
  - [ ] Deploy process tested
  - [ ] Rollback process validated
  - [ ] No breaking changes to existing workflows
  - [ ] Workflow documentation updated
  - [ ] Code review approved

validation:
  - Workflows run correctly
  - Deploy process works
  - Monitoring alerts functional
```

---

## 🔄 整体合并顺序

### Track 1: ViewService核心 (基于PR #246)
```
split/246-phase1-viewservice-core
  → split/246-phase2-rbac-table-perms
  → split/246-phase3-routes-views-scope
  → split/246-phase4-metrics-compat
  → split/246-phase5-plugin-touchpoints

(Core) → (RBAC) → (Routes) → (Metrics) → (Plugin)
```

### Track 2: PR #155后端部分 (依赖Track 1)
```
split/155-phase1a-backend-migrations
  → split/155-phase1b-viewservice-unified (coordinate with split/246-phase1)
  → split/155-phase2-jwt-improvements
  → split/155-phase3-admin-routes
  → split/155-phase4-metrics-index
  → split/155-phase5-scripts

(Migrations) → (ViewService) → (JWT) → (Admin) → (Metrics) → (Scripts)
```

### Track 3: PR #155前端部分 (依赖Track 2)
```
split/155-phase6-frontend-types
  → split/155-phase7-frontend-viewmanager
  → split/155-phase8-frontend-components
  → split/155-phase9-workflows

(Types) → (Manager) → (Components) → (Workflows)
```

### Track 4: PR #158处理 (并行或放弃)
```yaml
option_A: Close PR #158
  action: Cherry-pick unique changes到相关分支
  unique_changes:
    - JWT improvements → merge into split/155-phase2-jwt-improvements
    - gen-dev-token updates → merge into split/246-phase1-viewservice-core
    - pre-merge-check updates → merge into split/155-phase5-scripts
  effort: 低

option_B: Rebase PR #158 on Track 1 & 2
  action: Resolve conflicts, merge unique changes
  effort: 高
  risk: 高 (many conflicts)

recommendation: Option A (Close + cherry-pick)
reason: PR #158与#246和#155重叠度高，直接关闭并cherry-pick独特变更更高效
```

---

## 📋 执行计划

### Week 1: 准备和快速修复

**Day 1-2**:
```yaml
- [x] PR #244: 合并main继承最新workflow (已完成)
- [ ] PR #244: 等待lints通过，添加automerge标签
- [ ] 等待Dependabot PRs自动合并 (#247-#256)
```

**Day 3-5**:
```yaml
- [ ] split/246-phase1-viewservice-core: ViewService核心实现
  - 创建FEATURE_VIEWSERVICE_UNIFICATION flag in config/flags.ts
  - 实现core methods
  - 添加unit tests
  - 确保lints通过
```

### Week 2: Backend Track (Track 1)

**Day 1-2**:
```yaml
- [ ] split/246-phase2-rbac-table-perms: RBAC integration
  - 依赖split/246-phase1-viewservice-core
  - RBAC permission checks
  - Integration tests
```

**Day 3-4**:
```yaml
- [ ] split/246-phase3-routes-views-scope: API Routes
  - 依赖split/246-phase2-rbac-table-perms
  - Update view endpoints
  - Backward compatibility tests
```

**Day 5**:
```yaml
- [ ] split/246-phase4-metrics-compat: Metrics & Observability
  - 依赖split/246-phase3-routes-views-scope
  - Metrics collection
  - Telemetry integration
```

### Week 3: Backend Track 2 + PR #155处理

**Day 1-2**:
```yaml
- [ ] split/155-phase1a-backend-migrations: Migrations (from PR #155)
  - Gallery & Form schema
  - View indexes
  - Migration replay tests
```

**Day 3-4**:
```yaml
- [ ] split/155-phase1b-viewservice-unified: Unified ViewService
  - Coordinate with split/246-phase1-viewservice-core
  - Remove duplicate ViewService.ts
  - Unify implementations
  - Comprehensive tests
```

**Day 5**:
```yaml
- [ ] split/155-phase2-jwt-improvements: JWT improvements
  - Auth middleware updates
  - Security review
  - Backward compatibility
```

### Week 4: Frontend Track

**Day 1-2**:
```yaml
- [ ] split/155-phase3-admin-routes: Admin routes
- [ ] split/155-phase4-metrics-index: Metrics & Index
- [ ] split/155-phase5-scripts: Scripts
```

**Day 3-4**:
```yaml
- [ ] split/155-phase6-frontend-types: Frontend types
- [ ] split/155-phase7-frontend-viewmanager: Frontend ViewManager
```

**Day 5**:
```yaml
- [ ] split/155-phase8-frontend-components: Frontend components
- [ ] split/155-phase9-workflows: Workflows
```

---

## 🎯 Feature Flag管理

### Flag定义
```typescript
// metasheet-v2/packages/core-backend/src/config/flags.ts
export const FEATURE_FLAGS = {
  // ViewService Unification (PR #246 Track)
  FEATURE_VIEWSERVICE_UNIFICATION: process.env.FEATURE_VIEWSERVICE_UNIFICATION === 'true',
  FEATURE_TABLE_RBAC_ENABLED: process.env.FEATURE_TABLE_RBAC_ENABLED === 'true',
  FEATURE_VIEWSERVICE_ROUTES: process.env.FEATURE_VIEWSERVICE_ROUTES === 'true',
  FEATURE_VIEWSERVICE_METRICS: process.env.FEATURE_VIEWSERVICE_METRICS === 'true',

  // PR #155 Backend Features
  FEATURE_JWT_IMPROVEMENTS: process.env.FEATURE_JWT_IMPROVEMENTS === 'true',
  FEATURE_ADMIN_ROUTES_V2: process.env.FEATURE_ADMIN_ROUTES_V2 === 'true',
  FEATURE_METRICS_V2: process.env.FEATURE_METRICS_V2 === 'true',

  // PR #155 Frontend Features
  FEATURE_VIEW_MANAGER_V2: process.env.FEATURE_VIEW_MANAGER_V2 === 'true',
  FEATURE_FORM_GALLERY_VIEWS: process.env.FEATURE_FORM_GALLERY_VIEWS === 'true',
};

// Type-safe flag accessor
export function isFeatureEnabled(flag: keyof typeof FEATURE_FLAGS): boolean {
  return FEATURE_FLAGS[flag] === true;
}
```

### 渐进式启用计划
```yaml
phase_1_dev:
  environment: development
  flags:
    FEATURE_VIEWSERVICE_UNIFICATION: true
  validation: Dev environment testing

phase_2_staging:
  environment: staging
  flags:
    FEATURE_VIEWSERVICE_UNIFICATION: true
    FEATURE_TABLE_RBAC_ENABLED: true
  validation: Integration testing

phase_3_canary:
  environment: production (10% traffic)
  flags:
    FEATURE_VIEWSERVICE_UNIFICATION: true
    FEATURE_TABLE_RBAC_ENABLED: true
    FEATURE_VIEWSERVICE_ROUTES: true
  validation: Real traffic monitoring

phase_4_production:
  environment: production (100% traffic)
  flags: All enabled
  validation: Full rollout monitoring

flag_naming_convention:
  prefix: FEATURE_
  format: FEATURE_{DOMAIN}_{CAPABILITY}
  examples:
    - FEATURE_VIEWSERVICE_UNIFICATION
    - FEATURE_TABLE_RBAC_ENABLED
    - FEATURE_JWT_IMPROVEMENTS
```

---

## ⚠️ 风险管理

### 风险矩阵与对策

| 风险类别 | 具体风险 | 可能性 | 影响 | 风险等级 | 缓解措施 | 应急预案 |
|---------|---------|--------|------|---------|---------|---------|
| **认证授权** | JWT middleware变更导致认证bypass | 中 | 严重 | 🔴 HIGH | • Security code review (2人)<br>• 专门auth test suite<br>• Backward compatibility testing<br>• Feature flag FEATURE_JWT_IMPROVEMENTS=false | • 立即回滚commit<br>• Toggle flag to false<br>• 通知security team<br>• 发布security advisory |
| **ViewService统一** | ViewService重构破坏既有功能 | 中-高 | 高 | 🟡 MEDIUM-HIGH | • 保留旧ViewService作为fallback<br>• 100%测试覆盖<br>• Feature flag保护<br>• Canary deployment (10% traffic) | • Toggle FEATURE_VIEWSERVICE_UNIFICATION=false<br>• 监控error rate<br>• 准备hotfix分支 |
| **RBAC缓存** | table-perms RBAC逻辑错误导致越权 | 中 | 严重 | 🟡 MEDIUM-HIGH | • RBAC unit tests (allow + deny cases)<br>• Integration tests with real permissions<br>• Manual security testing<br>• Feature flag FEATURE_TABLE_RBAC_ENABLED=false | • Toggle flag to false<br>• 审计access logs<br>• 通知affected users<br>• Hotfix permission checks |
| **数据库迁移** | Migration破坏数据或索引性能下降 | 低-中 | 高 | 🟡 MEDIUM | • Migration replay testing (3 envs)<br>• Database backup before migration<br>• Rollback SQL prepared and tested<br>• Performance benchmarks (before/after) | • Execute rollback migration<br>• Restore from backup if needed<br>• 重新评估migration策略 |
| **routes/views.ts重叠** | PR #246和#155同时修改routes/views.ts冲突 | 高 | 中 | 🟡 MEDIUM | • split/246-phase3先合并<br>• split/155 rebase on latest<br>• 保留兼容层（旧routes继续工作）<br>• API versioning (/api/v1, /api/v2) | • Git conflict resolution<br>• Manual merge testing<br>• Rollback to stable version<br>• 延后conflicting PR |
| **metrics字段变更** | Observability metrics格式变更导致监控失效 | 中 | 中 | 🟢 MEDIUM | • 先添加兼容字段（同时保留旧字段）<br>• Prometheus metrics mapping<br>• Grafana dashboard不改阈值<br>• Feature flag FEATURE_METRICS_V2=false | • Toggle to old metrics<br>• 更新Grafana dashboards<br>• Backfill missing data |
| **Frontend type breaking** | Backend type changes导致frontend编译失败 | 中 | 中 | 🟢 MEDIUM | • Frontend types先于实现<br>• Backward compatible type changes<br>• TypeScript strict mode<br>• Frontend build in CI | • 回滚type changes<br>• 添加type compatibility layer<br>• 修复frontend compilation |
| **Plugin integration** | ViewService plugin hooks破坏现有plugins | 低 | 中 | 🟢 LOW-MEDIUM | • Plugin compatibility tests<br>• Plugin registry validation<br>• 通知plugin authors<br>• Deprecation warnings | • Disable plugin hooks<br>• Rollback to stable plugin API<br>• 提供migration guide |
| **Performance degradation** | 新代码导致响应时间增加或内存泄露 | 中 | 中 | 🟢 MEDIUM | • Load testing (k6 benchmarks)<br>• Memory profiling<br>• APM monitoring (DataDog/NewRelic)<br>• Performance budgets | • Toggle feature flags<br>• 优化hot paths<br>• 增加server capacity<br>• Rollback if severe |
| **CI/CD workflow破坏** | Workflow changes导致deploy失败 | 低 | 高 | 🟢 MEDIUM | • Workflow testing in feature branch<br>• Staged rollout (1 workflow at a time)<br>• Rollback plan for workflows | • Revert workflow commits<br>• Manual deploy process<br>• 修复workflow errors |

### 高风险区域详细说明

```yaml
jwt_changes:
  risk_level: 🔴 HIGH
  phases_affected: [split/155-phase2-jwt-improvements]
  mitigation:
    - Security team review (2 reviewers minimum)
    - Extensive auth testing (unit + integration + E2E)
    - Canary deployment (10% → 50% → 100%)
    - Quick rollback plan (feature flag toggle)
  validation_gates:
    - [ ] Security review sign-off
    - [ ] No auth bypass vulnerabilities
    - [ ] Backward compatibility verified
    - [ ] Token expiry logic correct

viewservice_unification:
  risk_level: 🟡 MEDIUM-HIGH
  phases_affected:
    - split/246-phase1-viewservice-core
    - split/155-phase1b-viewservice-unified
  mitigation:
    - Comprehensive unit tests (>90% coverage)
    - Integration tests (all view operations)
    - Feature flag protection (default: false)
    - Gradual rollout (dev → staging → canary → prod)
  coordination_required:
    - Merge split/246-phase1 first
    - split/155-phase1b rebases on split/246-phase1
    - Remove duplicate ViewService.ts
    - Unify tests and interfaces

database_migrations:
  risk_level: 🟡 MEDIUM
  phases_affected: [split/155-phase1a-backend-migrations]
  mitigation:
    - Migration replay testing (3 environments)
    - Database backup before migration
    - Rollback SQL prepared and tested
    - Performance benchmarks (query time before/after)
  validation_gates:
    - [ ] Migration replay passes
    - [ ] Indexes created correctly
    - [ ] No query performance degradation (< 10% increase)
    - [ ] Rollback tested successfully

routes_overlap:
  risk_level: 🟡 MEDIUM
  phases_affected:
    - split/246-phase3-routes-views-scope
    - split/155-phase3-admin-routes
  mitigation:
    - Merge split/246-phase3 before split/155-phase3
    - Keep compatibility layer (old routes continue to work)
    - API versioning if needed (/api/v1, /api/v2)
    - Comprehensive route testing
  coordination_strategy:
    - split/246-phase3 establishes new route patterns
    - split/155-phase3 follows same patterns
    - No conflicting endpoint definitions
    - OpenAPI spec stays consistent

metrics_compatibility:
  risk_level: 🟢 MEDIUM
  phases_affected:
    - split/246-phase4-metrics-compat
    - split/155-phase4-metrics-index
  mitigation:
    - Add new metrics while keeping old ones
    - Prometheus metrics mapping layer
    - Grafana dashboards updated gradually
    - No threshold changes initially
  rollback_strategy:
    - Toggle FEATURE_METRICS_V2=false
    - Old metrics still available
    - Grafana falls back to old metrics
    - Zero monitoring downtime
```

### Rollback策略
```yaml
code_rollback:
  method: git revert
  steps:
    1. Identify failing commit
    2. Create revert PR
    3. Fast-track merge with admin override
    4. Verify service recovery

feature_flag_rollback:
  method: Environment variable change
  steps:
    1. Set flag to false in environment
    2. Restart services (or wait for hot-reload)
    3. Monitor metrics
    4. Investigate root cause

database_rollback:
  method: Migration down
  steps:
    1. Execute down migration
    2. Verify data integrity
    3. Update application config
    4. Restart services
```

---

## 📊 成功指标

### PR质量指标
```yaml
per_pr_limits:
  additions: < 500 lines (ideal < 300)
  deletions: < 200 lines
  files_changed: < 10
  review_time: < 2 hours
  ci_time: < 5 minutes
```

### 合并速度指标
```yaml
timeline_targets:
  pr_creation_to_review: < 1 day
  review_to_approval: < 1 day
  approval_to_merge: < 4 hours (automerge)
  total_cycle_time: < 3 days
```

### 质量保证指标
```yaml
quality_gates:
  lints_pass_rate: 100%
  test_coverage: > 80%
  integration_test_pass: 100%
  observability_e2e_pass: 100%
  zero_production_incidents: required
```

---

## 🔧 工具和自动化

### PR模板
```markdown
## PR信息
- **Parent PR**: #246 / #155 / #158
- **Track**: ViewService Core / Frontend / Backend Track 2
- **Phase**: 1 / 2 / 3 / ...
- **Feature Flags**: VIEW_SERVICE_ENABLED=false

## 修改范围
- **Lines**: +X/-Y
- **Files**: N files
- **Domains**: [backend/frontend/migrations/workflows]

## 依赖关系
- **Depends on**: PR #XXX (merged)
- **Blocks**: PR #YYY
- **Conflicts with**: None / PR #ZZZ

## 测试计划
- [ ] Unit tests
- [ ] Integration tests
- [ ] E2E tests
- [ ] Migration replay
- [ ] Manual testing

## Feature Flag设置
```bash
# Development
export VIEW_SERVICE_ENABLED=true

# Production (disabled by default)
export VIEW_SERVICE_ENABLED=false
```

## Rollback Plan
1. Method: git revert / feature flag toggle
2. Steps: [具体步骤]
3. Validation: [验证方法]

## Checklist
- [ ] Lints pass
- [ ] Tests pass
- [ ] Feature flag protection
- [ ] Documentation updated
- [ ] Changelog updated
```

### 自动化脚本
```bash
# scripts/create-split-pr.sh
#!/bin/bash
set -euo pipefail

PARENT_PR=$1
PHASE=$2
BRANCH_NAME="feat/split-${PARENT_PR}-phase-${PHASE}"

git checkout main
git pull origin main
git checkout -b "$BRANCH_NAME"

# Cherry-pick specific changes
# (Manual step - identify commits)

# Create PR with template
gh pr create --title "feat(split): PR #${PARENT_PR} Phase ${PHASE}" \
  --body-file .github/SPLIT_PR_TEMPLATE.md \
  --label "split-pr,automerge"

echo "Created branch: $BRANCH_NAME"
echo "PR created with automerge label"
```

---

## 📚 文档要求

### 每个子PR必须包含
```yaml
documentation:
  - CHANGELOG.md entry
  - 相关的API documentation updates
  - Feature flag usage guide
  - Testing guide
  - Rollback procedures

code_comments:
  - Feature flag guards explained
  - Complex logic documented
  - Migration rationale explained
  - Breaking changes highlighted
```

---

## 🎯 总结

### 关键原则
1. **最小变更单元** - 每个PR只做一件事
2. **Feature Flag保护** - 所有新功能默认禁用
3. **渐进式合并** - 遵循依赖顺序
4. **快速rollback** - 每个PR都有回滚计划
5. **持续验证** - 每个阶段都有完整测试

### 预期成果
- 将3个大PR (6500+行)拆分为15-18个小PR (~300行/PR)
- 每个PR独立可review、可test、可rollback
- 4周内完成全部合并
- 零生产事故
- 代码质量显著提升

### 下一步行动
1. 创建PR #264修复shellcheck (今天)
2. PR #244添加automerge并合并 (今天)
3. 开始PR #246 Phase 1 (本周)
4. 定期sync meeting review进展 (每周)

---

**文档版本**: v1.0
**创建时间**: 2025-10-14
**最后更新**: 2025-10-14
**负责人**: Claude Code
**审核状态**: Ready for Review
