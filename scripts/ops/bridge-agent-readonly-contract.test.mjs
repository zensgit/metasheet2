import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const scriptPath = new URL('./bridge-agent-readonly.ps1', import.meta.url);
const configPath = new URL('./fixtures/bridge-agent-readonly/config.example.json', import.meta.url);

async function readScript() {
  return readFile(scriptPath, 'utf8');
}

async function readConfig() {
  return JSON.parse(await readFile(configPath, 'utf8'));
}

test('readonly bridge exposes the BA-M1 HTTP contract only on localhost', async () => {
  const script = await readScript();

  for (const marker of [
    'GET  /health',
    'GET  /objects',
    'GET  /schema/<object>',
    'POST /query/<object>',
    'BA-M1 MVP only supports localhost binding',
    '127.0.0.1',
    'System.Data.SqlClient.SqlConnection',
  ]) {
    assert.match(script, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(script, /start\s+https?:\/\/0\.0\.0\.0/i);
});

test('readonly bridge rejects unsafe query surfaces by code', async () => {
  const script = await readScript();

  for (const marker of [
    'UNKNOWN_OBJECT',
    'INVALID_LIMIT',
    'UNSUPPORTED_FILTERS',
    'RAW_SQL_REJECTED',
    'Raw SQL is not accepted by the readonly Bridge Agent.',
    'SELECT TOP $Limit',
    'ConvertTo-QuotedIdentifier',
    'database.connectTimeoutSec must be between 1 and 120',
    'database.queryTimeoutSec must be between 1 and 300',
  ]) {
    assert.match(script, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(script, /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE)\s+/i);
});

test('example config is localhost-only, credential-by-env, and object-allowlisted', async () => {
  const config = await readConfig();

  assert.equal(config.listen.host, '127.0.0.1');
  assert.equal(config.listen.port, 19091);
  assert.equal(config.auth.mode, 'shared-secret-header');
  assert.equal(config.auth.headerName, 'X-MetaSheet-Bridge-Secret');
  assert.equal(config.auth.sharedSecretEnvVar, 'METASHEET_BRIDGE_SHARED_SECRET');
  assert.equal(config.database.usernameEnvVar, 'METASHEET_BRIDGE_SQL_USERNAME');
  assert.equal(config.database.passwordEnvVar, 'METASHEET_BRIDGE_SQL_PASSWORD');
  assert.equal(config.limits.sampleLimit, 3);
  assert.equal(config.limits.maxLimit, 20);

  assert.deepEqual(Object.keys(config.objects).sort(), ['bom', 'bom_child', 'material']);
  assert.equal(config.objects.material.source, 'v_MetaSheet_MaterialRead');
  assert.equal(config.objects.bom.source, 'v_MetaSheet_BomRead');
  assert.equal(config.objects.bom_child.source, 'v_MetaSheet_BomChildRead');

  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /password["']?\s*:\s*["'](?!<configured)/i);
  const connectionStringPattern = new RegExp('Server=.*' + 'Pass' + 'word=', 'i');
  assert.doesNotMatch(serialized, connectionStringPattern);
});

test('script redacts common credential-bearing error surfaces', async () => {
  const script = await readScript();

  for (const marker of [
    'ConvertTo-RedactedText',
    'ConvertTo-BridgeError',
    'InnerException',
    'data[$keyText]=<redacted>',
    'Login failed for user',
    'Bearer\\s+',
    'eyJ[A-Za-z0-9_-]',
  ]) {
    assert.match(script, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
