import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'
import vm from 'node:vm'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.join(__dirname, '..')

async function loadGeminiVideoModule(stubs = {}) {
  const sourcePath = path.join(frontendRoot, 'app', 'lib', 'server-gemini-video-analysis.ts')
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
    if (stubs[specifier]) return stubs[specifier]
    if (specifier.startsWith('./')) return {}
    return localRequire(specifier)
  }
  const context = vm.createContext({
    module: cjsModule,
    exports: cjsModule.exports,
    require: stubbedRequire,
    process,
    console,
    Buffer,
    setTimeout,
    clearTimeout,
  })
  vm.runInContext(transpiled, context, { filename: sourcePath })
  return cjsModule.exports
}

test('segment planning targets 15MiB and never exceeds 90 seconds', async () => {
  const { planGeminiVideoSegments } = await loadGeminiVideoModule()
  const plan = planGeminiVideoSegments({
    fileSize: 184 * 1024 * 1024,
    durationMs: 10 * 60_000,
    targetBytes: 15 * 1024 * 1024,
    maxSegmentSeconds: 90,
  })
  assert.equal(plan.segmentSeconds, 48)
  assert.equal(plan.totalSegments, 13)
})

test('a file at the 18MiB limit stays on the direct Gemini path', async () => {
  const { shouldSegmentGeminiVideo } = await loadGeminiVideoModule()
  const limit = 18 * 1024 * 1024
  assert.equal(shouldSegmentGeminiVideo(limit, limit), false)
  assert.equal(shouldSegmentGeminiVideo(limit + 1, limit), true)
})
