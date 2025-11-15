#!/bin/bash
# Docker/Production Entrypoint with Environment Validation
# This script ensures environment variables are validated before starting the application
# Usage: ENTRYPOINT ["bash", "scripts/docker-entrypoint-validate.sh"]

set -e

echo "🚀 MetaSheet Production Entrypoint"
echo "==================================="
echo ""

# Determine environment mode
ENV_MODE="${NODE_ENV:-production}"
echo "📌 Environment Mode: $ENV_MODE"
echo ""

# Run environment validation
echo "🔍 Validating environment variables..."
if ! bash /app/scripts/validate-env.sh "$ENV_MODE"; then
    echo ""
    echo "❌ Environment validation FAILED!"
    echo ""
    echo "Container will NOT start until all required variables are set."
    echo ""
    echo "Common fixes:"
    echo "1. Check docker-compose.yml environment section"
    echo "2. Verify .env file is properly mounted"
    echo "3. Ensure all required variables are set in deployment config"
    echo ""
    echo "For detailed requirements, see:"
    echo "  - scripts/validate-env.sh"
    echo "  - .env.*.example files"
    echo ""
    exit 1
fi

echo ""
echo "✅ Environment validation passed!"
echo ""

# Additional production-specific checks
if [ "$NODE_ENV" == "production" ]; then
    echo "🔒 Running production security checks..."

    # Check for insecure defaults
    if [ "${JWT_SECRET}" == "dev-secret-key" ] || [ "${JWT_SECRET}" == "dev-secret" ]; then
        echo "❌ SECURITY ERROR: JWT_SECRET uses development default!"
        echo "   Production requires a strong, unique secret."
        echo "   Generate one: openssl rand -base64 64"
        exit 1
    fi

    if [[ "$DATABASE_URL" == *"postgres:postgres"* ]] || [[ "$DATABASE_URL" == *":password@"* ]]; then
        echo "❌ SECURITY ERROR: DATABASE_URL contains insecure credentials!"
        echo "   Production requires strong database passwords."
        exit 1
    fi

    # Check NODE_ENV is correctly set
    if [ "$NODE_ENV" != "production" ]; then
        echo "⚠️  WARNING: NODE_ENV is not 'production' (current: $NODE_ENV)"
        echo "   Some optimizations may not be enabled."
    fi

    echo "✅ Production security checks passed!"
    echo ""
fi

# Log startup configuration (without sensitive values)
echo "📋 Startup Configuration:"
echo "  - Node Version: $(node --version)"
echo "  - Environment: $NODE_ENV"
echo "  - Database: ${DATABASE_URL%%@*}@***"  # Hide credentials
echo "  - Port: ${PORT:-8900}"
echo ""

# Start the application
echo "🎬 Starting application..."
echo ""

# Pass control to the application
exec "$@"
