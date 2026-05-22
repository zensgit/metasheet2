import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const taskScriptPath = new URL('./bridge-agent-readonly-scheduled-task.ps1', import.meta.url);

async function readTaskScript() {
  return readFile(taskScriptPath, 'utf8');
}

function escaped(marker) {
  return new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

test('scheduled task helper installs the readonly bridge as a SYSTEM startup task', async () => {
  const script = await readTaskScript();

  for (const marker of [
    "ValidateSet('Install', 'Start', 'Stop', 'Status', 'Uninstall')",
    "MetaSheetReadonlyBridgeAgent",
    "Register-ScheduledTask",
    "New-ScheduledTaskTrigger -AtStartup",
    "New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
    "New-ScheduledTaskAction",
    "-NoProfile",
    "-ExecutionPolicy Bypass",
    "bridge-agent-readonly.ps1",
    "-ConfigPath",
  ]) {
    assert.match(script, escaped(marker));
  }
});

test('scheduled task helper surfaces status without needing bridge secrets', async () => {
  const script = await readTaskScript();

  for (const marker of [
    'Get-ScheduledTaskInfo',
    'LastTaskResult',
    'System.Net.Sockets.TcpClient',
    '127.0.0.1:$Port reachable',
    '127.0.0.1:$Port not reachable',
  ]) {
    assert.match(script, escaped(marker));
  }

  assert.doesNotMatch(script, /Invoke-RestMethod[\s\S]+X-MetaSheet-Bridge-Secret/i);
});

test('scheduled task helper does not print or embed Bridge Agent secrets', async () => {
  const script = await readTaskScript();

  for (const unsafe of [
    /METASHEET_BRIDGE_SQL_PASSWORD\s*=/i,
    /Write-(Host|Output|BridgeTaskInfo)[^\n]*METASHEET_BRIDGE_SQL_PASSWORD/i,
    /Write-(Host|Output|BridgeTaskInfo)[^\n]*METASHEET_BRIDGE_SHARED_SECRET/i,
    /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
    /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
    new RegExp('Pass' + 'word=.*;', 'i'),
  ]) {
    assert.doesNotMatch(script, unsafe);
  }
});
