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
    isActive: true,
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
  const adminTx = { user: { findUnique: async () => ({ role: 'admin', isActive: true }) } }
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

test('inactive members cannot have permissions changed', async () => {
  const inactiveTx = { user: { findUnique: async () => ({ role: 'member', isActive: false }) } }
  const service = await loadService({ $transaction: async (callback) => callback(inactiveTx) })
  await assert.rejects(
    () => service.replaceMemberBotAccess('member-1', ['1']),
    (error) => error.code === 'MEMBER_ACCOUNT_INACTIVE',
  )
  await assert.rejects(
    () => service.resetMemberBotAccess('member-1'),
    (error) => error.code === 'MEMBER_ACCOUNT_INACTIVE',
  )
  await assert.rejects(
    () => service.replaceMemberKbChatRoles('member-1', ['operation']),
    (error) => error.code === 'MEMBER_ACCOUNT_INACTIVE',
  )
})

test('deactivating a member bumps the session version', async () => {
  const updates = []
  const tx = {
    user: {
      findUnique: async () => ({ role: 'member', isActive: true }),
      update: async (args) => (updates.push(args), { id: 'member-1' }),
    },
  }
  const service = await loadService({ $transaction: async (callback) => callback(tx) })
  assert.deepEqual(await service.setMemberActive('member-1', false), { isActive: false })
  assert.equal(updates[0].where.id, 'member-1')
  assert.equal(updates[0].data.isActive, false)
  assert.deepEqual(updates[0].data.authTokenVersion, { increment: 1 })
})

test('deleting a member releases invite usage and owned records', async () => {
  const calls = []
  const tx = {
    user: {
      findUnique: async () => ({ role: 'member', isActive: true }),
      delete: async (args) => (calls.push(['user.delete', args]), { id: 'member-1' }),
    },
    inviteCode: {
      updateMany: async (args) => (calls.push(['inviteCode.updateMany', args]), { count: 1 }),
    },
    invitation: { deleteMany: async (args) => (calls.push(['invitation.deleteMany', args]), { count: 0 }) },
    pointsTransaction: { deleteMany: async (args) => (calls.push(['pointsTransaction.deleteMany', args]), { count: 0 }) },
    conversation: { deleteMany: async (args) => (calls.push(['conversation.deleteMany', args]), { count: 0 }) },
    workflowExecution: { deleteMany: async (args) => (calls.push(['workflowExecution.deleteMany', args]), { count: 0 }) },
    workflow: { deleteMany: async (args) => (calls.push(['workflow.deleteMany', args]), { count: 0 }) },
    videoUsageLog: { deleteMany: async (args) => (calls.push(['videoUsageLog.deleteMany', args]), { count: 0 }) },
  }
  const service = await loadService({
    $transaction: async (callback, options) => {
      assert.equal(options.timeout, 20_000)
      return callback(tx)
    },
  })
  await service.deleteMemberAccount('member-1')
  assert.equal(calls.at(-1)[0], 'user.delete')
  assert.deepEqual(calls.find((item) => item[0] === 'inviteCode.updateMany')[1], {
    where: { usedByUserId: 'member-1' },
    data: { usedByUserId: null, usedAt: null },
  })
})
