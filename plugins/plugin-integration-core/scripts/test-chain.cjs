'use strict'

/**
 * The plugin's explicit test chain: parser, shape validator, and runner.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The chain used to be one ~14 KB `&&` string in `package.json`'s `scripts.test`. `package.json`
 * is a PINNED RUNTIME FILE of the sealed-export package-provenance manifest
 * (`runtimeFiles.pluginPackageJson` in `lib/sealed-export/vectors/s6a-package-provenance-pins.json`
 * is its whole-file sha256), so every PR that added a test edited the same package.json line AND
 * recomputed that pin — a guaranteed two-file conflict between any two concurrent plugin PRs.
 *
 * That churn also hollowed the pin out. `__tests__/test-chain-completeness.test.cjs` records the
 * #4801 P1 finding verbatim: with an `echo` prefix on a chain command "and the routine
 * `runtimeFiles.pluginPackageJson` re-pin, `pnpm test` exits 0, the suite never runs" — "the digest
 * pin cannot separate that from a legitimate re-pin". A hash that legitimately moves in every
 * single PR cannot testify about the bytes that moved.
 *
 * So the volatile list moved to `test-chain.txt` and the protection moved from a digest to
 * STRUCTURE, which is strictly stronger for this content:
 *
 *   1. SHAPE ALLOWLIST (`assertChainShape`). A chain line must match `COMMAND_SHAPE` exactly.
 *      `echo node __tests__/x.test.cjs`, `xnode …`, `… || true`, `# …`, `… ; curl evil | sh` are
 *      not merely detected, they are unrepresentable — the character class permits no space,
 *      quote, or shell metacharacter beyond the two fixed forms.
 *   2. NO SHELL (`runTestChain`). Commands are executed via `spawnSync(process.execPath, argv)`
 *      with `shell: false`. Even if a line escaped the allowlist, there is no shell to interpret
 *      it. The old `&&` string was, by construction, handed to a shell.
 *   3. BIDIRECTIONAL COMPLETENESS (`__tests__/test-chain-completeness.test.cjs`). Every
 *      `*.test.{cjs,mjs}` in `__tests__/` must appear here exactly once, AND every line here must
 *      name a file that exists. The digest never checked either direction.
 *
 * Net effect on the pin: `package.json`'s whole-file sha256 is UNCHANGED IN KIND — it still covers
 * dependencies, all 128 remaining named scripts, and the manifest, byte for byte. It simply stops
 * moving for reasons that have nothing to do with what it protects, which is what makes a moved
 * hash worth reading again.
 *
 * FAIL-FAST SEMANTICS are identical to the `&&` chain it replaces: the first non-zero exit stops
 * the run and becomes this process's exit code.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const PACKAGE_DIR = path.join(__dirname, '..')
const CHAIN_FILE_NAME = 'test-chain.txt'

/**
 * The ONLY two command shapes the chain may express. Deliberately anchored and deliberately
 * narrow: no spaces beyond the two literal ones, no quotes, no shell metacharacters, no `..`
 * (the character class excludes `/`, so a line cannot escape `__tests__/`).
 */
const COMMAND_SHAPE =
  /^node (?:--import tsx )?__tests__\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.(?:cjs|mjs)$/

function chainFilePath(packageDir = PACKAGE_DIR) {
  return path.join(packageDir, CHAIN_FILE_NAME)
}

/**
 * Parse the chain file into an ordered list of commands.
 *
 * `\r` is stripped so a CRLF checkout cannot silently turn every exact-equality comparison (here,
 * in the completeness guard, and in the stage-ordering guard) into a mismatch. `.gitattributes`
 * pins this file to `eol=lf` as well; both belt and braces, because the failure mode is a
 * confusing red on Windows rather than anything a reviewer would read as tampering.
 */
function readTestChain(packageDir = PACKAGE_DIR) {
  const file = chainFilePath(packageDir)
  const text = fs.readFileSync(file, 'utf8')
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/**
 * Enforce the shape allowlist and the no-duplicates rule.
 *
 * Throws (rather than returning a verdict) so that every caller — the runner and the guards —
 * fails closed on a malformed chain instead of quietly running a subset.
 */
function assertChainShape(commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error('test chain is empty — refusing to report success')
  }
  const offending = commands.filter((command) => !COMMAND_SHAPE.test(command))
  if (offending.length > 0) {
    throw new Error(
      'test chain contains command(s) outside the allowed shapes ' +
        '(`node __tests__/<name>.test.cjs` or `node --import tsx __tests__/<name>.test.mjs`): ' +
        offending.map((c) => JSON.stringify(c)).join(', '),
    )
  }
  const seen = new Set()
  const duplicates = []
  for (const command of commands) {
    if (seen.has(command)) duplicates.push(command)
    seen.add(command)
  }
  if (duplicates.length > 0) {
    throw new Error(
      'test chain lists the same command more than once: ' + duplicates.join(', '),
    )
  }
  return commands
}

/** The suite file a chain command runs, e.g. `foo.test.cjs`. */
function suiteFileOf(command) {
  const match = /__tests__\/(\S+)$/.exec(command)
  return match ? match[1] : null
}

/** Argv for `process.execPath`, derived structurally — never by handing a string to a shell. */
function toArgv(command) {
  if (!COMMAND_SHAPE.test(command)) {
    throw new Error('refusing to build argv for a command outside the allowlist: ' + command)
  }
  return command.split(' ').slice(1)
}

function loadChain(packageDir = PACKAGE_DIR) {
  return assertChainShape(readTestChain(packageDir))
}

function runTestChain(packageDir = PACKAGE_DIR) {
  const commands = loadChain(packageDir)
  console.log(`test-chain: running ${commands.length} suites (fail-fast)`)
  for (const command of commands) {
    const result = spawnSync(process.execPath, toArgv(command), {
      cwd: packageDir,
      stdio: 'inherit',
      shell: false,
    })
    if (result.error) {
      console.error(`test-chain: failed to spawn \`${command}\`: ${result.error.message}`)
      return 1
    }
    if (result.signal) {
      console.error(`test-chain: \`${command}\` terminated by signal ${result.signal}`)
      return 1
    }
    if (result.status !== 0) {
      console.error(`test-chain: \`${command}\` exited ${result.status} — stopping the chain`)
      return result.status
    }
  }
  console.log(`test-chain: ${commands.length} suites passed`)
  return 0
}

module.exports = {
  CHAIN_FILE_NAME,
  COMMAND_SHAPE,
  chainFilePath,
  readTestChain,
  assertChainShape,
  loadChain,
  suiteFileOf,
  toArgv,
  runTestChain,
}

if (require.main === module) {
  process.exit(runTestChain())
}
