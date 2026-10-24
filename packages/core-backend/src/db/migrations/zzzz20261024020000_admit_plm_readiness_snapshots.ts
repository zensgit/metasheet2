import { sql, type Kysely } from 'kysely'
import {
  ECO_COLLABORATION_ECO_FIELDS,
  ECO_COLLABORATION_LOCAL_FIELDS,
} from '../../multitable/plm-collaboration-snapshot-wire'
import {
  READINESS_COLLABORATION_COVERAGE_STATUS,
  READINESS_COLLABORATION_LOCAL_FIELDS,
  READINESS_COLLABORATION_SOURCE_FIELDS,
} from '../../multitable/plm-collaboration-readiness-wire'

// Forward admission for readonly readiness collaboration on the existing four control tables.
// A database role that can write meta_plm_collaboration_syncs can still forge accepted evidence.
// These guards are a consistency check, not a privilege boundary.
//
// Root inventory correction: the review summary count of five existing function
// replacements is a typo. The inventory is accepted_sync, preview_guard,
// binding_guard, and sync_guard. This migration replaces those four functions
// and the eleven checks (maps plus ten preview/binding id checks) and adds four
// helpers. It leaves every other existing function unchanged. The canonical
// resources renderer stays inside data_ok. Boundary reads use
// pg_catalog.substr(text, int, int). Scalar JSON text uses
// pg_catalog.to_jsonb(text)::text. Objects and arrays stay hand-ordered.
// Shape pins the finite foundation catalog before change and the finite admitted
// catalog after change. Kept bodies use oracle hashes. Replaced and helper bodies
// are the bytes between the existing $fn$ delimiters. Normalization rewrites only
// quote_ident(current_schema()) || '.'. After that qualifier is removed, raw text
// that still contains __PLM_SERVING_SCHEMA__ is refused. A retained row also requires
// its canonical meta_records row on the binding sheet.

const ECO_KEYS = ECO_COLLABORATION_ECO_FIELDS.map((key) => `'${key}'`).join(', ')
const LOCAL_KEYS = ECO_COLLABORATION_LOCAL_FIELDS.map((field) => `'${field.key}'`).join(', ')
const LOCAL_TYPE_CASE = ECO_COLLABORATION_LOCAL_FIELDS
  .map((field) => `WHEN '${field.key}' THEN '${field.type}'`)
  .join('\n            ')
const READINESS_KEYS = READINESS_COLLABORATION_SOURCE_FIELDS.map((key) => `'${key}'`).join(', ')
const READINESS_LOCAL_KEYS = READINESS_COLLABORATION_LOCAL_FIELDS.map((field) => `'${field.key}'`).join(', ')
const REQUEST_BOUNDARY = '9,10,11,12,13,28,29,30,31,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288'
const SCOPE_BOUNDARY = '9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279'
const CONTROL_TABLES = [
  'meta_plm_collaboration_previews',
  'meta_plm_collaboration_bindings',
  'meta_plm_collaboration_rows',
  'meta_plm_collaboration_syncs',
] as const
const SCAN_TABLES = [
  'meta_fields',
  'meta_records',
  'meta_config_revisions',
  'meta_record_revisions',
  'meta_record_version_markers',
  'meta_record_history_operations',
] as const
const HELPERS = [
  ['meta_plm_collaboration_readiness_request_id', 1],
  ['meta_plm_collaboration_readiness_scope_id', 1],
  ['meta_plm_collaboration_readiness_row_key', 5],
  ['meta_plm_collaboration_readiness_data_ok', 4],
] as const
const REPLACED = [
  ['meta_plm_collaboration_accepted_sync', 2],
  ['meta_plm_collaboration_preview_guard', 0],
  ['meta_plm_collaboration_binding_guard', 0],
  ['meta_plm_collaboration_sync_guard', 0],
] as const
const KEPT = [
  ['meta_plm_collaboration_refuse', 2],
  ['meta_plm_collaboration_native_timestamp', 1],
  ['meta_plm_collaboration_eco_row_key', 4],
  ['meta_plm_collaboration_source_value_ok', 4],
  ['meta_plm_collaboration_row_guard', 0],
  ['meta_plm_collaboration_record_guard', 0],
  ['meta_plm_collaboration_field_guard', 0],
  ['meta_plm_collaboration_container_guard', 0],
  ['meta_plm_collaboration_truncate_guard', 0],
  ['meta_plm_collaboration_commit_guard', 0],
] as const
const ID_CHECKS = [
  ['meta_plm_collaboration_bindings', 'datasource', 'data_source_id', 'request', false],
  ['meta_plm_collaboration_bindings', 'tenant', 'native_tenant_id', 'scope', false],
  ['meta_plm_collaboration_bindings', 'org', 'native_org_id', 'scope', false],
  ['meta_plm_collaboration_bindings', 'item', 'item_id', 'request', false],
  ['meta_plm_collaboration_bindings', 'current_version', 'current_version_id', 'request', true],
  ['meta_plm_collaboration_previews', 'datasource', 'data_source_id', 'request', false],
  ['meta_plm_collaboration_previews', 'tenant', 'native_tenant_id', 'scope', false],
  ['meta_plm_collaboration_previews', 'org', 'native_org_id', 'scope', false],
  ['meta_plm_collaboration_previews', 'item', 'item_id', 'request', false],
  ['meta_plm_collaboration_previews', 'current_version', 'current_version_id', 'request', true],
] as const

type AdmissionFunctionPin = {
  cost: number
  kind: string
  name: string
  rows: number
  nargs: number
  config: string[]
  strict: boolean
  language: string
  parallel: string
  arg_modes: string[] | null
  arg_names: string[] | null
  arguments: string
  leakproof: boolean
  volatility: string
  input_types: string[] | null
  return_type: string
  returns_set: boolean
  arg_defaults: null
  all_arg_types: string[] | null
  default_count: number
  security_definer: boolean
  identity_arguments: string
  result_declaration: string
  body: 'kept' | 'replaced' | 'helper'
  body_hash: string | null
}

type AdmissionCheckPin = {
  name: string
  table_name: string
  kind: string
  validated: boolean
  no_inherit: boolean
  deferrable: boolean
  initially_deferred: boolean
  columns: string
  definition: string
}

type AdmissionTriggerPin = {
  name: string
  table_name: string
  type_bits: number
  enabled: string
  internal: boolean
  deferrable: boolean
  initially_deferred: boolean
  argument_count: number
  arguments_hex: string
  update_columns: string
  old_transition_table: string | null
  new_transition_table: string | null
  function_name: string
  function_arguments: string
  when_expression: string | null
  definition: string
}

// Finite pins copied from the foundation inventory 1ebc4830 and the admitted inventory 8e7efcb4.
// Migration runtime does not read those files.
// BEGIN_R3_CATALOG
const ADMISSION_FUNCTIONS: AdmissionFunctionPin[] = [
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_accepted_sync",
    "rows": 1000,
    "nargs": 2,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "plpgsql",
    "parallel": "u",
    "arg_modes": [
      "i",
      "i",
      "t",
      "t"
    ],
    "arg_names": [
      "record_id",
      "binding_id",
      "actor_id",
      "patch"
    ],
    "arguments": "record_id text, binding_id uuid",
    "leakproof": false,
    "volatility": "s",
    "input_types": [
      "text",
      "uuid"
    ],
    "return_type": "record",
    "returns_set": true,
    "arg_defaults": null,
    "all_arg_types": [
      "text",
      "uuid",
      "text",
      "jsonb"
    ],
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "record_id text, binding_id uuid",
    "result_declaration": "TABLE(actor_id text, patch jsonb)",
    "body": "replaced",
    "body_hash": null
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_binding_guard",
    "rows": 0,
    "nargs": 0,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "plpgsql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": null,
    "arguments": "",
    "leakproof": false,
    "volatility": "v",
    "input_types": null,
    "return_type": "trigger",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "",
    "result_declaration": "trigger",
    "body": "replaced",
    "body_hash": null
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_commit_guard",
    "rows": 0,
    "nargs": 0,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "plpgsql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": null,
    "arguments": "",
    "leakproof": false,
    "volatility": "v",
    "input_types": null,
    "return_type": "trigger",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "",
    "result_declaration": "trigger",
    "body": "kept",
    "body_hash": "43a1a7100389d5ff7d0c41807c4e637a07f14e91865c5e781380f655253fe377"
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_container_guard",
    "rows": 0,
    "nargs": 0,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "plpgsql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": null,
    "arguments": "",
    "leakproof": false,
    "volatility": "v",
    "input_types": null,
    "return_type": "trigger",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "",
    "result_declaration": "trigger",
    "body": "kept",
    "body_hash": "911edc828938086f03688e803da71e4bda9ddc7bbf06c9d86ede1151f2226670"
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_eco_row_key",
    "rows": 0,
    "nargs": 4,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "plpgsql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": [
      "row_key",
      "data_source_id",
      "native_tenant_id",
      "native_org_id"
    ],
    "arguments": "row_key jsonb, data_source_id text, native_tenant_id text, native_org_id text",
    "leakproof": false,
    "volatility": "i",
    "input_types": [
      "jsonb",
      "text",
      "text",
      "text"
    ],
    "return_type": "text",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "row_key jsonb, data_source_id text, native_tenant_id text, native_org_id text",
    "result_declaration": "text",
    "body": "kept",
    "body_hash": "b3ad63301d42a879b0efcbe621dfe37b3f5d6fe5d3adfc62e693f7acf478aee2"
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_field_guard",
    "rows": 0,
    "nargs": 0,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "plpgsql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": null,
    "arguments": "",
    "leakproof": false,
    "volatility": "v",
    "input_types": null,
    "return_type": "trigger",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "",
    "result_declaration": "trigger",
    "body": "kept",
    "body_hash": "6d3da88806a23454e6716bdb4aa0621b97a81ddc7e72f8de4953cba83262339b"
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_native_timestamp",
    "rows": 0,
    "nargs": 1,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "plpgsql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": [
      "value"
    ],
    "arguments": "value text",
    "leakproof": false,
    "volatility": "i",
    "input_types": [
      "text"
    ],
    "return_type": "boolean",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "value text",
    "result_declaration": "boolean",
    "body": "kept",
    "body_hash": "8dcbf4f5a412eea51c55c2c040c65f89ae76623765a32fcac22663142e788b5d"
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_preview_guard",
    "rows": 0,
    "nargs": 0,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "plpgsql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": null,
    "arguments": "",
    "leakproof": false,
    "volatility": "v",
    "input_types": null,
    "return_type": "trigger",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "",
    "result_declaration": "trigger",
    "body": "replaced",
    "body_hash": null
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_readiness_data_ok",
    "rows": 0,
    "nargs": 4,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "plpgsql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": [
      "item_id",
      "ruleset_id",
      "source_fields",
      "data"
    ],
    "arguments": "item_id text, ruleset_id text, source_fields jsonb, data jsonb",
    "leakproof": false,
    "volatility": "i",
    "input_types": [
      "text",
      "text",
      "jsonb",
      "jsonb"
    ],
    "return_type": "boolean",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "item_id text, ruleset_id text, source_fields jsonb, data jsonb",
    "result_declaration": "boolean",
    "body": "helper",
    "body_hash": null
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_readiness_request_id",
    "rows": 0,
    "nargs": 1,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "sql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": [
      "value"
    ],
    "arguments": "value text",
    "leakproof": false,
    "volatility": "i",
    "input_types": [
      "text"
    ],
    "return_type": "boolean",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "value text",
    "result_declaration": "boolean",
    "body": "helper",
    "body_hash": null
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_readiness_row_key",
    "rows": 0,
    "nargs": 5,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "plpgsql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": [
      "row_key",
      "data_source_id",
      "native_tenant_id",
      "native_org_id",
      "item_id"
    ],
    "arguments": "row_key jsonb, data_source_id text, native_tenant_id text, native_org_id text, item_id text",
    "leakproof": false,
    "volatility": "i",
    "input_types": [
      "jsonb",
      "text",
      "text",
      "text",
      "text"
    ],
    "return_type": "text",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "row_key jsonb, data_source_id text, native_tenant_id text, native_org_id text, item_id text",
    "result_declaration": "text",
    "body": "helper",
    "body_hash": null
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_readiness_scope_id",
    "rows": 0,
    "nargs": 1,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "sql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": [
      "value"
    ],
    "arguments": "value text",
    "leakproof": false,
    "volatility": "i",
    "input_types": [
      "text"
    ],
    "return_type": "boolean",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "value text",
    "result_declaration": "boolean",
    "body": "helper",
    "body_hash": null
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_record_guard",
    "rows": 0,
    "nargs": 0,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "plpgsql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": null,
    "arguments": "",
    "leakproof": false,
    "volatility": "v",
    "input_types": null,
    "return_type": "trigger",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "",
    "result_declaration": "trigger",
    "body": "kept",
    "body_hash": "f250810d285c735aee19c1c9a07e9c51501628f927d80698d1489b6e00a05a57"
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_refuse",
    "rows": 0,
    "nargs": 2,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "plpgsql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": [
      "constraint_name",
      "message"
    ],
    "arguments": "constraint_name text, message text",
    "leakproof": false,
    "volatility": "v",
    "input_types": [
      "text",
      "text"
    ],
    "return_type": "void",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "constraint_name text, message text",
    "result_declaration": "void",
    "body": "kept",
    "body_hash": "2b8c889558439a8e69c435c7d88e4a06623b78023d97168280ebe802749e3951"
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_row_guard",
    "rows": 0,
    "nargs": 0,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "plpgsql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": null,
    "arguments": "",
    "leakproof": false,
    "volatility": "v",
    "input_types": null,
    "return_type": "trigger",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "",
    "result_declaration": "trigger",
    "body": "kept",
    "body_hash": "6975d4a5078960ce00c89a4b43db4cf4f840ecb1f52b3454403edc6be01ab401"
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_source_value_ok",
    "rows": 0,
    "nargs": 4,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "plpgsql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": [
      "logical_key",
      "item_id",
      "eco_id",
      "value"
    ],
    "arguments": "logical_key text, item_id text, eco_id text, value jsonb",
    "leakproof": false,
    "volatility": "i",
    "input_types": [
      "text",
      "text",
      "text",
      "jsonb"
    ],
    "return_type": "boolean",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "logical_key text, item_id text, eco_id text, value jsonb",
    "result_declaration": "boolean",
    "body": "kept",
    "body_hash": "3869c0ce390b19b77dd8ac4747ba149b82a4f4ab5686a660382151eb06ae8321"
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_sync_guard",
    "rows": 0,
    "nargs": 0,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "plpgsql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": null,
    "arguments": "",
    "leakproof": false,
    "volatility": "v",
    "input_types": null,
    "return_type": "trigger",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "",
    "result_declaration": "trigger",
    "body": "replaced",
    "body_hash": null
  },
  {
    "cost": 100,
    "kind": "f",
    "name": "meta_plm_collaboration_truncate_guard",
    "rows": 0,
    "nargs": 0,
    "config": [
      "search_path=pg_catalog"
    ],
    "strict": false,
    "language": "plpgsql",
    "parallel": "u",
    "arg_modes": null,
    "arg_names": null,
    "arguments": "",
    "leakproof": false,
    "volatility": "v",
    "input_types": null,
    "return_type": "trigger",
    "returns_set": false,
    "arg_defaults": null,
    "all_arg_types": null,
    "default_count": 0,
    "security_definer": false,
    "identity_arguments": "",
    "result_declaration": "trigger",
    "body": "kept",
    "body_hash": "59911e9abe117e8b69bf72efeccfd173b296272b4a8f5c04f361c6b96966b3c7"
  }
]
const FOUNDATION_CHECKS: AdmissionCheckPin[] = [
  {
    "name": "meta_plm_collaboration_bindings_current_version_check",
    "table_name": "meta_plm_collaboration_bindings",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{current_version_id}",
    "definition": "CHECK ((((current_version_id IS NULL) OR (((char_length(current_version_id) >= 1) AND (char_length(current_version_id) <= 128)) AND (current_version_id = btrim(current_version_id)) AND (strpos(current_version_id, chr(10)) = 0) AND (strpos(current_version_id, chr(13)) = 0))) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_bindings_datasource_check",
    "table_name": "meta_plm_collaboration_bindings",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{data_source_id}",
    "definition": "CHECK (((((char_length(data_source_id) >= 1) AND (char_length(data_source_id) <= 128)) AND (data_source_id = btrim(data_source_id)) AND (strpos(data_source_id, chr(10)) = 0) AND (strpos(data_source_id, chr(13)) = 0)) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_bindings_item_check",
    "table_name": "meta_plm_collaboration_bindings",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{item_id}",
    "definition": "CHECK (((((char_length(item_id) >= 1) AND (char_length(item_id) <= 128)) AND (item_id = btrim(item_id)) AND (strpos(item_id, chr(10)) = 0) AND (strpos(item_id, chr(13)) = 0)) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_bindings_maps_check",
    "table_name": "meta_plm_collaboration_bindings",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{source_fields,local_fields,source_kind}",
    "definition": "CHECK ((((jsonb_typeof(source_fields) = 'object'::text) AND (jsonb_typeof(local_fields) = 'object'::text) AND ((source_kind <> 'eco'::text) OR (((source_fields - ARRAY['id'::text, 'name'::text, 'eco_type'::text, 'product_id'::text, 'source_version_id'::text, 'target_version_id'::text, 'stage_id'::text, 'state'::text, 'kanban_state'::text, 'priority'::text, 'updated_at'::text]) = '{}'::jsonb) AND (source_fields ?& ARRAY['id'::text, 'name'::text, 'eco_type'::text, 'product_id'::text, 'source_version_id'::text, 'target_version_id'::text, 'stage_id'::text, 'state'::text, 'kanban_state'::text, 'priority'::text, 'updated_at'::text]) AND ((local_fields - ARRAY['collaboration_owner'::text, 'followup_due_at'::text, 'review_note'::text]) = '{}'::jsonb) AND (local_fields ?& ARRAY['collaboration_owner'::text, 'followup_due_at'::text, 'review_note'::text])))) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_bindings_org_check",
    "table_name": "meta_plm_collaboration_bindings",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{native_org_id}",
    "definition": "CHECK (((((char_length(native_org_id) >= 1) AND (char_length(native_org_id) <= 64)) AND (native_org_id = btrim(native_org_id)) AND (strpos(native_org_id, chr(10)) = 0) AND (strpos(native_org_id, chr(13)) = 0)) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_bindings_tenant_check",
    "table_name": "meta_plm_collaboration_bindings",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{native_tenant_id}",
    "definition": "CHECK (((((char_length(native_tenant_id) >= 1) AND (char_length(native_tenant_id) <= 64)) AND (native_tenant_id = btrim(native_tenant_id)) AND (strpos(native_tenant_id, chr(10)) = 0) AND (strpos(native_tenant_id, chr(13)) = 0)) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_previews_current_version_check",
    "table_name": "meta_plm_collaboration_previews",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{current_version_id}",
    "definition": "CHECK ((((current_version_id IS NULL) OR (((char_length(current_version_id) >= 1) AND (char_length(current_version_id) <= 128)) AND (current_version_id = btrim(current_version_id)) AND (strpos(current_version_id, chr(10)) = 0) AND (strpos(current_version_id, chr(13)) = 0))) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_previews_datasource_check",
    "table_name": "meta_plm_collaboration_previews",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{data_source_id}",
    "definition": "CHECK (((((char_length(data_source_id) >= 1) AND (char_length(data_source_id) <= 128)) AND (data_source_id = btrim(data_source_id)) AND (strpos(data_source_id, chr(10)) = 0) AND (strpos(data_source_id, chr(13)) = 0)) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_previews_item_check",
    "table_name": "meta_plm_collaboration_previews",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{item_id}",
    "definition": "CHECK (((((char_length(item_id) >= 1) AND (char_length(item_id) <= 128)) AND (item_id = btrim(item_id)) AND (strpos(item_id, chr(10)) = 0) AND (strpos(item_id, chr(13)) = 0)) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_previews_org_check",
    "table_name": "meta_plm_collaboration_previews",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{native_org_id}",
    "definition": "CHECK (((((char_length(native_org_id) >= 1) AND (char_length(native_org_id) <= 64)) AND (native_org_id = btrim(native_org_id)) AND (strpos(native_org_id, chr(10)) = 0) AND (strpos(native_org_id, chr(13)) = 0)) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_previews_tenant_check",
    "table_name": "meta_plm_collaboration_previews",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{native_tenant_id}",
    "definition": "CHECK (((((char_length(native_tenant_id) >= 1) AND (char_length(native_tenant_id) <= 64)) AND (native_tenant_id = btrim(native_tenant_id)) AND (strpos(native_tenant_id, chr(10)) = 0) AND (strpos(native_tenant_id, chr(13)) = 0)) IS TRUE))"
  }
]
const ADMITTED_CHECKS: AdmissionCheckPin[] = [
  {
    "name": "meta_plm_collaboration_bindings_current_version_check",
    "table_name": "meta_plm_collaboration_bindings",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{source_kind,current_version_id}",
    "definition": "CHECK (((((source_kind = 'eco'::text) AND ((current_version_id IS NULL) OR (((char_length(current_version_id) >= 1) AND (char_length(current_version_id) <= 128)) AND (current_version_id = btrim(current_version_id)) AND (strpos(current_version_id, chr(10)) = 0) AND (strpos(current_version_id, chr(13)) = 0)))) OR ((source_kind = 'readiness'::text) AND ((current_version_id IS NULL) OR meta_plm_collaboration_readiness_request_id(current_version_id)))) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_bindings_datasource_check",
    "table_name": "meta_plm_collaboration_bindings",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{source_kind,data_source_id}",
    "definition": "CHECK (((((source_kind = 'eco'::text) AND (((char_length(data_source_id) >= 1) AND (char_length(data_source_id) <= 128)) AND (data_source_id = btrim(data_source_id)) AND (strpos(data_source_id, chr(10)) = 0) AND (strpos(data_source_id, chr(13)) = 0))) OR ((source_kind = 'readiness'::text) AND meta_plm_collaboration_readiness_request_id(data_source_id))) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_bindings_item_check",
    "table_name": "meta_plm_collaboration_bindings",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{source_kind,item_id}",
    "definition": "CHECK (((((source_kind = 'eco'::text) AND (((char_length(item_id) >= 1) AND (char_length(item_id) <= 128)) AND (item_id = btrim(item_id)) AND (strpos(item_id, chr(10)) = 0) AND (strpos(item_id, chr(13)) = 0))) OR ((source_kind = 'readiness'::text) AND meta_plm_collaboration_readiness_request_id(item_id))) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_bindings_maps_check",
    "table_name": "meta_plm_collaboration_bindings",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{source_kind,source_fields,local_fields}",
    "definition": "CHECK (((((source_kind = 'eco'::text) AND ((jsonb_typeof(source_fields) = 'object'::text) AND (jsonb_typeof(local_fields) = 'object'::text) AND ((source_kind <> 'eco'::text) OR (((source_fields - ARRAY['id'::text, 'name'::text, 'eco_type'::text, 'product_id'::text, 'source_version_id'::text, 'target_version_id'::text, 'stage_id'::text, 'state'::text, 'kanban_state'::text, 'priority'::text, 'updated_at'::text]) = '{}'::jsonb) AND (source_fields ?& ARRAY['id'::text, 'name'::text, 'eco_type'::text, 'product_id'::text, 'source_version_id'::text, 'target_version_id'::text, 'stage_id'::text, 'state'::text, 'kanban_state'::text, 'priority'::text, 'updated_at'::text]) AND ((local_fields - ARRAY['collaboration_owner'::text, 'followup_due_at'::text, 'review_note'::text]) = '{}'::jsonb) AND (local_fields ?& ARRAY['collaboration_owner'::text, 'followup_due_at'::text, 'review_note'::text]))))) OR ((source_kind = 'readiness'::text) AND (jsonb_typeof(source_fields) = 'object'::text) AND (jsonb_typeof(local_fields) = 'object'::text) AND ((source_fields - ARRAY['item_id'::text, 'ruleset_id'::text, 'generated_at'::text, 'coverage_status'::text, 'resources_count'::text, 'ok_resources'::text, 'error_count'::text, 'warning_count'::text, 'resources'::text]) = '{}'::jsonb) AND (source_fields ?& ARRAY['item_id'::text, 'ruleset_id'::text, 'generated_at'::text, 'coverage_status'::text, 'resources_count'::text, 'ok_resources'::text, 'error_count'::text, 'warning_count'::text, 'resources'::text]) AND ((local_fields - ARRAY['collaboration_owner'::text, 'followup_due_at'::text, 'review_note'::text]) = '{}'::jsonb) AND (local_fields ?& ARRAY['collaboration_owner'::text, 'followup_due_at'::text, 'review_note'::text]) AND (NOT jsonb_path_exists(source_fields, '$.*?(@.type() != \"string\")'::jsonpath)) AND (NOT jsonb_path_exists(local_fields, '$.*?(@.type() != \"string\")'::jsonpath)))) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_bindings_org_check",
    "table_name": "meta_plm_collaboration_bindings",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{source_kind,native_org_id}",
    "definition": "CHECK (((((source_kind = 'eco'::text) AND (((char_length(native_org_id) >= 1) AND (char_length(native_org_id) <= 64)) AND (native_org_id = btrim(native_org_id)) AND (strpos(native_org_id, chr(10)) = 0) AND (strpos(native_org_id, chr(13)) = 0))) OR ((source_kind = 'readiness'::text) AND meta_plm_collaboration_readiness_scope_id(native_org_id))) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_bindings_tenant_check",
    "table_name": "meta_plm_collaboration_bindings",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{source_kind,native_tenant_id}",
    "definition": "CHECK (((((source_kind = 'eco'::text) AND (((char_length(native_tenant_id) >= 1) AND (char_length(native_tenant_id) <= 64)) AND (native_tenant_id = btrim(native_tenant_id)) AND (strpos(native_tenant_id, chr(10)) = 0) AND (strpos(native_tenant_id, chr(13)) = 0))) OR ((source_kind = 'readiness'::text) AND meta_plm_collaboration_readiness_scope_id(native_tenant_id))) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_previews_current_version_check",
    "table_name": "meta_plm_collaboration_previews",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{source_kind,current_version_id}",
    "definition": "CHECK (((((source_kind = 'eco'::text) AND ((current_version_id IS NULL) OR (((char_length(current_version_id) >= 1) AND (char_length(current_version_id) <= 128)) AND (current_version_id = btrim(current_version_id)) AND (strpos(current_version_id, chr(10)) = 0) AND (strpos(current_version_id, chr(13)) = 0)))) OR ((source_kind = 'readiness'::text) AND ((current_version_id IS NULL) OR meta_plm_collaboration_readiness_request_id(current_version_id)))) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_previews_datasource_check",
    "table_name": "meta_plm_collaboration_previews",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{source_kind,data_source_id}",
    "definition": "CHECK (((((source_kind = 'eco'::text) AND (((char_length(data_source_id) >= 1) AND (char_length(data_source_id) <= 128)) AND (data_source_id = btrim(data_source_id)) AND (strpos(data_source_id, chr(10)) = 0) AND (strpos(data_source_id, chr(13)) = 0))) OR ((source_kind = 'readiness'::text) AND meta_plm_collaboration_readiness_request_id(data_source_id))) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_previews_item_check",
    "table_name": "meta_plm_collaboration_previews",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{source_kind,item_id}",
    "definition": "CHECK (((((source_kind = 'eco'::text) AND (((char_length(item_id) >= 1) AND (char_length(item_id) <= 128)) AND (item_id = btrim(item_id)) AND (strpos(item_id, chr(10)) = 0) AND (strpos(item_id, chr(13)) = 0))) OR ((source_kind = 'readiness'::text) AND meta_plm_collaboration_readiness_request_id(item_id))) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_previews_org_check",
    "table_name": "meta_plm_collaboration_previews",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{source_kind,native_org_id}",
    "definition": "CHECK (((((source_kind = 'eco'::text) AND (((char_length(native_org_id) >= 1) AND (char_length(native_org_id) <= 64)) AND (native_org_id = btrim(native_org_id)) AND (strpos(native_org_id, chr(10)) = 0) AND (strpos(native_org_id, chr(13)) = 0))) OR ((source_kind = 'readiness'::text) AND meta_plm_collaboration_readiness_scope_id(native_org_id))) IS TRUE))"
  },
  {
    "name": "meta_plm_collaboration_previews_tenant_check",
    "table_name": "meta_plm_collaboration_previews",
    "kind": "c",
    "validated": true,
    "no_inherit": false,
    "deferrable": false,
    "initially_deferred": false,
    "columns": "{source_kind,native_tenant_id}",
    "definition": "CHECK (((((source_kind = 'eco'::text) AND (((char_length(native_tenant_id) >= 1) AND (char_length(native_tenant_id) <= 64)) AND (native_tenant_id = btrim(native_tenant_id)) AND (strpos(native_tenant_id, chr(10)) = 0) AND (strpos(native_tenant_id, chr(13)) = 0))) OR ((source_kind = 'readiness'::text) AND meta_plm_collaboration_readiness_scope_id(native_tenant_id))) IS TRUE))"
  }
]
const ADMISSION_TRIGGERS: AdmissionTriggerPin[] = [
  {
    "name": "meta_plm_collaboration_bases_guard",
    "table_name": "meta_bases",
    "type_bits": 27,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_container_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_bases_guard BEFORE DELETE OR UPDATE ON __PLM_SERVING_SCHEMA__.meta_bases FOR EACH ROW EXECUTE FUNCTION meta_plm_collaboration_container_guard()"
  },
  {
    "name": "meta_plm_collaboration_bases_truncate",
    "table_name": "meta_bases",
    "type_bits": 34,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_truncate_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_bases_truncate BEFORE TRUNCATE ON __PLM_SERVING_SCHEMA__.meta_bases FOR EACH STATEMENT EXECUTE FUNCTION meta_plm_collaboration_truncate_guard()"
  },
  {
    "name": "meta_plm_collaboration_binding_guard",
    "table_name": "meta_plm_collaboration_bindings",
    "type_bits": 31,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_binding_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_binding_guard BEFORE INSERT OR DELETE OR UPDATE ON __PLM_SERVING_SCHEMA__.meta_plm_collaboration_bindings FOR EACH ROW EXECUTE FUNCTION meta_plm_collaboration_binding_guard()"
  },
  {
    "name": "meta_plm_collaboration_bindings_truncate",
    "table_name": "meta_plm_collaboration_bindings",
    "type_bits": 34,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_truncate_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_bindings_truncate BEFORE TRUNCATE ON __PLM_SERVING_SCHEMA__.meta_plm_collaboration_bindings FOR EACH STATEMENT EXECUTE FUNCTION meta_plm_collaboration_truncate_guard()"
  },
  {
    "name": "meta_plm_collaboration_commit_guard",
    "table_name": "meta_plm_collaboration_rows",
    "type_bits": 21,
    "enabled": "O",
    "internal": false,
    "deferrable": true,
    "initially_deferred": true,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_commit_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE CONSTRAINT TRIGGER meta_plm_collaboration_commit_guard AFTER INSERT OR UPDATE ON __PLM_SERVING_SCHEMA__.meta_plm_collaboration_rows DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meta_plm_collaboration_commit_guard()"
  },
  {
    "name": "meta_plm_collaboration_field_guard",
    "table_name": "meta_fields",
    "type_bits": 31,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_field_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_field_guard BEFORE INSERT OR DELETE OR UPDATE ON __PLM_SERVING_SCHEMA__.meta_fields FOR EACH ROW EXECUTE FUNCTION meta_plm_collaboration_field_guard()"
  },
  {
    "name": "meta_plm_collaboration_fields_truncate",
    "table_name": "meta_fields",
    "type_bits": 34,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_truncate_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_fields_truncate BEFORE TRUNCATE ON __PLM_SERVING_SCHEMA__.meta_fields FOR EACH STATEMENT EXECUTE FUNCTION meta_plm_collaboration_truncate_guard()"
  },
  {
    "name": "meta_plm_collaboration_preview_guard",
    "table_name": "meta_plm_collaboration_previews",
    "type_bits": 31,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_preview_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_preview_guard BEFORE INSERT OR DELETE OR UPDATE ON __PLM_SERVING_SCHEMA__.meta_plm_collaboration_previews FOR EACH ROW EXECUTE FUNCTION meta_plm_collaboration_preview_guard()"
  },
  {
    "name": "meta_plm_collaboration_previews_truncate",
    "table_name": "meta_plm_collaboration_previews",
    "type_bits": 34,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_truncate_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_previews_truncate BEFORE TRUNCATE ON __PLM_SERVING_SCHEMA__.meta_plm_collaboration_previews FOR EACH STATEMENT EXECUTE FUNCTION meta_plm_collaboration_truncate_guard()"
  },
  {
    "name": "meta_plm_collaboration_record_guard",
    "table_name": "meta_records",
    "type_bits": 31,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_record_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_record_guard BEFORE INSERT OR DELETE OR UPDATE ON __PLM_SERVING_SCHEMA__.meta_records FOR EACH ROW EXECUTE FUNCTION meta_plm_collaboration_record_guard()"
  },
  {
    "name": "meta_plm_collaboration_records_truncate",
    "table_name": "meta_records",
    "type_bits": 34,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_truncate_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_records_truncate BEFORE TRUNCATE ON __PLM_SERVING_SCHEMA__.meta_records FOR EACH STATEMENT EXECUTE FUNCTION meta_plm_collaboration_truncate_guard()"
  },
  {
    "name": "meta_plm_collaboration_row_guard",
    "table_name": "meta_plm_collaboration_rows",
    "type_bits": 31,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_row_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_row_guard BEFORE INSERT OR DELETE OR UPDATE ON __PLM_SERVING_SCHEMA__.meta_plm_collaboration_rows FOR EACH ROW EXECUTE FUNCTION meta_plm_collaboration_row_guard()"
  },
  {
    "name": "meta_plm_collaboration_rows_truncate",
    "table_name": "meta_plm_collaboration_rows",
    "type_bits": 34,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_truncate_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_rows_truncate BEFORE TRUNCATE ON __PLM_SERVING_SCHEMA__.meta_plm_collaboration_rows FOR EACH STATEMENT EXECUTE FUNCTION meta_plm_collaboration_truncate_guard()"
  },
  {
    "name": "meta_plm_collaboration_sheets_guard",
    "table_name": "meta_sheets",
    "type_bits": 27,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_container_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_sheets_guard BEFORE DELETE OR UPDATE ON __PLM_SERVING_SCHEMA__.meta_sheets FOR EACH ROW EXECUTE FUNCTION meta_plm_collaboration_container_guard()"
  },
  {
    "name": "meta_plm_collaboration_sheets_truncate",
    "table_name": "meta_sheets",
    "type_bits": 34,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_truncate_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_sheets_truncate BEFORE TRUNCATE ON __PLM_SERVING_SCHEMA__.meta_sheets FOR EACH STATEMENT EXECUTE FUNCTION meta_plm_collaboration_truncate_guard()"
  },
  {
    "name": "meta_plm_collaboration_sync_guard",
    "table_name": "meta_plm_collaboration_syncs",
    "type_bits": 31,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_sync_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_sync_guard BEFORE INSERT OR DELETE OR UPDATE ON __PLM_SERVING_SCHEMA__.meta_plm_collaboration_syncs FOR EACH ROW EXECUTE FUNCTION meta_plm_collaboration_sync_guard()"
  },
  {
    "name": "meta_plm_collaboration_syncs_truncate",
    "table_name": "meta_plm_collaboration_syncs",
    "type_bits": 34,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_truncate_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_syncs_truncate BEFORE TRUNCATE ON __PLM_SERVING_SCHEMA__.meta_plm_collaboration_syncs FOR EACH STATEMENT EXECUTE FUNCTION meta_plm_collaboration_truncate_guard()"
  },
  {
    "name": "meta_plm_collaboration_views_guard",
    "table_name": "meta_views",
    "type_bits": 27,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_container_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_views_guard BEFORE DELETE OR UPDATE ON __PLM_SERVING_SCHEMA__.meta_views FOR EACH ROW EXECUTE FUNCTION meta_plm_collaboration_container_guard()"
  },
  {
    "name": "meta_plm_collaboration_views_truncate",
    "table_name": "meta_views",
    "type_bits": 34,
    "enabled": "O",
    "internal": false,
    "deferrable": false,
    "initially_deferred": false,
    "argument_count": 0,
    "arguments_hex": "",
    "update_columns": "",
    "old_transition_table": null,
    "new_transition_table": null,
    "function_name": "meta_plm_collaboration_truncate_guard",
    "function_arguments": "",
    "when_expression": null,
    "definition": "CREATE TRIGGER meta_plm_collaboration_views_truncate BEFORE TRUNCATE ON __PLM_SERVING_SCHEMA__.meta_views FOR EACH STATEMENT EXECUTE FUNCTION meta_plm_collaboration_truncate_guard()"
  }
]
// END_R3_CATALOG

type ServingSchema = { name: string; ident: string }

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function assertSchemaName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('plm_collaboration_serving_schema_invalid')
  }
}

function legacyId(column: string, max: number): string {
  return `char_length(${column}) BETWEEN 1 AND ${max} AND ${column} = btrim(${column}) AND pg_catalog.strpos(${column}, pg_catalog.chr(10)) = 0 AND pg_catalog.strpos(${column}, pg_catalog.chr(13)) = 0`
}

function helperCall(ident: string, kind: 'request' | 'scope', column: string): string {
  const name = kind === 'request'
    ? 'meta_plm_collaboration_readiness_request_id'
    : 'meta_plm_collaboration_readiness_scope_id'
  return `${ident}.${name}(${column})`
}

function idExpression(ident: string, column: string, kind: 'request' | 'scope', nullable: boolean, admitted: boolean): string {
  const max = kind === 'scope' ? 64 : 128
  const legacy = nullable ? `${column} IS NULL OR (${legacyId(column, max)})` : legacyId(column, max)
  if (!admitted) return `(${legacy}) IS TRUE`
  const readiness = nullable
    ? `${column} IS NULL OR ${helperCall(ident, kind, column)}`
    : helperCall(ident, kind, column)
  return `((source_kind = 'eco' AND (${legacy})) OR (source_kind = 'readiness' AND (${readiness}))) IS TRUE`
}

function oldMaps(): string {
  return `jsonb_typeof(source_fields) = 'object'
      AND jsonb_typeof(local_fields) = 'object'
      AND (
        source_kind <> 'eco'
        OR (
          source_fields - ARRAY[${ECO_KEYS}] = '{}'::jsonb
          AND source_fields ?& ARRAY[${ECO_KEYS}]
          AND local_fields - ARRAY[${LOCAL_KEYS}] = '{}'::jsonb
          AND local_fields ?& ARRAY[${LOCAL_KEYS}]
        )
      )`
}

function mapsExpression(ident: string, admitted: boolean): string {
  if (!admitted) return `(${oldMaps()}) IS TRUE`
  // A CHECK cannot contain jsonb_each (that is a subquery). jsonb_path_exists().type()
  // rejects non-strings without jsonb_each_text coercion. data_ok repeats the walk with jsonb_each.
  const typed = `NOT pg_catalog.jsonb_path_exists(source_fields, '$.* ? (@.type() != "string")'::pg_catalog.jsonpath)
        AND NOT pg_catalog.jsonb_path_exists(local_fields, '$.* ? (@.type() != "string")'::pg_catalog.jsonpath)`
  return `((source_kind = 'eco' AND (${oldMaps()})) OR (source_kind = 'readiness' AND jsonb_typeof(source_fields) = 'object' AND jsonb_typeof(local_fields) = 'object' AND source_fields - ARRAY[${READINESS_KEYS}] = '{}'::jsonb AND source_fields ?& ARRAY[${READINESS_KEYS}] AND local_fields - ARRAY[${READINESS_LOCAL_KEYS}] = '{}'::jsonb AND local_fields ?& ARRAY[${READINESS_LOCAL_KEYS}] AND ${typed})) IS TRUE`
}

function checkStatements(ident: string, admitted: boolean): string[] {
  const maps = `ALTER TABLE ${ident}.meta_plm_collaboration_bindings DROP CONSTRAINT meta_plm_collaboration_bindings_maps_check`
  const addMaps = `ALTER TABLE ${ident}.meta_plm_collaboration_bindings ADD CONSTRAINT meta_plm_collaboration_bindings_maps_check CHECK (${mapsExpression(ident, admitted)})`
  const ids = ID_CHECKS.flatMap(([table, name, column, kind, nullable]) => [
    `ALTER TABLE ${ident}.${table} DROP CONSTRAINT ${table}_${name}_check`,
    `ALTER TABLE ${ident}.${table} ADD CONSTRAINT ${table}_${name}_check CHECK (${idExpression(ident, column, kind, nullable, admitted)})`,
  ])
  return [maps, addMaps, ...ids]
}

function raise(message: string, constraint: string): string {
  return `RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = '${message}', CONSTRAINT = '${constraint}'`
}

function helperStatements(s: string): string[] {
  return [
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_readiness_request_id(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $fn$
  SELECT value IS NOT NULL
    AND pg_catalog.char_length(value) BETWEEN 1 AND 128
    AND NOT (pg_catalog.ascii(pg_catalog.substr(value, 1, 1)) = ANY (ARRAY[${REQUEST_BOUNDARY}]::pg_catalog.int4[]))
    AND NOT (pg_catalog.ascii(pg_catalog.substr(value, pg_catalog.char_length(value), 1)) = ANY (ARRAY[${REQUEST_BOUNDARY}]::pg_catalog.int4[]))
$fn$`,
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_readiness_scope_id(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $fn$
  SELECT value IS NOT NULL
    AND pg_catalog.char_length(value) BETWEEN 1 AND 64
    AND pg_catalog.strpos(value, pg_catalog.chr(10)) = 0
    AND pg_catalog.strpos(value, pg_catalog.chr(13)) = 0
    AND NOT (pg_catalog.ascii(pg_catalog.substr(value, 1, 1)) = ANY (ARRAY[${SCOPE_BOUNDARY}]::pg_catalog.int4[]))
    AND NOT (pg_catalog.ascii(pg_catalog.substr(value, pg_catalog.char_length(value), 1)) = ANY (ARRAY[${SCOPE_BOUNDARY}]::pg_catalog.int4[]))
$fn$`,
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_readiness_row_key(
  row_key jsonb, data_source_id text, native_tenant_id text, native_org_id text, item_id text
) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  slot int;
  elem jsonb;
  ruleset text;
BEGIN
  IF jsonb_typeof(row_key) IS DISTINCT FROM 'array' OR jsonb_array_length(row_key) <> 5 THEN
    RETURN NULL;
  END IF;
  FOR slot IN 0..4 LOOP
    elem := row_key -> slot;
    IF jsonb_typeof(elem) IS DISTINCT FROM 'string' THEN
      RETURN NULL;
    END IF;
    IF slot IN (0, 3, 4) AND ${s}.meta_plm_collaboration_readiness_request_id(row_key ->> slot) IS NOT TRUE THEN
      RETURN NULL;
    END IF;
    IF slot IN (1, 2) AND ${s}.meta_plm_collaboration_readiness_scope_id(row_key ->> slot) IS NOT TRUE THEN
      RETURN NULL;
    END IF;
  END LOOP;
  IF (row_key ->> 0) IS DISTINCT FROM data_source_id
     OR (row_key ->> 1) IS DISTINCT FROM native_tenant_id
     OR (row_key ->> 2) IS DISTINCT FROM native_org_id
     OR (row_key ->> 3) IS DISTINCT FROM item_id THEN
    RETURN NULL;
  END IF;
  ruleset := row_key ->> 4;
  RETURN ruleset;
END
$fn$`,
    dataOkStatement(s),
  ]
}

function dataOkStatement(s: string): string {
  return `
CREATE FUNCTION ${s}.meta_plm_collaboration_readiness_data_ok(
  item_id text, ruleset_id text, source_fields jsonb, data jsonb
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  pair record;
  resource jsonb;
  issue jsonb;
  slot int;
  issue_slot int;
  pass int;
  physical text[];
  item_cell text;
  ruleset_cell text;
  generated_cell text;
  coverage_cell text;
  resources_count_cell text;
  ok_cell text;
  error_cell text;
  warning_cell text;
  resources_cell text;
  parsed jsonb;
  buf text;
  issues jsonb;
  seen jsonb := '[]'::jsonb;
  identity jsonb;
  mbom_n int := 0;
  routing_n int := 0;
  baseline_n int := 0;
  item_n int := 0;
  error_sum numeric := 0;
  warning_sum numeric := 0;
  ok_sum numeric := 0;
  kind_text text;
  type_text text;
  rid text;
BEGIN
  IF ${s}.meta_plm_collaboration_readiness_request_id(item_id) IS NOT TRUE
     OR ${s}.meta_plm_collaboration_readiness_request_id(ruleset_id) IS NOT TRUE
     OR source_fields IS NULL OR data IS NULL THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(source_fields) IS DISTINCT FROM 'object'
     OR jsonb_typeof(data) IS DISTINCT FROM 'object'
     OR source_fields - ARRAY[${READINESS_KEYS}] <> '{}'::jsonb
     OR NOT (source_fields ?& ARRAY[${READINESS_KEYS}]) THEN
    RETURN false;
  END IF;
  FOR pair IN SELECT key, value FROM jsonb_each(source_fields) LOOP
    IF jsonb_typeof(pair.value) IS DISTINCT FROM 'string' OR char_length(pair.value #>> '{}') < 1 THEN
      RETURN false;
    END IF;
  END LOOP;
  SELECT array_agg(mapped.value #>> '{}') INTO physical
  FROM jsonb_each(source_fields) AS mapped(key, value);
  IF physical IS NULL OR array_length(physical, 1) IS DISTINCT FROM 9
     OR (SELECT count(DISTINCT id) FROM unnest(physical) AS id) IS DISTINCT FROM 9
     OR data - physical <> '{}'::jsonb
     OR NOT (data ?& physical) THEN
    RETURN false;
  END IF;
  FOR pair IN SELECT key, value FROM jsonb_each(data) LOOP
    IF jsonb_typeof(pair.value) IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
  END LOOP;
  item_cell := data ->> (source_fields ->> 'item_id');
  ruleset_cell := data ->> (source_fields ->> 'ruleset_id');
  generated_cell := data ->> (source_fields ->> 'generated_at');
  coverage_cell := data ->> (source_fields ->> 'coverage_status');
  resources_count_cell := data ->> (source_fields ->> 'resources_count');
  ok_cell := data ->> (source_fields ->> 'ok_resources');
  error_cell := data ->> (source_fields ->> 'error_count');
  warning_cell := data ->> (source_fields ->> 'warning_count');
  resources_cell := data ->> (source_fields ->> 'resources');
  IF item_cell IS DISTINCT FROM item_id OR ruleset_cell IS DISTINCT FROM ruleset_id
     OR ${s}.meta_plm_collaboration_native_timestamp(generated_cell) IS NOT TRUE
     OR coverage_cell IS DISTINCT FROM ${quoteLiteral(READINESS_COLLABORATION_COVERAGE_STATUS)}
     OR resources_cell IS NULL THEN
    RETURN false;
  END IF;
  BEGIN
    parsed := resources_cell::jsonb;
  EXCEPTION
    WHEN data_exception THEN
      RETURN false;
  END;
  IF jsonb_typeof(parsed) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  FOR slot IN 0..jsonb_array_length(parsed) - 1 LOOP
    resource := parsed -> slot;
    IF jsonb_typeof(resource) IS DISTINCT FROM 'object'
       OR resource - ARRAY['errors','kind','name','resource_id','resource_type','state','warnings'] <> '{}'::jsonb
       OR NOT (resource ?& ARRAY['errors','kind','name','resource_id','resource_type','state','warnings'])
       OR jsonb_typeof(resource -> 'kind') IS DISTINCT FROM 'string'
       OR jsonb_typeof(resource -> 'resource_type') IS DISTINCT FROM 'string'
       OR jsonb_typeof(resource -> 'resource_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(resource -> 'name') NOT IN ('string', 'null')
       OR jsonb_typeof(resource -> 'state') NOT IN ('string', 'null')
       OR jsonb_typeof(resource -> 'errors') IS DISTINCT FROM 'array'
       OR jsonb_typeof(resource -> 'warnings') IS DISTINCT FROM 'array' THEN
      RETURN false;
    END IF;
    kind_text := resource ->> 'kind';
    type_text := resource ->> 'resource_type';
    rid := resource ->> 'resource_id';
    IF rid IS NULL OR char_length(rid) < 1 THEN
      RETURN false;
    END IF;
    IF kind_text = 'mbom_release' AND type_text = 'mbom' THEN
      mbom_n := mbom_n + 1;
    ELSIF kind_text = 'routing_release' AND type_text = 'routing' THEN
      routing_n := routing_n + 1;
    ELSIF kind_text = 'baseline_release' AND type_text = 'baseline' THEN
      baseline_n := baseline_n + 1;
    ELSIF kind_text = 'item_release' AND type_text = 'item' THEN
      item_n := item_n + 1;
      IF rid IS DISTINCT FROM item_id THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;
    IF mbom_n > 20 OR routing_n > 20 OR baseline_n > 20 OR item_n > 1 THEN
      RETURN false;
    END IF;
    identity := jsonb_build_object('kind', kind_text, 'resource_type', type_text, 'resource_id', rid);
    IF seen @> jsonb_build_array(identity) THEN
      RETURN false;
    END IF;
    seen := seen || jsonb_build_array(identity);
    -- Index the two arrays. jsonb equality would count a resource whose errors and warnings
    -- are the same array as errors twice and leave warnings at 0.
    FOR pass IN 1..2 LOOP
      issues := CASE WHEN pass = 1 THEN resource -> 'errors' ELSE resource -> 'warnings' END;
      FOR issue_slot IN 0..jsonb_array_length(issues) - 1 LOOP
        issue := issues -> issue_slot;
        IF jsonb_typeof(issue) IS DISTINCT FROM 'object'
           OR issue - ARRAY['code','rule_id'] <> '{}'::jsonb
           OR NOT (issue ?& ARRAY['code','rule_id'])
           OR jsonb_typeof(issue -> 'code') IS DISTINCT FROM 'string'
           OR jsonb_typeof(issue -> 'rule_id') IS DISTINCT FROM 'string' THEN
          RETURN false;
        END IF;
      END LOOP;
      IF pass = 1 THEN
        error_sum := error_sum + jsonb_array_length(issues);
      ELSE
        warning_sum := warning_sum + jsonb_array_length(issues);
      END IF;
    END LOOP;
    IF jsonb_array_length(resource -> 'errors') = 0 THEN
      ok_sum := ok_sum + 1;
    END IF;
  END LOOP;
  IF resources_count_cell !~ '^(0|[1-9][0-9]*)$' OR char_length(resources_count_cell) > 16
     OR ok_cell !~ '^(0|[1-9][0-9]*)$' OR char_length(ok_cell) > 16
     OR error_cell !~ '^(0|[1-9][0-9]*)$' OR char_length(error_cell) > 16
     OR warning_cell !~ '^(0|[1-9][0-9]*)$' OR char_length(warning_cell) > 16
     OR resources_count_cell::numeric > 9007199254740991
     OR ok_cell::numeric > 9007199254740991
     OR error_cell::numeric > 9007199254740991
     OR warning_cell::numeric > 9007199254740991
     OR resources_count_cell::numeric IS DISTINCT FROM jsonb_array_length(parsed)::numeric
     OR ok_cell::numeric IS DISTINCT FROM ok_sum
     OR error_cell::numeric IS DISTINCT FROM error_sum
     OR warning_cell::numeric IS DISTINCT FROM warning_sum THEN
    RETURN false;
  END IF;
  buf := '[';
  FOR slot IN 0..jsonb_array_length(parsed) - 1 LOOP
    IF slot > 0 THEN
      buf := buf || ',';
    END IF;
    resource := parsed -> slot;
    buf := buf || '{"errors":[';
    issues := resource -> 'errors';
    FOR issue_slot IN 0..jsonb_array_length(issues) - 1 LOOP
      IF issue_slot > 0 THEN buf := buf || ','; END IF;
      issue := issues -> issue_slot;
      buf := buf || '{"code":' || pg_catalog.to_jsonb(issue ->> 'code')::text
        || ',"rule_id":' || pg_catalog.to_jsonb(issue ->> 'rule_id')::text || '}';
    END LOOP;
    buf := buf || '],"kind":' || pg_catalog.to_jsonb(resource ->> 'kind')::text
      || ',"name":' || COALESCE(pg_catalog.to_jsonb(resource ->> 'name')::text, 'null')
      || ',"resource_id":' || pg_catalog.to_jsonb(resource ->> 'resource_id')::text
      || ',"resource_type":' || pg_catalog.to_jsonb(resource ->> 'resource_type')::text
      || ',"state":' || COALESCE(pg_catalog.to_jsonb(resource ->> 'state')::text, 'null')
      || ',"warnings":[';
    issues := resource -> 'warnings';
    FOR issue_slot IN 0..jsonb_array_length(issues) - 1 LOOP
      IF issue_slot > 0 THEN buf := buf || ','; END IF;
      issue := issues -> issue_slot;
      buf := buf || '{"code":' || pg_catalog.to_jsonb(issue ->> 'code')::text
        || ',"rule_id":' || pg_catalog.to_jsonb(issue ->> 'rule_id')::text || '}';
    END LOOP;
    buf := buf || ']}';
  END LOOP;
  buf := buf || ']';
  RETURN buf IS NOT DISTINCT FROM resources_cell;
END
$fn$`
}

function acceptedSync(s: string, admitted: boolean): string {
  const kind = admitted ? `anchor.source_kind IN ('eco', 'readiness')` : `anchor.source_kind = 'eco'`
  return `
CREATE OR REPLACE FUNCTION ${s}.meta_plm_collaboration_accepted_sync(record_id text, binding_id uuid)
RETURNS TABLE (actor_id text, patch jsonb)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  sync_id text;
BEGIN
  sync_id := pg_catalog.current_setting('metasheet.plm_collaboration_sync', true);
  IF sync_id IS NULL OR sync_id = '' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT accepted.actor_id, accepted.patches -> record_id
  FROM ${s}.meta_plm_collaboration_syncs accepted
  JOIN ${s}.meta_plm_collaboration_bindings anchor ON anchor.id = accepted.binding_id
  WHERE accepted.id::text = sync_id
    AND accepted.binding_id = meta_plm_collaboration_accepted_sync.binding_id
    AND accepted.accepted_txid = pg_catalog.pg_current_xact_id()::text
    AND accepted.binding_version = anchor.version
    AND anchor.status = 'active'
    AND ${kind};
END
$fn$`
}

function previewGuard(s: string, admitted: boolean): string {
  const kind = admitted
    ? `IF NEW.source_kind = 'eco' THEN
    eco_id := ${s}.meta_plm_collaboration_eco_row_key(NEW.row_key, NEW.data_source_id, NEW.native_tenant_id, NEW.native_org_id);
    IF eco_id IS NULL THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_preview_guard', 'plm_collaboration_source_protected');
    END IF;
  ELSIF NEW.source_kind = 'readiness' THEN
    ruleset_id := ${s}.meta_plm_collaboration_readiness_row_key(NEW.row_key, NEW.data_source_id, NEW.native_tenant_id, NEW.native_org_id, NEW.item_id);
    IF ruleset_id IS NULL THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_preview_guard', 'plm_collaboration_source_protected');
    END IF;
  ELSE
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_preview_guard', 'plm_collaboration_source_protected');
  END IF;`
    : `IF NEW.source_kind IS DISTINCT FROM 'eco' THEN
    PERFORM ${s}.meta_plm_collaboration_refuse(
      'meta_plm_collaboration_preview_guard',
      CASE WHEN NEW.source_kind = 'readiness' THEN 'plm_collaboration_readiness_unadmitted' ELSE 'plm_collaboration_source_protected' END
    );
  END IF;
  eco_id := ${s}.meta_plm_collaboration_eco_row_key(NEW.row_key, NEW.data_source_id, NEW.native_tenant_id, NEW.native_org_id);
  IF eco_id IS NULL THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_preview_guard', 'plm_collaboration_source_protected');
  END IF;`
  const ruleset = admitted ? '\n  ruleset_id text;' : ''
  return `
CREATE OR REPLACE FUNCTION ${s}.meta_plm_collaboration_preview_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  eco_id text;${ruleset}
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_preview_guard', 'plm_collaboration_source_protected');
  END IF;
  ${kind}
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['request_id', 'binding_id', 'consumed_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['request_id', 'binding_id', 'consumed_at']) THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_preview_guard', 'plm_collaboration_source_protected');
  END IF;
  IF OLD.request_id IS NULL AND OLD.binding_id IS NULL AND OLD.consumed_at IS NULL
     AND NEW.request_id IS NOT NULL AND NEW.binding_id IS NOT NULL AND NEW.consumed_at IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM ${s}.meta_plm_collaboration_bindings anchor
       WHERE anchor.id = NEW.binding_id
         AND anchor.data_source_id = NEW.data_source_id
         AND anchor.source_kind = NEW.source_kind
         AND anchor.native_tenant_id = NEW.native_tenant_id
         AND anchor.native_org_id = NEW.native_org_id
         AND anchor.item_id = NEW.item_id
         AND anchor.current_version_id IS NOT DISTINCT FROM NEW.current_version_id
         AND anchor.base_id = NEW.base_id
         AND anchor.source_fingerprint = NEW.source_fingerprint
     ) THEN
    RETURN NEW;
  END IF;
  PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_preview_guard', 'plm_collaboration_source_protected');
  RETURN NULL;
END
$fn$`
}

function bindingGuard(s: string, admitted: boolean): string {
  const kind = admitted
    ? `IF NEW.source_kind IS DISTINCT FROM 'eco' AND NEW.source_kind IS DISTINCT FROM 'readiness' THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
  END IF;`
    : `IF NEW.source_kind IS DISTINCT FROM 'eco' THEN
    PERFORM ${s}.meta_plm_collaboration_refuse(
      'meta_plm_collaboration_binding_guard',
      CASE WHEN NEW.source_kind = 'readiness' THEN 'plm_collaboration_readiness_unadmitted' ELSE 'plm_collaboration_source_protected' END
    );
  END IF;`
  return `
CREATE OR REPLACE FUNCTION ${s}.meta_plm_collaboration_binding_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  pair record;
  field record;
  base_row record;
  sheet_row record;
  view_row record;
  expected_type text;
  mutable text[] := ARRAY['version', 'status', 'updated_at', 'last_failure_code', 'last_failure_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
  END IF;
  ${kind}
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable)
       OR (OLD.status = 'disabled' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
       OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'active' AND NEW.status IN ('stale', 'disabled'))
         OR (OLD.status = 'stale' AND NEW.status = 'disabled')
       ))
       OR (NEW.version <> OLD.version AND NEW.version <> OLD.version + 1) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version <> 1 OR NEW.status <> 'active' OR NEW.last_failure_code IS NOT NULL OR NEW.last_failure_at IS NOT NULL THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
  END IF;
  IF (
    SELECT count(*) FROM (
      SELECT value FROM jsonb_each_text(NEW.source_fields)
      UNION ALL
      SELECT value FROM jsonb_each_text(NEW.local_fields)
    ) ids
  ) IS DISTINCT FROM (
    SELECT count(DISTINCT value) FROM (
      SELECT value FROM jsonb_each_text(NEW.source_fields)
      UNION ALL
      SELECT value FROM jsonb_each_text(NEW.local_fields)
    ) ids
  ) THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
  END IF;
  -- NO KEY UPDATE blocks a concurrent container UPDATE and does not wait on a child FK KEY SHARE.
  SELECT * INTO base_row FROM ${s}.meta_bases WHERE id = NEW.base_id FOR NO KEY UPDATE;
  IF NOT FOUND OR base_row.deleted_at IS NOT NULL THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
  END IF;
  SELECT * INTO sheet_row FROM ${s}.meta_sheets WHERE id = NEW.sheet_id FOR NO KEY UPDATE;
  IF NOT FOUND OR sheet_row.base_id IS DISTINCT FROM NEW.base_id OR sheet_row.deleted_at IS NOT NULL THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
  END IF;
  SELECT * INTO view_row FROM ${s}.meta_views WHERE id = NEW.view_id FOR NO KEY UPDATE;
  IF NOT FOUND OR view_row.sheet_id IS DISTINCT FROM NEW.sheet_id THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
  END IF;
  FOR pair IN
    SELECT mapped.key, mapped.value, mapped.kind
    FROM (
      SELECT key, value, 'source'::text AS kind FROM jsonb_each_text(NEW.source_fields)
      UNION ALL
      SELECT key, value, 'local'::text AS kind FROM jsonb_each_text(NEW.local_fields)
    ) mapped
    ORDER BY mapped.value
  LOOP
    IF pair.value IS NULL OR char_length(pair.value) < 1 OR pair.value <> btrim(pair.value) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
    END IF;
    SELECT id, sheet_id, type, property INTO field FROM ${s}.meta_fields WHERE id = pair.value FOR UPDATE;
    IF NOT FOUND OR field.sheet_id IS DISTINCT FROM NEW.sheet_id THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
    END IF;
    IF pair.kind = 'source' THEN
      IF field.type IS DISTINCT FROM 'string'
         OR field.property -> 'readOnly' IS DISTINCT FROM 'true'::jsonb
         OR ((field.property ? 'readonly') AND field.property -> 'readonly' IS DISTINCT FROM 'true'::jsonb)
         OR field.property -> 'plmCollaborationSnapshot' IS DISTINCT FROM jsonb_build_object('source', true, 'key', pair.key) THEN
        PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
      END IF;
    ELSE
      expected_type := CASE pair.key
        ${LOCAL_TYPE_CASE}
        ELSE NULL
      END;
      IF field.type IS DISTINCT FROM expected_type
         OR field.property -> 'readOnly' = 'true'::jsonb
         OR field.property -> 'readonly' = 'true'::jsonb
         OR field.property #> '{plmCollaborationSnapshot,source}' = 'true'::jsonb THEN
        PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
      END IF;
    END IF;
  END LOOP;
  IF to_regclass(${quoteLiteral(`${s}.meta_plm_bom_review_bindings`)}) IS NOT NULL THEN
    PERFORM 1 FROM ${s}.meta_plm_bom_review_bindings WHERE sheet_id = NEW.sheet_id;
    IF FOUND THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
    END IF;
  END IF;
  RETURN NEW;
END
$fn$`
}

function syncGuard(s: string, admitted: boolean): string {
  const gate = admitted
    ? `anchor.source_kind NOT IN ('eco', 'readiness')`
    : `anchor.source_kind <> 'eco'`
  const value = admitted
    ? `IF anchor.source_kind = 'readiness'
       AND ${s}.meta_plm_collaboration_native_timestamp(entry.value ->> 'captured_at') IS NOT TRUE THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
    END IF;
    BEGIN
      captured := (entry.value ->> 'captured_at')::timestamptz;
    EXCEPTION
      WHEN invalid_datetime_format OR datetime_field_overflow THEN
        PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
    END;
    IF captured IS NULL THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
    END IF;
    IF anchor.source_kind = 'eco' THEN
      eco_id := ${s}.meta_plm_collaboration_eco_row_key(entry.value -> 'row_key', anchor.data_source_id, anchor.native_tenant_id, anchor.native_org_id);
      IF eco_id IS NULL
         OR (entry.value -> 'data') - physical_ids <> '{}'::jsonb
         OR NOT ((entry.value -> 'data') ?& physical_ids) THEN
        PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
      END IF;
      FOR pair IN SELECT key, value FROM jsonb_each_text(anchor.source_fields) LOOP
        IF NOT ${s}.meta_plm_collaboration_source_value_ok(pair.key, anchor.item_id, eco_id, entry.value -> 'data' -> pair.value) THEN
          PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
        END IF;
      END LOOP;
    ELSIF anchor.source_kind = 'readiness' THEN
      ruleset_id := ${s}.meta_plm_collaboration_readiness_row_key(entry.value -> 'row_key', anchor.data_source_id, anchor.native_tenant_id, anchor.native_org_id, anchor.item_id);
      IF ruleset_id IS NULL
         OR (entry.value -> 'data') - physical_ids <> '{}'::jsonb
         OR NOT ((entry.value -> 'data') ?& physical_ids)
         OR ${s}.meta_plm_collaboration_readiness_data_ok(anchor.item_id, ruleset_id, anchor.source_fields, entry.value -> 'data') IS NOT TRUE THEN
        PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
      END IF;
    ELSE
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
    END IF;`
    : `BEGIN
      captured := (entry.value ->> 'captured_at')::timestamptz;
    EXCEPTION
      WHEN invalid_datetime_format OR datetime_field_overflow THEN
        PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
    END;
    IF captured IS NULL THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
    END IF;
    eco_id := ${s}.meta_plm_collaboration_eco_row_key(entry.value -> 'row_key', anchor.data_source_id, anchor.native_tenant_id, anchor.native_org_id);
    IF eco_id IS NULL
       OR (entry.value -> 'data') - physical_ids <> '{}'::jsonb
       OR NOT ((entry.value -> 'data') ?& physical_ids) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
    END IF;
    FOR pair IN SELECT key, value FROM jsonb_each_text(anchor.source_fields) LOOP
      IF NOT ${s}.meta_plm_collaboration_source_value_ok(pair.key, anchor.item_id, eco_id, entry.value -> 'data' -> pair.value) THEN
        PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
      END IF;
    END LOOP;`
  const ruleset = admitted ? '\n  ruleset_id text;' : ''
  return `
CREATE OR REPLACE FUNCTION ${s}.meta_plm_collaboration_sync_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  anchor record;
  entry record;
  pair record;
  eco_id text;
  physical_ids text[];
  captured timestamptz;${ruleset}
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
  END IF;
  IF NEW.accepted_txid IS DISTINCT FROM pg_catalog.pg_current_xact_id()::text THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
  END IF;
  SELECT * INTO anchor FROM ${s}.meta_plm_collaboration_bindings WHERE id = NEW.binding_id;
  IF NOT FOUND OR anchor.status <> 'active' OR ${gate} OR anchor.version <> NEW.binding_version THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
  END IF;
  SELECT array_agg(value) INTO physical_ids FROM jsonb_each_text(anchor.source_fields);
  FOR entry IN SELECT key, value FROM jsonb_each(NEW.patches) LOOP
    IF char_length(entry.key) < 1 OR entry.key <> btrim(entry.key)
       OR jsonb_typeof(entry.value) IS DISTINCT FROM 'object'
       OR entry.value - ARRAY['row_key', 'data', 'business_hash', 'captured_at'] <> '{}'::jsonb
       OR NOT (entry.value ?& ARRAY['row_key', 'data', 'business_hash', 'captured_at'])
       OR entry.value ->> 'business_hash' !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(entry.value -> 'captured_at') IS DISTINCT FROM 'string'
       OR jsonb_typeof(entry.value -> 'data') IS DISTINCT FROM 'object' THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
    END IF;
    ${value}
  END LOOP;
  RETURN NEW;
END
$fn$`
}

function replacedStatements(s: string, admitted: boolean): string[] {
  return [acceptedSync(s, admitted), previewGuard(s, admitted), bindingGuard(s, admitted), syncGuard(s, admitted)]
}

function dropHelpers(s: string): string[] {
  return [
    `DROP FUNCTION ${s}.meta_plm_collaboration_readiness_request_id(text)`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_readiness_scope_id(text)`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_readiness_row_key(jsonb, text, text, text, text)`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_readiness_data_ok(text, text, jsonb, jsonb)`,
  ]
}

async function servingSchema(db: Kysely<unknown>): Promise<ServingSchema> {
  const found = await sql<{ name: string | null; ident: string | null }>`
    SELECT current_schema() AS name, quote_ident(current_schema()) AS ident
  `.execute(db)
  const name = found.rows[0]?.name
  const ident = found.rows[0]?.ident
  if (!name || !ident) {
    await sql.raw(`DO $schema$ BEGIN ${raise('plm_collaboration_serving_schema_invalid', 'meta_plm_collaboration_predecessor_guard')}; END $schema$`).execute(db)
    throw new Error('plm_collaboration_serving_schema_invalid')
  }
  assertSchemaName(name)
  return { name, ident }
}

async function withOwnedTransaction(
  db: Kysely<unknown>,
  run: (trx: Kysely<unknown>) => Promise<void>,
): Promise<void> {
  if (db.isTransaction) {
    await run(db)
    return
  }
  await db.transaction().execute(run)
}

function isolationSql(): string {
  return `
DO $iso$
DECLARE
  iso text;
BEGIN
  SHOW transaction_isolation INTO iso;
  IF iso IS DISTINCT FROM 'read committed' THEN
    ${raise('plm_collaboration_snapshot_stale', 'meta_plm_collaboration_snapshot_guard')};
  END IF;
END
$iso$`
}

const SERVING_SCHEMA_MARKER = '__PLM_SERVING_SCHEMA__.'

function pgTextArray(values: readonly string[] | null): string {
  if (values === null) return 'NULL::text[]'
  return `ARRAY[${values.map((value) => quoteLiteral(value)).join(',')}]::text[]`
}

function pgCharArray(values: readonly string[] | null): string {
  if (values === null) return 'NULL::"char"[]'
  return `ARRAY[${values.map((value) => quoteLiteral(value)).join(',')}]::"char"[]`
}

function templateBody(statement: string, ident: string): string {
  const parts = statement.split('$fn$')
  if (parts.length !== 3) throw new Error('plm_collaboration_admission_shape_invalid')
  const qualifier = `${ident}.`
  const stripped = parts[1].split(qualifier).join('')
  if (stripped.includes('__PLM_SERVING_SCHEMA__')) throw new Error('plm_collaboration_admission_shape_invalid')
  return parts[1].split(qualifier).join(SERVING_SCHEMA_MARKER)
}

function generatedBodies(ident: string, admitted: boolean): ReadonlyMap<string, string> {
  const rows: Array<[string, string]> = [
    ['meta_plm_collaboration_accepted_sync', acceptedSync(ident, admitted)],
    ['meta_plm_collaboration_preview_guard', previewGuard(ident, admitted)],
    ['meta_plm_collaboration_binding_guard', bindingGuard(ident, admitted)],
    ['meta_plm_collaboration_sync_guard', syncGuard(ident, admitted)],
  ]
  if (admitted) {
    const statements = helperStatements(ident)
    if (statements.length !== HELPERS.length) throw new Error('plm_collaboration_admission_shape_invalid')
    statements.forEach((statement, index) => rows.push([HELPERS[index][0], statement]))
  }
  return new Map(rows.map(([name, statement]) => [name, templateBody(statement, ident)]))
}

function normalizedCatalogText(expression: string, ident: string): string {
  return `pg_catalog.replace(${expression}, ${quoteLiteral(`${ident}.`)}, ${quoteLiteral(SERVING_SCHEMA_MARKER)})`
}

function markerCollision(expression: string, ident: string): string {
  return `pg_catalog.strpos(pg_catalog.replace(${expression}, ${quoteLiteral(`${ident}.`)}, ''), ${quoteLiteral('__PLM_SERVING_SCHEMA__')}) > 0`
}

function bodyHashSql(expression: string): string {
  return `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${expression}, 'UTF8')), 'hex')`
}

function functionInventoryMismatch(schema: ServingSchema, admitted: boolean): string {
  const pins = ADMISSION_FUNCTIONS.filter((pin) => admitted || pin.body !== 'helper')
  const expectedCount = admitted ? 18 : 14
  if (pins.length !== expectedCount) throw new Error('plm_collaboration_admission_shape_invalid')
  if (pins.filter((pin) => pin.body === 'kept').length !== KEPT.length) throw new Error('plm_collaboration_admission_shape_invalid')
  if (pins.filter((pin) => pin.body === 'replaced').length !== REPLACED.length) throw new Error('plm_collaboration_admission_shape_invalid')
  if (ADMISSION_FUNCTIONS.filter((pin) => pin.body === 'helper').length !== HELPERS.length) throw new Error('plm_collaboration_admission_shape_invalid')
  const bodies = generatedBodies(schema.ident, admitted)
  const values = pins.map((pin) => {
    const bodyHash = pin.body === 'kept'
      ? quoteLiteral(pin.body_hash ?? '')
      : bodyHashSql(quoteLiteral(bodies.get(pin.name) ?? ''))
    if (pin.body === 'kept' && !pin.body_hash) throw new Error('plm_collaboration_admission_shape_invalid')
    if (pin.body !== 'kept' && !bodies.has(pin.name)) throw new Error('plm_collaboration_admission_shape_invalid')
    return `(${[
      quoteLiteral(pin.name),
      `${pin.nargs}::smallint`,
      quoteLiteral(pin.identity_arguments),
      quoteLiteral(pin.arguments),
      quoteLiteral(pin.result_declaration),
      quoteLiteral(pin.return_type),
      quoteLiteral(pin.language),
      quoteLiteral(pin.kind),
      quoteLiteral(pin.volatility),
      quoteLiteral(pin.parallel),
      pin.strict ? 'TRUE' : 'FALSE',
      pin.leakproof ? 'TRUE' : 'FALSE',
      pin.security_definer ? 'TRUE' : 'FALSE',
      pin.returns_set ? 'TRUE' : 'FALSE',
      `${pin.cost}::real`,
      `${pin.rows}::real`,
      `${pin.default_count}::smallint`,
      pgTextArray(pin.config),
      pgCharArray(pin.arg_modes),
      pgTextArray(pin.arg_names),
      pgTextArray(pin.input_types),
      pgTextArray(pin.all_arg_types),
      bodyHash,
    ].join(',')})`
  }).join(',')
  const normalizedBody = normalizedCatalogText('proc.prosrc', schema.ident)
  const collided = markerCollision('proc.prosrc', schema.ident)
  return `EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc proc
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = proc.pronamespace
    WHERE namespace.nspname = ${quoteLiteral(schema.name)}
      AND proc.proname LIKE 'meta_plm_collaboration\\_%' ESCAPE '\\'
      AND ${collided}
  )
  OR (
    SELECT count(*) FROM pg_catalog.pg_proc proc
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = proc.pronamespace
    WHERE namespace.nspname = ${quoteLiteral(schema.name)}
      AND proc.proname LIKE 'meta_plm_collaboration\\_%' ESCAPE '\\'
  ) <> ${expectedCount}
  OR (
    SELECT count(*) FROM (VALUES ${values}) AS expected(
      name, nargs, identity_arguments, argument_list, result_declaration, return_type,
      language, kind, volatility, parallel, is_strict, leakproof, security_definer, returns_set,
      cost, row_estimate, default_count, config, arg_modes, arg_names, input_types, all_arg_types, body_hash
    )
    WHERE EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc proc
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = proc.pronamespace
      JOIN pg_catalog.pg_language language ON language.oid = proc.prolang
      WHERE namespace.nspname = ${quoteLiteral(schema.name)}
        AND proc.proname = expected.name
        AND proc.pronargs = expected.nargs
        AND pg_catalog.pg_get_function_identity_arguments(proc.oid) = expected.identity_arguments
        AND pg_catalog.pg_get_function_arguments(proc.oid) = expected.argument_list
        AND pg_catalog.pg_get_function_result(proc.oid) = expected.result_declaration
        AND pg_catalog.format_type(proc.prorettype, NULL) = expected.return_type
        AND language.lanname = expected.language
        AND proc.prokind = expected.kind::"char"
        AND proc.provolatile = expected.volatility::"char"
        AND proc.proparallel = expected.parallel::"char"
        AND proc.proisstrict IS NOT DISTINCT FROM expected.is_strict
        AND proc.proleakproof IS NOT DISTINCT FROM expected.leakproof
        AND proc.prosecdef IS NOT DISTINCT FROM expected.security_definer
        AND proc.proretset IS NOT DISTINCT FROM expected.returns_set
        AND proc.procost IS NOT DISTINCT FROM expected.cost
        AND proc.prorows IS NOT DISTINCT FROM expected.row_estimate
        AND proc.pronargdefaults IS NOT DISTINCT FROM expected.default_count
        AND pg_catalog.pg_get_expr(proc.proargdefaults, 0) IS NULL
        AND proc.proconfig IS NOT DISTINCT FROM expected.config
        AND proc.proargmodes IS NOT DISTINCT FROM expected.arg_modes
        AND proc.proargnames IS NOT DISTINCT FROM expected.arg_names
        AND (
          SELECT pg_catalog.array_agg(pg_catalog.format_type(arg, NULL) ORDER BY arg_row.ordinality)
          FROM pg_catalog.unnest(proc.proargtypes::oid[]) WITH ORDINALITY AS arg_row(arg, ordinality)
        ) IS NOT DISTINCT FROM expected.input_types
        AND (
          SELECT pg_catalog.array_agg(pg_catalog.format_type(arg, NULL) ORDER BY arg_row.ordinality)
          FROM pg_catalog.unnest(proc.proallargtypes) WITH ORDINALITY AS arg_row(arg, ordinality)
        ) IS NOT DISTINCT FROM expected.all_arg_types
        AND ${bodyHashSql(normalizedBody)} = expected.body_hash
    )
  ) <> ${expectedCount}`
}

function checkInventoryMismatch(schema: ServingSchema, admitted: boolean): string {
  const pins = admitted ? ADMITTED_CHECKS : FOUNDATION_CHECKS
  if (pins.length !== 11) throw new Error('plm_collaboration_admission_shape_invalid')
  const values = pins.map((pin) => `(${[
    quoteLiteral(pin.name),
    quoteLiteral(pin.table_name),
    quoteLiteral(pin.kind),
    pin.validated ? 'TRUE' : 'FALSE',
    pin.no_inherit ? 'TRUE' : 'FALSE',
    pin.deferrable ? 'TRUE' : 'FALSE',
    pin.initially_deferred ? 'TRUE' : 'FALSE',
    quoteLiteral(pin.columns),
    quoteLiteral(pin.definition),
  ].join(',')})`).join(',')
  const definition = normalizedCatalogText('pg_catalog.pg_get_constraintdef(constraint_row.oid, false)', schema.ident)
  const collided = markerCollision('pg_catalog.pg_get_constraintdef(constraint_row.oid, false)', schema.ident)
  const names = pins.map((pin) => quoteLiteral(pin.name)).join(', ')
  return `EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint constraint_row
    JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${quoteLiteral(schema.name)}
      AND constraint_row.contype = 'c'
      AND constraint_row.conname IN (${names})
      AND ${collided}
  )
  OR (
    SELECT count(*) FROM (VALUES ${values}) AS expected(
      name, table_name, kind, validated, no_inherit, is_deferrable, initially_deferred, columns, definition
    )
    WHERE EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint constraint_row
      JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ${quoteLiteral(schema.name)}
        AND constraint_row.contype = expected.kind::"char"
        AND constraint_row.conname = expected.name
        AND relation.relname = expected.table_name
        AND constraint_row.convalidated IS NOT DISTINCT FROM expected.validated
        AND constraint_row.connoinherit IS NOT DISTINCT FROM expected.no_inherit
        AND constraint_row.condeferrable IS NOT DISTINCT FROM expected.is_deferrable
        AND constraint_row.condeferred IS NOT DISTINCT FROM expected.initially_deferred
        AND (
          SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key.ordinality)
          FROM pg_catalog.unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, ordinality)
          JOIN pg_catalog.pg_attribute attribute
            ON attribute.attrelid = relation.oid AND attribute.attnum = key.attnum
        )::text = expected.columns
        AND ${definition} = expected.definition
    )
  ) <> 11`
}

function triggerInventoryMismatch(schema: ServingSchema): string {
  if (ADMISSION_TRIGGERS.length !== 19) throw new Error('plm_collaboration_admission_shape_invalid')
  const values = ADMISSION_TRIGGERS.map((pin) => `(${[
    quoteLiteral(pin.name),
    quoteLiteral(pin.table_name),
    `${pin.type_bits}::smallint`,
    quoteLiteral(pin.enabled),
    pin.internal ? 'TRUE' : 'FALSE',
    pin.deferrable ? 'TRUE' : 'FALSE',
    pin.initially_deferred ? 'TRUE' : 'FALSE',
    `${pin.argument_count}::smallint`,
    quoteLiteral(pin.arguments_hex),
    quoteLiteral(pin.update_columns),
    pin.old_transition_table === null ? 'NULL::text' : quoteLiteral(pin.old_transition_table),
    pin.new_transition_table === null ? 'NULL::text' : quoteLiteral(pin.new_transition_table),
    quoteLiteral(pin.function_name),
    quoteLiteral(pin.function_arguments),
    pin.when_expression === null ? 'NULL::text' : quoteLiteral(pin.when_expression),
    quoteLiteral(pin.definition),
  ].join(',')})`).join(',')
  const definition = normalizedCatalogText('pg_catalog.pg_get_triggerdef(trigger_row.oid, false)', schema.ident)
  const collided = markerCollision('pg_catalog.pg_get_triggerdef(trigger_row.oid, false)', schema.ident)
  return `EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger trigger_row
    JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${quoteLiteral(schema.name)}
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgname LIKE 'meta_plm_collaboration\\_%' ESCAPE '\\'
      AND ${collided}
  )
  OR (
    SELECT count(*) FROM pg_catalog.pg_trigger trigger_row
    JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${quoteLiteral(schema.name)}
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgname LIKE 'meta_plm_collaboration\\_%' ESCAPE '\\'
  ) <> 19
  OR (
    SELECT count(*) FROM (VALUES ${values}) AS expected(
      name, table_name, type_bits, enabled, internal, is_deferrable, initially_deferred,
      argument_count, arguments_hex, update_columns, old_transition_table, new_transition_table,
      function_name, function_arguments, when_expression, definition
    )
    WHERE EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger trigger_row
      JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_proc proc ON proc.oid = trigger_row.tgfoid
      WHERE namespace.nspname = ${quoteLiteral(schema.name)}
        AND trigger_row.tgname = expected.name
        AND relation.relname = expected.table_name
        AND trigger_row.tgtype = expected.type_bits
        AND trigger_row.tgenabled = expected.enabled::"char"
        AND trigger_row.tgisinternal IS NOT DISTINCT FROM expected.internal
        AND trigger_row.tgdeferrable IS NOT DISTINCT FROM expected.is_deferrable
        AND trigger_row.tginitdeferred IS NOT DISTINCT FROM expected.initially_deferred
        AND trigger_row.tgnargs = expected.argument_count
        AND pg_catalog.encode(trigger_row.tgargs, 'hex') = expected.arguments_hex
        AND trigger_row.tgattr::text = expected.update_columns
        AND trigger_row.tgoldtable IS NOT DISTINCT FROM expected.old_transition_table
        AND trigger_row.tgnewtable IS NOT DISTINCT FROM expected.new_transition_table
        AND proc.proname = expected.function_name
        AND pg_catalog.pg_get_function_identity_arguments(proc.oid) = expected.function_arguments
        AND pg_catalog.pg_get_expr(trigger_row.tgqual, trigger_row.tgrelid) IS NOT DISTINCT FROM expected.when_expression
        AND ${definition} = expected.definition
    )
  ) <> 19`
}

function shapeSql(schema: ServingSchema, admitted: boolean): string {
  const tables = CONTROL_TABLES.map((name) => quoteLiteral(name)).join(', ')
  const scans = SCAN_TABLES.map((name) => quoteLiteral(name)).join(', ')
  const functions = functionInventoryMismatch(schema, admitted)
  const checks = checkInventoryMismatch(schema, admitted)
  const triggers = triggerInventoryMismatch(schema)
  return `
DO $shape$
BEGIN
  IF current_setting('server_encoding') IS DISTINCT FROM 'UTF8' THEN
    ${raise('plm_collaboration_admission_shape_invalid', 'meta_plm_collaboration_predecessor_guard')};
  END IF;
  IF (
    SELECT count(*) FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${quoteLiteral(schema.name)}
      AND relation.relkind = 'r'
      AND relation.relname IN (${tables})
  ) <> ${CONTROL_TABLES.length}
  OR (
    SELECT count(*) FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${quoteLiteral(schema.name)}
      AND relation.relkind = 'r'
      AND relation.relname IN (${scans})
  ) <> ${SCAN_TABLES.length}
  OR (${functions})
  OR (${checks})
  OR (${triggers})
  OR (
    SELECT count(*) FROM pg_catalog.pg_constraint constraint_row
    JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${quoteLiteral(schema.name)}
      AND constraint_row.conname IN ('meta_plm_collaboration_bindings_kind_check', 'meta_plm_collaboration_previews_kind_check')
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid) LIKE '%eco%'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid) LIKE '%readiness%'
  ) <> 2
  OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${quoteLiteral(schema.name)}
      AND relation.relname = 'meta_config_revisions'
      AND attribute.attname IN ('sheet_id', 'entity_type', 'entity_id', 'before', 'after')
      AND NOT attribute.attisdropped
    HAVING count(*) = 5
  )
  OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${quoteLiteral(schema.name)}
      AND relation.relname = 'meta_record_revisions'
      AND attribute.attname IN ('sheet_id', 'record_id', 'version', 'changed_field_ids', 'patch', 'snapshot', 'operation_id')
      AND NOT attribute.attisdropped
    HAVING count(*) = 7
  )
  OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${quoteLiteral(schema.name)}
      AND relation.relname = 'meta_fields'
      AND attribute.attname IN ('id', 'sheet_id', 'property')
      AND NOT attribute.attisdropped
    HAVING count(*) = 3
  )
  OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${quoteLiteral(schema.name)}
      AND relation.relname = 'meta_records'
      AND attribute.attname IN ('id', 'data', 'sheet_id')
      AND NOT attribute.attisdropped
    HAVING count(*) = 3
  )
  OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${quoteLiteral(schema.name)}
      AND relation.relname = 'meta_record_version_markers'
      AND attribute.attname IN ('sheet_id', 'record_id', 'version', 'operation_id')
      AND NOT attribute.attisdropped
    HAVING count(*) = 4
  )
  OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${quoteLiteral(schema.name)}
      AND relation.relname = 'meta_record_history_operations'
      AND attribute.attname IN ('sheet_id', 'operation_id')
      AND NOT attribute.attisdropped
    HAVING count(*) = 2
  ) THEN
    ${raise('plm_collaboration_admission_shape_invalid', 'meta_plm_collaboration_predecessor_guard')};
  END IF;
END
$shape$`
}

function positiveMarker(schemaIdent: string, marker: string, fieldId: string, sheetId: string): string {
  return `jsonb_typeof(${marker}) = 'object'
    AND (${marker} - ARRAY['source', 'key']) = '{}'::jsonb
    AND (${marker} ?& ARRAY['source', 'key'])
    AND ${marker} -> 'source' = 'true'::jsonb
    AND jsonb_typeof(${marker} -> 'key') = 'string'
    AND ${marker} ->> 'key' IN (${ECO_KEYS})
    AND EXISTS (
      SELECT 1 FROM ${schemaIdent}.meta_plm_collaboration_bindings binding
      WHERE binding.sheet_id = ${sheetId}
        AND binding.source_kind = 'eco'
        AND jsonb_typeof(binding.source_fields) = 'object'
        AND jsonb_typeof(binding.local_fields) = 'object'
        AND binding.source_fields - ARRAY[${ECO_KEYS}] = '{}'::jsonb
        AND binding.source_fields ?& ARRAY[${ECO_KEYS}]
        AND binding.local_fields - ARRAY[${LOCAL_KEYS}] = '{}'::jsonb
        AND binding.local_fields ?& ARRAY[${LOCAL_KEYS}]
        AND binding.source_fields ->> (${marker} ->> 'key') = ${fieldId}
    )`
}

function evidenceSql(s: string): string {
  const liveMarker = `(field.property -> 'plmCollaborationSnapshot')`
  const historyMarker = `(blob.document -> 'property' -> 'plmCollaborationSnapshot')`
  const ecoBinding = `jsonb_typeof(binding.source_fields) = 'object'
          AND jsonb_typeof(binding.local_fields) = 'object'
          AND binding.source_kind = 'eco'
          AND binding.source_fields - ARRAY[${ECO_KEYS}] = '{}'::jsonb
          AND binding.source_fields ?& ARRAY[${ECO_KEYS}]
          AND binding.local_fields - ARRAY[${LOCAL_KEYS}] = '{}'::jsonb
          AND binding.local_fields ?& ARRAY[${LOCAL_KEYS}]`
  return `
DO $evidence$
BEGIN
  IF EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_previews WHERE source_kind IS DISTINCT FROM 'eco')
     OR EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_bindings WHERE source_kind IS DISTINCT FROM 'eco')
     OR EXISTS (
       SELECT 1 FROM ${s}.meta_plm_collaboration_previews preview
       WHERE ${s}.meta_plm_collaboration_eco_row_key(preview.row_key, preview.data_source_id, preview.native_tenant_id, preview.native_org_id) IS NULL
     )
     OR EXISTS (
       SELECT 1 FROM ${s}.meta_plm_collaboration_previews preview
       WHERE (preview.request_id IS NOT NULL OR preview.binding_id IS NOT NULL OR preview.consumed_at IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM ${s}.meta_plm_collaboration_bindings binding
           WHERE binding.id = preview.binding_id
             AND ${ecoBinding}
             AND binding.data_source_id = preview.data_source_id
             AND binding.native_tenant_id = preview.native_tenant_id
             AND binding.native_org_id = preview.native_org_id
             AND binding.item_id = preview.item_id
             AND binding.current_version_id IS NOT DISTINCT FROM preview.current_version_id
             AND binding.base_id = preview.base_id
             AND binding.source_fingerprint = preview.source_fingerprint
             AND ${s}.meta_plm_collaboration_eco_row_key(preview.row_key, binding.data_source_id, binding.native_tenant_id, binding.native_org_id) IS NOT NULL
         )
     )
     OR EXISTS (
       SELECT 1 FROM ${s}.meta_plm_collaboration_rows row
       LEFT JOIN ${s}.meta_plm_collaboration_bindings binding ON binding.id = row.binding_id
       WHERE binding.id IS NULL
          OR NOT (${ecoBinding})
          OR ${s}.meta_plm_collaboration_eco_row_key(row.row_key, binding.data_source_id, binding.native_tenant_id, binding.native_org_id) IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM ${s}.meta_records canonical
            WHERE canonical.id = row.record_id
              AND canonical.sheet_id = binding.sheet_id
          )
     )
     OR EXISTS (
       SELECT 1 FROM ${s}.meta_plm_collaboration_syncs sync
       LEFT JOIN ${s}.meta_plm_collaboration_bindings binding ON binding.id = sync.binding_id
       WHERE binding.id IS NULL
          OR NOT (${ecoBinding})
          OR EXISTS (
            SELECT 1 FROM jsonb_each(sync.patches) AS entry(key, value)
            WHERE ${s}.meta_plm_collaboration_eco_row_key(entry.value -> 'row_key', binding.data_source_id, binding.native_tenant_id, binding.native_org_id) IS NULL
          )
     )
     OR EXISTS (
       SELECT 1 FROM ${s}.meta_fields field
       WHERE field.property ? 'plmCollaborationSnapshot'
         AND NOT (${positiveMarker(s, liveMarker, 'field.id', 'field.sheet_id')})
     )
     OR EXISTS (
       SELECT 1
       FROM ${s}.meta_config_revisions revision
       CROSS JOIN LATERAL (VALUES (revision.before), (revision.after)) AS blob(document)
       WHERE revision.entity_type = 'field'
         AND jsonb_typeof(blob.document) = 'object'
         AND jsonb_typeof(blob.document -> 'property') = 'object'
         AND (blob.document -> 'property') ? 'plmCollaborationSnapshot'
         AND NOT (${positiveMarker(s, historyMarker, 'revision.entity_id', 'revision.sheet_id')})
     )
     OR EXISTS (
       WITH bad_field AS (
         SELECT field.id
         FROM ${s}.meta_fields field
         WHERE field.property ? 'plmCollaborationSnapshot'
           AND NOT (${positiveMarker(s, liveMarker, 'field.id', 'field.sheet_id')})
         UNION
         SELECT revision.entity_id
         FROM ${s}.meta_config_revisions revision
         CROSS JOIN LATERAL (VALUES (revision.before), (revision.after)) AS blob(document)
         WHERE revision.entity_type = 'field'
           AND jsonb_typeof(blob.document) = 'object'
           AND jsonb_typeof(blob.document -> 'property') = 'object'
           AND (blob.document -> 'property') ? 'plmCollaborationSnapshot'
           AND NOT (${positiveMarker(s, historyMarker, 'revision.entity_id', 'revision.sheet_id')})
       )
       SELECT 1 FROM bad_field
       WHERE EXISTS (
         SELECT 1 FROM ${s}.meta_records record
         WHERE jsonb_typeof(record.data) = 'object'
           AND EXISTS (SELECT 1 FROM jsonb_object_keys(record.data) AS key WHERE key = bad_field.id)
       )
       OR EXISTS (
         SELECT 1 FROM ${s}.meta_record_revisions revision
         WHERE bad_field.id = ANY(revision.changed_field_ids)
            OR (jsonb_typeof(revision.patch) = 'object' AND revision.patch ? bad_field.id)
            OR (jsonb_typeof(revision.snapshot) = 'object' AND revision.snapshot ? bad_field.id)
       )
       OR EXISTS (
         SELECT 1
         FROM ${s}.meta_record_version_markers marker
         JOIN ${s}.meta_record_revisions revision
           ON revision.sheet_id = marker.sheet_id
          AND (
            (revision.record_id = marker.record_id AND revision.version = marker.version)
            OR (marker.operation_id IS NOT NULL AND revision.operation_id = marker.operation_id)
          )
         WHERE bad_field.id = ANY(revision.changed_field_ids)
       )
       OR EXISTS (
         SELECT 1
         FROM ${s}.meta_record_history_operations operation
         JOIN ${s}.meta_record_revisions revision
           ON revision.sheet_id = operation.sheet_id
          AND revision.operation_id = operation.operation_id
         WHERE bad_field.id = ANY(revision.changed_field_ids)
       )
     ) THEN
    ${raise('plm_collaboration_readiness_evidence_present', 'meta_plm_collaboration_evidence_guard')};
  END IF;
END
$evidence$`
}

async function executeAll(db: Kysely<unknown>, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await sql.raw(statement).execute(db)
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await withOwnedTransaction(db, async (trx) => {
    const schema = await servingSchema(trx)
    await sql.raw(isolationSql()).execute(trx)
    await sql.raw(shapeSql(schema, false)).execute(trx)
    await executeAll(trx, helperStatements(schema.ident))
    await executeAll(trx, replacedStatements(schema.ident, true))
    await executeAll(trx, checkStatements(schema.ident, true))
    await sql.raw(shapeSql(schema, true)).execute(trx)
  })
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withOwnedTransaction(db, async (trx) => {
    const schema = await servingSchema(trx)
    await sql.raw(isolationSql()).execute(trx)
    await sql.raw(shapeSql(schema, true)).execute(trx)
    await sql.raw(`LOCK TABLE ${schema.ident}.meta_plm_collaboration_previews IN ACCESS EXCLUSIVE MODE`).execute(trx)
    await sql.raw(`LOCK TABLE ${schema.ident}.meta_plm_collaboration_bindings IN ACCESS EXCLUSIVE MODE`).execute(trx)
    await sql.raw(`LOCK TABLE ${schema.ident}.meta_plm_collaboration_rows IN ACCESS EXCLUSIVE MODE`).execute(trx)
    await sql.raw(`LOCK TABLE ${schema.ident}.meta_plm_collaboration_syncs IN ACCESS EXCLUSIVE MODE`).execute(trx)
    await sql.raw(`LOCK TABLE ${schema.ident}.meta_fields IN SHARE MODE NOWAIT`).execute(trx)
    await sql.raw(`LOCK TABLE ${schema.ident}.meta_records IN SHARE MODE NOWAIT`).execute(trx)
    await sql.raw(`LOCK TABLE ${schema.ident}.meta_config_revisions IN SHARE MODE NOWAIT`).execute(trx)
    await sql.raw(`LOCK TABLE ${schema.ident}.meta_record_revisions IN SHARE MODE NOWAIT`).execute(trx)
    await sql.raw(`LOCK TABLE ${schema.ident}.meta_record_version_markers IN SHARE MODE NOWAIT`).execute(trx)
    await sql.raw(`LOCK TABLE ${schema.ident}.meta_record_history_operations IN SHARE MODE NOWAIT`).execute(trx)
    await sql.raw(evidenceSql(schema.ident)).execute(trx)
    await executeAll(trx, replacedStatements(schema.ident, false))
    await executeAll(trx, checkStatements(schema.ident, false))
    await executeAll(trx, dropHelpers(schema.ident))
    await sql.raw(shapeSql(schema, false)).execute(trx)
  })
}
