import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..', 'app')
const memberDirectoryPath = path.join(appRoot, 'lib', 'member-directory.ts')
const loginPagePath = path.join(appRoot, 'login', 'page.tsx')

test('registration only asks for account password and invite code', async () => {
  const loginPage = await readFile(loginPagePath, 'utf8')

  assert.match(loginPage, /register\(account, password, inviteCode\)/)
  assert.match(loginPage, /邀请码/)
  assert.doesNotMatch(loginPage, /api\.getRegistrationOptions\(\)/)
  assert.doesNotMatch(loginPage, /请选择姓名/)
  assert.doesNotMatch(loginPage, /请选择组别/)
  assert.doesNotMatch(loginPage, /FIXED_MEMBER_NAMES|FIXED_GROUP_NAMES/)
  assert.doesNotMatch(loginPage, /账号名称/)
})

test('the rejected fixed member directory is removed', async () => {
  await assert.rejects(() => readFile(memberDirectoryPath, 'utf8'), { code: 'ENOENT' })
})
