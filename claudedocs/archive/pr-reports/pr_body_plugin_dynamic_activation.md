Title: feat(plugins): activate dynamic plugin loading (staging flag only)

Purpose
- Document and validate dynamic loading path now that core loader hooks exist.
- Allow staging / CI environments to turn on dynamic discovery & validator without impacting production.
- Provide rollback and observability guidance before enabling sandbox or persistence.

Changes
- Docs: add enable guide reference & activation instructions
- Optional example plugin log (flag gated) – no production behavior change
- No default flag changes (all remain safe/off in production)

Non-Goals
- Enabling sandbox isolation by default
- Adding persistence layer / migrations
- Hard enforcement of capability matrix

Feature Flags (unchanged defaults)
| Flag | Default | Notes |
|------|---------|-------|
| PLUGIN_DYNAMIC_ENABLED | false | Set true in staging to load example plugin |
| PLUGIN_VALIDATE_ENABLED | true | Lightweight manifest / capability warnings |
| PLUGIN_SANDBOX_ENABLED | false | Post-activation noop sandbox |

Staging Enable (example)
```bash
export PLUGIN_DYNAMIC_ENABLED=true
export PLUGIN_VALIDATE_ENABLED=true
export PLUGIN_SANDBOX_ENABLED=false
npm --prefix backend run dev
```

Runtime Indicators
- Logs containing: `Starting plugin loading...`
- On success: `Successfully loaded <n> plugins`
- Metrics (if prom-client present): `plugin_loaded_total` increments

Validation Steps
```bash
bash scripts/plugin-lint.sh
bash scripts/capability-matrix-verify.sh
# (No capabilities yet → informational message)
bash scripts/check-plugin-flags.sh
```

Rollback
```bash
export PLUGIN_DYNAMIC_ENABLED=false
export PLUGIN_SANDBOX_ENABLED=false
restart service
```

Risk & Mitigation
| Risk | Impact | Mitigation |
|------|--------|------------|
| Flag accidentally enabled in prod | Low/Med | Flags default false; pre-merge flag check script |
| Validator false positives | Low | Validator soft-disablable (PLUGIN_VALIDATE_ENABLED=false) |
| Sandbox bypass pre-init | Medium | Planned pre-init wrap phase |
| Capability drift | Low | Future hard matrix enforcement |

Follow-up (separate PRs)
- Pre-init sandbox wrap
- Capability matrix hard-fail mode
- Persistence migration (≥0430)
- Add `plugin_sandbox_wrap_fail_total`

Checklist
- [ ] No default flag flips
- [ ] Example plugin loads only with PLUGIN_DYNAMIC_ENABLED=true
- [ ] Lints & health scripts pass
- [ ] Rollback instructions verified

