import fs from 'fs/promises'
import path from 'path'

const RELEASE_ROOT = path.resolve('output/releases/multitable-onprem')
const DELIVERY_ROOT = path.resolve('output/delivery/multitable-onprem')

const packageJsonPath = process.env.PACKAGE_JSON || ''
const deliveryRootOverride = process.env.DELIVERY_OUTPUT_ROOT || ''

const docsToCopy = [
  'docs/deployment/multitable-windows-onprem-easy-start-20260319.md',
  'docs/deployment/multitable-onprem-package-layout-20260319.md',
  'docs/deployment/multitable-onprem-customer-delivery-checklist-20260319.md',
  'docs/deployment/multitable-internal-pilot-runbook-20260319.md',
  'docs/deployment/multitable-pilot-quickstart-20260319.md',
]

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function findLatestPackageJson() {
  if (packageJsonPath) return path.resolve(packageJsonPath)
  const entries = await fs.readdir(RELEASE_ROOT)
  const candidates = entries
    .filter((name) => name.endsWith('.json'))
    .filter((name) => name !== 'package.json')
    .sort()
  const latest = candidates.at(-1)
  if (!latest) {
    throw new Error(`No package metadata json found under ${RELEASE_ROOT}`)
  }
  return path.join(RELEASE_ROOT, latest)
}

async function copyFileOrThrow(from, to) {
  if (!(await exists(from))) {
    throw new Error(`Missing required file: ${from}`)
  }
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.copyFile(from, to)
}

async function main() {
  const resolvedPackageJsonPath = await findLatestPackageJson()
  const raw = await fs.readFile(resolvedPackageJsonPath, 'utf8')
  const pkg = JSON.parse(raw)
  const packageName = pkg?.name
  if (!packageName) {
    throw new Error(`Package metadata missing name: ${resolvedPackageJsonPath}`)
  }

  const outRoot = deliveryRootOverride ? path.resolve(deliveryRootOverride) : DELIVERY_ROOT
  const bundleRoot = path.join(outRoot, packageName)

  const tgzPath = path.join(RELEASE_ROOT, pkg.archive)
  const zipPath = path.join(RELEASE_ROOT, pkg.archiveZip)
  const checksumIndex = path.join(RELEASE_ROOT, pkg.checksumFile)
  const tgzSha = `${tgzPath}.sha256`
  const zipSha = `${zipPath}.sha256`

  await fs.mkdir(bundleRoot, { recursive: true })

  await copyFileOrThrow(resolvedPackageJsonPath, path.join(bundleRoot, path.basename(resolvedPackageJsonPath)))
  await copyFileOrThrow(tgzPath, path.join(bundleRoot, path.basename(tgzPath)))
  await copyFileOrThrow(zipPath, path.join(bundleRoot, path.basename(zipPath)))
  await copyFileOrThrow(tgzSha, path.join(bundleRoot, path.basename(tgzSha)))
  await copyFileOrThrow(zipSha, path.join(bundleRoot, path.basename(zipSha)))
  await copyFileOrThrow(checksumIndex, path.join(bundleRoot, path.basename(checksumIndex)))

  for (const docRel of docsToCopy) {
    const abs = path.resolve(docRel)
    await copyFileOrThrow(abs, path.join(bundleRoot, 'docs', path.basename(docRel)))
  }

  const summaryMd = [
    '# Multitable On-Prem Delivery Bundle',
    '',
    `- Package name: \`${packageName}\``,
    `- Product mode: \`${pkg.productMode ?? 'unknown'}\``,
    `- Attendance only: \`${String(pkg.attendanceOnly)}\``,
    `- Bundle root: \`${bundleRoot}\``,
    '',
    '## Included package files',
    '',
    `- \`${path.basename(tgzPath)}\``,
    `- \`${path.basename(zipPath)}\``,
    `- \`${path.basename(tgzSha)}\``,
    `- \`${path.basename(zipSha)}\``,
    `- \`${path.basename(checksumIndex)}\``,
    `- \`${path.basename(resolvedPackageJsonPath)}\``,
    '',
    '## Included docs',
    '',
    ...docsToCopy.map((item) => `- \`${path.basename(item)}\``),
    '',
    '## Recommended first document for the customer',
    '',
    `- \`${path.basename(docsToCopy[0])}\``,
    '',
  ].join('\n')

  const manifest = {
    package: pkg,
    bundleRoot,
    packageJson: resolvedPackageJsonPath,
    createdAt: new Date().toISOString(),
    includedDocs: docsToCopy.map((item) => path.basename(item)),
  }

  await fs.writeFile(path.join(bundleRoot, 'DELIVERY.md'), `${summaryMd}\n`, 'utf8')
  await fs.writeFile(path.join(bundleRoot, 'DELIVERY.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  process.stdout.write(`[multitable-onprem-delivery-bundle] bundle_root=${bundleRoot}\n`)
  process.stdout.write(`[multitable-onprem-delivery-bundle] package_json=${resolvedPackageJsonPath}\n`)
}

main().catch((error) => {
  process.stderr.write(`[multitable-onprem-delivery-bundle] ERROR: ${error.message}\n`)
  process.exit(1)
})
