# PLM Audit Scene Summary Filter Highlight Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`

## Goal

Make the active `scene / owner` context visible in both places that matter on the audit page:

- the summary cards
- the filter form

## Problem

After adding scene-aware summary cards, the user could see context in the summary area, but the filter form still looked neutral. That left a gap between:

- what the page said was active
- what the filter UI visually suggested was active

## Design

### 1. Active summary card states

`plmAuditSceneSummary.ts` now models whether the card is active and what kind of context it represents:

- `kind: 'owner' | 'scene'`
- `active: boolean`

Card state rules:

- owner context active -> active owner card
- scene query active -> active scene card
- owner available but inactive -> inactive owner shortcut card
- scene context only -> inactive/neutral scene card

### 2. Filter highlight strip

When the summary card is active, the filter form shows a dedicated highlight strip above the filter inputs. It repeats:

- label
- current active value
- explanation
- contextual action

This keeps the current context visible next to the actual query controls.

### 3. Search field highlight

Because both owner-context and scene-query-context are currently implemented through the `q` field:

- the `Search` field receives an active visual treatment when either context is active

This keeps the current implementation honest instead of pretending the context is elsewhere in the filter model.

## Implementation

Files:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSceneContext.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSceneSummary.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditSceneContext.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditSceneSummary.spec.ts`
