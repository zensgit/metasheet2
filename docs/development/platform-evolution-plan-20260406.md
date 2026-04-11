# MetaSheet2 Platform Evolution Plan

Date: 2026-04-06  
Scope: evolve MetaSheet2 from a multitable-centric tool into a Feishu/Lark-like business platform without rewriting the existing microkernel/plugin foundation, while preserving safe execution boundaries for the current attendance, multitable, and approvals delivery tracks.

## Executive Summary

MetaSheet2 already has the hard parts that many platform products add late: plugin loading, a real message bus, an event bus, granular permissions, multi-tenant context plumbing, real-time collaboration, and a growing domain surface around attendance, multitable, approvals, and PLM federation. The practical path forward is not a rewrite. It is a staged expansion of the current core so that:

1. the platform gets an explicit organization/workspace/app shell,
2. plugins become discoverable platform apps and extension providers,
3. automation becomes a first-class trigger-condition-action layer across apps,
4. notifications become shared platform primitives instead of app-local features,
5. templates and internal app distribution become governed platform capabilities,
6. dashboards and reporting become the synthesis layer across apps.

The approved execution order below is dependency-driven and optimized to avoid collision with active business delivery:

1. Phase 1A: Workspace shell, app registry, launcher, legacy redirects
2. Phase 1B: request context extension with `organizationId` and `workspaceId`
3. Phase 2A: UI extension registry for views, fields, triggers, and actions
4. Phase 2B: automation runtime, run logs, and constrained rule builder
5. Phase 3: Notification hub
6. Phase 4: internal app catalog and template library
7. Phase 5: Dashboard and reporting engine

Cross-cutting implementation rule: reuse the current microkernel, `EventBusService`, `message-bus`, existing plugin manifests, `AsyncLocalStorage` tenant context, `Socket.IO` collaboration, and current multitable/workflow/approval services. Do not fork platform logic into parallel subsystems.

## Execution Amendment

This document remains the platform blueprint, but the implementation sequence is amended from the original draft. The goal is to preserve the target architecture while reducing risk against the current codebase and current parallel business streams.

Approved implementation constraints:

- `Phase 1A` must not change JWT/Auth semantics, the canonical meaning of `tenantId`, or the existing `workflow` `tenant_id` query path.
- `Phase 1A` and `Phase 2A` must avoid refactoring attendance, multitable, and approvals internals. They are shell and registry phases, not domain rewrite phases.
- `Phase 2A` and `Phase 2B` are intentionally split. Metadata registration and runtime automation must not ship as one large branch.
- The original marketplace chapter is downgraded in the approved rollout to an internal app catalog plus first-party templates. Open or third-party marketplace behavior is explicitly deferred until plugin sandboxing and capability scoping become real runtime guarantees.
- Calendar estimates in this document assume a mostly dedicated platform team. If the same engineers are concurrently shipping attendance, multitable, and approvals, apply a `1.5x` schedule-risk factor to calendar forecasts.

Approved execution sequence:

1. `Phase 1A`: `PlatformShell`, `app-registry`, launcher, legacy redirects
2. `Phase 1B`: request context adds `organizationId` and `workspaceId`, while `tenantId` stays the shard routing key
3. `Phase 2A`: extension registry for `views`, `fieldTypes`, `triggers`, and `actions`
4. `Phase 2B`: automation runtime, execution logs, idempotency, and a constrained builder
5. `Phase 3`: notification hub
6. `Phase 4`: internal app catalog and template library
7. `Phase 5`: dashboard and reporting engine

## 1. Phase Capability Plan

The sections below describe the target capability buckets. The approved rollout order is the amended sequence above.

### Phase 1: Workspace and Platform Shell

**Implementation note**

Execution is split into `Phase 1A` and `Phase 1B`.

- `Phase 1A` delivers shell, launcher, app registry, and legacy redirect compatibility.
- `Phase 1B` adds request context enrichment and membership convergence.
- Do not require JWT payload changes, `tenant-context` semantic changes, or workflow query rewrites in `Phase 1A`.

**Goal**

Introduce a real `organization -> workspace -> app` model and replace hardcoded shell navigation with a dynamic launcher, while preserving all existing routes and existing plugins unchanged.

**Why this phase comes first**

Feishu/Lark-like evolution is impossible without a stable shell. Every later capability in this plan needs a workspace context, app catalog, and launcher contract.

**Standalone value delivered**

- Workspace switcher for the same tenant/org.
- Dynamic app launcher and sidebar.
- First-class app catalog for attendance, multitable, approvals, PLM, and plugin apps.
- Per-workspace app enablement without code changes.

**Files to create**

- `packages/core-backend/src/db/migrations/zzzz20260406100000_create_platform_workspace_org_tables.ts`
- `packages/core-backend/src/routes/workspaces.ts`
- `packages/core-backend/src/routes/platform-apps.ts`
- `packages/core-backend/src/services/WorkspaceService.ts`
- `packages/core-backend/src/services/PlatformAppService.ts`
- `packages/core-backend/src/platform/app-registry.ts`
- `apps/web/src/components/PlatformShell.vue`
- `apps/web/src/components/AppLauncher.vue`
- `apps/web/src/components/WorkspaceSwitcher.vue`
- `apps/web/src/views/PlatformHomeView.vue`
- `apps/web/src/views/WorkspaceSettingsView.vue`
- `apps/web/src/composables/useWorkspace.ts`
- `apps/web/src/composables/usePlatformApps.ts`

**Files to modify**

- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/platform/app-manifest.ts`
- `packages/core-backend/src/db/types.ts`
- `packages/core-backend/src/db/sharding/tenant-context.ts`
- `packages/core-backend/src/auth/AuthService.ts`
- `packages/core-backend/src/auth/jwt-middleware.ts`
- `apps/web/src/App.vue`
- `apps/web/src/main.ts`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/src/router/types.ts`
- `apps/web/src/composables/usePlugins.ts`
- `apps/web/src/view-registry.ts`
- `apps/web/src/stores/featureFlags.ts`
- `apps/web/src/types/plugins.ts`

**Database migration**

- Create `platform_organizations`, `platform_organization_members`, `platform_workspaces`, `platform_workspace_members`, `platform_workspace_apps`, `platform_user_contexts`.
- Add `workspace_id` to `spreadsheets` if missing and backfill with a deterministic legacy workspace.
- Backfill organizations from existing `user_orgs`.
- Seed default core app enablement rows in the migration, then let `PlatformAppService.ts` bootstrap plugin-backed app entries from the runtime app registry on first startup.

**API endpoints**

- `GET /api/me/context`
- `GET /api/orgs`
- `POST /api/orgs`
- `GET /api/orgs/:orgId/workspaces`
- `POST /api/orgs/:orgId/workspaces`
- `POST /api/workspaces/:workspaceId/context/switch`
- `GET /api/workspaces/:workspaceId/apps`
- `PUT /api/workspaces/:workspaceId/apps/:appId`
- `GET /api/platform/apps`

**Frontend changes**

- `App.vue` becomes a thin root that renders `PlatformShell.vue`.
- `PlatformShell.vue` owns sidebar, workspace switcher, app launcher, top bar, and `router-view`.
- `appRoutes.ts` gains workspace-scoped routes such as `/w/:workspaceId` and keeps legacy routes as redirects.
- `usePlatformApps()` becomes the source for launcher/navigation; `usePlugins()` remains a lower-level runtime status API.

**Effort estimate**

- Backend: 4 person-weeks
- Frontend: 3 person-weeks
- Infra/devops: 1 person-week
- Total: 8 person-weeks

**Top risks**

- Workspace context leaks into the wrong tenant scope.
- Hardcoded route assumptions in the frontend shell regress existing paths.
- Auth token payloads drift from route guard expectations.

**Mitigations**

- Keep legacy URLs operational and redirect them into the new shell only after context resolution.
- Introduce a deterministic `legacy` org/workspace backfill and dual-read old/new membership tables for one full phase.
- Extend `tenant-context.ts` with `organizationId` and `workspaceId`, but keep `tenantId` as the canonical shard routing input until later rollout stages prove the new context path.

### Phase 2: Automation and UI Extension Registry

**Implementation note**

Execution is split into `Phase 2A` and `Phase 2B`.

- `Phase 2A` is registry work: plugin contribution validation, catalog APIs, and frontend registration/lookup.
- `Phase 2B` is runtime work: rule execution, logs, idempotency, loop prevention, and the first constrained builder.
- Do not deliver both tracks as one branch or one milestone.

**Goal**

Turn the existing eventing and plugin contribution model into a workspace-scoped automation engine and a registry for plugin-provided views, fields, triggers, actions, and widget types.

**Why this phase comes second**

Automation and dynamic UI extension both need workspace scoping and app identity from phase 1. Once the shell exists, rules and extension points become the core multiplier.

**Standalone value delivered**

- Cross-app automation for multitable, attendance, approvals, and plugin events.
- Dynamic registration of view types and field types from plugins without hardcoded frontend maps.
- Rule execution history with replay/debug support built on top of existing event/message infrastructure.

**Files to create**

- `packages/core-backend/src/db/migrations/zzzz20260406110000_create_automation_rule_tables.ts`
- `packages/core-backend/src/routes/automation.ts`
- `packages/core-backend/src/services/AutomationRuleService.ts`
- `packages/core-backend/src/services/AutomationRunner.ts`
- `packages/core-backend/src/services/ExtensionRegistryService.ts`
- `apps/web/src/views/AutomationRulesView.vue`
- `apps/web/src/components/AutomationRuleBuilder.vue`
- `apps/web/src/components/AutomationCatalogDrawer.vue`
- `apps/web/src/composables/useAutomationRules.ts`
- `apps/web/src/composables/useExtensionRegistry.ts`

**Files to modify**

- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/core/plugin-loader.ts`
- `packages/core-backend/src/types/plugin.ts`
- `packages/core-backend/src/routes/events.ts`
- `packages/core-backend/src/routes/views.ts`
- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/src/services/DeadLetterQueueService.ts`
- `apps/web/src/view-registry.ts`
- `apps/web/src/plugins/viewRegistry.ts`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/src/multitable/components/MetaFieldManager.vue`
- `apps/web/src/multitable/components/MetaViewManager.vue`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/src/multitable/types.ts`

**Database migration**

- Create `automation_rules`, `automation_rule_versions`, `automation_rule_bindings`, `automation_runs`, `automation_run_steps`.
- Reuse the existing dead-letter queue for failed actions instead of creating a second failure store.

**API endpoints**

- `GET /api/workspaces/:workspaceId/automations`
- `POST /api/workspaces/:workspaceId/automations`
- `GET /api/automations/:ruleId`
- `PUT /api/automations/:ruleId`
- `POST /api/automations/:ruleId/publish`
- `POST /api/automations/:ruleId/toggle`
- `GET /api/automations/:ruleId/runs`
- `POST /api/automations/test-run`
- `GET /api/platform/extensions`
- `GET /api/platform/extensions/catalog`

**Frontend changes**

- Introduce an automation builder page using Element Plus drawers, trees, forms, and step editors.
- Replace hardcoded `view-registry.ts` and multitable field/view menus with API-driven registries.
- Add a rule catalog that includes core triggers/actions and plugin-provided triggers/actions.

**Effort estimate**

- Backend: 6 person-weeks
- Frontend: 4 person-weeks
- Infra/devops: 1 person-week
- Total: 11 person-weeks

**Top risks**

- Event storms and duplicate automation runs.
- Plugins registering unsafe actions or malformed extension metadata.
- UI complexity of the first automation builder release.

**Mitigations**

- Require idempotency keys per run and persist trigger fingerprints in `automation_runs`.
- Validate plugin contributions at load time and refuse unsafe action types before publishing them to the catalog.
- Ship a constrained v1 builder: trigger -> conditions -> sequential actions only; parallel branches wait for phase 5.

### Phase 3: Marketplace and Template Library

**Implementation note**

In the approved rollout, this capability bucket moves after the notification hub and is intentionally narrowed for the first release.

- Treat this as an internal app catalog plus first-party template library first.
- Keep package trust boundaries internal-only until sandboxing and capability scoping are enforceable at runtime.
- Do not position this phase as an open marketplace in planning or staffing until plugin isolation is real.

**Goal**

Add a governed package catalog and template library so workspaces can enable apps, install first-party plugin packages, and provision business blueprints without code deployment.

**Why this phase comes third**

Marketplace packages are only useful after app identity, workspace scoping, and extension contracts are stable. Templates are materially more valuable after automation exists.

**Standalone value delivered**

- Internal app marketplace for attendance, after-sales, approval bridge, PLM, and future domain apps.
- Template center for workspace starter kits, multitable bases, workflow/approval bundles, automation packs, and dashboards.
- Versioned package rollout instead of repo-only enablement.

**Files to create**

- `packages/core-backend/src/db/migrations/zzzz20260406120000_create_marketplace_and_template_tables.ts`
- `packages/core-backend/src/routes/marketplace.ts`
- `packages/core-backend/src/routes/templates.ts`
- `packages/core-backend/src/services/MarketplaceService.ts`
- `packages/core-backend/src/services/TemplateLibraryService.ts`
- `packages/core-backend/src/platform/package-registry.ts`
- `apps/web/src/views/MarketplaceView.vue`
- `apps/web/src/views/TemplateLibraryView.vue`
- `apps/web/src/components/MarketplacePackageCard.vue`
- `apps/web/src/components/TemplateInstallDrawer.vue`
- `apps/web/src/composables/useMarketplace.ts`
- `apps/web/src/composables/useTemplates.ts`

**Files to modify**

- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/platform/app-registry.ts`
- `packages/core-backend/src/core/plugin-loader.ts`
- `packages/core-backend/src/routes/platform-apps.ts`
- `packages/core-backend/src/db/types.ts`
- `apps/web/src/components/AppLauncher.vue`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/src/composables/usePlatformApps.ts`

**Database migration**

- Create `marketplace_packages`, `marketplace_package_versions`, `marketplace_installations`, `template_libraries`, `template_versions`, `template_installs`.
- Treat all current first-party plugins as `system` packages on day one so nothing disappears from the current admin/plugin experience.

**API endpoints**

- `GET /api/marketplace/packages`
- `GET /api/marketplace/packages/:packageId`
- `POST /api/workspaces/:workspaceId/marketplace/install`
- `POST /api/workspaces/:workspaceId/marketplace/upgrade`
- `GET /api/workspaces/:workspaceId/marketplace/installations`
- `GET /api/templates`
- `GET /api/templates/:templateId`
- `POST /api/workspaces/:workspaceId/templates/:templateVersionId/install`

**Frontend changes**

- Add a marketplace view with package cards, compatibility warnings, and install/upgrade actions.
- Add a template library page with preview, scope, and dependency summaries.
- Expose “Browse marketplace” and “Use template” in the launcher and workspace home.

**Effort estimate**

- Backend: 5 person-weeks
- Frontend: 3 person-weeks
- Infra/devops: 2 person-weeks
- Total: 10 person-weeks

**Top risks**

- Package trust and supply-chain governance.
- Template installs mutating live workspace data incorrectly.
- Plugin lifecycle/hot reload conflicts during install or upgrade.

**Mitigations**

- Restrict the first release to signed internal packages and first-party templates.
- Implement template install as a transaction plus post-commit validation job with rollback metadata in `template_installs`.
- Perform package enable/disable through the current plugin loader and admin guardrails, not through ad hoc filesystem mutation.

### Phase 4: Notification Hub

**Implementation note**

This capability bucket is promoted earlier in the approved rollout because the current codebase already has reusable notification, scheduling, and DLQ foundations.

**Goal**

Promote notifications from an in-memory send abstraction to a durable, multi-channel platform hub with inbox, subscriptions, preferences, and external delivery connectors.

**Why this phase comes fourth**

The notification hub depends on app identity, automation actions, and marketplace-installed apps/templates. It also becomes much more valuable once more than one app emits events.

**Standalone value delivered**

- Unified inbox for approvals, attendance alerts, automation failures, assignment changes, and marketplace updates.
- Channel routing to in-app, email, webhook, DingTalk, Feishu, and WeCom.
- User preferences, read state, subscriptions, and delivery observability.

**Files to create**

- `packages/core-backend/src/db/migrations/zzzz20260406130000_create_notification_hub_tables.ts`
- `packages/core-backend/src/routes/notifications.ts`
- `packages/core-backend/src/services/NotificationHubService.ts`
- `packages/core-backend/src/services/NotificationPreferenceService.ts`
- `packages/core-backend/src/services/NotificationDeliveryWorker.ts`
- `apps/web/src/components/NotificationBell.vue`
- `apps/web/src/components/NotificationDrawer.vue`
- `apps/web/src/views/NotificationCenterView.vue`
- `apps/web/src/views/NotificationPreferencesView.vue`
- `apps/web/src/composables/useNotifications.ts`
- `apps/web/src/composables/useNotificationPreferences.ts`

**Files to modify**

- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/services/NotificationService.ts`
- `packages/core-backend/src/services/SchedulerService.ts`
- `packages/core-backend/src/services/ChangeManagementService.ts`
- `packages/core-backend/src/services/SLOService.ts`
- `packages/core-backend/src/services/ApprovalBridgeService.ts`
- `apps/web/src/components/PlatformShell.vue`
- `apps/web/src/router/appRoutes.ts`

**Database migration**

- Create `notification_channels`, `notification_topics`, `notification_subscriptions`, `notification_messages`, `notification_deliveries`, `notification_user_preferences`.
- Use `notification_deliveries.read_at` as inbox read state; no separate read table required in v1.

**API endpoints**

- `GET /api/workspaces/:workspaceId/notifications`
- `POST /api/workspaces/:workspaceId/notifications/mark-read`
- `GET /api/workspaces/:workspaceId/notification-topics`
- `GET /api/workspaces/:workspaceId/notification-subscriptions`
- `PUT /api/workspaces/:workspaceId/notification-subscriptions/:subscriptionId`
- `GET /api/workspaces/:workspaceId/notification-preferences`
- `PUT /api/workspaces/:workspaceId/notification-preferences`
- `POST /api/workspaces/:workspaceId/notification-channels/test`

**Frontend changes**

- Add a top-bar notification bell with unread badge.
- Add inbox drawer and full notification center page.
- Add channel and digest preferences in workspace/user settings.

**Effort estimate**

- Backend: 4 person-weeks
- Frontend: 3 person-weeks
- Infra/devops: 2 person-weeks
- Total: 9 person-weeks

**Top risks**

- Alert fatigue and duplicate delivery.
- Secret management for external connectors.
- Provider-specific rate limits and reliability differences.

**Mitigations**

- Deduplicate on `(message source, recipient, channel)` and support digest policies.
- Store only `secret_ref` in DB and resolve credentials through the existing secret/config path.
- Use the current scheduler and DLQ paths for retries, backoff, and visibility.

### Phase 5: Dashboard and Reporting Engine

**Goal**

Turn the existing latent dashboard schema into a real workspace/app reporting layer with reusable widgets, saved queries, report schedules, and cross-app home dashboards.

**Why this phase comes fifth**

Dashboards are most useful after app identity, automation, package templates, and notifications all exist. They should become the synthesis layer, not the first layer.

**Standalone value delivered**

- Workspace home dashboards.
- App-level operational dashboards for attendance, approvals, PLM, and marketplace usage.
- Report schedules with notification delivery.
- Reusable widgets backed by multitable, workflow, approval, or plugin resources.

**Files to create**

- `packages/core-backend/src/db/migrations/zzzz20260406140000_expand_dashboard_and_report_tables.ts`
- `packages/core-backend/src/routes/dashboards.ts`
- `packages/core-backend/src/routes/reports.ts`
- `packages/core-backend/src/routes/analytics.ts`
- `packages/core-backend/src/services/DashboardService.ts`
- `packages/core-backend/src/services/ReportService.ts`
- `packages/core-backend/src/services/MetricsQueryService.ts`
- `apps/web/src/views/DashboardCenterView.vue`
- `apps/web/src/views/ReportCenterView.vue`
- `apps/web/src/components/DashboardCanvas.vue`
- `apps/web/src/components/WidgetRenderer.vue`
- `apps/web/src/components/ReportScheduleDrawer.vue`
- `apps/web/src/composables/useDashboards.ts`
- `apps/web/src/composables/useReports.ts`

**Files to modify**

- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/db/types.ts`
- `packages/core-backend/src/services/DataMaterializationService.ts`
- `packages/core-backend/src/services/CollabService.ts`
- `apps/web/src/views/PlatformHomeView.vue`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/src/components/AppLauncher.vue`

**Database migration**

- Extend `meta_dashboards` and `meta_widgets`.
- Create `dashboard_data_sources`, `report_definitions`, `report_runs`, `report_shares`.
- Reuse notification hub for scheduled report delivery rather than creating a parallel mailer path.

**API endpoints**

- `GET /api/workspaces/:workspaceId/dashboards`
- `POST /api/workspaces/:workspaceId/dashboards`
- `GET /api/dashboards/:dashboardId`
- `PUT /api/dashboards/:dashboardId`
- `POST /api/dashboards/:dashboardId/widgets/query`
- `GET /api/workspaces/:workspaceId/reports`
- `POST /api/workspaces/:workspaceId/reports`
- `POST /api/reports/:reportId/run`
- `PUT /api/reports/:reportId/schedule`

**Frontend changes**

- Add a widget canvas, filter rail, saved dashboard views, and share/export flows.
- Use extension registry entries so plugins can contribute widget types or datasource resolvers later.
- Make `PlatformHomeView.vue` render a workspace default dashboard.

**Effort estimate**

- Backend: 6 person-weeks
- Frontend: 5 person-weeks
- Infra/devops: 1.5 person-weeks
- Total: 12.5 person-weeks

**Top risks**

- Slow cross-app queries and dashboard N+1 patterns.
- Data leakage across workspaces or roles.
- Endless bespoke widget requests that undermine maintainability.

**Mitigations**

- Start with a constrained widget catalog and cached/snapshot query path.
- Enforce workspace and RBAC filters inside datasource adapters, not only in the UI.
- Add report materialization for expensive queries before opening arbitrary SQL or arbitrary cross-plugin joins.

## 2. Database Schema Designs

Implementation note: follow the existing Kysely style in `packages/core-backend/src/db/migrations/` by using `up/down`, `sql`, idempotent `CREATE ... IF NOT EXISTS`, and helper patterns from `_patterns.ts` where useful.

### Phase 1 Migration

File: `packages/core-backend/src/db/migrations/zzzz20260406100000_create_platform_workspace_org_tables.ts`

```ts
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const LEGACY_ORG_ID = 'org_legacy'
const LEGACY_WORKSPACE_ID = 'ws_legacy'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS platform_organizations (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      slug text NOT NULL UNIQUE,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by text REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS platform_organization_members (
      organization_id text NOT NULL REFERENCES platform_organizations(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role text NOT NULL DEFAULT 'member',
      status text NOT NULL DEFAULT 'active',
      is_default boolean NOT NULL DEFAULT false,
      permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, user_id)
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_platform_org_members_user
    ON platform_organization_members(user_id)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS platform_workspaces (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      organization_id text NOT NULL REFERENCES platform_organizations(id) ON DELETE CASCADE,
      slug text NOT NULL,
      name text NOT NULL,
      type text NOT NULL DEFAULT 'general',
      status text NOT NULL DEFAULT 'active',
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      home_app_id text,
      created_by text REFERENCES users(id) ON DELETE SET NULL,
      archived_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, slug)
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_platform_workspaces_org
    ON platform_workspaces(organization_id)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS platform_workspace_members (
      workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role text NOT NULL DEFAULT 'member',
      status text NOT NULL DEFAULT 'active',
      is_default boolean NOT NULL DEFAULT false,
      permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, user_id)
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_platform_workspace_members_user
    ON platform_workspace_members(user_id)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS platform_workspace_apps (
      workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
      app_id text NOT NULL,
      source_type text NOT NULL DEFAULT 'core',
      source_ref text,
      enabled boolean NOT NULL DEFAULT true,
      pinned boolean NOT NULL DEFAULT false,
      nav_order integer NOT NULL DEFAULT 0,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, app_id)
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_platform_workspace_apps_enabled
    ON platform_workspace_apps(workspace_id, enabled, nav_order)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS platform_user_contexts (
      user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      organization_id text REFERENCES platform_organizations(id) ON DELETE SET NULL,
      workspace_id text REFERENCES platform_workspaces(id) ON DELETE SET NULL,
      recent_app_id text,
      preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    ALTER TABLE spreadsheets
    ADD COLUMN IF NOT EXISTS workspace_id text
  `.execute(db)

  await sql`
    INSERT INTO platform_organizations (id, slug, name, status, settings)
    VALUES (${LEGACY_ORG_ID}, 'legacy', 'Legacy Organization', 'active', '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `.execute(db)

  await sql`
    INSERT INTO platform_workspaces (id, organization_id, slug, name, type, status, settings)
    VALUES (${LEGACY_WORKSPACE_ID}, ${LEGACY_ORG_ID}, 'main', 'Main Workspace', 'general', 'active', '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `.execute(db)

  await sql`
    INSERT INTO platform_organizations (id, slug, name, status, settings)
    SELECT DISTINCT
      user_orgs.org_id,
      concat('org-', user_orgs.org_id),
      concat('Organization ', user_orgs.org_id),
      'active',
      '{}'::jsonb
    FROM user_orgs
    ON CONFLICT (id) DO NOTHING
  `.execute(db)

  await sql`
    INSERT INTO platform_organization_members (organization_id, user_id, role, status, is_default)
    SELECT
      user_orgs.org_id,
      user_orgs.user_id,
      CASE WHEN users.is_admin THEN 'owner' ELSE 'member' END,
      CASE WHEN user_orgs.is_active THEN 'active' ELSE 'disabled' END,
      true
    FROM user_orgs
    JOIN users ON users.id = user_orgs.user_id
    ON CONFLICT (organization_id, user_id) DO NOTHING
  `.execute(db)

  await sql`
    INSERT INTO platform_workspaces (id, organization_id, slug, name, type, status, settings)
    SELECT
      concat('ws_', platform_organizations.id),
      platform_organizations.id,
      'main',
      concat(platform_organizations.name, ' Workspace'),
      'general',
      'active',
      '{}'::jsonb
    FROM platform_organizations
    ON CONFLICT (id) DO NOTHING
  `.execute(db)

  await sql`
    INSERT INTO platform_workspace_members (workspace_id, user_id, role, status, is_default)
    SELECT
      concat('ws_', platform_organization_members.organization_id),
      platform_organization_members.user_id,
      platform_organization_members.role,
      platform_organization_members.status,
      platform_organization_members.is_default
    FROM platform_organization_members
    ON CONFLICT (workspace_id, user_id) DO NOTHING
  `.execute(db)

  await sql`
    UPDATE spreadsheets
    SET workspace_id = ${LEGACY_WORKSPACE_ID}
    WHERE workspace_id IS NULL
  `.execute(db)

  await sql`
    INSERT INTO platform_workspace_apps (workspace_id, app_id, source_type, enabled, pinned, nav_order)
    SELECT workspace_id, app_id, source_type, enabled, pinned, nav_order
    FROM (
      SELECT id AS workspace_id, 'multitable' AS app_id, 'core' AS source_type, true AS enabled, true AS pinned, 10 AS nav_order FROM platform_workspaces
      UNION ALL
      SELECT id, 'approvals', 'core', true, true, 20 FROM platform_workspaces
      UNION ALL
      SELECT id, 'workflow', 'core', true, false, 30 FROM platform_workspaces
    ) seed
    ON CONFLICT (workspace_id, app_id) DO NOTHING
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('platform_user_contexts').ifExists().cascade().execute()
  await db.schema.dropTable('platform_workspace_apps').ifExists().cascade().execute()
  await db.schema.dropTable('platform_workspace_members').ifExists().cascade().execute()
  await db.schema.dropTable('platform_workspaces').ifExists().cascade().execute()
  await db.schema.dropTable('platform_organization_members').ifExists().cascade().execute()
  await db.schema.dropTable('platform_organizations').ifExists().cascade().execute()
}
```

### Phase 2 Migration

File: `packages/core-backend/src/db/migrations/zzzz20260406110000_create_automation_rule_tables.ts`

```ts
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS automation_rules (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
      app_id text NOT NULL,
      name text NOT NULL,
      description text,
      status text NOT NULL DEFAULT 'draft',
      trigger_type text NOT NULL,
      trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,
      condition_tree jsonb NOT NULL DEFAULT '{}'::jsonb,
      action_graph jsonb NOT NULL DEFAULT '[]'::jsonb,
      concurrency_policy text NOT NULL DEFAULT 'allow',
      created_by text REFERENCES users(id) ON DELETE SET NULL,
      last_published_version_id text,
      archived_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_automation_rules_workspace_status
    ON automation_rules(workspace_id, status, updated_at DESC)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS automation_rule_versions (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      rule_id text NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
      version_number integer NOT NULL,
      snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      change_note text,
      published_by text REFERENCES users(id) ON DELETE SET NULL,
      published_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (rule_id, version_number)
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS automation_rule_bindings (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      rule_id text NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
      resource_type text NOT NULL,
      resource_id text NOT NULL,
      event_pattern text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_automation_rule_bindings_resource
    ON automation_rule_bindings(resource_type, resource_id, enabled)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_automation_rule_bindings_event
    ON automation_rule_bindings(event_pattern)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
      rule_id text REFERENCES automation_rules(id) ON DELETE SET NULL,
      rule_version_id text REFERENCES automation_rule_versions(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'queued',
      trigger_fingerprint text,
      correlation_id text,
      trigger_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      execution_context jsonb NOT NULL DEFAULT '{}'::jsonb,
      retry_count integer NOT NULL DEFAULT 0,
      error_message text,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_idempotent
    ON automation_runs(rule_id, trigger_fingerprint)
    WHERE trigger_fingerprint IS NOT NULL
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_workspace_status
    ON automation_runs(workspace_id, status, created_at DESC)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS automation_run_steps (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
      step_key text NOT NULL,
      step_type text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      input jsonb NOT NULL DEFAULT '{}'::jsonb,
      output jsonb NOT NULL DEFAULT '{}'::jsonb,
      error_message text,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_automation_run_steps_run
    ON automation_run_steps(run_id, created_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('automation_run_steps').ifExists().cascade().execute()
  await db.schema.dropTable('automation_runs').ifExists().cascade().execute()
  await db.schema.dropTable('automation_rule_bindings').ifExists().cascade().execute()
  await db.schema.dropTable('automation_rule_versions').ifExists().cascade().execute()
  await db.schema.dropTable('automation_rules').ifExists().cascade().execute()
}
```

### Phase 3 Migration

File: `packages/core-backend/src/db/migrations/zzzz20260406120000_create_marketplace_and_template_tables.ts`

```ts
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS marketplace_packages (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      slug text NOT NULL UNIQUE,
      type text NOT NULL DEFAULT 'app',
      display_name text NOT NULL,
      summary text,
      category text,
      owner_team text,
      source_plugin_name text,
      visibility text NOT NULL DEFAULT 'internal',
      status text NOT NULL DEFAULT 'draft',
      icon text,
      manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS marketplace_package_versions (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      package_id text NOT NULL REFERENCES marketplace_packages(id) ON DELETE CASCADE,
      version text NOT NULL,
      channel text NOT NULL DEFAULT 'stable',
      compatibility jsonb NOT NULL DEFAULT '{}'::jsonb,
      artifact_ref text,
      checksum text,
      release_notes text,
      published_by text REFERENCES users(id) ON DELETE SET NULL,
      published_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (package_id, version)
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_marketplace_package_versions_channel
    ON marketplace_package_versions(package_id, channel, published_at DESC)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS marketplace_installations (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
      package_id text NOT NULL REFERENCES marketplace_packages(id) ON DELETE CASCADE,
      version_id text REFERENCES marketplace_package_versions(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'installed',
      source text NOT NULL DEFAULT 'marketplace',
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      installed_by text REFERENCES users(id) ON DELETE SET NULL,
      installed_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, package_id)
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_marketplace_installations_workspace
    ON marketplace_installations(workspace_id, status, installed_at DESC)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS template_libraries (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      package_id text REFERENCES marketplace_packages(id) ON DELETE SET NULL,
      slug text NOT NULL UNIQUE,
      name text NOT NULL,
      category text,
      scope text NOT NULL DEFAULT 'workspace',
      summary text,
      preview jsonb NOT NULL DEFAULT '{}'::jsonb,
      manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS template_versions (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      template_id text NOT NULL REFERENCES template_libraries(id) ON DELETE CASCADE,
      version text NOT NULL,
      install_mode text NOT NULL DEFAULT 'clone',
      content jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (template_id, version)
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS template_installs (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
      template_id text REFERENCES template_libraries(id) ON DELETE SET NULL,
      template_version_id text REFERENCES template_versions(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'completed',
      installed_by text REFERENCES users(id) ON DELETE SET NULL,
      target_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
      validation_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_template_installs_workspace
    ON template_installs(workspace_id, created_at DESC)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('template_installs').ifExists().cascade().execute()
  await db.schema.dropTable('template_versions').ifExists().cascade().execute()
  await db.schema.dropTable('template_libraries').ifExists().cascade().execute()
  await db.schema.dropTable('marketplace_installations').ifExists().cascade().execute()
  await db.schema.dropTable('marketplace_package_versions').ifExists().cascade().execute()
  await db.schema.dropTable('marketplace_packages').ifExists().cascade().execute()
}
```

### Phase 4 Migration

File: `packages/core-backend/src/db/migrations/zzzz20260406130000_create_notification_hub_tables.ts`

```ts
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS notification_channels (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
      type text NOT NULL,
      name text NOT NULL,
      provider text,
      status text NOT NULL DEFAULT 'active',
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      secret_ref text,
      created_by text REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_notification_channels_workspace
    ON notification_channels(workspace_id, type, status)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS notification_topics (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
      key text NOT NULL,
      display_name text NOT NULL,
      source_app_id text,
      default_channel_types jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, key)
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS notification_subscriptions (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
      topic_id text REFERENCES notification_topics(id) ON DELETE CASCADE,
      channel_id text REFERENCES notification_channels(id) ON DELETE SET NULL,
      user_id text REFERENCES users(id) ON DELETE SET NULL,
      target_type text NOT NULL,
      target_ref text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      filters jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_notification_subscriptions_topic
    ON notification_subscriptions(workspace_id, topic_id, enabled)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS notification_messages (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
      topic_id text REFERENCES notification_topics(id) ON DELETE SET NULL,
      source_app_id text,
      source_type text,
      source_id text,
      severity text NOT NULL DEFAULT 'info',
      title text NOT NULL,
      body text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      actor_id text REFERENCES users(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'queued',
      scheduled_at timestamptz,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_notification_messages_workspace
    ON notification_messages(workspace_id, created_at DESC)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      message_id text NOT NULL REFERENCES notification_messages(id) ON DELETE CASCADE,
      channel_id text REFERENCES notification_channels(id) ON DELETE SET NULL,
      recipient_type text NOT NULL,
      recipient_ref text NOT NULL,
      delivery_status text NOT NULL DEFAULT 'pending',
      provider_message_id text,
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      delivered_at timestamptz,
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_recipient
    ON notification_deliveries(recipient_type, recipient_ref, delivery_status, read_at)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS notification_user_preferences (
      workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      quiet_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
      digest_frequency text NOT NULL DEFAULT 'off',
      channel_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
      locale text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, user_id)
    )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('notification_user_preferences').ifExists().cascade().execute()
  await db.schema.dropTable('notification_deliveries').ifExists().cascade().execute()
  await db.schema.dropTable('notification_messages').ifExists().cascade().execute()
  await db.schema.dropTable('notification_subscriptions').ifExists().cascade().execute()
  await db.schema.dropTable('notification_topics').ifExists().cascade().execute()
  await db.schema.dropTable('notification_channels').ifExists().cascade().execute()
}
```

### Phase 5 Migration

File: `packages/core-backend/src/db/migrations/zzzz20260406140000_expand_dashboard_and_report_tables.ts`

```ts
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    ALTER TABLE meta_dashboards
    ADD COLUMN IF NOT EXISTS workspace_id text REFERENCES platform_workspaces(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS app_id text,
    ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private',
    ADD COLUMN IF NOT EXISTS is_home boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS layout jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS filters jsonb NOT NULL DEFAULT '{}'::jsonb
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_dashboards_workspace
    ON meta_dashboards(workspace_id, app_id, updated_at DESC)
  `.execute(db)

  await sql`
    ALTER TABLE meta_widgets
    ADD COLUMN IF NOT EXISTS widget_key text,
    ADD COLUMN IF NOT EXISTS position jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS data_source_kind text NOT NULL DEFAULT 'query',
    ADD COLUMN IF NOT EXISTS data_source_ref text,
    ADD COLUMN IF NOT EXISTS bindings jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS refresh_interval_seconds integer
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS dashboard_data_sources (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
      name text NOT NULL,
      source_type text NOT NULL,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by text REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, name)
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS report_definitions (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
      app_id text,
      name text NOT NULL,
      description text,
      status text NOT NULL DEFAULT 'draft',
      query_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
      visualization_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
      parameter_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
      schedule_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
      owner_id text REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_report_definitions_workspace
    ON report_definitions(workspace_id, app_id, updated_at DESC)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS report_runs (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      report_id text NOT NULL REFERENCES report_definitions(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'queued',
      parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
      result_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
      output_uri text,
      error_message text,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_report_runs_report
    ON report_runs(report_id, created_at DESC)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS report_shares (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      report_id text NOT NULL REFERENCES report_definitions(id) ON DELETE CASCADE,
      target_type text NOT NULL,
      target_ref text NOT NULL,
      permission text NOT NULL DEFAULT 'view',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('report_shares').ifExists().cascade().execute()
  await db.schema.dropTable('report_runs').ifExists().cascade().execute()
  await db.schema.dropTable('report_definitions').ifExists().cascade().execute()
  await db.schema.dropTable('dashboard_data_sources').ifExists().cascade().execute()
}
```

## 3. API Designs

Conventions:

- Keep the current Express style: explicit routers in `packages/core-backend/src/routes/`, authenticated `GET/POST/PUT/DELETE`, JSON responses shaped as `{ ok, data }` or existing route-local `{ success, data }` where backwards compatibility requires it.
- Require JWT authentication for all new endpoints except future public template previews.
- Enforce workspace membership and RBAC at the router boundary.

### Phase 1 APIs

| Method | Path | Auth | Request shape | Response shape |
| --- | --- | --- | --- | --- |
| `GET` | `/api/me/context` | `JWT` | none | `{ ok: true, data: { user, organizations, workspaces, currentOrganizationId, currentWorkspaceId } }` |
| `GET` | `/api/orgs` | `JWT` | none | `{ ok: true, data: { items: [{ id, slug, name, role, isDefault }] } }` |
| `POST` | `/api/orgs` | `JWT + platform_admin` | `{ slug, name, settings? }` | `{ ok: true, data: { id, slug, name, status } }` |
| `GET` | `/api/orgs/:orgId/workspaces` | `JWT + org member` | none | `{ ok: true, data: { items: [{ id, slug, name, type, role, appCount }] } }` |
| `POST` | `/api/orgs/:orgId/workspaces` | `JWT + org owner/admin` | `{ slug, name, type?, settings?, seedApps?: string[] }` | `{ ok: true, data: { id, organizationId, slug, name, type } }` |
| `POST` | `/api/workspaces/:workspaceId/context/switch` | `JWT + workspace member` | `{ recentAppId? }` | `{ ok: true, data: { currentWorkspaceId, currentOrganizationId, recentAppId } }` |
| `GET` | `/api/platform/apps` | `JWT` | query: `?workspaceId=` | `{ ok: true, data: { items: [{ id, displayName, sourceType, navigation, permissions, enabledInWorkspace }] } }` |
| `GET` | `/api/workspaces/:workspaceId/apps` | `JWT + workspace member` | none | `{ ok: true, data: { items: [{ appId, enabled, pinned, navOrder, manifest }] } }` |
| `PUT` | `/api/workspaces/:workspaceId/apps/:appId` | `JWT + workspace admin` | `{ enabled?, pinned?, navOrder?, settings? }` | `{ ok: true, data: { workspaceId, appId, enabled, pinned, navOrder, settings } }` |

### Phase 2 APIs

| Method | Path | Auth | Request shape | Response shape |
| --- | --- | --- | --- | --- |
| `GET` | `/api/workspaces/:workspaceId/automations` | `JWT + automation:read` | query: `?status=&appId=` | `{ ok: true, data: { items: [{ id, name, appId, status, updatedAt, lastRunAt }] } }` |
| `POST` | `/api/workspaces/:workspaceId/automations` | `JWT + automation:write` | `{ appId, name, description?, triggerType, triggerConfig, conditionTree?, actionGraph }` | `{ ok: true, data: { id, status: "draft", ...rule } }` |
| `GET` | `/api/automations/:ruleId` | `JWT + automation:read` | none | `{ ok: true, data: { rule, latestVersion, bindings } }` |
| `PUT` | `/api/automations/:ruleId` | `JWT + automation:write` | `{ name?, description?, triggerConfig?, conditionTree?, actionGraph?, bindings? }` | `{ ok: true, data: { id, updatedAt } }` |
| `POST` | `/api/automations/:ruleId/publish` | `JWT + automation:write` | `{ changeNote? }` | `{ ok: true, data: { ruleId, versionId, status: "active" } }` |
| `POST` | `/api/automations/:ruleId/toggle` | `JWT + automation:write` | `{ enabled: boolean }` | `{ ok: true, data: { ruleId, status } }` |
| `GET` | `/api/automations/:ruleId/runs` | `JWT + automation:read` | query: `?status=&limit=` | `{ ok: true, data: { items: [{ id, status, startedAt, finishedAt, errorMessage }] } }` |
| `POST` | `/api/automations/test-run` | `JWT + automation:write` | `{ workspaceId, draftRule, samplePayload }` | `{ ok: true, data: { runId, simulatedSteps, warnings } }` |
| `GET` | `/api/platform/extensions` | `JWT` | query: `?workspaceId=` | `{ ok: true, data: { views, fields, triggers, actions, widgets } }` |
| `GET` | `/api/platform/extensions/catalog` | `JWT` | query: `?kind=view|field|trigger|action|widget` | `{ ok: true, data: { items: [{ key, plugin, appId, schema, status }] } }` |

### Phase 3 APIs

| Method | Path | Auth | Request shape | Response shape |
| --- | --- | --- | --- | --- |
| `GET` | `/api/marketplace/packages` | `JWT` | query: `?type=&category=&channel=` | `{ ok: true, data: { items: [{ id, slug, type, displayName, summary, latestVersion, installed }] } }` |
| `GET` | `/api/marketplace/packages/:packageId` | `JWT` | none | `{ ok: true, data: { package, versions, templates, compatibility } }` |
| `POST` | `/api/workspaces/:workspaceId/marketplace/install` | `JWT + workspace admin` | `{ packageId, versionId?, config? }` | `{ ok: true, data: { installationId, status, packageId, versionId } }` |
| `POST` | `/api/workspaces/:workspaceId/marketplace/upgrade` | `JWT + workspace admin` | `{ packageId, targetVersionId }` | `{ ok: true, data: { installationId, fromVersionId, targetVersionId, status } }` |
| `GET` | `/api/workspaces/:workspaceId/marketplace/installations` | `JWT + workspace member` | none | `{ ok: true, data: { items: [{ id, packageId, versionId, status, installedAt }] } }` |
| `GET` | `/api/templates` | `JWT` | query: `?category=&packageId=&scope=` | `{ ok: true, data: { items: [{ id, name, category, packageId, latestVersion, preview }] } }` |
| `GET` | `/api/templates/:templateId` | `JWT` | none | `{ ok: true, data: { template, versions, preview, dependencies } }` |
| `POST` | `/api/workspaces/:workspaceId/templates/:templateVersionId/install` | `JWT + workspace admin` | `{ variables?, targetAppId?, installMode? }` | `{ ok: true, data: { installId, status, targetRefs, warnings } }` |

### Phase 4 APIs

| Method | Path | Auth | Request shape | Response shape |
| --- | --- | --- | --- | --- |
| `GET` | `/api/workspaces/:workspaceId/notifications` | `JWT + workspace member` | query: `?status=unread&topic=&cursor=` | `{ ok: true, data: { items: [{ deliveryId, messageId, title, body, severity, readAt, createdAt }], nextCursor } }` |
| `POST` | `/api/workspaces/:workspaceId/notifications/mark-read` | `JWT + workspace member` | `{ deliveryIds: string[] }` | `{ ok: true, data: { updated: number } }` |
| `GET` | `/api/workspaces/:workspaceId/notification-topics` | `JWT + workspace member` | none | `{ ok: true, data: { items: [{ id, key, displayName, sourceAppId }] } }` |
| `GET` | `/api/workspaces/:workspaceId/notification-subscriptions` | `JWT + workspace member` | none | `{ ok: true, data: { items: [{ id, topicId, channelId, targetType, targetRef, enabled }] } }` |
| `PUT` | `/api/workspaces/:workspaceId/notification-subscriptions/:subscriptionId` | `JWT + workspace member or admin` | `{ enabled?, filters?, channelId? }` | `{ ok: true, data: { id, enabled, filters, channelId } }` |
| `GET` | `/api/workspaces/:workspaceId/notification-preferences` | `JWT + workspace member` | none | `{ ok: true, data: { quietHours, digestFrequency, channelOverrides, locale } }` |
| `PUT` | `/api/workspaces/:workspaceId/notification-preferences` | `JWT + workspace member` | `{ quietHours?, digestFrequency?, channelOverrides?, locale? }` | `{ ok: true, data: { workspaceId, userId, ...preferences } }` |
| `POST` | `/api/workspaces/:workspaceId/notification-channels/test` | `JWT + workspace admin` | `{ channelId, sampleMessage }` | `{ ok: true, data: { channelId, result: "sent" | "failed", errorMessage? } }` |

### Phase 5 APIs

| Method | Path | Auth | Request shape | Response shape |
| --- | --- | --- | --- | --- |
| `GET` | `/api/workspaces/:workspaceId/dashboards` | `JWT + dashboard:read` | query: `?appId=&visibility=` | `{ ok: true, data: { items: [{ id, name, appId, visibility, isHome, updatedAt }] } }` |
| `POST` | `/api/workspaces/:workspaceId/dashboards` | `JWT + dashboard:write` | `{ name, appId?, description?, layout?, filters?, visibility? }` | `{ ok: true, data: { id, name, appId, visibility } }` |
| `GET` | `/api/dashboards/:dashboardId` | `JWT + dashboard:read` | none | `{ ok: true, data: { dashboard, widgets, filterState, permissions } }` |
| `PUT` | `/api/dashboards/:dashboardId` | `JWT + dashboard:write` | `{ name?, layout?, filters?, widgets? }` | `{ ok: true, data: { id, updatedAt } }` |
| `POST` | `/api/dashboards/:dashboardId/widgets/query` | `JWT + dashboard:read` | `{ widgetId, runtimeFilters?, viewport? }` | `{ ok: true, data: { widgetId, rows, series, totals, cacheHit } }` |
| `GET` | `/api/workspaces/:workspaceId/reports` | `JWT + report:read` | query: `?appId=&status=` | `{ ok: true, data: { items: [{ id, name, status, nextRunAt, lastRunAt }] } }` |
| `POST` | `/api/workspaces/:workspaceId/reports` | `JWT + report:write` | `{ name, appId?, querySpec, visualizationSpec, parameterSpec?, scheduleSpec? }` | `{ ok: true, data: { id, name, status } }` |
| `POST` | `/api/reports/:reportId/run` | `JWT + report:write` | `{ parameters?, notifyRecipients? }` | `{ ok: true, data: { runId, status } }` |
| `PUT` | `/api/reports/:reportId/schedule` | `JWT + report:write` | `{ scheduleSpec, deliveryChannels? }` | `{ ok: true, data: { reportId, scheduleSpec } }` |

## 4. Frontend Architecture Changes

### Target Shell Tree

```text
App.vue
└─ PlatformShell.vue
   ├─ WorkspaceSwitcher.vue
   ├─ AppLauncher.vue
   ├─ NotificationBell.vue
   ├─ Platform navigation rail
   └─ router-view
      ├─ PlatformHomeView.vue
      ├─ WorkspaceSettingsView.vue
      ├─ PluginViewHost.vue
      ├─ AutomationRulesView.vue
      ├─ MarketplaceView.vue
      ├─ TemplateLibraryView.vue
      ├─ NotificationCenterView.vue
      ├─ DashboardCenterView.vue
      ├─ ReportCenterView.vue
      └─ existing app views
         ├─ AttendanceExperienceView.vue
         ├─ MultitableWorkbench.vue
         ├─ WorkflowHubView.vue
         ├─ SpreadsheetDetailView.vue
         └─ PlmProductView.vue
```

### Route Evolution

Current state:

- hardcoded routes such as `/grid`, `/attendance`, `/kanban`, `/gallery`, `/workflows`
- plugin pages under `/p/:plugin/:viewId`

Target state:

- `/w/:workspaceId` -> workspace home dashboard/launcher
- `/w/:workspaceId/apps/:appId` -> app root
- `/w/:workspaceId/apps/:appId/*` -> app child routes
- `/w/:workspaceId/multitable/:baseId/:sheetId/:viewId?` -> multitable host
- legacy routes remain and redirect after workspace resolution

### New Composables

- `useWorkspace.ts`
  - current organization/workspace
  - workspace switch action
  - workspace membership/role state
- `usePlatformApps.ts`
  - launcher catalog
  - workspace-enabled apps
  - app navigation groups
- `useExtensionRegistry.ts`
  - runtime catalog of views, field types, actions, triggers, widgets
- `useAutomationRules.ts`
  - rule CRUD, publish, run history
- `useMarketplace.ts`
  - package search/install/upgrade
- `useTemplates.ts`
  - template browse/preview/install
- `useNotifications.ts`
  - inbox feed, unread count, mark-read
- `useNotificationPreferences.ts`
  - digest and channel settings
- `useDashboards.ts`
  - dashboard CRUD and widget data execution
- `useReports.ts`
  - report CRUD, run, schedule

### Dynamic Plugin UI Registration

Current state:

- `apps/web/src/view-registry.ts` is a static name-to-loader map.
- `apps/web/src/plugins/viewRegistry.ts` is effectively a hardcoded compatibility layer.
- multitable view and field menus are still mostly hardcoded.

Target state:

1. `packages/core-backend/src/platform/app-registry.ts` loads core manifests plus synthesized app manifests from active plugins.
2. `packages/core-backend/src/services/ExtensionRegistryService.ts` normalizes plugin contributions from `contributes.views`, `contributes.fieldTypes`, `contributes.triggers`, `contributes.actions`, and future `contributes.widgets`.
3. `GET /api/platform/extensions` returns a workspace-filtered catalog.
4. `apps/web/src/view-registry.ts` becomes a runtime registry with functions such as `registerViewLoader()` and `resolveViewLoader()`.
5. `MetaViewManager.vue` renders available view types from the registry instead of a fixed list.
6. `MetaFieldManager.vue` renders field creation options from the registry and only falls back to the built-in types when the registry is unavailable.

### App Launcher Shell

`PlatformShell.vue` should own:

- workspace identity strip
- app launcher drawer
- per-workspace app favorites/pins
- top search entry point
- notification bell
- profile and session controls

Element Plus patterns that fit the current codebase:

- `el-container` / `el-aside` / `el-header`
- `el-menu` for launcher/sidebar
- `el-drawer` for app launcher and notification inbox
- `el-dropdown` for workspace and account actions
- `el-badge` for unread notifications
- `el-tabs` for app home and dashboard/report tabs
- `el-form` and `el-tree` for automation builder editing

### Multitable and Existing App Integration

The multitable workbench remains a platform primitive, but phase 2 changes how it gets optional capabilities:

- view type definitions come from the extension registry
- field type definitions come from the extension registry
- automation actions for record events are surfaced inline in multitable
- dashboard widgets can later query multitable through registered datasource resolvers

Attendance, approvals, and PLM remain existing views during phase 1. They become first-class app surfaces through launcher metadata, not through a rewrite.

## 5. Backward Compatibility Strategy

### Compatibility Principles

- Existing plugins keep loading through the current plugin loader.
- Existing routes keep working until the new shell is fully stable.
- Existing runtime services remain the execution backbone even when new APIs are added.
- New platform primitives must wrap or reuse existing services before replacing them.

### Phase-by-Phase Compatibility

| Surface | Strategy |
| --- | --- |
| `user_orgs` | Keep the table and backfill from it into new platform tables in phase 1. Read both during the transition. |
| Existing JWT/session flow | Add organization/workspace context claims opportunistically, but do not require them for legacy routes on day one. |
| Existing plugin manifests | If `app.manifest.json` is missing, synthesize app identity from `plugin.json` and `contributes.views`. |
| `/api/plugins` | Keep it unchanged; add `/api/platform/apps` as the new shell-facing API. |
| Existing plugin views under `/p/:plugin/:viewId` | Keep them operational. New launcher routes point to the same component host until plugin apps add richer manifests. |
| Hardcoded frontend routes | Preserve them and redirect into workspace routes only after context resolution. |
| `NotificationService.ts` | Keep it as the send engine; the notification hub capability adds persistence and inbox semantics around it. Existing callers do not need to change immediately. |
| `meta_dashboards` / `meta_widgets` | Extend them in phase 5 instead of replacing them with new tables. |
| Event and message buses | Automation uses them directly; no second bus is introduced. |

### How Existing 15+ Plugins Continue Working Unchanged

1. Loader shim
   - `packages/core-backend/src/core/plugin-loader.ts` continues to load current `plugin.json` files unchanged.
   - `packages/core-backend/src/platform/app-registry.ts` synthesizes app metadata from current plugin manifests.

2. View compatibility
   - Current `contributes.views` entries continue to appear in `/api/plugins`.
   - They are also mapped into the platform app catalog and launcher.

3. No forced `app.manifest.json`
   - Existing plugins can opt into richer platform metadata later.
   - First-party plugins should get optional manifests after phase 1 is stable, but the critical path does not depend on them.

4. Extension fallback
   - If a plugin does not register field types, triggers, actions, or widgets, the platform simply treats it as a view-only app.

5. Package bootstrap
   - The internal app catalog/template capability should seed current built-in plugins as `system` packages so the plugin manager and catalog do not disagree about what is installed.

6. Notification bridge
   - Existing plugin code that calls the current notification service continues to work; the new hub receives mirrored message records from the wrapper.

7. Dashboard bridge
   - Existing plugins are not required to expose dashboards. Phase 5 dashboards can consume existing REST endpoints and multitable/workflow data sources without plugin changes.

### Legacy Redirect and Decommission Plan

- `Phase 1A` through `Phase 2B`: legacy routes stay first-class
- After `Phase 1A` stabilization: launcher can become the default entry after login
- When the notification hub ships: replace ad hoc unread indicators
- When dashboard/reporting ships: workspace home can default to a dashboard instead of a hardcoded redirect
- After phase 5 stabilization: convert old top-level app URLs to permanent redirects and deprecate only after one release train

## 6. Effort Estimates

Assumptions:

- 1 senior backend/platform lead
- 1 additional backend engineer
- 1 frontend engineer
- shared infra/devops support
- QA and product/design overhead add roughly 20-25% beyond the engineering numbers below
- If the same engineers continue shipping attendance, multitable, and approvals in parallel, apply a `1.5x` schedule-risk factor to calendar forecasts.

| Phase | Backend | Frontend | Infra | Total person-weeks | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| Phase 1: Workspace and shell | 4.0 | 3.0 | 1.0 | 8.0 | heavy coordination across auth, routing, and shell |
| Phase 2: Automation and extension registry | 6.0 | 4.0 | 1.0 | 11.0 | hardest platform-logic phase |
| Phase 3: Marketplace and templates | 5.0 | 3.0 | 2.0 | 10.0 | governance and install safety matter as much as coding |
| Phase 4: Notification hub | 4.0 | 3.0 | 2.0 | 9.0 | connector reliability and secret handling drive infra work |
| Phase 5: Dashboards and reports | 6.0 | 5.0 | 1.5 | 12.5 | query execution, widget system, and scheduling are broad |
| **Total** | **25.0** | **18.0** | **7.5** | **50.5** | about 3-4 calendar months with a mostly dedicated 4-person core team; longer if shared with active business streams |

Suggested staffing by phase:

- Phase 1: 1 backend lead, 1 frontend, 0.5 backend shared
- Phase 2: 2 backend, 1 frontend
- Phase 3: 1.5 backend, 1 frontend, 0.5 infra
- Phase 4: 1 backend, 1 frontend, 0.5 infra
- Phase 5: 2 backend, 1 frontend, analytics-heavy support

## 7. Risk Analysis

| Phase | Risk | Why it matters | Concrete mitigation |
| --- | --- | --- | --- |
| 1 | Context leakage between tenant/org/workspace | Incorrect data scope is a platform-breaking failure | keep shard routing on existing tenant id first, add workspace context in parallel, add request-scope assertions in middleware and integration tests |
| 1 | Shell regression from hardcoded routes | Attendance and multitable are active tracks right now | keep legacy routes live, introduce redirects only after bootstrap context is loaded, test route parity before switching default home |
| 1 | Dual membership model drift | `user_orgs` and new platform tables can diverge | make one migration backfill, then designate new tables as source of truth while keeping a compatibility sync job |
| 2 | Automation duplicates and loops | Existing event volume plus new rules can explode quickly | idempotency fingerprint, loop guard on source event metadata, per-rule concurrency policy, DLQ integration |
| 2 | Unsafe plugin contributions | Dynamic field/action registration widens attack surface | validate contributions at load time, require explicit capabilities, reject untrusted JS actions in v1 |
| 2 | Builder UX complexity | A bad rule builder will stall adoption | narrow v1 scope, provide tested templates, keep JSON inspector for advanced users |
| 3 | Marketplace trust and version drift | Installing a bad package affects whole workspaces | first release is internal-only, signed package metadata, compatibility checks against core version and required permissions |
| 3 | Template side effects | Templates can create bad workflows or mutate live data | dry-run preview, transaction + validation summary, rollback handles in `template_installs` |
| 3 | Plugin install/hot reload instability | runtime enable/disable is already sensitive | route installs through current plugin loader admin flows and pause package upgrades during active reloads |
| 4 | Notification fatigue | Too many alerts will reduce trust in the hub | per-topic subscription defaults, digest modes, quiet hours, dedupe key across deliveries |
| 4 | Credential handling for external channels | DingTalk/Feishu/WeCom/webhook secrets are sensitive | secret references only in DB, use existing secret/config infrastructure, audit admin changes |
| 4 | Delivery cost and retries | provider outages or rate limits can saturate the system | async worker + retry backoff + DLQ + workspace/channel quotas |
| 5 | Slow queries and report load | dashboards become unusable if every widget runs expensive live queries | add datasource adapters, cache, scheduled materialization, and hard limits on live widget queries |
| 5 | Cross-workspace data exposure | analytics often bypass app-level permission assumptions | enforce workspace and RBAC inside datasource resolvers, add query guardrails and audit trails |
| 5 | Widget proliferation | too many one-off widgets create long-term maintenance debt | ship a constrained core widget catalog first and require plugins to register widgets through the extension registry contract |

## 8. Platform Comparison

### Feishu/Lark

**Documented approach**

- Lark positions itself as a unified work platform or “superapp” with multiple built-in business surfaces, not a single spreadsheet product.
- Lark Base is documented as a no-code way to build custom tools and workflows with multiple views, dashboards, workflow automation, and notifications into chat.
- Lark Approval is documented as a centralized approval center with templates and no-code customization.
- Lark’s pricing and product pages show Base automation workflows, granular permissions, dashboard permissions, webhook triggers, mini apps, templates, and approvals as connected platform capabilities.

**What MetaSheet2 should learn**

- The shell matters as much as the data layer.
- Approvals should stay a platform primitive rather than becoming app-specific logic.
- Templates and automations are distribution mechanisms, not “nice to have” extras.
- Notifications feel more valuable when they are embedded in the main shell rather than buried inside each app.

**Where MetaSheet2 should diverge**

- Do not try to become chat-first in the near term. MetaSheet2 does not currently have IM, meetings, docs, or calendar as native products.
- Use the current strength: structured data, workflow, approval bridge, and plugin extensibility. The Feishu/Lark analog here is the operational platform layer, not the communication stack.
- Build an app shell and notification center, but avoid spending early roadmap on chat-native metaphors that the repo does not support today.

**Hypothesis**

The public product packaging strongly suggests Lark evolved by layering Base, approvals, templates, and app surfaces into a unified shell. Public marketing/docs do not fully expose the internal sequencing, so the exact order should be treated as inference rather than confirmed architecture history.

### Notion

**Documented approach**

- Notion documents blocks as its universal content primitive.
- Notion databases are collections of pages, with multiple views and properties layered on top of the same underlying object model.
- Notion later added database automations and a large template marketplace on top of that same content/database substrate.
- The Notion workspace model centers navigation, sidebar, and content inside one consistent shell.

**What MetaSheet2 should learn**

- Strong primitives beat many bespoke features. In Notion, the block/page/database model made templates, views, and automations composable.
- The shell, the data model, and the template ecosystem reinforce each other.
- Automations become much easier to explain when they are anchored to a small set of core objects.

**Where MetaSheet2 should diverge**

- Do not force every future business surface into a pure block/page model. MetaSheet2 already has richer service-oriented primitives such as approvals, attendance rules, plugin RPC, and federation.
- Keep multitable as the default operational data primitive, but allow service-owned tables where stronger domain guarantees are required.
- MetaSheet2 should be more explicit about app boundaries than Notion, because its plugin system and enterprise workflows need clearer operational contracts.

### Airtable

**Documented approach**

- Airtable organizes work around workspaces and bases.
- Automations are explicitly modeled as triggers plus one or more actions.
- Interfaces sit on top of the underlying base and are intended to tailor experiences to specific audiences without exposing the full base.
- Extensions are modular components attached to a base; Airtable publicly notes they were previously called Blocks and then Apps.

**What MetaSheet2 should learn**

- Separate the data layer from the user experience layer.
- Builder/admin users and end users often need different shells.
- Granular interface permissions let the same data model serve more audiences.
- A marketplace/distribution surface is more useful after the installable unit and permissions model are clear.

**Where MetaSheet2 should diverge**

- Airtable’s installable surface is base-centric. MetaSheet2 should become workspace-centric much earlier because it already has multiple business domains, approval flows, and plugin apps.
- MetaSheet2 should connect automation, notifications, and approvals across apps sooner than Airtable’s base-local model typically encourages.
- Because MetaSheet2 already has a microkernel, it can let plugins extend views, fields, triggers, and widgets through one registry instead of separate product silos.

### NocoBase

**Documented approach**

- NocoBase explicitly documents a microkernel architecture where business functions are provided as plugins.
- Its plugins are full-stack and can register client/server behavior.
- Workflow, notification management, and data visualization are documented as built-in plugins rather than separate products.
- NocoBase documentation also exposes plugin lifecycle, plugin manager, workflow extension, and extensible blocks/fields/actions.

**What MetaSheet2 should learn**

- The current MetaSheet2 architecture is already closer to NocoBase than to the other three products.
- New platform primitives should be framed as microkernel services plus registries, not as giant framework rewrites.
- Full-stack plugin contributions are the right place to extend views, fields, actions, and widgets.

**Where MetaSheet2 should diverge**

- NocoBase skews toward admin-builder systems. MetaSheet2 should keep investing in collaborative, real-time, spreadsheet-like UX because that is a differentiator it already has.
- MetaSheet2 should also lean harder into approvals, attendance, and Feishu-like operational flows than a generic internal-tools builder would.

## Recommended Strategic Positioning

MetaSheet2 should converge toward:

- Feishu/Lark’s shell, template, workflow, and operational-platform posture
- Notion’s discipline around core primitives and composability
- Airtable’s separation between data layer and tailored interfaces
- NocoBase’s microkernel/plugin operating model

It should not try to converge toward:

- a full chat superapp in the short term
- a universal block editor as the root primitive
- a base-local extension model that ignores workspace/app context
- a generic admin-builder product that neglects real-time structured collaboration

## References

Public references used to ground the comparison section:

- Lark Base product page: https://www.larksuite.com/ja_jp/product/base
- Lark Approval product page: https://www.larksuite.com/zh_cn/product/approval
- Lark Base plans and platform capability packaging: https://www.larksuite.com/lp/en/base-plans
- Lark templates example: https://www.larksuite.com/en_us/templates/lark-retail-customer-service-management-tracking-base
- Notion block model: https://www.notion.com/help/what-is-a-block
- Notion API block reference: https://developers.notion.com/reference/block
- Notion workspace model: https://www.notion.com/help/intro-to-workspaces
- Notion database model: https://www.notion.com/help/intro-to-databases
- Notion database automations: https://www.notion.com/help/database-automations
- Notion marketplace/templates: https://www.notion.com/templates
- Airtable workspace settings overview: https://support.airtable.com/docs/account-page-overview
- Airtable automations overview: https://support.airtable.com/docs/getting-started-with-airtable-automations
- Airtable extensions overview: https://support.airtable.com/docs/airtable-extensions-overview
- Airtable interface designer overview: https://support.airtable.com/v1/docs/getting-started-with-airtable-interface-designer
- Airtable interface layouts: https://support.airtable.com/v1/docs/adding-layouts-to-interfaces
- NocoBase plugin development overview: https://v2.docs.nocobase.com/plugin-development/
- NocoBase workflow overview: https://v2.docs.nocobase.com/workflow/
- NocoBase notification manager: https://v2.docs.nocobase.com/plugins/%40nocobase/plugin-notification-manager
- NocoBase data visualization overview: https://v2.docs.nocobase.com/data-visualization/
- NocoBase development architecture overview: https://v2.docs.nocobase.com/development/
