# Data Factory issue #1542 postdeploy smoke - verification - 2026-05-15

## Commands

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
pnpm verify:integration-k3wise:poc
git diff --check
```

## Results

```text
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
20 tests passed
```

New coverage:

- `issue1542 workbench smoke verifies staging schema and draft pipeline save`
- `issue1542 workbench smoke fails when staging schema is empty`
- `issue1542 workbench smoke fails clearly when pipeline save still hits JSONB 22P02`

```text
pnpm verify:integration-k3wise:poc
PASS
```

Included sub-results:

- preflight tests: 21 passed
- evidence tests: 50 passed
- fixture contract tests: 2 passed
- mock K3 WebAPI tests: 4 passed
- mock SQL Server executor tests: 12 passed
- mock PoC chain: PASS

```text
git diff --check
0 whitespace/conflict-marker findings
```

## Assertions

### Opt-in behavior

Default postdeploy smoke behavior is unchanged. The new #1542 checks only run
when `--issue1542-workbench-smoke` is supplied.

### Staging schema regression

The smoke fails if the deployed staging source returns `fields: []` for
`standard_materials`. The failure check records:

- object name;
- returned field count;
- required fields;
- missing fields.

### Pipeline JSONB regression

The smoke fails clearly if pipeline save still returns HTTP 500 with PostgreSQL
`22P02`. This catches the deployed-box symptom reported in #1542 before an
operator attempts a UI dry-run.

### Secret handling

The existing postdeploy smoke token leak assertions continue to pass:

- token value is not present in stdout;
- token value is not present in stderr;
- token value is not present in generated JSON evidence.

The new #1542 smoke does not add credentials or connection strings to evidence.

## Deployment retest command

After installing a package that contains this change:

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "$METASHEET_BASE_URL" \
  --token-file "$METASHEET_AUTH_TOKEN_FILE" \
  --tenant-id "$METASHEET_TENANT_ID" \
  --require-auth \
  --issue1542-workbench-smoke \
  --out-dir artifacts/integration-k3wise/internal-trial/postdeploy-smoke-issue1542
```

Expected additional passing checks:

- `issue1542-system-readiness`
- `issue1542-staging-source-schema`
- `issue1542-k3-material-schema`
- `issue1542-pipeline-save`

## Remaining risk

`SQLSERVER_EXECUTOR_MISSING` is still outside this slice. The smoke makes that
separation explicit: staging-to-K3 metadata readiness can pass while direct SQL
Server source execution remains blocked until a real executor is deployed and
wired.
