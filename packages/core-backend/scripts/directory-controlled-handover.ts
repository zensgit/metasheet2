/** Privileged operator CLI. No provider HTTP calls and no implicit apply/finalize. */
import { readFile } from 'node:fs/promises'
import {
  applyDirectoryHandover,
  finishDirectoryHandover,
  previewDirectoryHandover,
} from '../src/directory/controlled-handover'

async function main() {
  const [action, inputFile] = process.argv.slice(2)
  if (
    !['preview', 'apply', 'rollback', 'finalize'].includes(action) ||
    !inputFile ||
    process.argv.length !== 4
  ) {
    throw new Error(
      'Usage: directory-controlled-handover.ts preview|apply|rollback|finalize INPUT.json',
    )
  }
  const input = JSON.parse(await readFile(inputFile, 'utf8'))
  if (!input || Array.isArray(input) || typeof input !== 'object')
    throw new Error('Expected an input object')
  const allowed =
    action === 'preview' || action === 'apply'
      ? [
          'sourceIntegrationId',
          'targetIntegrationId',
          'actorId',
          ...(action === 'apply' ? ['digest', 'confirm'] : []),
        ]
      : ['id', 'actorId', 'digest', 'confirm']
  if (
    Object.keys(input).some((k) => !allowed.includes(k)) ||
    allowed.some((k) => typeof input[k] !== 'string' || !input[k].trim())
  )
    throw new Error('Invalid or unexpected input fields')
  if (
    action !== 'preview' &&
    (input.confirm !== action || !/^[a-f0-9]{64}$/.test(input.digest))
  )
    throw new Error('Exact action confirmation and preview digest required')
  const pair = {
    sourceIntegrationId: input.sourceIntegrationId,
    targetIntegrationId: input.targetIntegrationId,
  }
  if (action === 'preview') return previewDirectoryHandover(pair, input.actorId)
  if (action === 'apply')
    return applyDirectoryHandover(pair, input.digest, input.actorId)
  return finishDirectoryHandover(
    input.id,
    input.digest,
    input.actorId,
    action as 'rollback' | 'finalize',
  )
}

main()
  .then((result) => {
    console.log(JSON.stringify(result))
    process.exit(0)
  })
  .catch(() => {
    // Do not echo SQL errors, input files, tenant identifiers, credentials or raw snapshots.
    console.error(
      'Directory handover refused; inspect scope, administrator and snapshot preconditions',
    )
    process.exit(1)
  })
