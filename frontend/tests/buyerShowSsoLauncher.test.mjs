import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..', 'app')
const sitePath = path.join(appRoot, 'lib', 'buyer-show-site.ts')
const ssoPath = path.join(appRoot, 'lib', 'buyer-show-sso.ts')
const startRoutePath = path.join(appRoot, 'api', 'buyer-show-sso', 'start', 'route.ts')
const exchangeRoutePath = path.join(appRoot, 'api', 'buyer-show-sso', 'exchange', 'route.ts')
const launcherPath = path.join(appRoot, 'bot', 'buyer-show', 'page.tsx')
const clientPath = path.join(appRoot, 'bot', 'buyer-show', 'BuyerShowLaunchClient.tsx')
const homePagePath = path.join(appRoot, 'page.tsx')
const envExamplePath = path.join(__dirname, '..', '.env.example')

test('buyer-show site metadata defines the external tool entry', async () => {
  const source = await readFile(sitePath, 'utf8')

  assert.match(source, /BUYER_SHOW_SITE_METADATA/)
  assert.match(source, /key:\s*'buyer-show'/)
  assert.match(source, /name:\s*'买家秀智能体'/)
  assert.match(source, /entryPath:\s*'\/bot\/buyer-show'/)
  assert.match(source, /defaultAppUrl:\s*'https:\/\/maijiaxiu\.qyaijingxuan\.top'/)
})

test('buyer-show SSO stores tickets under its own product key', async () => {
  const source = await readFile(ssoPath, 'utf8')

  assert.match(source, /BUYER_SHOW_PRODUCT = 'buyer-show'/)
  assert.match(source, /BUYER_SHOW_APP_URL/)
  assert.match(source, /product:\s*BUYER_SHOW_PRODUCT/)
  assert.match(source, /ticket\.product !== BUYER_SHOW_PRODUCT/)
})

test('buyer-show SSO API routes use dedicated helpers', async () => {
  const startRoute = await readFile(startRoutePath, 'utf8')
  const exchangeRoute = await readFile(exchangeRoutePath, 'utf8')

  assert.match(startRoute, /createBuyerShowSsoTicket/)
  assert.match(startRoute, /buildBuyerShowSsoUrl/)
  assert.match(exchangeRoute, /consumeBuyerShowSsoTicket/)
  assert.match(exchangeRoute, /signToken/)
  assert.match(startRoute, /assertUserCanAccessOfficialBot\(user\.id, 'buyer-show'/)
  const postRoute = startRoute.slice(startRoute.indexOf('export async function POST'))
  assert.ok(postRoute.indexOf('assertUserCanAccessOfficialBot') < postRoute.indexOf('createBuyerShowSsoTicket('))
})

test('buyer-show launcher delegates to its client component', async () => {
  const page = await readFile(launcherPath, 'utf8')
  const client = await readFile(clientPath, 'utf8')

  assert.match(page, /import BuyerShowLaunchClient from '\.\/BuyerShowLaunchClient';/)
  assert.match(page, /<BuyerShowLaunchClient \/>/)
  assert.match(client, /直达买家秀智能体/)
  assert.match(client, /打开买家秀智能体/)
  assert.match(client, /\/api\/buyer-show-sso\/start/)
  assert.match(client, /BUYER_SHOW_SITE_METADATA\.entryPath/)
})

test('homepage adds a protected buyer-show tool card', async () => {
  const source = await readFile(homePagePath, 'utf8')

  assert.match(
    source,
    /const BUYER_SHOW_TOOL: BotInfo = \{[\s\S]*id:\s*'buyer-show'[\s\S]*path:\s*'\/bot\/buyer-show\?autostart=1&openMode=replace'[\s\S]*requiresAuth:\s*true[\s\S]*\};/,
  )
  assert.match(source, /ALL_HOMEPAGE_BOTS: BotInfo\[] = \[[\s\S]*BUYER_SHOW_TOOL[\s\S]*\]/)
})

test('env example documents the buyer-show app URL', async () => {
  const source = await readFile(envExamplePath, 'utf8')

  assert.match(source, /BUYER_SHOW_APP_URL=https:\/\/maijiaxiu\.qyaijingxuan\.top/)
})
