# DingTalk Public Form Access Matrix UI Acceptance Design - 2026-04-28

## Goal

Reduce the remaining manual verification for the public-form sharing panel by turning the operator-facing access-matrix checks into repeatable frontend assertions.

The previous 142 verification left these checks as manual:

- Open the form sharing panel and visually confirm the access-rule card for `public`, `dingtalk`, and `dingtalk_granted`.
- Confirm selected allowed users and candidate search rows display DingTalk binding / grant status.
- Re-run real DingTalk mobile flows if product signoff evidence is required.

This slice automates the first two items as far as they can be validated without a real browser/device and DingTalk tenant session.

## Design

### Selected Member Group Status

Allowed member groups now show the same DingTalk status helper used by candidate rows:

- `Members are checked individually`

This makes the configured allowlist chips match the candidate-search rows and explains that a group selection does not bypass per-user DingTalk binding / grant enforcement.

### Access Matrix Assertions

The frontend unit test now checks the full operator access matrix:

| Mode | Local allowlist | Expected card |
| --- | --- | --- |
| `public` | empty | `Fully public anonymous form` |
| `dingtalk` | empty | `All DingTalk-bound users` |
| `dingtalk` | non-empty | `Selected DingTalk-bound users` |
| `dingtalk_granted` | empty | `All authorized DingTalk users` |
| `dingtalk_granted` | non-empty | `Selected authorized DingTalk users` |

Each case asserts:

- `data-form-share-audience-rule` exists.
- `data-access-mode` matches the configured access mode.
- `data-has-local-allowlist` matches the configured local allowlist state.
- The card title and description match the expected operator-facing rule.
- The allowlist section is hidden only for `public` mode.

### DingTalk Subject Status Assertions

The focused test now covers selected allowlist subjects and candidate rows:

- bound and granted user: `DingTalk bound and authorized`
- bound but not granted user: `DingTalk authorization not enabled`
- unbound user: `DingTalk not bound`
- member group: `Members are checked individually`

## Non-goals

- This does not replace real DingTalk mobile signoff. A real mobile flow still requires a live DingTalk account, tenant session, and product evidence capture.
- This does not change backend public-form authorization enforcement. Enforcement was already covered by backend integration tests and the deployed 142 smoke checks.
- This does not add or expose any DingTalk webhook, signing secret, JWT, or bearer token.
