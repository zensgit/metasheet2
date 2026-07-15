/**
 * PLM-COLLAB Discussion read-auth line — sub-slice 6 (capstone dual-service E2E) harness.
 *
 * Boots a REAL temp Yuantus provider (uvicorn subprocess) against a shared temp sqlite file that a
 * standalone Python seed script has populated, and mints REAL Ed25519 embed tokens via the
 * production mint service. Everything here is local-only plumbing for the E2E test; the actual
 * dual-service assertions live in `plm-discussion-read-e2e.test.ts`.
 *
 * Local defaults are hard-coded but overridable by env (E2E_YUANTUS_WORKTREE / E2E_YUANTUS_PYTHON).
 * CI wiring is DEFERRED (build-then-HOLD) — the owner will wire ports/paths for CI once Actions is
 * restored.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const YUANTUS_WORKTREE = process.env.E2E_YUANTUS_WORKTREE || '/private/tmp/yuantus-readauth'
export const YUANTUS_PYTHON =
  process.env.E2E_YUANTUS_PYTHON || '/Users/chouhua/Downloads/Github/Yuantus/.venv-wp13/bin/python'
export const YUANTUS_SRC = path.join(YUANTUS_WORKTREE, 'src')

export const EMBED_ORIGIN = 'https://plm.example.com'
export const EMBED_KEY_ID = 'embed-1'
export const EMBED_AUDIENCE = 'metasheet2.embed'
export const EMBED_TTL_SECONDS = '600'
export const SERVED_TENANT = 'default'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const SEED_SCRIPT = path.join(HERE, 'seed_yuantus.py')
const MINT_SCRIPT = path.join(HERE, 'mint_embed_token.py')

/** A fresh Ed25519 keypair shared by the provider (signs+verifies) and the relay (verifies). */
export interface EmbedKeys {
  /** base64 of the raw 32-byte private seed — the provider's YUANTUS_EMBED_TOKEN_SIGNING_KEY. */
  privateSeedB64: string
  /** base64 of the raw 32-byte public key — the relay's YUANTUS_EMBED_PUBLIC_KEY. */
  publicB64: string
}

export function generateEmbedKeys(): EmbedKeys {
  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string }
  return {
    privateSeedB64: Buffer.from(jwk.d, 'base64url').toString('base64'),
    publicB64: Buffer.from(jwk.x, 'base64url').toString('base64'),
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const p = addr.port
        srv.close(() => resolve(p))
      } else {
        srv.close(() => reject(new Error('could not resolve a free port')))
      }
    })
  })
}

/** The env every Yuantus python process shares (mint helper, seed, uvicorn). */
function providerEnv(keys: EmbedKeys, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONPATH: YUANTUS_SRC,
    PYTHONUNBUFFERED: '1',
    YUANTUS_EMBED_TOKEN_SIGNING_KEY: keys.privateSeedB64,
    YUANTUS_EMBED_TOKEN_KEY_ID: EMBED_KEY_ID,
    YUANTUS_EMBED_TOKEN_AUDIENCE: EMBED_AUDIENCE,
    YUANTUS_EMBED_TOKEN_TTL_SECONDS: EMBED_TTL_SECONDS,
    YUANTUS_EMBED_ALLOWED_ORIGINS: EMBED_ORIGIN,
    EMBED_ORIGIN,
    ...extra,
  }
}

export interface MintSpec {
  name: string
  user_id: number
  tenant_id: string
  org_id: string | null
  part_id: string
}

/** Mint a batch of REAL embed tokens in a single python invocation. */
export function mintTokens(keys: EmbedKeys, specs: MintSpec[]): Record<string, string> {
  const res = spawnSync(YUANTUS_PYTHON, [MINT_SCRIPT], {
    cwd: YUANTUS_WORKTREE,
    env: providerEnv(keys),
    input: JSON.stringify(specs),
    encoding: 'utf8',
  })
  if (res.status !== 0) {
    throw new Error(`mint_embed_token.py failed (status ${res.status}): ${res.stderr}`)
  }
  return JSON.parse(res.stdout) as Record<string, string>
}

/** Seed the shared temp sqlite `dbPath` (must run BEFORE the uvicorn that serves it). */
export function seed(keys: EmbedKeys, dbPath: string): void {
  const res = spawnSync(YUANTUS_PYTHON, [SEED_SCRIPT], {
    cwd: YUANTUS_WORKTREE,
    env: providerEnv(keys, { YUANTUS_DATABASE_URL: `sqlite:///${dbPath}` }),
    encoding: 'utf8',
  })
  if (res.status !== 0) {
    throw new Error(`seed_yuantus.py failed (status ${res.status}): ${res.stdout}\n${res.stderr}`)
  }
}

export interface Provider {
  url: string
  port: number
  proc: ChildProcess
  dbPath: string
  logs: () => string
}

async function waitForHealth(url: string, proc: ChildProcess, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`uvicorn exited early (code ${proc.exitCode})`)
    }
    try {
      const res = await fetch(`${url}/api/v1/health`)
      if (res.status === 200) return
      lastErr = `health ${res.status}`
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`temp Yuantus never became healthy at ${url} (last: ${lastErr})`)
}

/**
 * Start a REAL uvicorn provider against `dbPath`. `readSessionEnabled` toggles the read dark flag
 * (a second provider with it OFF backs the dark-flag-401 case). AUTH_MODE stays at its `required`
 * default so the FULL production middleware chain (pre-auth exchange + read-cred admission on
 * exactly the 2 read paths) is exercised, not bypassed.
 */
export async function startProvider(
  keys: EmbedKeys,
  dbPath: string,
  opts: { readSessionEnabled: boolean },
): Promise<Provider> {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const env = providerEnv(keys, {
    YUANTUS_DATABASE_URL: `sqlite:///${dbPath}`,
    YUANTUS_TENANCY_MODE: 'single',
    YUANTUS_DISCUSSION_READ_SESSION_ENABLED: opts.readSessionEnabled ? '1' : '0',
  })
  const proc = spawn(
    YUANTUS_PYTHON,
    ['-m', 'uvicorn', 'yuantus.api.app:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'],
    { cwd: YUANTUS_WORKTREE, env },
  )
  const buf: string[] = []
  proc.stdout?.on('data', (d) => buf.push(d.toString()))
  proc.stderr?.on('data', (d) => buf.push(d.toString()))
  const logs = () => buf.join('')
  try {
    await waitForHealth(url, proc)
  } catch (e) {
    proc.kill('SIGKILL')
    throw new Error(`${e instanceof Error ? e.message : e}\n--- uvicorn output ---\n${logs()}`)
  }
  return { url, port, proc, dbPath, logs }
}

export function stopProvider(p: Provider | null): void {
  if (!p) return
  try {
    p.proc.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plm-read-e2e-'))
}

export function rmTempDir(dir: string | null): void {
  if (!dir) return
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}
