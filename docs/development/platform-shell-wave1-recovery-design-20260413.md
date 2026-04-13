# Platform Shell Wave 1.1 Recovery Design

Date: 2026-04-13
Branch: `feat/platform-shell-wave1`

## Summary

Wave 1.1 strengthens the platform shell without expanding backend contracts.

This slice adds two things:

- shell-level recovery diagnostics driven by app-declared `currentPath`
- component-level coverage for shell install/reinstall behavior

The intent is to make `/apps/:appId` operationally useful when an installable app is degraded, while keeping `after-sales` installer semantics unchanged.

## Problem

Wave 1 introduced install/reinstall actions in `PlatformAppShell`, but recovery context was still weak:

- the shell knew whether an app instance existed
- the shell could trigger `Install app` or `Reinstall app`
- but it did not surface the plugin’s own runtime snapshot

That meant a failed or partial install had an action button but not enough context:

- no current status snapshot
- no report reference
- no warning list
- no summary of created objects/views

## Scope

Included:

- read `runtimeBindings.currentPath` from the app manifest
- fetch runtime current snapshot in `PlatformAppShell`
- render recovery diagnostics from existing `after-sales` current contract
- keep success/error notices visible without hiding shell content
- add component tests for diagnostics and install-refresh flow

Excluded:

- changes to `after-sales` installer state machine
- changes to `/api/after-sales/projects/current` envelope
- changes to `/api/after-sales/projects/install` payload contract
- generic recovery protocol across all plugins

## Design Decisions

### 1. Recovery data stays plugin-owned

The shell does not invent new diagnostic fields.

It reads the plugin’s existing current snapshot through:

- `runtimeBindings.currentPath`

For `after-sales`, the useful fields are already present:

- `status`
- `projectId`
- `displayName`
- `reportRef`
- `installResult.status`
- `installResult.createdObjects`
- `installResult.createdViews`
- `installResult.warnings`
- `installResult.reportRef`

Relevant files:

- `plugins/plugin-after-sales/lib/installer.cjs`
- `plugins/plugin-after-sales/index.cjs`
- `plugins/plugin-after-sales/app.manifest.json`

### 2. Shell notices are non-blocking

The original shell notice flow replaced the main shell content after install/reinstall.

Wave 1.1 changes notices to render above the shell instead of replacing it.

Rationale:

- users need to see confirmation and diagnostics at the same time
- successful install should still leave the shell visible
- failed runtime actions should not erase recovery context

Relevant file:

- `apps/web/src/views/PlatformAppShellView.vue`

### 3. Diagnostics remain optional

The shell only renders recovery diagnostics when an app declares `runtimeBindings.currentPath`.

This preserves the direct app model:

- `attendance` remains direct-open with no diagnostics fetch
- `after-sales` remains instance-based with current/install bindings

Relevant file:

- `apps/web/src/views/PlatformAppShellView.vue`

## Implementation Notes

### Frontend

`PlatformAppShellView` now:

- loads the platform app summary
- loads runtime diagnostics when `currentPath` exists
- renders a `Runtime diagnostics` panel
- refreshes diagnostics after install/reinstall
- keeps notices visible without suppressing shell content

Relevant file:

- `apps/web/src/views/PlatformAppShellView.vue`

### Testing

Wave 1.1 adds a dedicated shell component test file instead of relying only on composable tests.

Covered flows:

- diagnostics panel renders data from `/api/after-sales/projects/current`
- clicking `Install app` calls the declared install mutation and refreshes runtime state

Relevant file:

- `apps/web/tests/platform-app-shell.spec.ts`

## Constraints

- no contract changes to `after-sales current/install`
- no generic progress streaming
- no installer ledger redesign
- no attempt to normalize every plugin into the same runtime shape

## Outcome

After this slice:

- `PlatformAppShell` shows real recovery context for installable apps
- install/reinstall is test-covered at the component level
- `after-sales` gets better operational recovery UX without backend protocol churn

