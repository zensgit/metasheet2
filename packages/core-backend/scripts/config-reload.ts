#!/usr/bin/env tsx
/**
 * Config reload helper
 * Calls an internal reload and prints sanitized config.
 * For now, it imports and calls reloadConfig() directly.
 */

import { reloadConfig, getConfig, sanitizeConfig } from '../src/config'

async function main() {
  const cfg = reloadConfig()
  console.log(JSON.stringify(sanitizeConfig(cfg), null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })

