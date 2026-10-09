import assert from 'node:assert/strict'
import { constants, readFileSync } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

function verifier() {
  const source = readFileSync(new URL('../../scripts/verify-recovery-local-backup.mts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('backup.mts', source, ts.ScriptTarget.ESNext, true)
  const functions = parsed.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && ['assertPathMissing', 'readCode'].includes(statement.name?.text ?? ''))
  expect(functions).toHaveLength(2)
  // Run the actual absence witness without the native driver's top-level entrypoint.
  const program = ts.transpileModule(`${functions.map(fn => fn.getText(parsed)).join('\n')}\nassertPathMissing`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  })
  return new Script(program.outputText).runInNewContext({ assert, access, constants, lstat }) as (path: string) => Promise<void>
}

describe('local backup path absence witness', () => {
  it('accepts a genuinely absent entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tm-local-backup-path-witness-'))
    try {
      await expect(verifier()(join(root, 'missing'))).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['file', 'directory', 'symlink', 'dangling symlink'] as const)('refuses an existing %s entry', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'tm-local-backup-path-witness-'))
    const entry = join(root, 'entry')
    try {
      if (kind === 'file') await writeFile(entry, 'synthetic-only', { mode: 0o600 })
      else if (kind === 'directory') await mkdir(entry, { mode: 0o700 })
      else {
        const target = join(root, 'target')
        if (kind === 'symlink') await writeFile(target, 'synthetic-only', { mode: 0o600 })
        await symlink(target, entry, 'file')
      }
      await expect(verifier()(entry)).rejects.toMatchObject({ code: 'ERR_ASSERTION' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
