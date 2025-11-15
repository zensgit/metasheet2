import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.cwd(), '..')
const dist = path.resolve(root, 'dist')
const outDir = path.resolve(process.cwd(), '.')

const sdkSrc = path.join(dist, 'sdk.ts')
if (!fs.existsSync(sdkSrc)) {
  console.error('sdk.ts not found, run openapi build first')
  process.exit(1)
}
const jsOut = path.join(outDir, 'index.js')
const dtsOut = path.join(outDir, 'index.d.ts')
const src = fs.readFileSync(sdkSrc, 'utf8')
fs.writeFileSync(dtsOut, src)
fs.writeFileSync(jsOut, `// ESM stub exports types only\nexport {};\n`)
console.log('SDK packaged to dist-sdk')

