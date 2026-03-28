import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.cwd(), '..')
const dist = path.resolve(root, 'dist')
const outDir = path.resolve(process.cwd(), '.')

const openapiSrc = path.join(dist, 'openapi.yaml')
if (!fs.existsSync(openapiSrc)) {
  console.error('openapi.yaml not found, run openapi build first')
  process.exit(1)
}
const jsOut = path.join(outDir, 'index.js')
const dtsOut = path.join(outDir, 'index.d.ts')
fs.writeFileSync(jsOut, `// ESM stub exports types only\nexport {};\n`)

execFileSync(
  'pnpm',
  [
    'exec',
    'openapi-typescript',
    openapiSrc,
    '--output',
    dtsOut,
  ],
  {
    cwd: process.cwd(),
    stdio: 'inherit',
  },
)

execFileSync(
  'pnpm',
  [
    'exec',
    'tsc',
    'client.ts',
    '--declaration',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2020',
    '--skipLibCheck',
  ],
  {
    cwd: process.cwd(),
    stdio: 'inherit',
  },
)

console.log('SDK packaged to dist-sdk')
