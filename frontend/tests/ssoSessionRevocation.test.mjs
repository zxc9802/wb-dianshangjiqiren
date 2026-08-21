import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..', 'app')
const prismaSchemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma')
const authLibPath = path.join(appRoot, 'lib', 'auth.ts')
const authRoutePath = path.join(appRoot, 'api', 'auth', 'route.ts')
const authStorePath = path.join(appRoot, 'stores', 'auth.ts')
const ssoCorsPath = path.join(appRoot, 'lib', 'sso-client-cors.ts')
const videoCorsPath = path.join(appRoot, 'lib', 'video-site-cors.ts')
const ssoSessionRoutePath = path.join(appRoot, 'api', 'sso', 'session', 'route.ts')

const browserExchangeRoutes = [
  ['buyer-show', path.join(appRoot, 'api', 'buyer-show-sso', 'exchange', 'route.ts')],
  ['copywriting-agent', path.join(appRoot, 'api', 'copywriting-agent-sso', 'exchange', 'route.ts')],
  ['detail-image-agent', path.join(appRoot, 'api', 'detail-image-agent-sso', 'exchange', 'route.ts')],
  ['kb-chat', path.join(appRoot, 'api', 'kb-chat-sso', 'exchange', 'route.ts')],
]

test('SSO client CORS allow list covers every external SSO app', async () => {
  const source = await readFile(ssoCorsPath, 'utf8')

  assert.match(source, /getAllVideoAppUrls/)
  assert.match(source, /getCopywritingAgentAppUrl/)
  assert.match(source, /getDetailImageAgentAppUrl/)
  assert.match(source, /getBuyerShowAppUrl/)
  assert.match(source, /getKbChatAppUrl/)
  assert.match(source, /isAllowedSsoClientOrigin/)
  assert.match(source, /Access-Control-Allow-Origin/)
})

test('legacy video CORS helpers delegate to the shared SSO client allow list', async () => {
  const source = await readFile(videoCorsPath, 'utf8')

  assert.match(source, /sso-client-cors/)
  assert.match(source, /isAllowedSsoClientOrigin/)
  assert.match(source, /buildSsoClientCorsHeaders/)
})

test('SSO session route performs a live permission check for cached child-site tokens', async () => {
  await access(ssoSessionRoutePath)
  const source = await readFile(ssoSessionRoutePath, 'utf8')

  assert.match(source, /getAuthUser\(req\)/)
  assert.match(source, /withSsoClientCors/)
  assert.match(source, /jsonWithSsoClientCors/)
  assert.match(source, /export function OPTIONS/)
  assert.match(source, /createSsoClientPreflightResponse/)
})

test('browser-based SSO exchange routes return CORS headers', async () => {
  for (const [name, routePath] of browserExchangeRoutes) {
    const source = await readFile(routePath, 'utf8')

    assert.match(source, /jsonWithSsoClientCors/, `${name} exchange should return CORS JSON`)
    assert.match(source, /withSsoClientCors/, `${name} exchange should wrap error responses with CORS`)
    assert.match(source, /export function OPTIONS/, `${name} exchange should support preflight`)
    assert.match(source, /createSsoClientPreflightResponse/, `${name} exchange should use shared preflight`)
  }
})

test('auth tokens carry a server-side session version and stale tokens are rejected', async () => {
  const schema = await readFile(prismaSchemaPath, 'utf8')
  const authLib = await readFile(authLibPath, 'utf8')

  assert.match(schema, /authTokenVersion\s+Int\s+@default\(0\)\s+@map\("auth_token_version"\)/)
  assert.match(schema, /isActive\s+Boolean\s+@default\(true\)\s+@map\("is_active"\)/)
  assert.match(authLib, /tokenVersion:\s*authTokenVersion/)
  assert.match(authLib, /authTokenVersion:\s*true/)
  assert.match(authLib, /decoded\.tokenVersion !== user\.authTokenVersion/)
  assert.match(authLib, /SESSION_REVOKED/)
  assert.match(authLib, /ACCOUNT_DISABLED/)
})

test('main-site logout invalidates existing SSO child-site tokens on the server', async () => {
  const authLib = await readFile(authLibPath, 'utf8')
  const authRoute = await readFile(authRoutePath, 'utf8')
  const authStore = await readFile(authStorePath, 'utf8')

  assert.match(authLib, /export async function revokeAuthSession/)
  assert.match(authLib, /increment:\s*1/)
  assert.match(authRoute, /case 'logout':/)
  assert.match(authRoute, /revokeAuthSession\(req\)/)
  assert.match(authStore, /logout:\s*async/)
  assert.match(authStore, /await api\.logout\(\)/)
})
