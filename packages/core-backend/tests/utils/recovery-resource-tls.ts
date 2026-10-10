import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Disposable, publicly reproducible test certificate; never used by a resource packet. */
export async function recoveryResourceTestTls() {
  const root = await mkdtemp(join(tmpdir(), 'tm-resource-tls-'))
  try {
    await writeFile(join(root, 'openssl.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n', { mode: 0o600 })
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-config', join(root, 'openssl.cnf'), '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem')], { stdio: 'ignore' })
    return { key: await readFile(join(root, 'key.pem')), cert: await readFile(join(root, 'cert.pem')) }
  } finally { await rm(root, { recursive: true, force: true }) }
}
