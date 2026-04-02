# PLM Workbench Local Preset Single Restore Parity Design

## Background

`BOM / Where-Used` team preset restore had diverged into two different behaviors:

- batch restore already preserves local preset ownership when the current filter state is still owned by a local preset
- single restore still treated the same situation as a generic pending-management block, or cleared local ownership after success

That made single restore weaker than batch restore even though both operate on the same archived team preset target.

## Design

Align single restore with the existing batch-restore contract:

1. In `usePlmTeamFilterPresets.ts`, treat pure external-owner drift differently from a true pending apply selector:
   - pending apply between two team presets still blocks restore
   - local preset ownership drift no longer blocks restore
2. Expose `canRestoreTeamPreset` from the selected preset’s actual restore permission under local-owner drift, so the UI does not hide a valid restore action.
3. When a single restore succeeds while a local preset already owns the current state:
   - restore the team preset record itself
   - do not `applyPresetToTarget(...)`
   - do not clear the local preset owner
4. Keep the existing takeover behavior for the normal no-drift case.

## Expected Outcome

Single restore now matches batch restore:

- archived team presets can be restored even while a local preset still owns the live filter state
- the restored team preset stops being archived in the list
- local ownership and pending selector semantics remain intact until the user explicitly applies the team preset
