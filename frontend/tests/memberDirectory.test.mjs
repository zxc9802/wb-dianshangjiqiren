import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..', 'app')
const memberDirectoryPath = path.join(appRoot, 'lib', 'member-directory.ts')
const loginPagePath = path.join(appRoot, 'login', 'page.tsx')

test('registration uses independent administrator-managed selects', async () => {
  const loginPage = await readFile(loginPagePath, 'utf8')

  assert.match(loginPage, /api\.getRegistrationOptions\(\)/)
  assert.match(loginPage, /registrationOptions\.names/)
  assert.match(loginPage, /registrationOptions\.groups/)
  assert.match(loginPage, /<select/)
  assert.doesNotMatch(loginPage, /FIXED_MEMBER_NAMES|FIXED_GROUP_NAMES/)
})

test('the rejected fixed member directory is removed', async () => {
  await assert.rejects(() => readFile(memberDirectoryPath, 'utf8'), { code: 'ENOENT' })
})
