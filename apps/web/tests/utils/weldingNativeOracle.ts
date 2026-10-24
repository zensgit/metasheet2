import { readFileSync, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MANIFEST_SHA256 = '24f7ee8ef88c56571b2403c2f96b66735f4de3e8ae9628082e1fd13f6c7fe2f9'
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

export function nativeOracleRoot(root = process.env.WELDING_CAD_TEST_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/welding-native-source')): string {
  const manifest = readFileSync(join(root, 'manifest.json'))
  if (sha(manifest) !== MANIFEST_SHA256) throw new Error('Native oracle manifest changed')
  const { files } = JSON.parse(manifest.toString('utf8')) as { files: Array<{ path: string; bytes: number; sha256: string }> }
  for (const file of files) {
    const path = join(root, file.path), stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Native oracle member is not a regular file')
    const bytes = readFileSync(path)
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw new Error('Native oracle member changed')
  }
  return root
}
