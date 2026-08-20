import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..', 'app')
const videoSitesPath = path.join(appRoot, 'lib', 'video-sites.ts')
const apiPath = path.join(appRoot, 'lib', 'api.ts')
const launcherPath = path.join(appRoot, 'bot', 'tiktok-studio', 'page.tsx')
const clientPath = path.join(appRoot, 'bot', 'video-workbench', 'VideoWorkbenchClient.tsx')
const homePagePath = path.join(appRoot, 'page.tsx')
const videoSsoPath = path.join(appRoot, 'lib', 'video-sso.ts')
const videoStartRoutePath = path.join(appRoot, 'api', 'video-sso', 'start', 'route.ts')
const apiModulePath = path.join(appRoot, 'lib', 'api.ts')
const nodeRequire = createRequire(import.meta.url)

async function loadVideoSsoModule(envOverrides = {}) {
  const source = await readFile(videoSsoPath, 'utf8')
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
        $executeRawUnsafe: async () => undefined,
        $transaction: async (handler) => handler({}),
      },
    },
    './server-env': {
      readServerEnv: (key) => envOverrides[key] ?? process.env[key],
    },
    './video-sites': {
      VIDEO_SITE_KEYS: ['seedance', 'tiktok'],
      VIDEO_SITE_METADATA: {
        seedance: {
          key: 'seedance',
          name: '视频工作台',
          shortName: '视频工作台',
          entryPath: '/bot/video-workbench',
          defaultAppUrl: 'https://disanfang.qyaijingxuan.top',
        },
        tiktok: {
          key: 'tiktok',
          name: 'TikTok Studio',
          shortName: 'TikTok Studio',
          entryPath: '/bot/tiktok-studio',
          defaultAppUrl: 'https://titok.qyaijingxuan.top',
        },
      },
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

async function loadApiModule() {
  const source = await readFile(apiModulePath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText

  const module = { exports: {} }
  const factory = new Function('require', 'module', 'exports', compiled)
  factory(nodeRequire, module, module.exports)
  return module.exports
}

test('video site metadata includes the tiktok launcher target', async () => {
  const source = await readFile(videoSitesPath, 'utf8')

  assert.match(source, /VIDEO_SITE_KEYS = \['seedance', 'tiktok'\] as const;/)
  assert.match(
    source,
    /tiktok:\s*{\s*key:\s*'tiktok',[\s\S]*entryPath:\s*'\/bot\/tiktok-studio',[\s\S]*defaultAppUrl:\s*'https:\/\/titok\.qyaijingxuan\.top',/m,
  )
})

test('main-site api type allows the tiktok site key', async () => {
  const source = await readFile(apiPath, 'utf8')

  assert.match(source, /export type VideoSiteKey = 'seedance' \| 'tiktok';/)
})

test('the tiktok launcher page delegates to the shared video workbench client', async () => {
  const source = await readFile(launcherPath, 'utf8')

  assert.match(source, /import VideoWorkbenchClient from '\.\.\/video-workbench\/VideoWorkbenchClient';/)
  assert.match(source, /<VideoWorkbenchClient site="tiktok" \/>/)
})

test('the shared launcher redirects back to the active site after login', async () => {
  const source = await readFile(clientPath, 'utf8')

  assert.match(source, /return `\$\{siteMeta\.entryPath\}\?\$\{params\.toString\(\)\}`;/)
})

test('the homepage trial video tools include a TikTok Studio entry', async () => {
  const source = await readFile(homePagePath, 'utf8')

  assert.match(source, /id:\s*'tiktok-studio'/)
  assert.match(source, /name:\s*'TikTok Studio'/)
  assert.match(source, /category:\s*'视频工作台'/)
  assert.match(source, /path:\s*VIDEO_SITE_METADATA\.tiktok\.entryPath/)
  assert.match(source, /videoSite:\s*'tiktok'/)
  assert.match(source, /isTrial:\s*true/)
})

test('video SSO builds a site-specific external host', async () => {
  const { buildVideoSsoUrl } = await loadVideoSsoModule({
    VIDEO_APP_URL_SEEDANCE: 'https://seedance.example.test',
    VIDEO_APP_URL_TIKTOK: 'https://tiktok.example.test',
  })

  const seedanceUrl = new URL(buildVideoSsoUrl('seedance-ticket', {
    site: 'seedance',
    mainAppUrl: 'https://main.example.test',
  }))
  const tiktokUrl = new URL(buildVideoSsoUrl('tiktok-ticket', {
    site: 'tiktok',
    mainAppUrl: 'https://main.example.test',
  }))

  assert.equal(seedanceUrl.origin, 'https://seedance.example.test')
  assert.equal(tiktokUrl.origin, 'https://tiktok.example.test')
  assert.equal(seedanceUrl.searchParams.get('ticket'), 'seedance-ticket')
  assert.equal(tiktokUrl.searchParams.get('ticket'), 'tiktok-ticket')
  assert.equal(seedanceUrl.searchParams.get('mainApp'), 'https://main.example.test')
  assert.equal(tiktokUrl.searchParams.get('mainApp'), 'https://main.example.test')
})

test('tiktok video SSO uses the tiktok default host instead of legacy seedance envs', async () => {
  const { getVideoAppUrl } = await loadVideoSsoModule({
    VIDEO_APP_URL_SEEDANCE: 'https://seedance-env.example.test',
    VIDEO_APP_URL: 'https://legacy.example.test',
  })

  assert.equal(getVideoAppUrl('seedance'), 'https://seedance-env.example.test')
  assert.equal(getVideoAppUrl('tiktok'), 'https://titok.qyaijingxuan.top')
})

test('video SSO checks the site-specific bot before creating a ticket', async () => {
  const source = await readFile(videoStartRoutePath, 'utf8')
  assert.match(source, /site === 'tiktok' \? 'tiktok-studio' : 'video-workbench'/)
  const postRoute = source.slice(source.indexOf('export async function POST'))
  assert.ok(postRoute.indexOf('assertUserCanAccessOfficialBot') < postRoute.indexOf('createVideoSsoTicket('))
})

test('startVideoSso does not force a bare login redirect on 401', async () => {
  const { api, ApiError } = await loadApiModule()

  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const originalLocalStorage = globalThis.localStorage
  const storage = new Map([
    ['token', 'test-token'],
    ['user', '{"id":"user-1"}'],
  ])

  globalThis.window = {
    location: { href: '/bot/tiktok-studio?autostart=1' },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)) },
      removeItem: (key) => { storage.delete(key) },
      clear: () => { storage.clear() },
    },
  }
  globalThis.localStorage = globalThis.window.localStorage

  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    headers: {
      get: () => 'application/json',
    },
    json: async () => ({ message: 'Unauthorized' }),
    text: async () => 'Unauthorized',
  })

  try {
    await assert.rejects(
      api.startVideoSso({ site: 'tiktok' }),
      (error) => error instanceof ApiError && error.status === 401 && error.message === 'Unauthorized',
    )
    assert.equal(globalThis.window.location.href, '/bot/tiktok-studio?autostart=1')
    assert.equal(storage.has('token'), false)
    assert.equal(storage.has('user'), false)
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
    globalThis.localStorage = originalLocalStorage
  }
})
