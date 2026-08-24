import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  fetchExtensionBots,
  fetchSession,
  generateExtensionImage,
  saveInsight,
  streamExtensionChat,
} from '../shared/api';
import { createPageSession } from '../shared/page-session';
import { RichTextContent } from '../shared/RichTextContent';
import { getActiveTab, getPageContext, openMainSite, syncAuthFromMainSiteTabs } from '../shared/runtime';
import { getAuthToken, getPageSession, getSessionData, setPageSession, setSiteBaseUrl } from '../shared/storage';
import type {
  ExtensionBot,
  ExtensionChatMessage,
  ExtensionImageGenerationItem,
  ExtensionSessionData,
  LocalPageSession,
  PageContext,
} from '../shared/types';

type AuthState = 'checking' | 'ready' | 'missing';

const DEFAULT_BOT_ID = '6';
const IMAGE_MODE_ASPECT_RATIO = '1:1';

function buildAssistantError(error: unknown): ExtensionChatMessage {
  return {
    role: 'assistant',
    content: error instanceof Error ? `请求失败：${error.message}` : '请求失败，请稍后重试。',
    createdAt: new Date().toISOString(),
  };
}

function buildImageAssistantMessage(result: ExtensionImageGenerationItem): ExtensionChatMessage {
  const imageUrls = Array.isArray(result.resultImagePaths) ? result.resultImagePaths.filter(Boolean) : [];

  return {
    role: 'assistant',
    kind: 'image',
    content: imageUrls.length > 0 ? `已生成 ${imageUrls.length} 张图片。` : '已生成图片。',
    imageUrls,
    imagePrompt: result.prompt,
    aspectRatio: result.aspectRatio,
    createdAt: new Date().toISOString(),
  };
}

function buildChatRequestMessages(messages: ExtensionChatMessage[]): ExtensionChatMessage[] {
  return messages
    .filter((message) => message.kind !== 'image')
    .map((message) => ({
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    }));
}

function readPointsBalance(session: ExtensionSessionData | null): number | null {
  const value = (session?.user as { pointsBalance?: unknown } | undefined)?.pointsBalance;
  return typeof value === 'number' ? value : null;
}

export default function SidePanel() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [session, setSession] = useState<ExtensionSessionData | null>(null);
  const [bots, setBots] = useState<ExtensionBot[]>([]);
  const [botsLoading, setBotsLoading] = useState(false);
  const [pageSession, setPageSessionState] = useState<LocalPageSession | null>(null);
  const [draft, setDraft] = useState('');
  const [streamBuffer, setStreamBuffer] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [summaryBuffer, setSummaryBuffer] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [pageError, setPageError] = useState('');
  const [chatError, setChatError] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [imageModeEnabled, setImageModeEnabled] = useState(false);

  const selectedBot = useMemo(
    () => bots.find((bot) => bot.botId === pageSession?.botId) || bots.find((bot) => bot.botId === DEFAULT_BOT_ID) || null,
    [bots, pageSession?.botId],
  );

  const groupedBots = useMemo(() => {
    const groupMap = new Map<string, ExtensionBot[]>();
    for (const bot of bots) {
      const list = groupMap.get(bot.category) || [];
      list.push(bot);
      groupMap.set(bot.category, list);
    }
    return Array.from(groupMap.entries());
  }, [bots]);

  const renderedSummary = summaryLoading && summaryBuffer ? summaryBuffer : pageSession?.summary || '';
  const canSaveInsight = Boolean(pageSession?.summary || pageSession?.messages.length);
  const pointsBalance = useMemo(() => readPointsBalance(session), [session]);

  async function persistSession(nextSession: LocalPageSession) {
    setPageSessionState(nextSession);
    await setPageSession(nextSession);
  }

  async function loadActivePage() {
    const activeTab = await getActiveTab();
    if (!activeTab?.id) {
      setPageSessionState(null);
      setPageError('没有找到当前标签页。');
      return;
    }

    const context = await getPageContext(activeTab.id);
    if (!context) {
      setPageSessionState(null);
      setPageError('当前页面暂时无法提取正文，请切换到普通网页后再试。');
      return;
    }

    setPageError('');
    const existing = await getPageSession(activeTab.id, context.url);
    const nextSession = existing
      ? {
          ...existing,
          pageContext: context,
          pageUrl: context.url,
          pageTitle: context.title,
          updatedAt: new Date().toISOString(),
        }
      : createPageSession(activeTab.id, context);

    await persistSession(nextSession);
  }

  async function refreshAuth() {
    setAuthState('checking');
    try {
      const [storedToken, storedSession] = await Promise.all([
        getAuthToken(),
        getSessionData(),
      ]);

      if (storedToken && storedSession) {
        await setSiteBaseUrl(storedSession.siteBaseUrl);
        setSession(storedSession);
        setAuthState('ready');
        return;
      }

      if (!storedToken) {
        const synced = await syncAuthFromMainSiteTabs();
        if (!synced) {
          setSession(null);
          setAuthState('missing');
          return;
        }
      }

      const nextSession = await fetchSession();
      setSession(nextSession);
      setAuthState(nextSession ? 'ready' : 'missing');
    } catch {
      setSession(null);
      setAuthState('missing');
    }
  }

  async function loadBots() {
    if (authState !== 'ready') {
      setBots([]);
      return;
    }

    setBotsLoading(true);
    setChatError('');
    try {
      const nextBots = await fetchExtensionBots();
      setBots(nextBots);
      setPageSessionState((current) => {
        if (!current) return current;
        if (nextBots.some((bot) => bot.botId === current.botId)) return current;
        return { ...current, botId: DEFAULT_BOT_ID };
      });
    } catch (error) {
      setChatError(error instanceof Error ? error.message : '加载机器人失败');
    } finally {
      setBotsLoading(false);
    }
  }

  useEffect(() => {
    void refreshAuth();
    void loadActivePage();

    const storageListener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.extensionAuthToken || changes.extensionSessionData) {
        void refreshAuth();
      }

      if (pageSession?.sessionKey && changes[pageSession.sessionKey]?.newValue) {
        setPageSessionState(changes[pageSession.sessionKey].newValue);
      }
    };

    const handleActivated = () => {
      void loadActivePage();
    };

    const handleUpdated = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (changeInfo.status === 'complete' && tab.active) {
        void loadActivePage();
      }
    };

    chrome.storage.onChanged.addListener(storageListener);
    chrome.tabs.onActivated.addListener(handleActivated);
    chrome.tabs.onUpdated.addListener(handleUpdated);

    return () => {
      chrome.storage.onChanged.removeListener(storageListener);
      chrome.tabs.onActivated.removeListener(handleActivated);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
    };
  }, [pageSession?.sessionKey]);

  useEffect(() => {
    void loadBots();
  }, [authState]);

  async function handleBotChange(botId: string) {
    if (!pageSession) return;

    const resetSession = createPageSession(pageSession.tabId, pageSession.pageContext, {
      botId,
      summary: pageSession.summary,
      contextSnapshot: pageSession.contextSnapshot,
      hasPendingContext: pageSession.hasPendingContext,
      savedInsightId: pageSession.savedInsightId,
      messages: pageSession.messages,
    });

    await persistSession(resetSession);
    setDraft('');
    setStreamBuffer('');
    setChatError('');
    setSaveState('idle');
  }

  async function handleRefreshSnapshot() {
    if (!pageSession) return;

    const latestContext = await getPageContext(pageSession.tabId);
    if (!latestContext) {
      setPageError('刷新页面上下文失败，请先切回网页后再试。');
      return;
    }

    setPageError('');
    const nextSession: LocalPageSession = {
      ...pageSession,
      pageContext: latestContext,
      pageUrl: latestContext.url,
      pageTitle: latestContext.title,
      contextSnapshot: latestContext,
      hasPendingContext: true,
      updatedAt: new Date().toISOString(),
    };

    await persistSession(nextSession);
  }

  async function handleSummarize() {
    if (!pageSession || summaryLoading) return;

    setSummaryLoading(true);
    setSummaryError('');
    setSummaryBuffer('');

    const latestContext = await getPageContext(pageSession.tabId) || pageSession.pageContext;
    const baseSession: LocalPageSession = {
      ...pageSession,
      pageContext: latestContext,
      pageUrl: latestContext.url,
      pageTitle: latestContext.title,
      updatedAt: new Date().toISOString(),
    };

    await persistSession(baseSession);

    try {
      let nextSummary = '';
      await streamExtensionChat(
        {
          botId: selectedBot?.botId || baseSession.botId || DEFAULT_BOT_ID,
          mode: 'summary',
          messages: [],
          pageContext: latestContext,
        },
        (chunk) => {
          nextSummary += chunk;
          setSummaryBuffer(nextSummary);
        },
      );

      await persistSession({
        ...baseSession,
        summary: nextSummary,
        updatedAt: new Date().toISOString(),
      });
      setSummaryBuffer('');
    } catch (error) {
      setSummaryError(error instanceof Error ? error.message : '页面总结失败');
    } finally {
      setSummaryLoading(false);
    }
  }

  async function handleSend() {
    if (!pageSession || !draft.trim() || streaming || !selectedBot) return;

    const prompt = draft.trim();
    const userMessage: ExtensionChatMessage = {
      role: 'user',
      content: prompt,
      kind: imageModeEnabled ? 'image' : 'text',
      imagePrompt: imageModeEnabled ? prompt : undefined,
      aspectRatio: imageModeEnabled ? IMAGE_MODE_ASPECT_RATIO : undefined,
      createdAt: new Date().toISOString(),
    };

    setDraft('');
    setChatError('');
    setStreamBuffer('');
    setStreaming(true);

    if (imageModeEnabled) {
      const requestSession: LocalPageSession = {
        ...pageSession,
        messages: [...pageSession.messages, userMessage],
        updatedAt: new Date().toISOString(),
      };

      await persistSession(requestSession);

      try {
        const result = await generateExtensionImage({
          prompt,
          aspectRatio: IMAGE_MODE_ASPECT_RATIO,
          count: 1,
        });

        if (!result.resultImagePaths?.length) {
          throw new Error(result.errorMessage || '图片生成失败，请稍后重试。');
        }

        await persistSession({
          ...requestSession,
          messages: [...requestSession.messages, buildImageAssistantMessage(result)],
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        setChatError(error instanceof Error ? error.message : '图片生成失败');
        await persistSession({
          ...requestSession,
          messages: [...requestSession.messages, buildAssistantError(error)],
          updatedAt: new Date().toISOString(),
        });
      } finally {
        setStreaming(false);
      }
      return;
    }

    let workingSession = pageSession;
    let contextToSend: PageContext | undefined;

    if (!workingSession.contextSnapshot) {
      workingSession = {
        ...workingSession,
        contextSnapshot: workingSession.pageContext,
        hasPendingContext: true,
      };
    }

    if (workingSession.hasPendingContext && workingSession.contextSnapshot) {
      contextToSend = workingSession.contextSnapshot;
    }

    const requestSession: LocalPageSession = {
      ...workingSession,
      messages: [...workingSession.messages, userMessage],
      updatedAt: new Date().toISOString(),
    };

    await persistSession(requestSession);

    try {
      let assistantText = '';
      await streamExtensionChat(
        {
          botId: requestSession.botId,
          mode: 'chat',
          messages: buildChatRequestMessages(requestSession.messages),
          pageContext: contextToSend,
        },
        (chunk) => {
          assistantText += chunk;
          setStreamBuffer(assistantText);
        },
      );

      await persistSession({
        ...requestSession,
        hasPendingContext: false,
        messages: [
          ...requestSession.messages,
          {
            role: 'assistant',
            content: assistantText,
            createdAt: new Date().toISOString(),
          },
        ],
        updatedAt: new Date().toISOString(),
      });
      setStreamBuffer('');
    } catch (error) {
      setChatError(error instanceof Error ? error.message : '消息发送失败');
      setStreamBuffer('');
      await persistSession({
        ...requestSession,
        hasPendingContext: false,
        messages: [...requestSession.messages, buildAssistantError(error)],
        updatedAt: new Date().toISOString(),
      });
    } finally {
      setStreaming(false);
    }
  }

  async function handleSaveInsight() {
    if (!pageSession || !selectedBot || saveState === 'saving') return;

    setSaveState('saving');
    setSaveError('');
    try {
      const insight = await saveInsight({
        pageContext: pageSession.contextSnapshot || pageSession.pageContext,
        summary: pageSession.summary,
        chatTranscript: pageSession.messages,
        botId: selectedBot.botId,
        botKind: selectedBot.kind,
        botName: selectedBot.name,
      });

      await persistSession({
        ...pageSession,
        savedInsightId: insight.id,
        updatedAt: new Date().toISOString(),
      });
      setSaveState('saved');
    } catch (error) {
      setSaveState('error');
      setSaveError(error instanceof Error ? error.message : '保存失败');
    }
  }

  const assistantName = selectedBot?.name || '插件助手';
  const statusText = authState === 'ready'
    ? `${session?.user.account}${typeof pointsBalance === 'number' ? ` · ${pointsBalance} 积分` : ''}`
    : '请先在主站登录，再回到侧边栏使用总结、对话和绘图功能。';

  return (
    <div className="sidepanel-shell">
      <header className="sidepanel-header">
        <div>
          <div className="eyebrow">浏览器插件</div>
          <h1>网页助手</h1>
          <p className="header-copy">先总结，再围绕当前网页继续追问，必要时也可以直接出图。</p>
        </div>
        <button className="ghost-btn" onClick={() => void loadActivePage()}>
          刷新页面
        </button>
      </header>

      <section className="status-bar">
        <div className={`status-pill ${authState}`}>
          {authState === 'ready' ? '已同步登录' : authState === 'checking' ? '同步检查中' : '未同步登录'}
        </div>
        <div className="status-main">
          <strong>{pageSession?.pageTitle || '当前页面'}</strong>
          <span>{statusText}</span>
        </div>
      </section>

      {pageError ? <div className="error-box">{pageError}</div> : null}
      {summaryError ? <div className="error-box">{summaryError}</div> : null}
      {chatError ? <div className="error-box">{chatError}</div> : null}
      {saveError ? <div className="error-box">{saveError}</div> : null}

      {authState !== 'ready' ? (
        <section className="panel auth-panel">
          <h2>需要先同步主站登录</h2>
          <p>插件不会单独保存账号密码。请在主站完成登录后，再回这里点击“刷新同步”。</p>
          <div className="row actions-row">
            <button className="ghost-btn" onClick={() => void refreshAuth()}>
              刷新同步
            </button>
            <button className="primary-btn" onClick={() => void openMainSite('/login')}>
              打开主站登录
            </button>
          </div>
        </section>
      ) : null}

      <section className="panel summary-panel">
        <div className="section-head">
          <div>
            <div className="panel-title">总结当前页面</div>
            <div className="panel-subtitle">优先读取正文和字幕，不做音频转写。</div>
          </div>
          <button
            className="primary-btn"
            onClick={() => void handleSummarize()}
            disabled={authState !== 'ready' || !pageSession || summaryLoading}
          >
            {summaryLoading ? '总结中...' : '立即总结'}
          </button>
        </div>

        {renderedSummary ? (
          <div className={`summary-body ${summaryLoading ? 'is-streaming' : ''}`}>
            <RichTextContent content={renderedSummary} />
          </div>
        ) : (
          <div className="empty-block">
            登录同步成功后，点击“立即总结”，这里会给出当前页面的核心结论和要点。
          </div>
        )}
      </section>

      <section className="panel chat-panel">
        <div className="section-head">
          <div>
            <div className="panel-title">用当前机器人对话</div>
            <div className="panel-subtitle">首次提问会自动注入当前页面快照，后续追问默认沿用这份上下文。</div>
          </div>
        </div>

        <div className="field">
          <label htmlFor="bot-select">当前机器人</label>
          <select
            id="bot-select"
            value={pageSession?.botId || DEFAULT_BOT_ID}
            onChange={(event) => void handleBotChange(event.target.value)}
            disabled={botsLoading || !pageSession || authState !== 'ready'}
          >
            {groupedBots.map(([group, groupBots]) => (
              <optgroup key={group} label={group}>
                {groupBots.map((bot) => (
                  <option key={bot.botId} value={bot.botId}>
                    {bot.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="row controls-row">
          <button className="ghost-btn" onClick={() => void handleRefreshSnapshot()} disabled={!pageSession}>
            刷新页面快照
          </button>
          <button className="ghost-btn" onClick={() => void openMainSite('/my-bots')}>
            管理机器人
          </button>
          <button
            className="primary-btn"
            onClick={() => void handleSaveInsight()}
            disabled={!canSaveInsight || saveState === 'saving'}
          >
            {saveState === 'saving' ? '保存中...' : '保存到主站'}
          </button>
        </div>

        <div className="snapshot-note">
          {pageSession?.contextSnapshot
            ? pageSession.hasPendingContext
              ? '新的页面快照会在下一次提问时注入。'
              : '当前对话已经锁定一份页面快照。'
            : '首次提问时会自动注入当前页面快照。'}
        </div>

        {saveState === 'saved' && pageSession?.savedInsightId ? (
          <div className="saved-banner">
            <span>已保存为网页洞察。</span>
            <button className="ghost-btn" onClick={() => void openMainSite(`/insights/${pageSession.savedInsightId}`)}>
              在主站查看
            </button>
          </div>
        ) : null}

        <div className="messages-panel">
          {pageSession?.messages.length ? (
            pageSession.messages.map((message, index) => (
              <article
                key={`${message.role}-${index}-${message.createdAt || ''}`}
                className={`message-card ${message.role === 'user' ? 'user' : 'assistant'}`}
              >
                <div className="message-role">{message.role === 'user' ? '你' : assistantName}</div>
                {message.kind === 'image' && message.imageUrls?.length ? (
                  <div className="image-message">
                    {message.content ? <RichTextContent content={message.content} className="message-rich" /> : null}
                    <div className={`image-grid ${message.imageUrls.length === 1 ? 'single' : ''}`}>
                      {message.imageUrls.map((imageUrl, imageIndex) => (
                        <a
                          key={`${imageUrl}-${imageIndex}`}
                          href={imageUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="image-link"
                        >
                          <img
                            src={imageUrl}
                            alt={`generated-${imageIndex + 1}`}
                            className="image-thumb"
                            loading="lazy"
                          />
                        </a>
                      ))}
                    </div>
                  </div>
                ) : (
                  <RichTextContent content={message.content} className="message-rich" />
                )}
              </article>
            ))
          ) : (
            <div className="empty-state">
              <strong>还没有开始对话</strong>
              <span>先做页面总结、直接提问，或开启绘图模式生成图片。</span>
            </div>
          )}

          {streaming && streamBuffer ? (
            <article className="message-card assistant streaming">
              <div className="message-role">{assistantName}</div>
              <RichTextContent content={streamBuffer} className="message-rich" />
            </article>
          ) : null}
        </div>
      </section>

      <footer className="composer">
        <div className="composer-toolbar">
          <button
            type="button"
            className={`mode-toggle ${imageModeEnabled ? 'active' : ''}`}
            onClick={() => setImageModeEnabled((current) => !current)}
            disabled={authState !== 'ready' || streaming}
          >
            {imageModeEnabled ? '绘图已开' : '绘图已关'}
          </button>
          <span className="composer-hint">
            {imageModeEnabled
              ? '开启后会直接调用绘图能力，当前输入会作为出图提示词，默认生成 1 张 1:1 图片。'
              : '关闭时为普通对话模式。'}
          </span>
        </div>

        <div className="composer-main">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
            placeholder={imageModeEnabled
              ? '输入想生成的图片描述。Enter 发送，Shift+Enter 换行。'
              : '围绕当前网页继续提问。Enter 发送，Shift+Enter 换行。'}
            disabled={authState !== 'ready' || !pageSession || streaming}
          />

          <button
            className="primary-btn send-btn"
            onClick={() => void handleSend()}
            disabled={!draft.trim() || streaming || authState !== 'ready' || !pageSession}
          >
            {streaming ? (imageModeEnabled ? '出图中...' : '生成中...') : (imageModeEnabled ? '生成图片' : '发送')}
          </button>
        </div>
      </footer>
    </div>
  );
}

const sidePanelRoot = document.getElementById('root');
if (sidePanelRoot) {
  createRoot(sidePanelRoot).render(<SidePanel />);
}
