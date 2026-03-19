# PLM Audit Team View Recommendations Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Turn `/plm/audit` team views from a plain selector into a recommended entry surface so that:

- newly promoted audit team views appear immediately in a recommendation list
- current default audit team views are clearly surfaced as the stable team entry
- recently defaulted and recently updated audit team views can be applied or promoted from the recommendation card itself

## Scope

Frontend-only slice:

- no backend schema or route changes
- reuse existing audit team-view data:
  - `isDefault`
  - `lastDefaultSetAt`
  - `updatedAt`
  - `permissions.canSetDefault`
- add recommendation ranking, summary chips, and card-level actions to `/plm/audit`

## Design

### Recommendation helper

New helper:

- [plmAuditTeamViewCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewCatalog.ts)

It computes:

- recommendation reason:
  - `default`
  - `recent-default`
  - `recent-update`
- recommendation source label/timestamp
- primary and secondary actions
- summary chips and active hint text

### Action layering

Recommended audit team views now use differentiated actions:

- current default
  - primary: `进入默认视图`
  - secondary: `复制默认链接`
- recent default
  - primary: `查看近期默认`
  - secondary:
    - `重新设为默认` when allowed
    - otherwise `复制视图链接`
- recent update
  - primary: `查看最新更新`
  - secondary:
    - `设为默认` when allowed
    - otherwise `复制视图链接`

### Audit page integration

- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)

The audit page now exposes:

- summary chips for recommended audit team views
- a recommendation hint under the chip row
- cards with owner, source timestamp, and action note
- direct primary action for apply
- direct secondary action for copy-link or set-default

The existing team-view selector row remains, so recommendations complement rather than replace the explicit management controls.

## Why this is better

- gives newly promoted audit team views a visible landing zone
- makes default audit entry behavior obvious without forcing users into the selector
- surfaces default promotion where it matters most: on recently updated and recently defaulted audit views
