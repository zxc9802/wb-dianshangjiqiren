import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import ts from 'typescript'
import vm from 'node:vm'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..', 'app')
const chatPagePath = path.join(appRoot, 'chat', '[id]', 'page.tsx')
const messageRoutePath = path.join(appRoot, 'api', 'conversations', '[id]', 'messages', 'route.ts')

async function loadServerChatVideoModule(env = {}, stubs = {}) {
  const sourcePath = path.join(appRoot, 'lib', 'server-chat-video.ts')
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
    if (specifier === '@/app/lib/usage-context') return { withUsage: handler => handler }
    if (specifier === 'node:child_process') {
      return { execFile: stubs.execFile || localRequire(specifier).execFile }
    }

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

    if (specifier === './server-gemini-media') {
      return { describeImageWithGemini: stubs.describeImageWithGemini || (async () => 'frame description') }
    }

    if (specifier === './server-voice-transcription') {
      return { transcribeWaveBuffer: stubs.transcribeWaveBuffer || (async () => '') }
    }

    if (specifier === './chat-attachments') {
      return { formatDuration: (value) => `${value}ms` }
    }

    if (specifier === 'ffmpeg-static') {
      return 'ffmpeg'
    }

    if (specifier === 'ffprobe-static') {
      return { path: 'ffprobe' }
    }

    return localRequire(specifier)
  }
  const context = vm.createContext({
    module: cjsModule,
    exports: cjsModule.exports,
    require: stubbedRequire,
    process,
    console: stubs.console || console,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    Promise,
  })
  vm.runInContext(transpiled, context, { filename: sourcePath })
  return cjsModule.exports
}

async function loadUploadRouteModule(stubs = {}) {
  const sourcePath = path.join(appRoot, 'api', 'upload', 'route.ts')
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
    if (specifier === '@/app/lib/usage-context') return { withUsage: handler => handler }
    if (specifier === 'next/server') {
      return {
        NextResponse: {
          json: (body, init = {}) => ({
            status: init.status || 200,
            async json() {
              return body
            },
          }),
        },
      }
    }

    if (specifier === '../../lib/server-chat-video') {
      return {
        storeUploadedVideoForModelUpload: stubs.storeUploadedVideoForModelUpload || (async () => ({
          tempVideoToken: 'stored-token',
          fileSize: 1024,
          mimeType: 'video/mp4',
        })),
        processUploadedVideo: stubs.processUploadedVideo || (async () => ({
          extractedText: 'processed',
          previewUrl: undefined,
          frames: [],
          durationMs: 1000,
          transcript: '',
          tempVideoToken: 'token',
        })),
      }
    }

    if (specifier === '../../lib/server-gemini-media') {
      return { describeImageWithGemini: async () => 'image description' }
    }

    if (specifier === '../../lib/server-env') {
      return { readServerEnv: (key) => stubs.env?.[key] }
    }

    if (specifier === '../../lib/chat-models') {
      return {
        DEFAULT_RESPONSE_MODEL: 'openai',
        isResponseModel: (value) => value === 'openai' || value === 'gemini' || value === 'claude',
      }
    }

    return localRequire(specifier)
  }
  const context = vm.createContext({
    module: cjsModule,
    exports: cjsModule.exports,
    require: stubbedRequire,
    console,
    Buffer,
    File,
  })
  vm.runInContext(transpiled, context, { filename: sourcePath })
  return cjsModule.exports
}

test('video compression settings target large uploads without upscaling small videos', async () => {
  const { resolveVideoCompressionSettings } = await loadServerChatVideoModule()

  assert.equal(resolveVideoCompressionSettings({
    inputSizeBytes: 12 * 1024 * 1024,
    durationMs: 60_000,
    targetSizeBytes: 18 * 1024 * 1024,
  }), null)

  assert.deepEqual(JSON.parse(JSON.stringify(resolveVideoCompressionSettings({
    inputSizeBytes: 80 * 1024 * 1024,
    durationMs: 60_000,
    targetSizeBytes: 18 * 1024 * 1024,
  }))), {
    maxWidth: 720,
    videoBitrateKbps: 2352,
    audioBitrateKbps: 96,
  })
})

test('video compression settings preserve a minimum analysis-quality bitrate over target size', async () => {
  const { resolveVideoCompressionSettings } = await loadServerChatVideoModule()

  assert.deepEqual(JSON.parse(JSON.stringify(resolveVideoCompressionSettings({
    inputSizeBytes: 200 * 1024 * 1024,
    durationMs: 5 * 60_000,
    targetSizeBytes: 18 * 1024 * 1024,
  }))), {
    maxWidth: 720,
    videoBitrateKbps: 1200,
    audioBitrateKbps: 96,
  })
})

test('video preprocessing analyzes original media before creating the compressed copy', async () => {
  const operations = []
  const runExecFile = async (command, args) => {
    operations.push({ command, args: [...args] })
    const outputPath = args.at(-1)
    if (args.includes('-show_entries')) {
      return { stdout: '60\n', stderr: '' }
    }

    if (typeof outputPath === 'string' && outputPath.endsWith('.jpg')) {
      await writeFile(outputPath, Buffer.from('frame'))
      return { stdout: '', stderr: '' }
    }

    if (typeof outputPath === 'string' && outputPath.endsWith('.wav')) {
      await writeFile(outputPath, Buffer.from('audio'))
      return { stdout: '', stderr: '' }
    }

    if (typeof outputPath === 'string' && outputPath.endsWith('.mp4')) {
      await writeFile(outputPath, Buffer.alloc(8 * 1024 * 1024))
      return { stdout: '', stderr: '' }
    }

    return { stdout: '', stderr: '' }
  }
  const execFile = (command, args, callback) => {
    runExecFile(command, args).then(({ stdout, stderr }) => callback(null, stdout, stderr)).catch(callback)
  }
  execFile[promisify.custom] = runExecFile

  const { processUploadedVideo } = await loadServerChatVideoModule({}, {
    console: { log() {}, info() {}, warn() {}, error() {} },
    execFile,
    transcribeWaveBuffer: async () => ({ text: 'clear speech' }),
  })

  await processUploadedVideo({
    buffer: Buffer.alloc(40 * 1024 * 1024),
    fileName: 'quality-first.mp4',
    mimeType: 'video/mp4',
  }, {
    includeFrameDescriptions: true,
    includeTranscript: true,
  })

  const keyframeOperation = operations.find((operation) => operation.args.includes('-frames:v'))
  const audioOperation = operations.find((operation) => operation.args.includes('-acodec'))
  const compressionOperation = operations.find((operation) => operation.args.includes('libx264'))

  assert.ok(keyframeOperation)
  assert.ok(audioOperation)
  assert.ok(compressionOperation)
  assert.match(keyframeOperation.args[keyframeOperation.args.indexOf('-i') + 1], /source\.mp4$/)
  assert.match(audioOperation.args[audioOperation.args.indexOf('-i') + 1], /source\.mp4$/)
  assert.ok(operations.indexOf(keyframeOperation) < operations.indexOf(compressionOperation))
  assert.ok(operations.indexOf(audioOperation) < operations.indexOf(compressionOperation))
})

test('upload route lets oversized videos reach video processing instead of rejecting at MAX_FILE_SIZE', async () => {
  let processed = false
  const { POST } = await loadUploadRouteModule({
    processUploadedVideo: async () => {
      processed = true
      return {
        extractedText: 'processed video',
        previewUrl: undefined,
        frames: [],
        durationMs: 1000,
        transcript: '',
        tempVideoToken: 'token',
      }
    },
  })

  const largeVideo = new File([new Uint8Array(25 * 1024 * 1024)], 'large.mp4', { type: 'video/mp4' })
  const response = await POST({
    async formData() {
      const data = new FormData()
      data.set('file', largeVideo)
      return data
    },
  })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(processed, true)
  assert.equal(body.kind, 'video')
})

test('upload route keeps MAX_FILE_SIZE rejection for non-video files', async () => {
  const { POST } = await loadUploadRouteModule()
  const largeText = new File([new Uint8Array(25 * 1024 * 1024)], 'large.txt', { type: 'text/plain' })

  const response = await POST({
    async formData() {
      const data = new FormData()
      data.set('file', largeText)
      return data
    },
  })
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.match(body.error, /20MB/)
}
)

test('Gemini video uploads are staged through the backend instead of returned empty', async () => {
  let stored = false
  const { POST } = await loadUploadRouteModule({
    storeUploadedVideoForModelUpload: async () => {
      stored = true
      return {
        tempVideoToken: 'gemini-video-token',
        fileSize: 10 * 1024 * 1024,
        mimeType: 'video/mp4',
      }
    },
  })

  const video = new File([new Uint8Array(25 * 1024 * 1024)], 'gemini.mp4', { type: 'video/mp4' })
  const response = await POST({
    async formData() {
      const data = new FormData()
      data.set('file', video)
      data.set('responseModel', 'gemini')
      return data
    },
  })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(stored, true)
  assert.equal(body.tempVideoToken, 'gemini-video-token')
})

test('chat page sends Gemini videos by temp token when backend staging succeeded', async () => {
  const source = await readFile(chatPagePath, 'utf8')

  assert.doesNotMatch(source, /isDirectGeminiVideoBypassCandidate\(file,\s*model\)/)
  assert.match(source, /attachment\.kind === 'video' && !attachment\.tempVideoToken/)
})

test('message attachment schema does not cap video file metadata at 100MB', async () => {
  const source = await readFile(messageRoutePath, 'utf8')

  assert.doesNotMatch(source, /fileSize:\s*z\.number\(\)\.int\(\)\.nonnegative\(\)\.max\(100 \* 1024 \* 1024\)/)
})
