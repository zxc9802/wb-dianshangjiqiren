import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const homePagePath = path.join(__dirname, '..', 'app', 'page.tsx')

test('homepage hides the image generator and TikTok Studio while keeping their routes configured', async () => {
  const source = await readFile(homePagePath, 'utf8')

  assert.match(source, /isTrial:\s*bot\.routeId === VIDEO_BREAKDOWN_BOT_ID \? false : bot\.homepageTrial \?\? true,/)
  assert.match(source, /id:\s*'video-workbench',[\s\S]*?isTrial:\s*false,/)
  assert.match(source, /id:\s*'tiktok-studio',[\s\S]*?isTrial:\s*true,/)
  assert.doesNotMatch(source, /HOMEPAGE_VISIBLE_TRIAL_BOT_IDS/)
  assert.doesNotMatch(source, /ALL_HOMEPAGE_BOTS\.filter\(\(bot\) => !bot\.isTrial\)/)
  assert.match(
    source,
    /const HIDDEN_HOMEPAGE_BOT_IDS = new Set\(\['image-generator', 'tiktok-studio'\]\);/,
  )
  assert.match(
    source,
    /const filteredBots = ALL_HOMEPAGE_BOTS\s*\.filter\(\(bot\) => !HIDDEN_HOMEPAGE_BOT_IDS\.has\(bot\.id\)\)\s*\.filter\(\(bot\) => {/,
  )
  assert.match(source, /const \[trialBotsOpen, setTrialBotsOpen\] = useState\(true\);/)
})
