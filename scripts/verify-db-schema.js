#!/usr/bin/env node
/**
 * Database Schema Verification Script
 *
 * Purpose: Verify database schema consistency after observability merge
 * Usage: DATABASE_URL='postgresql://...' node scripts/verify-db-schema.js
 *
 * Checks:
 * 1. RBAC tables existence and structure
 * 2. Approval tables presence
 * 3. Foreign key integrity
 * 4. Index health
 * 5. Recent data sanity
 */

const { Pool } = require('pg');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m'
};

function log(level, message) {
  const timestamp = new Date().toISOString();
  const prefix = {
    INFO: `${colors.green}[INFO]${colors.reset}`,
    ERROR: `${colors.red}[ERROR]${colors.reset}`,
    WARN: `${colors.yellow}[WARN]${colors.reset}`,
    DEBUG: `${colors.blue}[DEBUG]${colors.reset}`
  }[level] || '[LOG]';

  console.log(`${prefix} ${timestamp} - ${message}`);
}

// Verification results
const results = {
  passed: 0,
  failed: 0,
  warnings: 0,
  checks: []
};

function recordCheck(name, passed, message, severity = 'error') {
  results.checks.push({ name, passed, message, severity });
  if (passed) {
    results.passed++;
    log('INFO', `✅ ${name}: ${message}`);
  } else if (severity === 'warning') {
    results.warnings++;
    log('WARN', `⚠️  ${name}: ${message}`);
  } else {
    results.failed++;
    log('ERROR', `❌ ${name}: ${message}`);
  }
}

async function main() {
  // Check DATABASE_URL
  if (!process.env.DATABASE_URL) {
    log('ERROR', 'DATABASE_URL environment variable not set');
    log('INFO', 'Usage: DATABASE_URL=postgresql://... node scripts/verify-db-schema.js');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000
  });

  try {
    log('INFO', 'Starting database schema verification...');
    console.log('');

    // ==================================================================
    // Check 1: Database connection
    // ==================================================================
    try {
      const result = await pool.query('SELECT NOW() as current_time');
      recordCheck(
        'Database Connection',
        true,
        `Connected successfully (${result.rows[0].current_time})`
      );
    } catch (err) {
      recordCheck('Database Connection', false, err.message);
      throw err; // Exit early if can't connect
    }

    // ==================================================================
    // Check 2: RBAC tables existence
    // ==================================================================
    const rbacTables = ['roles', 'permissions', 'user_roles'];
    const tableCheckQuery = `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema='public'
      AND table_name = ANY($1::text[])
    `;

    const { rows: existingTables } = await pool.query(tableCheckQuery, [rbacTables]);
    const foundTableNames = existingTables.map(r => r.table_name);

    rbacTables.forEach(tableName => {
      const exists = foundTableNames.includes(tableName);
      recordCheck(
        `RBAC Table: ${tableName}`,
        exists,
        exists ? 'Table exists' : 'Table missing',
        exists ? 'info' : 'error'
      );
    });

    // ==================================================================
    // Check 3: Approval tables
    // ==================================================================
    const approvalTables = ['approvals', 'approval_actions'];
    const { rows: approvalTablesCheck } = await pool.query(tableCheckQuery, [approvalTables]);
    const foundApprovalTables = approvalTablesCheck.map(r => r.table_name);

    approvalTables.forEach(tableName => {
      const exists = foundApprovalTables.includes(tableName);
      recordCheck(
        `Approval Table: ${tableName}`,
        exists,
        exists ? 'Table exists' : 'Table missing (may be in legacy schema)',
        exists ? 'info' : 'warning'
      );
    });

    // ==================================================================
    // Check 4: Recent data sanity
    // ==================================================================
    if (foundApprovalTables.includes('approvals')) {
      const { rows: recentApprovals } = await pool.query(`
        SELECT COUNT(*) as count
        FROM approvals
        WHERE created_at > NOW() - INTERVAL '1 hour'
      `);

      const count = parseInt(recentApprovals[0].count);
      recordCheck(
        'Recent Approvals',
        true,
        `${count} approvals in last hour`,
        count === 0 ? 'warning' : 'info'
      );
    }

    // ==================================================================
    // Check 5: Foreign key integrity
    // ==================================================================
    if (foundTableNames.includes('user_roles')) {
      const { rows: fkCheck } = await pool.query(`
        SELECT
          tc.constraint_name,
          tc.table_name,
          kcu.column_name,
          ccu.table_name AS foreign_table_name,
          ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = 'user_roles'
      `);

      recordCheck(
        'Foreign Keys: user_roles',
        fkCheck.length > 0,
        `${fkCheck.length} foreign key constraint(s) found`,
        fkCheck.length === 0 ? 'warning' : 'info'
      );

      if (fkCheck.length > 0) {
        fkCheck.forEach(fk => {
          log('DEBUG', `  FK: ${fk.column_name} -> ${fk.foreign_table_name}.${fk.foreign_column_name}`);
        });
      }
    }

    // ==================================================================
    // Check 6: Index health on critical tables
    // ==================================================================
    if (foundApprovalTables.includes('approvals')) {
      const { rows: indexes } = await pool.query(`
        SELECT
          indexname,
          indexdef
        FROM pg_indexes
        WHERE tablename = 'approvals'
      `);

      recordCheck(
        'Indexes: approvals',
        indexes.length > 0,
        `${indexes.length} index(es) found`,
        indexes.length === 0 ? 'warning' : 'info'
      );

      if (indexes.length > 0) {
        indexes.forEach(idx => {
          log('DEBUG', `  Index: ${idx.indexname}`);
        });
      }
    }

    // ==================================================================
    // Check 7: Migration tracking
    // ==================================================================
    const { rows: migrationTable } = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'knex_migrations'
      ) as exists
    `);

    if (migrationTable[0].exists) {
      const { rows: migrations } = await pool.query(`
        SELECT name, migration_time
        FROM knex_migrations
        ORDER BY migration_time DESC
        LIMIT 5
      `);

      recordCheck(
        'Migration Tracking',
        migrations.length > 0,
        `Last migration: ${migrations[0]?.name || 'N/A'}`,
        'info'
      );

      if (migrations.length > 0) {
        log('DEBUG', '  Recent migrations:');
        migrations.forEach(m => {
          log('DEBUG', `    - ${m.name} (${m.migration_time})`);
        });
      }
    } else {
      recordCheck(
        'Migration Tracking',
        false,
        'knex_migrations table not found (using different migration system?)',
        'warning'
      );
    }

    // ==================================================================
    // Summary
    // ==================================================================
    console.log('');
    log('INFO', '='.repeat(60));
    log('INFO', 'VERIFICATION SUMMARY');
    log('INFO', '='.repeat(60));
    log('INFO', `✅ Passed:   ${results.passed}`);
    log('WARN', `⚠️  Warnings: ${results.warnings}`);
    log('ERROR', `❌ Failed:   ${results.failed}`);
    log('INFO', '='.repeat(60));
    console.log('');

    // Determine exit code
    if (results.failed > 0) {
      log('ERROR', 'Schema verification FAILED. Manual review required.');
      process.exit(1);
    } else if (results.warnings > 0) {
      log('WARN', 'Schema verification passed with WARNINGS. Review recommended.');
      process.exit(0);
    } else {
      log('INFO', '✅ Schema verification PASSED. All checks successful.');
      process.exit(0);
    }

  } catch (error) {
    log('ERROR', `Verification failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Execute if run directly
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { main };
