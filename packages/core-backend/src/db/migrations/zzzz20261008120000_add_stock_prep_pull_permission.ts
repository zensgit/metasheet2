import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * S0 of ADR adr-stock-prep-project-sheets-20261008 (addendum A) / decision register R-33 — seed the
 * `stock-prep:pull` permission row.
 *
 * The owner ruled on 2026-10-08 that a floor operator (`stock-prep:read` + `stock-prep:operate`)
 * must no longer pull from PLM; only a holder of the new 「拉取人员」 code may run the pull (dry-run,
 * apply, the large-BOM background channel, reconcile) and, in the slices that follow, create project
 * sheets and archive / restore them. The vocabulary and the decision live in
 * `plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs`
 * (`STOCK_PREP_PULL`, `satisfiesStockPrepAccess`); this migration only makes the code EXIST as a
 * row, for the same reason zzzz20260830100000_add_stock_prep_permissions gives: `role_permissions`
 * and `user_permissions` carry a foreign key to `permissions(code)`, and `PUT /api/roles/:id`
 * refuses a code the catalogue does not hold (400 UNKNOWN_PERMISSION_CODE), so without this row an
 * administrator could not create the 「备料拉取人员」 role at all.
 *
 * Same shape as the 0830 seed, including its ONE deliberate omission: NO `role_permissions` insert.
 * R-11's mapping is 零自动 — the new code starts with ZERO holders. Roles are site data and are not
 * seeded here. THE ORDER ON SITE, stated because the naive one is impossible: the role cannot be
 * created BEFORE this migration (the role editor refuses the code until this row exists), and the
 * gate takes effect on upgrade with no switch. So: upgrade (this migration runs, the gate is live)
 * → immediately create 「备料拉取人员」 (read + operate + pull) in 角色管理 and assign it → grant the
 * account 开通插件使用 for `stock-prep` if it is a new account. In the window between upgrade and
 * role creation only a platform admin, a `stock-prep:admin` or an `integration:*` holder can pull
 * (the scheduled pull on an admin token is unaffected); the floor and the future pullers cannot.
 *
 * ROLLBACK: down() deletes EVERY role/user binding of `stock-prep:pull` (FK order); re-running up()
 * restores the catalogue row only, never the bindings — after a rollback + re-upgrade the
 * 「备料拉取人员」 role must be granted the code again.
 *
 * The row text is byte-identical to the `STOCK_PREP_PULL` descriptor in the plugin module; the
 * plugin permission-matrix suite pins the two against each other. `INSERT INTO permissions (...)
 * VALUES (...)` is the raw form the access-presets catalogue guard
 * (tests/unit/access-presets-permission-catalogue.guard.test.ts) reads back.
 *
 * down() removes only this one code's rows, bindings first (FK order), exactly as the 0830 seed's
 * down() does for its three codes. The three earlier codes are untouched in both directions.
 */

export const STOCK_PREP_PULL_PERMISSION_CODE = 'stock-prep:pull'

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
          ('stock-prep:pull', 'Stock Prep Pull', 'Pull from PLM into the stock-preparation sheet (dry-run, apply, large-BOM background channel, reconcile); in later slices also create project sheets and archive/restore them. The holder must also hold stock-prep:operate and stock-prep:read')
        ON CONFLICT (code) DO NOTHING;
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
        WHERE permission_code = 'stock-prep:pull';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'user_permissions'
      ) THEN
        DELETE FROM user_permissions
        WHERE permission_code = 'stock-prep:pull';
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
        WHERE code = 'stock-prep:pull';
      END IF;
    END $$;
  `.execute(db)
}
