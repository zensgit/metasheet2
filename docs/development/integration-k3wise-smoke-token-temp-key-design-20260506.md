# K3 WISE Smoke Token Temp Key Design

Date: 2026-05-06

## Context

`resolve-k3wise-smoke-token.sh` can mint a short-lived K3 WISE postdeploy smoke
token by SSHing into the deploy host and executing backend runtime code. Before
this slice, the deploy SSH key decoded from `DEPLOY_SSH_KEY_B64` was written to
the fixed path `~/.ssh/deploy_key`.

That fixed path is unnecessary for this resolver and can leave secret material
behind on reused runners or local test environments.

## Change

The resolver now:

- decodes `DEPLOY_SSH_KEY_B64` into a per-run `mktemp` file under
  `${TMPDIR:-/tmp}`
- sets the key mode to `0600`
- passes the temp path to `ssh -i`
- registers a `trap` that removes the temp key on script exit

The existing secret-token fast path is unchanged and does not create any SSH key
file.

## Scope

Changed files:

- `scripts/ops/resolve-k3wise-smoke-token.sh`
- `scripts/ops/resolve-k3wise-smoke-token.test.mjs`
- this design note
- companion verification note

No workflow files are changed, so this stays independent from the open K3 WISE
postdeploy workflow PR.
