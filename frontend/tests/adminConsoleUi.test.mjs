import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(testsRoot, '..', 'app')
const homePath = path.join(appRoot, 'page.tsx')
const adminPagePath = path.join(appRoot, 'admin', 'page.tsx')
const modelAccessPath = path.join(appRoot, 'lib', 'model-access.ts')

test('home exposes separate admin and invite-code links only in the admin guard', async () => {
  const home = await readFile(homePath, 'utf8')
  assert.match(home, /user\?\.role === 'admin'/)
  assert.match(home, /requireAuth\('\/admin'\).*管理员后台/s)
  assert.match(home, /requireAuth\('\/admin\/invite-codes'\).*邀请码管理/s)
})

test('group options keep deactivate and delete, and names are no longer managed', async () => {
  const page = await readFile(adminPagePath, 'utf8')
  assert.match(page, /deleteAdminRegistrationOption/)
  assert.match(page, /item\.isActive \? '停用' : '恢复'/)
  assert.match(page, /void deleteOption\(item\)/)
  assert.match(page, /组别管理/)
  assert.doesNotMatch(page, /姓名选项/)
})

test('permission editor includes knowledge-base role checkboxes for each member', async () => {
  const page = await readFile(adminPagePath, 'utf8')
  assert.match(page, /起芽知识库岗位/)
  assert.match(page, /replaceAdminMemberKbChatRoles/)
  assert.match(page, /resetAdminMemberKbChatRoles/)
  assert.match(page, /恢复默认全部岗位/)
  assert.match(page, /KB_CHAT_ROLES/)
})

test('permission editor manages model allowlists for all four entries', async () => {
  const page = await readFile(adminPagePath, 'utf8')
  const modelAccess = await readFile(modelAccessPath, 'utf8')
  assert.match(page, /MODEL_ACCESS_SITES/)
  assert.match(page, /replaceAdminMemberModelAccess/)
  assert.match(modelAccess, /主站通用输入框/)
  assert.match(modelAccess, /起芽成长特助/)
  assert.match(modelAccess, /视频拆解导演/)
  assert.match(modelAccess, /起芽知识库机器人/)
  assert.match(page, /自定义白名单/)
})

test('permission editor pins account and group assignment above categorized bot checkboxes', async () => {
  const page = await readFile(adminPagePath, 'utf8')
  assert.match(page, /selectedMember\.account/)
  assert.match(page, /selectedMember\.groupName/)
  assert.match(page, /assignMemberGroup/)
  assert.match(page, /智能体未开通/)
  assert.match(page, /分配组别/)
  assert.match(page, /保存权限/)
  assert.match(page, /恢复默认全部/)
})

test('deleted or deactivated accounts cannot be permission-edited', async () => {
  const page = await readFile(adminPagePath, 'utf8')
  assert.match(page, /updateAdminMember/)
  assert.match(page, /deleteAdminMember/)
  assert.match(page, /停用账号/)
  assert.match(page, /删除账号/)
  assert.match(page, /showDisabledMembers \|\| member\.isActive !== false/)
  assert.match(page, /canEditSelectedMember/)
  assert.match(page, /该账号已停用，无法设置权限/)
})
