#!/bin/bash
# Apply branch protection configuration to main branch
# Usage: bash apply-branch-protection.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/branch-protection.json"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}📋 Branch Protection Configuration Tool${NC}"
echo ""

# Check if config file exists
if [ ! -f "$CONFIG_FILE" ]; then
  echo -e "${RED}❌ Configuration file not found: $CONFIG_FILE${NC}"
  exit 1
fi

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
  echo -e "${RED}❌ GitHub CLI (gh) is not installed${NC}"
  echo "Install it from: https://cli.github.com/"
  exit 1
fi

# Check if authenticated
if ! gh auth status &> /dev/null; then
  echo -e "${YELLOW}⚠️  Not authenticated with GitHub${NC}"
  echo "Run: gh auth login"
  exit 1
fi

echo -e "${BLUE}📄 Reading configuration from:${NC} $CONFIG_FILE"
echo ""

# Extract configuration using jq
if ! command -v jq &> /dev/null; then
  echo -e "${RED}❌ jq is not installed${NC}"
  echo "Install it from: https://stedolan.github.io/jq/"
  exit 1
fi

STRICT=$(jq -r '.config.strict' "$CONFIG_FILE")
CONTEXTS=$(jq -c '.config.contexts' "$CONFIG_FILE")
REPO=$(jq -r '.repository' "$CONFIG_FILE")
BRANCH=$(jq -r '.branch' "$CONFIG_FILE")

echo -e "${BLUE}Configuration:${NC}"
echo "  Repository: $REPO"
echo "  Branch: $BRANCH"
echo "  Strict: $STRICT"
echo "  Required Checks:"
echo "$CONTEXTS" | jq -r '.[]' | sed 's/^/    - /'
echo ""

# Confirm with user
read -p "Apply this configuration? (y/N): " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo -e "${YELLOW}⚠️  Cancelled by user${NC}"
  exit 0
fi

echo -e "${BLUE}🔧 Applying branch protection...${NC}"

# Apply to GitHub
gh api --method PATCH \
  "/repos/$REPO/branches/$BRANCH/protection/required_status_checks" \
  --input <(cat <<EOF
{
  "strict": $STRICT,
  "contexts": $CONTEXTS
}
EOF
) > /dev/null

echo -e "${GREEN}✅ Branch protection applied successfully${NC}"
echo ""

# Verify
echo -e "${BLUE}🔍 Verifying configuration...${NC}"
CURRENT_CONTEXTS=$(gh api "/repos/$REPO/branches/$BRANCH/protection/required_status_checks" | jq -c '.contexts')

if [ "$CURRENT_CONTEXTS" = "$CONTEXTS" ]; then
  echo -e "${GREEN}✅ Verification passed${NC}"
  echo ""
  echo "Current required checks:"
  echo "$CURRENT_CONTEXTS" | jq -r '.[]' | sed 's/^/  - /'
else
  echo -e "${RED}⚠️  Verification failed - contexts don't match${NC}"
  echo "Expected: $CONTEXTS"
  echo "Got: $CURRENT_CONTEXTS"
  exit 1
fi

echo ""
echo -e "${GREEN}✨ Done!${NC}"
