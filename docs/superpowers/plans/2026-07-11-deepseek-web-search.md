# DeepSeek Web Search Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch Yunwu web-search enrichment from `gpt-4o-search-preview` to `deepseek-v3-search` using the user-approved non-streaming request shape.

**Architecture:** Keep `enrichSystemPromptWithWebSearch` and all off/auto/on routing unchanged. Only change the provider request payload, its focused test expectation, and the environment example comment; continue reading URL and API key from server environment variables.

**Tech Stack:** Next.js 16, TypeScript, native `fetch`, Node test runner.

---

### Task 1: Specify the DeepSeek request shape

**Files:**
- Modify: `frontend/tests/webSearch.test.mjs`

- [ ] **Step 1: Update the successful request assertion**

Replace the expected request body with:

```js
{
  model: 'deepseek-v3-search',
  messages: [{ role: 'user', content: 'What is quantum computing?' }],
  max_tokens: 256,
  stream: false,
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd frontend && node --test tests/webSearch.test.mjs
```

Expected: the request assertion fails because production still sends `gpt-4o-search-preview` and `web_search_options`.

### Task 2: Implement the approved provider payload

**Files:**
- Modify: `frontend/app/lib/web-search.ts`
- Modify: `frontend/.env.example`

- [ ] **Step 1: Change the model and request body**

Set the model constant to `deepseek-v3-search` and send:

```ts
{
    model: YUNWU_SEARCH_MODEL,
    messages: [{ role: 'user', content: query }],
    max_tokens: 256,
    stream: false,
}
```

Remove `web_search_options`. Keep `YUNWU_SEARCH_API_KEY`, `YUNWU_SEARCH_API_URL`, response parsing, error handling, search modes, and final answer-model routing unchanged.

- [ ] **Step 2: Update the environment example comment**

Use:

```dotenv
# 联网搜索（Yunwu deepseek-v3-search）
YUNWU_SEARCH_API_KEY=
YUNWU_SEARCH_API_URL=https://yunwu.ai/v1/chat/completions
```

- [ ] **Step 3: Run the focused test and verify GREEN**

Run:

```bash
cd frontend && node --test tests/webSearch.test.mjs
```

Expected: all focused web-search tests pass.

### Task 3: Verify and publish

**Files:**
- Verify: `frontend/app/lib/web-search.ts`
- Verify: `frontend/tests/webSearch.test.mjs`
- Verify: `frontend/.env.example`

- [ ] **Step 1: Run relevant tests and static checks**

Run:

```bash
cd frontend
node --test tests/webSearch.test.mjs tests/chatRenderIsolation.test.mjs
npx tsc --noEmit
npx eslint app/lib/web-search.ts
```

Expected: all commands exit successfully.

- [ ] **Step 2: Run the production build**

Run:

```bash
cd frontend && npm run build
```

Expected: Prisma generation and the Next.js production build complete successfully.

- [ ] **Step 3: Commit, merge, and push**

Commit the approved files, fast-forward local `main`, push `origin/main`, and verify local `HEAD`, `origin/main`, and the remote main ref are identical.
