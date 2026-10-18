# Multitable package SQL history: repair and verification

Source repair: `65511bce62fc4a64ede86141110ab98837cb300c`, based on immutable Meta source `519184d6414c0eededb9fde1b55fe211d7ce8e54`. This is a separate Draft candidate. No migration, frozen manifest, baseline or production configuration was changed.

## Failure and minimal repair

The actual compiled migration provider exposed459 names from the verified source-process bundle but457 from the existing on-prem package. The packager omitted `packages/core-backend/src/db/migrations`, losing `20250925_create_view_tables` and `20250926_create_audit_tables`. Though superseded/no-op, their identities remain necessary to validate existing Kysely histories.

An owned PostgreSQL15.17 database completed the real source migration (exit0); running the real unpacked package migration against it failed (exit1) on the missing history input. This is an actual upgrade failure, not just a file-list hypothesis. The one-line repair copies the existing source migration directory through the existing packager. SQL/provider/history bytes and semantics are unchanged.

## Verification

The original package suite passed15tests, zero skips. Both final TGZ and ZIP candidates passed the original unmodified package verifier, including its S6-A runtime pin checks. PowerShell ZipFile ran on macOS; native Windows is not claimed.

With the corrected packaged SQL assets, the real source-to-package upgrade and a fresh package database both migrated successfully. All459 history names matched source. Upgrade left the schema and migration history unchanged; fresh schema also exactly matched source. Both owned PostgreSQL controls stopped and removed their resources. Production dependencies for the migration control were installed offline with frozen lock/pnpm9.15.9:452reused/0downloads/no ignore-scripts. The final source restores the frozen verifier; all1807 packaged backend/migration runtime files are byte-identical to that actual green migration run. The intermediate verifier-edited candidate and its failed archive verdicts are preserved separately.

## Frozen evidence boundary

Independent repository-wide S6-A verification still refuses this candidate: the frozen evidence manifest pins the entire package-builder script, whose hash necessarily changes with the one-line repair. The frozen runtime verifier and all historical pins remain unchanged. Do not refresh the frozen manifest, bypass this refusal or present runtime-archive verification as repository-wide S6-A acceptance. This Draft remains HOLD for that distinct provenance disposition; other PLM engineering continues. The original intermediate patch and exact mismatch receipt are retained.

Compact evidence: `plm-onprem-package-sql-history-20261018/verification.json`. Private migration logs and databases are excluded. Actual backend/browser/service-manager installation and the full Yuantus–MetaSheet window remain incomplete. Keep Draft; no merge, deployment, production enablement, real business notification or issue closure.
