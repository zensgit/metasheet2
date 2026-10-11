import { request } from 'node:https'

export interface RecoveryResourceHttpsOptions {
  url: string
  token: string
  ca: Uint8Array
  timeoutMs: number
  maxRequestBytes?: number
  maxResponseBytes?: number
}

export function refuseRecoveryResourceIo(): never {
  throw new Error('RECOVERY_ARCHIVE_RESOURCE_IO_REFUSED')
}

export function decodeRecoveryResourceBase64(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maxBytes / 3) * 4) refuseRecoveryResourceIo()
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== value) refuseRecoveryResourceIo()
  return bytes
}

/** Fixed-origin TLS POST only. No redirects, proxy discovery, retries or values-bearing errors. */
export function createRecoveryResourceHttps(options: RecoveryResourceHttpsOptions, header: 'authorization' | 'x-vault-token') {
  let origin: string, token: string, ca: Buffer, timeoutMs: number, requestLimit: number, responseLimit: number
  try {
    const url = new URL(options.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') refuseRecoveryResourceIo()
    origin = url.origin
    token = options.token
    // OpenBao tokens are opaque (the native issuer currently returns 26 characters).
    if (typeof token !== 'string' || !/^[!-~]{1,1024}$/.test(token)
      || (header === 'authorization' && token.length < 32)) refuseRecoveryResourceIo()
    if (!(options.ca instanceof Uint8Array) || !options.ca.length || options.ca.length > 65536) refuseRecoveryResourceIo()
    ca = Buffer.from(options.ca)
    timeoutMs = options.timeoutMs
    requestLimit = options.maxRequestBytes ?? 65536
    responseLimit = options.maxResponseBytes ?? 65536
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || [requestLimit, responseLimit].some(n => !Number.isSafeInteger(n) || n < 1 || n > 384 * 1024 * 1024)) refuseRecoveryResourceIo()
  } catch { return refuseRecoveryResourceIo() }
  return async (path: string, input: unknown): Promise<unknown> => {
    let body: Buffer | undefined
    try {
      if (!/^\/v1\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(path)) refuseRecoveryResourceIo()
      body = Buffer.from(JSON.stringify(input))
      if (body.length > requestLimit) refuseRecoveryResourceIo()
      return await new Promise<unknown>((resolve, reject) => {
        let finished = false
        const chunks: Buffer[] = []; let length = 0
        const req = request(origin + path, { method: 'POST', ca, rejectUnauthorized: true, minVersion: 'TLSv1.2', agent: false,
          headers: { [header]: header === 'authorization' ? `Bearer ${token}` : token,
            'content-type': 'application/json', 'content-length': body!.length, 'accept': 'application/json' } }, res => {
          if (res.statusCode !== 200 || res.headers['content-encoding']
            || !/^application\/json(?:;|$)/i.test(String(res.headers['content-type']))) { fail(); return }
          res.on('data', (chunk: Buffer) => {
            length += chunk.length
            if (length > responseLimit) { fail(); return }
            chunks.push(Buffer.from(chunk))
          })
          res.on('error', fail)
          res.on('end', () => {
            if (finished) return
            const bytes = Buffer.concat(chunks)
            try {
              const result: unknown = JSON.parse(bytes.toString('utf8'))
              finished = true; clearTimeout(timer); resolve(result)
            } catch { fail() }
            finally { bytes.fill(0); for (const chunk of chunks) chunk.fill(0) }
          })
        })
        const fail = () => {
          if (finished) return
          finished = true; clearTimeout(timer); req.destroy()
          for (const chunk of chunks) chunk.fill(0)
          reject(new Error('RECOVERY_ARCHIVE_RESOURCE_IO_REFUSED'))
        }
        const timer = setTimeout(fail, timeoutMs)
        req.on('error', fail)
        req.end(body)
      })
    } catch { return refuseRecoveryResourceIo() }
    finally { body?.fill(0) }
  }
}
