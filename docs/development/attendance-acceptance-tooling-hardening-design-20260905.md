# Attendance Acceptance Tooling Hardening

Status: implementation under standing development authorization; Draft/HOLD.
Authoritative baseline: `fdee94dc4997f68ab7cfb0b06b11b6364a05f3aa`.
Scope: existing acceptance tooling, hermetic tests, and its CI wiring.
Implemented code checkpoint: `959ce7d3eeb9afb8392c72a95b57f0ab2a59b037`.
Code tree: `474e660c1a6774f5c4beebfcc8e042c884b39862`.
Code delta: 28 files, 1698 insertions / 120 deletions; this report pair is separate.

## Contract

1. A production-labelled acceptance run requires an explicitly configured
   synthetic organization. No default organization or inferred admin tenant is
   acceptable. The deploy-host token fallback selects an active admin with active
   membership in that organization and mints a tenant-bound token. Every resolved
   token must pass `/auth/me` with the exact expected tenant before acceptance.
   Each API/browser consumer verifies refreshed tokens before adoption and the
   effective token before actions. Tenant-proof failure cannot become a warning,
   retry, feature fallback, or permission to keep using an old token.
2. Platform directory search and batch resolution explicitly request
   `scope=global`. Attendance operations continue to use the configured synthetic
   organization. `USER_SCOPE_REQUIRED` is a distinct failure reason.
3. Browser verifiers enter the visible admin workspace before selecting its
   quick-jump. A hidden control existing in the DOM is not readiness evidence.
4. A missing role/user is an error, not permission to fall back to legacy grants.
   Legacy fallback is allowed only for an unambiguous missing-route response.
   Assignment/grant success requires an independent permission readback. Errors
   report fixed codes, never server response bodies or identities.
   If provisioning refreshes its token, the refreshed token must also pass the
   expected-tenant check before any assignment or legacy grant.
5. Evidence distinguishes the verifier checkout SHA, the operator's expected
   deployment SHA, and the backend health response's observed build commit.
   Missing, malformed, unhealthy, or mismatched identity prevents acceptance
   operations. An unavailable runtime identity is not replaced by checkout HEAD.
6. Final workflow success requires the actual strict attempt, or its explicitly
   executed retry, to succeed. An earlier successful summary cannot mask a later
   attempt that aborted before writing a summary, including provenance failure.

## Implementation Boundaries

Auth, navigation/request scope, and provisioning/provenance have disjoint writers.
Runtime products, database schemas, permission policies, Time Machine behavior,
and feature flags are outside this change. Shared workflow changes preserve all
existing test invocations and add the owning hermetic gates.

This development window authorizes no production connection, SSH execution,
workflow dispatch, deployment, real-data access, or live role grants. Mock
executables and synthetic local responses provide development evidence. Any
future operational run still requires the owner's separate target authorization.

## Implementation

| Contract | Owning implementation | Independent negative |
| --- | --- | --- |
| Synthetic-org token | `resolve-attendance-smoke-token.sh`, `attendance-resolve-auth.sh` | Missing active membership, missing/wrong tenant, unsuccessful auth envelope, dropped container environment |
| Directory request scope | `attendance-smoke-api.mjs` | Search and batch resolve must both carry `scope=global` |
| Visible admin navigation | `attendance-admin-navigation.mjs`, both existing browser verifiers | Hidden quick-jump cannot be selected before entering the admin workspace |
| Permission provisioning | `attendance-provision-user.sh` | Semantic/unknown 404 never grants legacy permissions; incomplete independent readback fails |
| Runtime provenance | `attendance-acceptance-preflight.mjs`, gate runners and summary validators | Missing or mismatched runtime build prevents all acceptance commands |
| Consumer token lifecycle | Shared tenant helper, API smoke, both browser verifiers | Refreshed and unchanged tokens must pass current server tenant proof; error is not swallowed |
| Attempt completion | Strict workflow finalization | First-run green evidence cannot mask second-run entry/exit provenance failure |

Five existing workflows bind the organization explicitly. The strict and locale
production-labelled workflows also require `ATTENDANCE_EXPECTED_DEPLOY_SHA`.
The three import performance workflows reuse the explicit token/organization
binding, without claiming strict deployment-provenance acceptance.

The required `contracts (strict)` lane executes the six owning hermetic suites.
Its existing invocations are preserved. This does not change branch protection,
workflow triggers, plugin-test selectors, provenance pins, or runtime flags.

## Evidence Semantics

Schema version 2 requires a closed provenance object with `checkoutSha`,
`expectedDeploymentSha`, `observedDeploymentSha`, and the fixed source
`backend_health_build_commit`. Both validators require observed equals expected.
Historical version 1 reports remain parseable for historical tooling; setting
`ATTENDANCE_REQUIRE_PROVENANCE=true` prevents a new strict acceptance run from
downgrading to a proof-free historical report.

Observed identity is the backend's self-reported `/api/health` build commit.
It is not a frontend asset hash, independent binary attestation, or evidence that
the operator's expected SHA was actually deployed. An absent, stale, or mismatched
build commit is a hard acceptance failure; it must not be replaced with checkout
HEAD. Preflight runs both before and after the strict acceptance commands.
The workflow also checks attempt outcomes independently of report discovery;
validators parsing an older valid report do not establish a failed attempt's
success. Existing explicit rate-limit retry behavior is preserved.

The synthetic organization must be supplied by the separately authorized
operator. The tool verifies explicit binding and token tenant equality; it does
not infer that an arbitrary configured organization contains synthetic data.

## Verification Gates

- Stubbed token/auth tests: absent org, inactive membership, absent/wrong tenant,
  malformed HTTP-200 body, refresh/login tenant verification, and pinned SSH.
- Directory request-shape tests and values-free failure classification.
- Local fake-page/browser navigation tests for hidden and already-visible controls.
- Provisioning tests for semantic 404, unknown 404, missing route, incomplete
  permission readback, and hostile response redaction.
- Provenance tests for missing/malformed/mismatched SHA, unhealthy health response,
  checkout/deployment independence, and no acceptance command before preflight.
- Discriminating mutations, existing neighboring contract suites, shell/Node
  syntax checks, workflow/schema tests, independent security review, diff check.

## Completion Evidence

Local evidence and remaining gates are recorded in the companion verification
report. Published PR checks and merged-main evidence are separate checkpoints;
local tests do not establish operational acceptance or permission to deploy.
