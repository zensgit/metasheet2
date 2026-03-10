import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const repoRoot = process.cwd()
const dispatchScript = path.join(repoRoot, 'scripts/ops/attendance-run-workflow-dispatch.sh')

function runBash(scriptPath, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })

    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      resolve({
        status: code,
        stdout,
        stderr,
      })
    })
  })
}

function writeExecutable(filePath, content) {
  writeFileSync(filePath, content, 'utf8')
  chmodSync(filePath, 0o755)
}

function writeGhStub(dir) {
  const ghPath = path.join(dir, 'gh')
  const script = `#!/usr/bin/env bash
set -euo pipefail
state_file="\${GH_STUB_STATE_FILE:?}"
calls_file="\${GH_STUB_CALLS_FILE:?}"
mode="\${GH_STUB_MODE:-success}"
run_id="\${GH_STUB_RUN_ID:-123456}"
run_branch="\${GH_STUB_BRANCH:-main}"

echo "$*" >> "$calls_file"

if [[ "$1" == "workflow" && "$2" == "run" ]]; then
  count=0
  if [[ -f "$state_file" ]]; then
    count="$(cat "$state_file")"
  fi
  if [[ "$mode" == "fallback-profile" && "$count" == "0" ]]; then
    echo "1" > "$state_file"
    echo 'could not create workflow dispatch event: HTTP 422: Unexpected inputs provided: ["profile"]' >&2
    exit 1
  fi
  echo "$((count + 1))" > "$state_file"
  exit 0
fi

if [[ "$1" == "run" && "$2" == "list" ]]; then
  cat <<JSON
[{"databaseId":$run_id,"createdAt":"2099-01-01T00:00:00Z","event":"workflow_dispatch","headBranch":"$run_branch","url":"https://example.invalid/runs/$run_id","name":"stub","status":"completed"}]
JSON
  exit 0
fi

if [[ "$1" == "run" && "$2" == "watch" ]]; then
  exit 0
fi

if [[ "$1" == "run" && "$2" == "download" ]]; then
  exit 0
fi

echo "unsupported gh command: $*" >&2
exit 2
`
  writeExecutable(ghPath, script)
}

test('attendance-run-workflow-dispatch retries without unsupported workflow inputs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-dispatch-fallback-'))
  const stateFile = path.join(dir, 'gh-state.txt')
  const callsFile = path.join(dir, 'gh-calls.log')
  try {
    writeFileSync(stateFile, '0', 'utf8')
    writeFileSync(callsFile, '', 'utf8')
    writeGhStub(dir)

    const result = await runBash(
      dispatchScript,
      ['attendance-import-perf-baseline.yml', 'branch=main', 'profile=high-scale'],
      {
        PATH: `${dir}:${process.env.PATH || ''}`,
        GH_STUB_MODE: 'fallback-profile',
        GH_STUB_STATE_FILE: stateFile,
        GH_STUB_CALLS_FILE: callsFile,
        GH_STUB_RUN_ID: '654321',
        GH_STUB_BRANCH: 'main',
        TIMEOUT_SECONDS: '30',
        POLL_SECONDS: '1',
      },
    )

    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.match(result.stdout, /RUN_ID=654321/)
    assert.match(result.stderr, /rejected unsupported inputs/i)

    const calls = readFileSync(callsFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line.startsWith('workflow run attendance-import-perf-baseline.yml'))

    assert.equal(calls.length, 2)
    assert.match(calls[0], /-f profile=high-scale/)
    assert.doesNotMatch(calls[1], /profile=high-scale/)
    assert.match(calls[1], /-f branch=main/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attendance-run-workflow-dispatch keeps single dispatch when workflow accepts all inputs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-dispatch-success-'))
  const stateFile = path.join(dir, 'gh-state.txt')
  const callsFile = path.join(dir, 'gh-calls.log')
  try {
    writeFileSync(stateFile, '0', 'utf8')
    writeFileSync(callsFile, '', 'utf8')
    writeGhStub(dir)

    const result = await runBash(
      dispatchScript,
      ['attendance-daily-gate-dashboard.yml', 'branch=main', 'lookback_hours=24'],
      {
        PATH: `${dir}:${process.env.PATH || ''}`,
        GH_STUB_MODE: 'success',
        GH_STUB_STATE_FILE: stateFile,
        GH_STUB_CALLS_FILE: callsFile,
        GH_STUB_RUN_ID: '123456',
        GH_STUB_BRANCH: 'main',
        TIMEOUT_SECONDS: '30',
        POLL_SECONDS: '1',
      },
    )

    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.match(result.stdout, /RUN_ID=123456/)

    const workflowCalls = readFileSync(callsFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line.startsWith('workflow run attendance-daily-gate-dashboard.yml'))

    assert.equal(workflowCalls.length, 1)
    assert.match(workflowCalls[0], /-f lookback_hours=24/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
