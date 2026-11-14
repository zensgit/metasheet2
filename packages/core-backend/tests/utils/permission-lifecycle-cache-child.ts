import express from 'express'
import { mountPermissionLifecyclePreflight } from './permission-lifecycle-preflight'

if (process.env.RBAC_BYPASS !== 'false' || process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('permission cache child requires RBAC_BYPASS=false and RBAC_TOKEN_TRUST=false')
}
if (!process.env.DATABASE_URL) {
  throw new Error('permission cache child requires DATABASE_URL')
}

function redact(value: string): string {
  return value.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://redacted')
}

const app = express()
app.use(express.json())
mountPermissionLifecyclePreflight(app)

const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  process.stdout.write(`PLC ${JSON.stringify({ cmd: 'ready', port })}\n`)
})

server.on('error', (error) => {
  process.stdout.write(`PLC ${JSON.stringify({ cmd: 'ready', error: redact(error.message) })}\n`)
  process.exit(1)
})

process.stdin.resume()
process.stdin.on('end', () => {
  server.close(() => process.exit(0))
})
