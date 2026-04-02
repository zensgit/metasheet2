# PLM Team Scene Card Actions Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Promote the workbench scene catalog from label-only recommendation cards to action-layered cards:

- current default scenes emphasize stable entry and sharing
- recent default scenes emphasize audit traceability
- recent update scenes emphasize update review before reuse

## Design

## Action contract

`PlmRecommendedWorkbenchScene` now carries:

- `primaryActionKind`
- `primaryActionLabel`
- `secondaryActionKind`
- `secondaryActionLabel`
- `actionNote`

## Recommendation mapping

- `default`
  - primary: `进入默认场景`
  - secondary: `复制默认链接`
  - note: stable team entry
- `recent-default`
  - primary: `查看近期默认`
  - secondary: `查看近期默认变更`
  - note: recent default switch should be audited first
- `recent-update`
  - primary: `查看最新更新`
  - secondary: `查看更新记录`
  - note: recent update should be reviewed before reuse

## UI behavior

- scene cards render the action note under recommendation source
- default scene primary action is visually stronger
- secondary action dispatches by kind:
  - `copy-link` -> copy scene link
  - `open-audit` -> open scene audit

## Scope

Frontend-only slice:

- no federation contract changes
- no backend schema changes
- no Yuantus behavior changes
