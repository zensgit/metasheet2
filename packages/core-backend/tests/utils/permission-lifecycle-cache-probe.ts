import { createRequire } from 'node:module'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export interface PermissionCacheProbe {
  baseUrl: string
  stop: () => Promise<void>
}

interface ReadyMessage {
  cmd?: string
  port?: number
  error?: string
}

function redact(value: string): string {
  return value.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://redacted')
}

function resolveTsxCli(): string {
  const require = createRequire(import.meta.url)
  for (const specifier of ['tsx/dist/cli.mjs', 'tsx/cli']) {
    try {
      return require.resolve(specifier)
    } catch {
      // Try the next published entry.
    }
  }
  throw new Error('tsx cli is unavailable for the permission cache child')
}

const CACHE_CHILD_STOP_MS = 2000

function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function stdioClosed(child: ChildProcessWithoutNullStreams): boolean {
  return child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed
}

function stopPermissionCacheChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (childHasExited(child)) return Promise.resolve()
  if (typeof child.pid !== 'number') {
    if (stdioClosed(child)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('cache child had no process id and did not close'))
      }, CACHE_CHILD_STOP_MS)
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      clearTimeout(giveUpTimer)
      child.removeListener('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    const onExit = () => finish()
    child.once('exit', onExit)
    const killTimer = setTimeout(() => {
      if (!childHasExited(child)) child.kill()
    }, CACHE_CHILD_STOP_MS)
    const giveUpTimer = setTimeout(() => {
      if (childHasExited(child)) {
        finish()
        return
      }
      try {
        child.kill()
      } catch {
        // The pid can disappear between the check and the signal.
      }
      finish(new Error(`cache child pid ${child.pid} did not exit after stop`))
    }, CACHE_CHILD_STOP_MS * 2)
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.end()
    } else if (!childHasExited(child)) {
      child.kill()
    }
  })
}

export async function startPermissionCacheProbe(): Promise<PermissionCacheProbe> {
  const childScript = fileURLToPath(new URL('./permission-lifecycle-cache-child.ts', import.meta.url))
  const packageRoot = fileURLToPath(new URL('../..', import.meta.url))
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [resolveTsxCli(), childScript],
    {
      cwd: packageRoot,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  const lines: string[] = []
  let onLine: (() => void) | null = null
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    let newline = stdout.indexOf('\n')
    while (newline >= 0) {
      const line = stdout.slice(0, newline).replace(/\r$/, '')
      stdout = stdout.slice(newline + 1)
      if (line.startsWith('PLC ')) lines.push(line)
      newline = stdout.indexOf('\n')
    }
    if (onLine && lines.length > 0) onLine()
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  let ready: ReadyMessage
  try {
    ready = await new Promise<ReadyMessage>((resolve, reject) => {
      let settled = false
      const settle = (finish: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        finish()
      }
      const timer = setTimeout(() => {
        settle(() => reject(new Error(`cache child ready timed out: ${redact(stderr).slice(-500)}`)))
      }, 60000)
      const take = () => {
        while (lines.length > 0) {
          const line = lines.shift()
          if (!line) return
          let message: ReadyMessage
          try {
            message = JSON.parse(line.slice(4)) as ReadyMessage
          } catch {
            settle(() => reject(new Error('cache child sent a malformed ready line')))
            return
          }
          settle(() => resolve(message))
          return
        }
      }
      onLine = take
      child.on('error', (error: Error) => {
        settle(() => reject(new Error(`cache child failed to start: ${redact(error.message)}`)))
      })
      child.once('exit', (code) => {
        settle(() => reject(new Error(`cache child exited ${code ?? 'null'} before ready: ${redact(stderr).slice(-500)}`)))
      })
      take()
    })
  } catch (error) {
    await stopPermissionCacheChild(child)
    throw error
  }
  if (ready.error || !ready.port) {
    await stopPermissionCacheChild(child)
    throw new Error(`cache child failed to listen: ${ready.error ?? 'missing port'}`)
  }

  return {
    baseUrl: `http://127.0.0.1:${ready.port}`,
    stop: () => stopPermissionCacheChild(child),
  }
}
