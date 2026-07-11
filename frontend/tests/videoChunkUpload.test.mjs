import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'
import vm from 'node:vm'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.join(__dirname, '..')

async function loadTsModule(relativePath, options = {}) {
  const sourcePath = path.join(frontendRoot, relativePath)
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
      return { readServerEnv: (key) => options.env?.[key] }
    }
    return localRequire(specifier)
  }
  const context = vm.createContext({
    module: cjsModule,
    exports: cjsModule.exports,
    require: stubbedRequire,
    process,
    console,
    Buffer,
    Blob,
    File,
    Response,
    fetch: options.fetch,
    localStorage: options.localStorage,
    setTimeout,
    clearTimeout,
  })
  vm.runInContext(transpiled, context, { filename: sourcePath })
  return cjsModule.exports
}

test('video upload jobs persist ownership, progress, chunks, and results', async () => {
  const [schema, contracts] = await Promise.all([
    readFile(path.join(frontendRoot, 'prisma', 'schema.prisma'), 'utf8'),
    readFile(path.join(frontendRoot, 'app', 'lib', 'video-upload-types.ts'), 'utf8'),
  ])

  assert.match(schema, /model VideoUploadJob/)
  assert.match(schema, /model VideoUploadChunk/)
  assert.match(schema, /@@unique\(\[jobId, index\]\)/)
  assert.match(contracts, /export type VideoUploadJobStatus/)
  assert.match(contracts, /export interface VideoUploadJobSnapshot/)
  assert.match(contracts, /result\?: ChatAttachmentPayload/)
})

test('chunk storage is idempotent and merges chunks in index order', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-chunks-'))
  try {
    const storage = await loadTsModule('app/lib/server-video-upload-storage.ts', {
      env: { VIDEO_UPLOAD_TEMP_ROOT: root },
    })

    await storage.writeVideoChunk({ jobId: '00000000-0000-4000-8000-000000000001', index: 1, bytes: Buffer.from('world') })
    await storage.writeVideoChunk({ jobId: '00000000-0000-4000-8000-000000000001', index: 0, bytes: Buffer.from('hello ') })
    const repeated = await storage.writeVideoChunk({
      jobId: '00000000-0000-4000-8000-000000000001',
      index: 0,
      bytes: Buffer.from('hello '),
    })
    assert.equal(repeated.created, false)

    const outputPath = await storage.mergeVideoChunks({
      jobId: '00000000-0000-4000-8000-000000000001',
      totalChunks: 2,
      extension: '.mp4',
    })
    assert.equal(await readFile(outputPath, 'utf8'), 'hello world')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('video processing accepts merged files by path and jobs run asynchronously', async () => {
  const [videoSource, jobSource] = await Promise.all([
    readFile(path.join(frontendRoot, 'app', 'lib', 'server-chat-video.ts'), 'utf8'),
    readFile(path.join(frontendRoot, 'app', 'lib', 'server-video-upload-jobs.ts'), 'utf8'),
  ])

  assert.match(videoSource, /export async function processUploadedVideoFile/)
  assert.match(videoSource, /export async function storeUploadedVideoFileForModelUpload/)
  assert.match(videoSource, /onStage\?:/)
  assert.match(jobSource, /activeVideoUploadJobs/)
  assert.match(jobSource, /completeVideoUpload/)
  assert.match(jobSource, /void promise/)
  assert.match(jobSource, /服务已重启，请重新上传视频/)
  assert.match(jobSource, /videoUploadChunk\.deleteMany/)
  assert.match(jobSource, /videoUploadChunk\.upsert/)
  assert.match(jobSource, /20 \* 1024 \* 1024/)
})

test('video upload routes authenticate and delegate create, chunk, complete, and polling', async () => {
  const routePaths = [
    ['app', 'api', 'video-uploads', 'route.ts'],
    ['app', 'api', 'video-uploads', '[jobId]', 'chunks', '[index]', 'route.ts'],
    ['app', 'api', 'video-uploads', '[jobId]', 'complete', 'route.ts'],
    ['app', 'api', 'video-uploads', '[jobId]', 'route.ts'],
  ]
  const sources = await Promise.all(routePaths.map((segments) => (
    readFile(path.join(frontendRoot, ...segments), 'utf8')
  )))

  for (const source of sources) {
    assert.match(source, /getUserId/)
    assert.match(source, /errorResponse/)
    assert.match(source, /runtime = 'nodejs'/)
  }
  assert.match(sources[0], /createVideoUploadJob/)
  assert.match(sources[1], /recordVideoUploadChunk/)
  assert.match(sources[1], /arrayBuffer/)
  assert.match(sources[2], /completeVideoUpload/)
  assert.match(sources[3], /getVideoUploadJob/)
})

test('browser uploader limits concurrency, retries a failed chunk, and polls to success', async () => {
  const attempts = new Map()
  let active = 0
  let maxActive = 0
  let pollCount = 0
  const fetchImpl = async (url, init = {}) => {
    if (url === '/api/video-uploads' && init.method === 'POST') {
      return Response.json({
        success: true,
        data: {
          id: 'job-1', status: 'uploading', stage: 'uploading', message: '正在上传视频。',
          chunkSize: 5, totalChunks: 3, uploadedChunks: 0, uploadPercent: 0,
        },
      }, { status: 201 })
    }
    if (String(url).includes('/chunks/')) {
      const index = Number(String(url).split('/').at(-1))
      attempts.set(index, (attempts.get(index) || 0) + 1)
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      if (index === 1 && attempts.get(index) === 1) {
        return Response.json({ error: 'temporary' }, { status: 503 })
      }
      return Response.json({ success: true, data: { status: 'uploading' } })
    }
    if (String(url).endsWith('/complete')) {
      return Response.json({
        success: true,
        data: { id: 'job-1', status: 'queued', stage: 'merging', message: '等待处理', chunkSize: 5, totalChunks: 3, uploadedChunks: 3, uploadPercent: 100 },
      })
    }
    pollCount += 1
    if (pollCount === 1) {
      return Response.json({
        success: true,
        data: { id: 'job-1', status: 'running', stage: 'compressing', message: '正在压缩视频。', chunkSize: 5, totalChunks: 3, uploadedChunks: 0, uploadPercent: 100 },
      })
    }
    return Response.json({
      success: true,
      data: {
        id: 'job-1', status: 'succeeded', stage: 'complete', message: '完成', chunkSize: 5, totalChunks: 3, uploadedChunks: 0, uploadPercent: 100,
        result: { kind: 'video', fileName: 'clip.mp4', fileSize: 13, mimeType: 'video/mp4', tempVideoToken: 'processed-token', frames: [] },
      },
    })
  }
  const uploader = await loadTsModule('app/lib/chunked-video-upload.ts', {
    fetch: fetchImpl,
    localStorage: { getItem: () => 'token' },
  })
  const progress = []
  const result = await uploader.uploadVideoInChunks({
    file: new File([new Uint8Array(13)], 'clip.mp4', { type: 'video/mp4' }),
    responseModel: 'gemini',
    fetchImpl,
    sleep: async () => {},
    onProgress: (snapshot) => progress.push(snapshot),
  })

  assert.equal(maxActive, 3)
  assert.equal(attempts.get(1), 2)
  assert.equal(result.tempVideoToken, 'processed-token')
  assert.ok(progress.some((item) => item.stage === 'compressing'))
})

test('safe response parsing converts an HTML timeout into a Chinese upload error', async () => {
  const uploader = await loadTsModule('app/lib/chunked-video-upload.ts', {
    localStorage: { getItem: () => 'token' },
  })
  const response = new Response('<html>gateway timeout</html>', {
    status: 504,
    headers: { 'Content-Type': 'text/html' },
  })

  await assert.rejects(
    uploader.readJsonResponse(response, '视频上传失败。'),
    /视频上传超时，请检查网络后重试。/,
  )
})

test('chat chunks only videos above 20MB and keeps ordinary uploads for smaller files', async () => {
  const source = await readFile(path.join(frontendRoot, 'app', 'chat', '[id]', 'page.tsx'), 'utf8')
  assert.match(source, /uploadVideoInChunks/)
  assert.match(source, /VIDEO_CHUNK_UPLOAD_THRESHOLD_BYTES/)
  assert.match(source, /attachment\.isVideo/)
  assert.match(source, /attachment\.file\.size > VIDEO_CHUNK_UPLOAD_THRESHOLD_BYTES/)
  assert.match(source, /onProgress:/)
  assert.match(source, /readJsonResponse/)
  assert.match(source, /fetch\('\/api\/upload'/)
})
