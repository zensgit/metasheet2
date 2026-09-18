MetaSheet stock-preparation bounded-candidate discovery sidecar
===============================================================

Purpose
-------
Run one discovery-only probe on the Windows entity machine while the stock-preparation flag is OFF.
The probe compares:

1. one source-free bound-limit parameter control on the source connection;
2. one values-free schema-only column type classification on that same opened connection;
3. one parameterized COUNT_BIG query over at most `limit + 1` matches from the same configured
   source and predicate, only when the type relation is DIRECT_CLASS; and
4. one allowlisted equality-filter query through the running readonly bridge, only after the count
   statement passes.

It does not deploy or restart anything, mutate the bridge config, enable a feature flag, write to
the source, or produce acceptance evidence. A POSSIBLE result only permits preparation of a new
approved config followed by the normal flag-OFF preflight.

The count is deliberately capped at `limit + 1`. That is sufficient to distinguish a short scope
from a full/over-limit scope without counting an arbitrarily large matching set.

The v5 diagnostic contract preserves the v4 source-count path (credential, connection, source-free
bound-limit control, real same-predicate count, and result stages) and inserts a closed type-class
gate after a control PASS. The metadata step reuses the already-open connection and runs only the
internally generated query `SELECT TOP (0) [filterField] FROM [source]` with
CommandBehavior.SchemaOnly. It consumes only FieldCount and GetDataTypeName; it never reads rows
or row values, never queries sys.columns/OBJECT_ID, and never emits the exact driver type name.
The exact driver type name is mapped in-process to one closed class:

  TEXT, INTEGER, BOOLEAN, GUID, DATE_TIME, DECIMAL, BINARY, or OTHER.

The relation field is one of DIRECT_CLASS, CROSS_CLASS, UNKNOWN, or NOT_RUN. DIRECT_CLASS is only
STRING+TEXT, INT64+INTEGER, or BOOLEAN+BOOLEAN. DIRECT_CLASS permits the unchanged real count SQL.
CROSS_CLASS and UNKNOWN fail closed before the real count. CROSS_CLASS is not claimed as a proven
config error; DIRECT_CLASS is not claimed as a proven implementation defect. Raw error numbers,
driver messages, SQL text, endpoints, object/field names, credentials, and exact type names are
discarded. A control PASS does not exonerate the filter value or its type; it only isolates the
bound-limit binding path from the predicate/source path for PARAMETER_OR_TYPE failures.

Required private inputs
-----------------------
- Path to the bridge's existing config JSON.
- Existing allowlisted object id.
- Existing allowlisted filter field.
- One business-valid filter value.
- Filter value type: STRING, INT64, or BOOLEAN.

Keep all of those concrete values in the private operator channel. Do not post them to GitHub.

Before the one permitted run
----------------------------
1. Download the exact-SHA ZIP and matching .zip.sha256 from the authorized workflow run.
2. Verify the ZIP:

   Get-FileHash -LiteralPath .\<downloaded-zip>.zip -Algorithm SHA256

   The lowercase digest must equal the value in <downloaded-zip>.zip.sha256.
3. Extract the ZIP to a new local directory.
4. From that directory, verify every packaged file against SHA256SUMS.
5. Confirm the #4628 authorization names this exact sourceGitCommit and package ZIP SHA-256.
6. Confirm the existing bridge is healthy and the concrete object/filter are already allowlisted.
7. Do not edit the bridge config or an approved config for this probe.
8. Confirm the bridge uses SQL authentication (`database.integratedSecurity=false`) and that this
   shell inherits the same configured username/password environment variables as the bridge
   service. Integrated Security is rejected because the operator and service identities cannot be
   proven equal by the current bridge protocol.

One-shot invocation
-------------------
Set the private filter value only in a temporary process environment variable whose name begins
with METASHEET_DISCOVERY_FILTER_. Use the hidden prompt and parent-process cleanup below; a child
process cannot remove an environment value from its parent shell.

Example shape only; replace all angle-bracket placeholders locally:

  $carrier = 'METASHEET_DISCOVERY_FILTER_ONCE'
  $secureValue = Read-Host -AsSecureString 'Private filter value'
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
  try {
    $plainValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    [Environment]::SetEnvironmentVariable($carrier, $plainValue, 'Process')
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
      .\stock-preparation-bounded-candidate-probe.ps1 `
      -ConfigPath '<private-bridge-config-path>' `
      -ObjectId '<private-allowlisted-object-id>' `
      -FilterField '<private-allowlisted-filter-field>' `
      -FilterValueType STRING `
      -FilterValueEnvVar $carrier
    $probeExit = $LASTEXITCODE
  } finally {
    [Environment]::SetEnvironmentVariable($carrier, $null, 'Process')
    $plainValue = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  if ($probeExit -ne 0) { throw 'Discovery probe blocked; stop and do not retry.' }

Run the command once. On any failure, stop and do not retry without a new maintainer authorization.

Public result
-------------
Only the fixed STOCK_PREPARATION_BOUNDED_DISCOVERY block may be posted publicly. It contains no
object, field, predicate, count, host, source, path, row, credential, driver error text, or exact
SQL type name.

Interpretation:
- boundedCandidateSignal=POSSIBLE:
  a non-empty filtered page was shorter than the verified bridge limit and matched the private
  same-predicate count. Prepare a new approved config, then run flag-OFF preflight.
- boundedCandidateSignal=EMPTY:
  the predicate returned no rows. It is not a usable acceptance candidate.
- boundedCandidateSignal=NOT_BOUNDED:
  the private count was equal to or greater than the verified bridge limit. Do not use this scope.
- failureReason=SOURCE_CREDENTIAL_UNAVAILABLE:
  the configured SQL-auth username or password environment value was absent in this parent process;
  no source connection, bound-limit control, metadata read, or count statement was attempted.
- failureReason=SOURCE_CONNECTION_FAILED:
  credential environment values were present, but the source connection could not be opened; no
  bound-limit control, metadata read, or count statement was attempted.
- failureReason=SOURCE_BOUND_LIMIT_CONTROL_FAILED:
  the source connection opened, but the source-free bound-limit control statement did not complete.
  sourceBoundLimitControlFailureClass reports exactly one values-free class (same closed set as
  sourceCountFailureClass). PARAMETER_OR_TYPE and SYNTAX_OR_DIALECT map
  sourceParameterFailureRole=BOUND_LIMIT; other control classes map UNDETERMINED. Metadata, real
  count, and bridge query are not attempted; the connection is still closed.
- failureReason=SOURCE_BOUND_LIMIT_CONTROL_RESULT_INVALID:
  the bound-limit control completed but did not return exactly INT64 1. Role is UNDETERMINED;
  metadata, real count, and bridge query are not attempted.
- failureReason=SOURCE_COLUMN_METADATA_FAILED:
  control passed, but the schema-only column metadata read did not complete.
  sourceColumnMetadataFailureClass reports one values-free class from the same closed set used by
  source-count failures. sourceTypeRelation=UNKNOWN. The real count and bridge query are not
  attempted.
- failureReason=SOURCE_COLUMN_METADATA_RESULT_INVALID:
  the metadata command completed but did not yield exactly one usable column type name.
  sourceTypeRelation=UNKNOWN. The real count and bridge query are not attempted.
- failureReason=SOURCE_TYPE_RELATION_CROSS_CLASS:
  metadata passed and mapped to a known closed source class that is not the direct pair for the
  requested probe type. sourceTypeRelation=CROSS_CLASS. This is a values-free diagnostic gate, not
  a proven config error. The real count and bridge query are not attempted.
- failureReason=SOURCE_TYPE_RELATION_UNKNOWN:
  metadata passed but the source class could not be related as DIRECT_CLASS or CROSS_CLASS
  (sourceColumnTypeClass=OTHER). The real count and bridge query are not attempted.
- failureReason=SOURCE_COUNT_STATEMENT_FAILED:
  control and DIRECT_CLASS metadata passed, but the real bounded count statement did not complete.
  sourceCountFailureClass reports exactly one values-free class:
  SELECT_PERMISSION, OBJECT_OR_COLUMN_RESOLUTION, PARAMETER_OR_TYPE, SYNTAX_OR_DIALECT,
  TIMEOUT_OR_RESOURCE, or OTHER. NONE and NOT_RUN are reserved for non-failing tuples.
  If one SQL exception carries multiple classified errors, that displayed order is the frozen
  precedence. When sourceCountFailureClass=PARAMETER_OR_TYPE after a control PASS,
  sourceParameterFailureRole=PREDICATE_OR_SOURCE; other actual classes keep role NONE.
- failureReason=SOURCE_COUNT_RESULT_INVALID:
  the bounded count statement completed but did not return the required non-negative INT64 shape.
- executionState=BLOCKED or boundedCandidateSignal=INCONCLUSIVE:
  stop. Do not retry or enter a flag-ON window.

Limitations
-----------
The bridge page and COUNT_BIG run on separate connections. Their equality is a discovery signal,
not a snapshot-consistency proof. Only the later approved-config preflight can establish the
SHORT_PAGE proof used by the current runtime. Matching credential variable names do not prove that
two separately started processes inherited identical values; operators must verify that private
deployment fact before the authorized run. DIRECT_CLASS only means the closed type pair is in the
current allowlist for attempting the existing count binder. It is not a SQL compatibility proof or
proof that the count will succeed.
