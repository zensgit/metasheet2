import { spawn } from 'node:child_process'
import { closeSync, fstatSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createConnection, createServer, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { Duplex } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { readLocalRecoverySecret } from '../../src/multitable/recovery-local-operator-input'

const REFUSED = 'RECOVERY_LOCAL_OPERATOR_INPUT_REFUSED'
const require = createRequire(import.meta.url)
const helperPath = fileURLToPath(new URL('../../src/multitable/recovery-local-operator-input.ts', import.meta.url))

async function childRead(payload: Buffer, end: boolean, abort = false, inherited: number | 'pipe' = 'pipe'): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, ['--require', require.resolve('tsx/cjs'), '--eval', `
    const { readLocalRecoverySecret } = require(${JSON.stringify(helperPath)});
    const { fstatSync } = require('node:fs');
    const controller = new AbortController();
    ${abort ? 'setTimeout(() => controller.abort(), 30);' : ''}
    (async () => {
      try {
        const secret = await readLocalRecoverySecret(3, controller.signal, 200);
        const valid = secret.equals(Buffer.alloc(32, 23));
        secret.fill(0);
        if (!valid) process.exitCode = 2;
        process.stdout.write(valid ? 'ok' : 'invalid');
      } catch (error) {
        process.stdout.write(error.message === '${REFUSED}' ? 'refused' : 'leaked-error');
      }
      await new Promise(resolve => setImmediate(resolve));
      try { fstatSync(3); process.stdout.write(':open'); } catch { process.stdout.write(':closed'); }
    })();
  `], { stdio: ['ignore', 'pipe', 'pipe', inherited] })
  const pipe = child.stdio[3] as Duplex | null
  pipe?.on('error', () => undefined)
  let output = ''
  let errors = ''
  child.stdout!.on('data', chunk => { output += String(chunk) })
  child.stderr!.on('data', chunk => { errors += String(chunk) })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
  try {
    pipe?.write(payload)
    if (end) pipe?.end()
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    expect(errors).toBe('')
    return { code, output }
  } finally {
    clearTimeout(timeout)
    pipe?.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

describe('local recovery operator input', () => {
  test('consumes a real inherited pipe once, exactly 32 bytes and EOF, and closes FD', async () => {
    expect(await childRead(Buffer.alloc(32, 23), true)).toEqual({ code: 0, output: 'ok:closed' })
  })
  test.each([0, 31, 33, 4096])('rejects %d-byte payload without exposing bytes', async size => {
    expect(await childRead(Buffer.alloc(size, 23), true)).toEqual({ code: 0, output: 'refused:closed' })
  })
  test('requires EOF even after exactly 32 bytes; bounded timeout closes pipe', async () => {
    expect(await childRead(Buffer.alloc(32, 23), false)).toEqual({ code: 0, output: 'refused:closed' })
  })
  test('aborts a partial secret, closes pipe and exits without hanging', async () => {
    expect(await childRead(Buffer.alloc(16, 23), false, true)).toEqual({ code: 0, output: 'refused:closed' })
  })
  test('rejects an inherited TCP socket even on synthetic loopback', async () => {
    let peer: Socket | undefined
    const server = createServer(socket => { peer = socket })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test listener unavailable')
    const socket = createConnection({ host: '127.0.0.1', port: address.port })
    try {
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
      const fd = (socket as unknown as { _handle: { fd: number } })._handle.fd
      expect(await childRead(Buffer.alloc(0), false, false, fd)).toEqual({ code: 0, output: 'refused:closed' })
    } finally {
      socket.destroy()
      peer?.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  test('refuses standard, regular-file and directory descriptors', async () => {
    await expect(readLocalRecoverySecret(2, new AbortController().signal)).rejects.toThrow(REFUSED)
    for (const filename of [process.execPath, process.cwd()]) {
      const fd = openSync(filename, 'r')
      try {
        await expect(readLocalRecoverySecret(fd, new AbortController().signal)).rejects.toThrow(REFUSED)
        expect(() => fstatSync(fd)).not.toThrow()
      } finally { closeSync(fd) }
    }
  })
})
