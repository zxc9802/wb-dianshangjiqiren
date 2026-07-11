# Chunked Video Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep videos at or below 20MiB on the existing upload path, while uploading larger videos up to 500MB in retryable 5MiB chunks and processing them asynchronously behind a persisted `jobId`.

**Architecture:** Video binaries live only in a task-specific local directory while PostgreSQL temporarily stores ownership, chunk receipts, state, progress, and the final attachment payload. Chunk rows and disk parts are deleted immediately after merge; terminal job metadata expires after two hours. The browser uses the existing endpoint through 20MiB, otherwise uploads at most three chunks concurrently, calls a non-blocking completion endpoint, polls every two seconds, and resumes the existing message-send path.

**Tech Stack:** Next.js 16 route handlers, React 19, TypeScript, Prisma/PostgreSQL, Node filesystem streams, native `fetch`, FFmpeg, Node test runner.

---

### Task 1: Define persisted upload state and shared contracts

**Files:**
- Modify: `frontend/prisma/schema.prisma`
- Create: `frontend/app/lib/video-upload-types.ts`
- Create: `frontend/tests/videoChunkUpload.test.mjs`

- [ ] **Step 1: Write a failing schema-and-contract test**

Create `frontend/tests/videoChunkUpload.test.mjs` with a test that reads the schema and shared contract source:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.join(__dirname, '..')

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
  assert.match(contracts, /tempVideoToken/)
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd frontend && node --test tests/videoChunkUpload.test.mjs
```

Expected: FAIL because `video-upload-types.ts` does not exist.

- [ ] **Step 3: Add the Prisma models and user relation**

Add `videoUploadJobs VideoUploadJob[]` to `User`, then add:

```prisma
model VideoUploadJob {
  id            String    @id @default(uuid())
  userId        String    @map("user_id")
  fileName      String    @map("file_name")
  fileSize      Int       @map("file_size")
  mimeType      String    @map("mime_type")
  responseModel String    @map("response_model")
  chunkSize     Int       @map("chunk_size")
  totalChunks   Int       @map("total_chunks")
  status        String    @default("uploading")
  stage         String    @default("uploading")
  message       String    @default("准备上传视频")
  result        Json?
  error         String?   @db.Text
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")
  completedAt   DateTime? @map("completed_at")

  user   User               @relation(fields: [userId], references: [id], onDelete: Cascade)
  chunks VideoUploadChunk[]

  @@index([userId, createdAt(sort: Desc)])
  @@index([status, updatedAt])
  @@map("video_upload_jobs")
}

model VideoUploadChunk {
  id        String   @id @default(uuid())
  jobId     String   @map("job_id")
  index     Int
  byteSize  Int      @map("byte_size")
  createdAt DateTime @default(now()) @map("created_at")

  job VideoUploadJob @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@unique([jobId, index])
  @@index([jobId])
  @@map("video_upload_chunks")
}
```

- [ ] **Step 4: Add shared API types**

Create `video-upload-types.ts` defining these exact public values and fields:

```ts
import type { ChatAttachmentPayload } from './api';

export type VideoUploadJobStatus = 'uploading' | 'queued' | 'running' | 'succeeded' | 'failed';
export type VideoUploadStage = 'uploading' | 'merging' | 'compressing' | 'analyzing' | 'complete';

export interface VideoUploadJobSnapshot {
    id: string;
    status: VideoUploadJobStatus;
    stage: VideoUploadStage;
    message: string;
    chunkSize: number;
    totalChunks: number;
    uploadedChunks: number;
    uploadPercent: number;
    result?: ChatAttachmentPayload;
    error?: string;
}

export interface CreateVideoUploadInput {
    fileName: string;
    fileSize: number;
    mimeType: string;
    responseModel: string;
}
```

- [ ] **Step 5: Generate Prisma and verify GREEN**

Run:

```bash
cd frontend && npx prisma generate && node --test tests/videoChunkUpload.test.mjs
```

Expected: Prisma generation succeeds and the test passes.

- [ ] **Step 6: Commit the persisted contract**

```bash
git add frontend/prisma/schema.prisma frontend/app/lib/video-upload-types.ts frontend/tests/videoChunkUpload.test.mjs
git commit -m "feat: define video upload job state"
```

### Task 2: Store and merge chunks without buffering the whole video

**Files:**
- Create: `frontend/app/lib/server-video-upload-storage.ts`
- Modify: `frontend/tests/videoChunkUpload.test.mjs`

- [ ] **Step 1: Add failing storage tests**

Extend the test loader with TypeScript transpilation and add a test using an isolated temporary root. It must write chunks out of order, repeat one chunk, merge them, and assert ordered output:

```js
test('chunk storage is idempotent and merges chunks in index order', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-chunks-'))
  const storage = await loadTsModule('app/lib/server-video-upload-storage.ts', {
    env: { VIDEO_UPLOAD_TEMP_ROOT: root },
  })

  await storage.writeVideoChunk({ jobId: 'job-1', index: 1, bytes: Buffer.from('world') })
  await storage.writeVideoChunk({ jobId: 'job-1', index: 0, bytes: Buffer.from('hello ') })
  const repeated = await storage.writeVideoChunk({ jobId: 'job-1', index: 0, bytes: Buffer.from('hello ') })
  assert.equal(repeated.created, false)

  const outputPath = await storage.mergeVideoChunks({
    jobId: 'job-1',
    totalChunks: 2,
    extension: '.mp4',
  })
  assert.equal(await readFile(outputPath, 'utf8'), 'hello world')
})
```

- [ ] **Step 2: Run the storage test and verify RED**

Run `cd frontend && node --test tests/videoChunkUpload.test.mjs`.

Expected: FAIL because the storage module does not exist.

- [ ] **Step 3: Implement safe local storage primitives**

Create a focused module exporting:

```ts
export async function writeVideoChunk(params: {
    jobId: string;
    index: number;
    bytes: Buffer;
}): Promise<{ created: boolean; byteSize: number }>;

export async function hasVideoChunk(params: {
    jobId: string;
    index: number;
    expectedBytes: number;
}): Promise<boolean>;

export async function mergeVideoChunks(params: {
    jobId: string;
    totalChunks: number;
    extension: string;
}): Promise<string>;

export async function cleanupVideoUploadDirectory(jobId: string): Promise<void>;
export async function cleanupStaleVideoUploadDirectories(ttlMs: number): Promise<void>;
```

Use `path.join(process.cwd(), 'storage', 'video-upload-jobs')` unless `VIDEO_UPLOAD_TEMP_ROOT` is configured. Validate `jobId` with `/^[0-9a-f-]+$/i`, validate indexes as non-negative integers, write through `open(path, 'wx')` so duplicate retries do not overwrite data, and merge through `createReadStream(...).pipe(output, { end: false })` one file at a time. The merge function must never call `readFile` on a full video.

- [ ] **Step 4: Verify storage GREEN**

Run `cd frontend && node --test tests/videoChunkUpload.test.mjs`.

Expected: all current video chunk tests pass.

- [ ] **Step 5: Commit storage**

```bash
git add frontend/app/lib/server-video-upload-storage.ts frontend/tests/videoChunkUpload.test.mjs
git commit -m "feat: store and merge video chunks"
```

### Task 3: Persist jobs and run existing video processing asynchronously

**Files:**
- Create: `frontend/app/lib/server-video-upload-jobs.ts`
- Modify: `frontend/app/lib/server-chat-video.ts`
- Modify: `frontend/tests/videoChunkUpload.test.mjs`
- Modify: `frontend/tests/videoUploadCompression.test.mjs`

- [ ] **Step 1: Add failing job lifecycle tests**

Use stubbed Prisma, storage, and video-processing dependencies to prove:

```js
test('completing an upload returns queued before deferred video processing finishes', async () => {
  const processing = Promise.withResolvers()
  const jobs = await loadVideoJobModule({
    processUploadedVideo: async () => processing.promise,
    receivedChunks: [0, 1],
  })

  const snapshot = await jobs.completeVideoUpload({ jobId: 'job-1', userId: 'user-1' })
  assert.equal(snapshot.status, 'queued')
  assert.equal(snapshot.stage, 'merging')
  processing.resolve({
    extractedText: 'analysis', transcript: '', frames: [], tempVideoToken: 'token-1',
  })
  await jobs.waitForActiveVideoUploadJob('job-1')
  assert.equal(jobs.snapshots.at(-1).status, 'succeeded')
})
```

Add separate assertions that a processing error produces `failed`, a different user receives `null`, and a queued/running DB record absent from the active-process Map becomes failed with “服务已重启，请重新上传视频”。

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run `cd frontend && node --test tests/videoChunkUpload.test.mjs`.

Expected: FAIL because the job service does not exist.

- [ ] **Step 3: Add path-based processing and optional stage callbacks**

The existing helpers accept a full `Buffer`, which would load a merged 500MB video into memory. Add path-based siblings and extract the existing processing body so buffer and path callers share one implementation:

```ts
export async function storeUploadedVideoFileForModelUpload(params: {
    absolutePath: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    onStage?: (update: VideoProcessingStageUpdate) => void | Promise<void>;
}): Promise<{ tempVideoToken: string; fileSize: number; mimeType: string }>;

export async function processUploadedVideoFile(params: {
    absolutePath: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
}, options?: ProcessUploadedVideoOptions): Promise<ProcessedVideoUpload>;
```

Move the merged source into the existing token directory with `rename`; on `EXDEV`, use `copyFile` followed by `rm`. Do not call `readFile` on the merged video. Keep the current Buffer-based public functions for `/api/upload` and remote-video callers.

Extend `ProcessUploadedVideoOptions` without changing existing callers:

```ts
export interface VideoProcessingStageUpdate {
    stage: 'compressing' | 'analyzing';
    message: string;
}

export interface ProcessUploadedVideoOptions {
    // existing flags remain
    onStage?: (update: VideoProcessingStageUpdate) => void | Promise<void>;
}
```

Call `onStage({ stage: 'analyzing', message: '正在抽帧和分析视频。' })` before frame/transcript analysis and `onStage({ stage: 'compressing', message: '正在压缩视频。' })` immediately before `compressTempVideoIfNeeded`. The path-based Gemini staging helper sends the same compression-stage callback.

- [ ] **Step 4: Implement the persisted job service**

Export these operations:

```ts
export async function createVideoUploadJob(input: CreateVideoUploadInput & { userId: string }): Promise<VideoUploadJobSnapshot>;
export async function recordVideoUploadChunk(input: { jobId: string; userId: string; index: number; bytes: Buffer }): Promise<VideoUploadJobSnapshot | null>;
export async function completeVideoUpload(input: { jobId: string; userId: string }): Promise<VideoUploadJobSnapshot | null>;
export async function getVideoUploadJob(input: { jobId: string; userId: string }): Promise<VideoUploadJobSnapshot | null>;
export async function waitForActiveVideoUploadJob(jobId: string): Promise<void>;
```

Use a fixed chunking threshold of 20MiB plus defaults of 500MB, 5MiB, and 2 hours from the approved environment variables. Reject creation when `fileSize <= 20 * 1024 * 1024`; those videos must use `/api/upload`. Validate extensions against `.mp4`, `.mov`, `.webm`, and `.m4v`. Record chunks with a unique `(jobId, index)` row, calculate progress from `_count.chunks`, verify every expected index and byte length before completion, then delete all `VideoUploadChunk` rows and disk part files immediately after the merged source is complete. Start the background Promise without awaiting it and store the current Promise in a global Map.

For Gemini call `storeUploadedVideoFileForModelUpload`; for other models call `processUploadedVideoFile` with the existing transcript/frame flags. Persist the returned `ChatAttachmentPayload` as JSON. Always remove remaining chunk and merged-source files after terminal success or failure; do not delete the existing processed temp-token directory. The merged video must move directly into that token directory rather than being reloaded into a Buffer.

- [ ] **Step 5: Verify lifecycle and existing compression tests GREEN**

Run:

```bash
cd frontend && node --test tests/videoChunkUpload.test.mjs tests/videoUploadCompression.test.mjs
```

Expected: all chunk/job and existing compression tests pass.

- [ ] **Step 6: Commit job processing**

```bash
git add frontend/app/lib/server-video-upload-jobs.ts frontend/app/lib/server-chat-video.ts frontend/tests/videoChunkUpload.test.mjs frontend/tests/videoUploadCompression.test.mjs
git commit -m "feat: process uploaded videos asynchronously"
```

### Task 4: Expose authenticated chunk and polling routes

**Files:**
- Create: `frontend/app/api/video-uploads/route.ts`
- Create: `frontend/app/api/video-uploads/[jobId]/chunks/[index]/route.ts`
- Create: `frontend/app/api/video-uploads/[jobId]/complete/route.ts`
- Create: `frontend/app/api/video-uploads/[jobId]/route.ts`
- Modify: `frontend/tests/videoChunkUpload.test.mjs`

- [ ] **Step 1: Add failing route contract tests**

Add source assertions plus VM route tests that stub `getUserId`, `errorResponse`, and the job service. The happy path must assert:

```js
const created = await createRoute.POST(requestWithJson({
  fileName: '184mb.mp4', fileSize: 184 * 1024 * 1024,
  mimeType: 'video/mp4', responseModel: 'gemini',
}))
assert.equal(created.status, 200)

const uploaded = await chunkRoute.PUT(requestWithBytes(Buffer.from('chunk')), {
  params: Promise.resolve({ jobId: 'job-1', index: '0' }),
})
assert.equal(uploaded.status, 200)

const queued = await completeRoute.POST(authenticatedRequest, {
  params: Promise.resolve({ jobId: 'job-1' }),
})
assert.equal((await queued.json()).data.status, 'queued')
```

Also verify invalid JSON, invalid index, oversized chunk, missing chunks, another user's job, and thrown errors all return JSON with the correct 400/404/409/500 status.

- [ ] **Step 2: Run route tests and verify RED**

Run `cd frontend && node --test tests/videoChunkUpload.test.mjs`.

Expected: FAIL because the four route files do not exist.

- [ ] **Step 3: Implement thin authenticated routes**

Each route must set:

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
```

Use `getUserId(req)`, delegate business rules to `server-video-upload-jobs.ts`, and return only `Response.json(...)` or `errorResponse(error)`. The chunk route reads at most one configured chunk with `Buffer.from(await req.arrayBuffer())`; the job service rejects any unexpected byte length. Convert missing-chunk completion to an `AppError` with status 409.

- [ ] **Step 4: Verify route tests GREEN**

Run `cd frontend && node --test tests/videoChunkUpload.test.mjs`.

Expected: route and service tests pass.

- [ ] **Step 5: Commit routes**

```bash
git add frontend/app/api/video-uploads frontend/tests/videoChunkUpload.test.mjs
git commit -m "feat: add chunked video upload API"
```

### Task 5: Build the retrying browser uploader and safe JSON handling

**Files:**
- Create: `frontend/app/lib/chunked-video-upload.ts`
- Modify: `frontend/tests/videoChunkUpload.test.mjs`

- [ ] **Step 1: Add failing client tests**

Use fake `fetch`, a `File`, and zero-delay sleep to assert that the client:

```js
test('browser uploader limits concurrency, retries one failed chunk, and polls to success', async () => {
  const progress = []
  const result = await uploadVideoInChunks({
    file: new File([new Uint8Array(13)], 'clip.mp4', { type: 'video/mp4' }),
    responseModel: 'gemini',
    fetchImpl,
    sleep: async () => {},
    onProgress: (snapshot) => progress.push(snapshot),
  })

  assert.equal(maxConcurrentChunkRequests, 3)
  assert.equal(chunkAttempts.get(1), 2)
  assert.equal(result.tempVideoToken, 'processed-token')
  assert.ok(progress.some((item) => item.stage === 'uploading'))
  assert.ok(progress.some((item) => item.stage === 'compressing'))
})
```

Add a second test where a 504 response has `text/html` and assert the thrown message is `视频上传超时，请检查网络后重试。`, not a JSON parser exception.

- [ ] **Step 2: Run client tests and verify RED**

Run `cd frontend && node --test tests/videoChunkUpload.test.mjs`.

Expected: FAIL because the browser uploader does not exist.

- [ ] **Step 3: Implement the browser uploader**

Export:

```ts
export async function readJsonResponse<T>(response: Response, fallbackMessage: string): Promise<T>;

export async function uploadVideoInChunks(options: {
    file: File;
    responseModel: string;
    onProgress?: (snapshot: VideoUploadJobSnapshot) => void;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
}): Promise<ChatAttachmentPayload>;
```

Read the bearer token from `localStorage`, create the job, use the server-returned `chunkSize` and `totalChunks`, schedule at most three chunk PUT requests, and retry each failed chunk after 500ms, 1000ms, then 2000ms. Call complete once, then poll every two seconds until `succeeded` or `failed`. Map HTML/502/504 responses to concise Chinese errors before any JSON parsing.

- [ ] **Step 4: Verify client tests GREEN**

Run `cd frontend && node --test tests/videoChunkUpload.test.mjs`.

Expected: all browser uploader tests pass.

- [ ] **Step 5: Commit the client uploader**

```bash
git add frontend/app/lib/chunked-video-upload.ts frontend/tests/videoChunkUpload.test.mjs
git commit -m "feat: upload video chunks with retries"
```

### Task 6: Route chat video attachments through the new pipeline

**Files:**
- Modify: `frontend/app/chat/[id]/page.tsx`
- Modify: `frontend/tests/videoChunkUpload.test.mjs`

- [ ] **Step 1: Add a failing chat integration test**

Read the chat page source and assert:

```js
test('chat uses chunk uploads only for videos and keeps ordinary uploads for other files', async () => {
  const source = await readFile(path.join(frontendRoot, 'app', 'chat', '[id]', 'page.tsx'), 'utf8')
  assert.match(source, /uploadVideoInChunks/)
  assert.match(source, /attachment\.isVideo/)
  assert.match(source, /20 \* 1024 \* 1024/)
  assert.match(source, /onProgress:/)
  assert.match(source, /readJsonResponse/)
  assert.match(source, /视频上传/)
  assert.match(source, /fetch\('\/api\/upload'/)
})
```

- [ ] **Step 2: Run the integration test and verify RED**

Run `cd frontend && node --test tests/videoChunkUpload.test.mjs`.

Expected: FAIL because the chat page still sends videos to `/api/upload`.

- [ ] **Step 3: Integrate video jobs without changing image/document behavior**

Import `uploadVideoInChunks` and `readJsonResponse`. Add `videoUploadStatusText` state. During attachment preparation, call the chunked uploader only when `attachment.isVideo && attachment.file.size > 20 * 1024 * 1024`; 20MiB and smaller videos continue through the existing `/api/upload`. The large-video branch is:

```ts
if (attachment.isVideo) {
    const parsed = await uploadVideoInChunks({
        file: attachment.file,
        responseModel,
        onProgress: (snapshot) => setVideoUploadStatusText(snapshot.message),
    });
    return {
        ...attachment,
        name: parsed.fileName,
        kind: 'video' as const,
        mimeType: parsed.mimeType,
        extractedText: parsed.extractedText || '',
        durationMs: parsed.durationMs,
        transcript: parsed.transcript,
        tempVideoToken: parsed.tempVideoToken,
        frames: parsed.frames || [],
        previewUrl: parsed.previewUrl || attachment.previewUrl,
    };
}
```

Keep the current `/api/upload` branch for images/documents, but replace its unconditional `response.json()` with `readJsonResponse`. Show `videoUploadStatusText` beside the existing uploading indicator, clear it after success, and retain the chosen attachment and input after failure.

- [ ] **Step 4: Verify chat integration GREEN**

Run:

```bash
cd frontend && node --test tests/videoChunkUpload.test.mjs tests/videoUploadCompression.test.mjs tests/chatRenderIsolation.test.mjs
```

Expected: new integration, existing compression, and chat render-isolation tests pass.

- [ ] **Step 5: Commit chat integration**

```bash
git add frontend/app/chat/[id]/page.tsx frontend/tests/videoChunkUpload.test.mjs
git commit -m "feat: use asynchronous video uploads in chat"
```

### Task 7: Document configuration and run final verification

**Files:**
- Modify: `frontend/.env.example`
- Modify: `frontend/README.md`

- [ ] **Step 1: Add configuration defaults without secrets**

Add:

```dotenv
# Local chunked video uploads (single-instance deployment)
VIDEO_UPLOAD_MAX_BYTES=524288000
VIDEO_UPLOAD_CHUNK_BYTES=5242880
VIDEO_UPLOAD_JOB_TTL_MS=7200000
```

Document that binaries are temporary local files, active jobs fail on restart, and `VIDEO_COMPRESS_TARGET_SIZE` continues to control final server compression.

- [ ] **Step 2: Run focused verification**

```bash
cd frontend && node --test tests/videoChunkUpload.test.mjs tests/videoUploadCompression.test.mjs tests/chatRenderIsolation.test.mjs
```

Expected: all focused tests pass.

- [ ] **Step 3: Run the full frontend test suite**

```bash
cd frontend && node --test --test-reporter=dot tests/*.test.mjs
```

Expected: no new failures. The existing `conversation image polling route and chat page wire image jobs` source-pattern failure may remain; record it separately if unchanged from the clean baseline.

- [ ] **Step 4: Run production build**

```bash
cd frontend && npm run build
```

Expected: Prisma generation, TypeScript checking, and Next.js production build complete successfully.

- [ ] **Step 5: Review scope and secrets**

```bash
git diff --check
git status --short
rg -n "sk-[A-Za-z0-9]{20,}|postgresql://[^[:space:]]+:[^[:space:]]+@" frontend/app frontend/tests frontend/.env.example frontend/README.md
```

Expected: the diff contains only the approved upload pipeline, tests, schema, and documentation; the secret scan prints no real credentials.

- [ ] **Step 6: Commit configuration and documentation**

```bash
git add frontend/.env.example frontend/README.md
git commit -m "docs: describe local chunked video uploads"
```

- [ ] **Step 7: Present integration choices**

Report the focused-test count, full-suite result including any unchanged baseline failure, build result, commit list, required database schema sync, and the three optional environment variables. Do not push or deploy without explicit authorization.

### Task 8: Carry the user's analysis question into the background job

**Files:**
- Modify: `frontend/prisma/schema.prisma`
- Modify: `frontend/app/lib/video-upload-types.ts`
- Modify: `frontend/app/lib/chunked-video-upload.ts`
- Modify: `frontend/app/chat/[id]/page.tsx`
- Modify: `frontend/tests/videoChunkUpload.test.mjs`

- [ ] **Step 1: Write a failing prompt propagation test**

Assert the schema contains `analysisPrompt`, the create input accepts it, the browser request serializes it, and chat passes `rawText`:

```js
test('large video jobs preserve the current user analysis question', async () => {
  const [schema, types, client, chat] = await Promise.all([
    readFile(path.join(frontendRoot, 'prisma', 'schema.prisma'), 'utf8'),
    readFile(path.join(frontendRoot, 'app', 'lib', 'video-upload-types.ts'), 'utf8'),
    readFile(path.join(frontendRoot, 'app', 'lib', 'chunked-video-upload.ts'), 'utf8'),
    readFile(path.join(frontendRoot, 'app', 'chat', '[id]', 'page.tsx'), 'utf8'),
  ])
  assert.match(schema, /analysisPrompt\s+String\s+@default\(""\)/)
  assert.match(types, /analysisPrompt: string/)
  assert.match(client, /analysisPrompt: options\.analysisPrompt/)
  assert.match(chat, /analysisPrompt: rawText/)
})
```

- [ ] **Step 2: Verify RED**

Run `cd frontend && node --test tests/videoChunkUpload.test.mjs`.

Expected: FAIL because the prompt is not yet propagated.

- [ ] **Step 3: Implement prompt persistence**

Add `analysisPrompt String @default("") @map("analysis_prompt") @db.Text` to `VideoUploadJob`. Add `analysisPrompt: string` to `CreateVideoUploadInput` and the browser uploader options. Limit the route value to 4000 characters and persist `input.analysisPrompt.trim().slice(0, 4000)`. Pass `rawText` from the chat send path.

- [ ] **Step 4: Generate Prisma and verify GREEN**

```bash
cd frontend && npx prisma generate && node --test tests/videoChunkUpload.test.mjs
```

Expected: generation and prompt propagation tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/prisma/schema.prisma frontend/app/lib/video-upload-types.ts frontend/app/lib/chunked-video-upload.ts frontend/app/chat/[id]/page.tsx frontend/tests/videoChunkUpload.test.mjs
git commit -m "feat: preserve video analysis questions"
```

### Task 9: Enforce the Gemini size limit and create playable time segments

**Files:**
- Modify: `frontend/app/lib/server-chat-video.ts`
- Create: `frontend/app/lib/server-gemini-video-analysis.ts`
- Create: `frontend/tests/geminiSegmentedVideo.test.mjs`

- [ ] **Step 1: Write failing segment-planning tests**

Test pure planning before FFmpeg integration:

```js
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
  assert.equal(shouldSegmentGeminiVideo(18 * 1024 * 1024, 18 * 1024 * 1024), false)
  assert.equal(shouldSegmentGeminiVideo((18 * 1024 * 1024) + 1, 18 * 1024 * 1024), true)
})
```

- [ ] **Step 2: Verify RED**

Run `cd frontend && node --test tests/geminiSegmentedVideo.test.mjs`.

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Add path inspection and FFmpeg splitting helpers**

Export from `server-chat-video.ts`:

```ts
export async function getTempVideoFileInfo(token: string): Promise<{
    absolutePath: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    durationMs?: number;
}>;

export async function splitVideoFileByTime(params: {
    absolutePath: string;
    outputDirectory: string;
    segmentSeconds: number;
}): Promise<Array<{ absolutePath: string; durationMs: number }>>;
```

Use FFmpeg segment output `segment-%03d.mp4`, reset timestamps, and force playable MP4 output. Probe every output file and return actual durations. Do not load the full file into a Buffer.

- [ ] **Step 4: Implement pure size planning and hard checks**

Create `server-gemini-video-analysis.ts` with:

```ts
export const DEFAULT_GEMINI_VIDEO_MAX_BYTES = 18 * 1024 * 1024;
export const DEFAULT_GEMINI_SEGMENT_TARGET_BYTES = 15 * 1024 * 1024;
export const DEFAULT_GEMINI_SEGMENT_MAX_SECONDS = 90;

export function shouldSegmentGeminiVideo(fileSize: number, maxBytes: number): boolean;
export function planGeminiVideoSegments(params: {
    fileSize: number;
    durationMs: number;
    targetBytes: number;
    maxSegmentSeconds: number;
}): { segmentSeconds: number; totalSegments: number };
```

Calculate `floor(durationSeconds * targetBytes / fileSize)`, clamp to 10–90 seconds, and calculate total segments with `ceil(durationSeconds / segmentSeconds)`. Every direct or segmented Gemini request must stat the staged file and reject it when it exceeds the configured 18MiB value.

- [ ] **Step 5: Verify segment planning GREEN**

Run `cd frontend && node --test tests/geminiSegmentedVideo.test.mjs`.

Expected: direct-limit and segment-planning tests pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/lib/server-chat-video.ts frontend/app/lib/server-gemini-video-analysis.ts frontend/tests/geminiSegmentedVideo.test.mjs
git commit -m "feat: split oversized Gemini videos"
```

### Task 10: Analyze segments with Gemini and synthesize one result

**Files:**
- Modify: `frontend/app/lib/server-gemini-media.ts`
- Modify: `frontend/app/lib/server-gemini-video-analysis.ts`
- Modify: `frontend/app/lib/server-video-upload-jobs.ts`
- Modify: `frontend/tests/geminiSegmentedVideo.test.mjs`

- [ ] **Step 1: Add failing orchestration tests**

Stub FFmpeg, media Gemini, text Gemini, and temp-token helpers. Verify these two paths:

```js
test('Gemini keeps a direct token when compressed video is within 18MiB', async () => {
  const result = await analyzeUploadedVideoForGemini(directDependencies)
  assert.equal(result.tempVideoToken, 'direct-token')
  assert.equal(result.extractedText, '')
  assert.equal(segmentCalls.length, 0)
})

test('Gemini analyzes oversized video segments and synthesizes one timeline', async () => {
  const result = await analyzeUploadedVideoForGemini(segmentedDependencies)
  assert.equal(result.tempVideoToken, undefined)
  assert.match(result.extractedText, /综合结论/)
  assert.equal(maxConcurrentGeminiCalls, 2)
  assert.equal(segmentAttempts.get(1), 2)
  assert.deepEqual(deletedSegmentTokens.sort(), ['segment-1', 'segment-2'])
})
```

- [ ] **Step 2: Verify RED**

Run `cd frontend && node --test tests/geminiSegmentedVideo.test.mjs`.

Expected: FAIL because the Gemini orchestration function does not exist.

- [ ] **Step 3: Generalize Gemini media analysis**

Keep `describeImageWithGemini` unchanged for existing callers, but implement it through a private media helper. Add:

```ts
export async function analyzeVideoSegmentWithGemini(
    base64Data: string,
    mimeType: string,
    prompt: string,
): Promise<string>;
```

Use the same configured Gemini media endpoint and timeout handling. Send the playable MP4 as inline media and reject empty responses.

- [ ] **Step 4: Implement hybrid orchestration**

Export:

```ts
export async function analyzeUploadedVideoForGemini(params: {
    absolutePath: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    analysisPrompt: string;
    onStage?: (update: VideoProcessingStageUpdate) => void | Promise<void>;
}): Promise<ChatAttachmentPayload>;
```

First stage/compress the full file. If its actual size is at most 18MiB, return the direct token. Otherwise create playable segments, stage each segment, recursively split any staged segment still over 18MiB, and analyze at most two segments concurrently. Retry each failed Gemini segment call twice. Prefix each structured prompt with its real `startMs/endMs`, the user's analysis question, and the fixed fields from the approved design.

After all segments succeed, call `requestYunwuGeminiChat` once with the ordered segment outputs and a synthesis instruction that preserves timeline and directly answers the user question. Return a video attachment with the synthesis plus concise segment evidence in `extractedText` and no `tempVideoToken`. Delete every segment token and the oversized full-video token in `finally` blocks.

- [ ] **Step 5: Integrate the upload job**

Replace the Gemini branch in `runVideoUploadJob` with `analyzeUploadedVideoForGemini`, pass `job.analysisPrompt`, and persist stage messages such as `正在分析第 2/13 段` and `正在综合全部片段`.

- [ ] **Step 6: Verify orchestration GREEN**

```bash
cd frontend && node --test tests/geminiSegmentedVideo.test.mjs tests/videoChunkUpload.test.mjs tests/videoUploadCompression.test.mjs
```

Expected: direct, segmented, retry, cleanup, chunked-upload, and existing compression tests pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/lib/server-gemini-media.ts frontend/app/lib/server-gemini-video-analysis.ts frontend/app/lib/server-video-upload-jobs.ts frontend/tests/geminiSegmentedVideo.test.mjs
git commit -m "feat: synthesize segmented Gemini video analysis"
```

### Task 11: Accept text-only processed video results and verify deployment

**Files:**
- Modify: `frontend/app/lib/chunked-video-upload.ts`
- Modify: `frontend/app/api/conversations/[id]/messages/route.ts`
- Modify: `frontend/.env.example`
- Modify: `frontend/README.md`
- Modify: `frontend/tests/videoChunkUpload.test.mjs`

- [ ] **Step 1: Write failing compatibility tests**

Assert a successful upload job is accepted when it has either a token or non-empty extracted text, and Gemini does not reject a processed text-only video:

```js
assert.match(clientSource, /job\.result\?\.tempVideoToken\s*\|\|\s*job\.result\?\.extractedText/)
assert.match(messageRouteSource, /attachment\.extractedText\.trim\(\)/)
```

- [ ] **Step 2: Verify RED**

Run `cd frontend && node --test tests/videoChunkUpload.test.mjs`.

Expected: FAIL because the current client requires `tempVideoToken`.

- [ ] **Step 3: Implement text-only compatibility**

In the browser uploader, accept success when `tempVideoToken` or trimmed `extractedText` exists. In the conversation route, count a Gemini video as unresolved only when it has no inline data, no temp token, and no non-empty extracted text. The existing attachment-context builder then supplies the synthesized analysis to the final chat request.

- [ ] **Step 4: Document the hybrid settings**

Add without secrets:

```dotenv
GEMINI_VIDEO_MAX_BYTES=18874368
GEMINI_VIDEO_SEGMENT_TARGET_BYTES=15728640
GEMINI_VIDEO_SEGMENT_MAX_SECONDS=90
```

Document direct-versus-segmented behavior, two-call concurrency, retries, cost implications, and immediate segment cleanup.

- [ ] **Step 5: Run final verification**

```bash
cd frontend && node --test tests/geminiSegmentedVideo.test.mjs tests/videoChunkUpload.test.mjs tests/videoUploadCompression.test.mjs tests/chatRenderIsolation.test.mjs
cd frontend && npm run build
```

Then run the full Node suite and changed-file ESLint. Expected: all new focused tests and build pass; any unchanged baseline failure remains separately reported.

- [ ] **Step 6: Commit and integrate**

```bash
git add frontend/app/lib/chunked-video-upload.ts frontend/app/api/conversations/[id]/messages/route.ts frontend/.env.example frontend/README.md frontend/tests/videoChunkUpload.test.mjs
git commit -m "feat: support synthesized Gemini video results"
```

Merge the verified feature branch into `main` and push only after confirming remote `main` has not moved.
