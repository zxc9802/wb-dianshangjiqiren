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
  const modelsBySite = {
    'main-general': ['gemini', 'gpt-5.4', 'gpt-5.6-luna', 'claude-opus-4.6'],
    'growth-assistant': ['gemini', 'gpt-5.4', 'gpt-5.6-luna', 'claude-opus-4.6'],
    'video-breakdown': ['gemini', 'gpt-5.4', 'gpt-5.6-luna', 'claude-opus-4.6'],
    'kb-chat': ['gemini-3.1-pro-preview', 'yunwu-gemini-3-flash-preview', 'yunwu-gpt-5.4', 'yunwu-gpt-5.6'],
  }
  const prisma = {
    $executeRawUnsafe: async () => 0,
    user: { findUnique: async () => ({ role: 'member' }) },
    userModelAccessPolicy: { findMany: async () => policies },
  }
  return loadTsModule(sourcePath, {
    './auth': { AppError: TestAppError },
    './model-access': {
      DEFAULT_MODEL_ACCESS: { sites: [] },
      canUseModel: (summary, siteKey, modelKey) => {
        const site = summary.sites.find((item) => item.siteKey === siteKey)
        return !site || site.modelKeys.includes(modelKey)
      },
      isModelAccessSiteKey: (siteKey) => Object.hasOwn(modelsBySite, siteKey),
      isModelKeyForSite: (siteKey, modelKey) => modelsBySite[siteKey]?.includes(modelKey) === true,
    },
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
  await assert.rejects(
    () => service.assertUserCanUseModel('member-1', 'main-general', 'gpt-5.6-luna', 'member'),
    (error) => error.status === 403 && error.code === 'MODEL_ACCESS_DENIED',
  )
})

test('admins always receive default all-model access', async () => {
  const service = await loadServerModelAccess([])
  assert.deepEqual(await service.getUserModelAccessSummary('admin-1', 'admin'), { sites: [] })
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
