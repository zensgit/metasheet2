# K3 WISE GATE Readiness UI Refresh Development - 2026-05-14

## Context

PR #1305 was opened from an older K3 WISE setup branch and is now conflicting with
current `main`. The old branch predates several mainline changes:

- authority-code WebAPI auth mode;
- saved/draft connection-test guard;
- staging multitable open targets;
- current deploy-readiness script and mainline workflow gate.

Replaying the old branch would reintroduce stale assumptions and large merge
noise. This refresh ports only the still-missing product surface: customer GATE
JSON preparation, import, redacted copy/download, and postdeploy command bundle
surfacing.

## Scope

Changed files:

- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/tests/k3WiseSetup.spec.ts`

This is frontend/service helper only. It does not add backend routes or contact
customer PLM/K3/SQL systems from the browser.

## Design

### Form model

`K3WiseSetupForm` now includes the GATE-only draft fields:

- operator;
- PLM kind/read method/base URL/default product ID/credential draft;
- rollback owner/strategy;
- BOM PoC enablement/product ID.

These fields are separate from the saved K3 WebAPI/SQL external-system payload.
They are used for readiness packet generation, not for saving integration
systems directly.

### Redacted GATE JSON

`buildK3WiseGateDraft()` validates a Save-only non-production PoC packet and
emits redacted JSON:

- authority-code mode emits `credentials.authorityCode = "<fill-outside-git>"`;
- login mode keeps non-secret `acctId` and emits password placeholder;
- PLM and SQL credential secrets are never emitted;
- SQL middle-table mode rejects K3 core business tables as write targets;
- BOM PoC requires a BOM product ID or PLM default product ID.

### Import behavior

`applyK3WiseGateJsonToForm()` imports public fields from customer GATE JSON and
clears secret drafts:

- authority code, K3 password, PLM password, and SQL password are always reset;
- secret-looking imported fields produce warnings;
- unsupported enum aliases are conservative and either normalized or warned.

### UI

`IntegrationK3WiseSetupView.vue` adds:

- GATE JSON copy/download buttons;
- customer GATE JSON import textarea;
- import warnings list;
- deploy env and postdeploy signoff command bundle;
- preflight/offline/evidence command copy controls;
- PLM Source / rollback / BOM PoC form section.

The UI keeps the existing K3 setup flow intact and reuses current-main
connection-test guards and staging open-target behavior.

## Supersedes

This refresh supersedes #1305's stale branch implementation. The old branch
still had useful UX/test intent, but its code assumed a pre-authority-code K3
setup model.
