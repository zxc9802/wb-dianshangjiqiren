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
  assert.match(contracts, /result\?: ChatAttachmentPayload/)
})
