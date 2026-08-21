import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadTsModule } from './helpers/loadTsModule.mjs'

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(testsRoot, '..', 'app')
const prismaSchemaPath = path.join(testsRoot, '..', 'prisma', 'schema.prisma')

test('kb chat roles stay aligned with the knowledge-base agent', async () => {
  const { KB_CHAT_ROLES, canAccessKbChatRole, isKbChatRoleKey } = await loadTsModule(
    path.join(appRoot, 'lib', 'kb-chat-roles.ts'),
  )

  assert.deepEqual(KB_CHAT_ROLES.map((role) => role.roleKey), [
    'product',
    'video',
    'operation',
    'bd',
    'live',
    'management',
    'tech',
    'new',
  ])
  assert.equal(isKbChatRoleKey('operation'), true)
  assert.equal(isKbChatRoleKey('unknown'), false)
  assert.equal(canAccessKbChatRole({ mode: 'all', roleKeys: [] }, 'operation'), true)
  assert.equal(canAccessKbChatRole({ mode: 'selected', roleKeys: ['operation'] }, 'product'), false)
})

test('admin schema and SSO ticket expose per-member kb chat roles', async () => {
  const schema = await readFile(prismaSchemaPath, 'utf8')
  const sso = await readFile(path.join(appRoot, 'lib', 'kb-chat-sso.ts'), 'utf8')
  const route = await readFile(path.join(appRoot, 'api', 'admin', 'members', '[id]', 'kb-chat-roles', 'route.ts'), 'utf8')

  assert.match(schema, /model UserKbChatRolePolicy/)
  assert.match(schema, /model UserKbChatRole/)
  assert.match(sso, /kbChatRoles/)
  assert.match(sso, /kbChatRolePolicy/)
  assert.match(route, /export async function PUT/)
  assert.match(route, /export async function DELETE/)
})
