import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..', 'app')
const memberDirectoryPath = path.join(appRoot, 'lib', 'member-directory.ts')
const loginPagePath = path.join(appRoot, 'login', 'page.tsx')
const profilePagePath = path.join(appRoot, 'profile', 'page.tsx')

function extractFixedMemberNames(source) {
  const blockMatch = source.match(/export const FIXED_MEMBER_NAMES = \[([\s\S]*?)\] as const;/)
  assert.ok(blockMatch, 'FIXED_MEMBER_NAMES array should be present')

  return [...blockMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
}

test('fixed member directory includes Ran Jianglong', async () => {
  const source = await readFile(memberDirectoryPath, 'utf8')
  const names = extractFixedMemberNames(source)

  assert.equal(names.length, 29)
  assert.ok(names.includes('冉江龙'))
})

test('profile pages no longer tell users to choose from a fixed directory', async () => {
  const loginPage = await readFile(loginPagePath, 'utf8')
  const profilePage = await readFile(profilePagePath, 'utf8')

  assert.doesNotMatch(loginPage, /姓名固定为 29 人名单/)
  assert.doesNotMatch(profilePage, /姓名只能从固定 29 人名单中搜索选择/)
})

test('registration profile fields accept typed values instead of fixed-list selections', async () => {
  const loginPage = await readFile(loginPagePath, 'utf8')
  const profilePage = await readFile(profilePagePath, 'utf8')
  const authRoute = await readFile(path.join(appRoot, 'api', 'auth', 'route.ts'), 'utf8')
  const authMeRoute = await readFile(path.join(appRoot, 'api', 'auth', 'me', 'route.ts'), 'utf8')

  assert.doesNotMatch(loginPage, /SearchableSelect/)
  assert.doesNotMatch(profilePage, /SearchableSelect/)
  assert.doesNotMatch(loginPage, /FIXED_(MEMBER|GROUP)_NAMES/)
  assert.doesNotMatch(profilePage, /FIXED_(MEMBER|GROUP)_NAMES/)
  assert.doesNotMatch(loginPage, /固定名单|搜索并选择|不能自定义输入/)
  assert.doesNotMatch(authRoute, /assertAllowed(Nickname|GroupName)/)
  assert.doesNotMatch(authRoute, /isAllowed(MemberName|GroupName)/)
  assert.doesNotMatch(authMeRoute, /isAllowedMemberName/)
})
