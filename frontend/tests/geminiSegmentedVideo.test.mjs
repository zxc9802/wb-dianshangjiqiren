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

test('Gemini keeps a direct token when compressed video is within 18MiB', async () => {
  const deleted = []
  const module = await loadGeminiVideoModule({
    './server-env': { readServerEnv: () => undefined },
    './server-chat-video': {
      storeUploadedVideoFileForModelUpload: async () => ({ tempVideoToken: 'direct-token', fileSize: 10 * 1024 * 1024, mimeType: 'video/mp4' }),
      getTempVideoFileInfo: async () => ({ absolutePath: '/tmp/direct.mp4', fileName: 'clip.mp4', mimeType: 'video/mp4', fileSize: 10 * 1024 * 1024, durationMs: 60_000 }),
      deleteTempVideo: async (token) => deleted.push(token),
    },
    './server-gemini-media': { analyzeVideoSegmentWithGemini: async () => 'unused' },
    './yunwu-gemini-chat': { requestYunwuGeminiChat: async () => 'unused' },
  })
  const result = await module.analyzeUploadedVideoForGemini({
    absolutePath: '/tmp/source.mp4', fileName: 'clip.mp4', mimeType: 'video/mp4', fileSize: 30 * 1024 * 1024, analysisPrompt: '分析节奏',
  })
  assert.equal(result.tempVideoToken, 'direct-token')
  assert.equal(result.extractedText, '')
  assert.deepEqual(deleted, [])
})

test('Gemini analyzes oversized video segments, retries, cleans up, and synthesizes one timeline', async () => {
  const deleted = []
  const attempts = new Map()
  let active = 0
  let maxActive = 0
  const module = await loadGeminiVideoModule({
    './server-env': { readServerEnv: () => undefined },
    './server-chat-video': {
      storeUploadedVideoFileForModelUpload: async ({ fileName }) => fileName === 'clip.mp4'
        ? { tempVideoToken: 'full-token', fileSize: 24 * 1024 * 1024, mimeType: 'video/mp4' }
        : { tempVideoToken: fileName.includes('001') ? 'segment-2' : 'segment-1', fileSize: 10 * 1024 * 1024, mimeType: 'video/mp4' },
      getTempVideoFileInfo: async (token) => token === 'full-token'
        ? { absolutePath: '/tmp/full.mp4', fileName: 'clip.mp4', mimeType: 'video/mp4', fileSize: 24 * 1024 * 1024, durationMs: 120_000 }
        : { absolutePath: `/tmp/${token}.mp4`, fileName: `${token}.mp4`, mimeType: 'video/mp4', fileSize: 10 * 1024 * 1024, durationMs: 60_000 },
      splitVideoFileByTime: async () => [
        { absolutePath: '/tmp/segment-000.mp4', durationMs: 60_000, fileSize: 10 * 1024 * 1024 },
        { absolutePath: '/tmp/segment-001.mp4', durationMs: 60_000, fileSize: 10 * 1024 * 1024 },
      ],
      loadTempVideo: async (token) => ({ buffer: Buffer.from(token), mimeType: 'video/mp4' }),
      deleteTempVideo: async (token) => deleted.push(token),
    },
    './server-gemini-media': {
      analyzeVideoSegmentWithGemini: async (data) => {
        const key = data.includes(Buffer.from('segment-2').toString('base64')) ? 2 : 1
        attempts.set(key, (attempts.get(key) || 0) + 1)
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        if (key === 2 && attempts.get(key) === 1) throw new Error('temporary')
        return `片段${key}分析`
      },
    },
    './yunwu-gemini-chat': { requestYunwuGeminiChat: async () => '综合结论：节奏逐步加快' },
  })
  const result = await module.analyzeUploadedVideoForGemini({
    absolutePath: '/tmp/source.mp4', fileName: 'clip.mp4', mimeType: 'video/mp4', fileSize: 184 * 1024 * 1024, analysisPrompt: '分析节奏',
  })
  assert.equal(result.tempVideoToken, undefined)
  assert.match(result.extractedText, /综合结论：节奏逐步加快/)
  assert.equal(maxActive, 2)
  assert.equal(attempts.get(2), 2)
  assert.deepEqual(deleted.sort(), ['full-token', 'segment-1', 'segment-2'])
})
