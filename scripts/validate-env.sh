#!/bin/bash
# Environment Variable Validation Script
# Usage: bash scripts/validate-env.sh [development|test|production]
#
# This script performs fail-fast validation of required environment variables
# before starting the application, preventing runtime errors due to missing config.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Environment mode (default: development)
ENV_MODE="${1:-development}"

echo -e "${BLUE}🔍 Validating environment variables for mode: ${ENV_MODE}${NC}"
echo ""

# Track validation status
VALIDATION_FAILED=0
MISSING_VARS=()
WARNINGS=()

# Validation function
validate_required() {
    local var_name=$1
    local var_value="${!var_name}"
    local description=$2

    if [ -z "$var_value" ]; then
        echo -e "${RED}❌ MISSING: ${var_name}${NC}"
        echo -e "   ${description}"
        MISSING_VARS+=("$var_name")
        VALIDATION_FAILED=1
    else
        echo -e "${GREEN}✅ ${var_name}${NC}: ${var_value:0:50}..."
    fi
}

# Validation function with warning (optional but recommended)
validate_recommended() {
    local var_name=$1
    local var_value="${!var_name}"
    local description=$2

    if [ -z "$var_value" ]; then
        echo -e "${YELLOW}⚠️  RECOMMENDED: ${var_name}${NC}"
        echo -e "   ${description}"
        WARNINGS+=("$var_name")
    else
        echo -e "${GREEN}✅ ${var_name}${NC}: ${var_value:0:50}..."
    fi
}

# Core validation - Required for all environments
echo -e "${BLUE}=== Core Configuration ===${NC}"
validate_required "DATABASE_URL" \
    "PostgreSQL connection string (e.g., postgresql://user:password@host:5432/database)"

validate_required "JWT_SECRET" \
    "Secret key for JWT token generation (min 32 characters recommended)"

echo ""

# Redis configuration (if using caching/sessions)
echo -e "${BLUE}=== Redis Configuration (Optional) ===${NC}"
validate_recommended "REDIS_URL" \
    "Redis connection string for caching (e.g., redis://localhost:6379)"

echo ""

# Environment-specific validation
case "$ENV_MODE" in
    production)
        echo -e "${BLUE}=== Production Environment Validation ===${NC}"

        # Production-specific required variables
        validate_required "NODE_ENV" \
            "Must be set to 'production'"

        if [ "$NODE_ENV" != "production" ]; then
            echo -e "${RED}❌ NODE_ENV must be 'production' in production mode${NC}"
            VALIDATION_FAILED=1
        fi

        # Security checks for production
        if [ "${JWT_SECRET}" == "dev-secret-key" ] || [ "${JWT_SECRET}" == "dev-secret" ]; then
            echo -e "${RED}❌ JWT_SECRET uses development default - INSECURE IN PRODUCTION!${NC}"
            VALIDATION_FAILED=1
        fi

        if [[ "$DATABASE_URL" == *"postgres:postgres"* ]] || [[ "$DATABASE_URL" == *"postgres:password"* ]]; then
            echo -e "${RED}❌ DATABASE_URL uses development credentials - INSECURE IN PRODUCTION!${NC}"
            VALIDATION_FAILED=1
        fi

        validate_recommended "LOG_LEVEL" \
            "Log level for production (recommended: 'info' or 'warn')"

        validate_recommended "CORS_ORIGIN" \
            "Allowed CORS origins for API requests"

        echo ""
        ;;

    test)
        echo -e "${BLUE}=== Test Environment Validation ===${NC}"

        validate_recommended "NODE_ENV" \
            "Should be set to 'test' for test environment"

        echo ""
        ;;

    development)
        echo -e "${BLUE}=== Development Environment Validation ===${NC}"

        validate_recommended "NODE_ENV" \
            "Should be set to 'development'"

        validate_recommended "PORT" \
            "API server port (default: 8900)"

        validate_recommended "LOG_LEVEL" \
            "Log verbosity (recommended: 'debug' for development)"

        echo ""
        ;;

    *)
        echo -e "${YELLOW}⚠️  Unknown environment mode: ${ENV_MODE}${NC}"
        echo -e "   Valid modes: development, test, production"
        echo ""
        ;;
esac

# Integration services (optional)
echo -e "${BLUE}=== Integration Services (Optional) ===${NC}"

if [ -n "$FEISHU_APP_ID" ] || [ -n "$FEISHU_APP_SECRET" ]; then
    validate_required "FEISHU_APP_ID" "Feishu (Lark) application ID"
    validate_required "FEISHU_APP_SECRET" "Feishu (Lark) application secret"
fi

if [ -n "$DINGTALK_APP_KEY" ] || [ -n "$DINGTALK_APP_SECRET" ]; then
    validate_required "DINGTALK_APP_KEY" "DingTalk application key"
    validate_required "DINGTALK_APP_SECRET" "DingTalk application secret"
fi

if [ -n "$WECHAT_WORK_CORP_ID" ] || [ -n "$WECHAT_WORK_SECRET" ]; then
    validate_required "WECHAT_WORK_CORP_ID" "WeChat Work corporation ID"
    validate_required "WECHAT_WORK_SECRET" "WeChat Work application secret"
fi

echo ""

# Summary
echo -e "${BLUE}=== Validation Summary ===${NC}"

if [ $VALIDATION_FAILED -eq 1 ]; then
    echo -e "${RED}❌ Environment validation FAILED!${NC}"
    echo ""
    echo -e "${RED}Missing required variables (${#MISSING_VARS[@]}):${NC}"
    for var in "${MISSING_VARS[@]}"; do
        echo -e "  - ${var}"
    done
    echo ""
    echo -e "${BLUE}💡 Setup Instructions:${NC}"
    echo ""

    if [[ " ${MISSING_VARS[@]} " =~ " DATABASE_URL " ]]; then
        echo -e "1. Set DATABASE_URL:"
        echo -e "   ${GREEN}export DATABASE_URL=postgresql://your_user:your_password@localhost:5432/metasheet_v2${NC}"
        echo ""
    fi

    if [[ " ${MISSING_VARS[@]} " =~ " JWT_SECRET " ]]; then
        echo -e "2. Set JWT_SECRET:"
        echo -e "   ${GREEN}export JWT_SECRET=\$(openssl rand -base64 32)${NC}"
        echo ""
    fi

    echo -e "3. Alternatively, create a .env file:"
    echo -e "   ${GREEN}cp .env.example .env${NC}"
    echo -e "   ${GREEN}# Edit .env with your configuration${NC}"
    echo ""

    echo -e "4. For detailed examples, see:"
    echo -e "   - .env.*.example files"
    echo -e "   - README_DEV.md"
    echo ""

    exit 1
else
    echo -e "${GREEN}✅ All required environment variables are configured!${NC}"

    if [ ${#WARNINGS[@]} -gt 0 ]; then
        echo -e ""
        echo -e "${YELLOW}⚠️  ${#WARNINGS[@]} recommended variables are missing:${NC}"
        for var in "${WARNINGS[@]}"; do
            echo -e "  - ${var}"
        done
        echo -e ""
        echo -e "${YELLOW}The application will start, but some features may not work as expected.${NC}"
    fi

    echo ""
    echo -e "${GREEN}🚀 Environment validation passed - safe to start application!${NC}"
    exit 0
fi
