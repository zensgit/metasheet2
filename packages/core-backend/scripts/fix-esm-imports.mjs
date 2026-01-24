import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'

const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('dist')
const allowedExtensions = new Set(['.js', '.mjs', '.cjs', '.json', '.node'])

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const resolved = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walk(resolved))
    } else {
      files.push(resolved)
    }
  }
  return files
}

function hasExtension(specifier) {
  const ext = path.extname(specifier)
  return allowedExtensions.has(ext)
}

async function resolveExtension(specifier, filePath) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return specifier
  if (hasExtension(specifier)) return specifier

  const base = path.resolve(path.dirname(filePath), specifier)

  try {
    const jsStat = await stat(`${base}.js`)
    if (jsStat.isFile()) return `${specifier}.js`
  } catch {}

  try {
    const mjsStat = await stat(`${base}.mjs`)
    if (mjsStat.isFile()) return `${specifier}.mjs`
  } catch {}

  try {
    const dirStat = await stat(base)
    if (dirStat.isDirectory()) {
      try {
        const idxStat = await stat(path.join(base, 'index.js'))
        if (idxStat.isFile()) return `${specifier}/index.js`
      } catch {}
    }
  } catch {}

  return `${specifier}.js`
}

async function rewriteFile(filePath) {
  if (!filePath.endsWith('.js') && !filePath.endsWith('.mjs')) return
  const original = await readFile(filePath, 'utf8')
  let updated = original

  updated = await replaceAsync(updated, /\bfrom\s+['"]([^'"]+)['"]/g, async (match, specifier) => {
    const resolved = await resolveExtension(specifier, filePath)
    if (resolved === specifier) return match
    return match.replace(specifier, resolved)
  })

  updated = await replaceAsync(updated, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, async (match, specifier) => {
    const resolved = await resolveExtension(specifier, filePath)
    if (resolved === specifier) return match
    return match.replace(specifier, resolved)
  })

  if (updated !== original) {
    await writeFile(filePath, updated, 'utf8')
  }
}

async function replaceAsync(text, regex, asyncReplacer) {
  const matches = []
  text.replace(regex, (...args) => {
    matches.push(args)
    return ''
  })
  const replacements = await Promise.all(matches.map(args => asyncReplacer(...args)))
  let i = 0
  return text.replace(regex, () => replacements[i++])
}

async function run() {
  const files = await walk(targetDir)
  await Promise.all(files.map(rewriteFile))
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
