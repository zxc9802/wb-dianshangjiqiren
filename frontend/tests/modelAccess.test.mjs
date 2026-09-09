import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadTsModule } from './helpers/loadTsModule.mjs'

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
const sourcePath = path.join(testsRoot, '..', 'app', 'lib', 'model-access.ts')

async function loadModelAccess() {
  return loadTsModule(sourcePath, {
    './builtin-bots': {
      GENERIC_CHAT_BOT_ID: '36',
      QIYA_ENTERPRISE_MANAGEMENT_BOT_ID: '35',
      VIDEO_BREAKDOWN_BOT_ID: '37',
    },
    './chat-models': {
      RESPONSE_MODEL_OPTIONS: [
        { value: 'gemini', label: 'Gemini' },
        { value: 'gpt-5.4', label: 'GPT-5.5' },
        { value: 'gpt-5.6-luna', label: 'GPT-5.6' },
        { value: 'claude-opus-4.6', label: 'Claude Opus 4.6' },
      ],
    },
  })
}

test('four managed entries expose their current selectable models', async () => {
  const modelAccess = await loadModelAccess()

  assert.deepEqual(
    modelAccess.MODEL_ACCESS_SITES.map((site) => site.siteKey),
    ['main-general', 'growth-assistant', 'video-breakdown', 'kb-chat'],
  )
  assert.equal(modelAccess.getModelAccessSiteKeyForBot('36'), 'main-general')
  assert.equal(modelAccess.getModelAccessSiteKeyForBot('35'), 'growth-assistant')
  assert.equal(modelAccess.getModelAccessSiteKeyForBot('37'), 'video-breakdown')
  assert.equal(modelAccess.getModelAccessSiteKeyForBot('1'), 'main-general')
  assert.equal(modelAccess.getModelAccessSiteKeyForBot('custom-example'), 'main-general')
})

test('unconfigured members cannot see models while selected policy is enforced', async () => {
  const modelAccess = await loadModelAccess()
  const summary = {
    sites: [{ siteKey: 'main-general', mode: 'selected', modelKeys: ['gpt-5.4'] }],
  }

  assert.equal(modelAccess.canUseModel(undefined, 'main-general', 'gpt-5.6-luna'), false)
  assert.equal(modelAccess.canUseModel(summary, 'main-general', 'gpt-5.4'), true)
  assert.equal(modelAccess.canUseModel(summary, 'main-general', 'gpt-5.6-luna'), false)
  assert.deepEqual(modelAccess.listAllowedModelKeys(summary, 'main-general'), ['gpt-5.4'])
})

test('model access parser drops unknown sites and models', async () => {
  const modelAccess = await loadModelAccess()
  const parsed = modelAccess.parseModelAccessSummary({
    sites: [
      { siteKey: 'kb-chat', mode: 'selected', modelKeys: ['yunwu-gpt-5.4', 'not-real'] },
      { siteKey: 'not-real', mode: 'selected', modelKeys: ['gpt-5.4'] },
    ],
  })

  assert.deepEqual(parsed, {
    sites: [{ siteKey: 'kb-chat', mode: 'selected', modelKeys: ['yunwu-gpt-5.4'] }],
  })
})

test('missing policies deny every entry, including other sites of a configured member', async () => {
  const access = await loadModelAccess()
  for (const site of access.MODEL_ACCESS_SITES) {
    assert.deepEqual(access.listAllowedModelKeys({ sites: [] }, site.siteKey), [])
  }
  assert.deepEqual(access.listAllowedModelKeys({ sites: [
    { siteKey: 'main-general', mode: 'selected', modelKeys: ['gpt-5.4'] },
  ] }, 'growth-assistant'), [])
  assert.equal(access.canUseModel({ sites: [] }, 'main-general', 'not-real'), false)
})


test('ordinary and custom main-site bots share the explicit model allowlist', async () => {
  const access = await loadModelAccess()
  const summary = { sites: [
    { siteKey: 'main-general', mode: 'selected', modelKeys: ['gpt-5.4'] },
  ] }
  for (const botId of ['1', '2', '34', '36', 'custom-example']) {
    const site = access.getModelAccessSiteKeyForBot(botId)
    assert.deepEqual(access.listAllowedModelKeys(summary, site), ['gpt-5.4'])
    assert.equal(access.canUseModel(summary, site, 'gpt-5.6-luna'), false)
    assert.deepEqual(access.listAllowedModelKeys(undefined, site), [])
  }
})
