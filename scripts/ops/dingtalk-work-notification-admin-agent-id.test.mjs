import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const scriptPath = new URL('./dingtalk-work-notification-admin-agent-id.mjs', import.meta.url).pathname;

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-agent-helper-'));
}

function startMockServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : {};
      const request = {
        method: req.method,
        url: req.url,
        body,
        authorization: req.headers.authorization,
      };
      requests.push(request);
      const response = handler(request, requests);
      res.writeHead(response.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.body ?? { ok: true }));
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        apiBase: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function runHelper(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ status: code, signal, stdout, stderr });
    });
  });
}

test('status-only emits redacted status summary', async () => {
  const server = await startMockServer((request) => {
    assert.equal(request.method, 'GET');
    return {
      body: {
        ok: true,
        data: {
          status: {
            configured: false,
            available: false,
            source: 'mixed',
            unavailableReason: 'missing_agent_id',
            integration: { id: 'dir-1', name: 'DingTalk', status: 'active' },
            requirements: { clientId: true, clientSecret: true, agentId: false },
          },
        },
      },
    };
  });

  try {
    const result = await runHelper([
      '--api-base',
      server.apiBase,
      '--auth-token',
      'unit-token',
      '--status-only',
    ]);

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /unit-token/);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, 'pass');
    assert.equal(summary.statusBefore.unavailableReason, 'missing_agent_id');
  } finally {
    await server.close();
  }
});

test('save workflow validates, saves, and never writes raw token, agent id, or recipient', async () => {
  const tmp = makeTmpDir();
  const tokenFile = path.join(tmp, 'admin.jwt');
  const agentFile = path.join(tmp, 'agent-id.txt');
  const recipientFile = path.join(tmp, 'recipient.txt');
  const jsonFile = path.join(tmp, 'summary.json');
  const mdFile = path.join(tmp, 'summary.md');
  writeFileSync(tokenFile, 'unit-token\n', 'utf8');
  writeFileSync(agentFile, '123456789\n', 'utf8');
  writeFileSync(recipientFile, 'recipient-1\n', 'utf8');

  const server = await startMockServer((request, requests) => {
    if (request.method === 'GET') {
      return {
        body: {
          ok: true,
          data: {
            status: {
              configured: requests.length > 2,
              available: requests.length > 2,
              source: requests.length > 2 ? 'database' : 'mixed',
              integration: { id: 'dir-1', name: 'DingTalk', status: 'active' },
              requirements: { clientId: true, clientSecret: true, agentId: requests.length > 2 },
            },
          },
        },
      };
    }

    if (request.method === 'POST') {
      assert.equal(request.body.agentId, '123456789');
      assert.equal(request.body.recipientUserId, 'recipient-1');
      return {
        body: {
          ok: true,
          data: {
            result: {
              integrationId: request.body.integrationId,
              accessTokenVerified: true,
              notificationSent: true,
              agentId: { configured: true, length: 9 },
              notificationResult: { sent: true, errcode: 0, errmsg: 'ok' },
            },
          },
        },
      };
    }

    assert.equal(request.method, 'PUT');
    assert.equal(request.body.agentId, '123456789');
    return { body: { ok: true } };
  });

  try {
    const result = await runHelper([
      '--api-base',
      server.apiBase,
      '--auth-token-file',
      tokenFile,
      '--agent-id-file',
      agentFile,
      '--recipient-user-id-file',
      recipientFile,
      '--save',
      '--output-json',
      jsonFile,
      '--output-md',
      mdFile,
    ]);

    assert.equal(result.status, 0);
    const combined = `${result.stdout}\n${result.stderr}\n${readFileSync(jsonFile, 'utf8')}\n${readFileSync(mdFile, 'utf8')}`;
    assert.doesNotMatch(combined, /unit-token/);
    assert.doesNotMatch(combined, /123456789/);
    assert.doesNotMatch(combined, /recipient-1/);
    const summary = JSON.parse(readFileSync(jsonFile, 'utf8'));
    assert.equal(summary.status, 'pass');
    assert.equal(summary.agentId.length, 9);
    assert.equal(summary.testResult.notificationSent, true);
    assert.equal(summary.saveResult.saved, true);
  } finally {
    await server.close();
  }
});

test('empty agent id file blocks before test and keeps output redacted', async () => {
  const tmp = makeTmpDir();
  const agentFile = path.join(tmp, 'agent-id.txt');
  writeFileSync(agentFile, '\n', 'utf8');

  const server = await startMockServer(() => ({
    body: {
      ok: true,
      data: {
        status: {
          configured: false,
          available: false,
          integration: { id: 'dir-1', name: 'DingTalk', status: 'active' },
        },
      },
    },
  }));

  try {
    const result = await runHelper([
      '--api-base',
      server.apiBase,
      '--auth-token',
      'unit-token',
      '--agent-id-file',
      agentFile,
      '--save',
    ]);

    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, 'blocked');
    assert.equal(summary.failures[0].code, 'AGENT_ID_FILE_EMPTY');
    assert.equal(server.requests.length, 1);
    assert.doesNotMatch(result.stdout, /unit-token/);
  } finally {
    await server.close();
  }
});

test('api errors are redacted', async () => {
  const tmp = makeTmpDir();
  const agentFile = path.join(tmp, 'agent-id.txt');
  writeFileSync(agentFile, '123456789\n', 'utf8');

  const server = await startMockServer((request) => {
    if (request.method === 'GET') {
      return {
        body: {
          ok: true,
          data: { status: { integration: { id: 'dir-1' } } },
        },
      };
    }

    return {
      status: 400,
      body: {
        ok: false,
        error: { message: 'bad agent 123456789 for bearer unit-token' },
      },
    };
  });

  try {
    const result = await runHelper([
      '--api-base',
      server.apiBase,
      '--auth-token',
      'unit-token',
      '--agent-id-file',
      agentFile,
    ]);

    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /123456789/);
    assert.doesNotMatch(result.stdout, /unit-token/);
    assert.match(result.stdout, /\[REDACTED\]/);
  } finally {
    await server.close();
  }
});
