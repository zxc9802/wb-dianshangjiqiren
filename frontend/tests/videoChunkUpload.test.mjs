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
  assert.match(jobSource, /20 \* 1024 \* 1024/)
})
