import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'
import vm from 'node:vm'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..', 'app')

async function loadTsModule(relativePath) {
  const sourcePath = path.join(appRoot, ...relativePath)
  const source = await readFile(sourcePath, 'utf8')
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const cjsModule = { exports: {} }
  const localRequire = createRequire(sourcePath)
  const stubbedRequire = (specifier) => {
    if (specifier === './auth') {
      return { AppError: class AppError extends Error {
        constructor(message, status = 500) {
          super(message)
          this.status = status
        }
      } }
    }

    if (specifier === './server-env') {
      return { readServerEnv: () => undefined }
    }

    if (specifier === './chat-models') {
      return {
        DEFAULT_WEB_SEARCH_MODE: 'auto',
        isWebSearchMode: (value) => ['auto', 'on', 'off'].includes(value),
      }
    }

    if (specifier === './upstream-error') {
      return {
        looksLikeHtmlPayload: () => false,
        looksLikeTimeoutPayload: () => false,
        normalizeUpstreamErrorMessage: (value) => value,
        truncateForLog: (value) => value,
      }
    }

    if (specifier === './yunwu-openai-chat') {
      return {}
    }

    return localRequire(specifier)
  }
  const context = vm.createContext({
    module: cjsModule,
    exports: cjsModule.exports,
    require: stubbedRequire,
    URL,
    TextDecoder,
    TextEncoder,
  })
  vm.runInContext(transpiled, context, { filename: sourcePath })
  return cjsModule.exports
}

test('chat model options include Claude Opus 4.6', async () => {
  const {
    RESPONSE_MODEL_OPTIONS,
    RESPONSE_MODEL_VALUES,
    WEB_SEARCH_MODE_VALUES,
    DEFAULT_WEB_SEARCH_MODE,
    getOpenAIUpstreamModel,
    getResponseModelLabel,
    getWebSearchModeLabel,
    isSelectableResponseModel,
    isResponseModel,
    isWebSearchMode,
  } = await loadTsModule(['lib', 'chat-models.ts'])

  assert.ok(RESPONSE_MODEL_VALUES.includes('claude-opus-4.6'))
  assert.ok(RESPONSE_MODEL_VALUES.includes('gpt-5.6-luna'))
  assert.equal(isResponseModel('claude-opus-4.6'), true)
  assert.equal(isResponseModel('gemini-deep-thinking'), true)
  assert.equal(isSelectableResponseModel('gemini-deep-thinking'), false)
  assert.deepEqual(
    JSON.parse(JSON.stringify(RESPONSE_MODEL_OPTIONS.map((option) => option.value))),
    ['gemini', 'gpt-5.4', 'gpt-5.6-luna', 'claude-opus-4.6'],
  )
  assert.equal(getResponseModelLabel('gpt-5.4'), 'GPT-5.5')
  assert.equal(getResponseModelLabel('gpt-5.6-luna'), 'GPT-5.6')
  assert.equal(getOpenAIUpstreamModel('gpt-5.4'), 'gpt-5.5')
  assert.equal(getOpenAIUpstreamModel('gpt-5.6-luna'), 'gpt-5.6-luna')
  assert.equal(getOpenAIUpstreamModel('gemini'), null)
  assert.equal(getResponseModelLabel('claude-opus-4.6'), 'Claude Opus 4.6')
  assert.deepEqual(JSON.parse(JSON.stringify(WEB_SEARCH_MODE_VALUES)), ['auto', 'on', 'off'])
  assert.equal(DEFAULT_WEB_SEARCH_MODE, 'auto')
  assert.equal(isWebSearchMode('on'), true)
  assert.equal(getWebSearchModeLabel('off'), '联网关闭')
})

test('Claude Messages response text is extracted from content parts', async () => {
  const { extractClaudeMessageTexts } = await loadTsModule(['lib', 'yunwu-claude-chat.ts'])

  const texts = extractClaudeMessageTexts({
    content: [
      { type: 'text', text: 'Hello' },
      { type: 'thinking', thinking: 'hidden' },
      { text: ' world' },
    ],
  })

  assert.deepEqual(JSON.parse(JSON.stringify(texts)), ['Hello', ' world'])
})

test('Claude web search mode does not send native Claude web search tools', async () => {
  const { buildClaudeWebSearchRequestOptions } = await loadTsModule(['lib', 'yunwu-claude-chat.ts'])

  assert.deepEqual(JSON.parse(JSON.stringify(buildClaudeWebSearchRequestOptions('off'))), {})
  assert.deepEqual(JSON.parse(JSON.stringify(buildClaudeWebSearchRequestOptions('auto'))), {})
  assert.deepEqual(JSON.parse(JSON.stringify(buildClaudeWebSearchRequestOptions('on'))), {})
})

test('Claude event-stream text is extracted from non-streaming web-search responses', async () => {
  const { extractClaudeResponseTexts } = await loadTsModule(['lib', 'yunwu-claude-chat.ts'])
  const eventStream = [
    'event: content_block_delta',
    'data: {"delta":{"text":"Hello","type":"text_delta"},"type":"content_block_delta"}',
    '',
    'event: content_block_delta',
    'data: {"delta":{"text":" web","type":"text_delta"},"type":"content_block_delta"}',
    '',
  ].join('\n')

  const texts = extractClaudeResponseTexts(eventStream)

  assert.deepEqual(JSON.parse(JSON.stringify(texts)), ['Hello', ' web'])
})
