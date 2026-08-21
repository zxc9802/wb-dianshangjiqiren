import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadTsModule } from './helpers/loadTsModule.mjs'

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
const sourcePath = path.join(testsRoot, '..', 'app', 'lib', 'server-admin-directory.ts')

class TestAppError extends Error {
  constructor(message, status = 400, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function loadService(prisma) {
  return loadTsModule(sourcePath, {
    './auth': { AppError: TestAppError },
    './bot-access-catalog': { isOfficialBotKey: (key) => ['1', '2', '3'].includes(key) },
    './kb-chat-roles': { isKbChatRoleKey: (key) => ['operation', 'product', 'new'].includes(key) },
    './prisma': { prisma },
  })
}

test('member rows include account name group and policy state', async () => {
  const prisma = {
    user: {
      findMany: async () => [{
        id: 'member-1', email: 'a001', nickname: '张三', groupName: '运营组',
        botAccessPolicy: { permissions: [{ botKey: '1' }, { botKey: '3' }] },
        kbChatRolePolicy: { permissions: [{ roleKey: 'operation' }] },
      }],
    },
  }
  const { listAdminMembers } = await loadService(prisma)
  assert.deepEqual(await listAdminMembers(), [{
    id: 'member-1', account: 'a001', nickname: '张三', groupName: '运营组',
    botAccess: { mode: 'selected', botKeys: ['1', '3'] },
    kbChatRoles: { mode: 'selected', roleKeys: ['operation'] },
  }])
})

test('saving access atomically replaces permissions including empty access', async () => {
  const transactionOrder = []
  const tx = {
    user: { findUnique: async () => (transactionOrder.push('validate-user'), { role: 'member' }) },
    userBotAccessPolicy: {
      upsert: async () => (transactionOrder.push('upsert-policy'), { id: 'policy-1' }),
    },
    userBotPermission: {
      deleteMany: async () => (transactionOrder.push('delete-old'), { count: 2 }),
      createMany: async () => (transactionOrder.push('create-new'), { count: 0 }),
    },
  }
  const service = await loadService({ $transaction: async (callback) => callback(tx) })
  assert.deepEqual(await service.replaceMemberBotAccess('member-1', []), { mode: 'selected', botKeys: [] })
  assert.deepEqual(transactionOrder, ['validate-user', 'upsert-policy', 'delete-old'])
})

test('saving kb chat roles atomically replaces the member allowlist', async () => {
  const transactionOrder = []
  const tx = {
    user: { findUnique: async () => (transactionOrder.push('validate-user'), { role: 'member' }) },
    userKbChatRolePolicy: {
      upsert: async () => (transactionOrder.push('upsert-policy'), { id: 'policy-1' }),
    },
    userKbChatRole: {
      deleteMany: async () => (transactionOrder.push('delete-old'), { count: 1 }),
      createMany: async () => (transactionOrder.push('create-new'), { count: 1 }),
    },
  }
  const service = await loadService({ $transaction: async (callback) => callback(tx) })
  assert.deepEqual(await service.replaceMemberKbChatRoles('member-1', ['operation']), {
    mode: 'selected',
    roleKeys: ['operation'],
  })
  assert.deepEqual(transactionOrder, ['validate-user', 'upsert-policy', 'delete-old', 'create-new'])
})

test('admins cannot be restricted and unknown keys are rejected', async () => {
  const adminTx = { user: { findUnique: async () => ({ role: 'admin' }) } }
  const service = await loadService({ $transaction: async (callback) => callback(adminTx) })
  await assert.rejects(
    () => service.replaceMemberBotAccess('admin-1', ['1']),
    (error) => error.code === 'ADMIN_ACCESS_IMMUTABLE',
  )
  await assert.rejects(
    () => service.replaceMemberBotAccess('member-1', ['not-real']),
    (error) => error.code === 'INVALID_BOT_KEY',
  )
  await assert.rejects(
    () => service.replaceMemberKbChatRoles('member-1', ['not-real']),
    (error) => error.code === 'INVALID_KB_CHAT_ROLE',
  )
})
