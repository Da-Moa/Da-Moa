import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const root = resolve('src')
const files = readdirSync(root, { recursive: true }).map(file => resolve(root, String(file)))
  .filter(file => /\.(?:ts|tsx|mjs)$/.test(file) && !file.includes('/test/') && !file.endsWith('.d.ts') && !file.includes('/generated/'))
const sources = new Map(files.map(file => [file, ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)]))
const graph = new Map<string, string[]>()
for (const [file, source] of sources) {
  const imports: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text)
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      assert.ok(ts.isStringLiteral(node.arguments[0]), `Uninspectable import: ${file}`)
      imports.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (file.includes('/backend/')) assert.ok(!imports.some(value => value.startsWith('next/')), `Backend depends on Next: ${file}`)
  const dependencies = imports.filter(value => value.startsWith('.') && !/\.(css|png|svg|woff2)$/.test(value)).map(value => {
    const path = resolve(dirname(file), value)
    if (path.includes('/generated/prisma/')) return undefined
    const target = [path, path + '.ts', path + '.tsx', path + '.mjs', path + '/index.ts'].find(candidate => sources.has(candidate))
    assert.ok(target, `Missing import: ${file} -> ${value}`)
    return target
  }).filter((value): value is string => value !== undefined)
  const owner = file.match(/\/backend\/domain\/(group|health|settle|user)\//)?.[1]
  if (owner) for (const target of dependencies) {
    const domain = target.match(/\/backend\/domain\/(group|health|settle|user)\//)?.[1]
    if (domain && domain !== owner) assert.match(target, /\/(index|native)\.ts$/, `Cross-domain internal import: ${file} -> ${target}`)
  }
  graph.set(file, dependencies)
}
function reachable(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen
  seen.add(file)
  for (const dependency of graph.get(file) ?? []) reachable(dependency, seen)
  return seen
}

test('frontend and shared runtime graphs cannot reach backend; backend cannot reach frontend or app', () => {
  for (const [file, source] of sources) {
    const client = source.statements.some(statement => ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) && statement.expression.text === 'use client')
    if (client || file.includes('/frontend/') || file.includes('/shared/') || file.includes('/app/')) {
      for (const target of reachable(file)) assert.ok(!target.includes('/backend/'), `Client reaches backend: ${file} -> ${target}`)
    }
    if (file.includes('/backend/')) for (const target of reachable(file)) assert.ok(!target.includes('/frontend/') && !target.includes('/app/'), `Backend reaches frontend: ${file} -> ${target}`)
    if (file.includes('/frontend/global/')) for (const target of reachable(file)) assert.ok(!target.includes('/frontend/domain/') && !target.includes('/frontend/page/'), `Global UI reaches domain/page: ${file} -> ${target}`)
  }
})

test('domain controllers/services delegate SQL to repositories and Prisma owns business connections', () => {
  for (const domain of ['group', 'user', 'settle']) for (const area of ['controller', 'service']) {
    const source = readFileSync(`src/backend/domain/${domain}/${area}/${domain}.${area}.ts`, 'utf8')
    assert.doesNotMatch(source, /\.query\s*\(/)
  }
  const group = readFileSync('src/backend/domain/group/repository/group.repository.ts', 'utf8')
  assert.doesNotMatch(group, /\b(rounds|round_members|COMPLETED)\b/)
  const settle = readFileSync('src/backend/domain/settle/repository/settle.repository.ts', 'utf8')
  assert.doesNotMatch(settle, /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:users|groups|group_members|group_invites)\b/i)
  assert.match(readFileSync('src/backend/global/database/prisma.service.ts', 'utf8'), /new PrismaClient\(\{\s*adapter: new PrismaPg/)
  assert.match(readFileSync('prisma/schema.prisma', 'utf8'), /provider\s*=\s*"postgresql"/)
})

test('Nest owns backend routes and guards; transport/common UI retain their responsibilities', () => {
  assert.ok(!files.some(file => file.includes('/app/') && file.endsWith('/route.ts')))
  assert.match(readFileSync('src/backend/domain/app.module.ts', 'utf8'), /provide: APP_GUARD, useClass: JwtGuard/)
  for (const file of ['src/backend/global/util/invalidationUtil.ts', 'src/backend/global/websocket/controller/wsController.mjs']) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /\.query\s*\(|FROM (users|rounds|group_members|settlement_transfers)/)
  }
  for (const target of reachable(resolve(root, 'backend/global/util/invalidationUtil.ts'))) {
    assert.ok(!target.includes('/backend/domain/'), `Invalidation utility reaches domain: ${target}`)
  }
  assert.doesNotMatch(readFileSync('src/frontend/global/util/apiClient.ts', 'utf8'), /uuidV7|\/api\/groups|stale_round|bank_account_conflict/)
  for (const file of ['ui.tsx', 'hooks.ts']) assert.doesNotMatch(readFileSync(`src/frontend/global/util/${file}`, 'utf8'), /stale_round|bank_account_conflict|RoundStatus|onboardingCompletedAt/)
  assert.doesNotMatch(readFileSync('src/backend/domain/user/controller/user.controller.ts', 'utf8'), /cookies\.set/)
})

test('business routes use one HTTP mapping per controller method and class providers', () => {
  for (const domain of ['group', 'settle', 'health', 'user']) {
    const controller = readFileSync(`src/backend/domain/${domain}/controller/${domain}.controller.ts`, 'utf8')
    assert.doesNotMatch(controller, /@All|handle\(/)
    assert.doesNotMatch(readFileSync(`src/backend/domain/${domain}/module/${domain}.module.ts`, 'utf8'), /useValue/)
  }
})
