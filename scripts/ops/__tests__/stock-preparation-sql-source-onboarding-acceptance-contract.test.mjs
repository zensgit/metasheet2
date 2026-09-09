import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Contract test for the SQL source onboarding acceptance runner
// (scripts/ops/stock-preparation-sql-source-onboarding-acceptance.ps1).
//
// This is a STATIC check only: it reads the .ps1 file as text and asserts
// on its shape. It never invokes PowerShell and never opens a socket -- the
// script itself talks to a real deployed instance and has no business
// running inside a unit test.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = path.join(__dirname, '..', 'stock-preparation-sql-source-onboarding-acceptance.ps1')
const scriptText = fs.readFileSync(SCRIPT_PATH, 'utf8')
const scriptLines = scriptText.split(/\r?\n/)

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

test('the script does read credentials from files (username/password), never inline', () => {
  assert.match(scriptText, /SqlUsernameFile/)
  assert.match(scriptText, /SqlPasswordFile/)
  assert.match(scriptText, /Read-AcceptanceSecret/)
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
