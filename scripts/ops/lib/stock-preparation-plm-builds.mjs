import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(filename), '../../..')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (parent, file) => {
  const relative = path.relative(parent, path.resolve(file))
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
const relative = file => {
  assert(inside(repoRoot, file), 'PLM_BUILD_REPOSITORY_INPUT_REQUIRED')
  return path.relative(repoRoot, file).replaceAll('\\', '/')
}
const safePath = value => {
  assert(typeof value === 'string' && !value.includes('\\') && !path.posix.isAbsolute(value) && !value.includes(':')
    && value.split('/').every(part => part && part !== '.' && part !== '..' && !/^\.env(?:\.|$)/i.test(part)),
  'PLM_BUILD_SAFE_PATH_REQUIRED')
  return path.join(repoRoot, value)
}
const filesUnder = directory => {
  const result = []
  if (!fs.existsSync(directory)) return result
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), 'PLM_BUILD_OUTPUT_SYMLINK_DENIED')
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...filesUnder(file))
    else { assert(entry.isFile(), 'PLM_BUILD_PLAIN_FILE_REQUIRED'); result.push(file) }
  }
  return result.sort()
}
export function assertBuildScratch(scratchDir) {
  assert.equal(path.relative(fs.realpathSync(scratchDir), scratchDir), '', 'PLM_BUILD_SCRATCH_REDIRECTED')
  assert.equal(path.dirname(scratchDir), path.join(fs.realpathSync(repoRoot), 'tmp'), 'PLM_BUILD_SCRATCH_PARENT_INVALID')
  const name = path.basename(scratchDir)
  assert(/^stock-preparation-plm-full-app-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name),
    'PLM_BUILD_SCRATCH_NAME_INVALID')
  const marker = JSON.parse(fs.readFileSync(path.join(scratchDir, 'owner.json'), 'utf8'))
  assert.deepEqual(Object.keys(marker).sort(), ['nonce', 'owner', 'pid', 'repoRoot'])
  assert.equal(marker.owner, 'PLM_FULL_APP_SCRATCH')
  assert.equal(marker.nonce, name.slice('stock-preparation-plm-full-app-'.length))
  assert.equal(marker.repoRoot, fs.realpathSync(repoRoot))
  assert(Number.isSafeInteger(marker.pid) && marker.pid > 0)
  return marker
}

/** Validate real bytes, not an "output exists" or green receipt assertion. */
export function verifyBuildReceipt(scratchDir, kind) {
  assertBuildScratch(scratchDir)
  assert(['core', 'web'].includes(kind), 'PLM_BUILD_KIND_INVALID')
  const owner = path.join(scratchDir, 'build', kind === 'core' ? 'backend' : 'web')
  const receiptFile = path.join(owner, 'receipt.json')
  const receiptBytes = fs.readFileSync(receiptFile)
  const receipt = JSON.parse(receiptBytes)
  assert.equal(receipt.schemaVersion, 1)
  assert.equal(receipt.kind, kind)
  assert.equal(receipt.result, 'passed', 'PLM_BUILD_NOT_PASSED')
  assert.equal(receipt.outDir, relative(path.join(owner, 'dist')))
  assert.equal(receipt.entry, receipt.outDir + (kind === 'core' ? '/src/index.js' : '/index.html'))
  assert.equal(receipt.sourceUnchanged, true)
  assert.equal(receipt.isolation.forbiddenConnections, 0)
  assert.equal(receipt.isolation.forbiddenEnvReads, 0)
  assert.equal(receipt.isolation.allowedConnections, 0)
  assert.equal(receipt.isolation.databaseAllowed, false)
  assert.equal(receipt.outsideOwnerWriteAttempts, 0)
  assert.equal(receipt.packageTypecheckRun, false, 'PLM_BUILD_UNEARNED_PACKAGE_GATE')
  const inputs = new Set()
  assert(Array.isArray(receipt.inputs) && receipt.inputs.length > 0)
  for (const item of receipt.inputs) {
    assert(!inputs.has(item.path) && /^[a-f0-9]{64}$/.test(item.sha256))
    inputs.add(item.path)
    assert.equal(sha256(fs.readFileSync(safePath(item.path))), item.sha256, 'PLM_BUILD_INPUT_CHANGED')
  }
  for (const required of [relative(filename), 'pnpm-lock.yaml', 'package.json',
    'scripts/ops/lib/stock-preparation-plm-network-guard.cjs']) assert(inputs.has(required))
  const outputs = new Set()
  assert(Array.isArray(receipt.emittedFiles) && receipt.emittedFiles.length > 0)
  for (const item of receipt.emittedFiles) {
    assert(!outputs.has(item.path) && item.path.startsWith(receipt.outDir + '/') && /^[a-f0-9]{64}$/.test(item.sha256))
    const output = safePath(item.path)
    assert.equal(path.relative(fs.realpathSync(output), output), '', 'PLM_BUILD_OUTPUT_REDIRECTED')
    const bytes = fs.readFileSync(output)
    assert.equal(bytes.length, item.bytes)
    assert.equal(sha256(bytes), item.sha256, 'PLM_BUILD_OUTPUT_CHANGED')
    outputs.add(item.path)
  }
  assert(outputs.has(receipt.entry))
  assert.deepEqual(filesUnder(safePath(receipt.outDir)).map(relative).sort(), [...outputs].sort(),
    'PLM_BUILD_OUTPUT_INVENTORY_CHANGED')
  if (kind === 'core') {
    assert.equal(receipt.diagnostics.length, 0, 'PLM_BUILD_CORE_DIAGNOSTICS')
    assert.equal(receipt.emitSkipped, false)
    assert.equal(receipt.compilerOptions.module, 'CommonJS')
    assert.deepEqual(receipt.compilerOptions.overrides, ['outDir'])
    assert.equal(fs.realpathSync(path.join(owner, 'node_modules')),
      fs.realpathSync(path.join(repoRoot, 'packages/core-backend/node_modules')))
    assert.equal(sha256(fs.readFileSync(path.join(owner, 'package.json'))), receipt.commonjsPackageSha256)
    assert.equal(JSON.parse(fs.readFileSync(path.join(owner, 'package.json'))).type, 'commonjs')
    const assetPaths = new Set()
    const sqlRoots = [
      ['packages/core-backend/migrations', path.join(owner, 'migrations')],
      ['packages/core-backend/src/db/migrations', path.join(owner, 'dist/src/db/migrations')],
    ]
    const expectedAssets = sqlRoots.flatMap(([source, target]) => filesUnder(safePath(source))
      .filter(file => file.endsWith('.sql')).map(file => ({ source: relative(file),
        path: relative(path.join(target, path.relative(safePath(source), file))) })))
    assert.deepEqual(receipt.runtimeAssets.map(({ source, path }) => ({ source, path })), expectedAssets)
    for (const asset of receipt.runtimeAssets) {
      assert(!assetPaths.has(asset.path) && inputs.has(asset.source))
      assetPaths.add(asset.path)
      const bytes = fs.readFileSync(safePath(asset.path))
      assert.equal(bytes.length, asset.bytes)
      assert.equal(sha256(bytes), asset.sha256)
      assert.equal(sha256(fs.readFileSync(safePath(asset.source))), asset.sha256)
    }
    assert.deepEqual(sqlRoots.flatMap(([, target]) => filesUnder(target).filter(file => file.endsWith('.sql')))
      .map(relative).sort(), [...assetPaths].sort())
  } else {
    assert.equal(receipt.originalConfig, 'apps/web/vite.config.ts')
    assert.equal(receipt.originalEntry, 'apps/web/index.html')
    assert.equal(receipt.originalMain, 'apps/web/src/main.ts')
    assert.equal(receipt.mode, 'production')
    assert.equal(receipt.manualChunksRetained, true)
    assert.equal(receipt.wrapperConfig, relative(path.join(owner, 'vite.config.mjs')))
    const wrapper = fs.readFileSync(safePath(receipt.wrapperConfig))
    assert.equal(sha256(wrapper), receipt.wrapperSha256)
    const specifier = path.relative(owner, path.join(repoRoot, receipt.originalConfig)).replaceAll('\\', '/')
    assert.equal(wrapper.toString('utf8'), "export { default } from '" + specifier + "'\n")
  }
  return { ...receipt, receipt: relative(receiptFile), receiptSha256: sha256(receiptBytes) }
}

async function build(kind, scratchDir) {
  const marker = assertBuildScratch(scratchDir)
  assert.equal(marker.pid, process.ppid, 'PLM_BUILD_OWNER_PROCESS_MISMATCH')
  const guard = globalThis.__PLM_FULL_APP_NETWORK_GUARD__
  assert(guard && guard.databaseAllowed === false, 'PLM_BUILD_GUARD_REQUIRED')
  const keep = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'COMSPEC', 'PATHEXT', 'HOME'])
  for (const key of Object.keys(process.env)) if (!keep.has(key.toUpperCase())) delete process.env[key]
  const owner = path.join(scratchDir, 'build', kind === 'core' ? 'backend' : 'web')
  fs.mkdirSync(owner, { recursive: true })
  const outDir = path.join(owner, 'dist')
  const envDir = path.join(owner, 'empty-env')
  const toolTemp = path.join(owner, 'tool-temp')
  fs.mkdirSync(envDir); fs.mkdirSync(toolTemp)
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = toolTemp
  process.env.METASHEET_ENV_DIR = envDir
  const rawRead = fs.readFileSync.bind(fs)
  const inputs = new Map()
  const readInput = file => {
    const absolute = path.resolve(file)
    const bytes = rawRead(absolute)
    if (inside(owner, absolute)) return bytes
    const key = relative(absolute)
    const digest = sha256(bytes)
    assert(!inputs.has(key) || inputs.get(key) === digest, 'PLM_BUILD_INPUT_CHANGED_DURING_BUILD')
    inputs.set(key, digest)
    return bytes
  }
  for (const file of [filename, path.join(repoRoot, 'package.json'), path.join(repoRoot, 'pnpm-lock.yaml'),
    path.join(repoRoot, 'scripts/ops/lib/stock-preparation-plm-network-guard.cjs')]) readInput(file)
  let outsideOwnerWriteAttempts = 0
  const checkWrite = input => {
    const file = input instanceof URL ? fileURLToPath(input) : typeof input === 'string' ? path.resolve(input) : null
    if (!file || (file !== owner && !inside(owner, file))) {
      outsideOwnerWriteAttempts++
      throw new Error('PLM_BUILD_WRITE_OUTSIDE_OWNER')
    }
  }
  for (const [target, methods] of [[fs, ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
    'mkdir', 'mkdirSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync']],
  [fs.promises, ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rm', 'rmdir']]]) {
    for (const method of methods) {
      const original = target[method]
      target[method] = function (file, ...args) { checkWrite(file); return original.call(this, file, ...args) }
    }
  }
  for (const target of [fs, fs.promises]) {
    for (const method of ['copyFile', 'rename', 'cp', ...(target === fs ? ['copyFileSync', 'renameSync', 'cpSync'] : [])]) {
      const original = target[method]
      if (!original) continue
      target[method] = function (from, to, ...args) {
        if (method.startsWith('rename')) checkWrite(from)
        checkWrite(to)
        return original.call(this, from, to, ...args)
      }
    }
    for (const method of ['readFile', ...(target === fs ? ['readFileSync'] : [])]) {
      const original = target[method]
      target[method] = function (file, ...args) {
        const absolute = file instanceof URL ? fileURLToPath(file) : typeof file === 'string' ? path.resolve(file) : null
        if (absolute && fs.existsSync(absolute) && fs.statSync(absolute).isFile()) readInput(absolute)
        return original.call(this, file, ...args)
      }
    }
    for (const method of ['open', ...(target === fs ? ['openSync'] : [])]) {
      const original = target[method]
      target[method] = function (file, flags, ...args) {
        if (typeof flags === 'number' ? flags !== fs.constants.O_RDONLY : /[wa+]/.test(flags)) checkWrite(file)
        return original.call(this, file, flags, ...args)
      }
    }
  }
  const originalWriteStream = fs.createWriteStream
  fs.createWriteStream = function (file, ...args) { checkWrite(file); return originalWriteStream.call(this, file, ...args) }
  syncBuiltinESMExports()
  const receipt = { schemaVersion: 1, kind, outDir: relative(outDir), nodeVersion: process.versions.node,
    packageTypecheckRun: false }
  const write = (file, text) => { checkWrite(file); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
  if (kind === 'core') {
    const core = path.join(repoRoot, 'packages/core-backend')
    const req = createRequire(path.join(core, 'package.json'))
    const ts = req('typescript')
    readInput(req.resolve('typescript/package.json'))
    readInput(req.resolve('typescript'))
    const configPath = path.join(core, 'tsconfig.json')
    const configFile = ts.readConfigFile(configPath, file => readInput(file).toString('utf8'))
    assert(!configFile.error, 'PLM_BUILD_CONFIG_INVALID')
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, core, { outDir }, configPath)
    assert.equal(parsed.options.module, ts.ModuleKind.CommonJS)
    assert.equal(path.resolve(parsed.options.rootDir), core)
    const host = ts.createCompilerHost(parsed.options)
    host.readFile = file => { try { return readInput(file).toString('utf8') } catch (error) { if (error.code === 'ENOENT') return undefined; throw error } }
    host.writeFile = (file, text, bom) => { assert(inside(outDir, file), 'PLM_BUILD_EMIT_OUTSIDE_DIST'); write(file, (bom ? '\uFEFF' : '') + text) }
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options,
      projectReferences: parsed.projectReferences, configFileParsingDiagnostics: parsed.errors, host })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    const emission = program.emit()
    const allDiagnostics = ts.sortAndDeduplicateDiagnostics([...diagnostics, ...emission.diagnostics])
    receipt.diagnostics = allDiagnostics.map(item => ({ code: item.code, category: item.category,
      path: item.file ? relative(item.file.fileName) : null,
      line: item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start).line + 1 : null }))
    receipt.emitSkipped = emission.emitSkipped
    receipt.compilerVersion = ts.version
    receipt.compilerOptions = { module: 'CommonJS', overrides: ['outDir'] }
    // The unified provider also enumerates raw SQL beside the compiled tree.
    // Preserve original bytes; do not synthesize a migration ledger or omit SQL.
    receipt.runtimeAssets = [
      [path.join(core, 'migrations'), path.join(owner, 'migrations')],
      [path.join(core, 'src/db/migrations'), path.join(outDir, 'src/db/migrations')],
    ].flatMap(([source, target]) => filesUnder(source).filter(file => file.endsWith('.sql')).map(file => {
      const bytes = readInput(file)
      const output = path.join(target, path.relative(source, file))
      write(output, bytes)
      return { source: relative(file), path: relative(output), bytes: bytes.length, sha256: sha256(bytes) }
    }))
    const commonjs = JSON.stringify({ private: true, type: 'commonjs' }) + '\n'
    write(path.join(owner, 'package.json'), commonjs)
    receipt.commonjsPackageSha256 = sha256(commonjs)
    fs.symlinkSync(path.join(core, 'node_modules'), path.join(owner, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir')
    receipt.entry = relative(path.join(outDir, 'src/index.js'))
  } else {
    const web = path.join(repoRoot, 'apps/web')
    const req = createRequire(path.join(web, 'package.json'))
    const metadata = req.resolve('vite/package.json')
    const vitePackage = JSON.parse(readInput(metadata))
    const viteEntry = path.join(path.dirname(metadata), 'dist/node/index.js')
    readInput(viteEntry)
    readInput(path.join(web, 'package.json'))
    readInput(path.join(web, 'index.html'))
    const originalConfig = path.join(web, 'vite.config.ts')
    const wrapperConfig = path.join(owner, 'vite.config.mjs')
    const specifier = path.relative(owner, originalConfig).replaceAll('\\', '/')
    const wrapper = "export { default } from '" + specifier + "'\n"
    write(wrapperConfig, wrapper)
    let resolvedConfig
    let warnings = 0
    const logger = { hasWarned: false, info() {}, error() {}, clearScreen() {}, hasErrorLogged() { return false },
      warn() { warnings++; logger.hasWarned = true }, warnOnce() { warnings++; logger.hasWarned = true } }
    const audit = { name: 'plm-full-app-input-audit', enforce: 'pre',
      configResolved(config) {
        resolvedConfig = config
        assert(config.command === 'build' && config.mode === 'production' && config.isProduction)
        assert.equal(path.resolve(config.root), web)
        assert.equal(path.resolve(config.envDir), envDir)
        assert.equal(path.resolve(config.build.outDir), outDir)
        assert.equal(config.base, '/')
        assert.equal(config.build.rollupOptions.input, undefined)
        assert.equal(config.build.ssr, false)
        assert.equal(typeof config.build.rollupOptions.output.manualChunks, 'function')
        for (const file of config.configFileDependencies) readInput(file)
      },
      load(id) {
        const file = id.split('?')[0]
        if (!file.includes('\0') && path.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile()) readInput(file)
        return null
      } }
    const { build: viteBuild } = await import(pathToFileURL(viteEntry).href)
    await viteBuild({ root: web, configFile: wrapperConfig, mode: 'production',
      cacheDir: path.join(owner, 'cache'), customLogger: logger, clearScreen: false,
      plugins: [audit], build: { outDir, emptyOutDir: false } })
    Object.assign(receipt, { viteVersion: vitePackage.version, entry: relative(path.join(outDir, 'index.html')),
      originalConfig: relative(originalConfig), originalEntry: 'apps/web/index.html', originalMain: 'apps/web/src/main.ts',
      mode: 'production', manualChunksRetained: Boolean(resolvedConfig), warnings,
      wrapperConfig: relative(wrapperConfig), wrapperSha256: sha256(wrapper) })
  }
  receipt.inputs = [...inputs].sort(([a], [b]) => a.localeCompare(b)).map(([file, digest]) => ({ path: file, sha256: digest }))
  receipt.sourceUnchanged = receipt.inputs.every(item => sha256(rawRead(safePath(item.path))) === item.sha256)
  receipt.emittedFiles = filesUnder(outDir).map(file => {
    const bytes = rawRead(file)
    return { path: relative(file), bytes: bytes.length, sha256: sha256(bytes) }
  })
  receipt.isolation = { ...guard.snapshot(), databaseAllowed: guard.databaseAllowed }
  receipt.outsideOwnerWriteAttempts = outsideOwnerWriteAttempts
  receipt.result = receipt.sourceUnchanged && outsideOwnerWriteAttempts === 0
    && receipt.emittedFiles.some(item => item.path === receipt.entry)
    && (kind !== 'core' || (receipt.diagnostics.length === 0 && !receipt.emitSkipped))
    && receipt.isolation.forbiddenConnections === 0 && receipt.isolation.forbiddenEnvReads === 0
    && receipt.isolation.allowedConnections === 0 ? 'passed' : 'failed'
  receipt.limitations = ['Node IO observations do not attest native tooling or OS network isolation.',
    'Web is the Vite stage; the separate package vue-tsc gate is not run by this builder.']
  write(path.join(owner, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log('PLM_FULL_APP_BUILD ' + JSON.stringify({ kind, result: receipt.result, inputs: receipt.inputs.length,
    outputs: receipt.emittedFiles.length, diagnostics: receipt.diagnostics?.length ?? 0 }))
  assert.equal(receipt.result, 'passed', 'PLM_BUILD_FAILED')
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  try {
    assert.equal(process.argv.length, 4, 'PLM_BUILD_ARGUMENTS_INVALID')
    const kind = process.argv[2]
    assert(['core', 'web'].includes(kind), 'PLM_BUILD_KIND_INVALID')
    await build(kind, path.resolve(process.argv[3]))
  } catch (error) {
    console.error('PLM_FULL_APP_BUILD_FAILED ' + JSON.stringify({ code: error instanceof assert.AssertionError
      ? (/^PLM_[A-Z0-9_]+/.exec(error.message)?.[0] ?? 'ASSERTION_FAILED')
      : (/^PLM_[A-Z0-9_]+/.exec(error?.message ?? '')?.[0] ?? 'BUILD_ERROR') }))
    process.exitCode = 1
  }
}
