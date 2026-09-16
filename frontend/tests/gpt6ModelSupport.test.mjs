import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadTsModule } from './helpers/loadTsModule.mjs'

const lib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/lib')
const models = await loadTsModule(path.join(lib, 'chat-models.ts'))
const access = await loadTsModule(path.join(lib, 'model-access.ts'), {
  './chat-models': models,
  './builtin-bots': { QIYA_ENTERPRISE_MANAGEMENT_BOT_ID: '35', VIDEO_BREAKDOWN_BOT_ID: '37' },
})

test('GPT-6 is selectable without changing the default or removing GPT-5.6', () => {
  assert.equal(models.isResponseModel('gpt-6'), true)
  assert.equal(models.isSelectableResponseModel('gpt-6'), true)
  assert.equal(models.getResponseModelLabel('gpt-6'), 'GPT-6')
  assert.equal(models.getOpenAIUpstreamModel('gpt-6'), 'gpt-6-astra')
  assert.equal(models.isSelectableResponseModel('gpt-5.6-luna'), true)
  assert.equal(models.DEFAULT_RESPONSE_MODEL, 'gemini')
})

test('GPT-6 and GPT-5.6 use the same Responses endpoint and API key with distinct models', async () => {
  const calls = []
  const env = { OPENLUX_API_BASE_URL: 'https://openlux.test/v1', OPENLUX_API_KEY: 'shared-test-key' }
  const client = await loadTsModule(path.join(lib, 'yunwu-openai-chat.ts'), {
    './auth': { AppError: Error },
    './server-env': { readServerEnv: key => env[key] },
    './upstream-error': await loadTsModule(path.join(lib, 'upstream-error.ts')),
    './usage-fetch': { usageFetch: async (url, init) => {
      calls.push({ url, authorization: init.headers.Authorization, body: JSON.parse(init.body) })
      return Response.json({ output_text: 'test answer' })
    } },
  })
  for (const modelKey of ['gpt-5.4', 'gpt-5.6-luna', 'gpt-6']) {
    let answer = ''
    await client.streamYunwuOpenAIChat({
      model: models.getOpenAIUpstreamModel(modelKey), systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hello' }], onText: text => { answer += text },
    })
    assert.equal(answer, 'test answer')
  }
  assert.deepEqual(calls.map(call => call.body.model), ['gpt-5.5', 'gpt-5.6-luna', 'gpt-6-astra'])
  for (const call of calls) {
    assert.equal(call.url, 'https://openlux.test/v1/responses')
    assert.equal(call.authorization, 'Bearer shared-test-key')
  }
})

test('GPT-6 needs its own grant in every main-site entry and knowledge-base SSO', () => {
  for (const site of access.MODEL_ACCESS_SITES) {
    const modelKey = site.siteKey === 'kb-chat' ? 'yunwu-gpt-6' : 'gpt-6'
    const oldModelKey = site.siteKey === 'kb-chat' ? 'yunwu-gpt-5.6' : 'gpt-5.6-luna'
    assert.equal(access.isModelKeyForSite(site.siteKey, modelKey), true)
    const selected = access.parseModelAccessSummary({ sites: [{ siteKey: site.siteKey, mode: 'selected', modelKeys: [modelKey] }] })
    assert.deepEqual(access.listAllowedModelKeys(selected, site.siteKey), [modelKey])
    assert.equal(access.canUseModel(access.ALL_MODEL_ACCESS, site.siteKey, modelKey), true)
    assert.equal(access.canUseModel(undefined, site.siteKey, modelKey), false)
    assert.equal(access.canUseModel({ sites: [{ siteKey: site.siteKey, mode: 'selected', modelKeys: [oldModelKey] }] }, site.siteKey, modelKey), false)
  }
})
