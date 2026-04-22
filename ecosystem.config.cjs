const fs = require('node:fs')
const path = require('node:path')

// --- on-prem env bootstrap (issue #518) -------------------------------------
//
// The bootstrap scripts (`attendance-onprem-bootstrap.sh` etc.) normally
// `source docker/app.env` before invoking PM2. Running `pm2 start
// ecosystem.config.cjs` directly skipped that step and the backend crashed
// in a restart loop with `Secret not found for key: DATABASE_URL`.
//
// This inline loader reads `docker/app.env` at config-parse time and
// populates `process.env` (without overriding values already set by the
// shell), so PM2 inherits the expected runtime env whether the operator
// ran `bootstrap.sh` or called `pm2 start` directly.
//
// Zero extra deps — we intentionally do NOT pull in `dotenv` to keep the
// on-prem image footprint small. The parser handles the `KEY=value` shape
// used by all `docker/app.env.*.template` files:
//   - lines starting with `#` are comments
//   - blank lines are skipped
//   - single or double quotes around the value are stripped
//   - values are NOT subject to `${var}` expansion (bash would expand them
//     in `source`, but the templates do not rely on expansion)
// ---------------------------------------------------------------------------
function loadOnPremEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return
    const content = fs.readFileSync(filePath, 'utf8')
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (!(key in process.env)) {
        process.env[key] = value
      }
    }
  } catch {
    // Best effort: if reading/parsing fails, fall back to the shell-sourced
    // env path. Operators using the bootstrap scripts are unaffected.
  }
}

loadOnPremEnvFile(path.join(__dirname, 'docker', 'app.env'))

module.exports = {
  apps: [
    {
      name: 'metasheet-backend',
      script: 'packages/core-backend/dist/src/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1024M',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      out_file: 'output/logs/metasheet-backend.out.log',
      error_file: 'output/logs/metasheet-backend.err.log',
      time: true,
    },
  ],
}
