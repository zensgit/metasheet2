/** Login repair CLI policy: client-timeout gate, fixed refusal codes, exit statuses. No database. */
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  REPAIR_CLI_QUERY_TIMEOUT_FLOOR_MS,
  REPAIR_CLI_QUERY_TIMEOUT_MAX_MS,
  classifyRepairFailure,
  guardRepairProcess,
  resolveRepairClientTimeout,
  runRepairCli,
  type RepairMain,
} from '../../src/auth/dingtalk-identity-repair-cli'
import {
  REPAIR_CLI_CODES,
  REPAIR_REFUSAL_CODES,
} from '../../src/auth/dingtalk-identity-repair-codes'

const backendRoot = fileURLToPath(new URL('../..', import.meta.url))
const source = (relative: string) => readFile(path.join(backendRoot, relative), 'utf8')
const entry = path.join(backendRoot, 'scripts/dingtalk-login-repair.ts')
const tsxLoader = createRequire(import.meta.url).resolve('tsx')

describe('resolveRepairClientTimeout', () => {
  it.each([
    [{}, { ok: true, value: 45000, floor: 45000, explicit: false }],
    [{ DB_QUERY_TIMEOUT: '' }, { ok: true, value: 45000, floor: 45000, explicit: false }],
    [{ DB_QUERY_TIMEOUT: '   ' }, { ok: true, value: 45000, floor: 45000, explicit: false }],
    [{ DB_QUERY_TIMEOUT: '60000' }, { ok: true, value: 60000, floor: 45000, explicit: true }],
    [{ DB_QUERY_TIMEOUT: '45000' }, { ok: true, value: 45000, floor: 45000, explicit: true }],
    [{ DB_STATEMENT_TIMEOUT: '40000' }, { ok: true, value: 55000, floor: 55000, explicit: false }],
    [{ DB_STATEMENT_TIMEOUT: '40000', DB_QUERY_TIMEOUT: '55000' }, { ok: true, value: 55000, floor: 55000, explicit: true }],
    [{ DB_STATEMENT_TIMEOUT: '40000', DB_QUERY_TIMEOUT: '54999' }, { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }],
    [{ DB_QUERY_TIMEOUT: '44999' }, { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }],
    [{ DB_QUERY_TIMEOUT: '30000' }, { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }],
    [{ DB_QUERY_TIMEOUT: 'abc' }, { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }],
    [{ DB_QUERY_TIMEOUT: '-1' }, { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }],
    [{ DB_QUERY_TIMEOUT: '0' }, { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }],
    // parseInt('1e9') is 1, exactly what the pool would hold.
    [{ DB_QUERY_TIMEOUT: '1e9' }, { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }],
    [{ DB_STATEMENT_TIMEOUT: 'x' }, { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }],
    [{ DB_STATEMENT_TIMEOUT: '-5' }, { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW' }],
    // Upper bound: Node arms a larger setTimeout delay as 1 ms, so pg's read timer would fire at once.
    [{ DB_QUERY_TIMEOUT: '2147483647' }, { ok: true, value: 2147483647, floor: 45000, explicit: true }],
    [{ DB_QUERY_TIMEOUT: '2147483648' }, { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_HIGH' }],
    [{ DB_QUERY_TIMEOUT: '9999999999' }, { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_HIGH' }],
    // PostgreSQL's own maximum statement_timeout: the floor (budget + 15 s) cannot be armed.
    [{ DB_STATEMENT_TIMEOUT: '2147483647' }, { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_HIGH' }],
    [{ DB_STATEMENT_TIMEOUT: '2147468648' }, { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_HIGH' }],
    [{ DB_STATEMENT_TIMEOUT: '2147468647' }, { ok: true, value: 2147483647, floor: 2147483647, explicit: false }],
    [
      { DB_STATEMENT_TIMEOUT: '2147483647', DB_QUERY_TIMEOUT: '2147483647' },
      { ok: false, code: 'REPAIR_CLIENT_TIMEOUT_TOO_HIGH' },
    ],
  ] as const)('%j', (env, expected) => {
    expect(resolveRepairClientTimeout({ ...env })).toEqual(expected)
  })

  it('the floor is never below 45 seconds, and no accepted value exceeds the largest delay Node can arm', () => {
    expect(REPAIR_CLI_QUERY_TIMEOUT_FLOOR_MS).toBe(45000)
    expect(REPAIR_CLI_QUERY_TIMEOUT_MAX_MS).toBe(2 ** 31 - 1)
    expect(resolveRepairClientTimeout({ DB_STATEMENT_TIMEOUT: '1000' })).toMatchObject({ floor: 45000 })
  })
})

describe('classifyRepairFailure', () => {
  const registered = [...REPAIR_REFUSAL_CODES, ...REPAIR_CLI_CODES].filter((c) => c !== 'REPAIR_LOCK_BUSY')
  it.each(registered)('%s prints itself with exit 1', (code) => {
    expect(classifyRepairFailure(new Error(code))).toEqual({ code, exit: 1 })
  })
  it('lock busy exits 75', () => {
    expect(classifyRepairFailure(new Error('REPAIR_LOCK_BUSY'))).toEqual({ code: 'REPAIR_LOCK_BUSY', exit: 75 })
  })
  it('a pg client read timeout exits 69', () => {
    expect(classifyRepairFailure(new Error('Query read timeout'))).toEqual({ code: 'REPAIR_CLIENT_TIMEOUT', exit: 69 })
  })
  it('a server statement cancel outside the lock phase is REPAIR_STATEMENT_TIMEOUT', () => {
    expect(classifyRepairFailure({ code: '57014' })).toEqual({ code: 'REPAIR_STATEMENT_TIMEOUT', exit: 1 })
    expect(
      classifyRepairFailure(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })),
    ).toEqual({ code: 'REPAIR_STATEMENT_TIMEOUT', exit: 1 })
  })
  it.each([
    new Error('REPAIR_LOCK_BUSY: pid 1'),
    new Error(' REPAIR_LOCK_BUSY'),
    new Error('canceling statement due to lock timeout'),
    Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
    Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    new Error('user 123 not found'),
    new Error('Query read timeout after 45000ms'),
    'REPAIR_LOCK_BUSY',
    null,
    undefined,
    42,
  ])('anything else is the generic code with exit 1: %s', (e) => {
    expect(classifyRepairFailure(e)).toEqual({ code: 'DINGTALK_LOGIN_REPAIR_REFUSED', exit: 1 })
  })
})

describe('runRepairCli', () => {
  const harness = (main: Partial<RepairMain> | Error, env: NodeJS.ProcessEnv = {}) => {
    const out: string[] = [],
      err: string[] = []
    const load = vi.fn(async () => {
      if (main instanceof Error) throw main
      return { effectiveClientQueryTimeoutMs: () => 45000, run: async () => ({ ok: true }), ...main } as RepairMain
    })
    return {
      env,
      out,
      err,
      load,
      go: (argv: string[] = ['preview', 'x']) =>
        runRepairCli(argv, env, { load, stdout: (s) => out.push(s), stderr: (s) => err.push(s) }),
    }
  }

  it('an explicit low value refuses before loading the module that constructs the pool', async () => {
    const h = harness({}, { DB_QUERY_TIMEOUT: '10000' })
    expect(await h.go()).toBe(1)
    expect(h.load).not.toHaveBeenCalled()
    expect(h.err).toEqual(['REPAIR_CLIENT_TIMEOUT_TOO_LOW'])
    expect(h.out).toEqual([])
    expect(h.env.DB_QUERY_TIMEOUT).toBe('10000')
  })

  it('presets the floor when unset, before loading, and never overrides an explicit value', async () => {
    let seen: string | undefined
    const h = harness({}, {})
    h.load.mockImplementationOnce(async () => {
      seen = h.env.DB_QUERY_TIMEOUT
      return { effectiveClientQueryTimeoutMs: () => 45000, run: async () => ({}) }
    })
    expect(await h.go()).toBe(0)
    expect(seen).toBe('45000')
    const explicit = harness({ effectiveClientQueryTimeoutMs: () => 90000 }, { DB_QUERY_TIMEOUT: '90000' })
    expect(await explicit.go()).toBe(0)
    expect(explicit.env.DB_QUERY_TIMEOUT).toBe('90000')
  })

  it('refuses when the pool does not actually hold the floor, before running anything', async () => {
    for (const effective of [30000, null, Number.NaN]) {
      const run = vi.fn(async () => ({}))
      const h = harness({ effectiveClientQueryTimeoutMs: () => effective, run })
      expect(await h.go()).toBe(1)
      expect(run).not.toHaveBeenCalled()
      expect(h.err).toEqual(['REPAIR_CLIENT_TIMEOUT_TOO_LOW'])
    }
  })

  it('refuses when the pool holds a value above the largest delay Node can arm, before running anything', async () => {
    for (const effective of [2147483648, 9999999999, Number.POSITIVE_INFINITY]) {
      const run = vi.fn(async () => ({}))
      const h = harness({ effectiveClientQueryTimeoutMs: () => effective, run })
      expect(await h.go()).toBe(1)
      expect(run).not.toHaveBeenCalled()
      expect(h.err).toEqual(['REPAIR_CLIENT_TIMEOUT_TOO_HIGH'])
    }
  })

  it('a load failure prints only the generic code', async () => {
    const h = harness(new Error('Cannot find module /secret/path'))
    expect(await h.go()).toBe(1)
    expect(h.err).toEqual(['DINGTALK_LOGIN_REPAIR_REFUSED'])
  })

  it('success prints the result with the effective client timeout', async () => {
    const h = harness({ effectiveClientQueryTimeoutMs: () => 45000, run: async () => ({ digest: 'd' }) })
    expect(await h.go()).toBe(0)
    expect(h.out.map((s) => JSON.parse(s))).toEqual([{ digest: 'd', clientQueryTimeoutMs: 45000 }])
    expect(h.err).toEqual([])
  })

  it.each([
    [new Error('REPAIR_LOCK_BUSY'), 'REPAIR_LOCK_BUSY', 75],
    [new Error('Query read timeout'), 'REPAIR_CLIENT_TIMEOUT', 69],
    [Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }), 'REPAIR_STATEMENT_TIMEOUT', 1],
    [new Error('REPAIR_SNAPSHOT_CHANGED'), 'REPAIR_SNAPSHOT_CHANGED', 1],
    [new Error('duplicate key value violates unique constraint "x" Key (id)=(abc)'), 'DINGTALK_LOGIN_REPAIR_REFUSED', 1],
  ] as const)('a run failure prints one fixed code: %s', async (e, code, exit) => {
    const h = harness({ run: async () => Promise.reject(e) })
    expect(await h.go()).toBe(exit)
    expect(h.err).toEqual([code])
    expect(h.out).toEqual([])
  })
})

describe('guardRepairProcess', () => {
  const fakeProcess = () => {
    const written: Array<[string, string]> = []
    const exits: number[] = []
    const listeners = new Map<string, (e: unknown) => void>()
    const stream = (name: string) => ({
      write: (chunk: unknown, ...rest: unknown[]) => {
        written.push([name, String(chunk)])
        const cb = rest.find((a) => typeof a === 'function') as (() => void) | undefined
        if (cb) queueMicrotask(cb)
        return true
      },
    })
    const proc = {
      stdout: stream('stdout'),
      stderr: stream('stderr'),
      on: (event: 'uncaughtException' | 'unhandledRejection', l: (e: unknown) => void) => listeners.set(event, l),
      exit: (code: number) => {
        exits.push(code)
      },
    }
    return { proc, written, exits, listeners }
  }
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it('discards every other writer and prints only the recorded line, then exits once', async () => {
    const f = fakeProcess()
    const io = guardRepairProcess(f.proc)
    const callback = vi.fn()
    expect(f.proc.stdout.write('warn: Slow query: 9ms - SELECT * FROM users WHERE id=$1\n', callback)).toBe(true)
    f.proc.stderr.write('Error: Connection terminated unexpectedly\n    at /abs/path/client.js:136:73\n')
    await settle()
    expect(callback).toHaveBeenCalledTimes(1)
    io.stdout('{"digest":"d"}')
    io.stdout('{"second":true}')
    io.exit(0)
    io.exit(1)
    await settle()
    expect(f.written).toEqual([['stdout', '{"digest":"d"}\n']])
    expect(f.exits).toEqual([0])
  })

  it('an uncaught exception or unhandled rejection prints one fixed code instead of the trace', async () => {
    for (const [event, e, code, status] of [
      ['uncaughtException', new Error('Connection terminated unexpectedly'), 'DINGTALK_LOGIN_REPAIR_REFUSED', 1],
      ['unhandledRejection', new Error('Query read timeout'), 'REPAIR_CLIENT_TIMEOUT', 69],
      ['uncaughtException', 'not an error', 'DINGTALK_LOGIN_REPAIR_REFUSED', 1],
    ] as const) {
      const f = fakeProcess()
      const io = guardRepairProcess(f.proc)
      f.listeners.get(event)!(e)
      // The awaited run fails afterwards with the same root cause: nothing more is printed.
      io.stderr('DINGTALK_LOGIN_REPAIR_REFUSED')
      io.exit(1)
      f.listeners.get(event)!(e)
      await settle()
      expect(f.written).toEqual([['stderr', code + '\n']])
      expect(f.exits).toEqual([status])
    }
  })

  it('a decision already recorded by the run is not replaced by a later crash', async () => {
    const f = fakeProcess()
    const io = guardRepairProcess(f.proc)
    io.stderr('REPAIR_LOCK_BUSY')
    f.listeners.get('uncaughtException')!(new Error('Connection terminated unexpectedly'))
    io.exit(75)
    await settle()
    expect(f.written).toEqual([['stderr', 'REPAIR_LOCK_BUSY\n']])
    expect(f.exits).toEqual([75])
  })

  it('exits without writing when nothing was recorded', async () => {
    const f = fakeProcess()
    guardRepairProcess(f.proc).exit(0)
    await settle()
    expect(f.written).toEqual([])
    expect(f.exits).toEqual([0])
  })

  it('the entry installs the guard before anything is loaded and routes every outcome through it', async () => {
    const text = await source('scripts/dingtalk-login-repair.ts')
    const guard = text.indexOf('guardRepairProcess(process)')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(text.indexOf('runRepairCli(process.argv'))
    expect(text).toMatch(/\.then\(io\.exit,\s*io\.crash\)/)
    expect(text).not.toMatch(/console\.|process\.exit\(|process\.(stdout|stderr)\.write/)
  })
})

describe('code lists and import boundaries', () => {
  const literals = (text: string) =>
    new Set([...text.matchAll(/'((?:DINGTALK_[A-Z_]+_REFUSED)|(?:REPAIR_[A-Z_]+))'/g)].map((m) => m[1]))
  const staticImports = (text: string) => [
    ...[...text.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]),
    ...[...text.matchAll(/^\s*import\s+'([^']+)'/gm)].map((m) => m[1]),
    ...[...text.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
  ]

  it('the two lists are disjoint and duplicate-free', () => {
    const all = [...REPAIR_REFUSAL_CODES, ...REPAIR_CLI_CODES]
    expect(new Set(all).size).toBe(all.length)
  })

  it('every refusal literal in the repair module is registered, and every registered module code is used there', async () => {
    const used = literals(await source('src/auth/dingtalk-identity-repair.ts'))
    expect([...used].filter((c) => !(REPAIR_REFUSAL_CODES as readonly string[]).includes(c))).toEqual([])
    expect(REPAIR_REFUSAL_CODES.filter((c) => !used.has(c))).toEqual([])
    expect(REPAIR_CLI_CODES.filter((c) => used.has(c))).toEqual([])
  })

  it('every code the CLI files name is printable, and every CLI code is produced by a CLI file', async () => {
    const texts = await Promise.all(
      ['src/auth/dingtalk-identity-repair-cli.ts', 'scripts/dingtalk-login-repair-main.ts', 'scripts/dingtalk-login-repair.ts'].map(source),
    )
    const used = new Set(texts.flatMap((t) => [...literals(t)]))
    const printable = new Set<string>([...REPAIR_REFUSAL_CODES, ...REPAIR_CLI_CODES])
    expect([...used].filter((c) => !printable.has(c))).toEqual([])
    expect(REPAIR_CLI_CODES.filter((c) => !used.has(c))).toEqual([])
  })

  it('the entry and the policy module cannot construct the pool before the timeout gate', async () => {
    const entryText = await source('scripts/dingtalk-login-repair.ts')
    expect(staticImports(entryText)).toEqual(['../src/auth/dingtalk-identity-repair-cli'])
    expect([...entryText.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])).toEqual(['./dingtalk-login-repair-main'])
    expect(entryText).not.toMatch(/\bawait\s+import\(/)
    expect(staticImports(await source('src/auth/dingtalk-identity-repair-cli.ts'))).toEqual(['./dingtalk-identity-repair-codes'])
    expect(staticImports(await source('src/auth/dingtalk-identity-repair-codes.ts'))).toEqual([])
    // The body module is where the pool is first evaluated.
    expect(staticImports(await source('scripts/dingtalk-login-repair-main.ts'))).toEqual(
      expect.arrayContaining(['../src/auth/dingtalk-identity-repair', '../src/integration/db/connection-pool']),
    )
  })
})

describe('entry process (child, no database)', () => {
  let dir = ''
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'login-repair-cli-'))
  })
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })
  /** Explicit env only: nothing from the test runner (e.g. DB_QUERY_TIMEOUT) leaks into the child. */
  /** An `undefined` in `extra` removes that variable from the child's environment. */
  const spawnEntry = (args: string[], extra: Record<string, string | undefined> = {}) =>
    new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve, reject) => {
      const started = Date.now()
      const env: Record<string, string | undefined> = {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'test',
        TSX_DISABLE_CACHE: '1',
        // Nothing listens here: any connection attempt would fail and print the generic code.
        DATABASE_URL: 'postgresql://synthetic@127.0.0.1:9/synthetic',
        ...extra,
      }
      for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
      const child = spawn(process.execPath, ['--import', tsxLoader, entry, ...args], {
        cwd: backendRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }))
    })
  const privateFile = async (name: string, body: string, mode = 0o600) => {
    const file = path.join(dir, name)
    await writeFile(file, body)
    // chmod after the write: the process umask cannot widen or narrow the intended mode.
    await chmod(file, mode)
    return file
  }

  it('an explicit DB_QUERY_TIMEOUT below the floor refuses without loading or connecting', async () => {
    const r = await spawnEntry(['preview', path.join(dir, 'nonexistent.json')], { DB_QUERY_TIMEOUT: '10000' })
    expect(r).toMatchObject({ code: 1, stdout: '', stderr: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW\n' })
    expect(r.ms).toBeLessThan(10000)
  }, 30000)

  it('an unparsable DB_STATEMENT_TIMEOUT refuses the same way', async () => {
    const r = await spawnEntry(['preview', path.join(dir, 'nonexistent.json')], { DB_STATEMENT_TIMEOUT: 'x' })
    expect(r).toMatchObject({ code: 1, stdout: '', stderr: 'REPAIR_CLIENT_TIMEOUT_TOO_LOW\n' })
  }, 30000)

  it.each([
    [{ DB_STATEMENT_TIMEOUT: '2147483647' }],
    [{ DB_QUERY_TIMEOUT: '2147483648' }],
    [{ DB_QUERY_TIMEOUT: '9999999999' }],
  ])('a client timeout above 2^31-1 ms (%j) refuses without loading or connecting', async (extra) => {
    const r = await spawnEntry(['preview', path.join(dir, 'nonexistent.json')], extra)
    expect(r).toMatchObject({ code: 1, stdout: '', stderr: 'REPAIR_CLIENT_TIMEOUT_TOO_HIGH\n' })
    expect(r.ms).toBeLessThan(10000)
  }, 30000)

  it('the largest client timeout Node can arm is accepted by the post-load assertion', async () => {
    const r = await spawnEntry(['nonsense'], { DB_QUERY_TIMEOUT: '2147483647' })
    expect(r).toMatchObject({ code: 1, stdout: '', stderr: 'REPAIR_INPUT_INVALID\n' })
  }, 30000)

  it('with DB_QUERY_TIMEOUT unset the dynamically loaded pool holds the preset (the assertion runs before argv validation)', async () => {
    const r = await spawnEntry(['nonsense'])
    expect(r).toMatchObject({ code: 1, stdout: '', stderr: 'REPAIR_INPUT_INVALID\n' })
  }, 30000)

  // The documented invocation itself is run through pnpm in the real-database CLI cases.
  it('every operator command in the doc runs through `pnpm --silent`, the flag before the script name', async () => {
    const doc = await readFile(path.join(backendRoot, '../../docs/development/dingtalk-login-identity-repair-20261102.md'), 'utf8')
    const blocks = [...doc.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((m) => m[1])
    const commands = blocks.flatMap((b) => b.split('\n')).filter((l) => l.includes('ops:dingtalk-login-repair'))
    expect(commands.length).toBeGreaterThanOrEqual(7)
    for (const line of commands) expect(line).toMatch(/^pnpm --silent ops:dingtalk-login-repair [a-z-]+ /)
    // The script exists only in this package: from the repository root pnpm exits 254 without running anything.
    for (const block of blocks.filter((b) => b.includes('ops:dingtalk-login-repair')))
      expect(block.split('\n')[0]).toBe('cd packages/core-backend')
  })

  it('the pool warning for an unset DATABASE_URL (non-production) does not reach stdout or stderr', async () => {
    const r = await spawnEntry(['nonsense'], { DATABASE_URL: undefined })
    expect(r).toMatchObject({ code: 1, stdout: '', stderr: 'REPAIR_INPUT_INVALID\n' })
  }, 30000)

  it('an explicit value at the floor is accepted by the same post-load assertion', async () => {
    const r = await spawnEntry(['nonsense'], { DB_QUERY_TIMEOUT: '45000' })
    expect(r).toMatchObject({ code: 1, stdout: '', stderr: 'REPAIR_INPUT_INVALID\n' })
  }, 30000)

  it('a module refusal code passes through unchanged (a proof that is not an encrypted envelope)', async () => {
    const file = await privateFile('plain-proof.json', JSON.stringify({ proof: 'synthetic-plain-proof' }))
    const r = await spawnEntry(['preview', file])
    expect(r).toMatchObject({ code: 1, stdout: '', stderr: 'DINGTALK_IDENTITY_REPAIR_REFUSED\n' })
  }, 30000)

  it('private-file, JSON and field validation print only REPAIR_INPUT_INVALID', async () => {
    const valid = JSON.stringify({ proof: 'synthetic-proof' })
    const target = await privateFile('ok.json', valid)
    const cases: string[][] = [
      ['preview', await privateFile('world-readable.json', valid, 0o644)],
      ['preview', await privateFile('group-readable.json', valid, 0o640)],
      ['preview', await privateFile('wrong-fields.json', JSON.stringify({ proof: 'p', extra: 'x' }))],
      ['preview', await privateFile('empty-field.json', JSON.stringify({ proof: '' }))],
      ['preview', await privateFile('array.json', JSON.stringify(['synthetic-proof']))],
      ['preview', await privateFile('not-json.json', '{proof:')],
      ['apply', await privateFile('apply-missing.json', valid)],
      ['preview', path.join(dir, 'missing.json')],
      ['preview', dir],
      ['preview', target, 'unexpected-output'],
      ['verify', target],
    ]
    const link = path.join(dir, 'link.json')
    await symlink(target, link)
    cases.push(['preview', link])
    for (const args of cases) {
      const r = await spawnEntry(args)
      expect({ args: args.map((a) => path.basename(a)), ...r, ms: 0 }).toEqual({
        args: args.map((a) => path.basename(a)),
        code: 1,
        stdout: '',
        stderr: 'REPAIR_INPUT_INVALID\n',
        ms: 0,
      })
    }
  }, 120000)
})
