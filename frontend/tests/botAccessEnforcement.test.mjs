import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(testsRoot, '..', 'app')

const expectedPageKeys = new Map([
  ['bot/kb-chat/page.tsx', 'kb-chat'],
  ['bot/copywriting-agent/page.tsx', 'copywriting-agent'],
  ['bot/buyer-show/page.tsx', 'buyer-show'],
  ['bot/detail-image-agent/page.tsx', 'detail-image-agent'],
  ['bot/image-generator/page.tsx', 'image-generator'],
  ['bot/video-workbench/page.tsx', 'video-workbench'],
  ['bot/video-workbench-seedance/page.tsx', 'video-workbench'],
  ['bot/tiktok-studio/page.tsx', 'tiktok-studio'],
])

function assertBefore(source, first, second, label) {
  const firstIndex = source.indexOf(first)
  const secondIndex = source.indexOf(second)
  assert.ok(firstIndex >= 0, `${label}: missing ${first}`)
  assert.ok(secondIndex >= 0, `${label}: missing ${second}`)
  assert.ok(firstIndex < secondIndex, `${label}: access check must happen first`)
}

test('homepage filters official cards and generic chat by member access', async () => {
  const home = await readFile(path.join(appRoot, 'page.tsx'), 'utf8')
  assert.match(home, /canAccessOfficialBot\(user\?\.botAccess, bot\.id\)/)
  assert.match(home, /canAccessOfficialBot\(user\?\.botAccess, GENERIC_CHAT_BOT_ID\)/)
  assert.match(home, /findDeniedBotKeys/)
  assert.match(home, /hasNoGrantedOfficialBots/)
  assert.match(home, /管理员尚未开通智能体权限/)
})

test('registration starts members with no official bot access', async () => {
  const authRoute = await readFile(path.join(appRoot, 'api', 'auth', 'route.ts'), 'utf8')
  assert.match(authRoute, /ensureEmptyBotAccessPolicy\(tx, createdUser\.id\)/)
  assert.match(authRoute, /ensureEmptyBotAccessPolicy\(tx, existing\.id\)/)
})

test('official chat routes use the access gate while custom chats stay available', async () => {
  const chatPage = await readFile(path.join(appRoot, 'chat', '[id]', 'page.tsx'), 'utf8')
  assert.match(chatPage, /botId\.startsWith\('custom-'\)/)
  assert.match(chatPage, /<BotAccessGate botKey=\{botId\}>/)
})

test('every official independent page has the correct access gate key', async () => {
  for (const [relativePath, botKey] of expectedPageKeys) {
    const source = await readFile(path.join(appRoot, ...relativePath.split('/')), 'utf8')
    assert.match(source, new RegExp(`<BotAccessGate botKey=["']${botKey}["']>`), relativePath)
  }
})

test('server entry points check access before parsing or side effects', async () => {
  const messages = await readFile(path.join(appRoot, 'api', 'conversations', '[id]', 'messages', 'route.ts'), 'utf8')
  const messagePost = messages.slice(messages.indexOf('export async function POST'))
  assertBefore(messagePost, 'assertConversationBotAccess', 'parseMessageRequest(req)', 'messages')

  const imageProxy = await readFile(path.join(appRoot, 'api', 'image-generations', 'proxy.ts'), 'utf8')
  const imageGenerate = imageProxy.slice(imageProxy.indexOf('export async function proxyGenerateImageRequest'))
  assertBefore(imageGenerate, 'assertUserCanAccessOfficialBot', 'await req.json()', 'image generation')
  assertBefore(imageGenerate, 'assertUserCanAccessOfficialBot', 'requestBackendImageGeneration', 'image generation')

  const fixedRoutes = new Map([
    ['kb-chat-sso', ['kb-chat', 'createKbChatSsoTicket']],
    ['copywriting-agent-sso', ['copywriting-agent', 'createCopywritingAgentSsoTicket']],
    ['buyer-show-sso', ['buyer-show', 'createBuyerShowSsoTicket']],
    ['detail-image-agent-sso', ['detail-image-agent', 'createDetailImageAgentSsoTicket']],
  ])
  for (const [route, [botKey, ticketFunction]] of fixedRoutes) {
    const source = await readFile(path.join(appRoot, 'api', route, 'start', 'route.ts'), 'utf8')
    assert.match(source, new RegExp(`assertUserCanAccessOfficialBot\\(user\\.id, ['"]${botKey}['"]`))
    const postSource = source.slice(source.indexOf('export async function POST'))
    assertBefore(postSource, 'assertUserCanAccessOfficialBot', `${ticketFunction}(`, route)
  }

  const video = await readFile(path.join(appRoot, 'api', 'video-sso', 'start', 'route.ts'), 'utf8')
  assert.match(video, /site === 'tiktok' \? 'tiktok-studio' : 'video-workbench'/)
  const videoPost = video.slice(video.indexOf('export async function POST'))
  assertBefore(videoPost, 'assertUserCanAccessOfficialBot', 'createVideoSsoTicket(', 'video SSO')
})

test('legacy direct chat and saved workflows cannot bypass access', async () => {
  const directChat = await readFile(path.join(appRoot, 'api', 'chat', 'route.ts'), 'utf8')
  const directPost = directChat.slice(directChat.indexOf('export async function POST'))
  assertBefore(directPost, 'getAuthUser(req)', 'await req.json()', 'direct chat authentication')
  assertBefore(directPost, 'assertUserCanAccessOfficialBot', 'streamByResponseModel(', 'direct chat authorization')
  assert.match(directPost, /botIdString \|\| GENERIC_CHAT_BOT_ID/)

  const workflowRoute = await readFile(path.join(appRoot, 'api', 'workflows', '[id]', 'route.ts'), 'utf8')
  const runBranch = workflowRoute.slice(workflowRoute.indexOf("if (action === 'run')"))
  assertBefore(runBranch, 'assertUserCanAccessOfficialBot', 'workflowExecution.create', 'saved workflow run')

  const workflowPage = await readFile(path.join(appRoot, 'my-workflows', 'page.tsx'), 'utf8')
  assert.match(workflowPage, /canAccessOfficialBot\(user\?\.botAccess, bot\.id\)/)
  assertBefore(workflowPage, 'findDeniedBotKeys', "sessionStorage.setItem('wf_state'", 'saved workflow launch')
})
