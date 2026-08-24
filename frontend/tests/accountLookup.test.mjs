import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadTsModule } from './helpers/loadTsModule.mjs'

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
const sourcePath = path.join(testsRoot, '..', 'app', 'lib', 'server-account-lookup.ts')

class TestAppError extends Error {
  constructor(message, status = 400, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function loadLookup(users) {
  const client = {
    user: {
      findUnique: async ({ where }) => users.find((user) => user.email === where.email) || null,
      findMany: async ({ where }) => users.filter((user) => user.nickname === where.nickname),
      findFirst: async ({ where }) => users.find((user) => {
        if (where.id?.not && user.id === where.id.not) return false
        return where.OR.some((item) => (
          (item.email && user.email === item.email) || (item.nickname && user.nickname === item.nickname)
        ))
      }) || null,
    },
  }
  const module = await loadTsModule(sourcePath, {
    './auth': { AppError: TestAppError },
  })
  return { module, client }
}

const select = { id: true, email: true, nickname: true }

test('login prefers the original account then the renamed account name', async () => {
  const { module, client } = await loadLookup([
    { id: '1', email: 'old-account', nickname: '新名称' },
    { id: '2', email: 'other', nickname: 'other' },
  ])

  assert.deepEqual(await module.findUserByLoginAccount(client, 'old-account', select), {
    id: '1', email: 'old-account', nickname: '新名称',
  })
  assert.deepEqual(await module.findUserByLoginAccount(client, '新名称', select), {
    id: '1', email: 'old-account', nickname: '新名称',
  })
  assert.equal(await module.findUserByLoginAccount(client, 'missing', select), null)
})

test('renamed account names cannot collide with another login account', async () => {
  const { module, client } = await loadLookup([
    { id: '1', email: 'a', nickname: 'a' },
    { id: '2', email: 'b', nickname: '张三' },
  ])

  await module.assertLoginAccountAvailable(client, '新名称', '1')
  await assert.rejects(
    () => module.assertLoginAccountAvailable(client, '张三', '1'),
    (error) => error.status === 409 && error.code === 'ACCOUNT_EXISTS',
  )
})
