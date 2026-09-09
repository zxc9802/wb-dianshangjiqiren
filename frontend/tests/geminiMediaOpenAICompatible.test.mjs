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

async function loadGeminiMediaModule(env, fetchImpl) {
  const sourcePath = path.join(appRoot, 'lib', 'server-gemini-media.ts')
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
    AbortController,
    clearTimeout,
    setTimeout,
    URL,
  })
  vm.runInContext(transpiled, context, { filename: sourcePath })
  return cjsModule.exports
}

test('describeImageWithGemini sends model and image content for OpenAI-compatible completions URLs', async () => {
  let requestBody
  const fetchImpl = async (_url, init) => {
    requestBody = JSON.parse(init.body)
    return new Response(JSON.stringify({
      choices: [{ message: { content: '图片里有一个蓝色杯子。' } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const { describeImageWithGemini } = await loadGeminiMediaModule({
    AI_API_KEY: 'test-key',
    AI_API_URL: 'https://www.shanbaob.net/v1/chat/completions',
    AI_API_CHAT_MODEL: 'gemini-3.5-flash',
  }, fetchImpl)

  const result = await describeImageWithGemini('abc123', 'image/png', '描述图片')

  assert.equal(result, '图片里有一个蓝色杯子。')
  assert.equal(requestBody.model, 'gemini-3.5-flash')
  assert.equal(requestBody.stream, false)
  assert.equal(requestBody.messages[0].role, 'user')
  assert.deepEqual(requestBody.messages[0].content, [
    { type: 'text', text: '描述图片' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
  ])
})
