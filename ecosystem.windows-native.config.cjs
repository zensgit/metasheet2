const fs = require('node:fs')
const path = require('node:path')

function loadEnvFile(filePath) {
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
    if (!(key in process.env)) process.env[key] = value
  }
}

const rootDir = __dirname
loadEnvFile(path.join(rootDir, 'docker', 'app.env'))

const backendHost =
  !process.env.HOST || process.env.HOST === '0.0.0.0'
    ? '127.0.0.1'
    : process.env.HOST
const backendPort = process.env.PORT || '8900'

module.exports = {
  apps: [
    {
      name: 'metasheet-windows-gateway',
      script: 'scripts/ops/attendance-windows-native-gateway.mjs',
      args: [
        '--root',
        rootDir,
        '--host',
        process.env.WINDOWS_NATIVE_GATEWAY_HOST || '127.0.0.1',
        '--port',
        process.env.WINDOWS_NATIVE_GATEWAY_PORT || '8080',
        '--backend',
        process.env.WINDOWS_NATIVE_BACKEND_ORIGIN ||
          `http://${backendHost}:${backendPort}`,
      ],
      cwd: rootDir,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      out_file: 'output/logs/metasheet-windows-gateway.out.log',
      error_file: 'output/logs/metasheet-windows-gateway.err.log',
      time: true,
    },
  ],
}
