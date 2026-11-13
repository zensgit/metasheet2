/**
 * The data-source manager is a module-level singleton in src/routes/data-sources.ts. The router and
 * the plugin facades get it through the STATIC import in src/index.ts. Under tsx (`dev:core`, which
 * several CI lanes boot) a dynamic `import()` of the same file loads a SECOND module instance, so a DB
 * bound through it lands on a manager nothing else uses: POST /api/data-sources answers 201 and
 * persists no row. The compiled CommonJS build shares one instance either way, which is why this
 * only shows under tsx; vitest also shares one instance, so the guard reads source text.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '..', '..', 'src')
const INDEX = path.join(SRC, 'index.ts')
const DATA_SOURCES_MODULE = path.join(SRC, 'routes', 'data-sources')

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...listTsFiles(p))
    else if (/\.[cm]?ts$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** `import('…')` / `require('…')` calls with a literal specifier that resolves to src/routes/data-sources. */
function dynamicLoadsOfDataSources(file: string, text: string): string[] {
  const hits: string[] = []
  const re = /\b(?:import|require)\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const spec = m[2]
    if (!spec.startsWith('.')) continue
    const resolved = path.resolve(path.dirname(file), spec).replace(/\.[cm]?[jt]s$/, '')
    if (resolved === DATA_SOURCES_MODULE) {
      const line = text.slice(0, m.index).split('\n').length
      hits.push(`${path.relative(SRC, file).split(path.sep).join('/')}:${line} ${m[0]}`)
    }
  }
  return hits
}

describe('data-source manager is one instance under tsx', () => {
  it('no src module loads routes/data-sources through import() or require()', () => {
    const hits = listTsFiles(SRC).flatMap((f) => dynamicLoadsOfDataSources(f, readFileSync(f, 'utf8')))
    expect(hits).toEqual([])
  })

  it('index.ts takes initializeDataSourceManager from its static import of ./routes/data-sources', () => {
    const text = readFileSync(INDEX, 'utf8')
    const clauses = [...text.matchAll(/^import\s*\{([^}]*)\}\s*from\s*(['"])\.\/routes\/data-sources\2/gm)]
    expect(clauses).toHaveLength(1)
    const names = clauses[0][1].split(',').map((s) => s.trim()).filter(Boolean)
    expect(names).toContain('initializeDataSourceManager')
    expect(names).toContain('getDataSourceManager')
  })

  it('index.ts still binds the DB: initializeDataSourceManager( is called exactly once', () => {
    const text = readFileSync(INDEX, 'utf8')
    expect(text.match(/\binitializeDataSourceManager\s*\(/g) ?? []).toHaveLength(1)
  })
})
