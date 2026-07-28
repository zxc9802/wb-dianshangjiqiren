import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const homePagePath = path.join(__dirname, '..', 'app', 'page.tsx')

test('homepage keeps the current tab open when launching SSO-connected agents', async () => {
  const source = await readFile(homePagePath, 'utf8')
  const ssoToolNames = [
    'DETAIL_IMAGE_AGENT_TOOL',
    'BUYER_SHOW_TOOL',
    'KB_CHAT_TOOL',
    'COPYWRITING_AGENT_TOOL',
  ]

  for (const toolName of ssoToolNames) {
    const blockStart = source.indexOf(`const ${toolName}: BotInfo = {`)
    const blockEnd = source.indexOf('\n};', blockStart)

    assert.notEqual(blockStart, -1, `${toolName} should exist`)
    assert.notEqual(blockEnd, -1, `${toolName} should have a complete configuration`)
    assert.match(source.slice(blockStart, blockEnd), /openInNewTab:\s*true/)
  }

  const handlerStart = source.indexOf('const openBot = async (bot: BotInfo) => {')
  const videoHandlerStart = source.indexOf('if (bot.videoSite)', handlerStart)
  const newTabHandler = source.indexOf('if (bot.openInNewTab)', handlerStart)

  assert.ok(handlerStart >= 0, 'homepage should define the bot click handler')
  assert.ok(newTabHandler > handlerStart, 'new-tab handling should be part of the click handler')
  assert.ok(newTabHandler < videoHandlerStart, 'new-tab handling should run before async SSO work')
  assert.match(
    source.slice(newTabHandler, videoHandlerStart),
    /if \(bot\.openInNewTab\) \{[\s\S]*?window\.open\(bot\.path, '_blank', 'noopener,noreferrer'\);[\s\S]*?return;[\s\S]*?\}/,
  )
})
