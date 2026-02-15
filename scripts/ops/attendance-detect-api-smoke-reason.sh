#!/usr/bin/env bash
set -euo pipefail

log_path="${1:-}"
if [[ -z "$log_path" ]]; then
  echo "Usage: $0 <gate-api-smoke.log>" >&2
  exit 2
fi

if [[ ! -f "$log_path" ]]; then
  echo "LOG_MISSING"
  exit 0
fi

# Keep reason codes as UPPERCASE_UNDERSCORES (safe to embed in JSON without escaping).

if grep -qE 'HTTP (401|403) ' "$log_path"; then
  echo "AUTH_FAILED"
  exit 0
fi
if grep -qE 'HTTP 429 |RATE_LIMITED' "$log_path"; then
  echo "RATE_LIMITED"
  exit 0
fi
if grep -qE 'features\\.mode expected' "$log_path"; then
  echo "PRODUCT_MODE_MISMATCH"
  exit 0
fi
if grep -qE 'features\\.attendance is not true' "$log_path"; then
  echo "FEATURE_DISABLED"
  exit 0
fi

# attendance-admin surface: distinguish "missing endpoint" from "schema/runtime failure".
if grep -qE 'attendance-admin API missing \(404\)' "$log_path"; then
  echo "ADMIN_API_MISSING"
  exit 0
fi
if grep -qE 'attendance-admin batch resolve API missing \(404\)' "$log_path"; then
  echo "ADMIN_BATCH_RESOLVE_MISSING"
  exit 0
fi

# Audit log gates: export.csv and summary.
if grep -qE 'attendance-admin audit log export missing \(404\)' "$log_path"; then
  echo "AUDIT_EXPORT_MISSING"
  exit 0
fi
if grep -qE 'attendance-admin audit log summary missing \(404\)' "$log_path"; then
  echo "AUDIT_SUMMARY_MISSING"
  exit 0
fi
if grep -qE 'AUDIT_LOGS_EXPORT_FAILED' "$log_path"; then
  if grep -qiE 'occurred_at' "$log_path"; then
    echo "AUDIT_EXPORT_SCHEMA_MISSING"
    exit 0
  fi
  echo "AUDIT_EXPORT_FAILED"
  exit 0
fi
if grep -qE 'GET /attendance-admin/audit-logs/export\\.csv failed: ' "$log_path"; then
  echo "AUDIT_EXPORT_FAILED"
  exit 0
fi
if grep -qE 'audit export CSV missing expected headers' "$log_path"; then
  echo "AUDIT_EXPORT_BAD_HEADERS"
  exit 0
fi
if grep -qE 'GET /attendance-admin/audit-logs/summary' "$log_path" && grep -qE 'HTTP [45][0-9]{2} ' "$log_path"; then
  echo "AUDIT_SUMMARY_FAILED"
  exit 0
fi
if grep -qE 'audit summary response missing (actions|errors)' "$log_path"; then
  echo "AUDIT_SUMMARY_BAD_RESPONSE"
  exit 0
fi

# Other admin surface failures.
if grep -qE 'role templates missing' "$log_path"; then
  echo "ADMIN_ROLE_TEMPLATES_MISSING"
  exit 0
fi
if grep -qE 'user search response missing items' "$log_path"; then
  echo "ADMIN_USER_SEARCH_BROKEN"
  exit 0
fi

# Import upload channel failures.
if grep -qE 'import upload did not return fileId' "$log_path"; then
  echo "IMPORT_UPLOAD_FAILED"
  exit 0
fi
if grep -qE 'POST /attendance/import/upload' "$log_path"; then
  echo "IMPORT_UPLOAD_FAILED"
  exit 0
fi

# Import export channel failures.
if grep -qE 'export endpoint missing \(404\)' "$log_path"; then
  echo "IMPORT_EXPORT_MISSING"
  exit 0
fi
if grep -qE 'export CSV missing expected headers' "$log_path"; then
  echo "IMPORT_EXPORT_BAD_HEADERS"
  exit 0
fi

if grep -qE 'plugin-attendance is not active' "$log_path"; then
  echo "PLUGIN_INACTIVE"
  exit 0
fi

if grep -qE 'import job timed out' "$log_path"; then
  echo "IMPORT_ASYNC_TIMEOUT"
  exit 0
fi
if grep -qE 'import job failed' "$log_path"; then
  echo "IMPORT_ASYNC_FAILED"
  exit 0
fi
if grep -qE 'commit did not succeed|Import commit did not succeed' "$log_path"; then
  echo "IMPORT_COMMIT_FAILED"
  exit 0
fi

echo "UNKNOWN"
