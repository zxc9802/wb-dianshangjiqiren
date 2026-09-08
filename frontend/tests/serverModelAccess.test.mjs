import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadTsModule } from './helpers/loadTsModule.mjs'

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
const sourcePath = path.join(testsRoot, '..', 'app', 'lib', 'server-model-access.ts')

class TestAppError extends Error {
  constructor(message, status = 400, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function loadServerModelAccess(policies = []) {
  const chatModels = await loadTsModule(path.join(testsRoot, '..', 'app', 'lib', 'chat-models.ts'))
  const modelAccess = await loadTsModule(path.join(testsRoot, '..', 'app', 'lib', 'model-access.ts'), {
    './builtin-bots': { GENERIC_CHAT_BOT_ID: '36', QIYA_ENTERPRISE_MANAGEMENT_BOT_ID: '35', VIDEO_BREAKDOWN_BOT_ID: '37' },
    './chat-models': chatModels,
  })
  const prisma = {
    $executeRawUnsafe: async () => 0,
    user: { findUnique: async () => ({ role: 'member' }) },
    userModelAccessPolicy: { findMany: async () => policies },
  }
  return loadTsModule(sourcePath, {
    './auth': { AppError: TestAppError },
    './model-access': modelAccess,
    './prisma': { prisma },
  })
}

test('member model policies preserve per-site allowlists including empty access', async () => {
  const service = await loadServerModelAccess([
    { siteKey: 'main-general', permissions: [{ modelKey: 'gpt-5.4' }] },
    { siteKey: 'video-breakdown', permissions: [] },
  ])

  assert.deepEqual(await service.getUserModelAccessSummary('member-1', 'member'), {
    sites: [
      { siteKey: 'main-general', mode: 'selected', modelKeys: ['gpt-5.4'] },
      { siteKey: 'video-breakdown', mode: 'selected', modelKeys: [] },
    ],
  })
  await service.assertUserCanUseModel('member-1', 'main-general', 'gpt-5.4', 'member')
  for (const site of ['video-breakdown', 'growth-assistant']) {
    await assert.rejects(
      () => service.assertUserCanUseModel('member-1', site, 'gpt-5.4', 'member'),
      (error) => error.status === 403 && error.code === 'MODEL_ACCESS_DENIED',
    )
  }
  await assert.rejects(
    () => service.assertUserCanUseModel('member-1', 'main-general', 'gpt-5.6-luna', 'member'),
    (error) => error.status === 403 && error.code === 'MODEL_ACCESS_DENIED',
  )
})

test('admins always receive default all-model access', async () => {
  const service = await loadServerModelAccess([])
  const summary = await service.getUserModelAccessSummary('admin-1', 'admin')
  assert.equal(summary.sites.length, 4)
  await service.assertUserCanUseModel('admin-1', 'main-general', 'gpt-5.6-luna', 'admin')
})

test('admin input rejects a model that does not belong to the selected site', async () => {
  const service = await loadServerModelAccess([])
  assert.throws(
    () => service.normalizeSelectedModelAccessSites([
      { siteKey: 'kb-chat', mode: 'selected', modelKeys: ['gpt-5.4'] },
    ]),
    (error) => error.code === 'INVALID_MODEL_ACCESS_MODEL',
  )
})

test('unconfigured members are denied on direct model calls, including role lookup', async () => {
  const service = await loadServerModelAccess([])
  for (const role of ['member', undefined]) {
    await assert.rejects(
      () => service.assertUserCanUseModel('member-1', 'main-general', 'gpt-5.6-luna', role),
      (error) => error.status === 403 && error.code === 'MODEL_ACCESS_DENIED',
    )
  }
})
