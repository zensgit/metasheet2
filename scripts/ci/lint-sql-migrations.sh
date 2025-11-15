#!/bin/bash
# SQL Migrations Health Check
# Checks for common SQL syntax issues before running migrations
# Usage: bash scripts/ci/lint-sql-migrations.sh

set -e

MIGRATION_DIR="packages/core-backend/src/db/migrations"
ISSUES_FOUND=0
WARNINGS_FOUND=0

# Colors
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🔍 Checking SQL migrations for common issues...${NC}"
echo ""

if [ ! -d "$MIGRATION_DIR" ]; then
  echo -e "${RED}❌ Migration directory not found: $MIGRATION_DIR${NC}"
  exit 1
fi

# Find all SQL files
SQL_FILES=$(find "$MIGRATION_DIR" -name "*.sql" -type f | sort)

if [ -z "$SQL_FILES" ]; then
  echo -e "${YELLOW}⚠️  No SQL migration files found${NC}"
  exit 0
fi

FILE_COUNT=$(echo "$SQL_FILES" | wc -l | tr -d ' ')
echo -e "${BLUE}Found $FILE_COUNT SQL migration files${NC}"
echo ""

# Check each file
while IFS= read -r file; do
  [ -e "$file" ] || continue

  filename=$(basename "$file")
  echo -e "${BLUE}Checking:${NC} $filename"

  # Check 1: Inline INDEX keyword (but exclude CREATE INDEX statements)
  if grep -vE "^\s*(CREATE|DROP)\s+INDEX" "$file" | grep -qE "\bINDEX\s+\w+\s+" ; then
    echo -e "  ${RED}❌ Contains inline INDEX keyword${NC}"
    echo "     Fix: Use separate CREATE INDEX statements"
    ISSUES_FOUND=$((ISSUES_FOUND + 1))
  fi

  # Check 2: Missing IF NOT EXISTS for CREATE TABLE
  if grep -qiE "CREATE\s+TABLE\s+\w+" "$file" && ! grep -qiE "IF\s+NOT\s+EXISTS" "$file"; then
    echo -e "  ${YELLOW}⚠️  CREATE TABLE without IF NOT EXISTS${NC}"
    echo "     Warning: May not be idempotent"
    WARNINGS_FOUND=$((WARNINGS_FOUND + 1))
  fi

  # Check 3: Missing IF NOT EXISTS for CREATE INDEX
  if grep -qiE "CREATE\s+(UNIQUE\s+)?INDEX\s+\w+" "$file" && ! grep -qiE "IF\s+NOT\s+EXISTS" "$file"; then
    echo -e "  ${YELLOW}⚠️  CREATE INDEX without IF NOT EXISTS${NC}"
    echo "     Warning: May not be idempotent"
    WARNINGS_FOUND=$((WARNINGS_FOUND + 1))
  fi

  # Check 4: Inconsistent keyword casing
  CREATE_LOWER=$(grep -c "create table" "$file" 2>/dev/null || true)
  CREATE_UPPER=$(grep -c "CREATE TABLE" "$file" 2>/dev/null || true)
  if [ "$CREATE_LOWER" -gt 0 ] && [ "$CREATE_UPPER" -gt 0 ]; then
    echo -e "  ${YELLOW}⚠️  Inconsistent keyword casing${NC}"
    echo "     Warning: Mixed 'create table' and 'CREATE TABLE'"
    WARNINGS_FOUND=$((WARNINGS_FOUND + 1))
  fi

  # Check 5: Missing semicolon at end
  if ! tail -c 10 "$file" | grep -q ";"; then
    echo -e "  ${YELLOW}⚠️  May be missing semicolon at end${NC}"
    echo "     Warning: Last statement should end with ;"
    WARNINGS_FOUND=$((WARNINGS_FOUND + 1))
  fi

  # Check 6: Check for common typos
  if grep -qiE "(,\s*,|,\s*;|\bFROM\s+,|\bWHERE\s+,)" "$file"; then
    echo -e "  ${RED}❌ Possible syntax error (double comma or comma before semicolon)${NC}"
    ISSUES_FOUND=$((ISSUES_FOUND + 1))
  fi

  # Check 7: Trailing commas in CREATE TABLE
  if grep -qE ",\s*\);" "$file"; then
    echo -e "  ${RED}❌ Trailing comma before closing parenthesis${NC}"
    echo "     Fix: Remove comma before )"
    ISSUES_FOUND=$((ISSUES_FOUND + 1))
  fi

  # Check 8: Partition table PRIMARY KEY validation
  if grep -qiE "PARTITION\s+BY" "$file"; then
    if grep -qiE "PRIMARY\s+KEY\s*\([^,)]+\)" "$file"; then
      echo -e "  ${YELLOW}⚠️  Partition table with simple PRIMARY KEY${NC}"
      echo "     Warning: Partition key should be included in PRIMARY KEY"
      WARNINGS_FOUND=$((WARNINGS_FOUND + 1))
    fi
  fi

  # All checks passed for this file
  if [ $ISSUES_FOUND -eq 0 ] && [ $WARNINGS_FOUND -eq 0 ]; then
    echo -e "  ${GREEN}✓ No issues found${NC}"
  fi

  echo ""
done <<< "$SQL_FILES"

# Summary
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Summary:${NC}"
echo "  Files checked: $FILE_COUNT"

if [ $ISSUES_FOUND -gt 0 ]; then
  echo -e "  ${RED}Issues found: $ISSUES_FOUND${NC}"
else
  echo -e "  ${GREEN}Issues found: 0${NC}"
fi

if [ $WARNINGS_FOUND -gt 0 ]; then
  echo -e "  ${YELLOW}Warnings: $WARNINGS_FOUND${NC}"
else
  echo -e "  ${GREEN}Warnings: 0${NC}"
fi

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Non-blocking exit
if [ $ISSUES_FOUND -gt 0 ]; then
  echo -e "${YELLOW}⚠️  Found $ISSUES_FOUND issues (non-blocking, for reference)${NC}"
  echo -e "${YELLOW}   Please review and fix these issues in your migrations${NC}"
else
  echo -e "${GREEN}✅ All SQL migrations passed health checks${NC}"
fi

# Always exit 0 (non-blocking)
exit 0
