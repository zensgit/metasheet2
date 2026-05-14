# System Integration Default Page Development - 2026-05-13

## Goal

Make the integration entry point product-neutral. The top navigation should no longer present the feature as only ERP integration or route users directly into the K3 WISE preset. The default page is the generic system integration workbench where users can choose any source system, clean data through multitable staging, and push to any supported target system.

## Changes

- Updated the platform shell integration nav item:
  - Chinese label: `系统对接`
  - English label: `System Integration`
  - default route: `/integrations/workbench`
- Updated `/integrations/workbench` route metadata:
  - `title: System Integration`
  - `titleZh: 系统对接`
- Repositioned the workbench header as the default generic system integration page.
- Repositioned `/integrations/k3-wise` as a specialized preset:
  - route title: `K3 WISE Setup Preset`
  - Chinese title: `K3 WISE 预设向导`
  - page eyebrow: `System Integration Preset`
- Kept the K3 WISE preset link from the generic workbench, so K3 remains a fast path without being the default product surface.

## Non-goals

- No backend route, adapter, migration, or pipeline behavior changed.
- No K3 credential, tenant scope, or WebAPI request behavior changed.
- No new connector type was added.

## Expected UX

1. User opens the app navigation.
2. The integration entry reads `系统对接` / `System Integration`.
3. Clicking it opens `/integrations/workbench`.
4. The page explains that it is the default generic system integration page.
5. K3 WISE remains available as a preset button for customers using K3 WISE.
