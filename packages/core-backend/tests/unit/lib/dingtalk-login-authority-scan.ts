import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { blankSqlComments, builderTable, calledMethod, commentStrippedText, isTestPath, QUERY_BUILDER_WRITERS } from '../../helpers/authorization-input-scan'

// Include the reviewed wrappers as well as their underlying issuers. Taking a reference is
// itself an edge: forwarding a method, destructuring it or importing under an alias is visible
// even when a subsequent call no longer contains the original spelling.
const authority = new Set(`createUserSession createToken refreshToken issueAuthSessionToken registerDingTalkSession readDingTalkLoginContext renewOrdinarySession switchOrdinarySessionOrg signInWeb signInContainer refreshStrictSession switchStrictSessionOrg signInStrictDingTalkWeb signInStrictDingTalkContainer insertStrictSession exchangeCodeForUser exchangeEnterpriseAuthCodeForUser resolveLocalUser activatePendingUser generateState bindDingTalkIdentityToUser unbindSelfManagedDingTalkIdentity enrichMissingOpenIdForRejectedLogin backfillDirectoryAccountOpenIdInTransaction upsertExternalIdentity insertGrantIfAbsent identityRequiresEmptyScope checkEmptyDingTalkScope checkOrdinaryDingTalkSource resolveDingTalkLoginSource guardAdminLegacyGrantSwitch guardAdminLegacyGrantSwitchSet applyDingTalkRepair reanchorDingTalkRepair releaseDingTalkRepair rollbackDingTalkRepair upsertDingTalkGrants applyDirectoryAccountBindInTransaction bindDirectoryAccount unbindDirectoryAccount applyRecyclePurge scrubPurgedUserIdentity applyDirectoryDeprovisionCandidateWrites applyDirectoryHandover finishDirectoryHandover recheckPublicFormGrant evaluateProtectedPublicFormAccess legacyGrantAllowsPublicForm executeDingTalkApprovalCardCallback checkCardConnectionBeforeDispatch applyReviewedBackfill resolveActivationCredentialScope refuseStrictLegacyDingTalkWrite checkLegacyRestoreSource restoreDeprovisionEvent compensateSupersededDenyGrant restoreDeprovisionEventForRequest compensateSupersededDenyGrantForRequest`.split(' '))
const issuerOrTable = /\b(?:createUserSession|createToken|issueAuthSessionToken|jsonwebtoken|socket\.io|user_external_identities|user_external_auth_grants|directory_accounts)\b/i
const table = /\b(?:user_external_identities|user_external_auth_grants|directory_accounts|user_sessions)\b/i
const sqlVerb = /\b(insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?|copy)\s+(?:only\s+)?(?:(?:"?[\w]+"?|\?)\s*\.\s*)?"?(user_external_identities|user_external_auth_grants|directory_accounts|user_sessions)\b/gi
const candidate = new RegExp(`\\b(?:${[...authority].join('|')}|authService|insertInto|deleteFrom|updateTable|mergeInto|replaceInto|user_sessions|user_external_identities|user_external_auth_grants|directory_accounts|jsonwebtoken|HS256|SignJWT|dingtalk-corp-backfill|compensate-orphan-deny|/dingtalk/launch)\\b`, 'i')
const js = /\.[cm]?[jt]sx?$/
const routes = /^\/(?:dev-token|login(?:\/dingtalk\/container)?|register|refresh-token|session-org|password\/change|invite\/accept|dingtalk\/(?:access|callback|launch|unbind)|deprovision(?:-events|\/events)\/:eventId\/(?:restore|reactivate|force-reactivate|compensate-orphan-deny))$/
export const residues = {
  'packages/core-backend/src/.~76fad745edcab853-76FAD745EDCAB853!s9731e18f396d4a8782e5735ca099c4ee-f78bbb.insyncdl': '86b8cc584e07a18002663f618937d1798a31a14b',
  'scripts/.~76fad745edcab853-76FAD745EDCAB853!sf9d263dcd5a04d8396a0912a9c54e0ec-5e53c7.insyncdl': '0ec5f9862d1e2f1fc9b68f1b6f78bba708176dc0',
}

function scope(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name) return n.name.getText()
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      const p = n.parent
      if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && p.name) return p.name.getText()
      if (ts.isCallExpression(p) && p.arguments[0] && ts.isStringLiteralLike(p.arguments[0])) return `${calledMethod(p) ?? 'call'} ${p.arguments[0].text}`
    }
  }
  return 'module'
}

function writes(sql: string): string[] {
  const found: string[] = []
  for (const m of blankSqlComments(sql).matchAll(sqlVerb)) {
    const verb = m[1].split(/\s/)[0].toLowerCase()
    if (m[2].toLowerCase() === 'user_sessions' && !['insert', 'merge', 'copy'].includes(verb)) continue
    // Include every directory account mutation, even if the open_id column is absent, so an
    // indirect column map or a new upsert is visible without interpreting its setter.
    found.push(`${verb} ${m[2].toLowerCase()}`)
  }
  const dynamic = /\b(insert\s+into|delete\s+from|update|merge\s+into|truncate(?:\s+table)?|copy)\s+(?:only\s+)?["`]?\?(?!\.)/gi
  for (const m of blankSqlComments(sql).matchAll(dynamic)) found.push(`dynamic ${m[1].toLowerCase().replace(/\s+/g, ' ')}`)
  return found
}

function literalSql(node: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(s => (literalSql(s.expression) ?? '?') + s.literal.text).join('')
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return (literalSql(node.left) ?? '?') + (literalSql(node.right) ?? '?')
  return undefined
}

export function authoritySites(file: string, text: string): string[] {
  const edges: string[] = []
  for (const name of Object.keys(residues)) {
    if (text.includes(path.basename(name))) edges.push(`reference to ${name}`)
  }
  const dynamicSql = /\b(?:insert\s+into|delete\s+from|update|merge\s+into|truncate|copy)\s+["`]?\$\{/i.test(text)
  if (!dynamicSql && !candidate.test(text) && !candidate.test(text.replace(/['"`]\s*\+\s*['"`]/g, ''))) return edges
  const add = (within: string, token: string) => edges.push(`${within} > ${token}`)
  if (!js.test(file)) {
    const raw = commentStrippedText(file, text)
    for (const op of writes(raw)) add('script', op)
    for (const m of raw.matchAll(/\b(?:createToken|createUserSession|refreshToken|dingtalk-corp-backfill\.ts)\b/g)) add('script', m[0])
    if (/require\(['"]jsonwebtoken['"]\)/.test(raw)) add('script', 'load JWT library')
    if (raw.includes('jsonwebtoken')) for (const _ of raw.matchAll(/\.sign\s*\(/g)) add('script', 'sign JWT')
    if (/HS256/i.test(raw) && /openssl\s+dgst|createHmac\s*\(|hmac\.new\s*\(/.test(raw)) add('script', 'sign HMAC JWT')
    return edges.sort()
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const constants = new Map<string, string>()
  const aliases = new Map<string, string>()
  const resolveName = (node: ts.Expression): string | undefined => {
    const key = ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isElementAccessExpression(node) ? literalSql(node.argumentExpression) : undefined
    return key && (authority.has(key) ? key : aliases.get(key))
  }
  const collectAliases = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && node.propertyName && authority.has(node.propertyName.text)) aliases.set(node.name.text, node.propertyName.text)
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        const sink = resolveName(node.initializer)
        if (sink && sink !== node.name.text) aliases.set(node.name.text, sink)
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const item of node.name.elements) {
          if (!ts.isIdentifier(item.name) || !item.propertyName) continue
          const original = ts.isIdentifier(item.propertyName) || ts.isStringLiteralLike(item.propertyName) ? item.propertyName.text : ''
          if (authority.has(original)) aliases.set(item.name.text, original)
        }
      }
    }
    ts.forEachChild(node, collectAliases)
  }
  collectAliases(source)
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (node.parent.flags & ts.NodeFlags.Const)) {
      const value = literalSql(node.initializer)
      if (value !== undefined) constants.set(node.name.text, value)
    }
    if (ts.isStringLiteralLike(node) && node.text === 'jsonwebtoken') add(scope(node), 'load JWT library')
    if (ts.isStringLiteralLike(node) && /(?:^|\/)dingtalk-corp-backfill(?:\.[cm]?[jt]s)?$/.test(node.text)) add(scope(node), 'load backfill tool')
    if (ts.isIdentifier(node) && node.text === 'SignJWT') add(scope(node), 'JWT constructor')
    if (ts.isElementAccessExpression(node)) {
      const key = literalSql(node.argumentExpression)
      if (key && !ts.isStringLiteralLike(node.argumentExpression) && authority.has(key)) add(scope(node), `computed ${key}`)
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'login' && node.expression.getText().endsWith('authService')) add(scope(node), 'platform password login')
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && aliases.has(node.expression.text)) {
        add(scope(node), `alias ${node.expression.text} for ${aliases.get(node.expression.text)}`)
      }
      const method = calledMethod(node)
      const arg = node.arguments[0]
      if (method && ['get', 'post', 'delete', 'patch'].includes(method) && arg && ts.isStringLiteralLike(arg) && routes.test(arg.text)) add(scope(node), `${method} ${arg.text}`)
      if (method && QUERY_BUILDER_WRITERS.has(method) && arg) {
        const target = builderTable(literalSql(arg) ?? (ts.isIdentifier(arg) ? constants.get(arg.text) ?? '' : ''))
        if (!target || table.test(target)) add(scope(node), `${method} ${target ?? `dynamic ${arg.getText(source)}`}`)
      }
      if (method === 'sign' && text.includes('jsonwebtoken')) add(scope(node), 'sign JWT')
      if ((method ?? node.expression.getText()) === 'createHmac' && /HS256/.test(text)) add(scope(node), 'HMAC in JWT module')
    }
    const name = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : ''
    if (authority.has(name)) {
      // Types and implementations are not references. A new alias, export, injected function or
      // a second call from an already registered function remains a separate census entry.
      const p = node.parent
      const decl = (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p)
        || ts.isPropertySignature(p) || ts.isVariableDeclaration(p)) && p.name === node
      const imported = ts.isImportSpecifier(p) && !p.propertyName
      if (!decl && !imported && !ts.isLiteralTypeNode(p)) add(scope(node), name)
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      const raw = literalSql(node)
      if (raw) for (const op of writes(raw)) {
        const operands = op.startsWith('dynamic ') && ts.isTemplateExpression(node)
          ? node.templateSpans.map(s => s.expression.getText(source).replace(/\s+/g, ' ')).join(', ') : ''
        add(scope(node), op + (operands ? ` [${operands}]` : ''))
      }
      if (ts.isTemplateExpression(node)) { for (const span of node.templateSpans) visit(span.expression); return }
      if (ts.isBinaryExpression(node) && raw && table.test(raw) && writes(raw).length) return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return edges.sort()
}

export function collectAuthoritySites(root: string): Record<string, string[]> {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }).toString().split('\0').filter(Boolean)
  const result: Record<string, string[]> = {}
  for (const file of files) {
    if (!/^(?:packages\/|plugins\/|scripts\/|ops\/|tools\/|apps\/|docker\/|\.github\/|Dockerfile|[^/]+$)/.test(file) || isTestPath(file)) continue
    const full = path.join(root, file)
    const stat = lstatSync(full, { throwIfNoEntry: false })
    if (!stat?.isFile()) continue
    const residual = file.endsWith('.insyncdl')
    if (!residual && !js.test(file) && !/\.(?:sql|sh|bash|ps1|py|yml|yaml|json|vue)$|(?:^|\/)Dockerfile/.test(file) && !(stat.mode & 0o111)) continue
    const bytes = readFileSync(full)
    if (bytes.includes(0)) continue
    const text = bytes.toString('utf8')
    if (residual) {
      if (issuerOrTable.test(text) || Object.prototype.hasOwnProperty.call(residues, file)) {
        const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
        result[file] = [`${stat.mode & 0o111 ? 'executable' : 'data'} blob ${blob}`]
      }
      continue
    }
    const entries = authoritySites(file, text)
    if (entries.length) result[file] = entries
  }
  return result
}
