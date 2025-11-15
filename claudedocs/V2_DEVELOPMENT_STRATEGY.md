# V2-Only Development Strategy
## Complete V1 Abandonment & V2 Migration Plan

**Date**: October 30, 2025
**Purpose**: Establish V2 as the sole development branch, abandoning V1 completely
**Status**: ✅ Implementation Ready

---

## 🎯 Executive Summary

Based on your explicit decision "我想直接开发V2版本，原来的V1作罢" (I want to develop V2 directly, abandon the original V1), this document provides a comprehensive strategy for complete V1 abandonment and V2-only development.

**Current Status**:
- ✅ Successfully switched to v2/init branch
- ✅ V2 project structure confirmed: @metasheet/web v2.0.0-alpha.1
- ✅ TypeScript Phase 1 migration work safely stashed
- ⚠️ V2 feature branches need integration
- 🎯 Ready for V1 abandonment implementation

---

## 📋 Phase 1: Complete V1 Abandonment

### 1.1 Git Repository Restructuring

#### Set V2 as Main Branch
```bash
# Make v2/init the new main development branch
git checkout v2/init
git branch -m v2/init main-v2

# Push new main branch to remote
git push origin main-v2

# Set main-v2 as default branch on GitHub
# (Go to GitHub repo Settings → Branches → Default branch → main-v2)
```

#### Archive V1 Branches
```bash
# Archive all V1-related branches
git checkout main  # old V1 main
git branch -m main v1-archived
git push origin v1-archived

# Archive other V1 feature branches
git branch | grep -E "(feat/phase|feature/)" | while read branch; do
  git branch -m "$branch" "v1-archive/$branch"
  git push origin "v1-archive/$branch"
done
```

### 1.2 GitHub Repository Settings

1. **Default Branch Change**:
   - GitHub Settings → Branches → Default branch → Change to `main-v2`
   - Update branch protection rules for `main-v2`

2. **Branch Cleanup Strategy**:
   - Keep V1 branches as `v1-archive/*` for reference
   - Delete active V1 development branches after archival
   - Set `main-v2` as protected branch

3. **Documentation Updates**:
   - Update README.md to reflect V2-only development
   - Update CONTRIBUTING.md with V2 workflow
   - Archive V1 documentation in `docs/v1-archive/`

---

## 📋 Phase 2: V2 Feature Branch Integration

### 2.1 Current V2 Branch Analysis

**V2 Branches Discovered**:
1. `v2/integration-core-mvp` - Core integration features
2. `v2/permissions-sandbox` - RBAC permission system
3. `v2/messaging-rpc-mvp` - RPC messaging system
4. `v2/events-metrics-unify` - Event-driven metrics
5. `feat/v2-microkernel-architecture` - Microkernel architecture

**Integration Priority**:
```
Priority 1: Core Architecture
├── feat/v2-microkernel-architecture (Foundation)
└── v2/integration-core-mvp (Core features)

Priority 2: Essential Systems
├── v2/permissions-sandbox (Security)
└── v2/messaging-rpc-mvp (Communication)

Priority 3: Observability
└── v2/events-metrics-unify (Monitoring)
```

### 2.2 Integration Strategy

#### Step 1: Create V2 Feature Integration Branch
```bash
git checkout main-v2
git checkout -b v2/feature-integration
```

#### Step 2: Sequential Feature Merging
```bash
# Merge microkernel architecture first (foundation)
git merge feat/v2-microkernel-architecture --no-ff -m "feat: integrate V2 microkernel architecture"

# Merge core integration features
git merge v2/integration-core-mvp --no-ff -m "feat: integrate core V2 features"

# Merge permission system
git merge v2/permissions-sandbox --no-ff -m "feat: integrate RBAC permission system"

# Merge messaging system
git merge v2/messaging-rpc-mvp --no-ff -m "feat: integrate RPC messaging system"

# Merge metrics system
git merge v2/events-metrics-unify --no-ff -m "feat: integrate event-driven metrics"
```

#### Step 3: Conflict Resolution Plan
```bash
# For each merge conflict:
# 1. Identify conflicting files
# 2. Preserve V2 architecture patterns
# 3. Integrate features maintaining consistency
# 4. Test after each merge
# 5. Commit resolution with descriptive message
```

---

## 📋 Phase 3: TypeScript Migration to V2

### 3.1 Migrate Completed TypeScript Work

**Completed TypeScript Phase 1 Assets**:
- ✅ KanbanCard.vue with TypeScript interfaces
- ✅ router/types.ts (444-line comprehensive routing)
- ✅ http.ts (425-line HTTP client with types)
- ✅ CalendarView.vue TypeScript integration
- ✅ ProfessionalGridView.vue TypeScript integration

**Migration Strategy**:
```bash
# Apply stashed TypeScript work to V2
git stash list
git stash apply stash@{0}  # Apply TypeScript Phase 1 work

# Resolve any conflicts with V2 structure
# Update import paths for V2 architecture
# Maintain TypeScript strict mode compliance
```

### 3.2 V2 TypeScript Architecture

**Enhanced Type System for V2**:
```typescript
// V2-specific type enhancements
interface V2ComponentInterface {
  microkernel: MicrokernelPlugin
  permissions: RBACContext
  messaging: RPCClient
  metrics: EventCollector
}

// Migration pattern for V1 → V2 types
type V1ComponentType = LegacyComponent
type V2ComponentType = V1ComponentType & V2ComponentInterface
```

---

## 📋 Phase 4: Development Workflow Establishment

### 4.1 V2-Only Git Workflow

**Branch Structure**:
```
main-v2 (primary development)
├── feature/v2-* (new features)
├── bugfix/v2-* (bug fixes)
├── hotfix/v2-* (urgent fixes)
└── experiment/v2-* (experimental features)
```

**Workflow Rules**:
1. **All development branches from main-v2**
2. **No V1 branch interaction allowed**
3. **Feature branches must include "v2-" prefix**
4. **All PRs target main-v2 only**

### 4.2 Development Environment Setup

**V2 Development Commands**:
```bash
# Start V2 development environment
cd metasheet-v2/apps/web
npm install  # or pnpm install
npm run dev  # V2 development server

# V2 Build pipeline
npm run build      # V2 production build
npm run type-check # V2 TypeScript validation
npm run test       # V2 test suite
```

**V2 Architecture Validation**:
```bash
# Validate V2 microkernel architecture
npm run validate:microkernel

# Test V2 permission system
npm run test:permissions

# Verify V2 messaging system
npm run test:messaging

# Check V2 metrics collection
npm run test:metrics
```

---

## 📋 Phase 5: Code Migration & Reuse Strategy

### 5.1 V1 Code Reuse Assessment

**Reusable Components** (migrate to V2):
- ✅ TypeScript interfaces and types
- ✅ Vue 3 components (adapt to V2 architecture)
- ✅ Utility functions and helpers
- ✅ Test suites (update for V2 patterns)
- ✅ Configuration files (adapt paths)

**V1-Specific Code** (abandon):
- ❌ V1 build configurations
- ❌ V1 routing patterns (replaced by V2 router)
- ❌ V1 state management (replaced by V2 microkernel)
- ❌ V1 API integration (replaced by V2 RPC)

### 5.2 Migration Checklist

**High-Priority Migrations**:
- [ ] TypeScript type definitions → V2 architecture
- [ ] Vue 3 components → V2 microkernel plugins
- [ ] HTTP client → V2 RPC messaging
- [ ] Router configuration → V2 routing system
- [ ] State management → V2 permission context

**Testing Strategy**:
- [ ] Port existing test suites to V2
- [ ] Create V2 integration tests
- [ ] Validate V2 architecture compliance
- [ ] Performance testing for V2 systems

---

## 📋 Phase 6: Team Communication & Documentation

### 6.1 Team Announcement

**Communication Points**:
1. **V1 Development Officially Discontinued**
2. **All future work on V2 branches only**
3. **V1 branches archived for reference**
4. **New development workflow established**

### 6.2 Documentation Updates

**Required Updates**:
- [ ] README.md → V2 setup and development
- [ ] CONTRIBUTING.md → V2 workflow rules
- [ ] Architecture docs → V2 microkernel design
- [ ] API documentation → V2 RPC endpoints
- [ ] Deployment guides → V2 build pipeline

---

## 🎯 Implementation Timeline

**Week 1: Repository Restructuring**
- [ ] Set main-v2 as default branch
- [ ] Archive V1 branches
- [ ] Update GitHub settings

**Week 2: Feature Integration**
- [ ] Merge V2 feature branches
- [ ] Resolve integration conflicts
- [ ] Test integrated V2 system

**Week 3: TypeScript Migration**
- [ ] Apply TypeScript Phase 1 to V2
- [ ] Update types for V2 architecture
- [ ] Validate TypeScript compilation

**Week 4: Workflow Establishment**
- [ ] Finalize V2 development workflow
- [ ] Update team documentation
- [ ] Train team on V2 patterns

---

## ✅ Success Criteria

**Repository Level**:
- [x] V2 branch is default and primary
- [ ] V1 branches archived appropriately
- [ ] All V2 features integrated successfully

**Development Level**:
- [ ] TypeScript Phase 1 work applied to V2
- [ ] V2 microkernel architecture functional
- [ ] All systems (permissions, messaging, metrics) working

**Team Level**:
- [ ] Team exclusively using V2 workflow
- [ ] Documentation reflects V2-only development
- [ ] No new V1 development activity

---

## 🚨 Risk Mitigation

**Potential Risks**:
1. **Feature Integration Conflicts** → Sequential merge strategy
2. **TypeScript Migration Issues** → Gradual application with testing
3. **Team Workflow Confusion** → Clear documentation and communication
4. **Lost V1 Work** → Archive strategy preserves all V1 code

**Rollback Strategy**:
- V1 branches preserved as archives
- V2 integration done in feature branch first
- Each phase can be independently rolled back

---

**Status**: 🎯 Ready for implementation
**Next Action**: Begin Phase 1 Repository Restructuring