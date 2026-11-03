# Admin console issue 1 — reset-password inline rule

- Date: 2026-10-14
- Slice: design-lock item 1 only (`docs/development/admin-console-issues-1-5-design-lock-20261014.md`). Items 4/5 and the field picker are out of this slice.
- Worktree tip when written: `7f103b5333f0` on `codex/admin-issues-permission-correctness-20261014`. Prompt baseline `d45ddff741` is an ancestor; later access-read and field-picker commits were left in place.
- Contract: neutral synthetic. Customer document and customer data were not read. This note contains no password value.
- Runtime: UI only. No install, build, vitest, browser, SSH, network, commit, publish, flag, API, or workflow change.

## Cause

`POST /api/admin/users/:userId/reset-password` (`packages/core-backend/src/routes/admin-users.ts` 5197–5250) trims a string `password`, treats empty as generate, and returns 400 `PASSWORD_TOO_SHORT` when the trimmed length is under 8. That handler has no other complexity rule. A successful reset still revokes the user's sessions in the same handler.

The account-section input posted on 重置密码. Failures used the page-top status banner. Nothing next to the input stated the rule, and a 1–7 character value was sent and then reported with the server's English sentence away from the field.

## Change

Account section and `resetPassword` only. `selectUser` also clears the new inline error when it already clears the field.

- Hint directly under the input: at least 8 characters; leaving it blank asks the server to generate.
- Trimmed length 1–7 shows a Chinese inline error and does not POST. The reset button stays enabled.
- Trimmed length 8 or more POSTs that trimmed value. No extra character-class check was added.
- Blank or whitespace still omits `password`, so the server generates and revokes sessions as before.
- Code `PASSWORD_TOO_SHORT` uses the same Chinese inline sentence. The English server sentence is not shown.
- Any other reset failure still uses the page error banner and the server message.
- Success clears the inline error, leaves the hint, clears the field, and still says 密码已重置.
- A response that arrives after another account is selected is not written onto that account.
- 停用账号 and 全部下线 are unchanged.

No backend, policy, flag, or route change.

## Tests

Added inside the existing mounted `apps/web/tests/userManagementView.spec.ts`. They use that file's synthetic users. Reset calls are recorded as user id and length only. The helper is not imported, so the assertions are the visible copy and the POST.

- Trimmed length 1 and 7, including surrounding spaces: no POST, Chinese inline error, rule visible.
- Trimmed length 8 with no other character classes: POST to the selected user; success clears the error and keeps the hint.
- Blank and whitespace: POST with the password field omitted.
- Server 400 `PASSWORD_TOO_SHORT` is the Chinese inline sentence. A different 400 and `PASSWORD_RESET_FAILED` stay on the page error banner.
- Switching accounts drops the inline error. The next account's blank reset posts to that account.
- A late short-password response does not paint the account selected afterward.
- After a short value is refused, 全部下线 still posts revoke-sessions for the current account.

## NOT RUN (parent Mac)

- `pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts --watch=false`
- Browser, synthetic admin only: rule visible under the temporary-password input; 1–7 characters blocked with the Chinese sentence and no request; 8 characters and blank submit; a forced `PASSWORD_TOO_SHORT` 400 is Chinese beside the input; another reset failure stays the page error; success clears the error and leaves the hint; switching accounts does not carry the error.
- Install, build, type-check, lint, commit, publish.

## Changed paths

- `apps/web/src/views/adminTemporaryPasswordFeedback.ts`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `docs/development/admin-console-issue-1-password-feedback-development-verification-20261014.md`

## Parent final local qualification

Frozen code `b611120d40e11ec48ebfbdee8805afd665a6115b` matched Mac full tree/digests. Six focused/neighbor frontend files163passed/0failed/0skipped. Full `pnpm validate:all` passed. Independent Sol medium source review passed at this SHA (`artifacts/admin-issues-20261014/sol-password-feedback-review.md`).

Native Chromium loaded the actual product route with real synthetic administrator login and the fully442-migrated backend: visible minimum8 hint; trimmed7-character input prevented the client POST; direct server7-character request returned400/PASSWORD_TOO_SHORT;8 lowercase characters reset successfully and authenticated; old target token returned401; blank/whitespace omitted the field, generated a password and authenticated successfully. A controlled server policy400 displayed Chinese inline text. Password values were not recorded in the receipt; screenshot input/output credentials were masked.

Minimum-length and error-code discriminator mutations each made their matching mounted tests fail, then original source bytes were restored. Owned web/backend stopped; all445 table counts/content hashes restored to the four-user/zero-session baseline. Item1 LOCAL PASS, not staging/customer/deployment acceptance. Public PR/CI remains owner-gated. PR material `artifacts/admin-issues-20261014/password-feedback-pr-body.md`.
