# Persisted personal change-read connection handoff — 2026-10-20

This is the Meta backend half of package configuration handoff. It connects an
explicit installation setting to the existing managed-link provisioning transaction
and permits explicit source-owner configuration through the existing source API.
It issues no Native grant, starts no listener and adds no management engine.
Native package rendering/export and new installed-image acceptance remain open.

## Source authority

With `PLM_PERSONAL_BOM_CHANGE_READ_ENABLED` exactly `true`, a new managed link needs
an explicit valid `config.options.personalChangeReadConnectionId`. If absent, only
the dedicated `PLM_PERSONAL_BOM_CHANGE_READ_CONNECTION_ID` installation setting may
seed it. The source is locked, owner/active/type/Meta tenant and registered Native
origin/tenant/org are rechecked, and source configuration plus link commit in the
same transaction. The dedicated input never comes from the OAuth client ID,
Meta user/source ID, approval connection setting or any credential. A token-shaped
opaque grant cannot be used as a connection identifier.

An already persisted value is authoritative. A conflicting installation value is
refused, not applied over frozen identity. When the dedicated setting is omitted,
a valid existing persisted value works. Other flag values leave legacy source
bytes and provisioning behavior unchanged. Runtime personal reads continue to
use persisted source configuration; the environment is not a runtime fallback.
Shared source credential bytes are preserved without decrypting or using them.

Automatic seeding cannot modify a Visual Review source's protected configuration.
Such a source must be explicitly configured through the existing platform-admin
source API first. Existing owner opt-in, source ownership, independent Meta
memberships and Native identity-link controls remain in force.

Existing linked sources do not bypass the existing active-link 409 to accept an
installation change. Their owner configures this option through the existing
source create/update API. Both schemas now retain and validate it. An explicit
source change follows the existing source-authority/listener-stop mechanism;
individual Native confirmation and grant verification are still required.

## Independent cache-loss counterexample

Review of the handoff found that the existing non-Visual source manager could
save an older cached configuration after the transactional seed and silently
remove the new persisted connection option. A focused actual-manager/stateful-store
unit test reproduced that loss before repair. The retained red log is
`/tmp/plm-change-read-handoff-cache-before-20261020.log`.

The existing manager now preserves only this new persisted PLM option when an old
cache omits it, under its existing database row lock. It returns the repaired
configuration to the normal adapter swap, refreshing that cache as well. Explicit
owner edits remain explicit; no broad source merge or authority rule was changed.
A corrupt non-string persisted value fails closed instead of being silently
removed. The green test verifies both persistence and the resulting adapter cache.

## Evidence

- Actual PostgreSQL managed-link entry point:14 distinct new controls qualified
  cumulatively (13 initial, one new Visual-boundary case). They cover explicit
  seed and field preservation, no credential decryption/Native request, existing
  persisted identity without an environment fallback, refusal of an approval
  setting as read configuration, conflict/opaque credential refusal, four non-true
  flags preserving legacy bytes, independent Native/Meta scopes, concurrent
  provisioning and full seed rollback after an injected link-insert failure.
- These tests used a new explicitly owned disposable database. The existing
  companion suite's destructive setup/teardown was not run against any retained
  acceptance or business database. Its Native responses are controlled fixtures;
  this is not Native authentication or personal-grant runtime proof.
- Existing owner source HTTP API:one focused case passed create/read/update of the
  explicit field, retained Native scope siblings, credential-shaped input refusal
  and non-owner404. Authentication/RBAC and persistence use existing unit doubles;
  this is not a real login or installation acceptance.
- Manager persistence/ownership compatibility:8 selected cases qualified
  cumulatively, including the new cache-loss case. The first selection passed7
  and the legacy adapter-connect fixture failed closed because it provided no
  durable unbound classification. Only that failed fixture was repaired using the
  existing helper that executes the actual binding SELECT against its narrow
  query double; it does not install an always-unbound reader. Its original adapter
  connect assertions remain. The selected case then passed; no production guard
  was disabled. Its intentionally limited load-store double still warns about an
  unsupported status update, so status persistence is not claimed by that case.
- Existing optional adapter-startup control:1 passed. The new source schema does
  not eagerly require the optional managed authentication service.
- Full backend TypeScript project validation passes with unchanged options. The
  first final check caught an unknown-to-ConfigValue assignment; actual string
  narrowing now refuses corrupt values, without a cast or weakened compiler gate.
  Staged whitespace checks pass. Previously accepted read/enrollment/UI/runtime
  profiles were not rerun.

## Remaining paired and package acceptance

The Native renderer/export must emit and retain the independent read flag and
explicit connection setting, default both sides off, preserve registered identity
and old cleanup capability on disable, and pin actual compatible source/images.
Existing-source upgrades use the existing owner/admin source API, preserving its
locks and permission boundaries. A request or409 alone is not successful handoff.

Combined actual Native-issued yue, real Meta managed authentication/browser
consent/enrollment/start, owned HTTP delivery, PostgreSQL process concurrency and
coordinated backup/restore still require their full proof. Current frontend image
1b9aa0ef is from the preceding UI source; current installed Native/backend images
predate this handoff. No install, deployment, production or whole-goal acceptance
is claimed. All publication remains held behind #363's valuable queued job and
all PRs remain Draft.

Source commit: `059b06b595abf2bd4834541ce0b2db3aaaf72493`. Compact receipt:
`artifacts/plm-personal-change-read-handoff-20261020/verification.json`.
This is the single source-closeout document commit; exact remote head CI remains
pending held publication. Owned QA PostgreSQL is stopped with its evidence retained.
