/**
 * JSON + Markdown report writer for Phase 3 release gate.
 *
 * Every report passes through the shared redaction helper before
 * being written to disk.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { redactValue } from './multitable-phase3-release-gate-redact.mjs'

export const REPORT_SCHEMA_VERSION = 1

export function buildReport(input) {
  const enriched = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    ...input,
  }
  return redactValue(enriched)
}

export function renderMarkdown(report) {
  const lines = [
    `# ${report.tool}`,
    '',
    `- Gate: \`${report.gate}\``,
    `- Status: **${report.status}**`,
    `- Exit code: \`${report.exitCode}\``,
  ]
  if (report.startedAt) lines.push(`- Started at: \`${report.startedAt}\``)
  if (report.completedAt) lines.push(`- Completed at: \`${report.completedAt}\``)
  if (report.deferral) lines.push(`- Deferral: ${report.deferral}`)
  if (report.reason) lines.push(`- Reason: ${report.reason}`)

  if (Array.isArray(report.requiredEnv) && report.requiredEnv.length) {
    lines.push('', '## Required env', '')
    for (const name of report.requiredEnv) lines.push(`- \`${name}\``)
  }
  if (Array.isArray(report.missingEnv) && report.missingEnv.length) {
    lines.push('', '## Missing env', '')
    for (const name of report.missingEnv) lines.push(`- \`${name}\``)
  }
  if (Array.isArray(report.children) && report.children.length) {
    lines.push('', '## Children', '', '| Gate | Status | Exit code |', '| --- | --- | ---: |')
    for (const child of report.children) {
      lines.push(`| \`${child.gate}\` | ${child.status} | ${child.exitCode} |`)
    }
  }
  return `${lines.join('\n')}\n`
}

export function writeReport({ outputJson, outputMd, report }) {
  const redacted = redactValue(report)
  mkdirSync(path.dirname(outputJson), { recursive: true })
  mkdirSync(path.dirname(outputMd), { recursive: true })
  writeFileSync(outputJson, `${JSON.stringify(redacted, null, 2)}\n`, 'utf8')
  writeFileSync(outputMd, renderMarkdown(redacted), 'utf8')
  return { outputJson, outputMd, report: redacted }
}
