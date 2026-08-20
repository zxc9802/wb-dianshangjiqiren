import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..', 'app')
const sitePath = path.join(appRoot, 'lib', 'copywriting-agent-site.ts')
const ssoPath = path.join(appRoot, 'lib', 'copywriting-agent-sso.ts')
const startRoutePath = path.join(appRoot, 'api', 'copywriting-agent-sso', 'start', 'route.ts')
const exchangeRoutePath = path.join(appRoot, 'api', 'copywriting-agent-sso', 'exchange', 'route.ts')
const launcherPath = path.join(appRoot, 'bot', 'copywriting-agent', 'page.tsx')
const clientPath = path.join(appRoot, 'bot', 'copywriting-agent', 'CopywritingAgentLaunchClient.tsx')
const homePagePath = path.join(appRoot, 'page.tsx')
const envExamplePath = path.join(__dirname, '..', '.env.example')
const nodeRequire = createRequire(import.meta.url)

async function loadCopywritingAgentSsoModule(envOverrides = {}) {
  const source = await readFile(ssoPath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText

  const cjsModule = { exports: {} }
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
    './copywriting-agent-site': {
      COPYWRITING_AGENT_SITE_METADATA: {
        key: 'copywriting-agent',
        name: '老黄 AI 文案总控',
        shortName: '文案总控',
        entryPath: '/bot/copywriting-agent',
        defaultAppUrl: 'https://wenan.qyaijingxuan.top',
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
  factory(localRequire, cjsModule, cjsModule.exports)
  return cjsModule.exports
}

test('copywriting agent site metadata defines the external tool entry', async () => {
  const source = await readFile(sitePath, 'utf8')

  assert.match(source, /COPYWRITING_AGENT_SITE_METADATA/)
  assert.match(source, /key:\s*'copywriting-agent'/)
  assert.match(source, /name:\s*'老黄 AI 文案总控'/)
  assert.match(source, /shortName:\s*'文案总控'/)
  assert.match(source, /entryPath:\s*'\/bot\/copywriting-agent'/)
  assert.match(source, /defaultAppUrl:\s*'https:\/\/wenan\.qyaijingxuan\.top'/)
})

test('copywriting agent SSO builds a configured external app URL', async () => {
  const { buildCopywritingAgentSsoUrl, getCopywritingAgentAppUrl } = await loadCopywritingAgentSsoModule({
    COPYWRITING_AGENT_APP_URL: 'https://copywriting.example.test',
    MAIN_APP_URL: 'https://main.example.test',
  })

  const targetUrl = new URL(buildCopywritingAgentSsoUrl('ticket-123', {
    mainAppUrl: 'https://main.example.test',
  }))

  assert.equal(getCopywritingAgentAppUrl(), 'https://copywriting.example.test')
  assert.equal(targetUrl.origin, 'https://copywriting.example.test')
  assert.equal(targetUrl.searchParams.get('ticket'), 'ticket-123')
  assert.equal(targetUrl.searchParams.get('mainApp'), 'https://main.example.test')
})

test('copywriting agent SSO stores tickets under its own product key', async () => {
  const source = await readFile(ssoPath, 'utf8')

  assert.match(source, /COPYWRITING_AGENT_PRODUCT = 'copywriting-agent'/)
  assert.match(source, /product:\s*COPYWRITING_AGENT_PRODUCT/)
  assert.match(source, /ticket\.product !== COPYWRITING_AGENT_PRODUCT/)
})

test('copywriting agent API routes use the dedicated SSO helpers', async () => {
  const startRoute = await readFile(startRoutePath, 'utf8')
  const exchangeRoute = await readFile(exchangeRoutePath, 'utf8')

  assert.match(startRoute, /createCopywritingAgentSsoTicket/)
  assert.match(startRoute, /buildCopywritingAgentSsoUrl/)
  assert.match(exchangeRoute, /consumeCopywritingAgentSsoTicket/)
  assert.match(exchangeRoute, /signToken/)
  assert.match(startRoute, /assertUserCanAccessOfficialBot\(user\.id, 'copywriting-agent'/)
  const postRoute = startRoute.slice(startRoute.indexOf('export async function POST'))
  assert.ok(postRoute.indexOf('assertUserCanAccessOfficialBot') < postRoute.indexOf('createCopywritingAgentSsoTicket('))
})

test('copywriting agent launcher delegates to its client component', async () => {
  const page = await readFile(launcherPath, 'utf8')
  const client = await readFile(clientPath, 'utf8')

  assert.match(page, /import CopywritingAgentLaunchClient from '\.\/CopywritingAgentLaunchClient';/)
  assert.match(page, /<CopywritingAgentLaunchClient \/>/)
  assert.match(client, /直达老黄 AI 文案总控/)
  assert.match(client, /打开文案总控/)
  assert.match(client, /ticket_exchange_failed/)
  assert.match(client, /if \(!token\)/)
  assert.match(client, /\/api\/copywriting-agent-sso\/start/)
  assert.match(client, /COPYWRITING_AGENT_SITE_METADATA\.entryPath/)
})

test('homepage adds a separate SSO copywriting agent card', async () => {
  const source = await readFile(homePagePath, 'utf8')

  assert.match(
    source,
    /const COPYWRITING_AGENT_TOOL: BotInfo = \{[\s\S]*id:\s*'copywriting-agent'[\s\S]*path:\s*'\/bot\/copywriting-agent\?autostart=1&openMode=replace'[\s\S]*isTrial:\s*false[\s\S]*requiresAuth:\s*true[\s\S]*\};/,
  )
  assert.match(source, /ALL_HOMEPAGE_BOTS: BotInfo\[] = \[[\s\S]*COPYWRITING_AGENT_TOOL[\s\S]*\]/)
})

test('env example documents the copywriting agent app URL', async () => {
  const source = await readFile(envExamplePath, 'utf8')

  assert.match(source, /COPYWRITING_AGENT_APP_URL=https:\/\/wenan\.qyaijingxuan\.top/)
})
