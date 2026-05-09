# K3 WISE Authenticated Smoke Signoff Design - 2026-04-30

## Context

The K3 WISE postdeploy smoke has two useful modes:

- public-only diagnostics: health, integration plugin health when public, and
  frontend route reachability.
- authenticated signoff: auth `/me`, route contract, control-plane list probes,
  and staging descriptor contract.

Before this change, public-only smoke could still produce `ok=true` and
`Status: PASS`. That was correct for diagnostics, but too easy to misread as
internal-trial readiness.

## Design

The smoke evidence now carries explicit signoff semantics:

```json
{
  "signoff": {
    "internalTrial": "pass|blocked",
    "reason": "..."
  }
}
```

Rules:

- `pass` requires `ok=true` and `authenticated=true`.
- `blocked` is used when authenticated checks did not run or any smoke check
  failed.

The Markdown evidence now shows both:

- `Internal trial signoff: PASS|BLOCKED`
- `Diagnostic result: PASS|FAIL`

The summary renderer also supports `--require-auth-signoff`, which adds the
same signoff line to GitHub Step Summary output.

## Workflow Changes

- Manual `K3 WISE Postdeploy Smoke` now defaults `require_auth` to `true`.
- Manual token resolution defaults to required mode.
- Manual and deploy workflow summaries call
  `integration-k3wise-postdeploy-summary.mjs --require-auth-signoff`.
- The deploy workflow remains compatible with environments that have not set
  `K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH=true`, but its summary now marks
  public-only evidence as blocked for internal trial signoff.

## Non-Goals

- This does not connect to customer PLM, K3 WISE, or SQL Server.
- This does not make every push deploy require K3 authenticated smoke by
  default; that remains controlled by `K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH`.
- This does not change token minting behavior or expose token values.
