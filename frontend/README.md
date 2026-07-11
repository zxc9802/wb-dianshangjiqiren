This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Main Site SSO Entrances

This frontend now exposes two main-site protected child-app launch flows:

- `/bot/video-workbench` for the video workbench child site
- `/bot/kb-chat` for the kb-chat knowledge bot child site

For kb-chat, configure at least:

```bash
MAIN_APP_URL=https://www.qycm.top
KB_CHAT_APP_URL=https://qyzsk.qyaijingxuan.top
JWT_SECRET=change-me
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/ecommerce_ai
```

## Local chunked video uploads

Videos at or below 20MiB continue to use the normal upload endpoint. Larger videos use 5MiB retryable chunks, are merged on the local disk, and are processed asynchronously through a polled job. Configure the optional limits with:

```dotenv
VIDEO_UPLOAD_MAX_BYTES=524288000
VIDEO_UPLOAD_CHUNK_BYTES=5242880
VIDEO_UPLOAD_JOB_TTL_MS=7200000
```

Video bytes are never stored in PostgreSQL. The database temporarily stores job and chunk-receipt metadata; chunk rows and disk parts are deleted immediately after merge, and terminal job metadata expires after two hours. This mode is intended for one Zeabur instance. A restart during upload or processing makes the active job fail and requires the user to upload again. Existing `VIDEO_COMPRESS_TARGET_SIZE` and FFmpeg settings still control final compression.

For Gemini, the worker first compresses the full video. If the actual compressed file is at most 18MiB, Gemini analyzes it directly. Otherwise, FFmpeg splits it into independently playable segments targeting 15MiB and no more than 90 seconds each. Gemini analyzes at most two segments concurrently, retries a failed segment twice, then synthesizes the ordered segment results into one answer using the user's original question. Temporary full-video and segment files are deleted after analysis.

The Gemini thresholds can be adjusted when needed:

```dotenv
GEMINI_VIDEO_MAX_BYTES=18874368
GEMINI_VIDEO_SEGMENT_TARGET_BYTES=15728640
GEMINI_VIDEO_SEGMENT_MAX_SECONDS=90
```

Segmented analysis makes multiple Gemini requests (one per segment plus one final synthesis request), so a longer video takes more time and consumes more API quota than direct analysis.

Expected flow:

1. User logs into the main site.
2. Main site creates a one-time SSO ticket through `/api/kb-chat-sso/start`.
3. The child site redirects back with `ticket`.
4. The child site calls `/api/kb-chat-sso/exchange` to exchange the ticket for user info and a signed token payload.

The `kb-chat` child app should point its env vars at:

```bash
MAIN_APP_KB_CHAT_ENTRY_PATH=/bot/kb-chat
MAIN_APP_KB_CHAT_SSO_EXCHANGE_PATH=/api/kb-chat-sso/exchange
```

## Remote Video Links

This app can fetch page-video links such as TikTok, YouTube, Xiaohongshu, or Bilibili before sending the video to Gemini.

- Direct `.mp4/.mov/.webm/.m4v` links are downloaded directly.
- Douyin links use a custom page/API parser first, then fall back to `yt-dlp`.
- TikTok links use `Playwright + Chromium` first, then fall back to `yt-dlp`.
- YouTube links continue to use `yt-dlp`, but now inject a JS runtime plus default extractor args for current YouTube clients.
- Deployments should install the Python packages from `requirements.txt` so `yt-dlp` and `curl_cffi` are available.
- For Nixpacks-based platforms, `nixpacks.toml` installs `ffmpeg`, `chromium`, Python, and the Playwright Chromium browser bundle.
- TikTok-style pages often need extra network context. Supported environment variables:
  - `YT_DLP_COOKIES_FILE` or `YT_DLP_COOKIES_BASE64`
  - `YT_DLP_COOKIES_FROM_BROWSER`
  - `YT_DLP_IMPERSONATE`
  - `YT_DLP_PROXY`
  - `YT_DLP_FORCE_IPV4`
  - `YT_DLP_EXTRACTOR_ARGS`
  - `YT_DLP_YOUTUBE_EXTRACTOR_ARGS`
  - `YT_DLP_EXTRA_HEADERS`
  - `YT_DLP_REFERER`
  - `YT_DLP_USER_AGENT`
  - `TIKTOK_PLAYWRIGHT_ENABLED`
  - `TIKTOK_PLAYWRIGHT_TIMEOUT_MS`

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
