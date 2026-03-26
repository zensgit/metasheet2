# Multitable Internal Pilot Quickstart

Date: 2026-03-19  
Audience: Pilot users, not platform engineers  
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable`

## Before You Start

Ask the pilot owner for two direct links:

- Grid link:

```text
/multitable/<sheetId>/<viewId>?baseId=<baseId>
```

- Form link:

```text
/multitable/<sheetId>/<viewId>?baseId=<baseId>&mode=form&recordId=<recordId>
```

You do not need to understand internal IDs. The pilot owner should give you working links directly.

## Management Flow

Use this path for table owners or coordinators.

1. Open the grid link.
2. Import a small CSV or TSV sample first.
3. If import reports a people mismatch or ambiguity, use `Select person` in the result panel instead of going back to the CSV immediately.
4. Use search to find one imported row.
5. Open the row drawer.
6. Assign one person in the owner/person field.
7. Save or confirm the change if prompted.
8. Search again by title and confirm the assigned person still shows up.

## Intake Flow

Use this path for frontline users entering or updating records.

1. Open the form link.
2. Upload a small file to the attachment field.
3. Wait for `Uploading...` to disappear.
4. Click `Save`.
5. Open comments using the comments button.
6. Send one comment.
7. Resolve that comment.
8. Go back to grid and search by the record title or attachment name.

Important:

- Upload complete is not the same as save complete.
- After upload finishes, you still need to click `Save`.
- If person import can be repaired directly in the result panel, prefer that path before editing the source file.

## Conflict Retry

If you see a conflict or stale-version warning:

1. Do not close the page immediately.
2. Use the retry or refresh action shown by the UI.
3. Confirm your latest value is still visible after retry.
4. Record the exact message in pilot feedback if the next step was unclear.

## What To Report

Report anything that made you hesitate, including:

- You did not know which button to click next.
- You could not tell whether upload was already saved.
- Search results did not match your expectation.
- Person names or comment authors were hard to identify.
- Conflict recovery steps were unclear.

Use one of these:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable/docs/deployment/multitable-pilot-feedback-template-20260319.md`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable/.github/ISSUE_TEMPLATE/multitable-pilot-feedback.yml`
