import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const native = vi.hoisted(() => ({ execFile: vi.fn(), statfs: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: native.execFile }))
vi.mock('node:fs/promises', () => ({ statfs: native.statfs }))

import { assertRecoveryLocalFilesystem } from '../../src/multitable/recovery-local-filesystem'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const root = '/synthetic/private archive'
const header = 'Filesystem    Type 512-blocks Used Available Capacity Mounted on'
const row = '/dev/synthetic apfs 200 100 100 50% /synthetic mount'
const output = `${header}\n${row}\n`
const refusal = 'RECOVERY_LOCAL_FILESYSTEM_REFUSED'
type Callback = (error: Error | null, stdout: string, stderr: string) => void

function result(stdout: string, stderr = '', error: Error | null = null) {
  native.execFile.mockImplementation((_binary: string, _args: string[], _options: unknown, callback: Callback) => callback(error, stdout, stderr))
}

beforeEach(() => {
  native.execFile.mockReset()
  native.statfs.mockReset()
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  result(output)
})
afterEach(() => { Object.defineProperty(process, 'platform', platform) })

describe('local filesystem identity admission', () => {
  test('Darwin requires the native APFS name using fixed bounded execution', async () => {
    await expect(assertRecoveryLocalFilesystem(root)).resolves.toBeUndefined()
    expect(native.execFile).toHaveBeenCalledTimes(1)
    expect(native.execFile).toHaveBeenCalledWith('/bin/df', ['-P', '-Y', '-T', 'apfs', root], {
      encoding: 'utf8', env: { LC_ALL: 'C' }, timeout: 2000, maxBuffer: 16_384,
    }, expect.any(Function))
    expect(native.statfs).not.toHaveBeenCalled()
  })

  test.each([
    output.slice(0, -1),
    `${header}\n/dev/synthetic apfs 200 100 100 50% /\n`,
    `${header}\n/dev/synthetic apfs 200 100 -1 100% /mount with spaces\n`,
  ])('accepts one explicit APFS row without equating a child root to its mountpoint: %s', async stdout => {
    result(stdout)
    await expect(assertRecoveryLocalFilesystem(root)).resolves.toBeUndefined()
  })

  test.each([
    ['', 'empty'],
    [header, 'header-only'],
    [`${header}\n${row.replace(' apfs ', ' hfs ')}\n`, 'other-local-type'],
    [`${header}\n${row.replace(' apfs ', ' smbfs ')}\n`, 'network-type'],
    [`${header}\n${row.replace(' apfs ', ' APFS ')}\n`, 'nonliteral-type'],
    [`${header}\n${row.replace(' apfs ', ' ')}\n`, 'missing-type'],
    [`${header.replace('Type ', '')}\n${row}\n`, 'missing-type-header'],
    [`${header}\n${row}\n${row}\n`, 'multiple-rows'],
    [`${output}\n`, 'extra-blank-row'],
    [`${header}\n${row.replace(' 200 ', ' unknown ')}\n`, 'malformed-data'],
    [`${output}\u0000`, 'nul'],
    [output.replace('mount', 'mount\r'), 'carriage-return'],
    [output.replace('mount', 'mount\u001b'), 'control'],
  ])('refuses closed-shape violation %s (%s)', async stdout => {
    result(stdout)
    await expect(assertRecoveryLocalFilesystem(root)).rejects.toThrow(refusal)
  })

  test('stderr refuses even a successful explicit APFS row without exposing its values', async () => {
    result(output, 'synthetic-private-path-and-provider-message')
    await expect(assertRecoveryLocalFilesystem(root)).rejects.toEqual(new Error(refusal))
  })

  test.each(['unsupported-option', 'timeout', 'max-buffer', 'missing-binary'])('execution failure %s has no cause or fallback', async reason => {
    result(output, '', new Error(`synthetic-private-${reason}`))
    await expect(assertRecoveryLocalFilesystem(root)).rejects.toEqual(new Error(refusal))
    expect(native.execFile).toHaveBeenCalledTimes(1)
    expect(native.statfs).not.toHaveBeenCalled()
  })

  test.each([0xef53, 0x58465342, 0x9123683e])('Linux preserves recognized type %i without spawning', async type => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    native.statfs.mockResolvedValue({ type })
    await expect(assertRecoveryLocalFilesystem(root)).resolves.toBeUndefined()
    expect(native.statfs).toHaveBeenCalledWith(root)
    expect(native.execFile).not.toHaveBeenCalled()
  })

  test.each([25, 26, 0x6969])('Linux still refuses unknown or network type %i', async type => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    native.statfs.mockResolvedValue({ type })
    await expect(assertRecoveryLocalFilesystem(root)).rejects.toEqual(new Error(refusal))
    expect(native.execFile).not.toHaveBeenCalled()
  })

  test('Linux lookup failure is values-free', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    native.statfs.mockRejectedValue(new Error('synthetic-private-filesystem-error'))
    await expect(assertRecoveryLocalFilesystem(root)).rejects.toEqual(new Error(refusal))
  })

  test('unsupported platforms refuse without either lookup', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    await expect(assertRecoveryLocalFilesystem(root)).rejects.toEqual(new Error(refusal))
    expect(native.execFile).not.toHaveBeenCalled()
    expect(native.statfs).not.toHaveBeenCalled()
  })
})
