import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(testsRoot, '..', 'app')

test('members can change their login account after registration', async () => {
  const profile = await readFile(path.join(appRoot, 'profile', 'page.tsx'), 'utf8')
  const meRoute = await readFile(path.join(appRoot, 'api', 'auth', 'me', 'route.ts'), 'utf8')
  const authRoute = await readFile(path.join(appRoot, 'api', 'auth', 'route.ts'), 'utf8')
  const loginPage = await readFile(path.join(appRoot, 'login', 'page.tsx'), 'utf8')

  assert.match(profile, /updateProfile\(\{ account/)
  assert.match(profile, /改完后请用新账号登录/)
  assert.doesNotMatch(profile, /账号名称/)
  assert.match(meRoute, /export async function PATCH/)
  assert.match(meRoute, /account: z\.string\(\)/)
  assert.match(meRoute, /email: nextAccount/)
  assert.match(meRoute, /nickname: nextAccount/)
  assert.match(meRoute, /assertLoginAccountAvailable/)
  assert.doesNotMatch(meRoute, /max\(20/)
  assert.match(authRoute, /findUserByLoginAccount/)
  assert.match(loginPage, /请输入账号/)
  assert.doesNotMatch(loginPage, /账号名称/)
})
