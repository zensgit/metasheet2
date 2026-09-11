import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
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
      'ops/maintenance/maintenance.html is not in the package INCLUDED_PATHS, so the runbook must tell the operator to copy it by hand',
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
  return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', harness], { encoding: 'utf8' })
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

// spawnSync blocks this process's event loop, so a node http server in the same
// process could never answer a harness started with runPwshHarness. Anything that
// needs the two to talk must use this async variant.
function runPwshHarnessAsync(harness) {
  return new Promise((resolve) => {
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', harness])
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

function writePm2Stub(liveRoot, pm2LogPath, witness = null) {
  const binDir = path.join(liveRoot, 'node_modules', '.bin')
  fs.mkdirSync(binDir, { recursive: true })
  const stubPath = path.join(binDir, 'pm2.cmd')
  if (process.platform === 'win32') {
    const witnessLine = witness
      ? `if exist "${witness.flagPath}" (echo FLAG_PRESENT %* >> "${witness.pm2FlagWitnessPath}") else (echo FLAG_ABSENT %* >> "${witness.pm2FlagWitnessPath}")`
      : 'rem no maintenance-flag witness requested'
    fs.writeFileSync(stubPath, ['@echo off', `echo %* >> "${pm2LogPath}"`, witnessLine, 'exit /b 0', ''].join('\r\n'))
  } else {
    // pwsh's `&` call operator execs the file directly on non-Windows — the .cmd
    // extension is irrelevant there, only the shebang and the executable bit are.
    // Same relative path on both OSes, so Resolve-Pm2Command in the script needs
    // no platform branching of its own.
    const witnessLine = witness
      ? `if [ -f "${witness.flagPath}" ]; then echo "FLAG_PRESENT $*" >> "${witness.pm2FlagWitnessPath}"; else echo "FLAG_ABSENT $*" >> "${witness.pm2FlagWitnessPath}"; fi\n`
      : ''
    fs.writeFileSync(stubPath, `#!/bin/sh\necho "$*" >> "${pm2LogPath}"\n${witnessLine}exit 0\n`)
    fs.chmodSync(stubPath, 0o755)
  }
  return stubPath
}

function buildAcidLiveRoot(liveRoot, { pm2LogPath, backendPort = null, witness = null }) {
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

  writePm2Stub(liveRoot, pm2LogPath, witness)
}

function buildAcidArchive(root, options = {}) {
  const stageParent = path.join(root, 'stage')
  const packageName = 'acid-fixture-multitable-onprem-package'
  const stageDir = path.join(stageParent, packageName)
  buildAcidPackageStage(stageDir, options)

  const archivePath = path.join(root, `${packageName}.zip`)
  const compress = spawnSync(
    'pwsh',
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
  return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', scriptPath, ...args], {
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
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', scriptPath, ...args], {
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
function startHealthServer({ flagPath = null } = {}) {
  return new Promise((resolve) => {
    const requests = []
    const server = http.createServer((req, res) => {
      requests.push({
        url: req.url,
        flagExists: flagPath ? fs.existsSync(flagPath) : null,
        // The one-shot "is the gate actually wired on this host" probe tags
        // itself; nginx's `if (-f ...)` is header-blind, so the tag cannot
        // change what the probe measures on a real box — it only lets these
        // fixtures tell that request apart from the two health probes.
        gateProbe: req.headers['x-upgrade-gate-probe'] === '1',
      })
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
      'pwsh',
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
      'pwsh',
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
        'pwsh',
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

