/** Operator-only, private-file CLI; never emits passwords, provider identities or proof ciphertext. */
import { lstat, readFile, writeFile } from 'node:fs/promises'
import {
  verifyDingTalkRepair,
  previewDingTalkRepair,
  applyDingTalkRepair,
  rollbackDingTalkRepair,
} from '../src/auth/dingtalk-identity-repair'
async function main() {
  const [action, file, out, ...rest] = process.argv.slice(2)
  if (
    rest.length ||
    !file ||
    !['verify', 'preview', 'apply', 'rollback'].includes(action) ||
    (action === 'verify' ? !out : !!out)
  )
    throw Error('Invalid command')
  const stat = await lstat(file)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65536)
    throw Error('Private input required')
  const input = JSON.parse(await readFile(file, 'utf8'))
  const fields =
    action === 'verify'
      ? ['userId', 'password', 'code', 'actorId']
      : action === 'preview'
        ? ['proof']
        : action === 'apply'
          ? ['proof', 'digest', 'confirm']
          : ['id', 'actorId', 'digest', 'confirm']
  if (
    !input ||
    Array.isArray(input) ||
    Object.keys(input).length !== fields.length ||
    fields.some((k) => typeof input[k] !== 'string' || !input[k])
  )
    throw Error('Invalid fields')
  if (action === 'verify') {
    const proof = await verifyDingTalkRepair(
      input.userId,
      input.password,
      input.code,
      input.actorId,
    )
    await writeFile(out, JSON.stringify({ proof }), { mode: 0o600, flag: 'wx' })
    return {
      verified: true,
      expiresInSeconds: 300,
      localSessionIssued: false,
      businessRowsChanged: false,
    }
  }
  if (action === 'preview') return previewDingTalkRepair(input.proof)
  if (action === 'apply')
    return applyDingTalkRepair(input.proof, input.digest, input.confirm)
  return rollbackDingTalkRepair(
    input.id,
    input.actorId,
    input.digest,
    input.confirm,
  )
}
main()
  .then((r) => {
    console.log(JSON.stringify(r))
    process.exit(0)
  })
  .catch(() => {
    console.error('DINGTALK_LOGIN_REPAIR_REFUSED')
    process.exit(1)
  })
