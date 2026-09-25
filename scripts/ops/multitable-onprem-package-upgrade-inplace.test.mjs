import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// F22 (2026-08-31): the live r7 upgrade used `Get-ChildItem -Exclude 'node_modules'`
// during a recursive copy. `-Exclude` does not filter directories in recursion, so an
// entire plugin lib/ directory was silently skipped — the deployment was missing
// stock-preparation-preflight.cjs until a hand-check against the package caught it.
// See docs/development/takeover-beiliao-20260821/first-deployment-lessons-20260831.md
// (Appendix A, F22) and r7-build-manifest.md §2.
//
// Adversarial verification of the first version of this file/script (2026-08-31)
// refuted three of four guarantee lanes with empirical replays:
//   P0 — this test file was wired into no workflow and no package.json script: a
//        dead tripwire. Fixed by a one-line addition to an existing, unpinned
//        `node --test` list in the REQUIRED `test` job of plugin-tests.yml (see
//        that file's "Global History flag manifest contract (R12-C)" step).
//   P1 — the static -Exclude tripwire was evadable by a legal PowerShell parameter
//        abbreviation (-Ex/-Excl/-Exclu, ...) or a splatted `@{ Exclude = ... }`
//        hashtable key. Fixed by findForbiddenExcludeTokens below, plus an evasion
//        battery.
//   P1 — a broken deployment could be left running (pm2 restarted, health check
//        failed, pm2 never stopped), and a mid-swap exception died raw, with no
//        restore-block printed. Fixed by wrapping the whole mutation window in one
//        handler (Write-RestoreBlock + Stop-Pm2App) in the script's Main.
//   P1 — the count-comparison "gate" was advisory and chronically wrong (an overlay
//        copy never deletes stale files, so deployed > package is normal). Fixed by
//        Assert-PluginTreesMatchPackage (per-file SHA-256) and
//        Assert-NoNodeModulesContentLeaked (the negative half — content leaking to
//        an unexpected location, which the positive hash check alone cannot see).
// The verifiers also noted the original fixtures were too shallow to reproduce F22
// (both canonical -Exclude patterns passed against them). The acid fixture below
// (buildAcidPackageStage / buildAcidLiveRoot) replaces those fixtures everywhere.

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const scriptPath = path.join(repoRoot, 'scripts/ops/multitable-onprem-package-upgrade-inplace.ps1')
const workflowPath = path.join(repoRoot, '.github/workflows/plugin-tests.yml')
const runbookPath = path.join(repoRoot, 'docs/development/takeover-beiliao-20260821/222-deploy-window-runbook-20260901.md')
const scriptSource = fs.readFileSync(scriptPath, 'utf8')

// The PowerShell every harness and every end-to-end run of this file uses.
// Default 'pwsh' (the ubuntu `test` job: pwsh 7). Set UPGRADE_INPLACE_TEST_SHELL
// to Windows PowerShell 5.1's powershell.exe to run this same file under 5.1, the
// demo host's shell -- some of the script's behaviour only exists there: pwsh 7.2+
// never turns redirected native stderr into an ErrorRecord, so a revert of
// Invoke-Pm2's `$ErrorActionPreference = 'Continue'` (R59: pm2's "not found" on
// stderr becomes a terminating NativeCommandError) is red at runtime only on 5.1.
// The pwsh 7 CI lane still catches that revert through the static pin in the
// "R59 wiring" test. Under 5.1 the script must carry a UTF-8 BOM, as the deployed
// copy does, unless the machine's ANSI code page is UTF-8: without it 5.1 decodes
// the file in the ANSI code page and, under 1252, the em-dashes inside its strings
// end them early (the script does not parse).
const PWSH = process.env.UPGRADE_INPLACE_TEST_SHELL || 'pwsh'
// A Windows PowerShell 5.1 started (via node) from a pwsh 7 session -- e.g. a CI step
// whose host shell is pwsh -- inherits pwsh 7's PSModulePath and then cannot load its own core
// modules: "The term 'Get-FileHash' is not recognized", Compress-Archive likewise.
// Without PSModulePath it builds its own default. Every child of this file inherits
// process.env (childEnv copies it), so dropping it here covers every spawn.
if (process.env.UPGRADE_INPLACE_TEST_SHELL) delete process.env.PSModulePath

// Strips PowerShell `<# ... #>` block comments (used here for rich, deliberately
// quotes-the-forbidden-syntax documentation of WHY -Exclude is banned) before the
// static tripwire below scans for live code. Without this, the script's own
// explanation of F22 ("do not rewrite this as ... -Exclude ...") would trip its
// own tripwire — the goal is banning the pattern from CODE, not from prose that
// quotes it as a warning.
function stripPowerShellBlockComments(source) {
  return source.replace(/<#[\s\S]*?#>/g, '')
}
const scriptCodeOnly = stripPowerShellBlockComments(scriptSource)

const PREFLIGHT_FILE = 'plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs'
const MANIFEST_FILE = 'plugins/plugin-integration-core/app.manifest.json'
// One level deeper than the real repo path (lib/adapters/k3-wise-document-templates.cjs,
// per scripts/ops/multitable-onprem-package-build.sh's BUILD_PROVENANCE marker file) so
// the acid fixture exercises depth>=3 under lib/, as the verifiers required.
const DEEP_ADAPTER_FILE = 'plugins/plugin-integration-core/lib/adapters/legacy/k3-wise-document-templates.cjs'
const DECOY_FILE = 'plugins/plugin-integration-core/lib/legacy-node_modules-shim.cjs'
const LOOSE_ROOT_FILE = 'plugins/README.txt'
const PACKAGE_NODE_MODULES_FILE = 'plugins/plugin-integration-core/node_modules/left-pad/index.js'
const LIVE_NODE_MODULES_SURVIVOR = 'plugins/plugin-integration-core/node_modules/existing-dep/index.js'
const PACKAGE_LEAK_MARKER = 'PACKAGE_NODE_MODULES_LEAK_MARKER_CONTENT_MUST_NEVER_BE_COPIED_ANYWHERE_OUTSIDE_NODE_MODULES'
const LIVE_SURVIVOR_CONTENT = 'LIVE_NODE_MODULES_SURVIVOR_CONTENT_MUST_NOT_BE_TOUCHED'

// ── Hardened static -Exclude scanner (mirrors what the script must never contain) ─

// PowerShell accepts ANY unambiguous prefix of a parameter name. Neither
// Get-ChildItem nor Copy-Item has another parameter starting "Ex", so all of these
// are legal, working spellings of -Exclude on both cmdlets — the naive `/-Exclude/i`
// regex the first version of this file used is blind to every one of them except
// the last.
const EXCLUDE_PREFIXES = ['Exclude', 'Exclud', 'Exclu', 'Excl', 'Exc', 'Ex']
const EXCLUDE_DASH_PATTERN = new RegExp(`-(?:${EXCLUDE_PREFIXES.join('|')})\\b`, 'gi')
// Splatted hashtable key form has no dash at all: `@{ Exclude = 'node_modules' }` or
// `@{ Excl = ... }`. Deliberately NOT anchored to "must follow { or ; or ," — a
// PowerShell hashtable/pscustomobject commonly separates entries with a bare
// newline, not a semicolon, which would have produced a false negative on the
// second-or-later key in a multi-line splat. Scoped to this one script file, where
// none of these six short tokens are legitimate identifiers, so the broader match
// is the correct tradeoff for a tripwire.
const EXCLUDE_SPLAT_KEY_PATTERN = new RegExp(`\\b(?:${EXCLUDE_PREFIXES.join('|')})\\s*=(?!=)`, 'gi')

function findForbiddenExcludeTokens(text) {
  const hits = []
  for (const re of [EXCLUDE_DASH_PATTERN, EXCLUDE_SPLAT_KEY_PATTERN]) {
    const matches = text.match(re)
    if (matches) hits.push(...matches)
  }
  return hits
}

// ── 1. STATIC ────────────────────────────────────────────────────────────────────

test('hardened tripwire: the real script contains zero forbidden Exclude tokens (dash-abbreviated or splatted)', () => {
  const hits = findForbiddenExcludeTokens(scriptCodeOnly)
  assert.deepEqual(
    hits,
    [],
    'the script must not use -Exclude, any unambiguous abbreviation of it (-Ex/-Exc/-Excl/-Exclu/-Exclud), ' +
      'or a splatted Exclude/Excl/... hashtable key anywhere in live code',
  )
})

test('evasion battery: every legal spelling of the forbidden pattern is caught', () => {
  const evasions = [
    ["Get-ChildItem -Recurse -Ex 'node_modules' | Copy-Item -Destination $d -Recurse -Force", '2-char dash abbreviation on Get-ChildItem'],
    ["Get-ChildItem -Recurse -Excl 'node_modules' | Copy-Item -Destination $d -Recurse -Force", '4-char dash abbreviation on Get-ChildItem'],
    ["Copy-Item -Path $s -Destination $d -Recurse -Exclu 'node_modules'", '5-char dash abbreviation on Copy-Item'],
    ["Copy-Item -Path $s -Destination $d -Recurse -EXCLUDE 'node_modules'", 'uppercase full word on Copy-Item'],
    ["get-childitem -recurse -exc 'node_modules' | copy-item -destination $d -recurse", 'lowercase 3-char abbreviation, lowercase cmdlets'],
    ["Get-ChildItem -Recurse -Ex:'node_modules'", 'colon parameter-value syntax'],
    ["$splat = @{ Exclude = 'node_modules' }\nGet-ChildItem @splat -Recurse", 'splatted full-word hashtable key, single-line hashtable'],
    ["$splat = @{ Excl = 'node_modules' }\nCopy-Item @splat -Recurse", 'splatted abbreviated hashtable key'],
    [
      "$splat = @{\n  Recurse = $true\n  Exclude = 'node_modules'\n}\nGet-ChildItem @splat",
      'splatted key on the SECOND line of a multi-line hashtable with no semicolon before it',
    ],
  ]

  for (const [snippet, label] of evasions) {
    const hits = findForbiddenExcludeTokens(snippet)
    assert.ok(hits.length > 0, `evasion not caught (${label}): ${JSON.stringify(snippet)}`)
  }
})

test('evasion battery: legitimate identifiers containing "Exclu" as a mid-word substring are NOT false-flagged', () => {
  const clean = [
    "function Copy-TreeExcludingNodeModules {",
    "$result = Copy-TreeExcludingNodeModules -Source $s -Destination $d",
    "# excluding node_modules from the walk",
    "Test-IsNodeModulesRelativePath -RelativePath $relative",
  ]
  for (const snippet of clean) {
    const hits = findForbiddenExcludeTokens(snippet)
    assert.deepEqual(hits, [], `false positive on legitimate text: ${JSON.stringify(snippet)} -> ${JSON.stringify(hits)}`)
  }
})

test('walk-files copy is implemented by enumerating files, not by filtering a recursive listing', () => {
  assert.match(
    scriptSource,
    /function Copy-TreeExcludingNodeModules/,
    'the F22-safe copy helper must exist as a named, testable function',
  )
  assert.match(
    scriptSource,
    /Get-ChildItem -LiteralPath \$sourceFull -Recurse -File -Force/,
    'the copy helper must enumerate FILES (not directories) recursively and test each one individually',
  )
  assert.match(
    scriptSource,
    /Test-IsNodeModulesRelativePath/,
    'the copy helper must delegate the node_modules decision to the standalone, unit-testable predicate',
  )
})

test('must-exist manifest defaults to the exact file F22 lost, plus the app manifest', () => {
  const manifestBlock = scriptSource.match(
    /\[string\[\]\]\$MustExistManifest = @\(([\s\S]*?)\)/,
  )
  assert.ok(manifestBlock, 'the script must declare a parameterized $MustExistManifest default array')

  assert.match(
    manifestBlock[1],
    /plugins\/plugin-integration-core\/lib\/stock-preparation-preflight\.cjs/,
    'the default manifest must include the exact file F22 silently dropped',
  )
  assert.match(
    manifestBlock[1],
    /plugins\/plugin-integration-core\/app\.manifest\.json/,
    'the default manifest must include app.manifest.json',
  )
})

test('the F22 tripwire assertion refuses to proceed on any missing file', () => {
  assert.match(scriptSource, /function Assert-MustExistFiles/)
  assert.match(scriptSource, /throw "UPGRADE_ASSERTION_MISSING_FILES/)
})

test('the real F22 net is a per-file SHA-256 gate, not just the file-count comparison', () => {
  assert.match(
    scriptSource,
    /function Assert-PluginTreesMatchPackage/,
    'a per-file hash-verification function must exist',
  )
  assert.match(scriptSource, /throw "UPGRADE_PLUGIN_HASH_VERIFICATION_FAILED/)
  assert.match(
    scriptSource,
    /Assert-PluginTreesMatchPackage -PackageRoot \$packageRoot -RootDir \$resolvedRoot/,
    'the hash gate must actually be called in Main, not just defined',
  )
  assert.match(
    scriptSource,
    /INFORMATIONAL ONLY[\s\S]{0,400}chronically false-MISMATCH/,
    'the count comparison must be explicitly demoted to informational, not presented as a gate',
  )
})

test('the negative half of the net (node_modules leak detection) exists and is wired into Main', () => {
  assert.match(scriptSource, /function Assert-NoNodeModulesContentLeaked/)
  assert.match(scriptSource, /throw "UPGRADE_NODE_MODULES_LEAK_DETECTED/)
  assert.match(
    scriptSource,
    /Assert-NoNodeModulesContentLeaked -PackageRoot \$packageRoot -RootDir \$resolvedRoot/,
    'the leak-detection gate must actually be called in Main, not just defined',
  )
})

test('package checksum is verified before anything else runs', () => {
  const step1Index = scriptSource.indexOf('Step 1/8: verify package checksum')
  const step2Index = scriptSource.indexOf('Step 2/8: stop pm2 app')
  assert.ok(step1Index > -1 && step2Index > -1)
  assert.ok(step1Index < step2Index, 'checksum verification must run before the pm2 app is stopped')
  assert.match(scriptSource, /throw "PACKAGE_CHECKSUM_MISMATCH/)
})

test('the entire mutation window is wrapped in one failure handler that stops pm2 and prints a restore block', () => {
  assert.match(
    scriptSource,
    /function Write-RestoreBlock/,
    'a dedicated, boxed restore-instructions function must exist',
  )
  const mainStart = scriptSource.indexOf("if ($MyInvocation.InvocationName -ne '.') {")
  assert.ok(mainStart > -1)
  const main = scriptSource.slice(mainStart)

  // One OUTER try/catch wraps steps 4 through 7 (extract through health check) —
  // not one handler per assertion. It also nests exactly ONE defensive try/catch
  // of its own, around the Stop-Pm2App call inside it (so a failure THERE cannot
  // prevent the restore block from still printing) — so exactly two `} catch {`
  // occurrences are expected in Main, not one flat handler and not a patchwork of
  // several.
  const catchCount = (main.match(/\}\s*catch\s*\{/g) || []).length
  assert.equal(
    catchCount,
    2,
    'Main must have exactly the outer mutation-window handler plus its one nested defensive pm2-stop catch',
  )

  const outerCatchStart = main.indexOf('Write-Err $_.Exception.Message')
  assert.ok(outerCatchStart > -1, 'the outer catch must start by reporting the original error')
  const outerCatchBlock = main.slice(outerCatchStart)
  assert.match(
    outerCatchBlock,
    /Stop-Pm2App -Pm2Command \$pm2Command -Name \$Pm2AppName/,
    'the catch handler must attempt to stop pm2 — a broken deployment must not be left running',
  )
  assert.match(
    outerCatchBlock,
    /Write-RestoreBlock -BackupPath \$backupPath -RootDir \$resolvedRoot -ReplacedRelativePaths \$restoredRelativePaths -Pm2AppName \$Pm2AppName/,
    'the catch handler must print the restore block',
  )
  assert.match(outerCatchBlock, /\bthrow\b/, 'the catch handler must rethrow, never swallow the failure')

  // Health failure must be raised as an exception INSIDE the try, so it flows
  // through the SAME handler — not handled by a separate, easily-desynced branch.
  const tryBlock = main.slice(main.indexOf('try {'), main.indexOf('} catch {'))
  assert.match(
    tryBlock,
    /if \(-not \$health\.Ok\) \{\s*throw "HEALTHCHECK_FAILED/,
    'a failed healthcheck must throw inside the try block, not just print and continue',
  )
})

test('the nginx example ships the maintenance gate, and both the flag and the maintenance page live OUTSIDE every replaced directory', () => {
  const conf = fs.readFileSync(path.join(repoRoot, 'ops/nginx/multitable-onprem.conf.example'), 'utf8')
  const page = fs.readFileSync(path.join(repoRoot, 'ops/maintenance/maintenance.html'), 'utf8')

  // The gate must be the FIRST rule inside location /api — after proxy_pass it
  // would never be reached for proxied requests.
  const apiBlock = conf.slice(conf.indexOf('location /api'), conf.indexOf('location @maintenance_json'))
  const apiDirectives = apiBlock.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  assert.match(apiDirectives[1] || '', /^if \(-f .*maintenance\.flag\) \{$/, 'the flag check must be the first directive in location /api')
  const flagDirectiveIdx = apiDirectives.findIndex((l) => l.includes('maintenance.flag'))
  const proxyDirectiveIdx = apiDirectives.findIndex((l) => l.startsWith('proxy_pass'))
  assert.ok(flagDirectiveIdx > -1 && proxyDirectiveIdx > -1, 'location /api must have both the flag check and proxy_pass')
  assert.ok(flagDirectiveIdx < proxyDirectiveIdx, 'the flag check must precede proxy_pass')

  // The browser path gets a real page, the API path gets JSON with Retry-After.
  assert.match(conf, /error_page 503 @maintenance_json;/)
  assert.match(conf, /error_page 503 \/maintenance\.html;/)
  assert.match(conf, /add_header Retry-After 90 always;/)
  assert.match(conf, /return 503 '\{"error":\{"code":"SERVICE_UNAVAILABLE"/)

  // Neither the flag nor the page may sit under a directory the upgrade deletes
  // and recopies (the ReplaceDirs defaults in the upgrade script).
  const replacedDirs = ['apps/web/dist', 'packages/core-backend/dist', 'packages/core-backend/migrations']
  const flagPaths = conf.match(/-f\s+(\S+maintenance\.flag)/g) || []
  assert.ok(flagPaths.length >= 2, 'both location / and location /api must test the flag')
  for (const hit of flagPaths) {
    for (const replaced of replacedDirs) {
      assert.ok(!hit.includes(replaced), `the maintenance flag must not live under ${replaced}: ${hit}`)
    }
  }
  const pageRoot = (conf.match(/root\s+(\S*ops\/maintenance)\s*;/) || [])[1]
  assert.ok(pageRoot, 'the maintenance page must be served from an ops/maintenance root')
  for (const replaced of replacedDirs) {
    assert.ok(!pageRoot.includes(replaced), `the maintenance page root must not live under ${replaced}`)
  }

  // ── The two sides must name the SAME file ────────────────────────────────────
  // Adversarial verification (2026-09-11) refuted the assertions above with a
  // mutation: renaming the flag in the conf to a path the script never writes
  // kept every assertion green. "Both locations agree with each other" is not
  // "nginx reads the file the upgrade script raises" — the gate can silently
  // decouple from the script and the whole suite stays green while the real
  // upgrade window goes unshielded. So pin the conf to the script's own default,
  // parsed from its single source of truth (Resolve-MaintenanceFlagPath).
  const scriptDefaultRelative = (scriptSource.match(/-Relative '([^']*maintenance\.flag)'/) || [])[1]
  assert.ok(
    scriptDefaultRelative,
    'the upgrade script must derive its default flag path from one literal (Resolve-MaintenanceFlagPath -Relative ...) so this contract has something to pin against',
  )
  assert.equal(scriptDefaultRelative, 'output/maintenance.flag')
  for (const hit of flagPaths) {
    assert.ok(
      hit.replace(/\\/g, '/').endsWith(`/${scriptDefaultRelative}`),
      `the nginx example must test the very file the upgrade script raises (<RootDir>/${scriptDefaultRelative}), not merely a path both nginx locations happen to agree on: ${hit}`,
    )
  }

  // A missing maintenance page must degrade to 503, never to 404. error_page is
  // an internal redirect: with the file absent the static handler fails open to
  // 404 and recursive_error_pages (off by default) will not map it back to 503 —
  // and the page is NOT in the deployment package, so "absent" is the default
  // state of any freshly-built host.
  const pageBlock = conf.slice(conf.indexOf('location = /maintenance.html'))
  assert.match(
    pageBlock.slice(0, pageBlock.indexOf('}')),
    /try_files \$uri =503;/,
    'location = /maintenance.html must fall back to =503 when the page file is missing, otherwise the client gets a 404 during the upgrade window',
  )

  // Whoever ships the page inside the package may delete the hand-copy step; but
  // as long as it is NOT in the package, the runbook must say so in the same
  // breath as the `/` verification, or the operator verifies a page that was
  // never deployed and concludes the gate is broken.
  const buildScript = fs.readFileSync(path.join(repoRoot, 'scripts/ops/multitable-onprem-package-build.sh'), 'utf8')
  const pageIsPackaged = /"ops\/maintenance\/maintenance\.html"/.test(buildScript)
  if (!pageIsPackaged) {
    assert.match(
      fs.readFileSync(runbookPath, 'utf8'),
      /\*\*手工\*\*把仓库的 `ops\/maintenance\/maintenance\.html` 复制到/,
      'ops/maintenance/maintenance.html is not in the package REQUIRED_PATHS, so the runbook must tell the operator to copy it by hand',
    )
  }

  // Zero external references: during the window the backend is down and any
  // outbound asset request would hang or fail, defeating the page's purpose.
  assert.doesNotMatch(page, /<(?:script|link|img|iframe)\b/i, 'the maintenance page must not reference any external asset')
  assert.doesNotMatch(page, /https?:\/\//i, 'the maintenance page must not contain any absolute URL')
})

test('the runbook never tells an operator to expect 503 from / on 222, where only location /api has the gate', () => {
  // Adversarial verification (2026-09-11) found the runbook's "verify the gate
  // on 222" recipe asking for `curl.exe -i http://127.0.0.1/` -> 503, while the
  // SAME section documents that the only hand-synced blocks on 222 are the
  // /api/ gate, the server-level error_page and the named location. On 222 `/`
  // returns the SPA with 200, so the recipe would make an operator conclude,
  // mid upgrade window, that the gate is broken and start editing the live
  // nginx.conf — the single most dangerous thing to do in that window.
  const runbook = fs.readFileSync(runbookPath, 'utf8')
  const sectionStart = runbook.indexOf('## 升级窗口的维护门')
  assert.ok(sectionStart > -1, 'the runbook must keep the maintenance gate section')
  const section = runbook.slice(sectionStart, runbook.indexOf('\n## ', sectionStart + 10))

  const recipeStart = section.indexOf('**怎么验证这道门真的在')
  assert.ok(recipeStart > -1, 'the 222 verification recipe must exist')
  const newHostStart = section.indexOf('**新机器', recipeStart)
  assert.ok(newHostStart > recipeStart, 'the "new host, after syncing the example" expectations must be a SEPARATE sub-section from the 222 recipe')
  const liveRecipe = section.slice(recipeStart, newHostStart)

  // Only the copy-pasteable blocks matter here: the prose around them is free to
  // (and must) discuss `/` in order to warn that it answers 200 on 222.
  const copyPasteable = (liveRecipe.match(/```[\s\S]*?```/g) || []).join('\n')
  assert.ok(copyPasteable.includes('curl.exe'), 'the 222 recipe must still contain a runnable check')
  for (const line of copyPasteable.split('\n')) {
    if (!line.includes('curl.exe')) continue
    assert.ok(
      /127\.0\.0\.1\/api\//.test(line),
      `the 222 recipe may only probe /api/* — 222 has no gate on /, so any other URL here teaches a false expectation: ${line.trim()}`,
    )
  }
  assert.match(
    liveRecipe,
    /http:\/\/127\.0\.0\.1\/` 在 222 上期望的是 200,不是 503/,
    'the recipe must state outright that / answers 200 on 222 while the flag is up, so nobody "fixes" the live nginx.conf during a window',
  )
})

test('CI wiring: this test file is actually invoked by the required `test` job (P0 fix)', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  const testJobMatch = workflow.match(/\n {2}test:\n[\s\S]*?(?=\n {2}\S)/)
  assert.ok(testJobMatch, 'the required `test` job must exist in plugin-tests.yml')
  assert.match(
    testJobMatch[0],
    /node --test[^\n]*multitable-onprem-package-upgrade-inplace\.test\.mjs/,
    'this test file must be invoked by a `node --test` step inside the required `test` (18.x/20.x) job — ' +
      'a workflow that never runs it is a dead tripwire, the exact class of gap adversarial verification found',
  )
})

// ── 2. UNIT (dot-source the real script, call the real functions) ────────────────

function runPwshHarness(harness) {
  return spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', harness], { encoding: 'utf8' })
}

function dotSourcePrelude(scratchDir) {
  // -PackageArchive is mandatory but irrelevant when only defining functions;
  // pass a harmless placeholder and an explicit -RootDir so the RootDir
  // parameter default (which resolves PSScriptRoot) is never evaluated.
  return `. '${scriptPath}' -PackageArchive 'unused' -RootDir '${scratchDir}' *> $null\n`
}

test('Test-IsNodeModulesRelativePath matches only an exact node_modules path segment', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-unit-'))
  try {
    const harness =
      dotSourcePrelude(scratch) +
      [
        "Write-Host ('A=' + (Test-IsNodeModulesRelativePath -RelativePath 'lib\\node_modules\\pkg\\x.js'))",
        "Write-Host ('B=' + (Test-IsNodeModulesRelativePath -RelativePath 'node_modules\\pkg\\x.js'))",
        "Write-Host ('C=' + (Test-IsNodeModulesRelativePath -RelativePath 'lib\\stock-preparation-preflight.cjs'))",
        "Write-Host ('D=' + (Test-IsNodeModulesRelativePath -RelativePath 'lib\\legacy-node_modules-shim.cjs'))",
      ].join('\n')
    const result = runPwshHarness(harness)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /A=True/)
    assert.match(result.stdout, /B=True/)
    assert.match(result.stdout, /C=False/)
    // A FILE merely named similarly to node_modules (containing the substring,
    // not equal to it as a path segment) must NOT be treated as node_modules.
    assert.match(result.stdout, /D=False/)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('Copy-TreeExcludingNodeModules copies real files but skips every node_modules path (RED-witnessed)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-unit-'))
  try {
    const src = path.join(scratch, 'src')
    fs.mkdirSync(path.join(src, 'lib', 'adapters'), { recursive: true })
    fs.mkdirSync(path.join(src, 'node_modules', 'pkg'), { recursive: true })
    fs.mkdirSync(path.join(src, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(src, 'lib', 'adapters', 'deep.cjs'), 'module.exports = {}\n')
    fs.writeFileSync(path.join(src, 'lib', 'legacy-node_modules-shim.cjs'), 'module.exports = {}\n')
    fs.writeFileSync(path.join(src, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}\n')
    fs.writeFileSync(path.join(src, 'scripts', 'tool.mjs'), 'export {}\n')
    fs.writeFileSync(path.join(src, 'app.manifest.json'), '{}\n')

    const dst = path.join(scratch, 'dst')
    const harness =
      dotSourcePrelude(scratch) +
      [
        `$result = Copy-TreeExcludingNodeModules -Source '${src}' -Destination '${dst}'`,
        "Write-Host ('Copied=' + $result.Copied)",
        "Write-Host ('Skipped=' + $result.Skipped)",
      ].join('\n')
    const result = runPwshHarness(harness)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /Copied=4/, 'lib/adapters/deep.cjs, the decoy, scripts/tool.mjs, and app.manifest.json (4 total) must be copied')
    assert.match(result.stdout, /Skipped=1/, 'exactly the one real node_modules file must be skipped')

    assert.ok(fs.existsSync(path.join(dst, 'lib', 'adapters', 'deep.cjs')), 'F22 regression: deep nested files must survive the copy')
    assert.ok(fs.existsSync(path.join(dst, 'lib', 'legacy-node_modules-shim.cjs')), 'the substring decoy must be copied, not skipped')
    assert.ok(fs.existsSync(path.join(dst, 'scripts', 'tool.mjs')), 'sibling directories must not be dropped')
    assert.ok(fs.existsSync(path.join(dst, 'app.manifest.json')))
    assert.ok(!fs.existsSync(path.join(dst, 'node_modules', 'pkg', 'index.js')), 'node_modules must never be copied by this helper')
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('Test-PackageChecksum refuses a mismatched sidecar and accepts a matching one (RED-witnessed)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-unit-'))
  try {
    const archivePath = path.join(scratch, 'pkg.zip')
    fs.writeFileSync(archivePath, 'not-really-a-zip-but-bytes-are-bytes')
    const actualHash = createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex')

    fs.writeFileSync(`${archivePath}.sha256`, `${actualHash}  pkg.zip\n`)
    const okHarness =
      dotSourcePrelude(scratch) +
      `try { $h = Test-PackageChecksum -ArchivePath '${archivePath}'; Write-Host "OK=$h" } catch { Write-Host "THREW=$($_.Exception.Message)" }`
    const okResult = runPwshHarness(okHarness)
    assert.equal(okResult.status, 0, okResult.stderr || okResult.stdout)
    assert.match(okResult.stdout, new RegExp(`OK=${actualHash}`))

    fs.writeFileSync(`${archivePath}.sha256`, `${'0'.repeat(64)}  pkg.zip\n`)
    const badHarness =
      dotSourcePrelude(scratch) +
      `try { Test-PackageChecksum -ArchivePath '${archivePath}'; Write-Host "DID_NOT_THROW" } catch { Write-Host "THREW=$($_.Exception.Message)" }`
    const badResult = runPwshHarness(badHarness)
    assert.equal(badResult.status, 0, badResult.stderr || badResult.stdout)
    assert.doesNotMatch(badResult.stdout, /DID_NOT_THROW/)
    assert.match(badResult.stdout, /THREW=PACKAGE_CHECKSUM_MISMATCH/)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('Assert-MustExistFiles passes when complete and names every missing file otherwise (RED-witnessed)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-unit-'))
  try {
    fs.mkdirSync(path.join(scratch, 'plugins/plugin-integration-core/lib'), { recursive: true })
    fs.writeFileSync(path.join(scratch, 'plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs'), '{}')
    fs.writeFileSync(path.join(scratch, 'plugins/plugin-integration-core/app.manifest.json'), '{}')

    const okHarness =
      dotSourcePrelude(scratch) +
      `try { Assert-MustExistFiles -RootDir '${scratch}' -RelativePaths @('${PREFLIGHT_FILE}', '${MANIFEST_FILE}') | Out-Null; Write-Host 'OK' } catch { Write-Host "THREW=$($_.Exception.Message)" }`
    const okResult = runPwshHarness(okHarness)
    assert.equal(okResult.status, 0, okResult.stderr || okResult.stdout)
    assert.match(okResult.stdout, /^OK/m)

    fs.rmSync(path.join(scratch, 'plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs'))
    const badHarness =
      dotSourcePrelude(scratch) +
      `try { Assert-MustExistFiles -RootDir '${scratch}' -RelativePaths @('${PREFLIGHT_FILE}', '${MANIFEST_FILE}') | Out-Null; Write-Host 'DID_NOT_THROW' } catch { Write-Host "THREW=$($_.Exception.Message)" }`
    const badResult = runPwshHarness(badHarness)
    assert.equal(badResult.status, 0, badResult.stderr || badResult.stdout)
    assert.doesNotMatch(badResult.stdout, /DID_NOT_THROW/)
    assert.match(badResult.stdout, /THREW=UPGRADE_ASSERTION_MISSING_FILES/)
    assert.match(badResult.stdout, new RegExp(PREFLIGHT_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('Assert-PluginTreesMatchPackage passes on a matching tree, and throws on both a missing file and a hash mismatch (RED-witnessed)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-unit-'))
  try {
    const pkgRoot = path.join(scratch, 'pkg')
    const liveRoot = path.join(scratch, 'live')
    fs.mkdirSync(path.join(pkgRoot, 'plugins/plugin-integration-core/lib/adapters'), { recursive: true })
    fs.writeFileSync(path.join(pkgRoot, 'plugins/plugin-integration-core/lib/adapters/deep.cjs'), 'deep-content-1234')
    fs.writeFileSync(path.join(pkgRoot, 'plugins/plugin-integration-core/app.manifest.json'), '{}')
    fs.mkdirSync(path.join(liveRoot, 'plugins/plugin-integration-core/lib/adapters'), { recursive: true })
    fs.writeFileSync(path.join(liveRoot, 'plugins/plugin-integration-core/lib/adapters/deep.cjs'), 'deep-content-1234')
    fs.writeFileSync(path.join(liveRoot, 'plugins/plugin-integration-core/app.manifest.json'), '{}')

    const okHarness =
      dotSourcePrelude(scratch) +
      `try { $n = Assert-PluginTreesMatchPackage -PackageRoot '${pkgRoot}' -RootDir '${liveRoot}'; Write-Host "OK=$n" } catch { Write-Host "THREW=$($_.Exception.Message)" }`
    const okResult = runPwshHarness(okHarness)
    assert.equal(okResult.status, 0, okResult.stderr || okResult.stdout)
    assert.match(okResult.stdout, /OK=2/)

    // RED case 1: a missing deployed file (the historical F22 symptom, generalized
    // to ANY file, not just the one that happened to be missing that day).
    fs.rmSync(path.join(liveRoot, 'plugins/plugin-integration-core/lib/adapters/deep.cjs'))
    const missingHarness =
      dotSourcePrelude(scratch) +
      `try { Assert-PluginTreesMatchPackage -PackageRoot '${pkgRoot}' -RootDir '${liveRoot}'; Write-Host 'DID_NOT_THROW' } catch { Write-Host "THREW=$($_.Exception.Message)" }`
    const missingResult = runPwshHarness(missingHarness)
    assert.equal(missingResult.status, 0, missingResult.stderr || missingResult.stdout)
    assert.doesNotMatch(missingResult.stdout, /DID_NOT_THROW/)
    assert.match(missingResult.stdout, /THREW=UPGRADE_PLUGIN_HASH_VERIFICATION_FAILED/)
    assert.match(missingResult.stdout, /MISSING: plugin-integration-core.lib.adapters.deep\.cjs/)

    // RED case 2: same count, same path, WRONG content — the exact class a
    // file-count comparison can never see.
    fs.writeFileSync(path.join(liveRoot, 'plugins/plugin-integration-core/lib/adapters/deep.cjs'), 'CORRUPTED-DIFFERENT-CONTENT')
    const corruptHarness =
      dotSourcePrelude(scratch) +
      `try { Assert-PluginTreesMatchPackage -PackageRoot '${pkgRoot}' -RootDir '${liveRoot}'; Write-Host 'DID_NOT_THROW' } catch { Write-Host "THREW=$($_.Exception.Message)" }`
    const corruptResult = runPwshHarness(corruptHarness)
    assert.equal(corruptResult.status, 0, corruptResult.stderr || corruptResult.stdout)
    assert.doesNotMatch(corruptResult.stdout, /DID_NOT_THROW/)
    assert.match(corruptResult.stdout, /THREW=UPGRADE_PLUGIN_HASH_VERIFICATION_FAILED/)
    assert.match(corruptResult.stdout, /HASH_MISMATCH: plugin-integration-core.lib.adapters.deep\.cjs/)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('Assert-NoNodeModulesContentLeaked passes when node_modules content stays put, and throws when it leaks (RED-witnessed)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-unit-'))
  try {
    const pkgRoot = path.join(scratch, 'pkg')
    const liveRoot = path.join(scratch, 'live')
    fs.mkdirSync(path.join(pkgRoot, 'plugins/plugin-integration-core/node_modules/left-pad'), { recursive: true })
    fs.writeFileSync(path.join(pkgRoot, 'plugins/plugin-integration-core/node_modules/left-pad/index.js'), PACKAGE_LEAK_MARKER)
    fs.mkdirSync(path.join(liveRoot, 'plugins/plugin-integration-core/lib'), { recursive: true })
    fs.writeFileSync(path.join(liveRoot, 'plugins/plugin-integration-core/lib/clean.cjs'), 'unrelated content')

    const okHarness =
      dotSourcePrelude(scratch) +
      `try { $n = Assert-NoNodeModulesContentLeaked -PackageRoot '${pkgRoot}' -RootDir '${liveRoot}'; Write-Host "OK=$n" } catch { Write-Host "THREW=$($_.Exception.Message)" }`
    const okResult = runPwshHarness(okHarness)
    assert.equal(okResult.status, 0, okResult.stderr || okResult.stdout)
    assert.match(okResult.stdout, /OK=1/)

    // RED case: simulate the leak a forbidden -Exclude pattern actually produces —
    // the excluded content lands, uncorrupted, at some OTHER live path.
    fs.writeFileSync(path.join(liveRoot, 'plugins/plugin-integration-core/index.js'), PACKAGE_LEAK_MARKER)
    const leakHarness =
      dotSourcePrelude(scratch) +
      `try { Assert-NoNodeModulesContentLeaked -PackageRoot '${pkgRoot}' -RootDir '${liveRoot}'; Write-Host 'DID_NOT_THROW' } catch { Write-Host "THREW=$($_.Exception.Message)" }`
    const leakResult = runPwshHarness(leakHarness)
    assert.equal(leakResult.status, 0, leakResult.stderr || leakResult.stdout)
    assert.doesNotMatch(leakResult.stdout, /DID_NOT_THROW/)
    assert.match(leakResult.stdout, /THREW=UPGRADE_NODE_MODULES_LEAK_DETECTED/)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('Update-Plugins copies loose root files and, with -Force, a hidden plugin directory (RED-witnessed)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-unit-'))
  try {
    const pkgRoot = path.join(scratch, 'pkg')
    const liveRoot = path.join(scratch, 'live')
    // Loose file directly at plugins/ root — not inside any plugin subdirectory.
    fs.mkdirSync(path.join(pkgRoot, 'plugins'), { recursive: true })
    fs.writeFileSync(path.join(pkgRoot, 'plugins/README.txt'), 'loose-root-file')

    // A hidden plugin directory. Windows: a normal name, hidden via the NTFS
    // attribute (attrib +h). Non-Windows: pwsh's hidden-file convention is a
    // leading dot, so the directory is NAMED that way instead.
    const hiddenPluginName = process.platform === 'win32' ? 'hidden-plugin' : '.hidden-plugin'
    const hiddenPluginDir = path.join(pkgRoot, 'plugins', hiddenPluginName)
    fs.mkdirSync(hiddenPluginDir, { recursive: true })
    fs.writeFileSync(path.join(hiddenPluginDir, 'index.cjs'), 'hidden-plugin-content')
    if (process.platform === 'win32') {
      const attrib = spawnSync('attrib.exe', ['+h', hiddenPluginDir])
      assert.equal(attrib.status, 0, `attrib +h failed: ${attrib.stderr}`)
    }

    fs.mkdirSync(liveRoot, { recursive: true })

    const harness =
      dotSourcePrelude(scratch) +
      `Update-Plugins -PackageRoot '${pkgRoot}' -RootDir '${liveRoot}' *> $null`
    const result = runPwshHarness(harness)
    assert.equal(result.status, 0, result.stderr || result.stdout)

    assert.ok(
      fs.existsSync(path.join(liveRoot, 'plugins', 'README.txt')),
      'a loose file at the package plugins/ root must be copied, not silently dropped',
    )
    assert.equal(fs.readFileSync(path.join(liveRoot, 'plugins', 'README.txt'), 'utf8'), 'loose-root-file')
    assert.ok(
      fs.existsSync(path.join(liveRoot, 'plugins', hiddenPluginName, 'index.cjs')),
      'a hidden plugin directory must still be copied — the directory listing must use -Force',
    )
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('Write-RestoreBlock prints the backup path and an exact copy-back command per replaced path', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-unit-'))
  try {
    // Real, platform-native paths (not a hardcoded Windows drive letter): a bare
    // "C:\..." literal makes PowerShell try to resolve PSDrive 'C', which does not
    // exist on Linux pwsh ("Cannot find drive") even for a pure string Join-Path —
    // this test does not need the paths to exist, only to be valid on the host OS.
    const backupPath = path.join(scratch, 'backup', 'x')
    const rootDir = path.join(scratch, 'live')
    const harness =
      dotSourcePrelude(scratch) +
      `Write-RestoreBlock -BackupPath '${backupPath}' -RootDir '${rootDir}' -ReplacedRelativePaths @('packages/core-backend/dist', 'plugins') -Pm2AppName 'metasheet-backend'`
    const result = runPwshHarness(harness)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /RESTORE REQUIRED/)
    assert.ok(result.stdout.includes(`Backup path: ${backupPath}`))
    assert.ok(result.stdout.includes(`Copy-Item -LiteralPath '${path.join(backupPath, 'packages', 'core-backend', 'dist')}'`))
    assert.ok(result.stdout.includes(`Copy-Item -LiteralPath '${path.join(backupPath, 'plugins')}'`))
    assert.match(result.stdout, /pm2 restart metasheet-backend --update-env/)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('Assert-MaintenanceFlagOutsideReplaceDirs refuses a flag inside a replaced dir, accepts one outside it, and is not fooled by a sibling prefix (RED-witnessed)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-unit-'))
  try {
    const rootDir = path.join(scratch, 'live')
    fs.mkdirSync(rootDir, { recursive: true })
    const call = (rel) =>
      `try { Write-Host ('OK ' + (Assert-MaintenanceFlagOutsideReplaceDirs -FlagPath (Join-Path '${rootDir}' '${rel}') -RootDir '${rootDir}' -ReplaceDirs $dirs)) } catch { Write-Host ('THROWN ' + $_.Exception.Message) }`
    const harness =
      dotSourcePrelude(scratch) +
      [
        "$dirs = @('packages/core-backend/dist', 'apps/web/dist', 'packages/core-backend/migrations')",
        call('apps/web/dist/maintenance.flag'),
        call('packages/core-backend/dist/src/maintenance.flag'),
        call('output/maintenance.flag'),
        // A directory whose name merely STARTS WITH a replaced directory's name is
        // not inside it — the check must compare path segments, not raw prefixes.
        call('apps/web/dist-backup/maintenance.flag'),
      ].join('\n')
    const result = runPwshHarness(harness)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const lines = result.stdout.trim().split('\n').map((l) => l.trim())
    assert.match(lines[0], /^THROWN MAINTENANCE_FLAG_PATH_INSIDE_REPLACE_DIR/, 'a flag directly inside a replaced dir must be refused')
    assert.match(lines[1], /^THROWN MAINTENANCE_FLAG_PATH_INSIDE_REPLACE_DIR/, 'a flag nested deeper inside a replaced dir must be refused')
    assert.match(lines[2], /^OK /, 'output/ is outside every replaced dir and must be accepted')
    assert.ok(lines[2].includes('maintenance.flag'), 'the accepted call must return the resolved absolute path')
    assert.match(lines[3], /^OK /, 'a sibling directory sharing a name prefix must not be treated as inside')
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('Resolve-BackendHealthUrl derives 127.0.0.1:<PORT>/health from the env file, falls back, and yields to an explicit override', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-unit-'))
  try {
    const envWithPort = path.join(scratch, 'with-port.env')
    fs.writeFileSync(envWithPort, '# comment\nPORT=18901\nDATABASE_URL=postgres://x\n')
    const envWithoutPort = path.join(scratch, 'no-port.env')
    fs.writeFileSync(envWithoutPort, 'DATABASE_URL=postgres://x\n')
    const harness =
      dotSourcePrelude(scratch) +
      [
        `Write-Host ('DERIVED ' + (Resolve-BackendHealthUrl -EnvFile '${envWithPort}'))`,
        `Write-Host ('FALLBACK ' + (Resolve-BackendHealthUrl -EnvFile '${envWithoutPort}'))`,
        `Write-Host ('MISSINGFILE ' + (Resolve-BackendHealthUrl -EnvFile '${path.join(scratch, 'nope.env')}'))`,
        `Write-Host ('OVERRIDE ' + (Resolve-BackendHealthUrl -Candidate 'http://127.0.0.1:9/health' -EnvFile '${envWithPort}'))`,
      ].join('\n')
    const result = runPwshHarness(harness)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /DERIVED http:\/\/127\.0\.0\.1:18901\/health/)
    assert.match(result.stdout, /FALLBACK http:\/\/127\.0\.0\.1:8900\/health/)
    assert.match(result.stdout, /MISSINGFILE http:\/\/127\.0\.0\.1:8900\/health/)
    assert.match(result.stdout, /OVERRIDE http:\/\/127\.0\.0\.1:9\/health/)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

// ── R59 (2026-09-24): pm2-runtime hosting ──────────────────────────────────────
//
// The demo host's backend runs under a scheduled task (MetaSheet-PM2) that starts
// pm2-runtime with PM2_HOME=<user profile>\.pm2-runtime. The upgrade's stop took
// pm2-runtime's only app offline, pm2-runtime auto-exited (pm2's Runtime4Docker
// autoExitWorker: 0 apps online -> exit, killing its daemon), and the restart
// answered "Process or Namespace ... not found" -> RESTORE REQUIRED, ~18 min of
// 503 until the task was started by hand. See
// docs/development/takeover-beiliao-20260821/handoff-r59-two-machine-20260924.md §2.
//
// PowerShell resolves a FUNCTION before a cmdlet of the same name, so defining
// global Get-ScheduledTask / Start-ScheduledTask functions stubs the task
// scheduler identically on Windows PowerShell 5.1 (shadowing the real
// ScheduledTasks module) and on pwsh 7 / Linux (where the module does not exist).

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

// A temp dir whose path has no 8.3 short-name segments. The R59 tests compare the
// home the script resolved with the one the test built, and a Windows TEMP such as
// C:\Users\RUNNER~1\... (GitHub's Windows runners) would otherwise differ from the
// script's view only by short- vs long-name spelling (.NET Framework's GetFullPath
// expands short names). realpathSync.native returns the long form.
function mkLongTempDir(prefix) {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix))
}

// PowerShell source defining the two task-scheduler stubs. Every call is logged
// to taskLogPath as `get <name>` / `start <name>`.
//   taskPresent:  whether a task named taskName "exists".
//   startBehavior: 'start-runtime' (writes runtimeStartedMarker — the fixture's
//                  "pm2-runtime is up again") or 'throw' (the scheduler refuses).
//   strayDaemonMarkerPath: when given, every start also logs `start-saw-daemon=yes|no`:
//                  whether the pm2 stub's session-bound daemon was still there when
//                  the task started. With real pm2 on Windows, `yes` means the task's
//                  pm2-runtime attaches to that daemon as a client and the backend
//                  lives and dies with the upgrade session (verified with pm2 7.0.4).
function scheduledTaskStubSource({ taskName = 'MetaSheet-PM2', taskPresent, startBehavior = 'start-runtime', runtimeStartedMarker = null, taskLogPath, strayDaemonMarkerPath = null }) {
  const sawDaemonLine = strayDaemonMarkerPath
    ? `  Add-Content -LiteralPath ${psSingleQuote(taskLogPath)} -Value ('start-saw-daemon=' + $(if (Test-Path -LiteralPath ${psSingleQuote(strayDaemonMarkerPath)}) { 'yes' } else { 'no' }))`
    : ''
  const startBody =
    startBehavior === 'throw'
      ? "  throw 'STUB_TASK_SCHEDULER_REFUSED: the task could not be started'"
      : `  Set-Content -LiteralPath ${psSingleQuote(runtimeStartedMarker)} -Value 'runtime-started'`
  return [
    'function global:Get-ScheduledTask {',
    '  [CmdletBinding()]',
    '  param([string]$TaskName)',
    `  Add-Content -LiteralPath ${psSingleQuote(taskLogPath)} -Value ('get ' + $TaskName)`,
    `  if (${taskPresent ? '$true' : '$false'} -and $TaskName -eq ${psSingleQuote(taskName)}) {`,
    "    return [pscustomobject]@{ TaskName = $TaskName; State = 'Ready' }",
    '  }',
    `  throw "No MSFT_ScheduledTask objects found with property 'TaskName' equal to '$TaskName'."`,
    '}',
    'function global:Start-ScheduledTask {',
    '  [CmdletBinding()]',
    '  param([string]$TaskName)',
    `  Add-Content -LiteralPath ${psSingleQuote(taskLogPath)} -Value ('start ' + $TaskName)`,
    // Like the real cmdlet: starting a task that does not exist fails.
    `  if (-not (${taskPresent ? '$true' : '$false'} -and $TaskName -eq ${psSingleQuote(taskName)})) {`,
    `    throw "No MSFT_ScheduledTask objects found with property 'TaskName' equal to '$TaskName'."`,
    '  }',
    ...(sawDaemonLine ? [sawDaemonLine] : []),
    startBody,
    '}',
    '',
  ].join('\n')
}

function readLogLines(logPath) {
  if (!fs.existsSync(logPath)) return []
  return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

// `HOME=[<value>] <args>` lines written by the pm2 stub -> [{ home, command }].
function readPm2HomeLog(homeLogPath) {
  return readLogLines(homeLogPath).map((line) => {
    const match = line.match(/^HOME=\[(.*?)\]\s*(.*)$/)
    assert.ok(match, `unparseable pm2 home witness line: ${line}`)
    return { home: match[1], command: match[2].trim().split(/\s+/)[0] }
  })
}

test('Resolve-Pm2Home: -Pm2Home beats PM2_HOME beats the auto-detected .pm2-runtime, which needs BOTH the directory and the scheduled task; every home it returns is absolute (RED-witnessed)', () => {
  const scratch = mkLongTempDir('ms2-upgrade-unit-')
  try {
    const profileWithRuntime = path.join(scratch, 'profile-with-runtime')
    const runtimeHome = path.join(profileWithRuntime, '.pm2-runtime')
    fs.mkdirSync(runtimeHome, { recursive: true })
    const profileWithoutRuntime = path.join(scratch, 'profile-without-runtime')
    fs.mkdirSync(profileWithoutRuntime, { recursive: true })
    const explicitHome = path.join(scratch, 'explicit-home')
    fs.mkdirSync(explicitHome, { recursive: true })
    const envHome = path.join(scratch, 'env-home')
    const missingHome = path.join(scratch, 'no-such-home')
    // Relative values, resolved against the location the harness sets (scratch).
    const relativeHomeName = 'rel-home'
    fs.mkdirSync(path.join(scratch, relativeHomeName), { recursive: true })
    const relativeEnvHomeName = 'rel-env-home'

    const call = (label, { explicit = '', env = '', profile, task = 'MetaSheet-PM2', present }) =>
      [
        `$global:StubTaskPresent = ${present ? '$true' : '$false'}`,
        '$global:StubTaskQueries = 0',
        `try { $r = Resolve-Pm2Home -Explicit ${psSingleQuote(explicit)} -EnvValue ${psSingleQuote(env)} -UserProfileDir ${psSingleQuote(profile)} -ScheduledTaskName ${psSingleQuote(task)}; ` +
          `Write-Host ('${label}=' + $r.Source + '|' + $r.Home + '|' + $global:StubTaskQueries) } catch { Write-Host ('${label}=THREW ' + $_.Exception.Message) }`,
      ].join('\n')

    const harness =
      [
        'function global:Get-ScheduledTask {',
        '  [CmdletBinding()]',
        '  param([string]$TaskName)',
        '  $global:StubTaskQueries += 1',
        "  if ($global:StubTaskPresent -and $TaskName -eq 'MetaSheet-PM2') { return [pscustomobject]@{ TaskName = $TaskName } }",
        "  throw \"No MSFT_ScheduledTask objects found with property 'TaskName' equal to '$TaskName'.\"",
        '}',
        '',
      ].join('\n') +
      dotSourcePrelude(scratch) +
      [
        // 1. The explicit parameter wins over everything, without even asking the scheduler.
        call('A', { explicit: explicitHome, env: envHome, profile: profileWithRuntime, present: true }),
        // 2. PM2_HOME from the environment wins over auto-detection.
        call('B', { env: envHome, profile: profileWithRuntime, present: true }),
        // 3. Auto-detection: .pm2-runtime AND the scheduled task.
        call('C', { profile: profileWithRuntime, present: true }),
        // 4. The directory alone is not enough...
        call('D', { profile: profileWithRuntime, present: false }),
        // 5. ...nor is the task alone — and without the directory the scheduler is never asked.
        call('E', { profile: profileWithoutRuntime, present: true }),
        // 6. An empty task name disables auto-detection.
        call('F', { profile: profileWithRuntime, task: '', present: true }),
        // 7. A whitespace-only -Pm2Home is "not given", not a path.
        call('G', { explicit: '   ', env: envHome, profile: profileWithRuntime, present: true }),
        // 8. An explicit home that does not exist is refused, not silently created by pm2.
        call('H', { explicit: missingHome, profile: profileWithRuntime, present: true }),
        // 9. A relative -Pm2Home comes back ABSOLUTE, resolved against the location its
        //    existence was checked in: Main later Set-Locations to RootDir, a native child
        //    inherits that as its cwd, and pm2 resolves a relative PM2_HOME against its cwd.
        `Push-Location ${psSingleQuote(scratch)}`,
        call('I', { explicit: relativeHomeName, profile: profileWithRuntime, present: true }),
        // 10. The same for a relative PM2_HOME from the environment (which need not exist).
        call('K', { env: relativeEnvHomeName, profile: profileWithRuntime, present: true }),
        'Pop-Location',
        // 11. A container that is not a file-system directory passes Test-Path -PathType
        //     Container but is no pm2 home (Env:\ exists on every platform; so would HKCU:\).
        call('J', { explicit: 'Env:\\', profile: profileWithRuntime, present: true }),
      ].join('\n')

    const result = runPwshHarness(harness)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const line = (label) => (result.stdout.split(/\r?\n/).find((l) => l.startsWith(`${label}=`)) || '').slice(label.length + 1)

    assert.equal(line('A'), `parameter -Pm2Home|${explicitHome}|0`)
    assert.equal(line('B'), `environment PM2_HOME|${envHome}|0`)
    assert.equal(line('C'), `pm2-runtime (.pm2-runtime + scheduled task 'MetaSheet-PM2')|${runtimeHome}|1`)
    assert.equal(line('D'), 'default (.pm2-runtime exists but no such scheduled task)||1')
    assert.equal(line('E'), 'default||0', 'with no .pm2-runtime directory the scheduler must not even be queried')
    assert.equal(line('F'), 'default||0')
    assert.equal(line('G'), `environment PM2_HOME|${envHome}|0`)
    assert.match(line('H'), /^THREW PM2_HOME_NOT_FOUND/)
    assert.equal(line('I'), `parameter -Pm2Home|${path.join(scratch, relativeHomeName)}|0`, 'a relative -Pm2Home must come back absolute')
    assert.equal(line('K'), `environment PM2_HOME|${path.join(scratch, relativeEnvHomeName)}|0`, 'a relative PM2_HOME must come back absolute')
    assert.match(line('J'), /^THREW PM2_HOME_NOT_FOUND/)
    if (process.platform === 'win32') {
      // Where Env:\ is known to pass the Container check (Windows PowerShell 5.1 and
      // pwsh 7 on Windows, both verified), it must be the provider check that refuses it.
      assert.match(line('J'), /not a file-system directory \(provider: Environment\)/)
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('Invoke-Pm2 runs pm2 under the given PM2_HOME for that one call and restores the caller\'s PM2_HOME afterwards; an empty home leaves PM2_HOME alone', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-unit-'))
  try {
    const liveRoot = path.join(scratch, 'live')
    const pm2LogPath = path.join(scratch, 'pm2-calls.log')
    const homeLogPath = path.join(scratch, 'pm2-home.log')
    const stubPath = writePm2Stub(liveRoot, pm2LogPath, null, { homeLogPath, restartNeedsHomeMarker: true })
    const runtimeHome = path.join(scratch, 'runtime-home')
    fs.mkdirSync(runtimeHome, { recursive: true })

    const harness =
      dotSourcePrelude(scratch) +
      [
        "Remove-Item -LiteralPath 'Env:PM2_HOME' -ErrorAction SilentlyContinue",
        `$r = Invoke-Pm2 -Pm2Command ${psSingleQuote(stubPath)} -Arguments @('stop', 'metasheet-backend') -Pm2Home ${psSingleQuote(runtimeHome)}`,
        "Write-Host ('A_EXIT=' + $r.ExitCode + ' A_AFTER_SET=' + (Test-Path -LiteralPath 'Env:PM2_HOME'))",
        "$env:PM2_HOME = 'caller-home'",
        `$r = Invoke-Pm2 -Pm2Command ${psSingleQuote(stubPath)} -Arguments @('restart', 'metasheet-backend', '--update-env') -Pm2Home ${psSingleQuote(runtimeHome)}`,
        "Write-Host ('B_EXIT=' + $r.ExitCode + ' B_AFTER=' + $env:PM2_HOME + ' B_NOTFOUND=' + (Test-Pm2ProcessNotFound -Output $r.Output))",
        `$r = Invoke-Pm2 -Pm2Command ${psSingleQuote(stubPath)} -Arguments @('restart', 'metasheet-backend', '--update-env')`,
        "Write-Host ('C_EXIT=' + $r.ExitCode + ' C_AFTER=' + $env:PM2_HOME)",
      ].join('\n')
    const result = runPwshHarness(harness)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /A_EXIT=0 A_AFTER_SET=False/, 'a PM2_HOME that was unset before the call must be unset again after it')
    // No pm2-app-alive.marker in runtimeHome: the stub answers "not found" on stderr,
    // and Invoke-Pm2 must hand back both the exit code and that stderr text (5.1
    // would otherwise raise a NativeCommandError under the script's 'Stop').
    assert.match(result.stdout, /B_EXIT=1 B_AFTER=caller-home B_NOTFOUND=True/)
    assert.match(result.stdout, /C_EXIT=1 C_AFTER=caller-home/)
    assert.match(result.stdout, /Process or Namespace metasheet-backend not found/, 'pm2 output must still reach the operator log')

    const homes = readPm2HomeLog(homeLogPath)
    assert.deepEqual(
      homes.map((entry) => `${entry.command}@${entry.home}`),
      [`stop@${runtimeHome}`, `restart@${runtimeHome}`, 'restart@caller-home'],
      'a given home applies to exactly its own call; with no home the caller\'s PM2_HOME passes through untouched',
    )
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('Test-Pm2DaemonPipePresent / Wait-Pm2DaemonPipeClosed: on Windows they see a listening pipe by name without connecting to it and report still-open / closed; elsewhere always closed', async () => {
  const scratch = mkLongTempDir('ms2-upgrade-unit-')
  // A pipe of our own, never pm2's real \\.\pipe\rpc.sock: that name is machine-wide
  // and must not be touched by a test.
  const pipeName = `ms2-upgrade-inplace-test-${process.pid}-${Date.now()}`
  let server = null
  let connections = 0
  if (process.platform === 'win32') {
    server = net.createServer((socket) => {
      connections += 1
      socket.destroy()
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(`\\\\.\\pipe\\${pipeName}`, resolve)
    })
  }
  try {
    const harness =
      dotSourcePrelude(scratch) +
      [
        `Write-Host ('LIVE=' + (Test-Pm2DaemonPipePresent -PipeName ${psSingleQuote(pipeName)}))`,
        `Write-Host ('ABSENT=' + (Test-Pm2DaemonPipePresent -PipeName ${psSingleQuote(`${pipeName}-absent`)}))`,
        `$t0 = Get-Date; $s = Wait-Pm2DaemonPipeClosed -PipeName ${psSingleQuote(pipeName)} -TimeoutSec 1; ` +
          "Write-Host ('WAIT_LIVE=' + $s + ' ELAPSED_MS=' + [int]((Get-Date) - $t0).TotalMilliseconds)",
        `Write-Host ('WAIT_ABSENT=' + (Wait-Pm2DaemonPipeClosed -PipeName ${psSingleQuote(`${pipeName}-absent`)} -TimeoutSec 1))`,
      ].join('\n')
    const result = await runPwshHarnessAsync(harness)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    if (process.platform === 'win32') {
      assert.match(result.stdout, /LIVE=True/)
      assert.match(result.stdout, /ABSENT=False/)
      const waited = result.stdout.match(/WAIT_LIVE=still-open ELAPSED_MS=(\d+)/)
      assert.ok(waited, `a pipe that stays open must end the wait as still-open:\n${result.stdout}`)
      assert.ok(Number(waited[1]) >= 900, `the wait must actually last its timeout, took ${waited[1]} ms`)
      assert.match(result.stdout, /WAIT_ABSENT=closed/)
      assert.equal(connections, 0, 'listing the pipe namespace must never connect to the daemon behind it')
    } else {
      // pm2's sockets are files inside PM2_HOME off Windows, and `pm2 kill` there
      // returns only after the daemon's SIGQUIT: nothing to wait for.
      assert.match(result.stdout, /LIVE=False/)
      assert.match(result.stdout, /ABSENT=False/)
      assert.match(result.stdout, /WAIT_LIVE=closed/)
      assert.match(result.stdout, /WAIT_ABSENT=closed/)
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

// spawnSync blocks this process's event loop, so a node http server in the same
// process could never answer a harness started with runPwshHarness. Anything that
// needs the two to talk must use this async variant.
function runPwshHarnessAsync(harness) {
  return new Promise((resolve) => {
    const child = spawn(PWSH, ['-NoProfile', '-NonInteractive', '-Command', harness])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

test('Test-MaintenanceGateWired separates a wired gate (503) from an inert flag (200) and from an unreachable nginx, and never throws', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-unit-'))
  const server = http.createServer((req, res) => {
    // /wired/* impersonates an nginx that really reads the flag; every other
    // path impersonates one whose conf was never synced.
    if (req.url.startsWith('/wired')) {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '90' })
      res.end('{"error":{"code":"SERVICE_UNAVAILABLE"}}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const flagPath = path.join(scratch, 'maintenance.flag')
    fs.writeFileSync(flagPath, 'raised')
    const harness =
      dotSourcePrelude(scratch) +
      [
        `Write-Host ('A=' + (Test-MaintenanceGateWired -ProbeUrl 'http://127.0.0.1:${port}/wired/api/health' -FlagPath '${flagPath}'))`,
        `Write-Host ('B=' + (Test-MaintenanceGateWired -ProbeUrl 'http://127.0.0.1:${port}/api/health' -FlagPath '${flagPath}'))`,
        // Port 1: connection refused — a transport failure, NOT evidence either way.
        `Write-Host ('C=' + (Test-MaintenanceGateWired -ProbeUrl 'http://127.0.0.1:1/api/health' -FlagPath '${flagPath}'))`,
        "Write-Host 'SURVIVED'",
      ].join('\n')
    const result = await runPwshHarnessAsync(harness)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /A=WIRED/, '503 while the flag is up is the only positive proof that this host reads the flag')
    assert.match(result.stdout, /B=NOT_WIRED/, '200 while the flag is up proves the conf was never synced here')
    assert.match(result.stdout, /C=UNKNOWN/, 'an unreachable endpoint must not be reported as either wired or unwired')
    assert.match(result.stdout, /MAINTENANCE_GATE_NOT_WIRED/, 'the 200 case must be loud enough for an operator to notice in the log')
    assert.match(
      result.stdout,
      /SURVIVED/,
      'the probe is a diagnostic, never a guard: refusing to upgrade a host whose nginx.conf was never synced would be worse than upgrading it unshielded',
    )
  } finally {
    server.close()
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('Main structure: the gate is validated before anything runs, raised before pm2 stop, and dropped by an unconditional finally', () => {
  const mainStart = scriptSource.indexOf("if ($MyInvocation.InvocationName -ne '.') {")
  const main = scriptSource.slice(mainStart)

  const assertIdx = main.indexOf('Assert-MaintenanceFlagOutsideReplaceDirs -FlagPath $maintenanceFlagPath')
  const raiseIdx = main.indexOf('New-MaintenanceFlag -FlagPath $maintenanceFlagPath')
  const stopIdx = main.indexOf('Stop-Pm2App -Pm2Command $pm2Command -Name $Pm2AppName')
  const backupRootIdx = main.indexOf('New-Item -ItemType Directory -Force -Path $resolvedBackupRoot')
  assert.ok(assertIdx > -1, 'Main must validate the flag path, not just resolve it')
  assert.ok(raiseIdx > -1 && stopIdx > -1)
  assert.ok(assertIdx < backupRootIdx, 'the flag-path refusal must come before ANY directory is created')
  assert.ok(assertIdx < raiseIdx, 'the path must be validated before the flag is written')
  assert.ok(raiseIdx < stopIdx, 'the gate must be raised before the backend is stopped')

  // THE INVARIANT THAT HAD NO GUARD: "once the flag is up, the finally owns it".
  // A raise sitting even two statements ABOVE `try {` still passes every
  // ordering assertion above, yet any throw between the write and the try --
  // or an early `exit` from a gate that has not run yet -- leaves the flag on
  // disk forever, i.e. a permanently 503 site. So: the checksum gate (the one
  // pre-try step that legitimately refuses) must run BEFORE the raise, the
  // raise must sit INSIDE the try, and nothing that can throw may separate
  // `try {` from the raise.
  const checksumIdx = main.indexOf('$verifiedSha = Test-PackageChecksum')
  const tryIdx = main.indexOf('try {')
  assert.ok(checksumIdx > -1 && tryIdx > -1)
  assert.ok(
    checksumIdx < raiseIdx,
    'the checksum refusal must come BEFORE the gate is raised: it exits without running any finally',
  )
  assert.ok(
    tryIdx < raiseIdx,
    'the gate must be raised INSIDE the try whose finally drops it -- a pre-try raise survives every throw before `try {`',
  )
  const betweenTryAndRaise = main.slice(tryIdx + 'try {'.length, raiseIdx)
  const executableBetween = betweenTryAndRaise
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.deepEqual(
    executableBetween,
    [],
    'nothing that can throw may sit between `try {` and the raise -- the window it opens is exactly the one the finally cannot close',
  )

  // The positive self-witness: probe the PUBLIC url once while the flag is up
  // and the backend is still serving. Only that window can distinguish "nginx
  // reads this flag" (503) from "this host never got the conf" (200) — after
  // pm2 is stopped a 503 could just as well be a dead upstream. Without it the
  // run prints "maintenance flag: ... (removed)" on hosts where the flag is
  // inert, which reads like proof the window was shielded.
  const gateProbeIdx = main.indexOf('Test-MaintenanceGateWired -ProbeUrl $HealthUrl -FlagPath $maintenanceFlagPath')
  assert.ok(gateProbeIdx > -1, 'Main must probe the public URL to prove the gate is actually wired on this host')
  assert.ok(raiseIdx < gateProbeIdx, 'the gate probe is meaningless before the flag exists')
  assert.ok(
    gateProbeIdx < stopIdx,
    'the gate probe must run BEFORE pm2 is stopped: with the backend down, a 503 no longer distinguishes "the gate answered" from "the upstream is dead"',
  )
  const finallyIdxForProbe = main.lastIndexOf('} finally {')
  assert.ok(gateProbeIdx < finallyIdxForProbe && gateProbeIdx > main.indexOf('try {'), 'the probe must sit inside the try whose finally drops the flag')

  const finallyIdx = main.lastIndexOf('} finally {')
  assert.ok(finallyIdx > stopIdx, 'the pm2 stop and everything after it must sit inside the try whose finally drops the gate')
  const finallyBlock = main.slice(finallyIdx)
  assert.match(
    finallyBlock,
    /Remove-MaintenanceFlag -FlagPath \$maintenanceFlagPath/,
    'the outermost finally must delete the flag unconditionally — success, refusal, or exception',
  )

  // Order inside step 7: backend-direct probe, then the removal, then nginx.
  const backendProbeIdx = main.indexOf('-HealthUrl $resolvedBackendHealthUrl')
  const successRemovalIdx = main.indexOf('Remove-MaintenanceFlag -FlagPath $maintenanceFlagPath')
  const nginxProbeIdx = main.indexOf("-Label 'Nginx healthcheck'")
  assert.ok(backendProbeIdx > -1 && successRemovalIdx > -1 && nginxProbeIdx > -1)
  assert.ok(
    backendProbeIdx < successRemovalIdx && successRemovalIdx < nginxProbeIdx,
    'the flag must be dropped BETWEEN the backend-direct probe and the nginx probe (r29): probing nginx while the ' +
      'gate is up makes the script fail its own healthcheck against a healthy backend',
  )
})

test('R59 wiring: pm2 is invoked in exactly one place (Invoke-Pm2), and every pm2 call site in Main passes the one resolved home', () => {
  // PowerShell variable names are case-insensitive: $pm2Command and $Pm2Command
  // are the same variable, so the scan must be too.
  const invocations = scriptCodeOnly.match(/&\s*\$pm2Command\b/gi) || []
  assert.equal(invocations.length, 1, `pm2 must be run from exactly one place, found: ${JSON.stringify(invocations)}`)
  const invokeStart = scriptCodeOnly.indexOf('function Invoke-Pm2 {')
  const invokeEnd = scriptCodeOnly.indexOf('\nfunction ', invokeStart + 1)
  assert.ok(invokeStart > -1 && invokeEnd > invokeStart)
  const invokeBody = scriptCodeOnly.slice(invokeStart, invokeEnd)
  assert.match(
    invokeBody,
    /&\s*\$Pm2Command @Arguments 2>&1/,
    'the single pm2 invocation must live inside Invoke-Pm2, which applies PM2_HOME around it',
  )
  // The line R59's fix rests on, pinned statically because only Windows PowerShell 5.1
  // can fail on it at runtime (pwsh 7.2+ never turns native stderr into an error
  // record): under the script's global 'Stop', 5.1 turns pm2's stderr "not found" into
  // a terminating NativeCommandError, losing the exit code and the text the fallback
  // needs -- the exact R59 incident. It must be 'Continue', set before the call, with
  // nothing re-assigning it in between.
  const callIdx = invokeBody.search(/&\s*\$Pm2Command @Arguments 2>&1/)
  const eapIdx = invokeBody.search(/\$ErrorActionPreference\s*=\s*['"]Continue['"]/i)
  assert.ok(eapIdx > -1, "Invoke-Pm2 must set $ErrorActionPreference = 'Continue' for the pm2 call")
  assert.ok(eapIdx < callIdx, "Invoke-Pm2 must set $ErrorActionPreference = 'Continue' BEFORE running pm2")
  assert.doesNotMatch(
    invokeBody.slice(eapIdx + 1, callIdx),
    /\$ErrorActionPreference/i,
    'nothing may re-assign $ErrorActionPreference between the Continue and the pm2 call',
  )

  // The fallback kills the empty daemon the "not found" restart left in this session,
  // waits for pm2's machine-wide pipe to close, and only then starts the task -- in
  // that order, with a still-open pipe refusing to start the task at all.
  const restartStart = scriptCodeOnly.indexOf('function Restart-Pm2AppOrScheduledTask {')
  const restartEnd = scriptCodeOnly.indexOf('\nfunction ', restartStart + 1)
  assert.ok(restartStart > -1 && restartEnd > restartStart)
  const restartBody = scriptCodeOnly.slice(restartStart, restartEnd)
  const killIdx = restartBody.search(/Invoke-Pm2 -Pm2Command \$Pm2Command -Arguments @\('kill'\) -Pm2Home \$Pm2Home/)
  const waitIdx = restartBody.indexOf('$pipeState = Wait-Pm2DaemonPipeClosed')
  const stillOpenIdx = restartBody.search(/if \(\$pipeState -eq 'still-open'\) \{\s*throw "PM2_DAEMON_STILL_RUNNING/)
  const startIdx = restartBody.indexOf('Start-ScheduledTask -TaskName $ScheduledTaskName')
  assert.ok(killIdx > -1, 'the fallback must `pm2 kill` under the resolved home')
  assert.ok(waitIdx > -1 && stillOpenIdx > -1 && startIdx > -1)
  assert.ok(killIdx < waitIdx && waitIdx < stillOpenIdx && stillOpenIdx < startIdx, 'kill, then wait for the pipe, then refuse or start the task')
  assert.match(
    restartBody.slice(waitIdx, waitIdx + 60),
    /Wait-Pm2DaemonPipeClosed\s*\r?\n/,
    "the fallback must wait on pm2's own pipe (the default -PipeName), not a test pipe",
  )
  assert.match(scriptCodeOnly, /function Test-Pm2DaemonPipePresent \{\s*param\(\[string\]\$PipeName = 'rpc\.sock'\)/)
  assert.match(scriptCodeOnly, /function Wait-Pm2DaemonPipeClosed \{[\s\S]*?\[string\]\$PipeName = 'rpc\.sock'/)

  const main = scriptSource.slice(scriptSource.indexOf("if ($MyInvocation.InvocationName -ne '.') {"))
  const stopCalls = main.match(/Stop-Pm2App -Pm2Command[^\n]*/g) || []
  assert.equal(stopCalls.length, 2, 'Main stops pm2 twice: step 2 and the failure handler')
  for (const call of stopCalls) {
    assert.match(call, /-Pm2Home \$resolvedPm2Home\b/, `every stop must run under the resolved pm2 home: ${call}`)
  }
  assert.match(
    main,
    /Restart-Pm2AppOrScheduledTask -Pm2Command \$pm2Command -Name \$Pm2AppName -Pm2Home \$resolvedPm2Home -ScheduledTaskName \$Pm2ScheduledTaskName/,
  )
  // Resolved before anything is touched: before the backup root is created and
  // before the gate goes up.
  const resolveIdx = main.indexOf('Resolve-Pm2Home -Explicit $Pm2Home -EnvValue $env:PM2_HOME')
  assert.ok(resolveIdx > -1)
  assert.ok(resolveIdx < main.indexOf('New-Item -ItemType Directory -Force -Path $resolvedBackupRoot'))
  assert.ok(resolveIdx < main.indexOf('New-MaintenanceFlag -FlagPath $maintenanceFlagPath'))
})

// ── 3. END-TO-END: the acid fixture ───────────────────────────────────────────────
//
// Deep nesting (depth>=3 under lib/), a decoy whose NAME contains "node_modules" as
// a substring but is not inside one, a package-side node_modules that must be
// skipped, a live-side node_modules that must survive, and a loose file at plugins/
// root — every shape the verifiers found the original, shallow fixtures could not
// reproduce F22 against.

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function writeFixtureFile(root, rel, contents) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, contents)
}

function buildAcidPackageStage(stageDir, { omitPreflightFile = false } = {}) {
  writeFixtureFile(stageDir, 'PACKAGE-METADATA.json', JSON.stringify({ name: 'acid-fixture-package' }, null, 2))
  writeFixtureFile(stageDir, 'apps/web/dist/index.html', '<html>NEW WEB DIST</html>\n')
  writeFixtureFile(
    stageDir,
    'packages/core-backend/dist/src/db/migrate.js',
    [
      "const fs = require('fs')",
      "const marker = process.env.UPGRADE_TEST_ENV_MARKER || 'MISSING'",
      "if (process.env.UPGRADE_TEST_MIGRATE_MARKER_PATH) fs.writeFileSync(process.env.UPGRADE_TEST_MIGRATE_MARKER_PATH, marker)",
      "console.log('migrate-ok marker=' + marker)",
    ].join('\n'),
  )
  writeFixtureFile(stageDir, 'packages/core-backend/migrations/001_new.sql', 'select 1;\n')

  // Loose file directly at plugins/ root.
  writeFixtureFile(stageDir, LOOSE_ROOT_FILE, 'PACKAGE_LOOSE_ROOT_FILE')

  writeFixtureFile(stageDir, 'plugins/plugin-integration-core/index.cjs', "module.exports = { name: 'plugin-integration-core' }\n")
  writeFixtureFile(stageDir, 'plugins/plugin-integration-core/app.manifest.json', JSON.stringify({ id: 'plugin-integration-core' }))
  if (!omitPreflightFile) {
    writeFixtureFile(stageDir, PREFLIGHT_FILE, 'module.exports = {}\n')
  }
  // Depth>=3 under lib/ (lib -> adapters -> legacy -> file), mirroring the real
  // package's lib/adapters/ shape one level deeper.
  writeFixtureFile(stageDir, DEEP_ADAPTER_FILE, 'module.exports = { deep: true }\n')
  // Decoy: filename CONTAINS "node_modules" as a substring, but is a plain file in
  // lib/, not inside an actual node_modules directory — must be copied, not skipped.
  writeFixtureFile(stageDir, DECOY_FILE, 'module.exports = { decoy: true }\n')
  // Package-side node_modules — must never reach the deployed tree, anywhere.
  writeFixtureFile(stageDir, PACKAGE_NODE_MODULES_FILE, PACKAGE_LEAK_MARKER)
}

// The maintenance gate must be UP before the backend goes down. The pm2 stub is
// the only witness that can see that ordering from the outside: it records, at the
// instant pm2 is actually invoked, whether the flag file already exists. A run that
// raises the flag after stopping pm2 (or never) writes FLAG_ABSENT on the stop call.
function maintenanceWitnessPaths(root, liveRoot) {
  return {
    flagPath: path.join(liveRoot, 'output', 'maintenance.flag'),
    pm2FlagWitnessPath: path.join(root, 'pm2-flag-witness.log'),
  }
}

function readPm2FlagWitness(witnessPath) {
  if (!fs.existsSync(witnessPath)) return []
  return fs.readFileSync(witnessPath, 'utf8').trim().split('\n').map((line) => line.trim()).filter(Boolean)
}

// The file whose presence INSIDE a pm2 home tells the pm2 stub "a daemon holding
// the app lives in this home". Absent = the R59 shape: pm2-runtime auto-exited
// after the stop took its only app offline, so a restart finds nothing.
const PM2_APP_ALIVE_MARKER = 'pm2-app-alive.marker'

// pm2Behavior (optional, all fields optional):
//   homeLogPath             — every call appends `HOME=[<PM2_HOME as the stub saw it>] <args>`,
//                             the witness for "every pm2 call ran under the resolved home".
//   restartNeedsHomeMarker  — `restart` succeeds only when PM2_HOME is set AND
//                             <PM2_HOME>/pm2-app-alive.marker exists; otherwise it prints pm2's own
//                             "[PM2][ERROR] Process or Namespace <name> not found" on STDERR and exits 1.
//   restartOtherError       — `restart` always fails with an error that is NOT "not found"
//                             ("[PM2][ERROR] spawn EPERM" on stderr, exit 1).
//   strayDaemonMarkerPath   — models the machine-wide pm2 daemon a CLI call leaves behind: a
//                             "not found" restart (a CLI call that found no daemon) prints pm2's
//                             "Spawning PM2 daemon" line and creates this file; `pm2 kill` deletes it.
//                             The Start-ScheduledTask stub reads it to record whether the task's
//                             pm2-runtime would have found (and attached to) that session-bound daemon.
// Without pm2Behavior the stub is exactly the historical one: every call exits 0.
function writePm2Stub(liveRoot, pm2LogPath, witness = null, pm2Behavior = {}) {
  const { homeLogPath = null, restartNeedsHomeMarker = false, restartOtherError = false, strayDaemonMarkerPath = null } = pm2Behavior
  const binDir = path.join(liveRoot, 'node_modules', '.bin')
  fs.mkdirSync(binDir, { recursive: true })
  const stubPath = path.join(binDir, 'pm2.cmd')
  if (process.platform === 'win32') {
    const witnessLine = witness
      ? `if exist "${witness.flagPath}" (echo FLAG_PRESENT %* >> "${witness.pm2FlagWitnessPath}") else (echo FLAG_ABSENT %* >> "${witness.pm2FlagWitnessPath}")`
      : 'rem no maintenance-flag witness requested'
    const homeLine = homeLogPath ? `echo HOME=[%PM2_HOME%] %* >> "${homeLogPath}"` : 'rem no pm2-home witness requested'
    const killLines = strayDaemonMarkerPath
      ? [
          'if /i not "%1"=="kill" goto afterkill',
          `if exist "${strayDaemonMarkerPath}" del /f /q "${strayDaemonMarkerPath}"`,
          'echo [PM2] [v] PM2 Daemon Stopped',
          'exit /b 0',
          ':afterkill',
        ]
      : []
    const spawnLines = strayDaemonMarkerPath
      ? ['echo [PM2] Spawning PM2 daemon with pm2_home=%PM2_HOME%', `echo spawned> "${strayDaemonMarkerPath}"`]
      : []
    const restartLines = restartOtherError
      ? ['if /i not "%1"=="restart" exit /b 0', 'echo [PM2][ERROR] spawn EPERM 1>&2', 'exit /b 1']
      : restartNeedsHomeMarker
      ? [
          'if /i not "%1"=="restart" exit /b 0',
          'if not defined PM2_HOME goto notfound',
          `if not exist "%PM2_HOME%\\${PM2_APP_ALIVE_MARKER}" goto notfound`,
          'exit /b 0',
          ':notfound',
          ...spawnLines,
          'echo [PM2][ERROR] Process or Namespace %2 not found 1>&2',
          'exit /b 1',
        ]
      : ['exit /b 0']
    fs.writeFileSync(stubPath, ['@echo off', `echo %* >> "${pm2LogPath}"`, witnessLine, homeLine, ...killLines, ...restartLines, ''].join('\r\n'))
  } else {
    // pwsh's `&` call operator execs the file directly on non-Windows — the .cmd
    // extension is irrelevant there, only the shebang and the executable bit are.
    // Same relative path on both OSes, so Resolve-Pm2Command in the script needs
    // no platform branching of its own.
    const witnessLine = witness
      ? `if [ -f "${witness.flagPath}" ]; then echo "FLAG_PRESENT $*" >> "${witness.pm2FlagWitnessPath}"; else echo "FLAG_ABSENT $*" >> "${witness.pm2FlagWitnessPath}"; fi\n`
      : ''
    const homeLine = homeLogPath ? `echo "HOME=[$PM2_HOME] $*" >> "${homeLogPath}"\n` : ''
    const killLines = strayDaemonMarkerPath
      ? `if [ "$1" = "kill" ]; then\n  rm -f "${strayDaemonMarkerPath}"\n  echo "[PM2] [v] PM2 Daemon Stopped"\n  exit 0\nfi\n`
      : ''
    const spawnLines = strayDaemonMarkerPath
      ? ['    echo "[PM2] Spawning PM2 daemon with pm2_home=$PM2_HOME"', `    echo spawned > "${strayDaemonMarkerPath}"`]
      : []
    const restartLines = restartOtherError
      ? 'if [ "$1" = "restart" ]; then\n  echo "[PM2][ERROR] spawn EPERM" >&2\n  exit 1\nfi\n'
      : restartNeedsHomeMarker
      ? [
          'if [ "$1" = "restart" ]; then',
          `  if [ -z "$PM2_HOME" ] || [ ! -f "$PM2_HOME/${PM2_APP_ALIVE_MARKER}" ]; then`,
          ...spawnLines,
          '    echo "[PM2][ERROR] Process or Namespace $2 not found" >&2',
          '    exit 1',
          '  fi',
          'fi',
          '',
        ].join('\n')
      : ''
    fs.writeFileSync(stubPath, `#!/bin/sh\necho "$*" >> "${pm2LogPath}"\n${witnessLine}${homeLine}${killLines}${restartLines}exit 0\n`)
    fs.chmodSync(stubPath, 0o755)
  }
  return stubPath
}

function buildAcidLiveRoot(liveRoot, { pm2LogPath, backendPort = null, witness = null, pm2Behavior = {} }) {
  // PORT is what Resolve-BackendHealthUrl reads to build the backend-direct probe
  // URL, so a fixture that declares it proves the derivation, not just the override.
  const portLine = backendPort === null ? '' : `PORT=${backendPort}\n`
  writeFixtureFile(liveRoot, 'docker/app.env', `UPGRADE_TEST_ENV_MARKER=from-app-env\n# a comment\n${portLine}\nJWT_SECRET="quoted-value"\n`)
  writeFixtureFile(liveRoot, 'apps/web/dist/index.html', '<html>OLD WEB DIST</html>\n')
  writeFixtureFile(liveRoot, 'packages/core-backend/dist/src/db/migrate.js', "console.log('stale pre-upgrade migrate.js')\n")
  writeFixtureFile(liveRoot, 'packages/core-backend/migrations/000_old.sql', 'select 0;\n')
  writeFixtureFile(liveRoot, 'plugins/plugin-integration-core/index.cjs', "module.exports = { name: 'stale' }\n")
  writeFixtureFile(liveRoot, 'plugins/plugin-integration-core/app.manifest.json', JSON.stringify({ id: 'stale' }))
  writeFixtureFile(liveRoot, PREFLIGHT_FILE, 'module.exports = { stale: true }\n')
  // Live-side node_modules — must survive the upgrade byte-for-byte.
  writeFixtureFile(liveRoot, LIVE_NODE_MODULES_SURVIVOR, LIVE_SURVIVOR_CONTENT)

  writePm2Stub(liveRoot, pm2LogPath, witness, pm2Behavior)
}

function buildAcidArchive(root, options = {}) {
  const stageParent = path.join(root, 'stage')
  const packageName = 'acid-fixture-multitable-onprem-package'
  const stageDir = path.join(stageParent, packageName)
  buildAcidPackageStage(stageDir, options)

  const archivePath = path.join(root, `${packageName}.zip`)
  const compress = spawnSync(
    PWSH,
    ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${stageDir}' -DestinationPath '${archivePath}' -Force`],
    { encoding: 'utf8' },
  )
  assert.equal(compress.status, 0, compress.stderr || compress.stdout)

  const digest = sha256File(archivePath)
  fs.writeFileSync(`${archivePath}.sha256`, `${digest}  ${path.basename(archivePath)}\n`)

  return { archivePath, stageDir }
}

function grepTreeForMarker(root, marker) {
  if (!fs.existsSync(root)) return []
  const hits = []
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          if (fs.readFileSync(full, 'utf8').includes(marker)) {
            hits.push(path.relative(root, full))
          }
        } catch {
          // binary/unreadable — irrelevant to this text-marker check
        }
      }
    }
  }
  return hits
}

function runUpgradeScript(args, envOverrides = {}) {
  return spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...envOverrides },
  })
}

// Async variant, required whenever the script under test will call OUT to an HTTP
// server that lives in THIS SAME Node process: child_process.spawnSync blocks the
// entire Node event loop until the child exits, so a same-process http.Server
// cannot accept the script's own healthcheck connections while spawnSync blocks —
// every request would hang until the client's own timeout. spawn (async) keeps the
// event loop live so the health server can actually answer.
function runUpgradeScriptAsync(args, envOverrides = {}) {
  return new Promise((resolve) => {
    const child = spawn(PWSH, ['-NoProfile', '-NonInteractive', '-File', scriptPath, ...args], {
      env: { ...process.env, ...envOverrides },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

// Answers BOTH probes (backend-direct /health and nginx /api/health) and records,
// per request, the path and whether the maintenance flag existed at that instant.
// That pair is the runtime witness for the r29 ordering fix: the backend-direct
// probe must arrive while the flag is still up, and the nginx probe must arrive
// after it is gone.
function startHealthServer({ flagPath = null, backendUp = () => true } = {}) {
  return new Promise((resolve) => {
    const requests = []
    const server = http.createServer((req, res) => {
      // backendUp only governs the backend-direct /health path: it lets the R59
      // fixtures model "the backend is down until the scheduled task starts it".
      const up = req.url === '/health' ? Boolean(backendUp()) : true
      requests.push({
        url: req.url,
        flagExists: flagPath ? fs.existsSync(flagPath) : null,
        // The one-shot "is the gate actually wired on this host" probe tags
        // itself; nginx's `if (-f ...)` is header-blind, so the tag cannot
        // change what the probe measures on a real box — it only lets these
        // fixtures tell that request apart from the two health probes.
        gateProbe: req.headers['x-upgrade-gate-probe'] === '1',
        backendUp: up,
      })
      if (!up) {
        res.writeHead(503, { 'content-type': 'text/plain' })
        res.end('backend down')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, port, requests, url: `http://127.0.0.1:${port}/api/health` })
    })
  })
}

test('end-to-end (acid fixture): a clean upgrade passes under the real walk — deep files, the decoy, the loose root file, node_modules isolation, all hold', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-acid-'))
  const liveRoot = path.join(root, 'live')
  const witness = maintenanceWitnessPaths(root, liveRoot)
  const health = await startHealthServer({ flagPath: witness.flagPath })
  try {
    const backupRoot = path.join(root, 'backups')
    const stagingRoot = path.join(root, 'staging')
    const pm2LogPath = path.join(root, 'pm2-calls.log')
    const migrateMarkerPath = path.join(root, 'migrate-marker.txt')

    // The same fake server answers both probes: PORT in app.env makes the script
    // derive http://127.0.0.1:<port>/health for the backend-direct probe, and
    // -HealthUrl points the nginx probe at /api/health on that same port.
    buildAcidLiveRoot(liveRoot, { pm2LogPath, backendPort: health.port, witness })
    const { archivePath, stageDir } = buildAcidArchive(root)

    const result = await runUpgradeScriptAsync(
      [
        '-PackageArchive', archivePath,
        '-RootDir', liveRoot,
        '-Pm2AppName', 'metasheet-backend',
        '-EnvFile', path.join(liveRoot, 'docker/app.env'),
        '-BackupRoot', backupRoot,
        '-StagingRoot', stagingRoot,
        '-HealthUrl', health.url,
        '-HealthcheckAttempts', '3',
        '-HealthcheckDelaySec', '1',
      ],
      { UPGRADE_TEST_MIGRATE_MARKER_PATH: migrateMarkerPath },
    )

    if (result.status !== 0) {
      assert.fail(`expected a clean upgrade to succeed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }

    // Depth>=3 deep file survives, hash-identical.
    const deepDeployedPath = path.join(liveRoot, ...DEEP_ADAPTER_FILE.split('/'))
    assert.ok(fs.existsSync(deepDeployedPath), 'F22 regression: a deeply nested file must survive the upgrade')
    assert.equal(sha256File(deepDeployedPath), sha256File(path.join(stageDir, ...DEEP_ADAPTER_FILE.split('/'))))

    // Decoy (substring "node_modules" in the name, not an actual node_modules dir)
    // is copied like any other file.
    const decoyDeployedPath = path.join(liveRoot, ...DECOY_FILE.split('/'))
    assert.ok(fs.existsSync(decoyDeployedPath), 'a file merely named like node_modules must not be treated as node_modules')

    // Loose file at plugins/ root is copied.
    assert.equal(fs.readFileSync(path.join(liveRoot, ...LOOSE_ROOT_FILE.split('/')), 'utf8'), 'PACKAGE_LOOSE_ROOT_FILE')

    // Package-side node_modules never reaches the deployed tree, anywhere.
    const leakHits = grepTreeForMarker(path.join(liveRoot, 'plugins'), PACKAGE_LEAK_MARKER)
    assert.deepEqual(leakHits, [], `package node_modules content must never leak into the deployed tree, found at: ${leakHits.join(', ')}`)

    // Live-side node_modules survives, byte-for-byte.
    assert.equal(
      fs.readFileSync(path.join(liveRoot, ...LIVE_NODE_MODULES_SURVIVOR.split('/')), 'utf8'),
      LIVE_SURVIVOR_CONTENT,
      'a plugin\'s pre-existing node_modules must be preserved untouched',
    )

    // Backup snapshot captured the OLD content before replacement.
    const backupDirs = fs.readdirSync(backupRoot)
    assert.equal(backupDirs.length, 1)
    const backupPath = path.join(backupRoot, backupDirs[0])
    assert.match(fs.readFileSync(path.join(backupPath, 'apps/web/dist/index.html'), 'utf8'), /OLD WEB DIST/)

    // The reported backup path in stdout matches the folder actually written.
    const printedBackupLine = result.stdout.split('\n').find((line) => line.startsWith('BACKUP_PATH='))
    assert.ok(printedBackupLine)
    assert.equal(path.resolve(printedBackupLine.slice('BACKUP_PATH='.length).trim()), path.resolve(backupPath))

    // pm2 was stopped exactly once (no failure -> the catch-handler stop never
    // fires) and restarted with --update-env.
    const pm2Log = fs.readFileSync(pm2LogPath, 'utf8')
    assert.match(pm2Log, /stop metasheet-backend/)
    assert.match(pm2Log, /restart metasheet-backend --update-env/)
    assert.equal((pm2Log.match(/stop metasheet-backend/g) || []).length, 1)

    // Migrations ran with env loaded from docker/app.env into THIS process, not
    // whatever pm2 happened to be holding: the marker's VALUE came from
    // UPGRADE_TEST_ENV_MARKER, which only docker/app.env defines.
    assert.ok(fs.existsSync(migrateMarkerPath))
    assert.equal(fs.readFileSync(migrateMarkerPath, 'utf8').trim(), 'from-app-env')

    // The real F22 net ran and passed.
    assert.match(result.stdout, /Plugin hash verification: OK/)
    assert.match(result.stdout, /Plugin node_modules leak check: OK/)

    // ── The r29 ordering guarantee, witnessed at runtime ──────────────────────
    // 1) The gate was UP before pm2 was touched at all (stop is the first call).
    const flagWitness = readPm2FlagWitness(witness.pm2FlagWitnessPath)
    assert.ok(flagWitness.length >= 1, 'the pm2 stub must have recorded at least the stop call')
    assert.match(
      flagWitness[0],
      /^FLAG_PRESENT stop metasheet-backend/,
      'the maintenance flag must already exist when pm2 is stopped — raising it afterwards leaves the ' +
        'connection-reset window this whole gate exists to close',
    )

    // 2) Backend-direct probe first, while the gate is still up; nginx probe only
    //    after the gate is gone. Probing nginx first is exactly what made r29 exit
    //    -1 against a backend that was already healthy.
    // The gate self-witness is a third request, tagged and deliberately made
    // BEFORE pm2 is stopped; the r29 ordering below is about the two health
    // probes, so filter it out here and assert it separately further down.
    const probes = health.requests.filter((entry) => !entry.gateProbe)
    assert.ok(probes.length >= 2, `expected both probes, got: ${JSON.stringify(health.requests)}`)
    assert.equal(probes[0].url, '/health', 'the FIRST probe must be the backend-direct one, bypassing nginx')
    assert.equal(
      probes[0].flagExists,
      true,
      'the backend-direct probe must run while the maintenance flag is still up — that is the whole point of ' +
        'probing the backend directly instead of through the 503-ing gate',
    )
    assert.equal(probes[probes.length - 1].url, '/api/health', 'the LAST probe must be the public one through nginx')
    assert.equal(
      probes[probes.length - 1].flagExists,
      false,
      'the flag must already be deleted when the nginx probe runs — otherwise the script fails its own healthcheck (r29)',
    )

    // 2b) The gate self-witness: exactly one tagged request, aimed at the PUBLIC
    //     url, fired while the flag was still up and — this is what makes it a
    //     witness rather than decoration — BEFORE the backend was stopped, i.e.
    //     before any of the other probes. This fixture's fake nginx answers 200
    //     to everything (it does not implement the gate), which is precisely the
    //     shape of an un-synced host, so the run must SAY the gate is not wired
    //     instead of letting "maintenance flag: ... (removed)" imply it was.
    const gateProbes = health.requests.filter((entry) => entry.gateProbe)
    assert.equal(gateProbes.length, 1, `expected exactly one tagged gate probe, got: ${JSON.stringify(health.requests)}`)
    assert.equal(health.requests[0].gateProbe, true, 'the gate probe must be the FIRST request of the whole run, before the backend is stopped')
    assert.equal(gateProbes[0].url, '/api/health', 'the gate probe must go through the public URL — the whole point is testing what nginx does')
    assert.equal(gateProbes[0].flagExists, true, 'probing before the flag is raised would prove nothing')
    assert.match(
      result.stdout,
      /MAINTENANCE_GATE_NOT_WIRED/,
      'a 200 on the public URL while the flag is up means this host\'s nginx never got the gate: the run must say so out loud',
    )
    assert.match(result.stdout, /maintenance gate:\s+NOT_WIRED/, 'the final report must carry the gate verdict, not just the flag path')

    // 3) The flag is gone when the script exits, and the final report names it.
    assert.ok(!fs.existsSync(witness.flagPath), 'the maintenance flag must not outlive a successful upgrade')
    assert.ok(result.stdout.includes(`MAINTENANCE_FLAG=${witness.flagPath}`), 'the raised flag path must be printed')
    assert.ok(
      result.stdout.includes(`maintenance flag: ${witness.flagPath} (removed)`),
      `the final report must name the flag path and its state.\nstdout:\n${result.stdout}`,
    )

    assert.match(result.stdout, /package:\s+acid-fixture-multitable-onprem-package\.zip/)
    assert.match(result.stdout, /migration exit:\s+0/)
    assert.match(result.stdout, /backend health:\s+OK/)
    assert.match(result.stdout, /\nhealth:\s+OK/)
    assert.match(result.stdout, /stock-preparation\/preflight/)
    assert.match(result.stdout, /stock-prep-acceptance-bootstrap\.mjs/)
    assert.doesNotMatch(result.stdout, /RESTORE REQUIRED/, 'a clean run must never print the restore block')
  } finally {
    health.server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end (acid fixture): checksum mismatch refuses BEFORE touching pm2 or any live file (RED-witnessed)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-acid-'))
  try {
    const liveRoot = path.join(root, 'live')
    const backupRoot = path.join(root, 'backups')
    const stagingRoot = path.join(root, 'staging')
    const pm2LogPath = path.join(root, 'pm2-calls.log')

    buildAcidLiveRoot(liveRoot, { pm2LogPath })
    const { archivePath } = buildAcidArchive(root)
    fs.writeFileSync(`${archivePath}.sha256`, `${'0'.repeat(64)}  ${path.basename(archivePath)}\n`)

    const result = runUpgradeScript([
      '-PackageArchive', archivePath,
      '-RootDir', liveRoot,
      '-EnvFile', path.join(liveRoot, 'docker/app.env'),
      '-BackupRoot', backupRoot,
      '-StagingRoot', stagingRoot,
      '-RunMigrations', '0',
      '-RestartService', '0',
    ])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr + result.stdout, /PACKAGE_CHECKSUM_MISMATCH/)
    assert.ok(!fs.existsSync(pm2LogPath), 'pm2 must never be invoked when the checksum gate refuses')
    assert.ok(!fs.existsSync(backupRoot) || fs.readdirSync(backupRoot).length === 0, 'no backup should be written')
    // The refusal happens before the gate goes up, so nothing may be left
    // holding it. If a future edit hoists the raise above the checksum gate (or
    // anywhere outside the try), this run ends with the flag still on disk and
    // nginx answers 503 for every request until a human deletes the file --
    // a refused upgrade would take the site down harder than a broken one.
    assert.ok(
      !fs.existsSync(path.join(liveRoot, 'output', 'maintenance.flag')),
      'a pre-try refusal must not leave a maintenance flag behind: no finally runs on that path',
    )
    assert.match(
      fs.readFileSync(path.join(liveRoot, ...PREFLIGHT_FILE.split('/')), 'utf8'),
      /stale: true/,
      'the live plugin file must be untouched',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end (acid fixture): a package missing the preflight file fails the F22 tripwire, stops pm2, and prints the restore block (RED-witnessed)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-acid-'))
  try {
    const liveRoot = path.join(root, 'live')
    const backupRoot = path.join(root, 'backups')
    const stagingRoot = path.join(root, 'staging')
    const pm2LogPath = path.join(root, 'pm2-calls.log')

    buildAcidLiveRoot(liveRoot, { pm2LogPath })
    fs.rmSync(path.join(liveRoot, ...PREFLIGHT_FILE.split('/')))
    const { archivePath } = buildAcidArchive(root, { omitPreflightFile: true })

    const result = runUpgradeScript([
      '-PackageArchive', archivePath,
      '-RootDir', liveRoot,
      '-EnvFile', path.join(liveRoot, 'docker/app.env'),
      '-BackupRoot', backupRoot,
      '-StagingRoot', stagingRoot,
      '-RunMigrations', '0',
      '-RestartService', '0',
    ])

    assert.notEqual(result.status, 0)
    const combined = result.stderr + result.stdout
    assert.match(combined, /UPGRADE_ASSERTION_MISSING_FILES/)
    assert.match(combined, /stock-preparation-preflight\.cjs/)
    assert.match(combined, /RESTORE REQUIRED/)
    assert.match(combined, /BACKUP_PATH=/)

    const backupDirs = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : []
    assert.equal(backupDirs.length, 1, 'a backup snapshot must exist even though the upgrade ultimately refused')

    // pm2 was stopped at step 2, AND again by the failure handler.
    const pm2Log = fs.readFileSync(pm2LogPath, 'utf8')
    assert.equal((pm2Log.match(/stop metasheet-backend/g) || []).length, 2)
    assert.doesNotMatch(pm2Log, /restart/, 'pm2 restart must never be reached after the tripwire fires')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end (acid fixture): a mid-swap exception (before ANY assertion runs) still stops pm2 and prints the restore block (RED-witnessed)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-acid-'))
  try {
    const liveRoot = path.join(root, 'live')
    const backupRoot = path.join(root, 'backups')
    const stagingRoot = path.join(root, 'staging')
    const pm2LogPath = path.join(root, 'pm2-calls.log')

    buildAcidLiveRoot(liveRoot, { pm2LogPath })
    const { archivePath, stageDir } = buildAcidArchive(root)
    // Simulate the earliest possible failure in the mutation window: the package
    // is missing a required full-replace directory entirely (Update-ReplaceDirs
    // throws PACKAGE_MISSING_REPLACE_DIR before Update-Plugins or any assertion
    // ever runs). Rebuild the archive after deleting migrations/ from the stage.
    fs.rmSync(path.join(stageDir, 'packages/core-backend/migrations'), { recursive: true, force: true })
    const rezip = spawnSync(
      PWSH,
      ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${stageDir}' -DestinationPath '${archivePath}' -Force`],
      { encoding: 'utf8' },
    )
    assert.equal(rezip.status, 0, rezip.stderr || rezip.stdout)
    const digest = sha256File(archivePath)
    fs.writeFileSync(`${archivePath}.sha256`, `${digest}  ${path.basename(archivePath)}\n`)

    const result = runUpgradeScript([
      '-PackageArchive', archivePath,
      '-RootDir', liveRoot,
      '-EnvFile', path.join(liveRoot, 'docker/app.env'),
      '-BackupRoot', backupRoot,
      '-StagingRoot', stagingRoot,
      '-RunMigrations', '0',
      '-RestartService', '0',
    ])

    assert.notEqual(result.status, 0)
    const combined = result.stderr + result.stdout
    assert.match(combined, /PACKAGE_MISSING_REPLACE_DIR/)
    assert.match(
      combined,
      /RESTORE REQUIRED/,
      'a failure with NO specific assertion (a raw mid-swap exception) must still print the restore block — ' +
        'this is what "wrap the entire mutation window" means, not a per-assertion patchwork',
    )
    assert.match(combined, /BACKUP_PATH=/)
    const pm2Log = fs.readFileSync(pm2LogPath, 'utf8')
    assert.equal((pm2Log.match(/stop metasheet-backend/g) || []).length, 2, 'pm2 stop must be attempted even on the earliest possible failure')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end (acid fixture): a failed nginx healthcheck stops the now-broken pm2 app and prints the restore block, not just a throw (RED-witnessed)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-acid-'))
  const liveRoot = path.join(root, 'live')
  const witness = maintenanceWitnessPaths(root, liveRoot)
  // The BACKEND answers (so the run gets past the first probe and drops the gate);
  // the nginx URL points at a dead port, which is the failure under test here.
  const backend = await startHealthServer({ flagPath: witness.flagPath })
  try {
    const backupRoot = path.join(root, 'backups')
    const stagingRoot = path.join(root, 'staging')
    const pm2LogPath = path.join(root, 'pm2-calls.log')

    buildAcidLiveRoot(liveRoot, { pm2LogPath, backendPort: backend.port, witness })
    const { archivePath } = buildAcidArchive(root)

    const result = await runUpgradeScriptAsync([
      '-PackageArchive', archivePath,
      '-RootDir', liveRoot,
      '-EnvFile', path.join(liveRoot, 'docker/app.env'),
      '-BackupRoot', backupRoot,
      '-StagingRoot', stagingRoot,
      '-RunMigrations', '0',
      '-HealthUrl', 'http://127.0.0.1:1/api/health',
      '-HealthcheckAttempts', '2',
      '-HealthcheckDelaySec', '1',
    ])

    assert.notEqual(result.status, 0)
    const combined = result.stderr + result.stdout
    assert.match(combined, /HEALTHCHECK_FAILED/)
    assert.match(combined, /RESTORE REQUIRED/)
    assert.match(combined, /\nhealth:\s+FAILED/, 'the final report must still print before the restore block, showing FAILED')
    assert.match(combined, /backend health:\s+OK/, 'the backend-direct probe is what decided the gate could come down')

    // The gate came down even though the upgrade ultimately failed, and the restore
    // block tells the operator where it was in case it somehow survived.
    assert.ok(!fs.existsSync(witness.flagPath), 'the maintenance flag must not outlive a FAILED upgrade either')
    assert.ok(combined.includes(`Maintenance flag: ${witness.flagPath}`), 'the restore block must name the flag path')
    assert.match(combined, /delete it by hand/)

    // pm2 sequence: stop (step 2), restart (step 7, BEFORE the healthcheck that
    // then fails), stop again (the failure handler — a broken deployment must not
    // be left running).
    const pm2Log = fs.readFileSync(pm2LogPath, 'utf8')
    const calls = pm2Log.trim().split('\n').map((line) => line.trim().split(/\s+/)[0])
    assert.deepEqual(calls, ['stop', 'restart', 'stop'])
  } finally {
    backend.server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end (acid fixture): when the BACKEND never answers directly, the nginx probe is never attempted and the gate still comes down', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-acid-'))
  try {
    const liveRoot = path.join(root, 'live')
    const witness = maintenanceWitnessPaths(root, liveRoot)
    const backupRoot = path.join(root, 'backups')
    const stagingRoot = path.join(root, 'staging')
    const pm2LogPath = path.join(root, 'pm2-calls.log')

    buildAcidLiveRoot(liveRoot, { pm2LogPath, witness })
    const { archivePath } = buildAcidArchive(root)

    // Both URLs point at a dead port: nothing listens, every attempt fails fast
    // (connection refused), so the plain sync spawn is fine here.
    const result = runUpgradeScript([
      '-PackageArchive', archivePath,
      '-RootDir', liveRoot,
      '-EnvFile', path.join(liveRoot, 'docker/app.env'),
      '-BackupRoot', backupRoot,
      '-StagingRoot', stagingRoot,
      '-RunMigrations', '0',
      '-BackendHealthUrl', 'http://127.0.0.1:1/health',
      '-HealthUrl', 'http://127.0.0.1:1/api/health',
      '-HealthcheckAttempts', '1',
      '-HealthcheckDelaySec', '1',
    ])

    assert.notEqual(result.status, 0)
    const combined = result.stderr + result.stdout
    assert.match(combined, /BACKEND_HEALTHCHECK_FAILED/)
    assert.match(combined, /the nginx probe was never attempted/)
    assert.match(combined, /RESTORE REQUIRED/)
    assert.ok(!fs.existsSync(witness.flagPath), 'the finally must drop the gate even when the backend never came back')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end (acid fixture): the gate is raised BEFORE pm2 is stopped and the finally drops it even when the upgrade throws mid-swap (RED-witnessed)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-acid-'))
  try {
    const liveRoot = path.join(root, 'live')
    const witness = maintenanceWitnessPaths(root, liveRoot)
    const backupRoot = path.join(root, 'backups')
    const stagingRoot = path.join(root, 'staging')
    const pm2LogPath = path.join(root, 'pm2-calls.log')

    buildAcidLiveRoot(liveRoot, { pm2LogPath, witness })
    const { archivePath, stageDir } = buildAcidArchive(root)
    // Same shape as the mid-swap test above: the package is missing a required
    // full-replace directory, so Update-ReplaceDirs throws in the middle of the
    // mutation window — long after the gate went up, long before any health probe
    // could take it down. Only the finally can save this run from leaving the whole
    // site answering 503 forever.
    fs.rmSync(path.join(stageDir, 'packages/core-backend/migrations'), { recursive: true, force: true })
    const rezip = spawnSync(
      PWSH,
      ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${stageDir}' -DestinationPath '${archivePath}' -Force`],
      { encoding: 'utf8' },
    )
    assert.equal(rezip.status, 0, rezip.stderr || rezip.stdout)
    fs.writeFileSync(`${archivePath}.sha256`, `${sha256File(archivePath)}  ${path.basename(archivePath)}\n`)

    const result = runUpgradeScript([
      '-PackageArchive', archivePath,
      '-RootDir', liveRoot,
      '-EnvFile', path.join(liveRoot, 'docker/app.env'),
      '-BackupRoot', backupRoot,
      '-StagingRoot', stagingRoot,
      '-RunMigrations', '0',
      '-RestartService', '0',
    ])

    assert.notEqual(result.status, 0)
    const combined = result.stderr + result.stdout
    assert.match(combined, /PACKAGE_MISSING_REPLACE_DIR/)

    // Raised before the backend went down.
    const flagWitness = readPm2FlagWitness(witness.pm2FlagWitnessPath)
    assert.match(
      flagWitness[0] || '',
      /^FLAG_PRESENT stop metasheet-backend/,
      'the gate must be up before pm2 is stopped, on the failure path as much as the success path',
    )

    // Dropped on the way out, by the finally — nothing else could have.
    assert.ok(
      !fs.existsSync(witness.flagPath),
      'a maintenance flag that survives a failed upgrade is a site-wide 503 nobody is watching for: ' +
        'the finally block must delete it unconditionally',
    )
    assert.ok(combined.includes(`Maintenance flag: ${witness.flagPath}`))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end (acid fixture): a maintenance flag path inside a ReplaceDir refuses at startup, before pm2 or any live file is touched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-acid-'))
  try {
    const liveRoot = path.join(root, 'live')
    const backupRoot = path.join(root, 'backups')
    const stagingRoot = path.join(root, 'staging')
    const pm2LogPath = path.join(root, 'pm2-calls.log')

    buildAcidLiveRoot(liveRoot, { pm2LogPath })
    const { archivePath } = buildAcidArchive(root)

    // apps/web/dist is a ReplaceDirs entry: it is deleted and recopied wholesale
    // mid-upgrade, which would drop the gate at the worst possible moment.
    const badFlagPath = path.join(liveRoot, 'apps', 'web', 'dist', 'maintenance.flag')
    const result = runUpgradeScript([
      '-PackageArchive', archivePath,
      '-RootDir', liveRoot,
      '-EnvFile', path.join(liveRoot, 'docker/app.env'),
      '-BackupRoot', backupRoot,
      '-StagingRoot', stagingRoot,
      '-MaintenanceFlagPath', badFlagPath,
      '-RunMigrations', '0',
      '-RestartService', '0',
    ])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr + result.stdout, /MAINTENANCE_FLAG_PATH_INSIDE_REPLACE_DIR/)
    assert.ok(!fs.existsSync(pm2LogPath), 'pm2 must never be invoked when the flag-path gate refuses')
    assert.ok(!fs.existsSync(badFlagPath), 'the refused flag must never be written')
    assert.ok(!fs.existsSync(backupRoot) || fs.readdirSync(backupRoot).length === 0, 'no backup should be written')
    assert.match(
      fs.readFileSync(path.join(liveRoot, ...PREFLIGHT_FILE.split('/')), 'utf8'),
      /stale: true/,
      'the live plugin file must be untouched',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ── 3b. END-TO-END: pm2-runtime hosting (R59) ──────────────────────────────────────
//
// The REAL script, unmodified, run through a thin wrapper that only defines the
// task-scheduler stubs first (see scheduledTaskStubSource). USERPROFILE is pointed
// at a per-test profile directory and PM2_HOME is removed from the child env, so
// neither the machine running the tests nor the CI runner can leak into what the
// script auto-detects.

// Pointing USERPROFILE at a bare temp directory has a side effect on Windows
// PowerShell 5.1: LocalApplicationData no longer resolves, and its module analysis
// cache is then written RELATIVE TO THE CWD — i.e. a `Microsoft/Windows/PowerShell/
// ModuleAnalysisCache` directory appears in the repo checkout (observed while
// writing these tests). Every R59 child therefore also gets an explicit
// PSModuleAnalysisCachePath inside the same profile directory, which the test's
// temp root cleanup removes.
function r59ChildEnv(profileDir, extraOverrides = {}, removals = []) {
  return childEnv(
    { USERPROFILE: profileDir, PSModuleAnalysisCachePath: path.join(profileDir, 'ps-module-analysis-cache'), ...extraOverrides },
    removals,
  )
}

function childEnv(overrides = {}, removals = []) {
  const env = { ...process.env }
  const drop = new Set([...removals, ...Object.keys(overrides)].map((key) => key.toUpperCase()))
  for (const key of Object.keys(env)) {
    if (drop.has(key.toUpperCase())) delete env[key]
  }
  return { ...env, ...overrides }
}

function writeStubbedUpgradeWrapper(root, taskStub, upgradeParams) {
  const wrapperPath = path.join(root, 'run-upgrade-with-task-stubs.ps1')
  const splat = Object.entries(upgradeParams).map(([key, value]) => `  ${key} = ${psSingleQuote(value)}`)
  fs.writeFileSync(
    wrapperPath,
    [scheduledTaskStubSource(taskStub), '$upgradeParams = @{', ...splat, '}', `& ${psSingleQuote(scriptPath)} @upgradeParams`, ''].join('\n'),
  )
  return wrapperPath
}

function runPwshFileAsync(filePath, env, cwd = undefined) {
  return new Promise((resolve) => {
    const child = spawn(PWSH, ['-NoProfile', '-NonInteractive', '-File', filePath], { env, cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

// The fallback's pipe check (Wait-Pm2DaemonPipeClosed) is REAL, not stubbed: on
// Windows it looks at pm2's machine-wide \\.\pipe\rpc.sock. A real pm2 daemon running
// on the same machine as these tests therefore makes every fallback test wait 15 s and
// fail with PM2_DAEMON_STILL_RUNNING -- which is the script refusing correctly. CI
// runners have no pm2; on a dev box, stop pm2 before running this file.
//
// runtimeHomeExists: <profile>/.pm2-runtime exists (half of the auto-detect signal).
// runtimeAlive:      pm2-runtime still holds the app in that home, so a restart there
//                    succeeds. false = the R59 shape (pm2-runtime exited after the stop).
function setUpR59Fixture(root, { runtimeHomeExists = true, runtimeAlive = false } = {}) {
  const liveRoot = path.join(root, 'live')
  const profileDir = path.join(root, 'profile')
  const runtimeHome = path.join(profileDir, '.pm2-runtime')
  fs.mkdirSync(profileDir, { recursive: true })
  if (runtimeHomeExists) fs.mkdirSync(runtimeHome, { recursive: true })
  if (runtimeAlive) fs.writeFileSync(path.join(runtimeHome, PM2_APP_ALIVE_MARKER), 'alive')
  const fx = {
    root,
    liveRoot,
    profileDir,
    runtimeHome,
    witness: maintenanceWitnessPaths(root, liveRoot),
    backupRoot: path.join(root, 'backups'),
    stagingRoot: path.join(root, 'staging'),
    pm2LogPath: path.join(root, 'pm2-calls.log'),
    homeLogPath: path.join(root, 'pm2-home.log'),
    taskLogPath: path.join(root, 'task-calls.log'),
    runtimeStartedMarker: path.join(root, 'runtime-started.marker'),
    // The pm2 stub's model of the machine-wide daemon a "not found" CLI call leaves behind.
    strayDaemonMarker: path.join(root, 'stray-pm2-daemon.marker'),
  }
  // Scheduled-task stub options for this fixture; tests override taskPresent/startBehavior.
  fx.taskStub = (overrides = {}) => ({
    taskPresent: true,
    startBehavior: 'start-runtime',
    runtimeStartedMarker: fx.runtimeStartedMarker,
    taskLogPath: fx.taskLogPath,
    strayDaemonMarkerPath: fx.strayDaemonMarker,
    ...overrides,
  })
  fx.baseParams = {
    RootDir: liveRoot,
    EnvFile: path.join(liveRoot, 'docker/app.env'),
    BackupRoot: fx.backupRoot,
    StagingRoot: fx.stagingRoot,
    RunMigrations: '0',
  }
  return fx
}

function buildR59LiveRootAndArchive(fx, backendPort = null, pm2Overrides = {}) {
  buildAcidLiveRoot(fx.liveRoot, {
    pm2LogPath: fx.pm2LogPath,
    backendPort,
    witness: fx.witness,
    pm2Behavior: { homeLogPath: fx.homeLogPath, restartNeedsHomeMarker: true, strayDaemonMarkerPath: fx.strayDaemonMarker, ...pm2Overrides },
  })
  return buildAcidArchive(fx.root).archivePath
}

test('end-to-end (acid fixture, R59 replay): restart "not found" on a pm2-runtime host kills the empty daemon it just started, THEN starts the MetaSheet-PM2 task, the SAME health polling passes, no restore block (RED on the pre-fix script)', async () => {
  const root = mkLongTempDir('ms2-upgrade-r59-')
  const fx = setUpR59Fixture(root, { runtimeAlive: false })
  // The backend stays DOWN until the scheduled task has started pm2-runtime again.
  const health = await startHealthServer({ flagPath: fx.witness.flagPath, backendUp: () => fs.existsSync(fx.runtimeStartedMarker) })
  try {
    const archivePath = buildR59LiveRootAndArchive(fx, health.port)
    const wrapper = writeStubbedUpgradeWrapper(
      root,
      fx.taskStub(),
      { ...fx.baseParams, PackageArchive: archivePath, HealthUrl: health.url, HealthcheckAttempts: '3', HealthcheckDelaySec: '1' },
    )
    const result = await runPwshFileAsync(wrapper, r59ChildEnv(fx.profileDir, {}, ['PM2_HOME']))
    const combined = result.stderr + result.stdout
    assert.equal(result.status, 0, `the R59 shape must now recover by itself.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)

    // Every pm2 call ran under the auto-detected pm2-runtime home: the stop, the
    // restart that answered "not found", and the kill of the daemon that restart left.
    const homes = readPm2HomeLog(fx.homeLogPath)
    assert.deepEqual(homes.map((entry) => entry.command), ['stop', 'restart', 'kill'], 'a recovered run must not reach the failure handler\'s stop')
    for (const entry of homes) {
      assert.equal(entry.home, fx.runtimeHome, `pm2 ${entry.command} must run under ${fx.runtimeHome}, got [${entry.home}]`)
    }
    // pm2 said "not found" (the R59 symptom) and the task was started exactly once.
    assert.match(combined, /Process or Namespace metasheet-backend not found/)
    assert.match(combined, /PM2_RESTART_NOT_FOUND_FALLBACK/)
    assert.deepEqual(readLogLines(fx.taskLogPath).filter((line) => line.startsWith('start ')), ['start MetaSheet-PM2'])
    // ...and it started only AFTER the empty daemon was gone. With real pm2 on
    // Windows (7.0.4, verified), a task started while that daemon lives gets a
    // pm2-runtime that attaches to it as a client: the backend answers the health
    // polling below, but runs under the upgrade session's daemon and dies with it.
    assert.deepEqual(
      readLogLines(fx.taskLogPath).filter((line) => line.startsWith('start-saw-daemon=')),
      ['start-saw-daemon=no'],
      'the task must start with no pm2 daemon left behind by this session',
    )
    assert.match(combined, /Spawning PM2 daemon/, 'the fixture must actually model the daemon the "not found" restart leaves behind')

    // The SAME health polling as after a normal restart: backend-direct first while
    // the gate is up (and only after the task started it), gate down, then nginx.
    const probes = health.requests.filter((entry) => !entry.gateProbe)
    assert.ok(probes.length >= 2, JSON.stringify(health.requests))
    assert.equal(probes[0].url, '/health')
    assert.equal(probes[0].backendUp, true, 'the health polling must start only after the task was started')
    assert.equal(probes[0].flagExists, true)
    assert.equal(probes[probes.length - 1].url, '/api/health')
    assert.equal(probes[probes.length - 1].flagExists, false)

    assert.match(result.stdout, /pm2 home:\s+\S.*\(source: pm2-runtime \(\.pm2-runtime \+ scheduled task 'MetaSheet-PM2'\)\)/)
    assert.match(result.stdout, /backend started:\s+scheduled-task/)
    assert.match(result.stdout, /backend health:\s+OK/)
    assert.match(result.stdout, /\nhealth:\s+OK/)
    assert.doesNotMatch(combined, /RESTORE REQUIRED/)
    // The deploy runbook judges a run by "FullyQualifiedErrorId count must be 0".
    // pm2's "not found" arrives on stderr; a recovered run must not surface it as
    // a PowerShell error record, or a good upgrade would read as a failed one.
    assert.doesNotMatch(combined, /FullyQualifiedErrorId|NativeCommandError/)
    assert.ok(!fs.existsSync(fx.witness.flagPath))
  } finally {
    health.server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end (acid fixture, R59): when pm2-runtime still holds the app, stop AND restart run under the auto-detected .pm2-runtime home and the task is never started (RED on the pre-fix script)', async () => {
  const root = mkLongTempDir('ms2-upgrade-r59-')
  const fx = setUpR59Fixture(root, { runtimeAlive: true })
  const health = await startHealthServer({ flagPath: fx.witness.flagPath })
  try {
    const archivePath = buildR59LiveRootAndArchive(fx, health.port)
    const wrapper = writeStubbedUpgradeWrapper(
      root,
      fx.taskStub(),
      { ...fx.baseParams, PackageArchive: archivePath, HealthUrl: health.url, HealthcheckAttempts: '3', HealthcheckDelaySec: '1' },
    )
    const result = await runPwshFileAsync(wrapper, r59ChildEnv(fx.profileDir, {}, ['PM2_HOME']))
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)

    // The stub only lets `restart` succeed under a home holding the app, so a
    // green run here is itself proof the restart ran under .pm2-runtime.
    const homes = readPm2HomeLog(fx.homeLogPath)
    assert.deepEqual(homes.map((entry) => `${entry.command}@${entry.home}`), [`stop@${fx.runtimeHome}`, `restart@${fx.runtimeHome}`])
    assert.deepEqual(readLogLines(fx.taskLogPath).filter((line) => line.startsWith('start ')), [], 'a successful restart must not also start the task')
    assert.match(result.stdout, /backend started:\s+pm2-restart/)
    assert.doesNotMatch(result.stdout + result.stderr, /RESTORE REQUIRED/)
  } finally {
    health.server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end (acid fixture, R59): if the scheduled task cannot be started, the run still stops pm2, prints RESTORE REQUIRED (with the pm2 home, a pm2 kill and the task command) and drops the gate', async () => {
  const root = mkLongTempDir('ms2-upgrade-r59-')
  const fx = setUpR59Fixture(root, { runtimeAlive: false })
  const health = await startHealthServer({ flagPath: fx.witness.flagPath, backendUp: () => fs.existsSync(fx.runtimeStartedMarker) })
  try {
    const archivePath = buildR59LiveRootAndArchive(fx, health.port)
    const wrapper = writeStubbedUpgradeWrapper(
      root,
      fx.taskStub({ startBehavior: 'throw' }),
      { ...fx.baseParams, PackageArchive: archivePath, HealthUrl: health.url, HealthcheckAttempts: '2', HealthcheckDelaySec: '1' },
    )
    const result = await runPwshFileAsync(wrapper, r59ChildEnv(fx.profileDir, {}, ['PM2_HOME']))
    const combined = result.stderr + result.stdout
    assert.notEqual(result.status, 0)
    assert.match(combined, /PM2_SCHEDULED_TASK_START_FAILED/)
    assert.match(combined, /STUB_TASK_SCHEDULER_REFUSED/)
    assert.match(combined, /RESTORE REQUIRED/)
    assert.ok(combined.includes(`$env:PM2_HOME = '${fx.runtimeHome}'`), 'the restore block must name the pm2 home the upgrade used')
    assert.ok(combined.includes("Start-ScheduledTask -TaskName 'MetaSheet-PM2'"), 'the restore block must say how to start pm2-runtime again')
    // By hand, too, the "not found" answer leaves an empty daemon in the operator's
    // session: the block must say to kill it BEFORE starting the task.
    const restoreBlock = combined.slice(combined.indexOf('RESTORE REQUIRED'))
    const restoreKillIdx = restoreBlock.search(/\n\s*pm2 kill\s*\r?\n/)
    assert.ok(restoreKillIdx > -1, 'the restore block must print `pm2 kill`')
    assert.ok(restoreKillIdx < restoreBlock.indexOf("Start-ScheduledTask -TaskName 'MetaSheet-PM2'"), '`pm2 kill` must come before Start-ScheduledTask')
    assert.deepEqual(readLogLines(fx.taskLogPath).filter((line) => line.startsWith('start ')), ['start MetaSheet-PM2'])

    const homes = readPm2HomeLog(fx.homeLogPath)
    assert.deepEqual(homes.map((entry) => entry.command), ['stop', 'restart', 'kill', 'stop'], 'the failure handler must still stop pm2')
    for (const entry of homes) assert.equal(entry.home, fx.runtimeHome)
    assert.deepEqual(health.requests.filter((entry) => !entry.gateProbe), [], 'no health polling after a task that never started')
    assert.ok(!fs.existsSync(fx.witness.flagPath), 'the finally must drop the gate')
  } finally {
    health.server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end (acid fixture, R59): if the task starts but the backend never answers, the health polling fails the run into RESTORE REQUIRED', async () => {
  const root = mkLongTempDir('ms2-upgrade-r59-')
  const fx = setUpR59Fixture(root, { runtimeAlive: false })
  const health = await startHealthServer({ flagPath: fx.witness.flagPath, backendUp: () => false })
  try {
    const archivePath = buildR59LiveRootAndArchive(fx, health.port)
    const wrapper = writeStubbedUpgradeWrapper(
      root,
      fx.taskStub(),
      { ...fx.baseParams, PackageArchive: archivePath, HealthUrl: health.url, HealthcheckAttempts: '2', HealthcheckDelaySec: '1' },
    )
    const result = await runPwshFileAsync(wrapper, r59ChildEnv(fx.profileDir, {}, ['PM2_HOME']))
    const combined = result.stderr + result.stdout
    assert.notEqual(result.status, 0)
    assert.match(combined, /PM2_RESTART_NOT_FOUND_FALLBACK/)
    assert.match(combined, /backend started:\s+scheduled-task/)
    assert.match(combined, /BACKEND_HEALTHCHECK_FAILED/)
    assert.match(combined, /RESTORE REQUIRED/)
    assert.equal(health.requests.filter((entry) => entry.url === '/health').length, 2, 'the normal backend-direct polling must have run, attempts included')
    assert.deepEqual(readPm2HomeLog(fx.homeLogPath).map((entry) => entry.command), ['stop', 'restart', 'kill', 'stop'])
    assert.ok(!fs.existsSync(fx.witness.flagPath))
  } finally {
    health.server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end (acid fixture, R59): an UNMANAGED host (a stray .pm2-runtime but no scheduled task, no PM2_HOME) behaves exactly as before — no PM2_HOME injected, no task started, restart "not found" is still fatal', async () => {
  const root = mkLongTempDir('ms2-upgrade-r59-')
  const fx = setUpR59Fixture(root, { runtimeHomeExists: true, runtimeAlive: false })
  try {
    const archivePath = buildR59LiveRootAndArchive(fx)
    const wrapper = writeStubbedUpgradeWrapper(
      root,
      fx.taskStub({ taskPresent: false }),
      {
        ...fx.baseParams,
        PackageArchive: archivePath,
        HealthUrl: 'http://127.0.0.1:1/api/health',
        BackendHealthUrl: 'http://127.0.0.1:1/health',
        HealthcheckAttempts: '1',
        HealthcheckDelaySec: '1',
      },
    )
    const result = await runPwshFileAsync(wrapper, r59ChildEnv(fx.profileDir, {}, ['PM2_HOME']))
    const combined = result.stderr + result.stdout
    assert.notEqual(result.status, 0)
    assert.match(combined, /PM2_RESTART_FAILED: exit=1/)
    assert.match(combined, /RESTORE REQUIRED/)
    const homes = readPm2HomeLog(fx.homeLogPath)
    assert.deepEqual(
      homes.map((entry) => `${entry.command}@${entry.home}`),
      ['stop@', 'restart@', 'stop@'],
      'no PM2_HOME may be injected on an unmanaged host, and no daemon may be killed there',
    )
    assert.deepEqual(readLogLines(fx.taskLogPath).filter((line) => line.startsWith('start ')), [], 'no task may be started on an unmanaged host')
    assert.doesNotMatch(combined, /\$env:PM2_HOME = /)
    assert.doesNotMatch(combined, /Start-ScheduledTask -TaskName/)
    assert.doesNotMatch(combined, /\n\s*pm2 kill\s*\r?\n/)
    assert.match(combined, /pm2 restart metasheet-backend --update-env/)
    assert.ok(!fs.existsSync(fx.witness.flagPath))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end (acid fixture, R59): on a pm2-runtime host a restart failure that is NOT "not found" stays fatal — the task is not started', async () => {
  const root = mkLongTempDir('ms2-upgrade-r59-')
  const fx = setUpR59Fixture(root, { runtimeAlive: true })
  try {
    const archivePath = buildR59LiveRootAndArchive(fx, null, { restartOtherError: true })
    const wrapper = writeStubbedUpgradeWrapper(
      root,
      fx.taskStub(),
      {
        ...fx.baseParams,
        PackageArchive: archivePath,
        HealthUrl: 'http://127.0.0.1:1/api/health',
        BackendHealthUrl: 'http://127.0.0.1:1/health',
        HealthcheckAttempts: '1',
        HealthcheckDelaySec: '1',
      },
    )
    const result = await runPwshFileAsync(wrapper, r59ChildEnv(fx.profileDir, {}, ['PM2_HOME']))
    const combined = result.stderr + result.stdout
    assert.notEqual(result.status, 0)
    assert.match(combined, /spawn EPERM/)
    assert.match(combined, /PM2_RESTART_FAILED: exit=1/)
    assert.doesNotMatch(combined, /PM2_RESTART_NOT_FOUND_FALLBACK/)
    assert.deepEqual(readLogLines(fx.taskLogPath).filter((line) => line.startsWith('start ')), [], 'only "not found" may trigger the task fallback')
    assert.match(combined, /RESTORE REQUIRED/)
    assert.deepEqual(readPm2HomeLog(fx.homeLogPath).map((entry) => entry.command), ['stop', 'restart', 'stop'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

for (const variant of ['parameter', 'environment']) {
  test(`end-to-end (acid fixture, R59): a PM2_HOME given by ${variant} wins over the auto-detected .pm2-runtime for every pm2 call`, async () => {
    const root = mkLongTempDir('ms2-upgrade-r59-')
    // .pm2-runtime + task present, but that home holds NO app: a run that let
    // auto-detection win would get "not found" and start the task.
    const fx = setUpR59Fixture(root, { runtimeHomeExists: true, runtimeAlive: false })
    const chosenHome = path.join(root, 'chosen-pm2-home')
    fs.mkdirSync(chosenHome, { recursive: true })
    fs.writeFileSync(path.join(chosenHome, PM2_APP_ALIVE_MARKER), 'alive')
    const health = await startHealthServer({ flagPath: fx.witness.flagPath })
    try {
      const archivePath = buildR59LiveRootAndArchive(fx, health.port)
      const params = { ...fx.baseParams, PackageArchive: archivePath, HealthUrl: health.url, HealthcheckAttempts: '3', HealthcheckDelaySec: '1' }
      const envOverrides = {}
      if (variant === 'parameter') params.Pm2Home = chosenHome
      else envOverrides.PM2_HOME = chosenHome
      const wrapper = writeStubbedUpgradeWrapper(
        root,
        fx.taskStub(),
        params,
      )
      const result = await runPwshFileAsync(wrapper, r59ChildEnv(fx.profileDir, envOverrides, variant === 'parameter' ? ['PM2_HOME'] : []))
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
      assert.deepEqual(readPm2HomeLog(fx.homeLogPath).map((entry) => `${entry.command}@${entry.home}`), [`stop@${chosenHome}`, `restart@${chosenHome}`])
      assert.deepEqual(readLogLines(fx.taskLogPath).filter((line) => line.startsWith('start ')), [])
      assert.match(result.stdout, new RegExp(`source: ${variant === 'parameter' ? 'parameter -Pm2Home' : 'environment PM2_HOME'}`))
    } finally {
      health.server.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

test('end-to-end (acid fixture, R59): -Pm2ScheduledTaskName \'\' disables the fallback even though a MetaSheet-PM2 task exists — restart "not found" stays fatal, the scheduler is never asked, the given -Pm2Home still applies', async () => {
  const root = mkLongTempDir('ms2-upgrade-r59-')
  // .pm2-runtime holds no app (the R59 shape) and the default-named task EXISTS: only
  // the empty task name stands between this run and the fallback.
  const fx = setUpR59Fixture(root, { runtimeAlive: false })
  try {
    const archivePath = buildR59LiveRootAndArchive(fx)
    const wrapper = writeStubbedUpgradeWrapper(root, fx.taskStub(), {
      ...fx.baseParams,
      PackageArchive: archivePath,
      Pm2Home: fx.runtimeHome,
      Pm2ScheduledTaskName: '',
      HealthUrl: 'http://127.0.0.1:1/api/health',
      BackendHealthUrl: 'http://127.0.0.1:1/health',
      HealthcheckAttempts: '1',
      HealthcheckDelaySec: '1',
    })
    const result = await runPwshFileAsync(wrapper, r59ChildEnv(fx.profileDir, {}, ['PM2_HOME']))
    const combined = result.stderr + result.stdout
    assert.notEqual(result.status, 0)
    assert.match(combined, /PM2_RESTART_FAILED: exit=1 \(pm2 reports 'metasheet-backend' not found; the scheduled-task fallback is disabled\)/)
    assert.doesNotMatch(combined, /PM2_RESTART_NOT_FOUND_FALLBACK/)
    assert.match(combined, /RESTORE REQUIRED/)
    assert.deepEqual(readLogLines(fx.taskLogPath), [], 'with the fallback disabled by name the scheduler must be neither queried nor started')
    assert.deepEqual(
      readPm2HomeLog(fx.homeLogPath).map((entry) => `${entry.command}@${entry.home}`),
      [`stop@${fx.runtimeHome}`, `restart@${fx.runtimeHome}`, `stop@${fx.runtimeHome}`],
      'the explicit home must still apply to every pm2 call, and nothing may be killed',
    )
    assert.doesNotMatch(combined, /Start-ScheduledTask -TaskName/)
    assert.ok(!fs.existsSync(fx.witness.flagPath))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end (acid fixture, R59): a non-default -Pm2ScheduledTaskName is the task that is detected, started and reported — never the default MetaSheet-PM2', async () => {
  const root = mkLongTempDir('ms2-upgrade-r59-')
  const fx = setUpR59Fixture(root, { runtimeAlive: false })
  const health = await startHealthServer({ flagPath: fx.witness.flagPath, backendUp: () => fs.existsSync(fx.runtimeStartedMarker) })
  try {
    const archivePath = buildR59LiveRootAndArchive(fx, health.port)
    // Only 'Custom-PM2' exists; starting any other name fails like the real cmdlet.
    const wrapper = writeStubbedUpgradeWrapper(root, fx.taskStub({ taskName: 'Custom-PM2' }), {
      ...fx.baseParams,
      PackageArchive: archivePath,
      Pm2ScheduledTaskName: 'Custom-PM2',
      HealthUrl: health.url,
      HealthcheckAttempts: '3',
      HealthcheckDelaySec: '1',
    })
    const result = await runPwshFileAsync(wrapper, r59ChildEnv(fx.profileDir, {}, ['PM2_HOME']))
    const combined = result.stderr + result.stdout
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.match(result.stdout, /source: pm2-runtime \(\.pm2-runtime \+ scheduled task 'Custom-PM2'\)/)
    assert.deepEqual(readLogLines(fx.taskLogPath).filter((line) => line.startsWith('start ')), ['start Custom-PM2'])
    assert.deepEqual(readLogLines(fx.taskLogPath).filter((line) => line.startsWith('start-saw-daemon=')), ['start-saw-daemon=no'])
    assert.deepEqual(readPm2HomeLog(fx.homeLogPath).map((entry) => `${entry.command}@${entry.home}`), [
      `stop@${fx.runtimeHome}`,
      `restart@${fx.runtimeHome}`,
      `kill@${fx.runtimeHome}`,
    ])
    assert.match(result.stdout, /backend started:\s+scheduled-task/)
    assert.doesNotMatch(combined, /MetaSheet-PM2/, 'the default task name must not appear anywhere once another one is given')
  } finally {
    health.server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end (acid fixture, R59): a RELATIVE -Pm2Home is resolved once, against the directory the script starts in — the step 6 Set-Location to RootDir must not move the restart to <RootDir>/<relative> (RED on the pre-fix script)', async () => {
  const root = mkLongTempDir('ms2-upgrade-r59-')
  const fx = setUpR59Fixture(root, { runtimeHomeExists: false })
  // The operator starts the script from a directory that is NOT RootDir, naming the
  // pm2 home relative to it. That directory holds the app; <RootDir>/<relative> does not.
  const operatorCwd = path.join(root, 'operator-cwd')
  const relativeName = 'rel-pm2-home'
  const absoluteHome = path.join(operatorCwd, relativeName)
  fs.mkdirSync(absoluteHome, { recursive: true })
  fs.writeFileSync(path.join(absoluteHome, PM2_APP_ALIVE_MARKER), 'alive')
  const health = await startHealthServer({ flagPath: fx.witness.flagPath })
  try {
    const archivePath = buildR59LiveRootAndArchive(fx, health.port)
    const wrapper = writeStubbedUpgradeWrapper(root, fx.taskStub({ taskPresent: false }), {
      ...fx.baseParams,
      PackageArchive: archivePath,
      Pm2Home: relativeName,
      HealthUrl: health.url,
      HealthcheckAttempts: '3',
      HealthcheckDelaySec: '1',
    })
    const result = await runPwshFileAsync(wrapper, r59ChildEnv(fx.profileDir, {}, ['PM2_HOME']), operatorCwd)
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.deepEqual(
      readPm2HomeLog(fx.homeLogPath).map((entry) => `${entry.command}@${entry.home}`),
      [`stop@${absoluteHome}`, `restart@${absoluteHome}`],
      'every pm2 call must see the ONE absolute home whose existence was checked',
    )
    assert.match(result.stdout, /backend started:\s+pm2-restart/)
    assert.ok(
      result.stdout.includes(`${absoluteHome} (source: parameter -Pm2Home)`),
      `the report must name the absolute home:\n${result.stdout}`,
    )
  } finally {
    health.server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('end-to-end (acid fixture, R59): an explicit -Pm2Home that does not exist refuses at startup, before pm2, the gate or any backup', () => {
  const root = mkLongTempDir('ms2-upgrade-r59-')
  try {
    const fx = setUpR59Fixture(root, { runtimeHomeExists: false })
    const archivePath = buildR59LiveRootAndArchive(fx)
    const result = runUpgradeScript(
      [
        '-PackageArchive', archivePath,
        '-RootDir', fx.liveRoot,
        '-EnvFile', path.join(fx.liveRoot, 'docker/app.env'),
        '-BackupRoot', fx.backupRoot,
        '-StagingRoot', fx.stagingRoot,
        '-Pm2Home', path.join(root, 'typo-pm2-home'),
        '-RunMigrations', '0',
        '-RestartService', '0',
      ],
      { USERPROFILE: fx.profileDir, PSModuleAnalysisCachePath: path.join(fx.profileDir, 'ps-module-analysis-cache') },
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr + result.stdout, /PM2_HOME_NOT_FOUND/)
    assert.ok(!fs.existsSync(fx.pm2LogPath), 'pm2 must never be invoked')
    assert.ok(!fs.existsSync(fx.witness.flagPath), 'the gate must never be raised')
    assert.ok(!fs.existsSync(fx.backupRoot) || fs.readdirSync(fx.backupRoot).length === 0, 'no backup should be written')
    assert.ok(!fs.existsSync(path.join(root, 'typo-pm2-home')), 'the typo home must not be created')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ── 4. END-TO-END: replay both canonical -Exclude patterns against the acid fixture

// Splices a REDEFINITION of Copy-TreeExcludingNodeModules into a COPY of the real
// script, inserted immediately before the `if ($MyInvocation...)` main-execution
// gate. PowerShell functions are ordinary statements: a later `function Name {...}`
// executed before Name is first CALLED simply replaces the earlier definition in
// that scope, so this does not require parsing or removing the original body — the
// mutated file's Main block ends up calling the LAST definition reached, which is
// this one. The real script on disk is never touched.
function buildMutatedScript(patternBody) {
  const anchor = "if ($MyInvocation.InvocationName -ne '.') {"
  const idx = scriptSource.indexOf(anchor)
  assert.ok(idx > -1, 'main-execution anchor not found in the real script')
  const override = [
    'function Copy-TreeExcludingNodeModules {',
    '  param(',
    '    [Parameter(Mandatory = $true)][string]$Source,',
    '    [Parameter(Mandatory = $true)][string]$Destination',
    '  )',
    '  New-Item -ItemType Directory -Force -Path $Destination | Out-Null',
    `  ${patternBody}`,
    '  return [pscustomobject]@{ Copied = -1; Skipped = -1 }',
    '}',
    '',
  ].join('\n')
  return scriptSource.slice(0, idx) + override + scriptSource.slice(idx)
}

const FORBIDDEN_PATTERNS = {
  // Canonical pattern 1 (the actual F22 defect): piped Get-ChildItem -Exclude into
  // a recursive Copy-Item. Empirically (verified against this exact shape): the
  // correctly-nested files CAN still end up present, but node_modules content
  // leaks through to other, wrong paths — -Exclude filters only items literally
  // NAMED 'node_modules' from the flat -Recurse listing; every descendant of an
  // excluded node_modules directory is still individually emitted and copied.
  'piped-gci-exclude':
    "Get-ChildItem -LiteralPath $Source -Recurse -Exclude 'node_modules' | Copy-Item -Destination $Destination -Recurse -Force",
  // Canonical pattern 2: a single, direct Copy-Item -Recurse -Exclude with a
  // bare (non-wildcarded) -Path. Per Microsoft's own documentation, -Exclude on
  // Copy-Item takes effect ONLY when -Path contains a wildcard — with a bare
  // directory path -Exclude has ZERO effect (node_modules is NOT excluded at
  // all), AND -Recurse into an EXISTING destination nests everything one level
  // too deep under a copy of the source's own leaf name, so every expected file
  // is "missing" at its correct path.
  'direct-copyitem-exclude':
    'Copy-Item -Path $Source -Destination $Destination -Recurse -Exclude \'node_modules\' -Force',
}

for (const [patternName, patternBody] of Object.entries(FORBIDDEN_PATTERNS)) {
  test(`end-to-end (acid fixture): the ${patternName} forbidden pattern FAILS the upgrade`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms2-upgrade-replay-'))
    try {
      const liveRoot = path.join(root, 'live')
      const backupRoot = path.join(root, 'backups')
      const stagingRoot = path.join(root, 'staging')
      const pm2LogPath = path.join(root, 'pm2-calls.log')

      buildAcidLiveRoot(liveRoot, { pm2LogPath })
      const { archivePath } = buildAcidArchive(root)

      const mutatedScriptPath = path.join(root, `mutated-${patternName}.ps1`)
      fs.writeFileSync(mutatedScriptPath, buildMutatedScript(patternBody))

      const result = spawnSync(
        PWSH,
        [
          '-NoProfile', '-NonInteractive', '-File', mutatedScriptPath,
          '-PackageArchive', archivePath,
          '-RootDir', liveRoot,
          '-EnvFile', path.join(liveRoot, 'docker/app.env'),
          '-BackupRoot', backupRoot,
          '-StagingRoot', stagingRoot,
          '-RunMigrations', '0',
          '-RestartService', '0',
        ],
        { encoding: 'utf8' },
      )

      assert.notEqual(
        result.status,
        0,
        `the ${patternName} forbidden pattern must fail the upgrade, not pass silently.\n` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      )
      const combined = result.stderr + result.stdout
      assert.match(
        combined,
        /UPGRADE_ASSERTION_MISSING_FILES|UPGRADE_PLUGIN_HASH_VERIFICATION_FAILED|UPGRADE_NODE_MODULES_LEAK_DETECTED/,
        `the ${patternName} failure must be caught by one of this script's own gates, not some unrelated crash`,
      )
      assert.match(combined, /RESTORE REQUIRED/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

