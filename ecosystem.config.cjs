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
