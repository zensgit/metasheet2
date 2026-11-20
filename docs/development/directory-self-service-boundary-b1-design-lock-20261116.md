# Directory self-service boundary B1

## Scope

This slice makes existing DingTalk self-service identity changes unavailable to all users, including administrators. It does not provide a replacement binding workflow. Current accounts, identities, permissions, memberships, sessions, normal login and existing administrator operations remain unchanged.

No migration, feature flag, rollout, deployment or environment operation is part of this slice. Read-only settings and normal public-form authentication remain available. A missing administrative path must be described as unavailable, not as a guaranteed recovery service.

## HTTP contract

Authenticated self-service requests return HTTP 403 with exactly:

```json
{
  "success": false,
  "error": "Self-service DingTalk identity changes are unavailable. Please contact an administrator.",
  "code": "self_service_disabled"
}
```

- `GET /api/auth/dingtalk/launch?intent=bind`: preserve probe, configuration, invalid-intent and authentication precedence; refuse before creating state or a provider URL.
- `POST /api/auth/dingtalk/callback`: preserve missing-code, invalid-state, configuration, authentication and bind-user-mismatch precedence; refuse trusted same-user bind states, including previously issued ones, before profile exchange or any self-binding service call.
- `POST /api/auth/dingtalk/unbind`: authenticate, then refuse before access snapshot or self-unbinding service calls.

Existing state validation may consume an OAuth state. Existing authentication may read the database or touch session metadata. This is not a zero-SQL or zero-state-change promise. The denied operation must not write identities, grants, memberships or access generations, issue or revoke sessions, or exchange provider codes.

The callback guidance table and its cross-package mechanical comparison include the new refusal code. Existing codes with service-level sources remain supported.

## UI contract

- Settings retain DingTalk status and refresh, without self-service bind/unbind actions or HTTP handlers.
- A public form requiring a bound identity shows fixed guidance to contact an administrator. It does not launch binding or relax form access checks.
- Normal DingTalk sign-in redirects and form submission behavior remain unchanged.

## Explicit exclusions

This slice does not implement administrator verification, same-platform application replacement, identity history, strict-grant migration, session revocation or directory import/offboarding. It does not change administrator/CLI contracts. All prerequisites for those future actions remain in force.

## Verification gates

| Gate | Required evidence |
|---|---|
| G1 | Ordinary and administrator requests are refused at all three entry points, without self-service/provider/business side effects |
| G2 | Invalid/expired state, authentication and user mismatch retain their established responses; valid old bind states cannot finish |
| G3 | Normal login, activation, container login, probe and access-status tests remain passing |
| G4 | Settings are read-only and refreshable; public forms do not launch self-binding; normal sign-in/submission still work |
| G5 | Backend/frontend callback code sets match mechanically; one-sided code changes fail |
| G6 | Bypassing each server refusal independently turns its matching regression red; sources restore byte-for-byte |
| G7 | Focused whole-file tests, neighboring tests, application type-check and required web gate run on the final local sources |
| G8 | Independent code review closes blocking findings; local results are not remote CI, rollout or provider acceptance |

No push, commit, merge, deployment, staging access, provider access or account/binding mutation is authorized by this document.
