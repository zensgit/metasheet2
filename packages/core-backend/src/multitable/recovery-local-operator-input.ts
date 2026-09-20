import { closeSync, fstatSync } from 'node:fs'
import { Socket } from 'node:net'

const RECOVERY_SECRET_BYTES = 32
const DEFAULT_TIMEOUT_MS = 60_000
const REFUSED = 'RECOVERY_LOCAL_OPERATOR_INPUT_REFUSED'

type AbortSignalLike = Pick<AbortSignal, 'aborted' | 'addEventListener' | 'removeEventListener'>

export function readLocalRecoverySecret(
  fd: number,
  signal: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Buffer> {
  if (!isOwnedDescriptor(fd) || !isBoundedTimeout(timeoutMs) || !isAbortSignal(signal)) {
    return Promise.reject(refused())
  }

  try {
    const stat = fstatSync(fd)
    if (!stat.isFIFO() && !stat.isSocket()) {
      // No admitted pipe means no ownership. An absent inherited FD may be reused by libuv.
      return Promise.reject(refused())
    }
  } catch {
    return Promise.reject(refused())
  }

  let source: Socket
  try {
    source = new Socket({ fd, readable: true, writable: false })
    // TCP descriptors report a port; anonymous pipes and Unix-domain sockets do not.
    const address = source.address()
    if (typeof address === 'object' && address !== null && 'port' in address) {
      source.destroy()
      return Promise.reject(refused())
    }
  } catch {
    closeOwnedDescriptor(fd)
    return Promise.reject(refused())
  }

  return new Promise<Buffer>((resolve, reject) => {
    const secret = Buffer.alloc(RECOVERY_SECRET_BYTES)
    let received = 0
    let settled = false
    const timeout = setTimeout(() => finish(), timeoutMs)

    const onAbort = () => finish()
    const onData = (chunk: Buffer) => {
      if (settled) {
        chunk.fill(0)
        return
      }
      const remaining = RECOVERY_SECRET_BYTES - received
      if (chunk.length > remaining) {
        chunk.fill(0)
        finish()
        return
      }
      chunk.copy(secret, received)
      received += chunk.length
      chunk.fill(0)
    }
    const onEnd = () => {
      if (received === RECOVERY_SECRET_BYTES) finish(secret)
      else finish()
    }
    const onError = () => finish()
    const onClose = () => finish()

    function finish(value?: Buffer): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      source.off('data', onData)
      source.off('end', onEnd)
      source.off('error', onError)
      source.off('close', onClose)
      source.destroy()

      if (value) resolve(value)
      else {
        secret.fill(0)
        reject(refused())
      }
    }

    source.on('data', onData)
    source.once('end', onEnd)
    source.once('error', onError)
    source.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) finish()
    else source.resume()
  })
}

function isOwnedDescriptor(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 3
}

function isBoundedTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= DEFAULT_TIMEOUT_MS
}

function isAbortSignal(value: unknown): value is AbortSignalLike {
  return typeof value === 'object' && value !== null
    && 'aborted' in value
    && typeof (value as AbortSignalLike).addEventListener === 'function'
    && typeof (value as AbortSignalLike).removeEventListener === 'function'
}

function closeOwnedDescriptor(fd: number): void {
  if (!isOwnedDescriptor(fd)) return
  try {
    closeSync(fd)
  } catch {
    // The descriptor may already be closed or the socket wrapper may own it.
  }
}

function refused(): Error {
  return new Error(REFUSED)
}
