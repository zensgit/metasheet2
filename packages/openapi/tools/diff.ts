#!/usr/bin/env tsx
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'

function main() {
  const prevFile = process.argv[2]
  const currFile = process.argv[3]
  if (!prevFile || !currFile) {
    console.error('Usage: diff <prev.yml> <curr.yml>')
    process.exit(1)
  }
  const prev = yaml.load(fs.readFileSync(prevFile, 'utf-8')) as any
  const curr = yaml.load(fs.readFileSync(currFile, 'utf-8')) as any

  const prevPaths = new Set(Object.keys(prev.paths || {}))
  const currPaths = new Set(Object.keys(curr.paths || {}))
  const removedPaths = [...prevPaths].filter(p => !currPaths.has(p))
  const addedPaths = [...currPaths].filter(p => !prevPaths.has(p))

  if (removedPaths.length) {
    console.error('Breaking change: removed paths:')
    for (const p of removedPaths) console.error(' -', p)
    process.exit(2)
  }

  // 方法级删除检测
  const methodSet = ['get','post','put','patch','delete','options','head','trace']
  const methodRemovals: string[] = []
  for (const p of currPaths) {
    const prevMethods = prev.paths[p] ? Object.keys(prev.paths[p]) : []
    const currMethods = curr.paths[p] ? Object.keys(curr.paths[p]) : []
    for (const m of methodSet) {
      if (prevMethods.includes(m) && !currMethods.includes(m)) {
        methodRemovals.push(`${m.toUpperCase()} ${p}`)
      }
    }
  }
  if (methodRemovals.length) {
    console.error('Breaking change: removed operations:')
    for (const m of methodRemovals) console.error(' -', m)
    process.exit(2)
  }

  console.log('Paths/operations OK. Added paths:', addedPaths)
}

main()
