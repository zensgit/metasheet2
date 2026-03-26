# PLM Workbench Team Preset Create-Draft Cleanup Design

## Background

`usePlmTeamFilterPresets.ts` already clears `teamPresetName` and `teamPresetGroup` after `saveTeamPreset()`,
`promoteFilterPresetToTeam()`, and `promoteFilterPresetToTeamDefault()`. But it leaves
`teamPresetOwnerUserId` intact.

That creates a stale transfer-owner residue:

- user types a transfer target while managing preset `A`
- user saves or promotes into a new preset target `B`
- the new preset is correctly selected, but the old owner draft still survives

`usePlmTeamViews.ts` already clears the owner draft after the corresponding create-target save path, so
team presets should match that contract.

## Decision

Treat these three preset actions as create-target takeovers:

- `saveTeamPreset()`
- `promoteFilterPresetToTeam()`
- `promoteFilterPresetToTeamDefault()`

Each path should clear the full preset management draft bundle:

- `teamPresetName`
- `teamPresetGroup`
- `teamPresetOwnerUserId`

The existing `clearTeamPresetDrafts()` helper is the canonical implementation point.

## Non-goals

- Do not change `rename`, `transfer`, `restore`, or `duplicate` semantics in this cut.
- Do not alter route ownership or batch selection behavior here.

