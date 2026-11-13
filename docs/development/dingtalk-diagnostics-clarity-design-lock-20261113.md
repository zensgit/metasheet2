# DingTalk diagnostic clarity — design lock (2026-11-13)

## Scope

This slice changes what the DingTalk directory connection test verifies and says, how the directory page words
the login probe, and how the sign-in callback page presents failures. It does not change the formal directory
sync (pull, matching, persistence, deprovisioning), account matching, grants, activation, binding, the login
gates, feature flags, migrations or deployment configuration. No identity match or authorization check is
relaxed.

All verification uses synthetic provider and database fixtures. Passing it does not mean that a real account can
scan in: the live directory scope, a real scan identity and any target-account recovery remain separate
acceptance work.

## Contract

### C1 Connection test (`POST /api/admin/directory/integrations/test`)

- After the existing five calls (token, root department list, first child-department member sample, ordinary
  root member sample, access-limited root member sample) the DingTalk probe makes **one logical member-detail
  read** (`getDingTalkUserDetail`) with the same client configuration as the list reads. The transport's
  existing retries are part of that one logical read; they are not additional logical reads, and the probe does
  not claim "at most one HTTP request".
- The detail sample is an **ordinary visible member**: the first member of the first child-department sample
  (which is itself the root sample when there are no child departments), else the first member of the ordinary
  root sample. The access-limited sample is never used. No pagination or further list call is added.
- A failing detail read rejects the probe through the existing route error handling: `400
  DIRECTORY_TEST_FAILED`, a DingTalk business rejection keeping only its errcode, any other failure the fixed
  sentence. It is never reported as healthy.
- The detail answer (which carries personal values) never enters the response or the logs.
- Without an ordinary sample no detail is read and a fixed warning says member-detail access is unverified. If
  the shared diagnosis would be `healthy`, the probe answers the new code **`member_detail_unverified`**
  instead; the two other codes stay as they are (they are not passes) and only gain the warning.
- `member_detail_unverified` is produced only by the connection probe. The shared builder (also used by the
  manual run's diagnostic sample) still yields only `healthy`, `no_child_departments` and
  `scope_or_root_misconfigured`; no code value reaches `directory_sync_runs.stats.diagnosticCode` that did not
  before. No consumer branches on the code.
- Response keys, key order (`summary` = `code`, `title`, `nextAction`) and the existing code values are
  unchanged; no response key is added.

### C2 Diagnostic wording (shared builder)

- No summary claims full coverage, says the scope is fine, or asks to widen the address-book scope to everyone.
  Every `nextAction` states that only the sampled reads were verified — not the full visible scope, every
  member's detail, or scan sign-in.
- The shared `healthy` title names only the sampled department and member list reads (the manual run reads no
  detail). The probe, having read one detail on a healthy diagnosis, titles it as list reads plus one member
  detail.
- The equal-counts warning (access-limited sample equal to the ordinary one) keeps its trigger but no longer
  concludes that access-limited filtering is ruled out; it now says the comparison alone does not explain the
  low count.
- Because the builder is shared, the wording change also reaches the manual run's stored diagnostic text and
  the run-history display. In the goldens this is text only: `manual-apply.json` changes exactly its
  `diagnosticTitle` and `diagnosticNextAction` values — no call, business data, grant, identity or write
  changes.

### C3 Login configuration check (directory page)

- The probe button, its loading text and its results are named 登录配置检查 (login configuration check). A pass
  reads "配置检查通过，尚未验证实际扫码、身份关联及账号授权。"; missing variables, a refused enterprise allowlist,
  an unknown reason and a failed request each have their own fixed sentence.
- The page still sends no request on open; the existing button triggers the check. The backend probe
  (`GET /api/auth/dingtalk/launch?probe=1`, `getDingTalkRuntimeStatus`) is unchanged: no provider or database
  call is added and the login gate semantics stay as they are.
- A connection test answering 200 no longer reports a blanket pass in the status bar: a `healthy` diagnosis
  names the sampled reads only, any other diagnosis (or a response without a summary) asks to read the
  diagnosis, and a failed test clears the previous result instead of leaving it on screen.

### C4 Callback refusal codes (`POST /api/auth/dingtalk/callback`)

- A `DingTalkLoginPolicyError` refusal answers `{ success: false, error, code }` with its existing stable code at
  its unchanged HTTP status. Activation-intent errors keep their code as before. Upstream (502), local (500),
  state (400), missing-code (400) and not-configured (503) failures still answer without a code; the nested
  recovery-conflict answer is unchanged. No refusal creates a session or a token.
- The three unlinked-account refusal messages no longer contain the email from the scanned profile. The
  container sign-in route forwards the same messages, so its response text changes the same way.
- The set of top-level codes the callback can answer is pinned as a literal set, derived from the sources:
  `ACCOUNT_ACTIVATION_INVALID`, `ACCOUNT_PENDING_ACTIVATION`, `activate_admin_required`,
  `activate_commit_incomplete`, `activate_failed`, `activate_source_ineligible`, `activate_state_invalid`,
  `activate_target_not_found`, `authentication_changed`, `auto_provision_alias_conflict`,
  `auto_provision_corp_required`, `auto_provision_email_conflict`, `bind_user_mismatch`,
  `directory_managed_conflict`, `directory_managed_identity`, `grant_disabled`, `grant_required`,
  `grant_state_unavailable`, `identity_already_bound`, `identity_ambiguous`, `identity_mismatch`,
  `local_user_disabled`, `repair_identity_mismatch`, `unlinked_enabled_local_user`, `unlinked_local_user`.
  `identity_key_unavailable` is excluded (container sign-in only).

### C5 Callback page guidance (`DingTalkAuthCallbackView.vue`)

- The page never shows the server's `error` text or an exception message. A failed response shows a fixed
  Chinese or English sentence chosen only by its top-level `code`, looked up as an own property of a fixed
  table whose keys equal the C4 set. The table distinguishes: not linked; the linked account cannot sign in
  (disabled / deleted, pending activation, invalid activation status); not authorized; authorization turned
  off; identity conflicts (already bound elsewhere, ambiguous, mismatch, repair mismatch, directory-managed,
  bind-session mismatch, auto-provision conflicts); cannot be verified right now; and the activation codes.
- Unknown or differently-cased codes, a missing code (older backend), non-string codes, prototype keys
  (`toString`, `constructor`, …), non-object bodies, unreadable JSON, network failures and exceptions after a
  successful response all show one fixed fallback. Failure responses carry no mode, so the fallback covers
  sign-in and binding alike. The nested `RECOVERY_AUTHORITY_BUSY` answer shows the fixed "cannot be verified
  right now, try again later" sentence.
- Failures set no token, prime no session and do not navigate. The page makes one request and never retries an
  authorization code, never shows another account's identity, and never repairs anything by email. Successful
  sign-in, binding and activation handling is unchanged.

## CI wiring

- `apps/web/tests/dingtalk-auth-callback.spec.ts` (previously run by no CI entry) is registered in the required
  web runner's exec block (`dingtalk-auth-callback`, at its case-insensitive position; the regenerated token
  manifest gains exactly that line) and in `.github/workflows/attendance-web-guard.yml`: push paths and PR
  classifier for the callback page, the guidance module and the spec, plus the targeted run token. The existing
  directory and login registrations are kept. `apps/web/tests/attendance-web-guard-workflow.spec.ts` pins the
  three registration points.
- The offline CI execution ledger (`scripts/ops/ci-execution-ledger.mjs`, `FROZEN_SHA`) is not changed; it is not
  wired into any workflow.

## Acceptance gates

| Gate | Evidence |
| --- | --- |
| G1 | Successful list reads plus a rejected detail read fail the probe (adapter test, and route-level tests through the real probe, client and transport with a stubbed provider); exactly one logical detail read of an ordinary sample (child first, ordinary root fallback, never the access-limited sample); no ordinary sample → no detail read, warning, `member_detail_unverified`; detail values absent from response and logs. |
| G2 | Shared wording never claims full coverage or asks to widen the scope; every next action names the sampled scope; connection-test golden gains exactly the detail call and the new wording; manual-apply golden changes only its two diagnostic text values. |
| G3 | Directory page: configuration-check label, loading and disabled state, pass / missing / allowlist / unknown / failed results, no request on open, no other login request; the connection-test status bar never says a blanket pass and a failed test clears the previous result. |
| G4 | Callback route: each policy code survives at its status (403 / 409 / 503) with no session or token; non-policy failures carry no code; the code set is pinned and mirrored by the page's table keys. Unlinked refusals carry no scanned-profile value. |
| G5 | Mounted callback tests: Chinese and English guidance for the main codes, every listed code distinct from the fallback, fallback for unknown / missing / odd-shaped / prototype codes, older responses, raw text with personal values, network errors and invalid JSON; no token, session or navigation on failure; success and binding unchanged. |
| G6 | Mutations (detail read removed, policy code dropped from the callback, raw error text shown again, `member_detail_unverified` reverted to `healthy`, detail sample taken from the access-limited list) each turn a test red. |
| G7 | The callback spec runs in the required web lane and the attendance web guard; the shape and manifest guards stay green. Draft only; no staging operation. |

## Out of scope

- The user-management page's "服务端钉钉登录可用" server-status line (`UserManagementView.vue`) keeps its wording;
  it reads the same runtime status and is a candidate for a follow-up.
- The real directory's visible scope, which DingTalk errcode a missing member-detail permission returns, and
  whether a real scan identity can sign in.
- The anonymous probe response's fields, the server-side log lines, and the formal sync's handling of detail
  failures.
