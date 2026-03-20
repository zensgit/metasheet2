# Multitable Pilot Team Checklist

Date: 2026-03-19  
Scope: Internal pilot execution checklist  
Repo root: `<REPO_ROOT>`

## Team A: Intake / Data Entry

Goal: validate `form + attachment + comments`.

### Day 1

1. Open the pilot form URL provided by the pilot owner.
2. Update one existing record.
3. Upload one small attachment.
4. Wait for `Uploading...` to disappear.
5. Click `Save`.
6. Add one comment and resolve it.
7. Confirm the record can be found again from grid by title or attachment name.

### Day 2-3

1. Use the form for real daily intake on at least 10 records.
2. Note every place where users hesitate or ask “what do I click next?”.
3. Record attachment failures separately from save failures.

### Day 4-5

1. Re-run the same flow with another user.
2. Validate comment collaboration on the same record.
3. Force at least one edit conflict and verify retry/reload is understandable.

## Team B: Management / Coordination

Goal: validate `import + grid + search + person assignment + conflict recovery`.

### Day 1

1. Open the pilot grid URL provided by the pilot owner.
2. Import a small CSV or TSV sample.
3. Search for one imported record by title.
4. Open the drawer and assign one person.
5. Search again and confirm the person still appears.

### Day 2-3

1. Use grid for real review/update work on at least 50 rows.
2. Search by title, owner, and attachment-related text where relevant.
3. Confirm pagination and page changes remain understandable.

### Day 4-5

1. Import one larger real sample.
2. Reproduce one stale-version conflict from two sessions.
3. Verify the retry path preserves the intended latest value.

## Reporting Rules

Use one of these for every issue or hesitation:

- `docs/deployment/multitable-pilot-feedback-template-20260319.md`
- `.github/ISSUE_TEMPLATE/multitable-pilot-feedback.yml`

Severity guide:

- `P0`: cannot continue pilot
- `P1`: severe confusion or repeated failure
- `P2`: workaround exists, but experience is poor
- `P3`: polish or copy issue
