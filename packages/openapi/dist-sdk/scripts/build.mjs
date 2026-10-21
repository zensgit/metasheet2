import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

// Resolve a package's CLI binary without invoking a package manager shim.
//
// On Windows there is often no `pnpm` executable on PATH (only npm-created
// shims: pnpm, pnpm.cmd, pnpm.ps1 with no .exe), so `execFileSync('pnpm', ...)`
// throws ENOENT, and `execFileSync('pnpm.cmd', ...)` throws EINVAL under
// certain Node versions. Shelling out (`shell: true`) is avoided too: Node 24+
// deprecates unquoted shell strings (DEP0190) and argument-array quoting on
// Windows shells is unreliable, especially with paths containing spaces.
//
// Instead, resolve the dependency's own package.json via `require.resolve`
// (which correctly walks node_modules / pnpm's content-addressed store from
// this file's location) and read its `bin` field directly, rather than
// `require.resolve('<pkg>/<bin-path>')`, because a package's `exports` map
// (e.g. openapi-typescript's `"./*.js": "./*.mjs"` rewrite) can make that
// subpath unresolvable even though the bin file exists on disk under that
// exact path. The resolved absolute path is then invoked with
// `execFileSync(process.execPath, [binPath, ...args])`, which runs it via
// the current Node binary with no shell involved and works identically on
// Windows, macOS and Linux (this same resolution logic finds the same
// physical files on Linux CI, so CI behavior is unchanged).
export function resolveBin(pkgName, binName = pkgName, { requireFn } = {}) {
  // `requireFn`, when provided (tests only), is a plain resolve function
  // `(specifier) => absolutePath`. In production this defaults to the
  // `.resolve` method of a real `require` built from this module's URL.
  const resolve = requireFn || createRequire(import.meta.url).resolve
  let pkgJsonPath
  try {
    pkgJsonPath = resolve(`${pkgName}/package.json`)
  } catch (err) {
    throw new Error(
      `Cannot resolve package "${pkgName}" (needed for its "${binName}" CLI binary): ${err.message}`,
    )
  }
  const pkgDir = path.dirname(pkgJsonPath)
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
  const bin = pkg.bin
  let rel
  if (typeof bin === 'string') {
    rel = bin
  } else if (bin && typeof bin === 'object') {
    rel = bin[binName]
  }
  if (!rel) {
    throw new Error(
      `Cannot resolve CLI binary "${binName}" for package "${pkgName}": ` +
        `no matching "bin" entry in ${pkgJsonPath}`,
    )
  }
  return path.join(pkgDir, rel)
}

export function runBuild({
  cwd = process.cwd(),
  execFile = execFileSync,
  resolveBinFn = resolveBin,
} = {}) {
  const root = path.resolve(cwd, '..')
  const dist = path.resolve(root, 'dist')
  const outDir = path.resolve(cwd, '.')

  const openapiSrc = path.join(dist, 'openapi.yaml')
  if (!fs.existsSync(openapiSrc)) {
    throw new Error('openapi.yaml not found, run openapi build first')
  }
  const jsOut = path.join(outDir, 'index.js')
  const dtsOut = path.join(outDir, 'index.d.ts')
  fs.writeFileSync(jsOut, `// ESM stub exports types only\nexport {};\n`)

  const openapiTypescriptCli = resolveBinFn('openapi-typescript')
  execFile(process.execPath, [openapiTypescriptCli, openapiSrc, '--output', dtsOut], {
    cwd,
    stdio: 'inherit',
  })

  // openapi-typescript writes with the platform's default newline handling in
  // some environments; normalize to LF so the generated file's line endings
  // match what is committed to git (the repository stores this file as LF;
  // Windows checkouts see CRLF only via git's own autocrlf conversion).
  if (fs.existsSync(dtsOut)) {
    const generated = fs.readFileSync(dtsOut, 'utf8')
    const normalized = generated.replace(/\r\n/g, '\n')
    if (normalized !== generated) {
      fs.writeFileSync(dtsOut, normalized)
    }
  }

  const tscCli = resolveBinFn('typescript', 'tsc')
  execFile(
    process.execPath,
    [
      tscCli,
      'client.ts',
      '--declaration',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2020',
      '--skipLibCheck',
    ],
    {
      cwd,
      stdio: 'inherit',
    },
  )

  return { jsOut, dtsOut }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  try {
    runBuild()
    console.log('SDK packaged to dist-sdk')
  } catch (err) {
    console.error(err.message || err)
    process.exit(1)
  }
}
