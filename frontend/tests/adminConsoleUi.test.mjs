import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(testsRoot, '..', 'app')
const homePath = path.join(appRoot, 'page.tsx')
const adminPagePath = path.join(appRoot, 'admin', 'page.tsx')

test('home exposes separate admin and invite-code links only in the admin guard', async () => {
  const home = await readFile(homePath, 'utf8')
  assert.match(home, /user\?\.role === 'admin'/)
  assert.match(home, /requireAuth\('\/admin'\).*管理员后台/s)
  assert.match(home, /requireAuth\('\/admin\/invite-codes'\).*邀请码管理/s)
})

test('permission editor pins account and name above categorized bot checkboxes', async () => {
  const page = await readFile(adminPagePath, 'utf8')
  assert.match(page, /selectedMember\.account/)
  assert.match(page, /selectedMember\.nickname/)
  assert.match(page, /selectedMember\.groupName/)
  assert.match(page, /保存权限/)
  assert.match(page, /恢复默认全部/)
})
