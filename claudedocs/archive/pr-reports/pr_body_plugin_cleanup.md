Title: chore(plugins): remove duplicate loader/sandbox/validator in preparation for dynamic loading

Purpose
- Eliminate parallel implementations under `src/plugins/` now that core loader has validator/sandbox hooks.
- Reduce future merge conflicts and simplify dynamic loading review.

Changes
- Removed plugin-specific loader / sandbox / validator files (migrated logic to core/* if still needed)
- Preserved example plugin for demonstration (non-production)
- Added/Updated plugin refactor plan progress markers

Non-Goals
- Enabling dynamic loading (flag remains off)
- Adding persistence or capability registrations
- Enforcing sandbox pre-activation isolation

Validation
```bash
bash scripts/plugin-lint.sh
bash scripts/capability-matrix-verify.sh
```
Expect: single loader; no capability mismatches.

Rollback
- Revert commit (no schema impact)
- Feature flags unchanged

Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| Missed logic in removed loader | Core loader already unified; manual diff validated |
| Sandbox behavior regression | Sandbox still gated & no-op when disabled |

Checklist
- [ ] No duplicate `PluginLoader` classes
- [ ] No plugin-local validator/sandbox residuals
- [ ] Example plugin intact
- [ ] Lints pass

