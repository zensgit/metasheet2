#!/usr/bin/env tsx
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'

const root = path.join(__dirname, '..')
const base = yaml.load(fs.readFileSync(path.join(root, 'src', 'base.yml'), 'utf-8')) as any

const pathsDir = path.join(root, 'src', 'paths')
const parts = fs.readdirSync(pathsDir).filter(f => f.endsWith('.yml')).sort()

base.paths = base.paths || {}
for (const f of parts) {
  const doc = yaml.load(fs.readFileSync(path.join(pathsDir, f), 'utf-8')) as any
  Object.assign(base.paths, doc.paths)
}

const distDir = path.join(root, 'dist')
fs.mkdirSync(distDir, { recursive: true })
fs.writeFileSync(path.join(distDir, 'combined.openapi.yml'), yaml.dump(base, { noRefs: true }))
console.log('Built OpenAPI to dist/combined.openapi.yml with parts:', parts)

