import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadTsModule } from './helpers/loadTsModule.mjs'

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
const sourcePath = path.join(testsRoot, '..', 'app', 'lib', 'server-bot-access.ts')

class TestAppError extends Error {
  constructor(message, status = 400, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function loadServerBotAccess({ policy }) {
  const calls = { policyReads: 0 }
  const prisma = {
    user: { findUnique: async () => ({ role: 'member' }) },
    userBotAccessPolicy: {
      findUnique: async () => {
        calls.policyReads += 1
        return policy
      },
    },
  }
  const loaded = await loadTsModule(sourcePath, {
    './auth': { AppError: TestAppError },
    './bot-access': {
      canAccessOfficialBot: (summary, key) => summary.mode === 'all' || summary.botKeys.includes(key),
    },
    './bot-access-catalog': { isOfficialBotKey: (key) => ['1', '2', '3'].includes(key) },
    './prisma': { prisma },
  })
  return { module: loaded, calls }
}

test('admin access does not query a policy', async () => {
  const { module, calls } = await loadServerBotAccess({ policy: null })
  assert.deepEqual(await module.getUserBotAccessSummary('admin-1', 'admin'), { mode: 'all', botKeys: [] })
  assert.equal(calls.policyReads, 0)
})

test('missing policy means all while present policy means selected', async () => {
  const missing = await loadServerBotAccess({ policy: null })
  assert.deepEqual(await missing.module.getUserBotAccessSummary('member-1', 'member'), { mode: 'all', botKeys: [] })

  const selected = await loadServerBotAccess({ policy: { permissions: [{ botKey: '1' }, { botKey: '3' }] } })
  assert.deepEqual(await selected.module.getUserBotAccessSummary('member-1', 'member'), { mode: 'selected', botKeys: ['1', '3'] })
})

test('denied access throws before callers perform work', async () => {
  const { module } = await loadServerBotAccess({ policy: { permissions: [] } })
  await assert.rejects(
    () => module.assertUserCanAccessOfficialBot('member-1', '1', 'member'),
    (error) => error.status === 403 && error.code === 'BOT_ACCESS_DENIED',
  )
})
