Scope: Day 3 rerun checklist for the Feishu-style multitable internal pilot  
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable`

# Day 3 Rerun Checklist

Goal: rerun the weakest Day 2 scenarios after the Day 3 backend fixes, then validate real-time collaboration in the browser.

Use this together with:
- `/Users/huazhou/Downloads/Github/metasheet2-multitable/docs/deployment/multitable-pilot-team-checklist-20260319.md`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable/docs/deployment/multitable-pilot-feedback-template-20260319.md`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable/docs/deployment/multitable-pilot-daily-triage-template-20260319.md`

## 1. Deploy the latest backend fixes first

Do not rerun Day 3 scenarios against an older pilot package.

Required backend commits:
- `091be9f9d` `fix(pilot): unblock day4 backend blockers`
- `f89802840` `fix(comments): complete pilot comment lifecycle`

Expected fixes included:
- attachment upload runtime no longer fails on optional `multer` loading
- spreadsheet cell writes now reject stale writes with `409 VERSION_CONFLICT`
- snapshot restore can restore `sheet` and `cell`
- comments now support `PATCH` and `DELETE`
- `comments:read` and `comments:write` are seeded for `admin` and `user`

After updating the backend:
1. deploy the new build/package
2. run database migration
3. restart backend
4. verify `/health` and the multitable route are reachable

Suggested local command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable
pnpm --filter @metasheet/core-backend migrate
```

## 2. Rerun Scenario 2 first: attachments / comments / permissions

This is the first Day 3 priority. Do not start WebSocket validation before this passes.

### 2.1 Attachment rerun

Use a normal pilot record with an attachment field.

Checklist:
1. Open grid view.
2. Open record drawer.
3. Upload one small file.
4. Save or patch the record.
5. Refresh the page.
6. Confirm the attachment still renders in:
   - grid
   - drawer
   - form mode
7. Search using record title and attachment filename.

Expected result:
- no `multer not installed` error
- uploaded file is hydrated back as filename/link, not raw id

### 2.2 Comment CRUD rerun

Use the same record if possible.

Checklist:
1. Create a top-level comment.
2. Reply to it if the UI supports threaded reply.
3. Edit the comment.
4. Resolve the comment.
5. Delete the comment.
6. Refresh the page.
7. Confirm list state matches the final action.

Expected result:
- create works
- update works
- resolve works
- delete works
- no stale comment remains after refresh

### 2.3 Normal user permission rerun

Repeat the same attachment/comment checks with a non-admin user.

Checklist:
1. Login as a normal user.
2. Open the same multitable route.
3. Add a comment.
4. Edit or resolve a comment if policy allows.
5. Upload an attachment.
6. Save a record update.

Expected result:
- normal user can read comments
- normal user can write comments
- normal user can upload attachments through the multitable flow

If this fails, record:
- exact role
- exact token/user used
- endpoint that returned `403`
- whether migration was already applied

## 3. Rerun conflict handling

This validates the new spreadsheet optimistic lock behavior.

Checklist:
1. Open the same sheet in two browser tabs.
2. Edit the same cell in tab A and save.
3. Without refreshing tab B, edit the same cell and save.
4. Capture the result.

Expected result:
- one write succeeds
- stale write is rejected
- backend returns conflict instead of silently overwriting

Record:
- whether the UI surfaces the conflict clearly
- whether retry after refresh works

## 4. Validate WebSocket real-time collaboration in two tabs

This is the Day 3 browser-only validation item.

Checklist:
1. Open the same multitable grid in two tabs using the same environment.
2. Join the same sheet in both tabs.
3. In tab A:
   - edit a visible cell
   - add a comment if comment updates are live
4. Watch tab B without refreshing.
5. Repeat once in the reverse direction.

Expected result:
- cell update appears in the other tab without manual refresh
- no disconnect loop
- no duplicate update

Record separately:
- cell live sync works / does not work
- comment live sync works / does not work

## 5. Record results in the pilot templates

After rerun, update:
- daily triage doc
- pilot feedback doc
- any new P1/P2 issues

Use the triage categories:
- `attachment`
- `comments`
- `permissions`
- `conflict`
- `collaboration`

## 6. Day 3 exit criteria

Day 3 is considered successful if:
- Scenario 2 rerun is no longer blocked by `multer`
- comment lifecycle is complete enough for pilot use
- normal users can comment
- two-tab collaboration has a clear observed result
- all remaining failures are documented with exact reproduction and severity
