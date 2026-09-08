import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadTsModule } from './helpers/loadTsModule.mjs'

const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'lib')

async function exchange(role, policies) {
  const chatModels = await loadTsModule(path.join(lib, 'chat-models.ts'))
  const access = await loadTsModule(path.join(lib, 'model-access.ts'), {
    './builtin-bots': { GENERIC_CHAT_BOT_ID: '36', QIYA_ENTERPRISE_MANAGEMENT_BOT_ID: '35', VIDEO_BREAKDOWN_BOT_ID: '37' },
    './chat-models': chatModels,
  })
  const tx = {
    videoSsoTicket: {
      findUnique: async () => ({ id: 'ticket', product: 'kb-chat', userId: 'user', expiresAt: new Date(Date.now() + 60000), usedAt: null }),
      updateMany: async () => ({ count: 1 }),
    },
    user: { findUnique: async () => ({ id: 'user', role, isActive: true, accessGrantedAt: new Date(), modelAccessPolicies: policies }) },
  }
  const sso = await loadTsModule(path.join(lib, 'kb-chat-sso.ts'), {
    'node:crypto': crypto,
    './auth': { AppError: Error, assertMemberAccountEnabled: () => {} },
    './prisma': { prisma: { $transaction: async (run) => run(tx) } },
    './server-env': { readServerEnv: () => '' },
    './kb-chat-site': { KB_CHAT_SITE_METADATA: {} },
    './server-model-access': { ensureModelAccessTables: async () => {} },
    './model-access': access,
    './video-sso': { ensureVideoSsoTicketTable: async () => {}, getMainAppUrl: () => '', parseVideoRedirectPath: () => '/' },
  })
  return (await sso.consumeKbChatSsoTicket('ticket')).user.modelAccess
}

test('knowledge-base SSO sends an explicit empty allowlist for unconfigured members', async () => {
  assert.deepEqual(await exchange('member', []), {
    sites: [{ siteKey: 'kb-chat', mode: 'selected', modelKeys: [] }],
  })
})

test('knowledge-base SSO preserves selected models and gives admins every model', async () => {
  assert.deepEqual(await exchange('member', [{ permissions: [{ modelKey: 'yunwu-gpt-5.4' }] }]), {
    sites: [{ siteKey: 'kb-chat', mode: 'selected', modelKeys: ['yunwu-gpt-5.4'] }],
  })
  const admin = await exchange('admin', [])
  assert.equal(admin.sites[0].modelKeys.length, 4)
})
