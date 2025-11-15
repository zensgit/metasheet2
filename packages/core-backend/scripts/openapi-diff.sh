#!/bin/bash

# OpenAPI Schema Diff Checker
# This script compares OpenAPI schemas to detect breaking changes

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default paths
BASE_SCHEMA="${1:-./openapi/openapi-base.json}"
NEW_SCHEMA="${2:-./openapi/openapi.json}"
OUTPUT_FILE="${3:-./openapi/diff.json}"

echo "OpenAPI Schema Diff Checker"
echo "==========================="
echo ""

# Check if schemas exist
if [ ! -f "$BASE_SCHEMA" ]; then
    echo -e "${YELLOW}Warning: Base schema not found at $BASE_SCHEMA${NC}"
    echo "Creating empty base schema..."
    mkdir -p $(dirname "$BASE_SCHEMA")
    echo '{"openapi":"3.0.0","info":{"title":"API","version":"1.0.0"},"paths":{}}' > "$BASE_SCHEMA"
fi

if [ ! -f "$NEW_SCHEMA" ]; then
    echo -e "${RED}Error: New schema not found at $NEW_SCHEMA${NC}"
    exit 1
fi

# Function to check if node is installed
check_node() {
    if ! command -v node &> /dev/null; then
        echo -e "${RED}Error: Node.js is required but not installed${NC}"
        exit 1
    fi
}

# Function to perform diff using node
perform_diff() {
    node -e "
const fs = require('fs');

try {
    const baseSchema = JSON.parse(fs.readFileSync('$BASE_SCHEMA', 'utf8'));
    const newSchema = JSON.parse(fs.readFileSync('$NEW_SCHEMA', 'utf8'));

    // Simple diff logic - check for removed paths
    const basePaths = Object.keys(baseSchema.paths || {});
    const newPaths = Object.keys(newSchema.paths || {});

    const removedPaths = basePaths.filter(p => !newPaths.includes(p));
    const addedPaths = newPaths.filter(p => !basePaths.includes(p));

    const diff = {
        breaking: removedPaths.length > 0,
        removed: removedPaths,
        added: addedPaths,
        timestamp: new Date().toISOString()
    };

    fs.writeFileSync('$OUTPUT_FILE', JSON.stringify(diff, null, 2));

    if (diff.breaking) {
        console.error('Breaking changes detected:');
        console.error('Removed paths:', removedPaths);
        process.exit(1);
    } else {
        console.log('No breaking changes detected');
        if (addedPaths.length > 0) {
            console.log('New paths added:', addedPaths);
        }
    }
} catch (err) {
    console.error('Error performing diff:', err.message);
    process.exit(1);
}
"
}

# Main execution
check_node

echo "Comparing schemas..."
echo "  Base: $BASE_SCHEMA"
echo "  New:  $NEW_SCHEMA"
echo ""

perform_diff

echo ""
echo -e "${GREEN}✓ OpenAPI diff complete${NC}"
echo "Results saved to: $OUTPUT_FILE"