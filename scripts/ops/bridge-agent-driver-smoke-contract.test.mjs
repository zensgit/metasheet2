import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const scriptPath = new URL('./bridge-agent-driver-smoke.ps1', import.meta.url);
const verifyScriptPath = new URL('./multitable-onprem-package-verify.sh', import.meta.url);

async function readSmokeScript() {
  return readFile(scriptPath, 'utf8');
}

test('driver smoke script remains ASCII-safe for Windows PowerShell 5.1', async () => {
  const bytes = await readFile(scriptPath);
  const nonAscii = [...bytes.entries()].filter(([, byte]) => {
    return byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && (byte < 0x20 || byte > 0x7e);
  });

  assert.deepEqual(nonAscii, []);
});

test('localized SQL login redaction uses Unicode escapes instead of literal CJK', async () => {
  const script = await readSmokeScript();

  for (const marker of [
    '\\u7528\\u6237',
    '\\u4f7f\\u7528\\u8005',
    '\\u767b\\u5165\\u540d',
    '\\u767b\\u5f55\\u540d',
    '\\u767b\\u5f55\\u5931\\u8d25',
    '\\u767b\\u5165\\u5931\\u6557',
  ]) {
    assert.match(script, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(script, /[\u3400-\u9fff]/);
});

test('package verifier rejects non-ASCII driver smoke scripts', async () => {
  const verifyScript = await readFile(verifyScriptPath, 'utf8');

  assert.match(verifyScript, /Bridge Agent driver smoke must remain ASCII-safe for Windows PowerShell 5\.1/);
  assert.match(verifyScript, /LC_ALL=C grep -n '\[\^ -~\]'/);
});
