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
    if (domain === 'Group') for (const target of dependencies) {
      for (const area of ['Frontend', 'Shared']) {
        const directory = resolve(root, `Domain/Group/${area}`) + '/'
        if (target.startsWith(directory) && !file.includes('/Domain/Group/')) assert.equal(target, directory + 'index.ts', `Group internal import: ${file} -> ${target}`)
      }
      if (file.includes('/Domain/Group/Frontend/') && target.includes('/Domain/') && !target.includes('/Domain/Group/')) {
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
