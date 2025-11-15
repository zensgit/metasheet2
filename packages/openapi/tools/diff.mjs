#!/usr/bin/env node
// Minimal placeholder OpenAPI diff: prints a simple JSON structure
// Usage: diff.mjs <prev.yaml> <curr.yaml>
import fs from 'node:fs'

const [, , prev, curr] = process.argv
if (!prev || !curr) {
  console.error('Usage: diff.mjs <prev.yaml> <curr.yaml>')
  process.exit(0)
}

const result = {
  compared: { prev, curr },
  summary: { added: 0, removed: 0, changed: 0 }
}
console.log(JSON.stringify(result))

