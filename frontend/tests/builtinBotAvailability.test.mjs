import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sourcePath = path.join(__dirname, '..', 'app', 'lib', 'server-conversations.ts')

class TestAppError extends Error {
  constructor(message, status = 400, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function loadServerConversations(prisma, allowedBotKeys = ['1']) {
  const source = await readFile(sourcePath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const loadedModule = { exports: {} }
  const require = (specifier) => {
    if (specifier === '@prisma/client') return { Prisma: {} }
    if (specifier === './auth') return { AppError: TestAppError }
    if (specifier === './prisma') return { prisma }
    if (specifier === './server-bot-access') {
      return {
        assertUserCanAccessOfficialBot: async (_userId, botKey) => {
          if (!allowedBotKeys.includes(botKey)) {
            throw new TestAppError('Denied', 403, 'BOT_ACCESS_DENIED')
          }
        },
      }
    }
    if (specifier === './builtin-bots') {
      return {
        BUILTIN_BOT_MAP: {
          1: {
            routeId: '1',
            slug: 'kpi-coach',
            name: 'KPI教练',
            category: '管理工具',
            icon: 'target',
            description: '设计可量化的 KPI 体系，让团队目标清晰可追踪。',
            pointsPerUse: 5,
            welcome: '你好，你们团队现在是怎么做绩效考核的？',
          },
        },
      }
    }
    if (specifier === './systemPrompts') {
      return {
        getSystemPromptBySortOrder: (_sortOrder, fallback) => fallback,
      }
    }
    throw new Error(`Unexpected import: ${specifier}`)
  }

  const execute = new Function('require', 'module', 'exports', compiled)
  execute(require, loadedModule, loadedModule.exports)
  return loadedModule.exports
}

test('missing configured builtin bot is restored before a conversation starts', async () => {
  const upsertCalls = []
  const prisma = {
    bot: {
      findFirst: async () => null,
      upsert: async (args) => {
        upsertCalls.push(args)
        return {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'KPI教练',
          icon: 'target',
          category: '管理工具',
          pointsPerUse: 5,
          sortOrder: 1,
          isActive: true,
        }
      },
    },
  }
  const { resolveConversationBotTarget } = await loadServerConversations(prisma)

  const target = await resolveConversationBotTarget('user-1', '1')

  assert.equal(target.routeId, '1')
  assert.equal(target.name, 'KPI教练')
  assert.equal(target.botId, '11111111-1111-4111-8111-111111111111')
  assert.equal(upsertCalls.length, 1)
  assert.equal(upsertCalls[0].where.slug, 'kpi-coach')
})

test('existing active builtin bot is reused without a database write', async () => {
  let upsertCount = 0
  const prisma = {
    bot: {
      findFirst: async () => ({
        id: '22222222-2222-4222-8222-222222222222',
        name: 'KPI教练',
        icon: 'target',
        category: '管理工具',
        pointsPerUse: 5,
        sortOrder: 1,
        isActive: true,
      }),
      upsert: async () => {
        upsertCount += 1
        throw new Error('upsert should not run')
      },
    },
  }
  const { resolveConversationBotTarget } = await loadServerConversations(prisma)

  const target = await resolveConversationBotTarget('user-1', '1')

  assert.equal(target.botId, '22222222-2222-4222-8222-222222222222')
  assert.equal(upsertCount, 0)
})

test('unknown numeric bot routes still return Bot not found', async () => {
  let upsertCount = 0
  const prisma = {
    bot: {
      findFirst: async () => null,
      upsert: async () => {
        upsertCount += 1
        throw new Error('upsert should not run')
      },
    },
  }
  const { resolveConversationBotTarget } = await loadServerConversations(prisma)

  await assert.rejects(
    () => resolveConversationBotTarget('user-1', '999'),
    (error) => error instanceof TestAppError && error.message === 'Bot not found' && error.status === 404,
  )
  assert.equal(upsertCount, 0)
})

test('restricted builtin bot is denied before restore or conversation creation', async () => {
  const calls = { botReads: 0, botWrites: 0 }
  const prisma = {
    bot: {
      findFirst: async () => {
        calls.botReads += 1
        return null
      },
      upsert: async () => {
        calls.botWrites += 1
        return null
      },
    },
  }
  const { resolveConversationBotTarget } = await loadServerConversations(prisma, ['2'])
  await assert.rejects(
    () => resolveConversationBotTarget('user-1', '1'),
    (error) => error.status === 403 && error.code === 'BOT_ACCESS_DENIED',
  )
  assert.equal(calls.botReads, 0)
  assert.equal(calls.botWrites, 0)
})
