# T3C-2b Form Share Manager i18n Design

Date: 2026-05-20
Branch: `codex/multitable-t3c2b-form-share-i18n-20260520`
Base: `origin/main@62e179de3`

## Decision Summary

T3C-2b localizes `MetaFormShareManager.vue` chrome to zh-CN while preserving raw user-authored and backend-owned values.

Key decisions:

- Add `apps/web/src/multitable/utils/meta-form-share-labels.ts` as the form-share specific label module.
- Reuse `meta-manager-labels.ts` for shared manager actions where applicable. This slice uses `action.remove` for allowlist chip removal.
- Do not extend `meta-permission-labels.ts`; that module remains T3C-2a permission-only.
- Keep access-mode enum values, public token values, user names, member-group names, subtitles, and backend `err.message` text raw.
- Localize frontend fallback errors only when no backend `Error.message` is available.

## Files In Scope

- `apps/web/src/multitable/components/MetaFormShareManager.vue`
- `apps/web/src/multitable/utils/meta-form-share-labels.ts`
- `apps/web/tests/meta-form-share-labels.spec.ts`
- `apps/web/tests/multitable-form-share-manager.spec.ts`
- This design MD and the paired verification MD

Out of scope:

- `MetaApiTokenManager.vue` (T3C-2c)
- Permission managers (T3C-2a, already shipped)
- Backend routes, contracts, migrations, DingTalk policy behavior, and public-form auth semantics

## Label Module Contract

`meta-form-share-labels.ts` owns:

- Static chrome labels: title, loading state, access mode labels, allowlist labels, link/expiry labels.
- Access-mode helper text.
- Audience-rule helper text for all 5 visible combinations:
  - public
  - dingtalk + no local allowlist
  - dingtalk + local allowlist
  - dingtalk_granted + no local allowlist
  - dingtalk_granted + local allowlist
- Allowlist count summary with English singular/plural forks and zh neutral counts.
- DingTalk status labels for selected users/groups.
- Frontend fallback errors.

The module does not translate persisted values such as `public`, `dingtalk`, `dingtalk_granted`, subject IDs, token values, or backend-provided error strings.

## Exact Chrome Targets

`MetaFormShareManager.vue` chrome covered by T3C-2b:

- `Public Form Sharing`
- `Loading share settings...`
- `Sharing enabled` / `Sharing disabled`
- `Active` / `Expired` / `Disabled`
- Access-mode label and option labels
- Access-mode hints
- Audience-rule title and description strings
- Allowlist label, explanatory hint, summary, empty states, search placeholder
- Candidate loading/empty states, candidate type badges, inactive-user warning
- DingTalk binding / grant / member-group status labels
- Public link, copy/copied, regenerate, preview, expiry/no-expiry labels
- Frontend fallback errors

The chip removal button uses `managerLabel('action.remove', isZh)`, not a form-share duplicate.

## Testing Plan

- `meta-form-share-labels.spec.ts`
  - Static label mapping
  - Status/access-mode helpers
  - Audience-rule matrix
  - Allowlist count formatter
  - DingTalk status formatter
- `multitable-form-share-manager.spec.ts`
  - Existing English behavior remains covered with `useLocale().setLocale('en')`
  - New zh-CN render assertion verifies visible modal chrome, DingTalk status text, allowlist summary, shared manager `Remove`, and raw subject names

## Risk Controls

- No dead-key discipline: every label key maps to a concrete `MetaFormShareManager.vue` call-site or helper branch covered by specs.
- Cross-module discipline: common manager action stays in `meta-manager-labels.ts`; form-share-specific chrome stays in `meta-form-share-labels.ts`.
- Raw data boundary: subject labels/subtitles and backend errors remain unchanged.
- Package-relative test paths are used for `pnpm --filter @metasheet/web exec vitest`.

## Follow-Up

T3C-2c should localize `MetaApiTokenManager.vue` and continue reusing `meta-manager-labels.ts` shared actions instead of redeclaring them.
