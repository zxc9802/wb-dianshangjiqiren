import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { z } from 'zod'
import { loadTsModule } from './helpers/loadTsModule.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app')
const models = await loadTsModule(path.join(appRoot, 'lib/chat-models.ts'))
const access = await loadTsModule(path.join(appRoot, 'lib/model-access.ts'), {
  './builtin-bots': { QIYA_ENTERPRISE_MANAGEMENT_BOT_ID: '35', VIDEO_BREAKDOWN_BOT_ID: '37' },
  './chat-models': models,
})

for (const route of ['api/chat/route.ts', 'api/conversations/[id]/messages/route.ts']) {
  test(`${route} rejects unauthorized models for ordinary and custom bots before generation`, async () => {
    const sourcePath = path.join(appRoot, route)
    const source = ts.createSourceFile(sourcePath, await readFile(sourcePath, 'utf8'), ts.ScriptTarget.Latest)
    for (const botId of ['1', '34', 'custom-example']) {
      for (const modelKeys of [[], ['gpt-5.4']]) {
        const checked = []
        const stubs = {}
        for (const declaration of source.statements.filter(ts.isImportDeclaration)) {
          const specifier = declaration.moduleSpecifier.text
          // Unexpected downstream work must fail the test instead of calling providers or writing data.
          stubs[specifier] = new Proxy({}, { get: (_, name) => {
            if (name === '__esModule') return true
            return () => { throw new Error(`Unexpected downstream call: ${specifier}.${String(name)}`) }
          } })
          if (specifier.endsWith('/usage-context')) stubs[specifier] = { withUsage: fn => fn }
          if (specifier === 'zod') stubs[specifier] = { z }
          if (specifier.endsWith('/auth')) stubs[specifier] = {
            getAuthUser: async () => ({ id: 'member', role: 'user' }),
            getUserId: async () => 'member',
            errorResponse: error => Response.json({ code: error.code }, { status: error.status || 500 }),
          }
          if (specifier.endsWith('/builtin-bots')) stubs[specifier] = { GENERIC_CHAT_BOT_ID: '36', BUILTIN_BOT_MAP: {} }
          if (specifier.endsWith('/chat-models')) stubs[specifier] = models
          if (specifier.endsWith('/model-access')) stubs[specifier] = access
          if (specifier.endsWith('/server-bot-access')) stubs[specifier] = {
            assertUserCanAccessOfficialBot: async () => {}, assertConversationBotAccess: async () => {},
          }
          if (specifier.endsWith('/prisma')) stubs[specifier] = {
            prisma: { conversation: { findFirst: async () => ({ id: 'conversation', userId: 'member' }) } },
          }
          if (specifier.endsWith('/server-conversations')) stubs[specifier] = {
            getConversationBotPayload: () => ({ kind: botId.startsWith('custom-') ? 'custom' : 'builtin', routeId: botId }),
          }
          if (specifier.endsWith('/server-model-access')) stubs[specifier] = {
            assertUserCanUseModel: async (userId, siteKey, modelKey) => {
              checked.push({ userId, siteKey, modelKey })
              const summary = { sites: [{ siteKey: 'main-general', mode: 'selected', modelKeys }] }
              if (!access.canUseModel(summary, siteKey, modelKey)) {
                throw Object.assign(new Error('Denied'), { status: 403, code: 'MODEL_ACCESS_DENIED' })
              }
            },
          }
        }
        const { POST } = await loadTsModule(sourcePath, stubs)
        const req = new Request('http://localhost/api/chat', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ botId, content: 'test', message: 'test', responseModel: 'gpt-5.6-luna' }),
        })
        const response = await POST(req, { params: Promise.resolve({ id: 'conversation' }) })
        assert.equal(response.status, 403)
        assert.equal((await response.json()).code, 'MODEL_ACCESS_DENIED')
        assert.deepEqual(checked, [{ userId: 'member', siteKey: 'main-general', modelKey: 'gpt-5.6-luna' }])
      }
    }
  })
}
