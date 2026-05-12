# Generic Integration Workbench Connection Test Design - 2026-05-12

## Purpose

Close the first interactive Workbench gap after discovery and preview: users must be able to verify whether selected source and target systems are reachable before loading objects, mapping fields, or running future dry-run/save-only actions.

## Scope

- Add a frontend service wrapper for `POST /api/integration/external-systems/:id/test`.
- Add source and target connection status badges in `IntegrationWorkbenchView.vue`.
- Add source and target "test connection" buttons.
- Update selected system state from the sanitized backend `system` returned by the test endpoint.
- Keep this slice frontend-only. The backend route and redaction behavior already exist in `plugin-integration-core`.

## UX Rules

- `active` systems display `可用`, or `已连接` when `lastTestedAt` exists.
- `error` systems display `异常` plus the sanitized `lastError` when available.
- inactive or missing systems display `未启用` or `未选择`.
- Source and target tests are independent so users can validate one side without blocking the other.

## Security

The service sends an empty JSON body and relies on the existing backend route to load credentials server-side. Credentials are never sent from the browser and are never displayed in badges or status text.

## Non-Goals

- No dry-run or save-only execution in this slice.
- No connection creation/editing UI.
- No backend route changes.
