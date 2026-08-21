'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, KeyRound, Plus, RefreshCw, Search, Settings2, UserRound } from 'lucide-react';
import {
    api,
    type AdminMemberInfo,
    type AdminRegistrationOptionInfo,
} from '../lib/api';
import type { BotAccessSummary } from '../lib/bot-access';
import type { OfficialBotCatalogEntry } from '../lib/bot-access-catalog';
import { KB_CHAT_ROLES, type KbChatRoleAccessSummary } from '../lib/kb-chat-roles';
import { useAuthStore } from '../stores/auth';
import styles from './admin.module.css';

type AdminTab = 'options' | 'access';
type OptionKind = 'name' | 'group';

function sortedKeys(keys: string[]): string[] {
    return [...keys].sort((left, right) => left.localeCompare(right));
}

function sameKeys(left: string[], right: string[]): boolean {
    const sortedLeft = sortedKeys(left);
    const sortedRight = sortedKeys(right);
    return sortedLeft.length === sortedRight.length
        && sortedLeft.every((key, index) => key === sortedRight[index]);
}

export default function AdminConsolePage() {
    const router = useRouter();
    const { user, isAuthenticated, isLoading, loadUser } = useAuthStore();

    const [activeTab, setActiveTab] = useState<AdminTab>('options');
    const [options, setOptions] = useState<AdminRegistrationOptionInfo[]>([]);
    const [members, setMembers] = useState<AdminMemberInfo[]>([]);
    const [catalog, setCatalog] = useState<OfficialBotCatalogEntry[]>([]);
    const [selectedMemberId, setSelectedMemberId] = useState('');
    const [memberSearch, setMemberSearch] = useState('');
    const [draftBotKeys, setDraftBotKeys] = useState<string[]>([]);
    const [savedBotKeys, setSavedBotKeys] = useState<string[]>([]);
    const [savedMode, setSavedMode] = useState<'all' | 'selected'>('all');
    const [draftRoleKeys, setDraftRoleKeys] = useState<string[]>([]);
    const [savedRoleKeys, setSavedRoleKeys] = useState<string[]>([]);
    const [savedRoleMode, setSavedRoleMode] = useState<'all' | 'selected'>('all');
    const [nameDraft, setNameDraft] = useState('');
    const [groupDraft, setGroupDraft] = useState('');
    const [loadingOptions, setLoadingOptions] = useState(false);
    const [loadingAccess, setLoadingAccess] = useState(false);
    const [saving, setSaving] = useState(false);
    const [busyOptionId, setBusyOptionId] = useState('');
    const [busyMemberId, setBusyMemberId] = useState('');
    const [showDisabledMembers, setShowDisabledMembers] = useState(false);
    const [addingKind, setAddingKind] = useState<OptionKind | ''>('');
    const [error, setError] = useState('');
    const [status, setStatus] = useState('');

    useEffect(() => {
        void loadUser();
    }, [loadUser]);

    useEffect(() => {
        if (isLoading) return;
        if (!isAuthenticated) {
            router.replace('/login');
            return;
        }
        if (user && user.role !== 'admin') {
            router.replace('/');
        }
    }, [isAuthenticated, isLoading, router, user]);

    const loadOptions = useCallback(async () => {
        setLoadingOptions(true);
        setError('');
        try {
            const response = await api.getAdminRegistrationOptions();
            setOptions(response.data);
        } catch (err) {
            setError(err instanceof Error ? err.message : '加载注册选项失败。');
        } finally {
            setLoadingOptions(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated && user?.role === 'admin') {
            void loadOptions();
        }
    }, [isAuthenticated, loadOptions, user?.role]);

    const setMemberDraft = useCallback((member: AdminMemberInfo, entries: OfficialBotCatalogEntry[]) => {
        const effectiveKeys = member.botAccess.mode === 'all'
            ? entries.map((entry) => entry.botKey)
            : member.botAccess.botKeys;
        const effectiveRoleKeys = member.kbChatRoles.mode === 'all'
            ? KB_CHAT_ROLES.map((role) => role.roleKey)
            : member.kbChatRoles.roleKeys;
        setSelectedMemberId(member.id);
        setDraftBotKeys(effectiveKeys);
        setSavedBotKeys(effectiveKeys);
        setSavedMode(member.botAccess.mode);
        setDraftRoleKeys(effectiveRoleKeys);
        setSavedRoleKeys(effectiveRoleKeys);
        setSavedRoleMode(member.kbChatRoles.mode);
    }, []);

    const loadAccessData = useCallback(async () => {
        setLoadingAccess(true);
        setError('');
        try {
            const [memberResponse, catalogResponse] = await Promise.all([
                api.getAdminMembers(),
                api.getAdminBotCatalog(),
            ]);
            setMembers(memberResponse.data);
            setCatalog(catalogResponse.data);
            const preferred = memberResponse.data.find((member) => (
                member.id === selectedMemberId && (showDisabledMembers || member.isActive !== false)
            ))
                || memberResponse.data.find((member) => member.isActive !== false)
                || (showDisabledMembers ? memberResponse.data[0] : undefined);
            if (preferred) {
                setMemberDraft(preferred, catalogResponse.data);
            } else {
                setSelectedMemberId('');
                setDraftBotKeys([]);
                setSavedBotKeys([]);
                setSavedMode('all');
                setDraftRoleKeys([]);
                setSavedRoleKeys([]);
                setSavedRoleMode('all');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : '加载成员权限失败。');
        } finally {
            setLoadingAccess(false);
        }
    }, [selectedMemberId, setMemberDraft, showDisabledMembers]);

    useEffect(() => {
        if (activeTab === 'access' && isAuthenticated && user?.role === 'admin') {
            void loadAccessData();
        }
    }, [activeTab, isAuthenticated, loadAccessData, user?.role]);

    const selectedMember = members.find((member) => member.id === selectedMemberId) || null;
    const allCatalogKeys = useMemo(() => catalog.map((entry) => entry.botKey), [catalog]);
    const allRoleKeys = useMemo(() => KB_CHAT_ROLES.map((role) => role.roleKey), []);
    const isBotDirty = !sameKeys(draftBotKeys, savedBotKeys);
    const isRoleDirty = !sameKeys(draftRoleKeys, savedRoleKeys);
    const isDirty = isBotDirty || isRoleDirty;

    const normalizedMemberSearch = memberSearch.trim().toLowerCase();
    const visibleMembers = members.filter((member) => showDisabledMembers || member.isActive !== false);
    const filteredMembers = visibleMembers.filter((member) => !normalizedMemberSearch || [
        member.account,
        member.nickname,
        member.groupName,
    ].some((value) => value.toLowerCase().includes(normalizedMemberSearch)));
    const canEditSelectedMember = Boolean(selectedMember && selectedMember.isActive !== false);

    const catalogGroups = useMemo(() => {
        const groups = new Map<string, OfficialBotCatalogEntry[]>();
        for (const entry of catalog) {
            const current = groups.get(entry.category) || [];
            current.push(entry);
            groups.set(entry.category, current);
        }
        return [...groups.entries()];
    }, [catalog]);

    function confirmDiscard(): boolean {
        return !isDirty || window.confirm('当前权限尚未保存，确定离开吗？');
    }

    function handleBack() {
        if (confirmDiscard()) router.push('/');
    }

    function changeTab(nextTab: AdminTab) {
        if (nextTab === activeTab || (activeTab === 'access' && !confirmDiscard())) return;
        setActiveTab(nextTab);
        setError('');
        setStatus('');
    }

    function selectMember(member: AdminMemberInfo) {
        if (member.id === selectedMemberId || !confirmDiscard()) return;
        setMemberDraft(member, catalog);
        setError('');
        setStatus('');
    }

    async function addOption(kind: OptionKind) {
        const label = (kind === 'name' ? nameDraft : groupDraft).trim();
        if (!label) return;
        setAddingKind(kind);
        setError('');
        setStatus('');
        try {
            await api.createAdminRegistrationOption({ kind, label });
            if (kind === 'name') setNameDraft('');
            else setGroupDraft('');
            await loadOptions();
            setStatus(`已添加${kind === 'name' ? '姓名' : '组别'}“${label}”。`);
        } catch (err) {
            setError(err instanceof Error ? err.message : '添加选项失败。');
        } finally {
            setAddingKind('');
        }
    }

    async function toggleOption(item: AdminRegistrationOptionInfo) {
        if (item.isActive && !window.confirm(`停用“${item.label}”后，新注册人员将无法选择它。确定继续吗？`)) {
            return;
        }
        setBusyOptionId(item.id);
        setError('');
        setStatus('');
        try {
            await api.updateAdminRegistrationOption(item.id, { isActive: !item.isActive });
            await loadOptions();
            setStatus(`已${item.isActive ? '停用' : '恢复'}“${item.label}”。`);
        } catch (err) {
            setError(err instanceof Error ? err.message : '更新选项失败。');
        } finally {
            setBusyOptionId('');
        }
    }

    async function deleteOption(item: AdminRegistrationOptionInfo) {
        const kindLabel = item.kind === 'name' ? '成员' : '组别';
        if (!window.confirm(`删除${kindLabel}“${item.label}”后，新注册人员将无法选择它，已有账号不会改动。确定删除吗？`)) {
            return;
        }
        setBusyOptionId(item.id);
        setError('');
        setStatus('');
        try {
            await api.deleteAdminRegistrationOption(item.id);
            await loadOptions();
            setStatus(`已删除${kindLabel}“${item.label}”。`);
        } catch (err) {
            setError(err instanceof Error ? err.message : '删除选项失败。');
        } finally {
            setBusyOptionId('');
        }
    }

    function applyMemberAccess(memberId: string, access: BotAccessSummary) {
        setMembers((current) => current.map((member) => (
            member.id === memberId ? { ...member, botAccess: access } : member
        )));
        const effectiveKeys = access.mode === 'all' ? allCatalogKeys : access.botKeys;
        setDraftBotKeys(effectiveKeys);
        setSavedBotKeys(effectiveKeys);
        setSavedMode(access.mode);
    }

    function applyMemberKbChatRoles(memberId: string, access: KbChatRoleAccessSummary) {
        setMembers((current) => current.map((member) => (
            member.id === memberId ? { ...member, kbChatRoles: access } : member
        )));
        const effectiveKeys = access.mode === 'all' ? allRoleKeys : access.roleKeys;
        setDraftRoleKeys(effectiveKeys);
        setSavedRoleKeys(effectiveKeys);
        setSavedRoleMode(access.mode);
    }

    async function saveAccess() {
        if (!selectedMember || saving || !isDirty || !selectedMember.isActive) return;
        setSaving(true);
        setError('');
        setStatus('');
        try {
            if (isBotDirty) {
                const response = await api.replaceAdminMemberBotAccess(selectedMember.id, draftBotKeys);
                applyMemberAccess(selectedMember.id, response.data);
            }
            if (isRoleDirty) {
                const response = await api.replaceAdminMemberKbChatRoles(selectedMember.id, draftRoleKeys);
                applyMemberKbChatRoles(selectedMember.id, response.data);
            }
            setStatus(`已保存 ${selectedMember.nickname || selectedMember.account} 的权限。`);
        } catch (err) {
            setError(err instanceof Error ? err.message : '保存权限失败。');
        } finally {
            setSaving(false);
        }
    }

    async function restoreDefault() {
        if (!selectedMember || saving || !selectedMember.isActive) return;
        if (!window.confirm('恢复后该成员将默认可用全部官方智能体，确定继续吗？')) return;
        setSaving(true);
        setError('');
        setStatus('');
        try {
            const response = await api.resetAdminMemberBotAccess(selectedMember.id);
            applyMemberAccess(selectedMember.id, response.data);
            setStatus(`已恢复 ${selectedMember.nickname || selectedMember.account} 的默认全部智能体权限。`);
        } catch (err) {
            setError(err instanceof Error ? err.message : '恢复默认权限失败。');
        } finally {
            setSaving(false);
        }
    }

    async function restoreDefaultRoles() {
        if (!selectedMember || saving || !selectedMember.isActive) return;
        if (!window.confirm('恢复后该成员将默认可用起芽知识库的全部岗位，确定继续吗？')) return;
        setSaving(true);
        setError('');
        setStatus('');
        try {
            const response = await api.resetAdminMemberKbChatRoles(selectedMember.id);
            applyMemberKbChatRoles(selectedMember.id, response.data);
            setStatus(`已恢复 ${selectedMember.nickname || selectedMember.account} 的默认全部知识库岗位。`);
        } catch (err) {
            setError(err instanceof Error ? err.message : '恢复默认岗位失败。');
        } finally {
            setSaving(false);
        }
    }

    async function toggleMemberActive() {
        if (!selectedMember || busyMemberId) return;
        const label = selectedMember.nickname || selectedMember.account;
        if (selectedMember.isActive && !window.confirm(`停用“${label}”后，该账号无法登录，也不会再出现在权限设置中。确定继续吗？`)) {
            return;
        }
        setBusyMemberId(selectedMember.id);
        setError('');
        setStatus('');
        try {
            await api.updateAdminMember(selectedMember.id, { isActive: !selectedMember.isActive });
            await loadAccessData();
            setStatus(`已${selectedMember.isActive ? '停用' : '恢复'}“${label}”。`);
        } catch (err) {
            setError(err instanceof Error ? err.message : '更新账号状态失败。');
        } finally {
            setBusyMemberId('');
        }
    }

    async function deleteMember() {
        if (!selectedMember || busyMemberId) return;
        const label = selectedMember.nickname || selectedMember.account;
        if (!window.confirm(`删除“${label}”后账号无法恢复，权限设置中将不再显示。确定删除吗？`)) {
            return;
        }
        setBusyMemberId(selectedMember.id);
        setError('');
        setStatus('');
        try {
            await api.deleteAdminMember(selectedMember.id);
            setSelectedMemberId('');
            await loadAccessData();
            setStatus(`已删除账号“${label}”。`);
        } catch (err) {
            setError(err instanceof Error ? err.message : '删除账号失败。');
        } finally {
            setBusyMemberId('');
        }
    }

    function toggleBotKey(botKey: string) {
        setDraftBotKeys((current) => current.includes(botKey)
            ? current.filter((key) => key !== botKey)
            : [...current, botKey]);
    }

    function toggleRoleKey(roleKey: string) {
        setDraftRoleKeys((current) => current.includes(roleKey)
            ? current.filter((key) => key !== roleKey)
            : [...current, roleKey]);
    }

    function renderOptionSection(kind: OptionKind, title: string, description: string) {
        const items = options.filter((item) => item.kind === kind);
        const draft = kind === 'name' ? nameDraft : groupDraft;
        const setDraft = kind === 'name' ? setNameDraft : setGroupDraft;
        return (
            <section className={styles.optionCard}>
                <div className={styles.cardHeading}>
                    <div>
                        <h2>{title}</h2>
                        <p>{description}</p>
                    </div>
                    <span className={styles.countBadge}>{items.filter((item) => item.isActive).length} 个可用</span>
                </div>
                <form
                    className={styles.optionForm}
                    onSubmit={(event) => {
                        event.preventDefault();
                        void addOption(kind);
                    }}
                >
                    <input
                        className={styles.optionInput}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={kind === 'name' ? '输入成员姓名' : '输入组别名称'}
                        maxLength={50}
                        aria-label={`新增${title}`}
                    />
                    <button className={styles.primaryButton} type="submit" disabled={!draft.trim() || addingKind === kind}>
                        <Plus size={16} />
                        {addingKind === kind ? '添加中' : '添加'}
                    </button>
                </form>
                <div className={styles.optionList}>
                    {items.length === 0 ? (
                        <p className={styles.emptyState}>还没有{title}，添加后注册页面即可选择。</p>
                    ) : items.map((item) => (
                        <div className={`${styles.optionRow} ${!item.isActive ? styles.optionRowDisabled : ''}`} key={item.id}>
                            <span>{item.label}</span>
                            <div className={styles.optionActions}>
                                <button
                                    className={styles.textButton}
                                    type="button"
                                    onClick={() => void toggleOption(item)}
                                    disabled={busyOptionId === item.id}
                                >
                                    {busyOptionId === item.id ? '处理中' : item.isActive ? '停用' : '恢复'}
                                </button>
                                <button
                                    className={styles.dangerTextButton}
                                    type="button"
                                    onClick={() => void deleteOption(item)}
                                    disabled={busyOptionId === item.id}
                                >
                                    删除
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </section>
        );
    }

    if (isLoading || !user) {
        return <div className={styles.loading}>加载管理员后台...</div>;
    }
    if (user.role !== 'admin') return null;

    return (
        <main className={styles.page}>
            <header className={styles.header}>
                <div>
                    <button type="button" className={styles.backButton} onClick={handleBack}>
                        <ArrowLeft size={16} />
                        返回首页
                    </button>
                    <p className={styles.eyebrow}>ADMIN CONTROL</p>
                    <h1>管理员后台</h1>
                    <p className={styles.subtitle}>维护注册下拉选项，并按成员控制官方智能体和起芽知识库岗位。</p>
                </div>
                <button type="button" className={styles.inviteButton} onClick={() => router.push('/admin/invite-codes')}>
                    <KeyRound size={17} />
                    邀请码管理
                </button>
            </header>

            <nav className={styles.tabs} aria-label="管理员功能">
                <button
                    type="button"
                    className={`${styles.tabButton} ${activeTab === 'options' ? styles.tabActive : ''}`}
                    onClick={() => changeTab('options')}
                >
                    <Settings2 size={17} /> 注册选项
                </button>
                <button
                    type="button"
                    className={`${styles.tabButton} ${activeTab === 'access' ? styles.tabActive : ''}`}
                    onClick={() => changeTab('access')}
                >
                    <UserRound size={17} /> 成员智能体权限
                </button>
            </nav>

            {error ? <div className={styles.errorBanner} role="alert">{error}</div> : null}
            {status ? <div className={styles.statusBanner}><Check size={16} />{status}</div> : null}

            {activeTab === 'options' ? (
                <section>
                    <div className={styles.sectionIntro}>
                        <div>
                            <h2>注册资料选项</h2>
                            <p>姓名和组别互相独立，可自由组合。停用或删除只影响后续注册，不会改动已有账号。</p>
                        </div>
                        <button type="button" className={styles.actionButton} onClick={() => void loadOptions()} disabled={loadingOptions}>
                            <RefreshCw size={16} className={loadingOptions ? styles.spinning : ''} /> 刷新
                        </button>
                    </div>
                    <div className={styles.optionColumns}>
                        {renderOptionSection('name', '姓名选项', '允许同一姓名被多个账号选择。')}
                        {renderOptionSection('group', '组别选项', '独立维护团队、岗位或业务组名称。')}
                    </div>
                </section>
            ) : (
                <section>
                    <div className={styles.sectionIntro}>
                        <div>
                            <h2>成员智能体权限</h2>
                            <p>未单独配置的成员默认可用全部官方智能体和知识库岗位。停用或删除账号后，该成员不会出现在权限设置中，也无法登录。注册选项里的姓名/组别删除不会删除已有账号。</p>
                        </div>
                        <button type="button" className={styles.actionButton} onClick={() => void loadAccessData()} disabled={loadingAccess}>
                            <RefreshCw size={16} className={loadingAccess ? styles.spinning : ''} /> 刷新
                        </button>
                    </div>
                    <div className={styles.accessGrid}>
                        <aside className={styles.memberPanel}>
                            <label className={styles.searchBox}>
                                <Search size={16} />
                                <input
                                    value={memberSearch}
                                    onChange={(event) => setMemberSearch(event.target.value)}
                                    placeholder="搜索账号、姓名或组别"
                                />
                            </label>
                            <label className={styles.showDisabled}>
                                <input
                                    type="checkbox"
                                    checked={showDisabledMembers}
                                    onChange={(event) => setShowDisabledMembers(event.target.checked)}
                                />
                                显示已停用
                            </label>
                            <div className={styles.memberList}>
                                {filteredMembers.length === 0 ? (
                                    <p className={styles.emptyState}>{loadingAccess ? '正在加载成员...' : '没有匹配的成员。'}</p>
                                ) : filteredMembers.map((member) => (
                                    <button
                                        key={member.id}
                                        type="button"
                                        className={`${styles.memberButton} ${member.id === selectedMemberId ? styles.memberButtonActive : ''} ${member.isActive === false ? styles.memberButtonInactive : ''}`}
                                        onClick={() => selectMember(member)}
                                    >
                                        <strong>{member.nickname || '未填写姓名'}</strong>
                                        <code>{member.account}</code>
                                        <span>{member.isActive === false ? '已停用' : (member.groupName || '未填写组别')}</span>
                                    </button>
                                ))}
                            </div>
                        </aside>

                        <div className={styles.permissionPanel}>
                            {selectedMember ? (
                                <>
                                    <div className={`${styles.memberIdentity} ${selectedMember.isActive ? '' : styles.memberIdentityDisabled}`}>
                                        <strong>{selectedMember.nickname || '未填写姓名'}</strong>
                                        <span>账号：{selectedMember.account}</span>
                                        <span>组别：{selectedMember.groupName || '未填写组别'}</span>
                                        <em>{selectedMember.isActive
                                            ? `${savedMode === 'all' ? '智能体默认全部' : '智能体已配置'} · ${savedRoleMode === 'all' ? '岗位默认全部' : '岗位已配置'}`
                                            : '账号已停用'}</em>
                                    </div>
                                    <div className={styles.memberAccountBar}>
                                        <span>{selectedMember.isActive ? '可设置该成员权限' : '已停用账号不能设置权限，可恢复或删除。'}</span>
                                        <div className={styles.optionActions}>
                                            <button
                                                type="button"
                                                className={styles.textButton}
                                                onClick={() => void toggleMemberActive()}
                                                disabled={Boolean(busyMemberId)}
                                            >
                                                {busyMemberId === selectedMember.id ? '处理中' : selectedMember.isActive ? '停用账号' : '恢复账号'}
                                            </button>
                                            <button
                                                type="button"
                                                className={styles.dangerTextButton}
                                                onClick={() => void deleteMember()}
                                                disabled={Boolean(busyMemberId)}
                                            >
                                                删除账号
                                            </button>
                                        </div>
                                    </div>
                                    {canEditSelectedMember ? (
                                        <>
                                    <div className={styles.permissionToolbar}>
                                        <span>已选 {draftBotKeys.length} / {catalog.length}</span>
                                        <div>
                                            <button type="button" className={styles.textButton} onClick={() => setDraftBotKeys(allCatalogKeys)}>全选</button>
                                            <button type="button" className={styles.textButton} onClick={() => setDraftBotKeys([])}>清空</button>
                                            <button type="button" className={styles.textButton} onClick={() => void restoreDefault()} disabled={saving}>恢复默认全部</button>
                                        </div>
                                    </div>
                                    <div className={styles.catalogGroups}>
                                        {catalogGroups.map(([category, entries]) => (
                                            <fieldset className={styles.botGroup} key={category}>
                                                <legend>{category}</legend>
                                                <div className={styles.botGrid}>
                                                    {entries.map((entry) => (
                                                        <label className={styles.botOption} key={entry.botKey}>
                                                            <input
                                                                type="checkbox"
                                                                checked={draftBotKeys.includes(entry.botKey)}
                                                                onChange={() => toggleBotKey(entry.botKey)}
                                                            />
                                                            <span>
                                                                <strong>{entry.name}</strong>
                                                                <small>{entry.entryKind === 'builtin' ? `智能体 ${entry.botKey}` : '独立工具'}</small>
                                                            </span>
                                                        </label>
                                                    ))}
                                                </div>
                                            </fieldset>
                                        ))}
                                        <fieldset className={styles.botGroup}>
                                            <legend>起芽知识库岗位</legend>
                                            <p className={styles.roleHint}>勾选后，该成员进入知识库机器人时只能使用这些岗位。未单独配置时默认全部可选。</p>
                                            <div className={styles.permissionToolbar}>
                                                <span>已选 {draftRoleKeys.length} / {KB_CHAT_ROLES.length}</span>
                                                <div>
                                                    <button type="button" className={styles.textButton} onClick={() => setDraftRoleKeys(allRoleKeys)}>全选</button>
                                                    <button type="button" className={styles.textButton} onClick={() => setDraftRoleKeys([])}>清空</button>
                                                    <button type="button" className={styles.textButton} onClick={() => void restoreDefaultRoles()} disabled={saving}>恢复默认全部岗位</button>
                                                </div>
                                            </div>
                                            <div className={styles.botGrid}>
                                                {KB_CHAT_ROLES.map((role) => (
                                                    <label className={styles.botOption} key={role.roleKey}>
                                                        <input
                                                            type="checkbox"
                                                            checked={draftRoleKeys.includes(role.roleKey)}
                                                            onChange={() => toggleRoleKey(role.roleKey)}
                                                        />
                                                        <span>
                                                            <strong>{role.name}</strong>
                                                            <small>{role.description}</small>
                                                        </span>
                                                    </label>
                                                ))}
                                            </div>
                                        </fieldset>
                                    </div>
                                    <div className={styles.saveBar}>
                                        <span>{isDirty ? '有尚未保存的权限调整' : '权限已保存'}</span>
                                        <button
                                            type="button"
                                            className={styles.primaryButton}
                                            onClick={() => void saveAccess()}
                                            disabled={!isDirty || saving || !canEditSelectedMember}
                                        >
                                            {saving ? '保存中...' : '保存权限'}
                                        </button>
                                    </div>
                                        </>
                                    ) : (
                                        <p className={styles.emptyState}>该账号已停用，无法设置权限。</p>
                                    )}
                                </>
                            ) : (
                                <p className={styles.emptyState}>选择左侧成员后配置智能体权限。</p>
                            )}
                        </div>
                    </div>
                </section>
            )}
        </main>
    );
}
