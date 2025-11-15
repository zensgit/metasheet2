#!/usr/bin/env tsx
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'

function isAuthWhitelisted(p: string): boolean {
  return p.startsWith('/api/auth/') || p === '/health' || p.startsWith('/metrics')
}

function main() {
  const file = process.argv[2] || path.join(__dirname, '..', 'src', 'openapi.yml')
  const doc = yaml.load(fs.readFileSync(file, 'utf-8')) as any
  const paths = doc.paths || {}
  const violations: string[] = []
  for (const p of Object.keys(paths)) {
    if (p.startsWith('/api/') && !isAuthWhitelisted(p)) {
      const methods = Object.keys(paths[p])
      for (const m of methods) {
        const sec = paths[p][m]?.security
        const hasBearer = Array.isArray(sec) && sec.some((s: any) => 'bearerAuth' in s)
        if (!hasBearer) {
          violations.push(`${m.toUpperCase()} ${p} missing bearerAuth`)
        }
      }
    }
  }
  if (violations.length) {
    console.error('OpenAPI security validation failed:')
    for (const v of violations) console.error(' -', v)
    process.exit(2)
  }
  console.log('OpenAPI security validation passed')
}

main()

