# PLM Audit Scene Input Token Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`

## Goal

Push scene-context semantics from banner/highlight level into the audit search control itself, so users can see when the `Search` input is effectively driven by scene or owner context and can act on that context in-place.

## Problem

The previous slice unified token actions across:

- context banner
- summary card
- filter highlight

But the actual `Search` field still only relied on:

- active border/highlight styling
- indirect nearby context UI

That made the effective `q` source visible, but not explicit enough at the input control level.

## Design

### 1. Add an input-token helper

`/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSceneInputToken.ts`

This helper maps a generic `PlmAuditSceneToken` into an input-oriented model:

- `kind`
- `label`
- `value`
- `description`
- `locked`
- `actions`

It keeps token actions unchanged, but rewrites the description for the search-control use case:

- locked owner context -> search is locked to owner context
- locked scene context -> search is locked to scene query
- inactive owner shortcut -> pivot search to owner
- inactive scene shortcut -> restore scene query context

### 2. Render the token inside the search field block

`/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`

The search field now renders an inline token above the input when scene context exists:

- label/value
- lock-aware description
- token actions

This makes the current search-driving context visible where users actually edit `q`.

### 3. Keep action semantics centralized

The input token does not invent new actions.
It reuses the same token action model as:

- banner actions
- filter highlight actions
- summary-card primary action

So `owner / scene / clear` remain defined once.

## Expected Outcome

- Users can see immediately whether search is locked to scene or owner context.
- Users can pivot or clear that context from the search block itself.
- The search input no longer depends only on color/highlight to communicate state.

## Scope

Frontend only.

No changes to:

- backend audit routes
- route-state contract
- federation / Yuantus integration
