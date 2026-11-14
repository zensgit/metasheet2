import { inspectUserPermissionGrants, listUserPermissions } from '../../src/rbac/service'

/**
 * One long-lived reader. The warm snapshot is printed before the parent
 * revokes. A later stdin line `reread` prints a second snapshot from new
 * queries. This process does not call invalidateUserPerms.
 *
 * The backend package compiles through tsx as CommonJS, which rejects
 * top-level await. The warm read, the stdin wait, and the reread stay in
 * this same process inside main.
 */
const userId = process.argv[2] || ''
if (!userId || process.env.RBAC_BYPASS !== 'false' || process.env.RBAC_TOKEN_TRUST !== 'false') {
  process.stderr.write('permission ux legacy reader refused\n')
  process.exit(2)
}

async function snapshot(): Promise<{
  listed: string[]
  legacy: string[]
  direct: string[]
  inherited: string[]
}> {
  const listed = await listUserPermissions(userId)
  const grants = await inspectUserPermissionGrants(userId)
  return {
    listed,
    legacy: grants.legacy,
    direct: grants.direct,
    inherited: grants.inherited,
  }
}

function writeSnapshot(phase: 'warm' | 'after', value: Awaited<ReturnType<typeof snapshot>>): void {
  process.stdout.write(`${JSON.stringify({ phase, ...value })}\n`)
}

function sanitizeReaderError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'permission ux legacy reader failed'
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://redacted')
}

async function main(): Promise<void> {
  const warm = await snapshot()
  writeSnapshot('warm', warm)

  const signal = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('reread signal timed out')), 30000)
    process.stdin.setEncoding('utf8')
    let buffered = ''
    const onData = (chunk: string) => {
      buffered += chunk
      const newline = buffered.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer)
      process.stdin.off('data', onData)
      resolve(buffered.slice(0, newline).trim())
    }
    process.stdin.on('data', onData)
  })

  if (signal !== 'reread') {
    process.stderr.write('permission ux legacy reader expected reread\n')
    process.exit(2)
  }

  writeSnapshot('after', await snapshot())
  process.exit(0)
}

main().catch((error: unknown) => {
  process.stderr.write(`permission ux legacy reader failed: ${sanitizeReaderError(error)}\n`)
  process.exit(1)
})
