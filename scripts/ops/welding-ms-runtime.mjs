import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const contract = JSON.parse(fs.readFileSync(path.join(HERE, 'welding-ms-runtime-contract.json'), 'utf8'))
const SCHEMA = 'metasheet.welding_ms_runtime/1'
const MANIFEST = 'welding-ms-runtime-manifest.json'
const MAX_FILES = 120000
const MAX_BYTES = 2 * 1024 ** 3
const DEPENDENCY_ROOTS = [
  'node_modules', 'apps/web/node_modules', 'packages/core-backend/node_modules',
  'packages/openapi/dist-sdk/node_modules', 'packages/mssql-readonly-utils/node_modules',
]
const TOOL_FILES = ['scripts/ops/welding-ms-runtime.mjs', 'scripts/ops/welding-ms-runtime-contract.json']
const REQUIRED_FILES = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'apps/web/package.json', 'apps/web/dist/index.html',
  'packages/core-backend/package.json', 'packages/core-backend/dist/src/index.js',
  'packages/core-backend/dist/src/db/migrate.js', 'packages/core-backend/dist/src/db/migration-provider.js',
  'packages/core-backend/dist/src/routes/welding.js', 'packages/core-backend/dist/src/routes/welding-cad-host.js',
  'packages/mssql-readonly-utils/package.json', 'packages/mssql-readonly-utils/index.cjs',
  'packages/openapi/package.json', 'packages/openapi/dist-sdk/package.json',
  'packages/openapi/dist-sdk/index.js', 'tools/cli/package.json', ...TOOL_FILES, ...contract.sql,
  ...contract.pluginPackages,
]
const TREES = [
  ...DEPENDENCY_ROOTS, 'apps/web/dist', 'packages/core-backend/dist', 'packages/openapi/dist-sdk',
  ...Object.keys(contract.plugins).map((name) => `plugins/${name}`),
]
const EXTRA_IMPORTS = [
  ['plugin-attendance', 'zod'], ['plugin-integration-core', 'mssql'],
  ['plugin-integration-core', 'pg'], ['plugin-integration-core', '@metasheet/mssql-readonly-utils'],
  ['plugin-intelligent-restore', 'vue'], ['plugin-telemetry-otel', 'prom-client'],
]

function requireCondition(condition, message) {
  if (!condition) throw new Error(message)
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeName(name) {
  requireCondition(typeof name === 'string' && name.length <= 1024 && name
    && !/[\\:\0\r\n]/.test(name) && !path.posix.isAbsolute(name)
    && name.split('/').every((part) => part && part !== '.' && part !== '..'), 'Unsafe member path')
}

function within(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

function exists(file) {
  try { fs.lstatSync(file); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function allowed(name, type, requiredFiles) {
  return requiredFiles.includes(name) || TREES.some((root) => name === root || name.startsWith(`${root}/`))
    || type === 'directory' && [...requiredFiles, ...TREES].some((file) => file.startsWith(`${name}/`))
}

function readManifest(file, expectedSha256) {
  requireCondition(/^[a-f0-9]{64}$/.test(expectedSha256), 'Expected manifest SHA256 required')
  requireCondition(fs.lstatSync(file).isFile() && fs.statSync(file).size <= 32 * 1024 ** 2, 'Invalid manifest file')
  const raw = fs.readFileSync(file)
  requireCondition(sha256(raw) === expectedSha256, 'Input manifest SHA256 changed')
  const manifest = JSON.parse(raw)
  requireCondition(Object.keys(manifest).sort().join() === 'files,profile,schema,target'
    && manifest.schema === SCHEMA && manifest.profile === contract.profile, 'Unsupported runtime manifest/profile')
  requireCondition(manifest.target && Object.keys(manifest.target).sort().join() === 'arch,node,os'
    && manifest.target.node === '20.20.2'
    && (manifest.target.os === 'darwin' && manifest.target.arch === 'arm64'
      || manifest.target.os === 'win32' && manifest.target.arch === 'x64'),
    'Only Mac arm64 and Windows x64 Node20.20.2 byte profiles are supported')
  const windows = manifest.target.os === 'win32'
  const node = windows ? 'runtime/node.exe' : 'runtime/node'
  const requiredFiles = [...REQUIRED_FILES, node]
  requireCondition(Array.isArray(manifest.files) && manifest.files.length <= MAX_FILES, 'Invalid member count')
  const entries = new Map()
  let bytes = 0
  for (const row of manifest.files) {
    safeName(row.path)
    requireCondition(allowed(row.path, row.type, requiredFiles) && !entries.has(row.path), `Unexpected/duplicate member: ${row.path}`)
    requireCondition(!row.path.split('/').some((part) => part === '.env' || part.startsWith('.env.')),
      'Environment files are external installation inputs')
    const keys = Object.keys(row).sort().join()
    if (row.type === 'file') {
      requireCondition(keys === 'byte_size,mode,path,sha256,type' && /^[a-f0-9]{64}$/.test(row.sha256)
        && Number.isSafeInteger(row.byte_size) && row.byte_size >= 0 && row.byte_size <= 512 * 1024 ** 2
        && Number.isInteger(row.mode) && row.mode >= 0 && row.mode <= 0o777, 'Invalid file row')
      bytes += row.byte_size
    } else if (row.type === 'directory') {
      requireCondition(keys === 'path,type', 'Invalid directory row')
    } else {
      requireCondition(row.type === 'symlink' && keys === 'path,target,type' && typeof row.target === 'string'
        && row.target && !/[\\:\0\r\n]/.test(row.target) && !path.posix.isAbsolute(row.target), 'Invalid relative link')
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(row.path), row.target))
      safeName(target)
    }
    entries.set(row.path, row)
  }
  requireCondition(bytes <= MAX_BYTES, 'Runtime exceeds byte budget')
  for (const row of entries.values()) {
    for (let parent = path.posix.dirname(row.path); parent !== '.'; parent = path.posix.dirname(parent)) {
      requireCondition(entries.get(parent)?.type === 'directory', `Missing physical parent: ${parent}`)
    }
    if (row.type === 'symlink') {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(row.path), row.target))
      requireCondition(entries.has(target), `Link target absent from manifest: ${row.path}`)
    }
  }
  for (const name of requiredFiles) {
    requireCondition(entries.get(name)?.type === 'file' && entries.get(name).byte_size > 0, `Required runtime file missing: ${name}`)
  }
  for (const name of DEPENDENCY_ROOTS) requireCondition(entries.get(name)?.type === 'directory', `Dependency root missing: ${name}`)
  if (!windows) requireCondition(entries.get(node).mode & 0o111, 'Owned Node input must be executable')
  return { raw, manifest, entries, windows }
}

function checkMembers(root, entries, windows) {
  requireCondition(fs.lstatSync(root).isDirectory(), 'Runtime root must be a physical directory')
  for (const row of entries.values()) {
    if (row.type === 'directory') requireCondition(fs.lstatSync(path.join(root, row.path)).isDirectory(), `Directory changed: ${row.path}`)
  }
  for (const row of entries.values()) {
    const file = path.join(root, row.path)
    const stat = fs.lstatSync(file)
    if (row.type === 'directory') requireCondition(stat.isDirectory(), `Directory changed: ${row.path}`)
    else if (row.type === 'symlink') {
      const target = stat.isSymbolicLink() ? fs.readlinkSync(file) : null
      requireCondition(stat.isSymbolicLink() && (windows ? target.replaceAll('\\', '/') : target) === row.target,
        `Link changed: ${row.path}`)
      const resolved = fs.realpathSync(file)
      requireCondition(within(root, resolved) && entries.has(path.relative(root, resolved).split(path.sep).join('/')),
        `Link escapes frozen closure: ${row.path}`)
    } else {
      requireCondition(stat.isFile() && stat.size === row.byte_size && (stat.mode & 0o777) === row.mode
        && sha256(fs.readFileSync(file)) === row.sha256, `File bytes/mode changed: ${row.path}`)
    }
  }
}

function checkRuntime(root, entries) {
  const json = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))
  const resolveImport = (metadata, name) => {
    const resolved = createRequire(path.join(root, metadata)).resolve(name)
    requireCondition(within(root, resolved) && entries.has(path.relative(root, resolved).split(path.sep).join('/')),
      `Dependency escapes frozen closure: ${name}`)
  }
  // Plugin declarations also contain compile-time/bundled dependencies. The six
  // reviewed runtime imports below are checked separately; this is no import-graph proof.
  for (const metadata of ['package.json', 'packages/core-backend/package.json']) {
    for (const name of Object.keys(json(metadata).dependencies ?? {})) {
      // @types packages have no executable entry; preserve and resolve metadata.
      // The backend imports y-protocols/sync; that package has no bare export.
      const entry = name.startsWith('@types/') ? `${name}/package.json`
        : name === 'y-protocols' ? 'y-protocols/sync' : name
      resolveImport(metadata, entry)
    }
  }
  requireCondition(json('packages/core-backend/package.json').name === '@metasheet/core-backend', 'Wrong backend package')
  for (const [name, main] of Object.entries(contract.plugins)) {
    const metadata = `plugins/${name}/plugin.json`
    requireCondition(entries.get(metadata)?.type === 'file', `Plugin manifest missing: ${name}`)
    const plugin = json(metadata)
    requireCondition(plugin.name === name && plugin.main === main && /\.(c?js|mjs)$/.test(main), `Plugin entry/profile changed: ${name}`)
    requireCondition(entries.get(`plugins/${name}/${main}`)?.type === 'file', `Plugin entry missing: ${name}`)
  }
  for (const [plugin, dependency] of EXTRA_IMPORTS) {
    const importer = `plugins/${plugin}/node_modules/${dependency}`
    requireCondition(entries.get(importer)?.type === 'symlink', `Plugin importer link missing: ${importer}`)
    resolveImport(`plugins/${plugin}/plugin.json`, dependency)
  }
  requireCondition(entries.get('packages/core-backend/node_modules/@metasheet/mssql-readonly-utils')?.type === 'symlink',
    'Backend workspace importer link missing')
  requireCondition([...entries.keys()].some((name) => /^packages\/core-backend\/dist\/src\/db\/migrations\/[^/]+\.js$/.test(name)),
    'Compiled migration modules missing')
  for (const name of TOOL_FILES) {
    requireCondition(entries.get(name).sha256 === sha256(fs.readFileSync(path.join(HERE, path.basename(name)))),
      'Packaged verifier differs from the running verifier')
  }
}

export function verifyRuntime(root, manifestSha256) {
  root = path.resolve(root)
  requireCondition(fs.lstatSync(root).isDirectory(), 'Runtime root must be a physical directory')
  root = fs.realpathSync(root)
  const frozen = readManifest(path.join(root, MANIFEST), manifestSha256)
  checkMembers(root, frozen.entries, frozen.windows)
  const actual = []
  const walk = (directory) => {
    for (const child of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const name = directory ? `${directory}/${child.name}` : child.name
      if (name === MANIFEST) continue
      actual.push(name)
      if (child.isDirectory()) walk(name)
    }
  }
  walk('')
  requireCondition(actual.length === frozen.entries.size && actual.every((name) => frozen.entries.has(name)), 'Runtime namespace changed')
  checkRuntime(root, frozen.entries)
  return { profile: contract.profile, manifest_sha256: manifestSha256, members: actual.length,
    declared_target: frozen.manifest.target, verification_node: process.versions.node,
    input_manifest_bytes_and_links: 'verified', root_backend_declared_direct_dependencies: 'resolvable',
    type_dependencies: 'metadata_only', known_plugin_runtime_imports: 'resolvable',
    transitive_runtime_dependencies: 'not_verified', installed_runtime: 'not_verified', offline_runtime: 'not_verified',
    launch: { cwd: '.', entry: 'packages/core-backend/dist/src/index.js', plugins: Object.keys(contract.plugins) } }
}

export function buildRuntime({ input, output, manifest, manifestSha256 }) {
  input = path.resolve(input)
  requireCondition(fs.lstatSync(input).isDirectory(), 'Runtime input must be a physical directory')
  input = fs.realpathSync(input)
  output = path.join(fs.realpathSync(path.dirname(path.resolve(output))), path.basename(output))
  requireCondition(!exists(output) && !within(input, output) && !within(output, input), 'Destination exists or overlaps input')
  const frozen = readManifest(manifest, manifestSha256)
  checkMembers(input, frozen.entries, frozen.windows)
  checkRuntime(input, frozen.entries)
  const staging = fs.mkdtempSync(path.join(path.dirname(output), '.welding-ms-runtime-'))
  let reserved = false
  try {
    for (const row of [...frozen.entries.values()].sort((a, b) =>
      (frozen.windows ? Number(a.type === 'symlink') - Number(b.type === 'symlink') : 0)
      || a.path.split('/').length - b.path.split('/').length)) {
      const destination = path.join(staging, row.path)
      if (row.type === 'directory') fs.mkdirSync(destination)
      else if (row.type === 'symlink') {
        const type = frozen.windows ? (fs.statSync(path.join(input, row.path)).isDirectory() ? 'dir' : 'file') : undefined
        fs.symlinkSync(row.target, destination, type)
      }
      else {
        fs.copyFileSync(path.join(input, row.path), destination, fs.constants.COPYFILE_EXCL)
        fs.chmodSync(destination, row.mode)
      }
    }
    fs.writeFileSync(path.join(staging, MANIFEST), frozen.raw, { flag: 'wx' })
    const result = verifyRuntime(staging, manifestSha256)
    fs.mkdirSync(output)
    reserved = true
    for (const child of fs.readdirSync(staging)) fs.renameSync(path.join(staging, child), path.join(output, child))
    return result
  } catch (error) {
    if (reserved) fs.rmSync(output, { recursive: true })
    throw error
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { positionals, values } = parseArgs({ allowPositionals: true, options: {
      input: { type: 'string' }, output: { type: 'string' }, manifest: { type: 'string' },
      root: { type: 'string' }, 'manifest-sha256': { type: 'string' },
    } })
    requireCondition(positionals.length === 1 && ['build', 'verify'].includes(positionals[0]), 'Expected build or verify command')
    const result = positionals[0] === 'build'
      ? buildRuntime({ input: values.input, output: values.output, manifest: values.manifest, manifestSha256: values['manifest-sha256'] })
      : verifyRuntime(values.root, values['manifest-sha256'])
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(`Welding MS runtime refused: ${error.message}`)
    process.exitCode = 1
  }
}
