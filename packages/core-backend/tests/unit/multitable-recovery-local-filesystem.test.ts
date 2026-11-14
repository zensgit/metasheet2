import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { isRecoveryLocalFilesystem } from '../../src/multitable/recovery-local-filesystem'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
vi.mock('node:fs/promises', () => ({ lstat: vi.fn(), stat: vi.fn(), realpath: vi.fn(), statfs: vi.fn() }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const root = { configuredPath: '/synthetic/root', realPath: '/synthetic/root', dev: 7n, ino: 8n }
const directory = { dev: 7n, ino: 8n, isDirectory: () => true, isSymbolicLink: () => false }
const record = { name: '/dev/synthetic', type: 'apfs', 'total-blocks': 1, 'used-blocks': 0, 'available-blocks': 1, 'used-percent': 0, 'mounted-on': '/different/firmlink-mount' }
let output: string
let error: Error | null
let stderr: string
function rows(records: unknown[]) { return JSON.stringify({ 'storage-system-information': { filesystem: records } }) }
function onPlatform(value: string) { Object.defineProperty(process, 'platform', { value, configurable: true }) }

beforeEach(() => {
  vi.resetAllMocks()
  onPlatform('darwin')
  output = rows([record]); error = null; stderr = ''
  vi.mocked(fs.lstat).mockResolvedValue(directory as never)
  vi.mocked(fs.stat).mockResolvedValue(directory as never)
  vi.mocked(fs.realpath).mockImplementation(async target => String(target))
  vi.mocked(fs.statfs).mockResolvedValue({ type: 25 } as never)
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void
    callback(error, output, stderr)
    return {} as ReturnType<typeof execFile>
  })
})
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks() })

describe('LOCAL filesystem name admission', () => {
  test.each([25, 26])('admits named APFS independently of numeric type %i and firmlink prefix', async type => {
    vi.mocked(fs.statfs).mockResolvedValue({ type } as never)
    expect(await isRecoveryLocalFilesystem(root)).toBe(true)
    expect(fs.statfs).not.toHaveBeenCalled()
  })
  test('uses bounded absolute native argv, local filter and clean environment for a hostile path', async () => {
    const hostile = '/synthetic/space \' " $(touch nope)\nroot'
    expect(await isRecoveryLocalFilesystem({ ...root, configuredPath: hostile, realPath: hostile })).toBe(true)
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(execFile).toHaveBeenCalledWith('/bin/df', ['--libxo', 'json', '-l', '-T', 'apfs', '-P', '-Y', hostile], {
      env: { LC_ALL: 'C', LANG: 'C' }, encoding: 'utf8', timeout: 1000, maxBuffer: 16_384, killSignal: 'SIGKILL',
    }, expect.any(Function))
  })
  test.each(['nfs', 'smbfs', 'webdav', 'hfs', 'unknown'])('rejects successful command with type %s even numeric 25', async type => {
    output = rows([{ ...record, type }])
    expect(await isRecoveryLocalFilesystem(root)).toBe(false)
  })
  test.each([
    '', '{}', 'null', '[]', 'not-json', rows([]), rows([record, record]), rows([null]), rows([1]),
    rows([{ ...record, type: undefined }]), rows([{ ...record, 'mounted-on': undefined }]),
    rows([{ ...record, 'mounted-on': 'relative' }]), rows([{ ...record, 'used-blocks': '0' }]),
    rows([{ ...record, warning: 'ambiguous' }]),
    JSON.stringify({ 'storage-system-information': { filesystem: [record], error: 'ambiguous' } }),
  ])('rejects malformed or ambiguous JSON %#', async value => {
    output = value
    expect(await isRecoveryLocalFilesystem(root)).toBe(false)
  })
  test.each(['exit', 'timeout', 'maxBuffer'])('rejects %s failure despite valid output', async code => {
    error = Object.assign(new Error('private diagnostic'), { code })
    expect(await isRecoveryLocalFilesystem(root)).toBe(false)
  })
  test('rejects stderr with otherwise valid success', async () => {
    stderr = 'private diagnostic'
    expect(await isRecoveryLocalFilesystem(root)).toBe(false)
  })
  test('rejects mount device mismatch', async () => {
    vi.mocked(fs.stat).mockResolvedValue({ ...directory, dev: 9n } as never)
    expect(await isRecoveryLocalFilesystem(root)).toBe(false)
  })
  test('rejects unresolved mount or mount IO failure', async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error('private mount'))
    expect(await isRecoveryLocalFilesystem(root)).toBe(false)
  })
  test.each(['dev', 'ino', 'realpath', 'symlink'])('rejects root %s drift after native probe', async field => {
    if (field === 'realpath') {
      vi.mocked(fs.realpath).mockResolvedValueOnce(root.realPath).mockResolvedValueOnce('/different/mount').mockResolvedValueOnce('/changed/root')
    } else {
      vi.mocked(fs.lstat).mockResolvedValueOnce(directory as never).mockResolvedValueOnce({ ...directory,
        ...(field === 'symlink' ? { isSymbolicLink: () => true } : { [field]: 99n }),
      } as never)
    }
    expect(await isRecoveryLocalFilesystem(root)).toBe(false)
  })
  test('rejects initial root drift before launching command', async () => {
    vi.mocked(fs.lstat).mockResolvedValue({ ...directory, ino: 9n } as never)
    expect(await isRecoveryLocalFilesystem(root)).toBe(false)
    expect(execFile).not.toHaveBeenCalled()
  })
  test('does not reuse admission for a second root', async () => {
    expect(await isRecoveryLocalFilesystem(root)).toBe(true)
    output = rows([{ ...record, type: 'nfs' }])
    expect(await isRecoveryLocalFilesystem({ ...root, configuredPath: '/second', realPath: '/second' })).toBe(false)
    expect(execFile).toHaveBeenCalledTimes(2)
  })
  test.each([0xef53, 0x58465342, 0x9123683e, 0x6969, 25, 26])('preserves Linux type %i without native child', async type => {
    onPlatform('linux')
    vi.mocked(fs.statfs).mockResolvedValue({ type } as never)
    expect(await isRecoveryLocalFilesystem(root)).toBe([0xef53, 0x58465342, 0x9123683e].includes(type))
    expect(execFile).not.toHaveBeenCalled()
  })
  test('refuses unknown platforms', async () => {
    onPlatform('freebsd')
    expect(await isRecoveryLocalFilesystem(root)).toBe(false)
    expect(execFile).not.toHaveBeenCalled()
  })
})
