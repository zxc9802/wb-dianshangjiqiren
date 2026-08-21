import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..', 'app')
const revokeRoutePath = path.join(appRoot, 'api', 'admin', 'invite-codes', '[id]', 'revoke', 'route.ts')
const directoryPath = path.join(appRoot, 'lib', 'server-admin-directory.ts')

test('admin invite-code revocation deletes the member account instead of only disabling access', async () => {
  const source = await readFile(revokeRoutePath, 'utf8')

  assert.doesNotMatch(source, /accessGrantedAt:\s*null/)
  assert.match(source, /deleteMemberAccount\(/)
  assert.match(source, /usedByUserId/)
})

test('admin invite-code revocation clears user-owned records that block account deletion', async () => {
  const source = await readFile(directoryPath, 'utf8')

  assert.match(source, /tx\.invitation\.deleteMany\(/)
  assert.match(source, /tx\.pointsTransaction\.deleteMany\(/)
  assert.match(source, /tx\.conversation\.deleteMany\(/)
  assert.match(source, /tx\.workflow\.deleteMany\(/)
  assert.match(source, /tx\.user\.delete\(/)
  assert.match(source, /usedByUserId:\s*null/)
  assert.match(source, /usedAt:\s*null/)
})
