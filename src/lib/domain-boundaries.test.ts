import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

for (const [namespace, domain] of [['Domain', 'Health'], ['Domain', 'Group'], ['Domain', 'User'], ['Domain', 'Settle'], ['Global', 'Auth'], ['Global', 'Util'], ['Global', 'Websocket']]) test(`${namespace}/${domain} encapsulation blocks client imports and access to internal backend modules`, () => {
  const root = resolve('src')
  const backend = resolve(root, `${namespace}/${domain}/Backend`) + '/'
  const shared = resolve(root, `${namespace}/${domain}/Shared`) + '/'
  const entry = backend + 'index.ts'
  const files = readdirSync(root, { recursive: true }).map(file => resolve(root, String(file)))
    .filter(file => /\.(?:ts|tsx|mjs)$/.test(file) && !file.includes('.test.') && !file.endsWith('.d.ts'))
  const sources = new Map(files.map(file => [file, ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)]))
  const graph = new Map<string, string[]>()
  for (const [file, source] of sources) {
    const imports: string[] = []
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text)
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
        assert.ok(node.arguments[0] && ts.isStringLiteral(node.arguments[0]), `Cannot inspect dynamic import in ${file}`)
        imports.push(node.arguments[0].text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (file.startsWith(backend)) assert.ok(imports.includes('server-only'), `Missing server-only marker: ${file}`)
    const dependencies = imports.filter(specifier => specifier.startsWith('.')).flatMap(specifier => {
      const path = resolve(dirname(file), specifier)
      const target = [path, path + '.ts', path + '.tsx', path + '.mjs', path + '/index.ts'].find(candidate => sources.has(candidate))
      return target ? [target] : []
    })
    graph.set(file, dependencies)
    if (['Group', 'User', 'Settle'].includes(domain)) for (const target of dependencies) {
      for (const area of ['Frontend', 'Shared']) {
        const directory = resolve(root, `Domain/${domain}/${area}`) + '/'
        if (target.startsWith(directory) && !file.includes(`/Domain/${domain}/`)) assert.equal(target, directory + 'index.ts', `${domain} internal import: ${file} -> ${target}`)
      }
      if (file.includes(`/Domain/${domain}/Frontend/`) && target.includes('/Domain/') && !target.includes(`/Domain/${domain}/`)) {
        assert.match(target, /\/(Frontend|Shared)\/index\.ts$/, `Other domain frontend internal import: ${file} -> ${target}`)
      }
    }
    for (const target of dependencies) {
      if (target.startsWith(backend) && !file.startsWith(backend)) assert.equal(target, entry, `${domain} internal import: ${file} -> ${target}`)
      if (file.startsWith(backend) && target.includes('/Domain/') && !target.includes(`/Domain/${domain}/`)) {
        assert.match(target, /\/(Backend|Shared)\/index\.ts$/, `Other domain internal import: ${file} -> ${target}`)
      }
    }
  }
  const reachable = (file: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(file)) return seen
    seen.add(file)
    for (const dependency of graph.get(file) ?? []) reachable(dependency, seen)
    return seen
  }
  for (const [file, source] of sources) {
    const client = source.statements.some(statement => ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) && statement.expression.text === 'use client')
    if (client || file.startsWith(shared) || file.includes('/Frontend/')) {
      for (const target of reachable(file)) assert.ok(!target.startsWith(backend), `Client/shared reaches ${domain} backend: ${file} -> ${target}`)
    }
    if (file.startsWith(backend)) {
      for (const target of reachable(file)) {
        assert.ok(!target.includes('/Frontend/') && !target.includes('/app/'), `${domain} backend reaches frontend: ${file} -> ${target}`)
        const dependency = sources.get(target)!
        assert.ok(!dependency.statements.some(statement => ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) && statement.expression.text === 'use client'), `${domain} backend reaches client module: ${target}`)
      }
    }
  }
})

test('User rules and HTTP handlers delegate SQL to repositories and Auth keeps user persistence behind the public entry', () => {
  for (const file of ['Controller/UserController.ts', 'Service/UserService.ts']) {
    const source = readFileSync(resolve('src/Domain/User/Backend', file), 'utf8')
    assert.doesNotMatch(source, /\.query\s*\(/, file)
  }
  const repository = readFileSync(resolve('src/Domain/User/Backend/Repository/UserRepository.ts'), 'utf8')
  assert.doesNotMatch(repository, /\b(?:group_members|round_members|rounds|refresh_sessions)\b/)
  const auth = readFileSync(resolve('src/Global/Auth/Backend/Service/AuthService.ts'), 'utf8')
  assert.doesNotMatch(auth, /\.query\s*\(|\brefresh_sessions\b/)
  for (const path of ['me', 'me/onboarding', 'me/bank-account', 'auth/withdraw']) {
    const source = readFileSync(resolve('src/app/api', path, 'route.ts'), 'utf8')
    assert.match(source, /Domain\/User\/Backend/)
    assert.doesNotMatch(source, /\.query\s*\(|lib\/auth-store|lib\/authorization/)
  }
})

test('Settle HTTP and rules delegate SQL and storage to their owners', () => {
  for (const file of ['Controller/SettleController.ts', 'Service/SettleService.ts']) {
    const source = readFileSync(resolve('src/Domain/Settle/Backend', file), 'utf8')
    assert.doesNotMatch(source, /\.query\s*\(|from ['"](?:sharp|@aws-sdk\/)/, file)
  }
  const repository = readFileSync('src/Domain/Settle/Backend/Repository/SettleRepository.ts', 'utf8')
  assert.doesNotMatch(repository, /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:users|groups|group_members|group_invites|mutation_requests)\b/i)
  assert.doesNotMatch(repository, /\b(?:Response|AppError|withWriteTransaction|withReadTransaction)\b/)
  const route = readFileSync('src/app/api/[...path]/route.ts', 'utf8')
  assert.match(route, /Domain\/Settle\/Backend/)
  assert.doesNotMatch(route, /lib\/round-store|\.query\s*\(|formData|publishRoundInvalidation/)
})
