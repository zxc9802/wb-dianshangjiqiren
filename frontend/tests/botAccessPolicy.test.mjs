import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadTsModule } from './helpers/loadTsModule.mjs'

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(testsRoot, '..', 'app')

const builtinStub = {
  BUILTIN_BOTS: [
    { routeId: '1', name: 'KPI教练', category: '管理工具' },
    { routeId: '36', name: '通用聊天', category: '管理工具' },
  ],
}

async function loadCatalog() {
  return loadTsModule(path.join(appRoot, 'lib', 'bot-access-catalog.ts'), {
    './builtin-bots': builtinStub,
  })
}

async function loadBotAccess() {
  return loadTsModule(path.join(appRoot, 'lib', 'bot-access.ts'))
}

test('unconfigured access allows every official bot', async () => {
  const { canAccessOfficialBot } = await loadBotAccess()
  assert.equal(canAccessOfficialBot({ mode: 'all', botKeys: [] }, '1'), true)
  assert.equal(canAccessOfficialBot({ mode: 'all', botKeys: [] }, 'buyer-show'), true)
})

test('selected access is a strict allowlist and can be empty', async () => {
  const { canAccessOfficialBot } = await loadBotAccess()
  assert.equal(canAccessOfficialBot({ mode: 'selected', botKeys: ['1', '3'] }, '1'), true)
  assert.equal(canAccessOfficialBot({ mode: 'selected', botKeys: ['1', '3'] }, '2'), false)
  assert.equal(canAccessOfficialBot({ mode: 'selected', botKeys: [] }, '1'), false)
})

test('catalog contains builtins and independent tools without custom bots', async () => {
  const { OFFICIAL_BOT_CATALOG, isOfficialBotKey } = await loadCatalog()
  assert.ok(OFFICIAL_BOT_CATALOG.some((bot) => bot.botKey === '1'))
  assert.ok(OFFICIAL_BOT_CATALOG.some((bot) => bot.botKey === 'kb-chat'))
  assert.ok(OFFICIAL_BOT_CATALOG.some((bot) => bot.botKey === 'image-generator'))
  assert.ok(OFFICIAL_BOT_CATALOG.some((bot) => bot.botKey === 'video-workbench'))
  assert.equal(isOfficialBotKey('custom-11111111-1111-4111-8111-111111111111'), false)
})
