'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '../stores/auth';
import styles from './my-bots.module.css';
import {
    Plus, Bot, Trash2, MessageSquare, Edit3, Upload, X,
    FileText, Image, File, Loader2, ArrowLeft, Save, Sparkles,
    Brain, Briefcase, GraduationCap, HeartPulse, Lightbulb,
    Megaphone, PenTool, Rocket, Shield, Target, Users, Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';

const PRESET_ICONS: { key: string; icon: ReactNode; color: string; bg: string }[] = [
    { key: 'bot', icon: <Bot size={24} />, color: '#2563eb', bg: '#eff6ff' },
    { key: 'brain', icon: <Brain size={24} />, color: '#7c3aed', bg: '#f5f3ff' },
    { key: 'rocket', icon: <Rocket size={24} />, color: '#ea580c', bg: '#fff7ed' },
    { key: 'lightbulb', icon: <Lightbulb size={24} />, color: '#eab308', bg: '#fefce8' },
    { key: 'target', icon: <Target size={24} />, color: '#dc2626', bg: '#fef2f2' },
    { key: 'briefcase', icon: <Briefcase size={24} />, color: '#0891b2', bg: '#ecfeff' },
    { key: 'users', icon: <Users size={24} />, color: '#059669', bg: '#ecfdf5' },
    { key: 'shield', icon: <Shield size={24} />, color: '#4f46e5', bg: '#eef2ff' },
    { key: 'zap', icon: <Zap size={24} />, color: '#d97706', bg: '#fffbeb' },
    { key: 'megaphone', icon: <Megaphone size={24} />, color: '#e11d48', bg: '#fff1f2' },
    { key: 'pen', icon: <PenTool size={24} />, color: '#0d9488', bg: '#f0fdfa' },
    { key: 'grad', icon: <GraduationCap size={24} />, color: '#6d28d9', bg: '#faf5ff' },
];

function getPresetIcon(key: string | undefined, size = 24): { icon: ReactNode; color: string; bg: string } {
    const found = PRESET_ICONS.find(p => p.key === key);
    if (found) {
        // Re-create icon at requested size
        const sizedIcon = PRESET_ICONS.find(p => p.key === key)!;
        return { ...sizedIcon, icon: <>{sizedIcon.icon}</> };
    }
    return { icon: <Bot size={size} />, color: '#2563eb', bg: '#eff6ff' };
}

interface BotDocument {
    id: string;
    fileName: string;
    fileType: string;
    fileSize: number;
    createdAt: string;
}

interface CustomBot {
    id: string;
    name: string;
    description: string;
    avatar: string;
    icon: string;
    systemPrompt: string;
    pointsPerUse: number;
    documents: BotDocument[];
    createdAt: string;
}

type PendingDocStatus = 'parsing' | 'ready' | 'saving' | 'error';

interface PendingBotDocument {
    id: string;
    fileName: string;
    fileType: string;
    fileSize: number;
    parsedText: string;
    status: PendingDocStatus;
    errorMessage?: string;
}

const API_BASE = '/api';

class RequestError extends Error {
    status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'RequestError';
        this.status = status;
    }
}

function getToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('token');
}

async function apiFetch(path: string, opts: RequestInit = {}) {
    const token = getToken();
    const res = await fetch(`${API_BASE}${path}`, {
        ...opts,
        headers: {
            ...opts.headers,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        },
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ message: '请求失败' }));
        throw new RequestError(err.message || '请求失败', res.status);
    }
    return res.json();
}

export default function MyBotsPage() {
    const router = useRouter();
    const { user } = useAuthStore();
    const [bots, setBots] = useState<CustomBot[]>([]);
    const [loading, setLoading] = useState(false);
    const [showForm, setShowForm] = useState(false);
    const [editingBot, setEditingBot] = useState<CustomBot | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    // Form fields
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [systemPrompt, setSystemPrompt] = useState('');

    // Document upload
    const [docs, setDocs] = useState<BotDocument[]>([]);
    // Pending docs queued during creation or background parsing
    const [pendingDocs, setPendingDocs] = useState<PendingBotDocument[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Selected icon key
    const [selectedIcon, setSelectedIcon] = useState('bot');
    const hasPendingDocWork = pendingDocs.some((doc) => doc.status === 'parsing' || doc.status === 'saving');
    const hasPendingDocError = pendingDocs.some((doc) => doc.status === 'error');
    const uploadingDoc = pendingDocs.some((doc) => doc.status === 'parsing');

    const updatePendingDoc = useCallback((docId: string, updater: (doc: PendingBotDocument) => PendingBotDocument) => {
        setPendingDocs((prev) => prev.map((doc) => (doc.id === docId ? updater(doc) : doc)));
    }, []);

    const loadBots = useCallback(async () => {
        try {
            setLoading(true);
            const res = await apiFetch('/custom-bots');
            setBots(res.data || []);
        } catch (err) {
            console.error('加载智能体失败:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!user) {
            const stored = localStorage.getItem('user');
            if (!stored) { router.push('/login'); return; }
        }
        loadBots();
    }, [user, router, loadBots]);

    const savePendingDocuments = useCallback(async (botId: string, documentsToSave: PendingBotDocument[]) => {
        if (documentsToSave.length === 0) return;

        const payload = documentsToSave.map((doc) => ({
            fileName: doc.fileName,
            fileType: doc.fileType,
            fileSize: doc.fileSize,
            parsedText: doc.parsedText,
        }));

        try {
            await apiFetch(`/custom-bots/${botId}/documents/batch`, {
                method: 'POST',
                body: JSON.stringify({ documents: payload }),
            });
            return;
        } catch (error) {
            // Compatibility fallback for backend instances that haven't deployed the batch route yet.
            if (!(error instanceof RequestError) || (error.status !== 404 && error.status !== 405)) {
                throw error;
            }
        }

        for (const document of payload) {
            await apiFetch(`/custom-bots/${botId}/documents`, {
                method: 'POST',
                body: JSON.stringify(document),
            });
        }
    }, []);

    const resetForm = () => {
        setName('');
        setDescription('');
        setSystemPrompt('');
        setDocs([]);
        setPendingDocs([]);
        setSelectedIcon('bot');
        setEditingBot(null);
        setError('');
    };

    const openCreateForm = () => {
        resetForm();
        setShowForm(true);
    };

    const openEditForm = (bot: CustomBot) => {
        setEditingBot(bot);
        setName(bot.name);
        setDescription(bot.description);
        setSystemPrompt(bot.systemPrompt);
        setDocs(bot.documents || []);
        setPendingDocs([]);
        setSelectedIcon(bot.icon || 'bot');
        setShowForm(true);
        setError('');
    };

    const handleSave = async () => {
        if (!name.trim()) { setError('请输入智能体名称'); return; }
        if (!systemPrompt.trim()) { setError('请输入系统提示词'); return; }
        if (hasPendingDocWork) { setError('文档还在解析或上传中，请稍候再保存'); return; }
        if (hasPendingDocError) { setError('请先移除解析失败的文档，再保存智能体'); return; }
        setSaving(true);
        setError('');

        try {
            let botId: string;

            if (editingBot) {
                const res = await apiFetch(`/custom-bots/${editingBot.id}`, {
                    method: 'PUT',
                    body: JSON.stringify({ name, description, systemPrompt, icon: selectedIcon }),
                });
                botId = res.data.id;
            } else {
                const res = await apiFetch('/custom-bots', {
                    method: 'POST',
                    body: JSON.stringify({ name, description, systemPrompt, icon: selectedIcon }),
                });
                botId = res.data.id;
            }

            const readyPendingDocs = pendingDocs.filter((doc) => doc.status === 'ready');
            if (!editingBot && readyPendingDocs.length > 0) {
                setPendingDocs((prev) => prev.map((doc) => (
                    doc.status === 'ready' ? { ...doc, status: 'saving', errorMessage: undefined } : doc
                )));

                await savePendingDocuments(botId, readyPendingDocs);
            }

            setShowForm(false);
            resetForm();
            await loadBots();
        } catch (err) {
            setPendingDocs((prev) => prev.map((doc) => (
                doc.status === 'saving' ? { ...doc, status: 'ready' } : doc
            )));
            setError(err instanceof Error ? err.message : '保存失败');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('确定要删除这个智能体吗？')) return;
        try {
            await apiFetch(`/custom-bots/${id}`, { method: 'DELETE' });
            await loadBots();
        } catch (err) {
            alert(err instanceof Error ? err.message : '删除失败');
        }
    };

    const handleDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const totalDocs = docs.length + pendingDocs.length;
        if (totalDocs >= 10) { setError('最多只能上传 10 个文档'); return; }

        setError('');

        const ext = file.name.split('.').pop()?.toLowerCase() || '';
        const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
        const pendingDocId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const pendingDocBase: PendingBotDocument = {
            id: pendingDocId,
            fileName: file.name,
            fileType: isImage ? 'image' : ext,
            fileSize: file.size,
            parsedText: '',
            status: 'parsing',
        };

        setPendingDocs((prev) => [...prev, pendingDocBase]);

        try {
            const formData = new FormData();
            formData.append('file', file);

            const parseRes = await fetch('/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` }, body: formData });
            if (!parseRes.ok) {
                const errData = await parseRes.json().catch(() => ({}));
                throw new Error(errData.error || '文件解析失败');
            }
            const parseData = await parseRes.json();
            const docData = {
                fileName: file.name,
                fileType: isImage ? 'image' : ext,
                fileSize: file.size,
                parsedText: parseData.content,
            };

            if (editingBot) {
                updatePendingDoc(pendingDocId, (doc) => ({ ...doc, parsedText: docData.parsedText, status: 'saving', errorMessage: undefined }));
                const res = await apiFetch(`/custom-bots/${editingBot.id}/documents`, {
                    method: 'POST',
                    body: JSON.stringify(docData),
                });
                setPendingDocs((prev) => prev.filter((doc) => doc.id !== pendingDocId));
                setDocs(prev => [res.data, ...prev]);
            } else {
                updatePendingDoc(pendingDocId, (doc) => ({
                    ...doc,
                    parsedText: docData.parsedText,
                    status: 'ready',
                    errorMessage: undefined,
                }));
            }
        } catch (err) {
            updatePendingDoc(pendingDocId, (doc) => ({
                ...doc,
                status: 'error',
                errorMessage: err instanceof Error ? err.message : '文档上传失败',
            }));
            setError(err instanceof Error ? err.message : '文档上传失败');
        } finally {
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const handleDeleteDoc = async (docId: string) => {
        if (pendingDocs.some((doc) => doc.id === docId)) {
            setPendingDocs(prev => prev.filter((doc) => doc.id !== docId));
            return;
        }

        if (editingBot) {
            // Saved doc - delete from backend
            try {
                await apiFetch(`/custom-bots/${editingBot.id}/documents/${docId}`, { method: 'DELETE' });
                setDocs(prev => prev.filter(d => d.id !== docId));
            } catch (err) {
                alert(err instanceof Error ? err.message : '删除失败');
            }
        }
    };

    const startChat = (bot: CustomBot) => {
        router.push(`/chat/custom-${bot.id}?name=${encodeURIComponent(bot.name)}`);
    };

    const formatFileSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    };

    const getDocIcon = (fileType: string) => {
        if (fileType === 'image') return <Image size={16} />;
        if (fileType === 'pdf') return <FileText size={16} />;
        return <File size={16} />;
    };

    return (
        <div className={styles.layout}>
            <header className={styles.header}>
                <button onClick={() => router.push('/')} className={styles.backBtn}>
                    <ArrowLeft size={16} /> 返回
                </button>
                <h1 className={styles.title}><Sparkles size={20} /> 我的智能体</h1>
                <button className={styles.createBtn} onClick={openCreateForm}>
                    <Plus size={16} /> 新建智能体
                </button>
            </header>


            <main className={styles.main}>
                {bots.length === 0 && !showForm ? (
                    <div className={styles.emptyState}>
                        <Bot size={48} />
                        <h3>{loading ? '加载中...' : '还没有智能体'}</h3>
                        <p>创建你的第一个智能体，支持上传知识库和自定义提示词。</p>
                        <button className={styles.createBtnLarge} onClick={openCreateForm}>
                            <Plus size={18} /> 创建智能体
                        </button>
                    </div>
                ) : (
                    <>
                        {/* Bot Cards Grid */}
                        {!showForm && (
                            <div className={styles.grid}>
                                {bots.map(bot => (
                                    <div key={bot.id} className={styles.card}>
                                        <div className={styles.cardTop}>
                                            <div className={styles.cardAvatar} style={{ background: getPresetIcon(bot.icon).bg, color: getPresetIcon(bot.icon).color }}>
                                                {getPresetIcon(bot.icon).icon}
                                            </div>
                                            <div className={styles.cardInfo}>
                                                <h3 className={styles.cardName}>{bot.name}</h3>
                                                <p className={styles.cardDesc}>{bot.description || '暂无描述'}</p>
                                            </div>
                                        </div>
                                        <div className={styles.cardMeta}>
                                            <span><FileText size={12} /> {bot.documents?.length || 0} 个文档</span>
                                        </div>
                                        <div className={styles.cardActions}>
                                            <button onClick={() => startChat(bot)} className={styles.chatBtn}>
                                                <MessageSquare size={14} /> 开始对话
                                            </button>
                                            <button onClick={() => openEditForm(bot)} className={styles.editBtn}>
                                                <Edit3 size={14} /> 编辑
                                            </button>
                                            <button onClick={() => handleDelete(bot.id)} className={styles.deleteBtn}>
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Create/Edit Form */}
                        {showForm && (
                            <div className={styles.formCard}>
                                <div className={styles.formHeader}>
                                    <h2>{editingBot ? '编辑智能体' : '新建智能体'}</h2>
                                    <button onClick={() => { setShowForm(false); resetForm(); }} className={styles.closeBtn}>
                                        <X size={18} />
                                    </button>
                                </div>

                                {error && <div className={styles.error}>{error}</div>}

                                {/* Icon Picker */}
                                <div className={styles.formGroup}>
                                    <label>图标</label>
                                    <div className={styles.iconGrid}>
                                        {PRESET_ICONS.map(p => (
                                            <button
                                                key={p.key}
                                                type="button"
                                                className={`${styles.iconOption} ${selectedIcon === p.key ? styles.iconSelected : ''}`}
                                                style={{ background: p.bg, color: p.color, borderColor: selectedIcon === p.key ? p.color : 'transparent' }}
                                                onClick={() => setSelectedIcon(p.key)}
                                            >
                                                {p.icon}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* Name */}
                                <div className={styles.formGroup}>
                                    <label>智能体名称 *</label>
                                    <input
                                        value={name}
                                        onChange={e => setName(e.target.value)}
                                        placeholder="请输入智能体名称"
                                        maxLength={50}
                                    />
                                </div>

                                {/* Description */}
                                <div className={styles.formGroup}>
                                    <label>简介</label>
                                    <input
                                        value={description}
                                        onChange={e => setDescription(e.target.value)}
                                        placeholder="请输入智能体简介（选填）"
                                        maxLength={200}
                                    />
                                </div>

                                {/* System Prompt */}
                                <div className={styles.formGroup}>
                                    <label>系统提示词 *</label>
                                    <textarea
                                        value={systemPrompt}
                                        onChange={e => setSystemPrompt(e.target.value)}
                                        placeholder="告诉 AI 它的角色、擅长事项和回答风格。例如：你是一位专业的产品经理，擅长需求分析和产品规划。"
                                        rows={8}
                                    />
                                    <span className={styles.charCount}>{systemPrompt.length} 字</span>
                                </div>

                                {/* Knowledge Base Documents - always visible */}
                                <div className={styles.formGroup}>
                                    <label>知识库</label>
                                    <p className={styles.hint}>支持 PDF、Word、TXT、Markdown、CSV 和图片，上传后会作为 AI 知识库使用。</p>

                                    <div className={styles.docList}>
                                        {/* Saved docs (for editing) */}
                                        {docs.map(doc => (
                                            <div key={doc.id} className={styles.docItem}>
                                                {getDocIcon(doc.fileType)}
                                                <span className={styles.docName}>{doc.fileName}</span>
                                                <span className={styles.docSize}>{formatFileSize(doc.fileSize)}</span>
                                                <button onClick={() => handleDeleteDoc(doc.id)} className={styles.docDeleteBtn}>
                                                    <X size={14} />
                                                </button>
                                            </div>
                                        ))}
                                        {/* Pending docs (for creating) */}
                                        {pendingDocs.map((doc) => (
                                            <div
                                                key={doc.id}
                                                className={`${styles.docItem} ${doc.status === 'error' ? styles.docItemError : ''}`}
                                            >
                                                {getDocIcon(doc.fileType)}
                                                <span className={styles.docName}>{doc.fileName}</span>
                                                <span className={styles.docSize}>{formatFileSize(doc.fileSize)}</span>
                                                <span className={`${styles.docStatus} ${styles[`docStatus${doc.status[0].toUpperCase()}${doc.status.slice(1)}`]}`}>
                                                    {doc.status === 'parsing' && <><Loader2 size={12} className="animate-spin" /> 解析中</>}
                                                    {doc.status === 'ready' && '待创建'}
                                                    {doc.status === 'saving' && <><Loader2 size={12} className="animate-spin" /> 保存中</>}
                                                    {doc.status === 'error' && '解析失败'}
                                                </span>
                                                <button onClick={() => handleDeleteDoc(doc.id)} className={styles.docDeleteBtn}>
                                                    <X size={14} />
                                                </button>
                                            </div>
                                        ))}
                                    </div>

                                    {hasPendingDocWork && (
                                        <p className={styles.queueHint}>文档正在后台解析，期间你可以继续填写名称和提示词。</p>
                                    )}
                                    {hasPendingDocError && (
                                        <p className={styles.queueHintError}>有文档解析失败，请删除失败项后再保存。</p>
                                    )}

                                    <button
                                        className={styles.uploadDocBtn}
                                        onClick={() => fileInputRef.current?.click()}
                                        disabled={saving || (docs.length + pendingDocs.length) >= 10}
                                    >
                                        {uploadingDoc ? (
                                            <><Loader2 size={14} className="animate-spin" /> 正在解析文档...</>
                                        ) : (
                                            <><Upload size={14} /> 上传文档 ({docs.length + pendingDocs.length}/10)</>
                                        )}
                                    </button>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept=".pdf,.docx,.txt,.md,.csv,.jpg,.jpeg,.png,.webp"
                                        hidden
                                        onChange={handleDocUpload}
                                    />
                                </div>

                                <div className={styles.formActions}>
                                    <button onClick={() => { setShowForm(false); resetForm(); }} className={styles.cancelBtn}>
                                        取消
                                    </button>
                                    <button onClick={handleSave} className={styles.saveBtn} disabled={saving || hasPendingDocWork}>
                                        {saving ? <><Loader2 size={14} className="animate-spin" /> 保存中...</> : hasPendingDocWork ? <><Loader2 size={14} className="animate-spin" /> 等待文档完成...</> : <><Save size={14} /> {editingBot ? '保存修改' : '创建智能体'}</>}
                                    </button>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </main>
        </div>
    );
}
