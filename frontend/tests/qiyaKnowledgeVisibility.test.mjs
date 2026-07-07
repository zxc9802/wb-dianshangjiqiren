import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..', 'app')

const files = {
  adminPanel: path.join(appRoot, 'components', 'AdminBotPanel.tsx'),
  adminBotRoute: path.join(appRoot, 'api', 'admin', 'bots', '[id]', 'route.ts'),
  adminBotDocsRoute: path.join(appRoot, 'api', 'admin', 'bots', '[id]', 'documents', 'route.ts'),
  adminBotDocDetailRoute: path.join(appRoot, 'api', 'admin', 'bots', '[id]', 'documents', '[docId]', 'route.ts'),
  builtinKnowledgeRoute: path.join(appRoot, 'api', 'admin', 'builtin-knowledge', '[sourceId]', 'route.ts'),
}

test('qiya knowledge documents are hidden from the admin frontend', async () => {
  const source = await readFile(files.adminPanel, 'utf8')

  assert.match(source, /shouldShowKnowledgeDocuments/)
  assert.match(source, /shouldHideQiyaKnowledgeDocuments\(botId, botKind\)/)
  assert.match(source, /shouldShowKnowledgeDocuments\s*\?/)
})

test('qiya builtin knowledge documents are not returned by admin document APIs', async () => {
  const adminBotRoute = await readFile(files.adminBotRoute, 'utf8')
  const docsRoute = await readFile(files.adminBotDocsRoute, 'utf8')
  const docDetailRoute = await readFile(files.adminBotDocDetailRoute, 'utf8')

  assert.match(adminBotRoute, /isQiyaEnterpriseManagementRouteId\(String\(bot\.sortOrder\)\)/)
  assert.match(adminBotRoute, /\?\s*\[\]/)
  assert.match(docsRoute, /isQiyaEnterpriseManagementRouteId\(String\(bot\.sortOrder\)\)/)
  assert.match(docsRoute, /return Response\.json\(\{ success: true, data: \[\] \}\)/)
  assert.match(docDetailRoute, /isQiyaEnterpriseManagementRouteId\(String\(bot\.sortOrder\)\)/)
  assert.match(docDetailRoute, /throw new AppError\('文档不存在'/)
})

test('qiya builtin knowledge source content cannot be read through admin frontend API', async () => {
  const source = await readFile(files.builtinKnowledgeRoute, 'utf8')

  assert.match(source, /assertBuiltinKnowledgeHidden\(\)/)
  assert.match(source, /AppError\('知识源不存在'/)
})
