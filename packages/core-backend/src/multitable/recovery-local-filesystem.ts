import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/** Admission only: network/unknown filesystems need their own durability contract. */
export async function isRecoveryLocalFilesystem(root: {
  configuredPath: string
  realPath: string
  dev: bigint
  ino: bigint
}): Promise<boolean> {
  try {
    if (process.platform === 'linux') {
      return [0xef53, 0x58465342, 0x9123683e].includes((await fs.statfs(root.realPath)).type)
    }
    if (process.platform !== 'darwin' || !path.isAbsolute(root.realPath)) return false
    const unchanged = async () => {
      const stat = await fs.lstat(root.configuredPath, { bigint: true })
      return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === root.dev && stat.ino === root.ino
        && await fs.realpath(root.configuredPath) === root.realPath
    }
    if (!await unchanged()) return false
    const output = await new Promise<string>((resolve, reject) => {
      execFile('/bin/df', ['--libxo', 'json', '-l', '-T', 'apfs', '-P', '-Y', root.realPath], {
        env: { LC_ALL: 'C', LANG: 'C' }, encoding: 'utf8', timeout: 1000, maxBuffer: 16_384, killSignal: 'SIGKILL',
      }, (error, stdout, stderr) => {
        if (error || stderr !== '') reject(new Error('RECOVERY_LOCAL_FILESYSTEM_REFUSED'))
        else resolve(stdout)
      })
    })
    const value = JSON.parse(output)
    if (!value || Object.keys(value).join(',') !== 'storage-system-information') return false
    const information = value['storage-system-information']
    if (!information || Object.keys(information).join(',') !== 'filesystem') return false
    const records = information.filesystem
    if (!Array.isArray(records) || records.length !== 1) return false
    const record = records[0]
    if (!record || Object.keys(record).sort().join(',') !== 'available-blocks,mounted-on,name,total-blocks,type,used-blocks,used-percent') return false
    if (record.type !== 'apfs' || typeof record.name !== 'string' || record.name.length === 0
      || typeof record['mounted-on'] !== 'string' || !path.isAbsolute(record['mounted-on'])) return false
    for (const field of ['total-blocks', 'used-blocks', 'available-blocks', 'used-percent']) {
      if (typeof record[field] !== 'number' || !Number.isFinite(record[field])) return false
    }
    // Data firmlinks need device identity, not a textual root/mount path-prefix test.
    const mount = await fs.realpath(record['mounted-on'])
    const stat = await fs.stat(mount, { bigint: true })
    if (!path.isAbsolute(mount) || !stat.isDirectory() || stat.dev !== root.dev) return false
    return await unchanged()
  } catch {
    return false
  }
}
