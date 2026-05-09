#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TOOL_NAME = 'dingtalk-work-notification-admin-agent-id';
const DEFAULT_API_BASE = 'http://127.0.0.1:8900';
const DEFAULT_TIMEOUT_MS = 15000;

function printUsage() {
  console.log(`Usage:
  node scripts/ops/dingtalk-work-notification-admin-agent-id.mjs --auth-token-file /tmp/admin.jwt --status-only
  node scripts/ops/dingtalk-work-notification-admin-agent-id.mjs --auth-token-file /tmp/admin.jwt --agent-id-file /secure/agent-id.txt --save

Options:
  --api-base <url>                 API base URL. Default: ${DEFAULT_API_BASE}
  --auth-token-file <path>         File containing an admin bearer token.
  --auth-token <token>             Admin bearer token. Prefer --auth-token-file.
  --integration-id <id>            Directory integration id. Falls back to current DingTalk status when possible.
  --agent-id-file <path>           File containing DingTalk work-notification Agent ID.
  --recipient-user-id-file <path>  Optional file containing DingTalk recipient user id for real send test.
  --recipient-user-id <id>         Optional DingTalk recipient user id. Prefer --recipient-user-id-file.
  --status-only                    Only read redacted work-notification status.
  --save                           Save Agent ID after successful API validation.
  --output-json <path>             Write redacted JSON summary.
  --output-md <path>               Write redacted Markdown summary.
  --timeout-ms <ms>                HTTP timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --help                           Show this help.`);
}

function parseArgs(argv) {
  const opts = {
    apiBase: DEFAULT_API_BASE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    statusOnly: false,
    save: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case '--api-base':
        opts.apiBase = readValue();
        break;
      case '--auth-token-file':
        opts.authTokenFile = readValue();
        break;
      case '--auth-token':
        opts.authToken = readValue();
        break;
      case '--integration-id':
        opts.integrationId = readValue();
        break;
      case '--agent-id-file':
        opts.agentIdFile = readValue();
        break;
      case '--recipient-user-id-file':
        opts.recipientUserIdFile = readValue();
        break;
      case '--recipient-user-id':
        opts.recipientUserId = readValue();
        break;
      case '--status-only':
        opts.statusOnly = true;
        break;
      case '--save':
        opts.save = true;
        break;
      case '--output-json':
        opts.outputJson = readValue();
        break;
      case '--output-md':
        opts.outputMd = readValue();
        break;
      case '--timeout-ms':
        opts.timeoutMs = Number(readValue());
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }

  return opts;
}

function readTrimmedFile(filePath, errorCode) {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch (error) {
    const wrapped = new Error(`Unable to read ${filePath}: ${error.message}`);
    wrapped.code = errorCode;
    throw wrapped;
  }
}

function normalizeAgentId(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    const error = new Error('Agent ID file is empty');
    error.code = 'AGENT_ID_FILE_EMPTY';
    throw error;
  }

  if (!/^\d{4,32}$/.test(trimmed)) {
    const error = new Error('Agent ID must be a 4-32 digit numeric string');
    error.code = 'AGENT_ID_INVALID';
    throw error;
  }

  return trimmed;
}

function normalizeOptionalUserId(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.length > 128 || /[\s]/.test(trimmed)) {
    const error = new Error('Recipient user id must be non-empty, <=128 chars, and contain no whitespace');
    error.code = 'RECIPIENT_USER_ID_INVALID';
    throw error;
  }

  return trimmed;
}

function readAuthToken(opts) {
  const token = opts.authTokenFile
    ? readTrimmedFile(opts.authTokenFile, 'AUTH_TOKEN_FILE_READ_FAILED')
    : String(opts.authToken ?? '').trim();

  if (!token) {
    const error = new Error('Admin auth token is required');
    error.code = 'AUTH_TOKEN_MISSING';
    throw error;
  }

  return token;
}

function readAgentId(opts) {
  if (!opts.agentIdFile) {
    const error = new Error('--agent-id-file is required unless --status-only is set');
    error.code = 'AGENT_ID_FILE_REQUIRED';
    throw error;
  }

  return normalizeAgentId(readTrimmedFile(opts.agentIdFile, 'AGENT_ID_FILE_READ_FAILED'));
}

function readRecipientUserId(opts) {
  const value = opts.recipientUserIdFile
    ? readTrimmedFile(opts.recipientUserIdFile, 'RECIPIENT_USER_ID_FILE_READ_FAILED')
    : opts.recipientUserId;

  return normalizeOptionalUserId(value);
}

function createRedactor(values = []) {
  const sensitiveValues = values.filter(Boolean).sort((a, b) => b.length - a.length);
  return (input) => {
    let output = String(input ?? '');
    for (const value of sensitiveValues) {
      output = output.split(value).join('[REDACTED]');
    }

    return output
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
      .replace(/(access_token=)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
      .replace(/\bSEC[a-zA-Z0-9]{20,}\b/g, 'SEC[REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT_REDACTED]');
  };
}

function redactedPath(filePath) {
  if (!filePath) {
    return '';
  }

  const base = path.basename(filePath);
  return base ? `.../${base}` : '[path-redacted]';
}

function addFailure(summary, code, message, detail = {}) {
  summary.failures.push({
    code,
    message,
    ...detail,
  });
}

function normalizeStatusPayload(payload) {
  const body = payload?.data?.status
    ?? payload?.status
    ?? payload?.data?.workNotification
    ?? payload?.workNotification
    ?? payload?.data
    ?? payload
    ?? {};

  const integration = body.integration ?? body.directoryIntegration ?? {};
  const requirements = body.requirements ?? {};

  return {
    configured: Boolean(body.configured),
    available: Boolean(body.available),
    source: body.source ? String(body.source) : '',
    unavailableReason: body.unavailableReason ? String(body.unavailableReason) : '',
    integration: {
      id: integration.id ? String(integration.id) : '',
      name: integration.name ? String(integration.name) : '',
      status: integration.status ? String(integration.status) : '',
    },
    requirements: {
      clientId: Boolean(requirements.clientId),
      clientSecret: Boolean(requirements.clientSecret),
      agentId: Boolean(requirements.agentId),
      tokenCache: requirements.tokenCache ? String(requirements.tokenCache) : '',
    },
  };
}

function normalizeTestPayload(payload) {
  const body = payload?.data?.result ?? payload?.result ?? payload?.data ?? payload ?? {};
  const result = body.result ?? body;
  const notificationResult = result.notificationResult ?? result.deliveryResult ?? {};

  return {
    ok: payload?.ok === undefined ? true : Boolean(payload.ok),
    integrationId: result.integrationId ? String(result.integrationId) : '',
    accessTokenVerified: Boolean(result.accessTokenVerified),
    notificationSent: Boolean(result.notificationSent),
    saved: Boolean(result.saved ?? result.persisted),
    agentId: {
      configured: Boolean(result.agentId?.configured ?? result.agentIdConfigured),
      length: Number(result.agentId?.length ?? result.agentIdLength ?? 0),
      valuePrinted: false,
    },
    notification: {
      errcode: Number.isFinite(Number(notificationResult.errcode)) ? Number(notificationResult.errcode) : null,
      errmsg: notificationResult.errmsg ? String(notificationResult.errmsg) : '',
      requestId: notificationResult.requestId ? String(notificationResult.requestId) : '',
      sent: Boolean(notificationResult.sent ?? result.notificationSent),
    },
  };
}

function getApiMessage(payload, redactor) {
  const error = payload?.error ?? payload?.data?.error ?? {};
  const message = error.message ?? payload?.message ?? payload?.errorMessage ?? '';
  return redactor(message || 'API request failed');
}

async function fetchJson({ apiBase, token, method, endpoint, timeoutMs, body, redactor }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(endpoint, apiBase), {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: redactor(text.slice(0, 500)) };
      }
    }

    return {
      ok: response.ok && payload?.ok !== false,
      status: response.status,
      payload,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: { message: redactor(error.message) },
    };
  } finally {
    clearTimeout(timer);
  }
}

function ensureParent(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function renderMarkdown(summary) {
  const status = summary.status === 'pass' ? 'PASS' : 'BLOCKED';
  const lines = [
    `# DingTalk Work Notification Agent ID Admin Helper Verification`,
    '',
    `- Result: ${status}`,
    `- Generated At: ${summary.generatedAt}`,
    `- API Base: ${summary.apiBase}`,
    `- Auth Token: ${summary.authToken.present ? 'present' : 'missing'} (${summary.authToken.source})`,
    `- Agent ID File: ${summary.agentId.file || 'not provided'}`,
    `- Agent ID Configured In Input: ${summary.agentId.configured ? 'yes' : 'no'}`,
    `- Recipient Provided: ${summary.recipient.present ? 'yes' : 'no'}`,
    `- Save Requested: ${summary.saveRequested ? 'yes' : 'no'}`,
    '',
    `## Status Before`,
    '',
    `- Configured: ${summary.statusBefore?.configured ? 'yes' : 'no'}`,
    `- Available: ${summary.statusBefore?.available ? 'yes' : 'no'}`,
    `- Source: ${summary.statusBefore?.source || 'unknown'}`,
    `- Unavailable Reason: ${summary.statusBefore?.unavailableReason || 'none'}`,
    `- Integration ID Present: ${summary.statusBefore?.integration?.id ? 'yes' : 'no'}`,
    '',
    `## Test Result`,
    '',
    `- Access Token Verified: ${summary.testResult?.accessTokenVerified ? 'yes' : 'no'}`,
    `- DingTalk Notification Sent: ${summary.testResult?.notificationSent ? 'yes' : 'no'}`,
    `- Agent ID Length: ${summary.testResult?.agentId?.length ?? 0}`,
    `- Agent ID Value Printed: no`,
    '',
    `## Save Result`,
    '',
    `- Saved: ${summary.saveResult?.saved ? 'yes' : 'no'}`,
    `- Status After Available: ${summary.statusAfter?.available ? 'yes' : 'no'}`,
    '',
    `## Failures`,
    '',
  ];

  if (summary.failures.length === 0) {
    lines.push('- none');
  } else {
    for (const failure of summary.failures) {
      lines.push(`- ${failure.code}: ${failure.message}`);
    }
  }

  lines.push('', 'Sensitive values are intentionally not printed.');
  return `${lines.join('\n')}\n`;
}

function writeOutputs(summary, opts) {
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  const markdown = renderMarkdown(summary);

  if (opts.outputJson) {
    ensureParent(opts.outputJson);
    writeFileSync(opts.outputJson, json, 'utf8');
  }

  if (opts.outputMd) {
    ensureParent(opts.outputMd);
    writeFileSync(opts.outputMd, markdown, 'utf8');
  }

  if (!opts.outputJson && !opts.outputMd) {
    console.log(json);
  }
}

function buildSummary(opts) {
  return {
    tool: TOOL_NAME,
    generatedAt: new Date().toISOString(),
    status: 'blocked',
    apiBase: opts.apiBase,
    statusOnly: Boolean(opts.statusOnly),
    saveRequested: Boolean(opts.save),
    integrationIdProvided: Boolean(opts.integrationId),
    authToken: {
      present: Boolean(opts.authToken || opts.authTokenFile),
      source: opts.authTokenFile ? 'file' : opts.authToken ? 'argument' : 'missing',
      file: redactedPath(opts.authTokenFile),
    },
    agentId: {
      configured: false,
      length: 0,
      valuePrinted: false,
      file: redactedPath(opts.agentIdFile),
    },
    recipient: {
      present: Boolean(opts.recipientUserId || opts.recipientUserIdFile),
      valuePrinted: false,
      file: redactedPath(opts.recipientUserIdFile),
    },
    statusBefore: null,
    testResult: null,
    saveResult: null,
    statusAfter: null,
    failures: [],
  };
}

async function runWorkflow(opts) {
  const summary = buildSummary(opts);
  const token = readAuthToken(opts);
  let agentId = '';
  let recipientUserId = '';
  const staticRedactor = createRedactor([token]);

  const statusResponse = await fetchJson({
    apiBase: opts.apiBase,
    token,
    method: 'GET',
    endpoint: '/api/admin/directory/dingtalk/work-notification',
    timeoutMs: opts.timeoutMs,
    redactor: staticRedactor,
  });

  if (statusResponse.ok) {
    summary.statusBefore = normalizeStatusPayload(statusResponse.payload);
  } else {
    addFailure(summary, 'STATUS_API_FAILED', getApiMessage(statusResponse.payload, staticRedactor), {
      httpStatus: statusResponse.status,
    });
  }

  if (opts.statusOnly) {
    summary.status = summary.failures.length === 0 ? 'pass' : 'blocked';
    return summary;
  }

  try {
    agentId = readAgentId(opts);
    summary.agentId.configured = true;
    summary.agentId.length = agentId.length;
  } catch (error) {
    addFailure(summary, error.code ?? 'AGENT_ID_READ_FAILED', error.message);
    return summary;
  }

  try {
    recipientUserId = readRecipientUserId(opts);
    summary.recipient.present = Boolean(recipientUserId);
  } catch (error) {
    addFailure(summary, error.code ?? 'RECIPIENT_USER_ID_READ_FAILED', error.message);
    return summary;
  }

  const redactor = createRedactor([token, agentId, recipientUserId]);
  const integrationId = opts.integrationId || summary.statusBefore?.integration?.id || '';
  const testBody = {
    ...(integrationId ? { integrationId } : {}),
    agentId,
    ...(recipientUserId ? { recipientUserId } : {}),
  };

  const testResponse = await fetchJson({
    apiBase: opts.apiBase,
    token,
    method: 'POST',
    endpoint: '/api/admin/directory/dingtalk/work-notification/test',
    timeoutMs: opts.timeoutMs,
    body: testBody,
    redactor,
  });

  if (testResponse.ok) {
    summary.testResult = normalizeTestPayload(testResponse.payload);
  } else {
    addFailure(summary, 'TEST_API_FAILED', getApiMessage(testResponse.payload, redactor), {
      httpStatus: testResponse.status,
    });
  }

  if (opts.save) {
    if (!integrationId) {
      addFailure(summary, 'INTEGRATION_ID_MISSING', 'Cannot save because no DingTalk directory integration id was found');
    } else if (testResponse.ok) {
      const saveResponse = await fetchJson({
        apiBase: opts.apiBase,
        token,
        method: 'PUT',
        endpoint: '/api/admin/directory/dingtalk/work-notification',
        timeoutMs: opts.timeoutMs,
        body: { integrationId, agentId },
        redactor,
      });

      if (saveResponse.ok) {
        summary.saveResult = {
          saved: true,
          integrationIdPresent: true,
          agentIdValuePrinted: false,
        };
      } else {
        addFailure(summary, 'SAVE_API_FAILED', getApiMessage(saveResponse.payload, redactor), {
          httpStatus: saveResponse.status,
        });
      }
    }

    const afterResponse = await fetchJson({
      apiBase: opts.apiBase,
      token,
      method: 'GET',
      endpoint: '/api/admin/directory/dingtalk/work-notification',
      timeoutMs: opts.timeoutMs,
      redactor,
    });

    if (afterResponse.ok) {
      summary.statusAfter = normalizeStatusPayload(afterResponse.payload);
    }
  }

  summary.status = summary.failures.length === 0 ? 'pass' : 'blocked';
  return summary;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return 0;
  }

  const summary = await runWorkflow(opts);
  writeOutputs(summary, opts);
  return summary.status === 'pass' ? 0 : 1;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
