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
    if (specifier === './server-env') {
      return {
        readServerEnv: (key) => options.env?.[key],
      }
    }

    if (specifier === './chat-models') {
      return {
        DEFAULT_WEB_SEARCH_MODE: 'auto',
        WEB_SEARCH_MODE_VALUES: ['auto', 'on', 'off'],
        isWebSearchMode: (value) => ['auto', 'on', 'off'].includes(value),
      }
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
    fetch: options.fetch,
    console,
  })
  vm.runInContext(transpiled, context, { filename: sourcePath })
  return cjsModule.exports
}

test('web search mode off skips Yunwu search and leaves prompt unchanged', async () => {
  const { enrichSystemPromptWithWebSearch } = await loadTsModule(['lib', 'web-search.ts'], {
    env: { YUNWU_SEARCH_API_KEY: 'test-key' },
    fetch: async () => {
      throw new Error('fetch should not be called')
    },
  })

  const result = await enrichSystemPromptWithWebSearch({
    systemPrompt: 'base prompt',
    messages: [{ role: 'user', content: '今天有什么新闻？' }],
    webSearchMode: 'off',
  })

  assert.equal(result.systemPrompt, 'base prompt')
  assert.equal(result.usedWebSearch, false)
})

test('web search mode on calls Yunwu and appends search context', async () => {
  const calls = []
  const { enrichSystemPromptWithWebSearch } = await loadTsModule(['lib', 'web-search.ts'], {
    env: { YUNWU_SEARCH_API_KEY: 'test-key' },
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: 'A positive current news story with source references.',
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  const result = await enrichSystemPromptWithWebSearch({
    systemPrompt: 'base prompt',
    messages: [{ role: 'user', content: 'What is quantum computing?' }],
    webSearchMode: 'on',
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://yunwu.ai/v1/chat/completions')
  assert.equal(calls[0].headers.Authorization, 'Bearer test-key')
  assert.deepEqual(calls[0].body, {
    model: 'gpt-4o-search-preview',
    web_search_options: {},
    messages: [{ role: 'user', content: 'What is quantum computing?' }],
  })
  assert.equal(result.usedWebSearch, true)
  assert.match(result.systemPrompt, /# 联网搜索参考/)
  assert.match(result.systemPrompt, /A positive current news story with source references\./)
})

test('web search uses the configured Yunwu API URL', async () => {
  const calls = []
  const { enrichSystemPromptWithWebSearch } = await loadTsModule(['lib', 'web-search.ts'], {
    env: {
      YUNWU_SEARCH_API_KEY: 'test-key',
      YUNWU_SEARCH_API_URL: 'https://search.example.com/v1/chat/completions',
    },
    fetch: async (url) => {
      calls.push(url)
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Search result' } }],
      }), { status: 200 })
    },
  })

  await enrichSystemPromptWithWebSearch({
    systemPrompt: 'base prompt',
    messages: [{ role: 'user', content: 'latest news' }],
    webSearchMode: 'on',
  })

  assert.deepEqual(calls, ['https://search.example.com/v1/chat/completions'])
})

test('web search rejects a Yunwu response without usable content', async () => {
  const { enrichSystemPromptWithWebSearch } = await loadTsModule(['lib', 'web-search.ts'], {
    env: { YUNWU_SEARCH_API_KEY: 'test-key' },
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 }),
  })

  await assert.rejects(
    enrichSystemPromptWithWebSearch({
      systemPrompt: 'base prompt',
      messages: [{ role: 'user', content: 'latest news' }],
      webSearchMode: 'on',
    }),
    /Yunwu web search returned no usable content\./,
  )
})

test('web search mode auto only searches for freshness-sensitive queries', async () => {
  let callCount = 0
  const { enrichSystemPromptWithWebSearch } = await loadTsModule(['lib', 'web-search.ts'], {
    env: { YUNWU_SEARCH_API_KEY: 'test-key' },
    fetch: async () => {
      callCount += 1
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Fresh result' } }],
      }), { status: 200 })
    },
  })

  const stable = await enrichSystemPromptWithWebSearch({
    systemPrompt: 'base prompt',
    messages: [{ role: 'user', content: '解释一下二分查找' }],
    webSearchMode: 'auto',
  })
  const fresh = await enrichSystemPromptWithWebSearch({
    systemPrompt: 'base prompt',
    messages: [{ role: 'user', content: '今天 OpenAI 有什么最新消息？' }],
    webSearchMode: 'auto',
  })

  assert.equal(stable.usedWebSearch, false)
  assert.equal(fresh.usedWebSearch, true)
  assert.equal(callCount, 1)
})
