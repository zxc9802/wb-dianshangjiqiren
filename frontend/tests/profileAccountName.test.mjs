import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(testsRoot, '..', 'app')

test('members can edit their own display name after registration', async () => {
  const profile = await readFile(path.join(appRoot, 'profile', 'page.tsx'), 'utf8')
  const meRoute = await readFile(path.join(appRoot, 'api', 'auth', 'me', 'route.ts'), 'utf8')
  const authRoute = await readFile(path.join(appRoot, 'api', 'auth', 'route.ts'), 'utf8')

  assert.match(profile, /账号名称/)
  assert.match(profile, /updateProfile\(\{ nickname/)
  assert.match(profile, /请用新的账号名称登录/)
  assert.match(meRoute, /export async function PATCH/)
  assert.match(meRoute, /email: nextNickname/)
  assert.match(meRoute, /nickname: nextNickname/)
  assert.match(meRoute, /assertLoginAccountAvailable/)
  assert.doesNotMatch(meRoute, /max\(20/)
  assert.match(authRoute, /findUserByLoginAccount/)
})
