# Yunwu Web Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the AnySearch enrichment request with Yunwu `gpt-4o-search-preview` while preserving the existing off, auto, and on modes and downstream answer-model routing.

**Architecture:** Keep `enrichSystemPromptWithWebSearch` as the single integration boundary. Its provider helper will send the latest user query to Yunwu, extract `choices[0].message.content`, and append that text as one reference block before the selected response model runs.

**Tech Stack:** Next.js 16, TypeScript, native `fetch`, Node test runner, VM-based TypeScript test loader.

---

### Task 1: Specify the Yunwu request and response behavior

**Files:**
- Modify: `frontend/tests/webSearch.test.mjs`

- [ ] **Step 1: Replace the successful AnySearch fixture with a Yunwu fixture**

Update the mode-on test so its loader environment contains `YUNWU_SEARCH_API_KEY: 'test-key'`. Capture `url`, `headers`, and parsed `body`, then return:

```js
new Response(JSON.stringify({
  choices: [{
    message: {
      role: 'assistant',
      content: 'A positive current news story with source references.',
    },
  }],
}), { status: 200, headers: { 'Content-Type': 'application/json' } })
```

Assert the URL is `https://yunwu.ai/v1/chat/completions`, the authorization header is `Bearer test-key`, and the body equals:

```js
{
  model: 'gpt-4o-search-preview',
  web_search_options: {},
  messages: [{ role: 'user', content: 'What is quantum computing?' }],
}
```

Also assert the enriched system prompt contains `# 联网搜索参考` and the returned content.

- [ ] **Step 2: Add focused validation tests**

Add one test asserting `YUNWU_SEARCH_API_URL` overrides the default URL, and one test asserting a successful response without string `choices[0].message.content` rejects with `Yunwu web search returned no usable content.`.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
cd frontend && node --test tests/webSearch.test.mjs
```

Expected: FAIL because the production code still reads `ANYSEARCH_API_KEY` and sends the AnySearch request shape.

### Task 2: Replace AnySearch with Yunwu

**Files:**
- Modify: `frontend/app/lib/web-search.ts`

- [ ] **Step 1: Replace provider constants and payload types**

Use the default URL `https://yunwu.ai/v1/chat/completions` and model `gpt-4o-search-preview`. Replace AnySearch response types with:

```ts
type YunwuSearchPayload = {
    choices?: Array<{
        message?: {
            content?: unknown;
        };
    }>;
};
```

- [ ] **Step 2: Implement the minimal Yunwu provider request**

Read `YUNWU_SEARCH_API_KEY`, fail with `YUNWU_SEARCH_API_KEY is not configured.` when absent, and optionally read `YUNWU_SEARCH_API_URL`. Send:

```ts
{
    model: 'gpt-4o-search-preview',
    web_search_options: {},
    messages: [{ role: 'user', content: query }],
}
```

Parse JSON, validate trimmed `choices[0].message.content`, and return it. On non-2xx responses include the status and response text without including the key.

- [ ] **Step 3: Build one search-reference block**

Replace the list-based AnySearch context builder with a string-based builder returning:

```ts
[
    '# 联网搜索参考',
    '以下内容来自实时联网搜索。回答涉及事实、时间、价格、新闻或外部资料时，优先参考这些结果；如果结果不足以支撑结论，请明确说明不确定。',
    '',
    content,
].join('\n\n')
```

Keep the public enrichment result shape and off/auto/on decision logic unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
cd frontend && node --test tests/webSearch.test.mjs
```

Expected: all tests in `webSearch.test.mjs` PASS.

### Task 3: Update configuration documentation and verify the frontend

**Files:**
- Modify: `frontend/.env.example`

- [ ] **Step 1: Replace the AnySearch example variables**

Use:

```dotenv
# 联网搜索（Yunwu gpt-4o-search-preview）
YUNWU_SEARCH_API_KEY=
YUNWU_SEARCH_API_URL=https://yunwu.ai/v1/chat/completions
```

Do not add a real key.

- [ ] **Step 2: Run regression tests**

Run:

```bash
cd frontend && node --test tests/*.test.mjs
```

Expected: all frontend Node tests PASS.

- [ ] **Step 3: Run production build**

Run:

```bash
cd frontend && npm run build
```

Expected: Prisma generation and Next.js production build complete successfully.

- [ ] **Step 4: Review the final diff and commit**

Run:

```bash
git diff --check
git diff -- frontend/app/lib/web-search.ts frontend/tests/webSearch.test.mjs frontend/.env.example
git add frontend/app/lib/web-search.ts frontend/tests/webSearch.test.mjs frontend/.env.example docs/superpowers/plans/2026-07-11-yunwu-web-search.md
git commit -m "feat: migrate web search to Yunwu"
```

Expected: only the approved search integration, tests, environment example, and implementation plan are included. Do not push until explicitly authorized.
