'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AdminBotDocumentInfo } from '../lib/api';
import { shouldHideQiyaKnowledgeDocuments } from '../lib/qiya-knowledge-visibility';
import styles from './AdminBotPanel.module.css';
import {
    X, Save, Upload, Loader2, FileText, File, Image,
    ChevronDown, ChevronRight, Code, LayoutList, Search, Trash2,
    Edit3, ArrowLeft, Sparkles, Copy, Check,
} from 'lucide-react';

interface AdminBotPanelProps {
    botId: string;
    botKind: 'builtin' | 'custom';
    isOpen: boolean;
    onClose: () => void;
}

interface PromptSection {
    title: string;
    content: string;
    key: string;
}

function parsePromptSections(prompt: string): PromptSection[] {
    const lines = prompt.split('\n');
    const sections: PromptSection[] = [];
    let currentTitle = '';
    let currentContent: string[] = [];
    let sectionIndex = 0;

    for (const line of lines) {
        const headingMatch = line.match(/^#{1,3}\s+(.+)/);
        if (headingMatch) {
            if (currentTitle || currentContent.length > 0) {
                sections.push({
                    title: currentTitle || '开头',
                    content: currentContent.join('\n').trim(),
                    key: `section-${sectionIndex++}`,
                });
            }
            currentTitle = headingMatch[1].trim();
            currentContent = [];
        } else {
            currentContent.push(line);
        }
    }

    if (currentTitle || currentContent.length > 0) {
        sections.push({
            title: currentTitle || '开头',
            content: currentContent.join('\n').trim(),
            key: `section-${sectionIndex}`,
        });
    }

    return sections;
}

function sectionsToPrompt(sections: PromptSection[]): string {
    return sections
        .map((section) => {
            if (section.title === '开头') return section.content;
            return `# ${section.title}\n${section.content}`;
        })
        .join('\n\n');
}

export default function AdminBotPanel({ botId, botKind, isOpen, onClose }: AdminBotPanelProps) {
    const [systemPrompt, setSystemPrompt] = useState('');
    const [originalPrompt, setOriginalPrompt] = useState('');
    const [documents, setDocuments] = useState<AdminBotDocumentInfo[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [error, setError] = useState('');
    const [successMsg, setSuccessMsg] = useState('');
    const [editorMode, setEditorMode] = useState<'structured' | 'full'>('structured');
    const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
    const [sections, setSections] = useState<PromptSection[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [showSearch, setShowSearch] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);

    // Document editing state
    const [editingDocId, setEditingDocId] = useState<string | null>(null);
    const [editingDocName, setEditingDocName] = useState('');
    const [editingDocText, setEditingDocText] = useState('');
    const [originalDocText, setOriginalDocText] = useState('');
    const [isLoadingDoc, setIsLoadingDoc] = useState(false);
    const [isSavingDoc, setIsSavingDoc] = useState(false);

    // Prompt assistant state
    const [showPromptAssistant, setShowPromptAssistant] = useState(false);
    const [assistantMode, setAssistantMode] = useState<'create' | 'supplement'>('create');
    const [assistantInput, setAssistantInput] = useState('');
    const [assistantOutput, setAssistantOutput] = useState('');
    const [isAssistantStreaming, setIsAssistantStreaming] = useState(false);
    const [assistantCopied, setAssistantCopied] = useState(false);
    const assistantOutputRef = useRef<HTMLDivElement>(null);
    const assistantAbortRef = useRef<AbortController | null>(null);
    const shouldShowKnowledgeDocuments = !shouldHideQiyaKnowledgeDocuments(botId, botKind);

    const loadBotData = useCallback(async () => {
        try {
            setIsLoading(true);
            setError('');
            const res = await api.adminGetBot(botId, botKind);
            const prompt = res.data.systemPrompt || '';
            setSystemPrompt(prompt);
            setOriginalPrompt(prompt);
            setDocuments(shouldShowKnowledgeDocuments ? (res.data.documents || []) : []);
            const parsed = parsePromptSections(prompt);
            setSections(parsed);
            if (parsed.length > 0) {
                setExpandedSections(new Set([parsed[0].key]));
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : '加载失败');
        } finally {
            setIsLoading(false);
        }
    }, [botId, botKind, shouldShowKnowledgeDocuments]);

    useEffect(() => {
        if (isOpen) {
            loadBotData();
            setEditingDocId(null);
        }
    }, [isOpen, loadBotData]);

    useEffect(() => {
        if (successMsg) {
            const timer = setTimeout(() => setSuccessMsg(''), 3000);
            return () => clearTimeout(timer);
        }
    }, [successMsg]);

    const handleSavePrompt = async () => {
        const promptToSave = editorMode === 'structured' ? sectionsToPrompt(sections) : systemPrompt;
        setIsSaving(true);
        setError('');
        try {
            await api.adminUpdateBot(botId, botKind, { systemPrompt: promptToSave });
            setOriginalPrompt(promptToSave);
            setSystemPrompt(promptToSave);
            if (editorMode === 'full') {
                setSections(parsePromptSections(promptToSave));
            }
            setSuccessMsg('保存成功');
        } catch (err) {
            setError(err instanceof Error ? err.message : '保存失败');
        } finally {
            setIsSaving(false);
        }
    };

    const handleSwitchMode = (mode: 'structured' | 'full') => {
        if (mode === 'full' && editorMode === 'structured') {
            setSystemPrompt(sectionsToPrompt(sections));
        } else if (mode === 'structured' && editorMode === 'full') {
            setSections(parsePromptSections(systemPrompt));
        }
        setEditorMode(mode);
    };

    const updateSectionContent = (key: string, newContent: string) => {
        setSections((prev) =>
            prev.map((section) => (section.key === key ? { ...section, content: newContent } : section)),
        );
    };

    const toggleSection = (key: string) => {
        setExpandedSections((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const handleDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (fileInputRef.current) fileInputRef.current.value = '';

        setIsUploading(true);
        setError('');
        try {
            const formData = new FormData();
            formData.append('file', file);
            const parseRes = await fetch('/api/upload', { method: 'POST', body: formData });
            if (!parseRes.ok) {
                const errData = await parseRes.json().catch(() => ({}));
                throw new Error(errData.error || '文件解析失败');
            }
            const parseData = await parseRes.json();
            const ext = file.name.split('.').pop()?.toLowerCase() || '';
            const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);

            const res = await api.adminUploadBotDocument(botId, botKind, {
                fileName: file.name,
                fileType: isImage ? 'image' : ext,
                fileSize: file.size,
                parsedText: parseData.content,
            });
            setDocuments((prev) => [res.data, ...prev]);
            setSuccessMsg('文档上传成功');
        } catch (err) {
            setError(err instanceof Error ? err.message : '上传失败');
        } finally {
            setIsUploading(false);
        }
    };

    const handleDeleteDoc = async (docId: string) => {
        if (!confirm('确定删除这个文档？')) return;
        try {
            if (docId.startsWith('builtin-')) {
                const sourceId = docId.replace('builtin-', '');
                await api.adminDeleteBuiltinKnowledge(sourceId);
            } else {
                await api.adminDeleteBotDocument(botId, docId, botKind);
            }
            setDocuments((prev) => prev.filter((doc) => doc.id !== docId));
            if (editingDocId === docId) setEditingDocId(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : '删除失败');
        }
    };

    const handleEditDoc = async (docId: string) => {
        setIsLoadingDoc(true);
        setError('');
        try {
            if (docId.startsWith('builtin-')) {
                const sourceId = docId.replace('builtin-', '');
                const res = await api.adminGetBuiltinKnowledge(sourceId);
                setEditingDocId(docId);
                setEditingDocName(res.data.title);
                setEditingDocText(res.data.parsedText);
                setOriginalDocText(res.data.parsedText);
            } else {
                const res = await api.adminGetDocumentContent(botId, docId, botKind);
                setEditingDocId(docId);
                setEditingDocName(res.data.fileName);
                setEditingDocText(res.data.parsedText);
                setOriginalDocText(res.data.parsedText);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : '加载文档失败');
        } finally {
            setIsLoadingDoc(false);
        }
    };

    const handleSaveDoc = async () => {
        if (!editingDocId) return;
        setIsSavingDoc(true);
        setError('');
        try {
            if (editingDocId.startsWith('builtin-')) {
                const sourceId = editingDocId.replace('builtin-', '');
                await api.adminUpdateBuiltinKnowledge(sourceId, {
                    parsedText: editingDocText,
                    title: editingDocName,
                });
            } else {
                await api.adminUpdateDocument(botId, editingDocId, botKind, {
                    parsedText: editingDocText,
                    fileName: editingDocName,
                });
            }
            setOriginalDocText(editingDocText);
            setDocuments((prev) =>
                prev.map((doc) => (doc.id === editingDocId ? { ...doc, fileName: editingDocName } : doc)),
            );
            setSuccessMsg('文档保存成功');
        } catch (err) {
            setError(err instanceof Error ? err.message : '保存文档失败');
        } finally {
            setIsSavingDoc(false);
        }
    };

    const docHasChanges = editingDocText !== originalDocText;

    const formatFileSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    };

    const getDocIcon = (fileType: string) => {
        if (fileType === 'image') return <Image size={14} />;
        if (fileType === 'pdf') return <FileText size={14} />;
        return <File size={14} />;
    };

    const hasChanges = editorMode === 'structured'
        ? sectionsToPrompt(sections) !== originalPrompt
        : systemPrompt !== originalPrompt;

    const handleAssistantGenerate = async () => {
        if (!assistantInput.trim() || isAssistantStreaming) return;
        setAssistantOutput('');
        setIsAssistantStreaming(true);
        setAssistantCopied(false);

        const abortCtrl = new AbortController();
        assistantAbortRef.current = abortCtrl;

        try {
            const currentPromptText = editorMode === 'structured'
                ? sectionsToPrompt(sections)
                : systemPrompt;

            const token = localStorage.getItem('token');
            const res = await fetch('/api/admin/prompt-assistant', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({
                    userInput: assistantInput,
                    currentPrompt: currentPromptText || undefined,
                    mode: assistantMode,
                }),
                signal: abortCtrl.signal,
            });

            if (!res.ok || !res.body) throw new Error('请求失败');

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let pending = '';

            while (true) {
                const { done, value } = await reader.read();
                pending += decoder.decode(value || new Uint8Array(), { stream: !done });
                const lines = pending.split('\n');
                pending = lines.pop() || '';

                for (const rawLine of lines) {
                    const line = rawLine.trim();
                    if (!line.startsWith('data:')) continue;
                    const payload = line.slice(5).trim();
                    if (!payload || payload === '[DONE]') continue;
                    try {
                        const data = JSON.parse(payload);
                        if (data.error) throw new Error(data.error);
                        if (data.text) {
                            setAssistantOutput((prev) => prev + data.text);
                            assistantOutputRef.current?.scrollTo(0, assistantOutputRef.current.scrollHeight);
                        }
                    } catch { /* skip */ }
                }
                if (done) break;
            }
        } catch (err) {
            if ((err as Error).name !== 'AbortError') {
                setAssistantOutput((prev) => prev + '\n\n[生成出错: ' + ((err as Error).message || '未知错误') + ']');
            }
        } finally {
            setIsAssistantStreaming(false);
            assistantAbortRef.current = null;
        }
    };

    const handleCopyAssistantOutput = () => {
        if (!assistantOutput.trim()) return;
        navigator.clipboard.writeText(assistantOutput);
        setAssistantCopied(true);
        setTimeout(() => setAssistantCopied(false), 2000);
    };

    if (!isOpen) return null;

    return (
        <div className={styles.overlay} onClick={onClose}>
            <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
                <div className={styles.header}>
                    <h2 className={styles.title}>
                        {editingDocId ? (
                            <button className={styles.backToListBtn} onClick={() => setEditingDocId(null)}>
                                <ArrowLeft size={16} />
                                返回
                            </button>
                        ) : (
                            '⚙️ 管理员设置'
                        )}
                    </h2>
                    <button className={styles.closeBtn} onClick={onClose}>
                        <X size={18} />
                    </button>
                </div>

                {error && <div className={styles.error}>{error}</div>}
                {successMsg && <div className={styles.success}>{successMsg}</div>}

                {isLoading ? (
                    <div className={styles.loading}>
                        <Loader2 size={24} className={styles.spinner} /> 加载中...
                    </div>
                ) : editingDocId ? (
                    /* Document Editor View */
                    <div className={styles.content}>
                        <div className={styles.section}>
                            <div className={styles.sectionHeader}>
                                <h3>编辑文档</h3>
                            </div>

                            {isLoadingDoc ? (
                                <div className={styles.loading}>
                                    <Loader2 size={20} className={styles.spinner} /> 加载文档内容...
                                </div>
                            ) : (
                                <>
                                    <div className={styles.docEditNameRow}>
                                        <label>文件名</label>
                                        <input
                                            type="text"
                                            className={styles.docEditNameInput}
                                            value={editingDocName}
                                            onChange={(e) => setEditingDocName(e.target.value)}
                                        />
                                    </div>
                                    <div className={styles.docEditContent}>
                                        <div className={styles.editorToolbar}>
                                            <span className={styles.charCount}>{editingDocText.length} 字</span>
                                        </div>
                                        <textarea
                                            className={styles.fullTextarea}
                                            value={editingDocText}
                                            onChange={(e) => setEditingDocText(e.target.value)}
                                            rows={20}
                                            spellCheck={false}
                                            placeholder="文档内容为空"
                                        />
                                    </div>
                                    <div className={styles.saveBar}>
                                        <button
                                            className={styles.saveBtn}
                                            onClick={handleSaveDoc}
                                            disabled={isSavingDoc || !docHasChanges}
                                        >
                                            {isSavingDoc
                                                ? <><Loader2 size={14} className={styles.spinner} /> 保存中...</>
                                                : <><Save size={14} /> {docHasChanges ? '保存修改' : '未修改'}</>}
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className={styles.content}>
                        {/* System Prompt Editor */}
                        <div className={styles.section}>
                            <div className={styles.sectionHeader}>
                                <h3>系统提示词</h3>
                                <div className={styles.modeSwitch}>
                                    <button
                                        className={`${styles.modeBtn} ${styles.assistantBtn}`}
                                        onClick={() => setShowPromptAssistant(true)}
                                        title="AI 提示词助手"
                                    >
                                        <Sparkles size={14} /> AI 助写
                                    </button>
                                    <button
                                        className={`${styles.modeBtn} ${editorMode === 'structured' ? styles.modeBtnActive : ''}`}
                                        onClick={() => handleSwitchMode('structured')}
                                        title="结构化编辑"
                                    >
                                        <LayoutList size={14} /> 分段
                                    </button>
                                    <button
                                        className={`${styles.modeBtn} ${editorMode === 'full' ? styles.modeBtnActive : ''}`}
                                        onClick={() => handleSwitchMode('full')}
                                        title="全文编辑"
                                    >
                                        <Code size={14} /> 全文
                                    </button>
                                </div>
                            </div>

                            {editorMode === 'structured' ? (
                                <div className={styles.structuredEditor}>
                                    {sections.length === 0 ? (
                                        <p className={styles.emptyHint}>暂无提示词内容</p>
                                    ) : (
                                        sections.map((section) => (
                                            <div key={section.key} className={styles.promptSection}>
                                                <button
                                                    className={styles.sectionToggle}
                                                    onClick={() => toggleSection(section.key)}
                                                >
                                                    {expandedSections.has(section.key)
                                                        ? <ChevronDown size={14} />
                                                        : <ChevronRight size={14} />}
                                                    <span className={styles.sectionTitle}>{section.title}</span>
                                                    <span className={styles.sectionLength}>{section.content.length} 字</span>
                                                </button>
                                                {expandedSections.has(section.key) && (
                                                    <textarea
                                                        className={styles.sectionTextarea}
                                                        value={section.content}
                                                        onChange={(e) => updateSectionContent(section.key, e.target.value)}
                                                        rows={Math.min(15, Math.max(3, section.content.split('\n').length + 1))}
                                                    />
                                                )}
                                            </div>
                                        ))
                                    )}
                                </div>
                            ) : (
                                <div className={styles.fullEditor}>
                                    <div className={styles.editorToolbar}>
                                        <button
                                            className={styles.searchToggle}
                                            onClick={() => {
                                                setShowSearch(!showSearch);
                                                if (!showSearch) setTimeout(() => searchInputRef.current?.focus(), 100);
                                            }}
                                        >
                                            <Search size={14} /> 搜索
                                        </button>
                                        <span className={styles.charCount}>{systemPrompt.length} 字</span>
                                    </div>
                                    {showSearch && (
                                        <div className={styles.searchBar}>
                                            <input
                                                ref={searchInputRef}
                                                type="text"
                                                placeholder="搜索内容..."
                                                value={searchQuery}
                                                onChange={(e) => setSearchQuery(e.target.value)}
                                                className={styles.searchInput}
                                            />
                                            {searchQuery && (
                                                <span className={styles.searchCount}>
                                                    {(systemPrompt.match(new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length} 处匹配
                                                </span>
                                            )}
                                        </div>
                                    )}
                                    <textarea
                                        className={styles.fullTextarea}
                                        value={systemPrompt}
                                        onChange={(e) => setSystemPrompt(e.target.value)}
                                        rows={20}
                                        spellCheck={false}
                                    />
                                </div>
                            )}

                            <div className={styles.saveBar}>
                                <button
                                    className={styles.saveBtn}
                                    onClick={handleSavePrompt}
                                    disabled={isSaving || !hasChanges}
                                >
                                    {isSaving
                                        ? <><Loader2 size={14} className={styles.spinner} /> 保存中...</>
                                        : <><Save size={14} /> {hasChanges ? '保存修改' : '未修改'}</>}
                                </button>
                            </div>
                        </div>

                        {/* Knowledge Documents */}
                        {shouldShowKnowledgeDocuments ? <div className={styles.section}>
                            <div className={styles.sectionHeader}>
                                <h3>知识库文档</h3>
                                <span className={styles.docCount}>{documents.length} 个</span>
                            </div>

                            <div className={styles.docList}>
                                {documents.map((doc) => (
                                    <div key={doc.id} className={styles.docItem}>
                                        {getDocIcon(doc.fileType)}
                                        <span
                                            className={styles.docName}
                                            onClick={() => handleEditDoc(doc.id)}
                                            title="点击编辑文档内容"
                                        >
                                            {doc.fileName}
                                        </span>
                                        <span className={styles.docSize}>{doc.isBuiltin ? `${doc.fileSize}字` : formatFileSize(doc.fileSize)}</span>
                                        <button
                                            className={styles.docEditBtn}
                                            onClick={() => handleEditDoc(doc.id)}
                                            title="编辑文档内容"
                                        >
                                            <Edit3 size={12} />
                                        </button>
                                        <button
                                            className={styles.docDeleteBtn}
                                            onClick={() => handleDeleteDoc(doc.id)}
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                ))}
                                {documents.length === 0 && (
                                    <p className={styles.emptyHint}>暂无知识文档</p>
                                )}
                            </div>

                            <button
                                className={styles.uploadBtn}
                                onClick={() => fileInputRef.current?.click()}
                                disabled={isUploading}
                            >
                                {isUploading
                                    ? <><Loader2 size={14} className={styles.spinner} /> 解析上传中...</>
                                    : <><Upload size={14} /> 上传文档</>}
                            </button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".pdf,.docx,.txt,.md,.csv,.jpg,.jpeg,.png,.webp"
                                hidden
                                onChange={handleDocUpload}
                            />
                            <p className={styles.uploadHint}>支持 PDF、Word、TXT、Markdown、CSV 和图片</p>
                        </div> : null}
                    </div>
                )}
                {/* Prompt Assistant Modal */}
                {showPromptAssistant && (
                    <div className={styles.assistantOverlay} onClick={() => { if (!isAssistantStreaming) { setShowPromptAssistant(false); assistantAbortRef.current?.abort(); } }}>
                        <div className={styles.assistantModal} onClick={(e) => e.stopPropagation()}>
                            <div className={styles.assistantHeader}>
                                <h3><Sparkles size={16} /> 提示词助手</h3>
                                <button
                                    className={styles.closeBtn}
                                    onClick={() => { setShowPromptAssistant(false); assistantAbortRef.current?.abort(); }}
                                >
                                    <X size={16} />
                                </button>
                            </div>

                            <div className={styles.assistantBody}>
                                <div className={styles.assistantModeTabs}>
                                    <button
                                        className={`${styles.assistantModeTab} ${assistantMode === 'create' ? styles.assistantModeTabActive : ''}`}
                                        onClick={() => { setAssistantMode('create'); setAssistantOutput(''); }}
                                        disabled={isAssistantStreaming}
                                    >
                                        ✨ 从零创建
                                    </button>
                                    <button
                                        className={`${styles.assistantModeTab} ${assistantMode === 'supplement' ? styles.assistantModeTabActive : ''}`}
                                        onClick={() => { setAssistantMode('supplement'); setAssistantOutput(''); }}
                                        disabled={isAssistantStreaming}
                                    >
                                        ➕ 补充提示词
                                    </button>
                                </div>

                                <div className={styles.assistantInputArea}>
                                    <label>
                                        {assistantMode === 'create'
                                            ? '描述你想要的机器人（角色、能力、风格等）'
                                            : '描述你想要补充的内容（AI 会参考现有提示词生成一段补充）'}
                                    </label>
                                    <textarea
                                        className={styles.assistantTextarea}
                                        value={assistantInput}
                                        onChange={(e) => setAssistantInput(e.target.value)}
                                        placeholder={assistantMode === 'create'
                                            ? '例如：我需要一个电商客服机器人，能处理退款、售后问题，语气要专业又温暖...'
                                            : '例如：增加处理用户投诉的能力，要先道歉再解决问题...'}
                                        rows={4}
                                        disabled={isAssistantStreaming}
                                    />
                                    <button
                                        className={styles.assistantGenerateBtn}
                                        onClick={handleAssistantGenerate}
                                        disabled={isAssistantStreaming || !assistantInput.trim()}
                                    >
                                        {isAssistantStreaming
                                            ? <><Loader2 size={14} className={styles.spinner} /> 生成中...</>
                                            : <><Sparkles size={14} /> {assistantMode === 'create' ? '生成提示词' : '生成补充内容'}</>}
                                    </button>
                                </div>

                                {assistantOutput && (
                                    <div className={styles.assistantOutputArea}>
                                        <div className={styles.assistantOutputHeader}>
                                            <span>生成结果</span>
                                        </div>
                                        <div className={styles.assistantOutputContent} ref={assistantOutputRef}>
                                            <pre>{assistantOutput}</pre>
                                        </div>
                                        {!isAssistantStreaming && (
                                            <button
                                                className={styles.assistantApplyBtn}
                                                onClick={handleCopyAssistantOutput}
                                            >
                                                {assistantCopied ? <><Check size={14} /> 已复制</> : <><Copy size={14} /> 复制提示词</>}
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
