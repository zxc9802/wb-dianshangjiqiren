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

async function loadTsModule(relativePath, options = {}) {
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
    if (specifier === './usage-fetch') return { usageFetch: options.fetch }
    if (specifier === '@/app/lib/usage-context') return { withUsage: handler => handler }
    if (options.stubs?.[specifier]) {
      return options.stubs[specifier]
    }
    return localRequire(specifier)
  }
  const context = vm.createContext({
    module: cjsModule,
    exports: cjsModule.exports,
    require: stubbedRequire,
    console,
    fetch: options.fetch,
    TextDecoder,
    TextEncoder,
  })
  vm.runInContext(transpiled, context, { filename: sourcePath })
  return cjsModule.exports
}

function appErrorStub() {
  return {
    AppError: class AppError extends Error {
      constructor(message, status = 500) {
        super(message)
        this.status = status
      }
    },
  }
}

function upstreamErrorStub() {
  return {
    looksLikeHtmlPayload: () => false,
    looksLikeTimeoutPayload: () => false,
    normalizeUpstreamErrorMessage: (value) => value,
    truncateForLog: (value) => value,
  }
}

test('OpenAI chat helper lets report force GPT-5.4 over env model', async () => {
  let capturedBody
  const { requestYunwuOpenAIChat } = await loadTsModule(['lib', 'yunwu-openai-chat.ts'], {
    stubs: {
      './auth': appErrorStub(),
      './server-env': {
        readServerEnv: (key) => ({
          YUNWU_OPENAI_CHAT_API_KEY: 'test-key',
          YUNWU_OPENAI_CHAT_URL: 'https://ai.example.test/v1/chat/completions',
          YUNWU_OPENAI_CHAT_MODEL: 'env-model',
        })[key],
      },
      './upstream-error': upstreamErrorStub(),
    },
    fetch: async (_url, init) => {
      capturedBody = JSON.parse(init.body)
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ choices: [{ message: { content: '{"title":"ok"}' } }] }),
      }
    },
  })

  await requestYunwuOpenAIChat({
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'conversation' }],
    model: 'gpt-5.4',
  })

  assert.equal(capturedBody.model, 'gpt-5.4')
})

test('report endpoint asks the OpenAI chat helper to analyze with GPT-5.4', async () => {
  let capturedOptions
  const reportJson = {
    title: '测试报告',
    summary: '摘要',
    insights: [],
    actions: [],
    planSummary: '方案',
    tags: [],
  }

  const { POST } = await loadTsModule(['api', 'report', 'route.ts'], {
    stubs: {
      'next/server': {
        NextResponse: {
          json: (body, init = {}) => ({
            body,
            status: init.status || 200,
            json: async () => body,
          }),
        },
      },
      '../../lib/server-env': {
        readServerEnv: (key) => (key === 'YUNWU_CHAT_API_KEY' ? 'test-key' : undefined),
      },
      '../../lib/yunwu-openai-chat': {
        GPT_5_4_MODEL: 'gpt-5.4',
        requestYunwuOpenAIChat: async (options) => {
          capturedOptions = options
          return JSON.stringify(reportJson)
        },
      },
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(reportJson) }] } }],
      }),
    }),
  })

  const response = await POST({
    json: async () => ({
      botId: '35',
      botName: '起芽成长特助',
      messages: [
        { role: 'user', content: '用户问题' },
        { role: 'assistant', content: 'AI回答' },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(capturedOptions.model, 'gpt-5.4')
  assert.equal(capturedOptions.messages[0].role, 'user')
  assert.match(capturedOptions.messages[0].content, /用户：用户问题/)
  assert.match(capturedOptions.messages[0].content, /AI：AI回答/)
})
