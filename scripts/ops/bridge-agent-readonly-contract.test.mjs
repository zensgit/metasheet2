import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const scriptPath = new URL('./bridge-agent-readonly.ps1', import.meta.url);
const configPath = new URL('./fixtures/bridge-agent-readonly/config.example.json', import.meta.url);

async function readScript() {
  return readFile(scriptPath, 'utf8');
}

async function readConfig() {
  return JSON.parse(await readFile(configPath, 'utf8'));
}

test('readonly bridge exposes the BA-M1 HTTP contract only on localhost', async () => {
  const script = await readScript();

  for (const marker of [
    'GET  /health',
    'GET  /objects',
    'GET  /schema/<object>',
    'POST /query/<object>',
    'BA-M1 MVP only supports localhost binding',
    '127.0.0.1',
    'System.Data.SqlClient.SqlConnection',
  ]) {
    assert.match(script, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(script, /start\s+https?:\/\/0\.0\.0\.0/i);
});

test('readonly bridge rejects unsafe query surfaces by code', async () => {
  const script = await readScript();

  for (const marker of [
    'UNKNOWN_OBJECT',
    'INVALID_LIMIT',
    'INVALID_FILTERS',
    'RAW_SQL_REJECTED',
    'Raw SQL is not accepted by the readonly Bridge Agent.',
    'SELECT TOP $Limit',
    'ConvertTo-QuotedIdentifier',
    'database.connectTimeoutSec must be between 1 and 120',
    'database.queryTimeoutSec must be between 1 and 300',
  ]) {
    assert.match(script, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

// This is its own test (not folded into the marker checks above) so that it
// still runs, and still fails a PR, even when one of the marker assertions
// above throws first -- as happened when #2311 (2026-06-05) renamed the
// filter-rejection marker from UNSUPPORTED_FILTERS to INVALID_FILTERS and
// left this file unupdated: the marker `assert.match` threw before the write
// verb check below it ever ran.
test('readonly bridge script contains no SQL/ADO write or extra execute verbs', async () => {
  const script = await readScript();

  // Matched as whole words, case-insensitively, across the *entire* script
  // text -- including PowerShell comments (`#...`) and embedded SQL string
  // literals. Comments are not exempt: a stale comment naming a write verb
  // (for example, copy-pasted from a T-SQL snippet while drafting a query)
  // is exactly the kind of drift this test exists to catch, and comments are
  // trivially uncommented by later edits. If the script ever needs to name
  // one of these words legitimately -- for example inside a human-facing
  // refusal message that enumerates the forbidden verbs -- that occurrence
  // must be carved out narrowly (e.g. asserted at its own literal/line)
  // rather than by removing or loosening an entry below. No such occurrence
  // exists in the script today.
  //
  // Beyond the core DML/DDL verb set, this also forbids: bulk-copy write
  // paths (SqlBulkCopy / WriteToServer -- an ADO.NET bulk insert that never
  // spells INSERT); `SELECT ... INTO` (creates and populates a table without
  // any of the other listed verbs); legacy text-write statements (WRITETEXT
  // / UPDATETEXT); administrative writes reachable from a query connection
  // (RESTORE / BACKUP / DENY / DISABLE, e.g. `DISABLE TRIGGER ...`); and
  // `sp_rename` (a system stored procedure call, which a whole-word check on
  // RENAME/EXEC alone would miss because `_` is a word character and glues
  // `sp_` onto the procedure name, leaving no `\b` boundary before it).
  // `StoredProcedure` is forbidden here too, as a belt to the CommandType
  // pin below.
  const forbiddenVerbs = [
    'INSERT',
    'UPDATE',
    'DELETE',
    'MERGE',
    'DROP',
    'ALTER',
    'CREATE',
    'TRUNCATE',
    'GRANT',
    'REVOKE',
    'EXEC',
    'EXECUTE',
    'sp_executesql',
    'sp_rename',
    'ExecuteNonQuery',
    'ExecuteScalar',
    'SqlBulkCopy',
    'WriteToServer',
    'StoredProcedure',
    'INTO',
    'RESTORE',
    'BACKUP',
    'DENY',
    'DISABLE',
    'WRITETEXT',
    'UPDATETEXT',
  ];

  for (const verb of forbiddenVerbs) {
    assert.doesNotMatch(
      script,
      new RegExp(`\\b${verb}\\b`, 'i'),
      `bridge-agent-readonly.ps1 must not contain the write/execute verb "${verb}"`,
    );
  }

  // ExecuteReader is the only ADO.NET command-execution call the read path
  // may use. Matching the generic `Execute<Word>` shape (rather than
  // enumerating known ADO.NET method names) also catches variants such as
  // ExecuteXmlReader or ExecuteDataSet that are not individually named above.
  const executeCalls = [...script.matchAll(/\bExecute[A-Za-z]+\b/g)].map((match) => match[0]);
  assert.ok(executeCalls.length > 0, 'expected at least one Execute* call in the script');
  assert.deepEqual(
    executeCalls,
    executeCalls.map(() => 'ExecuteReader'),
    `expected every command execution to be ExecuteReader, found: ${JSON.stringify(executeCalls)}`,
  );
});

// The two checks above catch write *verbs* appearing anywhere in the script,
// but a stored-procedure call spelled as a bare object name (for example
// `dbo.usp_InsertStockIssue`) contains none of those verbs as whole words --
// `usp_Insert...` has no `\b` boundary before `Insert` because `_` is a word
// character. That shape is instead ruled out structurally here: the whole
// script may only ever set `CommandText` once, to the `$Sql` variable built
// by New-ObjectQuerySql, and `CommandType` once, to `::Text`. Any stored
// procedure call (whether via `CommandType.StoredProcedure` or via a bare
// `usp_...`/`sp_...` literal assigned to CommandText) changes one of those
// two assignments and is caught here, independent of what verb list is kept
// in sync above.
test('readonly bridge sets SQL command text and type through one pinned assignment', async () => {
  const script = await readScript();

  const commandTextAssignments = [...script.matchAll(/\.CommandText\s*=[^\r\n]*/g)].map((match) =>
    match[0].trim(),
  );
  assert.deepEqual(
    commandTextAssignments,
    ['.CommandText = $Sql'],
    `expected exactly one CommandText assignment, set to the $Sql variable built by ` +
      `New-ObjectQuerySql, found: ${JSON.stringify(commandTextAssignments)}`,
  );

  const commandTypeAssignments = [...script.matchAll(/\.CommandType\s*=[^\r\n]*/g)].map((match) =>
    match[0].trim(),
  );
  assert.deepEqual(
    commandTypeAssignments,
    ['.CommandType = [System.Data.CommandType]::Text'],
    `expected exactly one CommandType assignment, set to ::Text, found: ${JSON.stringify(commandTypeAssignments)}`,
  );
});

// Round-2 verifier finding: a whole-word verb ban (the test above) and a
// count-of-assignments ban (the test above that) both only recognise a
// *spelling* -- they never pin what SQL text actually reaches the database.
// A bare stored-procedure name (e.g. `dbo.usp_InsertStockIssue`) contains no
// forbidden verb as a whole word, and T-SQL admin statements (DBCC, SHUTDOWN,
// KILL, sp_configure, sp_addrolemember, xp_cmdshell, ENABLE TRIGGER) are not
// on -- and can never fully enumerate -- the forbidden-verb list. Closing
// this structurally: the script has exactly one function that ever runs SQL
// (Invoke-BridgeSqlQuery), it is only ever called from two literal call
// sites, and the one SQL string it builds itself has exactly one literal
// shape. Any mutation to the health-check literal, to the query-builder
// text, or to how either reaches -Sql (a renamed variable, a different
// request property, an inline batch) changes one of the pinned literals
// below and fails this test, regardless of which word it now contains.
test('readonly bridge executes SQL only through two pinned call sites, each with a pinned SQL shape', async () => {
  const script = await readScript();

  const invokeBridgeSqlQueryLines = script
    .split(/\r\n|\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('Invoke-BridgeSqlQuery'));
  assert.deepEqual(
    invokeBridgeSqlQueryLines,
    [
      'function Invoke-BridgeSqlQuery {',
      "[void](Invoke-BridgeSqlQuery -Config $Config -Sql 'SELECT 1 AS ok')",
      '$rows = Invoke-BridgeSqlQuery -Config $Config -Sql $querySpec.Sql -Parameters $querySpec.Parameters',
    ],
    `expected exactly one function definition and two call sites, with the health check passing the literal ` +
      `'SELECT 1 AS ok' and the query route passing $querySpec.Sql unchanged, found: ${JSON.stringify(invokeBridgeSqlQueryLines)}`,
  );

  const sqlAssignments = [...script.matchAll(/\$sql\s*=[^\r\n]*/g)].map((match) => match[0].trim());
  assert.deepEqual(
    sqlAssignments,
    ['$sql = "SELECT TOP $Limit $columns FROM $source"'],
    `expected exactly one $sql assignment, built only from the quoted identifier/source helpers, found: ${JSON.stringify(sqlAssignments)}`,
  );

  const sqlAppends = [...script.matchAll(/\$sql\s*\+=[^\r\n]*/g)].map((match) => match[0].trim());
  assert.deepEqual(
    sqlAppends,
    ["$sql += \" WHERE \" + ($whereClauses -join ' AND ')"],
    `expected exactly one $sql append, built only from the parameterized WHERE clause list, found: ${JSON.stringify(sqlAppends)}`,
  );
});

// Round-2 verifier finding: the CommandText/CommandType pin above only
// watches the one SqlCommand object created via $connection.CreateCommand().
// A stored-procedure (or any other write) reaches the database just as well
// through a *second* command object that never touches that pin: a direct
// `New-Object ... SqlCommand(...)` / `[SqlCommand]::new(...)` /
// `New-Object ... SqlCommand -Property @{ CommandText = ... }` constructor,
// a SqlDataAdapter/SqlCommandBuilder pair (`.Fill()`, `.Update()`,
// `.GetInsertCommand()`), or shelling out to `Invoke-Sqlcmd`/`sqlcmd.exe`.
// None of those names is a "write verb" in the SQL sense, so the whole-word
// verb test above cannot see them either. These are matched as plain
// substrings, not whole words: `SqlCommandBuilder` and `SqlDataAdapter` are
// their own identifiers with no `\b` boundary a `\bSqlCommand\b`-style check
// could rely on, and `sqlcmd`/`Invoke-Sqlcmd`/`sqlcmd.exe` are not variants
// of any word in the forbidden-verb list at all.
test('readonly bridge names no alternate SqlCommand/adapter/sqlcmd execution surface', async () => {
  const script = await readScript();

  for (const surface of ['SqlCommand', 'SqlDataAdapter', 'sqlcmd']) {
    assert.doesNotMatch(
      script,
      new RegExp(surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      `bridge-agent-readonly.ps1 must not reference "${surface}" (a second way to build/run a SQL command)`,
    );
  }

  const createCommandCalls = [...script.matchAll(/\bCreateCommand\s*\(/g)];
  assert.equal(
    createCommandCalls.length,
    1,
    `expected exactly one CreateCommand() call (one command, from one connection), found ${createCommandCalls.length}`,
  );
});

test('example config is localhost-only, credential-by-env, and object-allowlisted', async () => {
  const config = await readConfig();

  assert.equal(config.listen.host, '127.0.0.1');
  assert.equal(config.listen.port, 19091);
  assert.equal(config.auth.mode, 'shared-secret-header');
  assert.equal(config.auth.headerName, 'X-MetaSheet-Bridge-Secret');
  assert.equal(config.auth.sharedSecretEnvVar, 'METASHEET_BRIDGE_SHARED_SECRET');
  assert.equal(config.database.usernameEnvVar, 'METASHEET_BRIDGE_SQL_USERNAME');
  assert.equal(config.database.passwordEnvVar, 'METASHEET_BRIDGE_SQL_PASSWORD');
  assert.equal(config.limits.sampleLimit, 3);
  assert.equal(config.limits.maxLimit, 20);

  assert.deepEqual(Object.keys(config.objects).sort(), ['bom', 'bom_child', 'material']);
  assert.equal(config.objects.material.source, 'v_MetaSheet_MaterialRead');
  assert.equal(config.objects.bom.source, 'v_MetaSheet_BomRead');
  assert.equal(config.objects.bom_child.source, 'v_MetaSheet_BomChildRead');

  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /password["']?\s*:\s*["'](?!<configured)/i);
  const connectionStringPattern = new RegExp('Server=.*' + 'Pass' + 'word=', 'i');
  assert.doesNotMatch(serialized, connectionStringPattern);
});

test('script redacts common credential-bearing error surfaces', async () => {
  const script = await readScript();

  for (const marker of [
    'ConvertTo-RedactedText',
    'ConvertTo-BridgeError',
    'InnerException',
    'data[$keyText]=<redacted>',
    'Login failed for user',
    'Bearer\\s+',
    'eyJ[A-Za-z0-9_-]',
  ]) {
    assert.match(script, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
