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

async function loadGeminiModule(env, fetchImpl) {
  const sourcePath = path.join(appRoot, 'lib', 'yunwu-gemini-chat.ts')
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
    if (specifier === './usage-fetch') return { usageFetch: fetchImpl }
    if (specifier === '@/app/lib/usage-context') return { withUsage: handler => handler }
    if (specifier === './auth') {
      return {
        AppError: class AppError extends Error {
          constructor(message, status = 500) {
            super(message)
            this.status = status
          }
        },
      }
    }

    if (specifier === './server-env') {
      return { readServerEnv: (key) => env[key] }
    }

    return localRequire(specifier)
  }
  const context = vm.createContext({
    module: cjsModule,
    exports: cjsModule.exports,
    require: stubbedRequire,
    fetch: fetchImpl,
    ReadableStream,
    TextDecoder,
    TextEncoder,
    URL,
  })
  vm.runInContext(transpiled, context, { filename: sourcePath })
  return cjsModule.exports
}

test('Gemini chat sends model when configured with an OpenAI-compatible completions URL', async () => {
  let requestBody
  const fetchImpl = async (_url, init) => {
    requestBody = JSON.parse(init.body)
    return new Response([
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const { streamYunwuGeminiChat } = await loadGeminiModule({
    AI_API_KEY: 'test-key',
    AI_API_URL: 'https://www.shanbaob.net/v1/chat/completions',
    AI_API_CHAT_MODEL: 'gemini-3.5-flash',
  }, fetchImpl)

  const chunks = []
  await streamYunwuGeminiChat({
    systemPrompt: 'You are helpful.',
    messages: [{ role: 'user', content: 'hi' }],
    onText: (text) => chunks.push(text),
  })

  assert.equal(requestBody.model, 'gemini-3.5-flash')
  assert.equal(requestBody.stream, true)
  assert.deepEqual(requestBody.messages.map((message) => message.role), ['system', 'user'])
  assert.deepEqual(chunks, ['hello'])
})
