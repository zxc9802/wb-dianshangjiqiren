import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadTsModule } from './helpers/loadTsModule.mjs'

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(testsRoot, '..', 'app')
const sourcePath = path.join(appRoot, 'lib', 'server-registration-options.ts')
const authRoutePath = path.join(appRoot, 'api', 'auth', 'route.ts')

class TestAppError extends Error {
  constructor(message, status = 400, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function loadRegistrationOptions(rows) {
  const client = {
    registrationOption: {
      findMany: async () => rows,
    },
  }
  const loadedModule = await loadTsModule(sourcePath, {
    './auth': { AppError: TestAppError },
    './prisma': { prisma: client },
  })
  return { module: loadedModule, client }
}

test('active names and groups are returned as independent lists', async () => {
  const { module } = await loadRegistrationOptions([
    { kind: 'group', label: '直播组' },
    { kind: 'name', label: '张三' },
    { kind: 'name', label: '李四' },
  ])

  assert.deepEqual(await module.listActiveRegistrationOptions(), {
    names: ['张三', '李四'],
    groups: ['直播组'],
  })
})

test('both selected values must match an active option', async () => {
  const valid = await loadRegistrationOptions([
    { kind: 'name', label: '张三' },
    { kind: 'group', label: '直播组' },
  ])
  await valid.module.assertActiveRegistrationOptions(valid.client, '张三', '直播组')

  const missingGroup = await loadRegistrationOptions([{ kind: 'name', label: '张三' }])
  await assert.rejects(
    () => missingGroup.module.assertActiveRegistrationOptions(missingGroup.client, '张三', '直播组'),
    (error) => error.status === 400 && error.code === 'REGISTRATION_OPTION_INVALID',
  )
})

test('admin can delete a registration option without removing deactivate', async () => {
  const optionRoutePath = path.join(appRoot, 'api', 'admin', 'registration-options', '[id]', 'route.ts')
  const source = await readFile(optionRoutePath, 'utf8')
  assert.match(source, /export async function PATCH/)
  assert.match(source, /export async function DELETE/)
  assert.match(source, /registrationOption\.deleteMany/)
  assert.match(source, /isActive/)
})

test('auth validates current options before consuming an invite code', async () => {
  const source = await readFile(authRoutePath, 'utf8')
  assert.match(source, /server-registration-options/)
  assert.equal([...source.matchAll(/assertActiveRegistrationOptions\(/g)].length, 3)
  assert.equal([...source.matchAll(/assertActiveRegistrationOptions\([\s\S]*?consumeInviteCode\(/g)].length, 3)
})
