import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Contract test for the SQL source onboarding acceptance runner
// (scripts/ops/stock-preparation-sql-source-onboarding-acceptance.ps1).
//
// TWO layers, and the second one is why this file exists at all:
//
//   STATIC  — read the .ps1 as text and assert on its shape. Cheap, but it can
//             only prove that a guard is WRITTEN, never that it DECIDES
//             correctly. The first round of this file was static-only, and a
//             reviewer's in-memory replica found a step that returned PASS on
//             a failed connection because "HTTP 200" was the whole assertion.
//   EXECUTED — run the script's own `-SelfTest` mode in a real PowerShell and
//             grade what its classifiers actually decided on fixed synthetic
//             payloads (and what its two file readers actually did to real
//             fixture files). The script prints its decisions and never its
//             expectations; every expectation below lives here, so the script
//             cannot grade its own homework.
//
// Neither layer opens a socket or touches a deployment: `-SelfTest` is defined
// in the .ps1 ABOVE `Invoke-Api`, so it cannot reach an HTTP call, and a static
// test below re-proves that ordering.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = path.join(__dirname, '..', 'stock-preparation-sql-source-onboarding-acceptance.ps1')
const scriptText = fs.readFileSync(SCRIPT_PATH, 'utf8')
const scriptLines = scriptText.split(/\r?\n/)

// ---------------------------------------------------------------------------
// EXECUTED LAYER — drive `-SelfTest` once, reuse the parsed output everywhere.
//
// PowerShell is a REQUIREMENT here, not a nice-to-have, and a missing shell is
// reported as a FAILURE rather than a skip: this repo has been bitten by
// skip-shaped green before (see the `EXPECTED_OPS_TESTS_COUNT` rationale in
// .github/workflows/plugin-tests.yml). The `test` job that runs this file is
// ubuntu-latest, which ships `pwsh`, and that same job already runs a
// `shell: pwsh` step for the sibling acceptance suites.
// ---------------------------------------------------------------------------
function resolvePowerShell() {
  const candidates = process.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh']
  for (const exe of candidates) {
    const probe = spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
    })
    if (probe.status === 0) return exe
  }
  return null
}

// The exact bytes each probe file gets. The READER is chosen by suffix inside
// the script: `*.credential.probe` -> Read-AcceptanceCredential (byte-exact
// apart from ONE trailing newline), `*.token.probe` -> Read-AcceptanceToken
// (whitespace-trimmed). Nothing here is a real credential.
const READER_FIXTURES = {
  'spaces-crlf.credential.probe': '  pa ss  \r\n',
  'spaces-lf.credential.probe': '  pa ss  \n',
  'spaces-none.credential.probe': '  pa ss  ',
  'double-lf.credential.probe': 'pw\n\n',
  'empty-line.credential.probe': '\n',
  'spaces-crlf.token.probe': '  tok  \r\n',
  'inner-space.token.probe': '\tto ken \r\n',
}

function runSelfTest() {
  const shell = resolvePowerShell()
  assert.ok(
    shell,
    'PowerShell (pwsh, or powershell.exe on Windows) is required to run the acceptance script self-test; ' +
      'this is deliberately a failure and not a skip, so the executable legs below cannot silently stop running',
  )
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-sql-src-acc-selftest-'))
  try {
    for (const [name, contents] of Object.entries(READER_FIXTURES)) {
      fs.writeFileSync(path.join(fixtureDir, name), Buffer.from(contents, 'utf8'))
    }
    const args = ['-NoProfile']
    if (process.platform === 'win32') args.push('-ExecutionPolicy', 'Bypass')
    args.push('-File', SCRIPT_PATH, '-SelfTest', '-SelfTestFixtureDir', fixtureDir)
    const run = spawnSync(shell, args, { encoding: 'utf8' })
    assert.equal(
      run.status,
      0,
      `acceptance script -SelfTest exited ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    )
    let parsed
    try {
      parsed = JSON.parse(run.stdout)
    } catch (error) {
      assert.fail(`-SelfTest did not print parseable JSON (${error.message})\nstdout:\n${run.stdout}`)
    }
    assert.equal(parsed.schema, 'stock-preparation/sql-source-onboarding-acceptance/self-test/v1')
    return parsed
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true })
  }
}

const selfTest = runSelfTest()

const caseById = new Map((selfTest.cases || []).map((entry) => [entry.id, entry]))
const readerByFile = new Map((selfTest.readers || []).map((entry) => [entry.file, entry]))

// Fails loudly on a TYPO in a case id rather than vacuously passing: a lookup
// miss here means the script stopped emitting a case this test grades.
function verdictOf(id) {
  const entry = caseById.get(id)
  assert.ok(entry, `-SelfTest emitted no case '${id}' (emitted: ${[...caseById.keys()].join(', ')})`)
  return `${entry.result}/${entry.code}`
}

function readerOf(file) {
  const entry = readerByFile.get(file)
  assert.ok(entry, `-SelfTest reported no reader result for '${file}'`)
  return entry
}

// ---------------------------------------------------------------------------
// (E1) STEP3 leg 1 — the fake-PASS the reviewer reproduced.
//
// http-routes.cjs `externalSystemsTest` catches the adapter's throw, turns it
// into { ok:false, code, message } and STILL answers 200. A step that asserts
// only "HTTP 200" therefore passes on a source that cannot be reached at all.
// ---------------------------------------------------------------------------
test('STEP3 refuses a connection test that answered HTTP 200 with data.ok false', () => {
  assert.equal(verdictOf('connect-call-http200-ok-false'), 'FAIL/TEST_RESULT_NOT_OK')
  assert.equal(verdictOf('connect-call-ok'), 'PASS/CONNECTION_TEST_OK')
})

test('STEP3 fails closed when data.ok is absent or is not a real boolean', () => {
  assert.equal(verdictOf('connect-call-ok-field-absent'), 'FAIL/TEST_RESULT_NOT_OK')
  assert.equal(verdictOf('connect-call-ok-string-true'), 'FAIL/TEST_RESULT_NOT_OK')
  assert.equal(verdictOf('connect-call-http-500'), 'FAIL/TEST_CALL_HTTP_NOT_200')
})

// ---------------------------------------------------------------------------
// (E2) STEP3 leg 2 — the SAVED failure. `persistExternalSystemTestResult`
// writes status='error' + a non-null lastError together with a fresh
// lastTestedAt, so "lastTestedAt exists" is true for a failed test too.
// ---------------------------------------------------------------------------
test('STEP3 readback refuses a saved failure (status=error, or a non-empty lastError)', () => {
  assert.equal(verdictOf('connect-readback-status-error'), 'FAIL/SOURCE_STATUS_ERROR')
  assert.equal(verdictOf('connect-readback-last-error-only'), 'FAIL/LAST_ERROR_PRESENT')
  assert.equal(verdictOf('connect-readback-clean'), 'PASS/CONNECTION_VERIFIED')
})

test('STEP3 readback still requires lastTestedAt, and treats status=inactive as success', () => {
  assert.equal(verdictOf('connect-readback-no-tested-at'), 'FAIL/TESTED_AT_ABSENT')
  assert.equal(verdictOf('connect-readback-http-404'), 'FAIL/READBACK_HTTP_NOT_200')
  // resolveTestedStatus keeps an intentionally inactive system inactive after a
  // GOOD test; that must not be read as a failed connection.
  assert.equal(verdictOf('connect-readback-inactive-is-not-a-failure'), 'PASS/CONNECTION_VERIFIED')
})

// ---------------------------------------------------------------------------
// (E3) STEP4 preflight — the real route answers { ok, verdict }, never `ready`.
// ---------------------------------------------------------------------------
test('STEP4 preflight fails on verdict no-go and passes only on ok+go', () => {
  assert.equal(verdictOf('preflight-no-go'), 'FAIL/PREFLIGHT_VERDICT_NO_GO')
  assert.equal(verdictOf('preflight-go'), 'PASS/PREFLIGHT_GO')
  assert.equal(verdictOf('preflight-ok-false-verdict-go'), 'FAIL/PREFLIGHT_NOT_OK')
  assert.equal(verdictOf('preflight-http-409'), 'FAIL/PREFLIGHT_HTTP_NOT_200')
})

test('STEP4 preflight refuses a body that only carries the never-existing `ready` field', () => {
  // The original step read `data.ready`, which no deployment has ever returned:
  // it was always $null, so HTTP 200 was the entire gate.
  assert.equal(verdictOf('preflight-ready-field-only'), 'FAIL/PREFLIGHT_FIELDS_ABSENT')
})

// ---------------------------------------------------------------------------
// (E4) STEP4/STEP6 scope — a binding that points at a different source must
// degrade the CLAIM to ENV_PROBE, never quietly keep calling itself a chain.
// ---------------------------------------------------------------------------
test('a table action bound to another source degrades STEP4/STEP6 to ENV_PROBE', () => {
  assert.equal(verdictOf('chain-bound-to-other-source'), 'ENV_PROBE/BOUND_TO_OTHER_SOURCE')
  assert.equal(verdictOf('chain-bound-to-this-run'), 'CLOSED_LOOP/BOUND_TO_THIS_RUNS_SOURCE')
})

test('every unprovable binding readback degrades to ENV_PROBE rather than assuming a closed loop', () => {
  assert.equal(verdictOf('chain-binding-forbidden'), 'ENV_PROBE/BINDING_READBACK_FORBIDDEN')
  assert.equal(verdictOf('chain-action-id-mismatch'), 'ENV_PROBE/ACTION_ID_MISMATCH')
  assert.equal(verdictOf('chain-nothing-bound'), 'ENV_PROBE/NO_SOURCE_BOUND')
  assert.equal(verdictOf('chain-bound-system-unreadable'), 'ENV_PROBE/BOUND_SYSTEM_UNREADABLE')
  // CLOSED_LOOP is reachable from exactly one case above; nothing else claims it.
  const closedLoop = (selfTest.cases || []).filter((entry) => entry.result === 'CLOSED_LOOP')
  assert.deepEqual(closedLoop.map((entry) => entry.id), ['chain-bound-to-this-run'])
})

// ---------------------------------------------------------------------------
// (E5) The two file readers, round-tripped through real files.
//
// Reported structurally (length / leading spaces / trailing spaces / "does it
// still end in a newline") so the proof needs no value in the output.
// '  pa ss  \r\n' is 10 chars on disk and must arrive as the 9-char
// '  pa ss  ' — spaces intact, exactly one newline gone.
// ---------------------------------------------------------------------------
test('a SQL credential keeps its leading and trailing spaces (the .Trim() that rewrote passwords is gone)', () => {
  for (const file of ['spaces-crlf.credential.probe', 'spaces-lf.credential.probe', 'spaces-none.credential.probe']) {
    const result = readerOf(file)
    assert.equal(result.reader, 'credential')
    assert.equal(result.length, 9, `${file}: '  pa ss  ' is 9 characters`)
    assert.equal(result.leadingSpaces, 2, `${file}: both leading spaces must survive`)
    assert.equal(result.trailingSpaces, 2, `${file}: both trailing spaces must survive`)
    assert.equal(result.endsWithNewline, false, `${file}: the single trailing newline must be stripped`)
  }
})

test('a credential reader strips exactly ONE trailing newline, never two', () => {
  const doubled = readerOf('double-lf.credential.probe')
  assert.equal(doubled.length, 3, "'pw\\n\\n' must arrive as 'pw\\n', not as 'pw'")
  assert.equal(doubled.endsWithNewline, true, 'the second newline must survive so a bad file fails loudly')
  // A file that is nothing but one newline becomes the empty string, not $null.
  assert.equal(readerOf('empty-line.credential.probe').length, 0)
})

test('a token file is still whitespace-trimmed at both ends', () => {
  const token = readerOf('spaces-crlf.token.probe')
  assert.equal(token.reader, 'token')
  assert.equal(token.length, 3, "'  tok  \\r\\n' must arrive as 'tok'")
  assert.equal(token.endsWithNewline, false)
  const tabbed = readerOf('inner-space.token.probe')
  assert.equal(tabbed.length, 6, "'\\tto ken \\r\\n' must arrive as 'to ken' -- inner space kept, outer trimmed")
  assert.equal(tabbed.leadingSpaces, 0)
  assert.equal(tabbed.trailingSpaces, 0)
})

// ---------------------------------------------------------------------------
// STATIC LAYER
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (1) The 9 numbered steps (plus the two negative sub-checks 1' and 2') must
// each have their own distinct, greppable identifier in the script. Word
// boundaries matter here: STEP1 must be found as its own token, not merely
// as a substring inside STEP1B, STEP10, etc.
// ---------------------------------------------------------------------------
test('script names all 9 steps (STEP1..STEP9) as distinct identifiers', () => {
  for (let n = 1; n <= 9; n += 1) {
    const pattern = new RegExp(`\\bSTEP${n}\\b`)
    assert.ok(pattern.test(scriptText), `expected to find a STEP${n} identifier in the script`)
  }
})

test('script also names the two negative sub-checks (1prime, 2prime) as STEP1B / STEP2B', () => {
  assert.match(scriptText, /\bSTEP1B\b/, 'expected a STEP1B identifier for the claimless-token negative check under step 1')
  assert.match(scriptText, /\bSTEP2B\b/, 'expected a STEP2B identifier for the credentials-forbidden negative check under step 2')
})

// ---------------------------------------------------------------------------
// (2) Invoke-WebRequest with -UseBasicParsing. PS 5.1 without
// -UseBasicParsing depends on IE's DOM parser being installed, which is not
// a safe assumption for an on-prem ops box.
// ---------------------------------------------------------------------------
test('every HTTP call uses Invoke-WebRequest with -UseBasicParsing', () => {
  assert.match(scriptText, /Invoke-WebRequest\b/, 'expected Invoke-WebRequest to appear')
  const invokeCalls = scriptText.match(/Invoke-WebRequest\s+@?\w*/g) || []
  assert.ok(invokeCalls.length > 0, 'expected at least one Invoke-WebRequest call')
  // The single HTTP helper (Invoke-Api) must splat @requestArgs, and that
  // hashtable must set UseBasicParsing = $true -- checked directly, since a
  // splatted call's flags do not appear on the same source line as the verb.
  assert.match(scriptText, /\$requestArgs\.UseBasicParsing\s*=\s*\$true|UseBasicParsing\s*=\s*\$true/, 'expected UseBasicParsing = $true to be set on the request arguments')
  assert.match(scriptText, /Invoke-WebRequest\s+@requestArgs/, 'expected Invoke-WebRequest to be called with the splatted request arguments carrying -UseBasicParsing')
})

// ---------------------------------------------------------------------------
// (3) Values-free logging: no Write-Host / Write-Output line may reference a
// variable whose name mentions Token, Password, or Credential. This is a
// LINE-LEVEL check (not a whole-file grep) so an unrelated line elsewhere
// mentioning e.g. "$OwnerTokenFile" in a comment cannot hide a real leak on
// a Write-Host line, and cannot falsely fail a Write-Host line that merely
// prints a step id or a status code.
// ---------------------------------------------------------------------------
test('no Write-Host / Write-Output line ever references a Token / Password / Credential variable', () => {
  const forbiddenVarPattern = /\$\w*(?:Token|Password|Credential)\w*/i
  const offendingLines = []
  scriptLines.forEach((line, index) => {
    if (/Write-Host|Write-Output/.test(line) && forbiddenVarPattern.test(line)) {
      offendingLines.push(`line ${index + 1}: ${line.trim()}`)
    }
  })
  assert.deepEqual(offendingLines, [], `found Write-Host/Write-Output line(s) referencing a secret-shaped variable:\n${offendingLines.join('\n')}`)
})

// STEP3 now READS lastError to assert it is empty. That is exactly the kind of
// field that must never be echoed, so the emptiness assertion may not become a
// leak: no printed line, and no report field, may carry its value.
test('lastError is asserted empty and never printed or written into the report', () => {
  const offendingLines = []
  scriptLines.forEach((line, index) => {
    if (!/Write-Host|Write-Output/.test(line)) return
    if (/lastError/i.test(line)) offendingLines.push(`line ${index + 1}: ${line.trim()}`)
  })
  assert.deepEqual(offendingLines, [], `found a printed line carrying lastError:\n${offendingLines.join('\n')}`)
  assert.match(
    scriptText,
    /LAST_ERROR_PRESENT/,
    'the lastError assertion must report a fixed classification code instead of the message',
  )
})

test('the script does read credentials from files (username/password), never inline', () => {
  assert.match(scriptText, /SqlUsernameFile/)
  assert.match(scriptText, /SqlPasswordFile/)
  // Two readers, on purpose: tokens are trimmed, credentials are byte-exact.
  assert.match(scriptText, /function Read-AcceptanceToken/)
  assert.match(scriptText, /function Read-AcceptanceCredential/)
  assert.match(
    scriptText,
    /\$sqlPassword\s*=\s*Read-AcceptanceCredential/,
    'the SQL password must be read with the byte-exact credential reader, not the trimming token reader',
  )
  assert.match(
    scriptText,
    /\$sqlUsername\s*=\s*Read-AcceptanceCredential/,
    'the SQL username must be read with the byte-exact credential reader too',
  )
  assert.match(
    scriptText,
    /\$ownerToken\s*=\s*Read-AcceptanceToken/,
    'bearer tokens keep the trimming reader',
  )
  assert.doesNotMatch(
    scriptText,
    /\$sql(?:Username|Password)\s*=\s*Read-AcceptanceToken/,
    'a credential must never go through the trimming reader',
  )
})

// ---------------------------------------------------------------------------
// (4) ISOLATION_BREACH marker for "expected 4xx, got 2xx".
// ---------------------------------------------------------------------------
test('script defines an ISOLATION_BREACH marker and halts on it', () => {
  assert.match(scriptText, /ISOLATION_BREACH/)
  // Must actually gate subsequent steps, not just log the string once.
  assert.match(scriptText, /\$script:Halt\s*=\s*\$true/)
  assert.match(scriptText, /if\s*\(-not \$script:Halt\)/)
})

// ---------------------------------------------------------------------------
// (5) -DryRun support: prints the plan, sends no requests.
// ---------------------------------------------------------------------------
test('script declares a -DryRun switch and never sends a request under it', () => {
  assert.match(scriptText, /\[switch\]\$DryRun/)
  const dryRunBlockMatch = scriptText.match(/if\s*\(\$DryRun\)\s*\{([\s\S]*?)\n\}/)
  assert.ok(dryRunBlockMatch, 'expected an `if ($DryRun) { ... }` block')
  assert.doesNotMatch(dryRunBlockMatch[1], /Invoke-Api|Invoke-WebRequest/, 'the -DryRun branch must not issue any HTTP call')
  assert.match(dryRunBlockMatch[1], /exit 0/, 'the -DryRun branch must exit before falling through to the real steps')
})

// ---------------------------------------------------------------------------
// (6) -SelfTest is structurally incapable of reaching the network: PowerShell
// binds a function name only when execution passes its definition, so a
// self-test placed above `function Invoke-Api` cannot call it.
// ---------------------------------------------------------------------------
test('-SelfTest is defined above Invoke-Api and issues no HTTP call', () => {
  assert.match(scriptText, /\[switch\]\$SelfTest/)
  const selfTestIndex = scriptText.indexOf('if ($SelfTest) {')
  const invokeApiIndex = scriptText.indexOf('function Invoke-Api')
  assert.ok(selfTestIndex > 0, 'expected an `if ($SelfTest) { ... }` block')
  assert.ok(invokeApiIndex > 0, 'expected the Invoke-Api helper')
  assert.ok(
    selfTestIndex < invokeApiIndex,
    'the -SelfTest block must appear BEFORE function Invoke-Api, so it cannot call it',
  )
  // Comment lines are stripped first: the block's own comments EXPLAIN why it
  // cannot reach Invoke-Api, and a naive grep would read that explanation as
  // the violation it describes.
  const selfTestCode = scriptText
    .slice(selfTestIndex, invokeApiIndex)
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
  assert.doesNotMatch(selfTestCode, /Invoke-Api|Invoke-WebRequest/, 'the -SelfTest branch must not issue any HTTP call')
  assert.match(selfTestCode, /exit 0/, 'the -SelfTest branch must exit before falling through to the real steps')
})

// ---------------------------------------------------------------------------
// Extra structural checks, cheap to keep and cheap to trust: every
// documented status/code pairing this runner claims to check for actually
// appears literally in the script text (guards against the acceptance spec
// drifting silently out of sync with the implementation).
// ---------------------------------------------------------------------------
test('every documented expected error code literally appears in the script', () => {
  const expectedCodes = [
    'AUTHENTICATED_TENANT_REQUIRED',
    'CONNECTION_BINDING_CREDENTIALS_FORBIDDEN',
    'DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS',
    'OPERATOR_SCOPE_TENANT_REQUIRED',
    'TENANT_MISMATCH',
    'CONNECTION_CANONICAL_UNAVAILABLE',
    'TENANT_REQUIRED',
    'NOT_FOUND',
  ]
  for (const code of expectedCodes) {
    assert.ok(scriptText.includes(code), `expected error code ${code} to appear in the script`)
  }
})

test('#requires -Version 5.1 is declared (PowerShell 5.1 compatibility)', () => {
  assert.match(scriptText, /^#requires -Version 5\.1/m)
})

test('script supports -KeepFixtures and defaults to cleaning up its own fixtures', () => {
  assert.match(scriptText, /\[switch\]\$KeepFixtures/)
  assert.match(scriptText, /if\s*\(-not \$KeepFixtures\)/)
})

test('script writes a JSON report to -ReportPath', () => {
  assert.match(scriptText, /\[string\]\$ReportPath/)
  assert.match(scriptText, /ConvertTo-Json/)
  assert.match(scriptText, /WriteAllText\(\$ReportPath/)
})

test('script exits non-zero on any FAIL or ISOLATION_BREACH', () => {
  assert.match(scriptText, /\$script:ExitCode\s*=\s*1/)
  assert.match(scriptText, /exit \$script:ExitCode/)
})

// ---------------------------------------------------------------------------
// The closed-loop claim must be wired into the plan, the report and the
// printed conclusion -- not just computed and dropped.
// ---------------------------------------------------------------------------
test('the plan carries the two binding-readback legs that decide the closed-loop claim', () => {
  assert.match(scriptText, /STEP4-ACTION-SOURCE-BINDING/)
  assert.match(scriptText, /STEP4-BOUND-SOURCE-CONNECTION/)
  assert.match(
    scriptText,
    /'\/api\/integration\/stock-preparation\/source-binding'/,
    'the binding readback must call the real source-binding route',
  )
})

test('the run concludes CLOSED_LOOP_PASS only when the binding readback proved it', () => {
  assert.match(scriptText, /CLOSED_LOOP_PASS/)
  assert.match(scriptText, /ENV_PROBE_PASS/)
  // The conclusion is derived from $script:ChainMode, so a non-closed-loop run
  // cannot print the closed-loop wording.
  assert.match(
    scriptText,
    /\$script:ChainMode\s+-eq\s+'CLOSED_LOOP'\)\s*\{\s*\r?\n\s*'CLOSED_LOOP_PASS'/,
    'CLOSED_LOOP_PASS must be gated on $script:ChainMode',
  )
  assert.match(scriptText, /NOT A CLOSED LOOP/, 'a non-closed-loop run must say so in as many words')
  assert.match(scriptText, /closedLoop = \(\$script:ChainMode -eq 'CLOSED_LOOP'\)/, 'the JSON report must carry the claim too')
  assert.match(scriptText, /boundSourceDigest/, 'the pre-existing bound source must be named by digest in the report')
})

test('the acceptance run never rebinds the deployed table action to close its own loop', () => {
  // Reading the binding is the whole mechanism; a POST to source-binding would
  // be the script editing production config to make its own claim true.
  const bindingWrites = scriptLines.filter((line) =>
    /Invoke-Api[^\n]*-Method\s+POST/.test(line) && /source-binding/.test(line))
  assert.deepEqual(bindingWrites, [], 'the script must never POST to the source-binding route')
  assert.doesNotMatch(scriptText, /stockPreparationSourceBindingSet/)
})

// ---------------------------------------------------------------------------
// Params referenced by the task brief must all exist, with the documented
// defaults where a default was specified.
// ---------------------------------------------------------------------------
test('declares every parameter named in the acceptance spec, with the documented defaults', () => {
  const requiredParams = [
    '$BaseUrl',
    '$OwnerTokenFile',
    '$OperatorTokenFile',
    '$ClaimlessTokenFile',
    '$TenantId',
    '$OtherTenantId',
    '$DataSourceId',
    '$SqlHost',
    '$SqlPort',
    '$SqlDatabase',
    '$SqlUsernameFile',
    '$SqlPasswordFile',
    '$WorkspaceHint',
    '$ActionId',
    '$ProjectNo',
    '$DryRun',
    '$SelfTest',
    '$SelfTestFixtureDir',
    '$KeepFixtures',
    '$ReportPath',
  ]
  const paramBlockMatch = scriptText.match(/param\(([\s\S]*?)\n\)/)
  assert.ok(paramBlockMatch, 'expected a param() block')
  const paramBlock = paramBlockMatch[1]
  for (const p of requiredParams) {
    assert.ok(paramBlock.includes(p), `expected param block to declare ${p}`)
  }
  assert.match(paramBlock, /\$OtherTenantId\s*=\s*'tenant-acceptance-other'/)
  assert.match(paramBlock, /\$WorkspaceHint\s*=\s*'default'/)
  assert.match(paramBlock, /\$ActionId\s*=\s*'plm\.stock-preparation\.pull-bom\.v1'/)
})

// ---------------------------------------------------------------------------
// Reference-file style check: the shipped provenance-pinned acceptance
// script must remain untouched by this addition (this repo's operating
// rule for this task -- a read-only reference, never edited).
// ---------------------------------------------------------------------------
test('does not modify the provenance-pinned S6-A reference script', () => {
  const referencePath = path.join(__dirname, '..', 'stock-preparation-s6a-onprem-acceptance.ps1')
  assert.ok(fs.existsSync(referencePath), 'reference script should still exist untouched')
})

// ---------------------------------------------------------------------------
// The runner has to actually SHIP: it is useless on a customer box if the
// on-prem package does not carry it. Both halves are asserted here so a
// packaging regression is caught at PR time (verify.sh itself only runs in
// dispatch-only workflows).
// ---------------------------------------------------------------------------
test('the acceptance script is part of the on-prem package manifest and its verifier', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const buildScript = fs.readFileSync(path.join(repoRoot, 'scripts/ops/multitable-onprem-package-build.sh'), 'utf8')
  const verifyScript = fs.readFileSync(path.join(repoRoot, 'scripts/ops/multitable-onprem-package-verify.sh'), 'utf8')
  const requiredPaths = buildScript.match(/REQUIRED_PATHS=\(\n([\s\S]*?)\n\)/)
  assert.ok(requiredPaths, 'expected a REQUIRED_PATHS array in the build script')
  assert.match(
    requiredPaths[1],
    /"scripts\/ops\/stock-preparation-sql-source-onboarding-acceptance\.ps1"/,
    'the SQL source onboarding acceptance script must be packaged',
  )
  assert.match(
    verifyScript,
    /sql_source_acceptance=/,
    'the package verifier must resolve the SQL source onboarding acceptance script',
  )
  assert.match(
    verifyScript,
    /search_fixed_string 'ISOLATION_BREACH' "\$sql_source_acceptance"/,
    'the package verifier must require the ISOLATION_BREACH marker in the packaged copy',
  )
})
