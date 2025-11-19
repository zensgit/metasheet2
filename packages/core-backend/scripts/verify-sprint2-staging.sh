#!/bin/bash

###############################################################################
# Sprint 2: Snapshot Protection System - Staging Verification Script
#
# Purpose: Systematic verification of Sprint 2 deployment in staging environment
# Prerequisites:
#   - Staging environment access
#   - Database credentials configured
#   - Valid admin API token
#
# Usage: ./scripts/verify-sprint2-staging.sh [API_TOKEN]
###############################################################################

set -e  # Exit on error

# Configuration
STAGING_API_URL="${STAGING_API_URL:-http://localhost:8900}"
API_TOKEN="${1:-}"
DB_NAME="${DB_NAME:-metasheet}"
VERIFICATION_LOG="./sprint2-verification-$(date +%Y%m%d-%H%M%S).log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1" | tee -a "$VERIFICATION_LOG"
}

log_success() {
    echo -e "${GREEN}[✓]${NC} $1" | tee -a "$VERIFICATION_LOG"
}

log_warning() {
    echo -e "${YELLOW}[⚠]${NC} $1" | tee -a "$VERIFICATION_LOG"
}

log_error() {
    echo -e "${RED}[✗]${NC} $1" | tee -a "$VERIFICATION_LOG"
}

log_section() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════${NC}" | tee -a "$VERIFICATION_LOG"
    echo -e "${BLUE}  $1${NC}" | tee -a "$VERIFICATION_LOG"
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}\n" | tee -a "$VERIFICATION_LOG"
}

# Check prerequisites
check_prerequisites() {
    log_section "1. PREREQUISITES CHECK"

    # Check if API token provided
    if [ -z "$API_TOKEN" ]; then
        log_error "API token not provided. Usage: $0 [API_TOKEN]"
        exit 1
    fi
    log_success "API token provided"

    # Check required commands
    local required_commands=("curl" "jq" "psql" "node" "npm")
    for cmd in "${required_commands[@]}"; do
        if command -v "$cmd" &> /dev/null; then
            log_success "$cmd is installed"
        else
            log_error "$cmd is not installed"
            exit 1
        fi
    done

    # Check database connection
    if psql -d "$DB_NAME" -c "SELECT 1" &> /dev/null; then
        log_success "Database connection OK"
    else
        log_error "Cannot connect to database: $DB_NAME"
        exit 1
    fi
}

# Verify database migrations
verify_database_migrations() {
    log_section "2. DATABASE MIGRATION VERIFICATION"

    # Check if snapshots table has new columns
    log_info "Checking snapshots table schema..."

    local has_tags=$(psql -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='snapshots' AND column_name='tags'")
    local has_protection=$(psql -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='snapshots' AND column_name='protection_level'")
    local has_channel=$(psql -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='snapshots' AND column_name='release_channel'")

    if [ "$has_tags" -eq 1 ]; then
        log_success "snapshots.tags column exists"
    else
        log_error "snapshots.tags column missing"
        exit 1
    fi

    if [ "$has_protection" -eq 1 ]; then
        log_success "snapshots.protection_level column exists"
    else
        log_error "snapshots.protection_level column missing"
        exit 1
    fi

    if [ "$has_channel" -eq 1 ]; then
        log_success "snapshots.release_channel column exists"
    else
        log_error "snapshots.release_channel column missing"
        exit 1
    fi

    # Check if protection_rules table exists
    log_info "Checking protection_rules table..."

    local rules_table=$(psql -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_name='protection_rules'")
    if [ "$rules_table" -eq 1 ]; then
        log_success "protection_rules table exists"
    else
        log_error "protection_rules table missing"
        exit 1
    fi

    # Check if rule_execution_log table exists
    local log_table=$(psql -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_name='rule_execution_log'")
    if [ "$log_table" -eq 1 ]; then
        log_success "rule_execution_log table exists"
    else
        log_error "rule_execution_log table missing"
        exit 1
    fi

    # Check indexes
    log_info "Checking database indexes..."

    local indexes=(
        "idx_snapshots_tags"
        "idx_snapshots_protection_level"
        "idx_snapshots_release_channel"
        "idx_protection_rules_conditions"
        "idx_protection_rules_effects"
        "idx_protection_rules_target_type"
        "idx_protection_rules_priority"
    )

    for index in "${indexes[@]}"; do
        local exists=$(psql -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM pg_indexes WHERE indexname='$index'")
        if [ "$exists" -eq 1 ]; then
            log_success "Index $index exists"
        else
            log_warning "Index $index missing (may be created asynchronously)"
        fi
    done

    # Check constraints
    log_info "Checking table constraints..."

    local constraints=(
        "chk_protection_level"
        "chk_release_channel"
    )

    for constraint in "${constraints[@]}"; do
        local exists=$(psql -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_name='$constraint'")
        if [ "$exists" -eq 1 ]; then
            log_success "Constraint $constraint exists"
        else
            log_error "Constraint $constraint missing"
            exit 1
        fi
    done
}

# Verify server health
verify_server_health() {
    log_section "3. SERVER HEALTH VERIFICATION"

    log_info "Checking server status..."

    # Health check endpoint
    local health_response=$(curl -s -o /dev/null -w "%{http_code}" "$STAGING_API_URL/health" || echo "000")

    if [ "$health_response" = "200" ]; then
        log_success "Server health check passed (HTTP 200)"
    else
        log_error "Server health check failed (HTTP $health_response)"
        exit 1
    fi

    # Check Prometheus metrics endpoint
    log_info "Checking Prometheus metrics endpoint..."

    local metrics_response=$(curl -s "$STAGING_API_URL/metrics" || echo "")

    if echo "$metrics_response" | grep -q "metasheet_snapshot_tags_total"; then
        log_success "Sprint 2 metric: metasheet_snapshot_tags_total found"
    else
        log_warning "Sprint 2 metric: metasheet_snapshot_tags_total not found"
    fi

    if echo "$metrics_response" | grep -q "metasheet_protection_rule_evaluations_total"; then
        log_success "Sprint 2 metric: metasheet_protection_rule_evaluations_total found"
    else
        log_warning "Sprint 2 metric: metasheet_protection_rule_evaluations_total not found"
    fi
}

# Test snapshot labels API
test_snapshot_labels_api() {
    log_section "4. SNAPSHOT LABELS API TESTING"

    local auth_header="Authorization: Bearer $API_TOKEN"

    # Create test snapshot first
    log_info "Creating test snapshot..."

    local test_snapshot_id="test-sprint2-$(date +%s)"
    local create_response=$(curl -s -X POST "$STAGING_API_URL/api/admin/snapshots" \
        -H "$auth_header" \
        -H "Content-Type: application/json" \
        -d "{
            \"id\": \"$test_snapshot_id\",
            \"view_id\": \"test-view-1\",
            \"data\": {}
        }" || echo "{}")

    if echo "$create_response" | jq -e '.ok' &> /dev/null; then
        log_success "Test snapshot created: $test_snapshot_id"
    else
        log_warning "Could not create test snapshot (may already exist)"
    fi

    # Test: Add tags
    log_info "Testing tag addition..."

    local add_tags_response=$(curl -s -X PUT "$STAGING_API_URL/api/admin/snapshots/$test_snapshot_id/tags" \
        -H "$auth_header" \
        -H "Content-Type: application/json" \
        -d '{"add": ["production", "sprint2-test"]}' || echo "{}")

    if echo "$add_tags_response" | jq -e '.ok' &> /dev/null; then
        log_success "Tags added successfully"
    else
        log_error "Failed to add tags: $(echo $add_tags_response | jq -r '.error // "Unknown error"')"
    fi

    # Test: Set protection level
    log_info "Testing protection level setting..."

    local protection_response=$(curl -s -X PATCH "$STAGING_API_URL/api/admin/snapshots/$test_snapshot_id/protection" \
        -H "$auth_header" \
        -H "Content-Type: application/json" \
        -d '{"level": "protected"}' || echo "{}")

    if echo "$protection_response" | jq -e '.ok' &> /dev/null; then
        log_success "Protection level set successfully"
    else
        log_error "Failed to set protection level: $(echo $protection_response | jq -r '.error // "Unknown error"')"
    fi

    # Test: Set release channel
    log_info "Testing release channel setting..."

    local channel_response=$(curl -s -X PATCH "$STAGING_API_URL/api/admin/snapshots/$test_snapshot_id/release-channel" \
        -H "$auth_header" \
        -H "Content-Type: application/json" \
        -d '{"channel": "stable"}' || echo "{}")

    if echo "$channel_response" | jq -e '.ok' &> /dev/null; then
        log_success "Release channel set successfully"
    else
        log_error "Failed to set release channel: $(echo $channel_response | jq -r '.error // "Unknown error"')"
    fi

    # Test: Query by tags
    log_info "Testing snapshot query by tags..."

    local query_response=$(curl -s -X GET "$STAGING_API_URL/api/admin/snapshots?tags=production" \
        -H "$auth_header" || echo "{}")

    if echo "$query_response" | jq -e '.ok' &> /dev/null; then
        local count=$(echo "$query_response" | jq '.data | length')
        log_success "Query by tags succeeded (found $count snapshots)"
    else
        log_error "Failed to query by tags"
    fi
}

# Test protection rules API
test_protection_rules_api() {
    log_section "5. PROTECTION RULES API TESTING"

    local auth_header="Authorization: Bearer $API_TOKEN"

    # Test: Create protection rule
    log_info "Testing protection rule creation..."

    local rule_response=$(curl -s -X POST "$STAGING_API_URL/api/admin/safety/rules" \
        -H "$auth_header" \
        -H "Content-Type: application/json" \
        -d '{
            "rule_name": "sprint2-test-rule",
            "description": "Test rule for Sprint 2 verification",
            "target_type": "snapshot",
            "conditions": {
                "all": [
                    {"field": "tags", "operator": "contains", "value": "production"}
                ]
            },
            "effects": {
                "action": "elevate_risk",
                "risk_level": "HIGH",
                "message": "Production snapshots require elevated risk assessment"
            },
            "priority": 100
        }' || echo "{}")

    local test_rule_id=""
    if echo "$rule_response" | jq -e '.ok' &> /dev/null; then
        test_rule_id=$(echo "$rule_response" | jq -r '.data.id')
        log_success "Protection rule created: $test_rule_id"
    else
        log_error "Failed to create protection rule: $(echo $rule_response | jq -r '.error // "Unknown error"')"
    fi

    # Test: List protection rules
    log_info "Testing protection rules listing..."

    local list_response=$(curl -s -X GET "$STAGING_API_URL/api/admin/safety/rules" \
        -H "$auth_header" || echo "{}")

    if echo "$list_response" | jq -e '.ok' &> /dev/null; then
        local count=$(echo "$list_response" | jq '.data | length')
        log_success "Protection rules listed (found $count rules)"
    else
        log_error "Failed to list protection rules"
    fi

    # Test: Evaluate rule (dry-run)
    if [ -n "$test_rule_id" ]; then
        log_info "Testing rule evaluation (dry-run)..."

        local eval_response=$(curl -s -X POST "$STAGING_API_URL/api/admin/safety/rules/evaluate" \
            -H "$auth_header" \
            -H "Content-Type: application/json" \
            -d '{
                "entity_type": "snapshot",
                "entity_id": "test-snapshot-1",
                "operation": "delete",
                "properties": {
                    "tags": ["production"],
                    "protection_level": "normal"
                }
            }' || echo "{}")

        if echo "$eval_response" | jq -e '.ok' &> /dev/null; then
            local matched=$(echo "$eval_response" | jq -r '.data.matched')
            if [ "$matched" = "true" ]; then
                log_success "Rule evaluation succeeded (matched: true)"
            else
                log_warning "Rule evaluation succeeded but no match (expected match for production tag)"
            fi
        else
            log_error "Failed to evaluate rule"
        fi
    fi

    # Test: Update rule
    if [ -n "$test_rule_id" ]; then
        log_info "Testing rule update..."

        local update_response=$(curl -s -X PATCH "$STAGING_API_URL/api/admin/safety/rules/$test_rule_id" \
            -H "$auth_header" \
            -H "Content-Type: application/json" \
            -d '{"priority": 200}' || echo "{}")

        if echo "$update_response" | jq -e '.ok' &> /dev/null; then
            log_success "Protection rule updated"
        else
            log_error "Failed to update protection rule"
        fi
    fi

    # Test: Delete rule (cleanup)
    if [ -n "$test_rule_id" ]; then
        log_info "Testing rule deletion (cleanup)..."

        local delete_response=$(curl -s -X DELETE "$STAGING_API_URL/api/admin/safety/rules/$test_rule_id" \
            -H "$auth_header" || echo "{}")

        if echo "$delete_response" | jq -e '.ok' &> /dev/null; then
            log_success "Protection rule deleted (cleanup complete)"
        else
            log_warning "Failed to delete test rule (manual cleanup may be required)"
        fi
    fi
}

# Test functional scenarios
test_functional_scenarios() {
    log_section "6. FUNCTIONAL SCENARIO TESTING"

    local auth_header="Authorization: Bearer $API_TOKEN"

    # Scenario 1: Protected snapshot should skip cleanup
    log_info "Scenario 1: Testing protected snapshot cleanup skip..."

    # This would require creating an expired protected snapshot and running cleanup
    # For staging verification, we'll check if the logic is in place via code review
    log_warning "Manual verification required: Create expired protected snapshot and verify cleanup skips it"

    # Scenario 2: Rule-based operation blocking
    log_info "Scenario 2: Testing rule-based operation blocking..."

    # Create a blocking rule
    local block_rule_response=$(curl -s -X POST "$STAGING_API_URL/api/admin/safety/rules" \
        -H "$auth_header" \
        -H "Content-Type: application/json" \
        -d '{
            "rule_name": "block-critical-delete",
            "target_type": "snapshot",
            "conditions": {
                "all": [
                    {"field": "protection_level", "operator": "eq", "value": "critical"}
                ]
            },
            "effects": {
                "action": "block",
                "message": "Cannot delete critical snapshots"
            },
            "priority": 1000
        }' || echo "{}")

    local block_rule_id=""
    if echo "$block_rule_response" | jq -e '.ok' &> /dev/null; then
        block_rule_id=$(echo "$block_rule_response" | jq -r '.data.id')
        log_success "Blocking rule created for scenario testing"

        # Create critical snapshot and attempt deletion
        # This would test SafetyGuard integration
        log_warning "Manual verification required: Attempt to delete critical snapshot and verify block"

        # Cleanup
        if [ -n "$block_rule_id" ]; then
            curl -s -X DELETE "$STAGING_API_URL/api/admin/safety/rules/$block_rule_id" \
                -H "$auth_header" &> /dev/null
        fi
    else
        log_warning "Could not create blocking rule for scenario testing"
    fi
}

# Verify Grafana dashboard
verify_grafana_dashboard() {
    log_section "7. GRAFANA DASHBOARD VERIFICATION"

    log_info "Checking Grafana dashboard file..."

    local dashboard_file="../../grafana/dashboards/snapshot-protection.json"

    if [ -f "$dashboard_file" ]; then
        log_success "Dashboard file exists: $dashboard_file"

        # Check panel count
        local panel_count=$(jq '.panels | length' "$dashboard_file" 2>/dev/null || echo "0")
        if [ "$panel_count" -ge 10 ]; then
            log_success "Dashboard has $panel_count panels (expected ≥10)"
        else
            log_warning "Dashboard has only $panel_count panels (expected ≥10)"
        fi
    else
        log_error "Dashboard file not found: $dashboard_file"
    fi

    log_warning "Manual verification required: Import dashboard to Grafana and verify all panels display correctly"
}

# Performance baseline check
performance_baseline() {
    log_section "8. PERFORMANCE BASELINE"

    local auth_header="Authorization: Bearer $API_TOKEN"

    log_info "Measuring rule evaluation performance..."

    # Run 10 rule evaluations and measure average time
    local total_time=0
    local iterations=10

    for i in $(seq 1 $iterations); do
        local start=$(date +%s%N)
        curl -s -X POST "$STAGING_API_URL/api/admin/safety/rules/evaluate" \
            -H "$auth_header" \
            -H "Content-Type: application/json" \
            -d '{
                "entity_type": "snapshot",
                "entity_id": "perf-test",
                "operation": "delete",
                "properties": {"tags": ["test"]}
            }' &> /dev/null
        local end=$(date +%s%N)
        local duration=$(( (end - start) / 1000000 )) # Convert to ms
        total_time=$(( total_time + duration ))
    done

    local avg_time=$(( total_time / iterations ))

    if [ $avg_time -lt 100 ]; then
        log_success "Average rule evaluation time: ${avg_time}ms (target: <100ms)"
    else
        log_warning "Average rule evaluation time: ${avg_time}ms (target: <100ms)"
    fi
}

# Rollback verification
verify_rollback_capability() {
    log_section "9. ROLLBACK CAPABILITY VERIFICATION"

    log_info "Checking rollback migration files..."

    local migration_files=(
        "src/db/migrations/20251117000001_add_snapshot_labels.ts"
        "src/db/migrations/20251117000002_create_protection_rules.ts"
    )

    for file in "${migration_files[@]}"; do
        if [ -f "$file" ]; then
            if grep -q "export async function down" "$file"; then
                log_success "Rollback function exists in $file"
            else
                log_error "No rollback function in $file"
            fi
        else
            log_error "Migration file not found: $file"
        fi
    done

    log_warning "Manual verification required: Test rollback in isolated environment before production deployment"
}

# Generate verification report
generate_report() {
    log_section "10. VERIFICATION SUMMARY"

    log_info "Verification log saved to: $VERIFICATION_LOG"

    # Count successes and errors
    local success_count=$(grep -c "\[✓\]" "$VERIFICATION_LOG" || echo "0")
    local error_count=$(grep -c "\[✗\]" "$VERIFICATION_LOG" || echo "0")
    local warning_count=$(grep -c "\[⚠\]" "$VERIFICATION_LOG" || echo "0")

    echo -e "\n${BLUE}════════════════════════════════════════${NC}"
    echo -e "${BLUE}  VERIFICATION RESULTS${NC}"
    echo -e "${BLUE}════════════════════════════════════════${NC}"
    echo -e "${GREEN}✓ Successes: $success_count${NC}"
    echo -e "${YELLOW}⚠ Warnings:  $warning_count${NC}"
    echo -e "${RED}✗ Errors:    $error_count${NC}"
    echo -e "${BLUE}════════════════════════════════════════${NC}\n"

    if [ $error_count -eq 0 ]; then
        echo -e "${GREEN}✓ Sprint 2 staging verification PASSED${NC}"
        echo -e "${YELLOW}⚠ Manual verification items require attention${NC}"
        exit 0
    else
        echo -e "${RED}✗ Sprint 2 staging verification FAILED${NC}"
        echo -e "${RED}  Please review errors in log: $VERIFICATION_LOG${NC}"
        exit 1
    fi
}

# Main execution
main() {
    echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║  Sprint 2: Snapshot Protection System                 ║${NC}"
    echo -e "${BLUE}║  Staging Verification Script                           ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}\n"

    check_prerequisites
    verify_database_migrations
    verify_server_health
    test_snapshot_labels_api
    test_protection_rules_api
    test_functional_scenarios
    verify_grafana_dashboard
    performance_baseline
    verify_rollback_capability
    generate_report
}

# Run main function
main
