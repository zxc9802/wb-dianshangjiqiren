import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..', 'app')
const sitePath = path.join(appRoot, 'lib', 'detail-image-agent-site.ts')
const ssoPath = path.join(appRoot, 'lib', 'detail-image-agent-sso.ts')
const startRoutePath = path.join(appRoot, 'api', 'detail-image-agent-sso', 'start', 'route.ts')
const exchangeRoutePath = path.join(appRoot, 'api', 'detail-image-agent-sso', 'exchange', 'route.ts')
const launcherPath = path.join(appRoot, 'bot', 'detail-image-agent', 'page.tsx')
const clientPath = path.join(appRoot, 'bot', 'detail-image-agent', 'DetailImageAgentLaunchClient.tsx')
const homePagePath = path.join(appRoot, 'page.tsx')
const envExamplePath = path.join(__dirname, '..', '.env.example')
const nodeRequire = createRequire(import.meta.url)

async function loadDetailImageAgentSsoModule(envOverrides = {}) {
  const source = await readFile(ssoPath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText

  const module = { exports: {} }
  const relativeMocks = {
    './auth': {
      AppError: class AppError extends Error {
        constructor(message, status, code) {
          super(message)
          this.name = 'AppError'
          this.status = status
          this.code = code
        }
      },
    },
    './prisma': {
      prisma: {
        videoSsoTicket: {
          create: async (args) => args,
        },
        $transaction: async (handler) => handler({}),
      },
    },
    './server-env': {
      readServerEnv: (key) => envOverrides[key] ?? process.env[key],
    },
    './detail-image-agent-site': {
      DETAIL_IMAGE_AGENT_SITE_METADATA: {
        key: 'detail-image-agent',
        name: '电商图片生成机器人',
        shortName: '图片生成',
        entryPath: '/bot/detail-image-agent',
        defaultAppUrl: 'https://dianpu.qyaijingxuan.top',
      },
    },
    './video-sso': {
      ensureVideoSsoTicketTable: async () => undefined,
      getMainAppUrl: () => envOverrides.MAIN_APP_URL || 'https://main.example.test',
      parseVideoRedirectPath: (value) => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : null,
    },
  }

  function localRequire(specifier) {
    if (specifier in relativeMocks) {
      return relativeMocks[specifier]
    }

    return nodeRequire(specifier)
  }

  const factory = new Function('require', 'module', 'exports', compiled)
  factory(localRequire, module, module.exports)
  return module.exports
}

test('detail image agent site metadata defines the external tool entry', async () => {
  const source = await readFile(sitePath, 'utf8')

  assert.match(source, /DETAIL_IMAGE_AGENT_SITE_METADATA/)
  assert.match(source, /key:\s*'detail-image-agent'/)
  assert.match(source, /name:\s*'店铺图片工具'/)
  assert.match(source, /shortName:\s*'图片工具'/)
  assert.match(source, /entryPath:\s*'\/bot\/detail-image-agent'/)
  assert.match(source, /defaultAppUrl:\s*'https:\/\/dianpu\.qyaijingxuan\.top'/)
})

test('detail image agent SSO builds a configured external app URL', async () => {
  const { buildDetailImageAgentSsoUrl, getDetailImageAgentAppUrl } = await loadDetailImageAgentSsoModule({
    DETAIL_IMAGE_AGENT_APP_URL: 'https://image-agent.example.test',
    MAIN_APP_URL: 'https://main.example.test',
  })

  const targetUrl = new URL(buildDetailImageAgentSsoUrl('ticket-123', {
    mainAppUrl: 'https://main.example.test',
  }))

  assert.equal(getDetailImageAgentAppUrl(), 'https://image-agent.example.test')
  assert.equal(targetUrl.origin, 'https://image-agent.example.test')
  assert.equal(targetUrl.searchParams.get('ticket'), 'ticket-123')
  assert.equal(targetUrl.searchParams.get('mainApp'), 'https://main.example.test')
})

test('detail image agent SSO stores tickets under its own product key', async () => {
  const source = await readFile(ssoPath, 'utf8')

  assert.match(source, /DETAIL_IMAGE_AGENT_PRODUCT = 'detail-image-agent'/)
  assert.match(source, /product:\s*DETAIL_IMAGE_AGENT_PRODUCT/)
  assert.match(source, /ticket\.product !== DETAIL_IMAGE_AGENT_PRODUCT/)
})

test('detail image agent API routes use the dedicated SSO helpers', async () => {
  const startRoute = await readFile(startRoutePath, 'utf8')
  const exchangeRoute = await readFile(exchangeRoutePath, 'utf8')

  assert.match(startRoute, /createDetailImageAgentSsoTicket/)
  assert.match(startRoute, /buildDetailImageAgentSsoUrl/)
  assert.match(exchangeRoute, /consumeDetailImageAgentSsoTicket/)
  assert.match(exchangeRoute, /signToken/)
  assert.match(startRoute, /assertUserCanAccessOfficialBot\(user\.id, 'detail-image-agent'/)
  const postRoute = startRoute.slice(startRoute.indexOf('export async function POST'))
  assert.ok(postRoute.indexOf('assertUserCanAccessOfficialBot') < postRoute.indexOf('createDetailImageAgentSsoTicket('))
})

test('detail image agent launcher delegates to its client component', async () => {
  const page = await readFile(launcherPath, 'utf8')
  const client = await readFile(clientPath, 'utf8')

  assert.match(page, /import DetailImageAgentLaunchClient from '\.\/DetailImageAgentLaunchClient';/)
  assert.match(page, /<DetailImageAgentLaunchClient \/>/)
  assert.match(client, /直达店铺图片工具/)
  assert.match(client, /打开店铺图片工具/)
  assert.match(client, /ticket_exchange_failed/)
  assert.match(client, /if \(!token\)/)
  assert.match(client, /\/api\/detail-image-agent-sso\/start/)
  assert.match(client, /DETAIL_IMAGE_AGENT_SITE_METADATA\.entryPath/)
})

test('homepage keeps the legacy image generator and adds a separate SSO image tool card', async () => {
  const source = await readFile(homePagePath, 'utf8')

  assert.match(
    source,
    /const IMAGE_TOOL: BotInfo = \{[\s\S]*id:\s*'image-generator'[\s\S]*path:\s*'\/bot\/image-generator'[\s\S]*requiresAuth:\s*false[\s\S]*\};/,
  )
  assert.match(
    source,
    /const DETAIL_IMAGE_AGENT_TOOL: BotInfo = \{[\s\S]*id:\s*'detail-image-agent'[\s\S]*path:\s*'\/bot\/detail-image-agent\?autostart=1&openMode=replace'[\s\S]*isTrial:\s*false[\s\S]*requiresAuth:\s*true[\s\S]*\};/,
  )
  assert.match(source, /ALL_HOMEPAGE_BOTS: BotInfo\[] = \[[\s\S]*IMAGE_TOOL[\s\S]*\]/)
  assert.match(source, /ALL_HOMEPAGE_BOTS: BotInfo\[] = \[[\s\S]*DETAIL_IMAGE_AGENT_TOOL[\s\S]*\]/)
})

test('env example documents the detail image agent app URL', async () => {
  const source = await readFile(envExamplePath, 'utf8')

  assert.match(source, /DETAIL_IMAGE_AGENT_APP_URL=https:\/\/dianpu\.qyaijingxuan\.top/)
}
)
