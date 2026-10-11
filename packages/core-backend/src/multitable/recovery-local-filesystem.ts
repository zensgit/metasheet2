import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'

function refuse(): never {
  throw new Error('RECOVERY_LOCAL_FILESYSTEM_REFUSED')
}

/** Darwin filesystem numbers are runtime registry IDs, not stable type identities. */
export async function assertRecoveryLocalFilesystem(realPath: string): Promise<void> {
  try {
    if (process.platform === 'linux') {
      if (![0xef53, 0x58465342, 0x9123683e].includes((await fs.statfs(realPath)).type)) refuse()
      return
    }
    if (process.platform !== 'darwin') refuse()
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      // Do not add -l: Apple's local/type selectors combine additively.
      execFile('/bin/df', ['-P', '-Y', '-T', 'apfs', realPath], {
        encoding: 'utf8', env: { LC_ALL: 'C' }, timeout: 2000, maxBuffer: 16_384,
      }, (error, stdout, stderr) => {
        if (error) reject(error)
        else resolve({ stdout, stderr })
      })
    })
    if (stderr !== '' || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(stdout)) refuse()
    const rows = stdout.endsWith('\n') ? stdout.slice(0, -1).split('\n') : stdout.split('\n')
    if (rows.length !== 2 || !/^Filesystem +Type +512-blocks +Used +Available +Capacity +Mounted on$/.test(rows[0])) refuse()
    // The mountpoint is a remainder: child roots and mountpoints with spaces are valid.
    if (!/^\S+ +apfs +\d+ +\d+ +-?\d+ +\d+% +\/[^\n]*$/.test(rows[1])) refuse()
  } catch {
    refuse()
  }
}
