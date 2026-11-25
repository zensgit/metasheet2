/**
 * Starts the whole server in a child process for the C2 cases of the stop of client connections
 * (design lock STOP-BARRIER-OPEN-CONNECTIONS §5.3), shaped like the process harness of the realtime
 * documents line: forked with the TypeScript loader of the repository, a port the system picks on
 * the loopback interface, ended through its own handle only (a stop signal, as a deployment sends
 * it, or a kill), never outliving the test.
 *
 * What the child prints is thrown away (it could carry settings). What it says over the channel:
 *   ready {port}                    once it listens;
 *   failed {reason}                 when it could not start, one short line;
 *   stop-outcome {outcome, reason}  observed on the latched stop of the server, before it exits;
 *   pool-ended                      once the database pool has been closed.
 */
import { fork, type ChildProcess } from 'node:child_process'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const CHILD = path.join(__dirname, 'server-process-child.ts')

export interface ProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface ServerProcess {
  readonly port: number
  readonly url: string
  readonly exited: Promise<ProcessExit>
  /** A stop signal; resolves when the process has exited. */
  stop(): Promise<ProcessExit>
  /** How the stop of the server settled, as the process said before it exited; null when it said nothing. */
  stopOutcome(): { outcome: 'ok' | 'failed'; reason: string | null } | null
  /** Whether the process said the database pool was closed. */
  poolEnded(): boolean
  kill(): Promise<ProcessExit>
}

const started: ChildProcess[] = []

export async function startServerProcess(options: { env?: Record<string, string>; readyTimeoutMs?: number; lifetimeMs?: number } = {}): Promise<ServerProcess> {
  const child = fork(CHILD, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...(options.env ?? {}),
      NODE_ENV: 'test',
      STOP_BARRIER_PROCESS_LIFETIME_MS: String(options.lifetimeMs ?? 120_000),
    },
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  started.push(child)
  let exit: ProcessExit | null = null
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('exit', (code, signal) => {
      exit = { code, signal }
      resolve(exit)
    })
  })
  let outcome: { outcome: 'ok' | 'failed'; reason: string | null } | null = null
  let poolEnded = false
  child.on('message', (message: { type?: string; outcome?: 'ok' | 'failed'; reason?: string }) => {
    if (message.type === 'stop-outcome' && (message.outcome === 'ok' || message.outcome === 'failed')) {
      outcome = { outcome: message.outcome, reason: message.reason ?? null }
    }
    if (message.type === 'pool-ended') poolEnded = true
  })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the server process to listen')), options.readyTimeoutMs ?? 120_000)
    const onMessage = (message: { type?: string; port?: number; reason?: string }): void => {
      if (message.type === 'ready' && typeof message.port === 'number') {
        clearTimeout(timer)
        resolve(message.port)
      } else if (message.type === 'failed') {
        clearTimeout(timer)
        reject(new Error(`the server process did not start: ${message.reason ?? 'no reason given'}`))
      }
    }
    child.on('message', onMessage)
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error('the server process ended before it listened'))
    })
  }).catch(async (error) => {
    if (!exit) child.kill('SIGKILL')
    await exited
    throw error
  })
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    exited,
    stop: () => {
      if (!exit) child.kill('SIGTERM')
      return exited
    },
    stopOutcome: () => outcome,
    poolEnded: () => poolEnded,
    kill: () => {
      if (!exit) child.kill('SIGKILL')
      return exited
    },
  }
}

/** For the end of every case: a process still running is killed; the number of those is returned. */
export async function endServerProcesses(): Promise<{ leftRunning: number }> {
  let leftRunning = 0
  for (const child of started.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    leftRunning += 1
    const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGKILL')
    await gone
  }
  return { leftRunning }
}
