# PLM Workbench Default Reapply Design

## Context

Both `usePlmTeamViews()` and `usePlmTeamFilterPresets()` track the last automatically applied default target with `lastAutoAppliedDefaultId`.

That marker prevents duplicate auto-apply loops during steady state, but it also created a stale-memory problem:

1. default target is auto-applied
2. user explicitly applies a non-default target
3. that explicit target later disappears or becomes non-applyable
4. refresh wants to fall back to the default again
5. stale `lastAutoAppliedDefaultId` can incorrectly suppress the fallback

## Goal

Make default fallback re-enterable:

- auto-applied defaults should still be debounced during steady state
- once the user explicitly applies a non-default target, the old auto-default marker must no longer block future fallback

## Implementation

Updated both hooks:

- [/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)

Rule:

- applying a non-default target clears `lastAutoAppliedDefaultId`
- applying a default target keeps the marker untouched

That keeps the auto-default debounce local to the period where the default still owns the screen.

