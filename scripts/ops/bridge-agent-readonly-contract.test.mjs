import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// What this file proves, and what it does not
// -------------------------------------------
//
// Layer 1, the change detector. The whole text of every Bridge Agent script
// that opens a database connection, builds SQL, or decides which script runs
// as SYSTEM at startup is pinned below by a sha256 digest. Any change to such
// a script -- new SQL text, another launched file, a comment edit, a
// whitespace change -- turns this file red until the pin is updated. That
// proves one thing: a pinned script cannot change without a visible re-pin
// in the same diff. Updating a pin is a review duty, not a formality: whoever
// updates it must first read the diff of the script for anything that can
// write or execute beyond the existing reads.
//
// Layer 1 also refuses, in the pinned scripts, the forms that load a second
// code file (dot-sourcing, Import-Module, using module, Invoke-Expression,
// Add-Type with anything other than an assembly name), because the digest
// covers only the bytes of the pinned file itself.
//
// Layer 2, the older word and line checks further down, is a readable check
// for common write forms in bridge-agent-readonly.ps1. It is kept because it
// still flags the obvious cases after a careless re-pin. It is not a proof
// that the script cannot write: a list of forbidden forms cannot be
// completed, and each of three verification rounds slipped a plain write
// past it.
//
// Neither layer proves that the Bridge Agent cannot write. The provable
// guarantee against external writes is the read-only database account the
// agent connects with.

// Test-only override, used by mutation harnesses to point these tests at a
// changed COPY of a pinned script instead of editing the tracked file. It
// takes effect only when this flag equals the exact literal 'true' AND the
// per-script path variable is set. Two tests keep it honest: one proves that
// the path variables are ignored without the exact flag, and one fails
// whenever a redirect is in effect, so a run that uses the override is never
// all green and certifies nothing.
const TEST_ONLY_OVERRIDE_FLAG = 'BRIDGE_AGENT_CONTRACT_TEST_ONLY_OVERRIDE';

// Every Bridge Agent script in scripts/ops that opens a database connection,
// builds SQL, or decides which script runs as SYSTEM at startup. `sha256` is
// the digest of the file after CRLF is normalized to LF (see lfNormalized
// below).
const PINNED_SCRIPTS = Object.freeze({
  readonly: Object.freeze({
    // Opens a SqlClient connection; runs the /health probe and the /query SELECT.
    file: 'bridge-agent-readonly.ps1',
    sha256: '7e656b54af23fd16981356828d8eb15c0be03f9c40f5110892ee801ab2713a91',
    overrideVar: 'BRIDGE_AGENT_CONTRACT_TEST_ONLY_READONLY_PS1',
  }),
  driverSmoke: Object.freeze({
    // Opens a SqlClient, Odbc or OleDb connection and runs SELECT @@VERSION.
    file: 'bridge-agent-driver-smoke.ps1',
    sha256: 'aab2ef409ddedf3a9b53f4d38cfa7ec87446af5247be4d738406983b6b5178f1',
    overrideVar: 'BRIDGE_AGENT_CONTRACT_TEST_ONLY_DRIVER_SMOKE_PS1',
  }),
  scheduledTask: Object.freeze({
    // Opens no database connection and builds no SQL, but registers the
    // Windows startup task that runs a script as SYSTEM. Without this pin, a
    // copy that launches another file while keeping the old file name in a
    // comment passed every other test here and in the task contract.
    file: 'bridge-agent-readonly-scheduled-task.ps1',
    sha256: '14c4c379f07ead60706b247518c2d58a16265de50cd68df77777a4d24af36fdc',
    overrideVar: 'BRIDGE_AGENT_CONTRACT_TEST_ONLY_SCHEDULED_TASK_PS1',
  }),
});

// Bridge Agent scripts in scripts/ops that are deliberately not pinned, each
// with the reason. Empty today: every bridge-agent*.ps1 is pinned above.
const UNPINNED_SCRIPTS = Object.freeze({});

// Scripts that must stay pinned whatever else changes, with the reason. The
// family test below fails if one of them is moved to UNPINNED_SCRIPTS.
const MUST_STAY_PINNED = Object.freeze({
  'bridge-agent-readonly-scheduled-task.ps1': 'decides which script runs as SYSTEM at startup',
});

const configPath = new URL('./fixtures/bridge-agent-readonly/config.example.json', import.meta.url);

function trackedScriptUrl(key) {
  return new URL(`./${PINNED_SCRIPTS[key].file}`, import.meta.url);
}

function resolveScriptUrl(key, env) {
  const overridePath = env[PINNED_SCRIPTS[key].overrideVar];
  if (env[TEST_ONLY_OVERRIDE_FLAG] === 'true' && typeof overridePath === 'string' && overridePath !== '') {
    return pathToFileURL(overridePath);
  }
  return trackedScriptUrl(key);
}

function scriptUnderTest(key) {
  return resolveScriptUrl(key, process.env);
}

// The digest is taken over the file's bytes with every CR that directly
// precedes an LF removed, and nothing else changed. A Windows checkout with
// core.autocrlf=true has CRLF while the committed blob and the CI checkout
// have LF; both give the same digest. A lone CR is kept.
//
// A UTF-8 byte-order mark is kept as well, so adding or removing one changes
// the digest. That is deliberate: Windows PowerShell 5.1 reads a script
// without a BOM in the system ANSI code page and a script with one as UTF-8,
// and bridge-agent-readonly.ps1 has non-ASCII string literals, so a BOM change
// changes what the script does and must be reviewed like any other edit.
function lfNormalized(bytes) {
  return Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

function lfNormalizedSha256(bytes) {
  return createHash('sha256').update(lfNormalized(bytes)).digest('hex');
}

async function readScript() {
  return readFile(scriptUnderTest('readonly'), 'utf8');
}

async function readConfig() {
  return JSON.parse(await readFile(configPath, 'utf8'));
}

// ---------------------------------------------------------------------------
// Layer 1: whole-file digest pins, and no second code file
// ---------------------------------------------------------------------------

for (const [key, spec] of Object.entries(PINNED_SCRIPTS)) {
  test(`digest pin: ${spec.file} is the reviewed version, byte for byte`, async () => {
    const actual = lfNormalizedSha256(await readFile(scriptUnderTest(key)));
    assert.equal(
      actual,
      spec.sha256,
      [
        `The Bridge Agent script ${spec.file} changed.`,
        `Its sha256 (CRLF normalized to LF) is ${actual}; the pin in ` +
          `scripts/ops/bridge-agent-readonly-contract.test.mjs is ${spec.sha256}.`,
        'Before you update the pin, read the diff of the script for anything that can write or execute ' +
          'beyond the existing reads: new SQL text, a new command or connection object, another SQL client ' +
          'or program, a second file loaded, a new process or network call.',
        'Only then update the pin, in the same PR as the script change, so that the reviewer sees both together.',
        'This pin only makes the change visible. The guarantee against writes is the read-only database account.',
      ].join('\n'),
    );
  });
}

test('digest normalization drops only a CR that directly precedes an LF, and keeps a byte-order mark', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  assert.deepEqual(
    lfNormalized(Buffer.concat([bom, Buffer.from('a\r\nb\rc\n\r\n', 'latin1')])),
    Buffer.concat([bom, Buffer.from('a\nb\rc\n\n', 'latin1')]),
  );
  assert.equal(
    lfNormalizedSha256(Buffer.from('x\r\ny\r\n', 'latin1')),
    lfNormalizedSha256(Buffer.from('x\ny\n', 'latin1')),
    'a CRLF checkout and an LF checkout of the same file must give the same digest',
  );
  assert.notEqual(
    lfNormalizedSha256(Buffer.concat([bom, Buffer.from('x\n', 'latin1')])),
    lfNormalizedSha256(Buffer.from('x\n', 'latin1')),
    'adding a byte-order mark must change the digest',
  );
});

test('test-only override: the script path variables are ignored unless the exact test-only flag is set', () => {
  const elsewhere = fileURLToPath(new URL('./not-a-bridge-agent-script.ps1', import.meta.url));
  for (const [key, spec] of Object.entries(PINNED_SCRIPTS)) {
    const tracked = trackedScriptUrl(key).href;
    assert.equal(resolveScriptUrl(key, {}).href, tracked);
    assert.equal(
      resolveScriptUrl(key, { [spec.overrideVar]: elsewhere }).href,
      tracked,
      `${spec.overrideVar} without ${TEST_ONLY_OVERRIDE_FLAG} must be ignored`,
    );
    for (const flag of ['', '1', 'yes', 'TRUE', 'True', ' true', 'true ']) {
      assert.equal(
        resolveScriptUrl(key, { [TEST_ONLY_OVERRIDE_FLAG]: flag, [spec.overrideVar]: elsewhere }).href,
        tracked,
        `${TEST_ONLY_OVERRIDE_FLAG}=${JSON.stringify(flag)} is not the exact literal 'true' and must be ignored`,
      );
    }
    assert.equal(
      resolveScriptUrl(key, { [TEST_ONLY_OVERRIDE_FLAG]: 'true' }).href,
      tracked,
      'the flag without a path must not redirect',
    );
    assert.equal(
      resolveScriptUrl(key, { [TEST_ONLY_OVERRIDE_FLAG]: 'true', [spec.overrideVar]: '' }).href,
      tracked,
      'the flag with an empty path must not redirect',
    );
    const otherSpecs = Object.entries(PINNED_SCRIPTS).filter(([otherKey]) => otherKey !== key);
    assert.ok(otherSpecs.length > 0);
    for (const [, otherSpec] of otherSpecs) {
      assert.equal(
        resolveScriptUrl(key, { [TEST_ONLY_OVERRIDE_FLAG]: 'true', [otherSpec.overrideVar]: elsewhere }).href,
        tracked,
        `${otherSpec.overrideVar} must not redirect ${spec.file}`,
      );
    }
    // Positive control, so that the checks above cannot pass vacuously.
    assert.equal(
      resolveScriptUrl(key, { [TEST_ONLY_OVERRIDE_FLAG]: 'true', [spec.overrideVar]: elsewhere }).href,
      pathToFileURL(elsewhere).href,
    );
  }
});

test('no test-only override is in effect (a run that redirects a pinned script never passes)', () => {
  for (const [key, spec] of Object.entries(PINNED_SCRIPTS)) {
    assert.equal(
      scriptUnderTest(key).href,
      trackedScriptUrl(key).href,
      `${spec.file} is redirected to another file by the test-only override; ` +
        'this run checks a copy, not the tracked script, and certifies nothing',
    );
  }
});

// Forms that make a pinned script load and run a second code file, which the
// digest above cannot see. Each count is 0 today. The dot-sourcing pattern
// was checked against the Windows PowerShell 5.1 parser: `. x`, `.$x`,
// `.'x'`, `."x"`, `.(x)` and `.{ }` all dot-source, while `.\x.ps1` (run a
// script in its own scope) and `$x.Name` do not. The pattern looks for them
// at the start of a line, after one of ; { ( | & =, after the keywords
// return, exit and throw (any letter case; not when the word ends a longer
// name, a variable or a member, as in Rethrow, $throw or $x.return), and
// after a param(...) block whose parentheses nest at most one level deep. It
// does not look anywhere else; the digest pin is what catches a form it
// misses.
// Add-Type is allowed only in the form `Add-Type -AssemblyName Some.Name`,
// which loads a framework assembly by name; a path, a literal path, source
// text or any other argument is refused.
const DOT_SOURCING =
  /(?:^|[;{(|&=]|(?<![\w$.-])(?:return|exit|throw)|param[ \t]*\((?:[^()]|\([^()]*\))*\))[ \t]*\.(?:[ \t]+\S|[$'"({])/im;
const SECOND_FILE_LOADERS = Object.freeze([
  ['dot-sourcing', DOT_SOURCING],
  ['Import-Module (or its alias ipmo)', /\b(?:Import-Module|ipmo)\b/i],
  ['#requires -Modules', /#requires\b[^\r\n]*[ \t]-Modules?\b/i],
  ['using module / using assembly', /\busing[ \t]+(?:module|assembly)\b/i],
  ['Invoke-Expression (or its alias iex)', /\b(?:Invoke-Expression|iex)\b/i],
]);
const ASSEMBLY_NAME_ONLY_ADD_TYPE = /^Add-Type[ \t]+-AssemblyName[ \t]+[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/i;

for (const [key, spec] of Object.entries(PINNED_SCRIPTS)) {
  test(`${spec.file} loads no second code file`, async () => {
    const script = await readFile(scriptUnderTest(key), 'utf8');

    for (const [form, pattern] of SECOND_FILE_LOADERS) {
      assert.doesNotMatch(
        script,
        pattern,
        `${spec.file} must not use ${form}: the digest pin covers only this file, not a file it loads`,
      );
    }

    const addTypeStatements = [...script.matchAll(/\bAdd-Type\b[^\r\n]*/gi)].map((match) => match[0].trim());
    for (const statement of addTypeStatements) {
      assert.match(
        statement,
        ASSEMBLY_NAME_ONLY_ADD_TYPE,
        `${spec.file} may use Add-Type only to load a framework assembly by name ` +
          `(Add-Type -AssemblyName System.Data), not a path or source text; found: ${statement}`,
      );
      assert.doesNotMatch(statement, /\.(?:dll|exe)$/i, `Add-Type must not name an assembly file: ${statement}`);
    }
  });
}

// Checked parse-only against the Windows PowerShell 5.1 parser: each positive
// snippet below is a dot-source, and each negative one is valid code that is
// not. The first four positives are the forms the earlier pattern missed;
// each goes red if its alternative is removed from DOT_SOURCING. `Return`
// holds the letter-case flag and the nested param(...) holds the one level of
// nesting. The last four negatives each go red if one character is removed
// from the keyword lookbehind.
test('the dot-sourcing pattern catches a dot-source after return, exit, throw and param()', () => {
  for (const snippet of [
    'return . $x',
    'exit . $x',
    'throw . $x',
    'param() . $x',
    'Return . $x',
    'param([string]$p = (Get-Location)) . $x',
  ]) {
    assert.match(snippet, DOT_SOURCING, `the dot-sourcing pattern must match ${JSON.stringify(snippet)}`);
  }
  for (const snippet of ['return .\\x.ps1', 'Rethrow .($x)', '$throw.($name)', '$x.return.($y)', 'Do-Throw .($x)']) {
    assert.doesNotMatch(snippet, DOT_SOURCING, `the dot-sourcing pattern must not match ${JSON.stringify(snippet)}`);
  }
});

test('every bridge-agent*.ps1 in scripts/ops is either pinned or listed as not pinned with a reason', async () => {
  const family = (await readdir(new URL('./', import.meta.url)))
    .filter((name) => /^bridge-agent.*\.ps[dm]?1$/i.test(name))
    .sort();
  const pinnedFiles = Object.values(PINNED_SCRIPTS).map((spec) => spec.file);
  assert.deepEqual(
    family,
    [...pinnedFiles, ...Object.keys(UNPINNED_SCRIPTS)].sort(),
    'A Bridge Agent script was added, renamed or removed. If it opens a database connection, builds SQL ' +
      'or decides what runs as SYSTEM, pin it in PINNED_SCRIPTS; otherwise list it in UNPINNED_SCRIPTS ' +
      'with the reason.',
  );
  for (const [file, reason] of Object.entries(MUST_STAY_PINNED)) {
    assert.ok(pinnedFiles.includes(file), `${file} must be pinned in PINNED_SCRIPTS: it ${reason}`);
  }
});

// ---------------------------------------------------------------------------
// Layer 2: readable checks for common write forms in bridge-agent-readonly.ps1
// ---------------------------------------------------------------------------

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
//
// Catches: every word listed below, in any letter case, as a whole word,
// anywhere in the file -- comments and string literals included, so also
// inside here-strings; and any Execute* method name other than ExecuteReader.
// Does not catch: a word split by concatenation or -f formatting, a method
// reached by reflection or a computed name, a statement or client whose name
// is not listed (for example ENABLE TRIGGER, SHUTDOWN, osql), a procedure
// name that contains no listed word, or a lower-case Execute* name (the
// Execute* scan is case-sensitive).
test('readonly bridge script contains no SQL/ADO write or extra execute verbs', async () => {
  const script = await readScript();

  // Comments are not exempt: a stale comment naming a write verb (for example,
  // copy-pasted from a T-SQL snippet while drafting a query) is drift, and
  // comments are trivially uncommented by later edits. If the script ever
  // needs to name one of these words legitimately -- for example inside a
  // human-facing refusal message that enumerates the forbidden verbs -- that
  // occurrence must be carved out narrowly rather than by removing or
  // loosening an entry below. No such occurrence exists in the script today.
  //
  // Besides the DML/DDL verbs the list names: the ADO.NET bulk insert
  // (SqlBulkCopy / WriteToServer), `SELECT ... INTO`, WRITETEXT / UPDATETEXT,
  // RESTORE / BACKUP / DENY / DISABLE, `sp_rename` (a whole-word RENAME check
  // would miss it, because `_` is a word character), and StoredProcedure.
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
  // uses. Matching the generic `Execute<Word>` shape also catches PascalCase
  // variants such as ExecuteXmlReader that are not named above.
  const executeCalls = [...script.matchAll(/\bExecute[A-Za-z]+\b/g)].map((match) => match[0]);
  assert.ok(executeCalls.length > 0, 'expected at least one Execute* call in the script');
  assert.deepEqual(
    executeCalls,
    executeCalls.map(() => 'ExecuteReader'),
    `expected every command execution to be ExecuteReader, found: ${JSON.stringify(executeCalls)}`,
  );
});

// Pins the text of the one `.CommandText =` line and the one `.CommandType =`
// line. Catches a procedure name, another variable or another type written on
// those two lines. Does not see what reaches `$Sql` before the CommandText
// line, `.CommandText +=`, `set_CommandText(...)`, or a second command object.
test('readonly bridge: the one .CommandText = line and the one .CommandType = line match their pinned text', async () => {
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

// Pins the three lines that name `Invoke-BridgeSqlQuery` (exact case) and
// the `$sql =` / `$sql +=` lines of the query builder (exact case). Catches a
// change written on those exact lines: another health-check literal, another
// argument at the /query call site, a third call spelled `Invoke-BridgeSqlQuery`,
// or new text on the two builder lines. Does not see the lines in between:
// the builder's return line, `$querySpec` before the call, `$source`,
// `$columns` and `$whereClauses` that feed the builder line, or the `$Sql`
// parameter inside Invoke-BridgeSqlQuery; nor a call or variable spelled in
// another letter case.
test('readonly bridge: the lines naming Invoke-BridgeSqlQuery and the $sql = / $sql += lines match their pinned text', async () => {
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

// Refuses the substrings SqlCommand, SqlDataAdapter and sqlcmd in any letter
// case (they are matched as substrings, so SqlCommandBuilder and
// Invoke-Sqlcmd are covered too), and allows exactly one CreateCommand()
// call. Catches a second SqlClient command or adapter and the sqlcmd tools.
// Does not catch OleDb or Odbc command objects, osql, bcp, or any other
// client that does not contain one of those three names.
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
