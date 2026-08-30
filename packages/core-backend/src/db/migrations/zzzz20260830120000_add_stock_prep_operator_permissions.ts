import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * O2 / R-11 stock-preparation confirmation-queue operator permission seed.
 *
 * Codes: stockprep:read | stockprep:confirm.
 *
 * These are the two codes the `/stock-prep` confirmation-queue workbench gates on, on BOTH sides:
 * the plugin routes (`hasStockPrepPermission` in
 * plugins/plugin-integration-core/lib/http-routes.cjs) and the web route guard + per-control
 * rendering. Before O2 every confirmation-decision route was admin-only while the page admitted an
 * `integration:write` holder, so the workbench looked clickable and 403'd on click; these codes are
 * what a CUSTOMER operator holds instead of plugin-wide admin.
 *
 * `stockprep:read` is the admission ticket (values-free queue, readiness). `stockprep:confirm` is
 * additive on top of it and carries the value-entry read plus the confirm write — it is NOT honored
 * without the read grant, so the server and the router agree for every principal in both directions.
 * There is deliberately no `stockprep:admin`: reconcile and ledger provisioning stay on the existing
 * platform admin gate rather than getting a third code that would look operator-shaped.
 *
 * Shape copied from zzzz20260824121000_add_elearning_permissions (itself copied from
 * zzzz20260117090000): DO $$ + table-existence guard + ON CONFLICT DO NOTHING, so it is a no-op on a
 * tree without RBAC tables and re-runnable.
 *
 * down() removes only this domain's rows.
 */

export const STOCK_PREP_PERMISSION_CODES = [
  'stockprep:read',
  'stockprep:confirm',
] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'permissions'
      ) THEN
        INSERT INTO permissions (code, name, description)
        VALUES
          ('stockprep:read', 'Stock Prep Read', 'Read the stock-preparation confirmation queue (values-free)'),
          ('stockprep:confirm', 'Stock Prep Confirm', 'Confirm stock-preparation decisions and read own value entry')
        ON CONFLICT (code) DO NOTHING;
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'role_permissions'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'permissions'
      ) THEN
        INSERT INTO role_permissions (role_id, permission_code)
        VALUES
          ('admin', 'stockprep:read'),
          ('admin', 'stockprep:confirm')
        ON CONFLICT DO NOTHING;
      END IF;
    END $$;
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'role_permissions'
      ) THEN
        DELETE FROM role_permissions
        WHERE permission_code IN (
          'stockprep:read',
          'stockprep:confirm'
        );
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'permissions'
      ) THEN
        DELETE FROM permissions
        WHERE code IN (
          'stockprep:read',
          'stockprep:confirm'
        );
      END IF;
    END $$;
  `.execute(db)
}
