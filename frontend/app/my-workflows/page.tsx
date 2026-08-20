'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Plus, Trash2, GitBranch, Play, Edit3, X, Save,
  ChevronUp, ChevronDown, Bot,
} from 'lucide-react';
import { api, type WorkflowInfo } from '../lib/api';
import { BUILTIN_BOT_MAP, BUILTIN_BOTS } from '../lib/builtin-bots';
import { deserializeSimpleWorkflow, serializeSimpleWorkflow, type SimpleWorkflowStep } from '../lib/workflow-simple';
import { canAccessOfficialBot, findDeniedBotKeys } from '../lib/bot-access';
import { getOfficialBot } from '../lib/bot-access-catalog';
import { useAuthStore } from '../stores/auth';
import styles from './myworkflows.module.css';

const BUILTIN_BOT_OPTIONS: Array<{ id: string; name: string }> = BUILTIN_BOTS.map((bot) => ({
  id: bot.routeId,
  name: bot.name,
}));

interface WorkflowItem {
  id: string;
  clientSourceId: string | null;
  name: string;
  description: string;
  steps: SimpleWorkflowStep[];
  createdAt: number;
  updatedAt: number;
}

function localizeStep(step: SimpleWorkflowStep): SimpleWorkflowStep {
  if (step.botId.startsWith('custom-')) {
    return step;
  }

  const builtin = BUILTIN_BOT_MAP[step.botId];
  if (!builtin) {
    return step;
  }

  return {
    botId: step.botId,
    botName: builtin.name,
  };
}

function normalizeWorkflow(workflow: WorkflowInfo): WorkflowItem {
  return {
    id: workflow.id,
    clientSourceId: workflow.clientSourceId,
    name: workflow.name,
    description: workflow.description || '',
    steps: deserializeSimpleWorkflow(workflow.canvasData).map(localizeStep),
    createdAt: new Date(workflow.createdAt).getTime(),
    updatedAt: new Date(workflow.updatedAt).getTime(),
  };
}

export default function MyWorkflowsPage() {
  const router = useRouter();
  const { user, loadUser } = useAuthStore();
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [customBots, setCustomBots] = useState<Array<{ id: string; name: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<WorkflowItem | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<SimpleWorkflowStep[]>([{ botId: '', botName: '' }]);

  const loadCustomBots = useCallback(async () => {
    if (typeof window === 'undefined') return;
    const token = localStorage.getItem('token');
    if (!token) return;

    try {
      const response = await fetch('/api/custom-bots', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = response.ok ? await response.json() : { data: [] };
      setCustomBots((data.data || []).map((bot: { id: string; name: string }) => ({
        id: `custom-${bot.id}`,
        name: bot.name,
      })));
    } catch (error) {
      console.error('[Workflows] Failed to load custom bots', error);
    }
  }, []);

  const loadWorkflows = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await api.getWorkflows({ scope: 'mine' });
      setWorkflows(response.data.map(normalizeWorkflow).sort((a, b) => b.updatedAt - a.updatedAt));
    } catch (error) {
      console.error('[Workflows] Failed to load workflows', error);
      alert(error instanceof Error ? error.message : '加载工作流失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUser();
    void loadWorkflows();
    void loadCustomBots();
  }, [loadCustomBots, loadUser, loadWorkflows]);

  const allBotOptions = useMemo(() => [
    ...BUILTIN_BOT_OPTIONS.filter((bot) => canAccessOfficialBot(user?.botAccess, bot.id)),
    ...customBots,
  ], [customBots, user?.botAccess]);

  const resetForm = () => {
    setName('');
    setDescription('');
    setSteps([{ botId: '', botName: '' }]);
    setEditing(null);
  };

  const openCreate = () => {
    resetForm();
    setShowForm(true);
  };

  const openEdit = (workflow: WorkflowItem) => {
    setEditing(workflow);
    setName(workflow.name);
    setDescription(workflow.description);
    setSteps(workflow.steps.length ? workflow.steps.map(localizeStep) : [{ botId: '', botName: '' }]);
    setShowForm(true);
  };

  const addStep = () => setSteps((current) => [...current, { botId: '', botName: '' }]);

  const removeStep = (index: number) => {
    setSteps((current) => current.filter((_, itemIndex) => itemIndex !== index));
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    setSteps((current) => {
      const next = [...current];
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= next.length) return next;
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  };

  const updateStep = (index: number, botId: string) => {
    const bot = allBotOptions.find((item) => item.id === botId);
    setSteps((current) => current.map((step, itemIndex) => (
      itemIndex === index ? { botId, botName: bot?.name || '' } : step
    )));
  };

  const handleSave = async () => {
    if (!name.trim()) {
      alert('请输入工作流名称');
      return;
    }

    const validSteps = steps.filter((step) => step.botId && step.botName);
    if (validSteps.length < 2) {
      alert('至少需要 2 个步骤');
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        canvasData: serializeSimpleWorkflow(validSteps),
        clientSourceId: editing?.clientSourceId || undefined,
      };

      if (editing) {
        const response = await api.updateWorkflow(editing.id, payload);
        const nextWorkflow = normalizeWorkflow(response.data);
        setWorkflows((current) => current
          .map((item) => (item.id === nextWorkflow.id ? nextWorkflow : item))
          .sort((a, b) => b.updatedAt - a.updatedAt));
      } else {
        const response = await api.createWorkflow(payload);
        const nextWorkflow = normalizeWorkflow(response.data);
        setWorkflows((current) => [nextWorkflow, ...current].sort((a, b) => b.updatedAt - a.updatedAt));
      }

      setShowForm(false);
      resetForm();
    } catch (error) {
      console.error('[Workflows] Failed to save workflow', error);
      alert(error instanceof Error ? error.message : '保存工作流失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除这个工作流吗？')) return;

    try {
      await api.deleteWorkflow(id);
      setWorkflows((current) => current.filter((item) => item.id !== id));
    } catch (error) {
      console.error('[Workflows] Failed to delete workflow', error);
      alert(error instanceof Error ? error.message : '删除工作流失败');
    }
  };

  const launchWorkflow = (workflow: WorkflowItem) => {
    const deniedBotKeys = findDeniedBotKeys(
      user?.botAccess,
      workflow.steps.filter((step) => !step.botId.startsWith('custom-')).map((step) => step.botId),
    );
    if (deniedBotKeys.length > 0) {
      const deniedNames = deniedBotKeys.map((botKey) => getOfficialBot(botKey)?.name || botKey);
      alert(`当前账号没有以下智能体权限：${deniedNames.join('、')}`);
      return;
    }
    sessionStorage.setItem('wf_state', JSON.stringify({
      workflowId: workflow.id,
      workflowName: workflow.name,
      steps: workflow.steps.map((step) => ({ botId: step.botId, botName: step.botName })),
      currentStep: 0,
      stepOutputs: [] as string[],
      selectedMessages: {} as Record<number, string[]>,
    }));
    router.push(`/chat/${workflow.steps[0].botId}?wf=1`);
  };

  const validPreviewSteps = steps.filter((step) => step.botId && step.botName);

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={() => router.push('/')}>
          <ArrowLeft size={16} />
          返回
        </button>
        <span className={styles.headerTitle}>
          <GitBranch size={18} />
          我的工作流
        </span>
        <button className={styles.newBtn} onClick={openCreate}>
          <Plus size={16} />
          新建工作流
        </button>
      </header>

      <div className={styles.content}>
        {showForm ? (
          <div className={styles.formCard}>
            <div className={styles.formHeader}>
              <h2>{editing ? '编辑工作流' : '新建工作流'}</h2>
              <button
                onClick={() => {
                  setShowForm(false);
                  resetForm();
                }}
                className={styles.closeBtn}
              >
                <X size={18} />
              </button>
            </div>

            <div className={styles.formGroup}>
              <label>工作流名称 *</label>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="请输入工作流名称"
              />
            </div>

            <div className={styles.formGroup}>
              <label>工作流说明</label>
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="请输入工作流说明（选填）"
              />
            </div>

            <div className={styles.formGroup}>
              <label>流程步骤（至少 2 步）</label>
              <div className={styles.stepList}>
                {steps.map((step, index) => (
                  <div key={`${step.botId || 'empty'}-${index}`} className={styles.stepItem}>
                    <span className={styles.stepNum}>{index + 1}</span>
                    <select
                      value={step.botId}
                      onChange={(event) => updateStep(index, event.target.value)}
                      className={styles.stepSelect}
                    >
                      <option value="">请选择智能体...</option>
                      <optgroup label="内置智能体">
                        {BUILTIN_BOT_OPTIONS.map((bot) => (
                          <option key={bot.id} value={bot.id}>{bot.name}</option>
                        ))}
                      </optgroup>
                      {customBots.length > 0 && (
                        <optgroup label="我的智能体">
                          {customBots.map((bot) => (
                            <option key={bot.id} value={bot.id}>{bot.name}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>

                    <div className={styles.stepActions}>
                      <button onClick={() => moveStep(index, -1)} disabled={index === 0} className={styles.stepBtn} title="上移">
                        <ChevronUp size={14} />
                      </button>
                      <button onClick={() => moveStep(index, 1)} disabled={index === steps.length - 1} className={styles.stepBtn} title="下移">
                        <ChevronDown size={14} />
                      </button>
                      {steps.length > 1 && (
                        <button onClick={() => removeStep(index)} className={`${styles.stepBtn} ${styles.stepBtnDanger}`} title="删除步骤">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <button onClick={addStep} className={styles.addStepBtn}>
                <Plus size={14} />
                添加步骤
              </button>
            </div>

            {validPreviewSteps.length >= 2 && (
              <div className={styles.preview}>
                <span className={styles.previewLabel}>流程预览</span>
                {validPreviewSteps.map((step, index) => (
                  <span key={`${step.botId}-${index}`}>
                    <span className={styles.previewStep}>{step.botName}</span>
                    {index < validPreviewSteps.length - 1 && <span className={styles.previewArrow}> → </span>}
                  </span>
                ))}
              </div>
            )}

            <div className={styles.formActions}>
              <button
                onClick={() => {
                  setShowForm(false);
                  resetForm();
                }}
                className={styles.cancelBtn}
              >
                取消
              </button>
              <button onClick={() => void handleSave()} className={styles.saveBtn} disabled={isSaving}>
                <Save size={14} />
                {isSaving ? '保存中...' : (editing ? '保存修改' : '创建工作流')}
              </button>
            </div>
          </div>
        ) : isLoading ? (
          <div className={styles.empty}>
            <GitBranch size={48} color="#cbd5e1" />
            <h3>加载工作流中...</h3>
          </div>
        ) : workflows.length === 0 ? (
          <div className={styles.empty}>
            <GitBranch size={48} color="#cbd5e1" />
            <h3>还没有工作流</h3>
            <p>创建你的第一个工作流，把多个智能体串联起来自动协作。</p>
            <button className={styles.emptyBtn} onClick={openCreate}>
              <Plus size={16} />
              创建工作流
            </button>
          </div>
        ) : (
          <div className={styles.grid}>
            {workflows.map((workflow) => (
              <div key={workflow.id} className={styles.card}>
                <div className={styles.cardTop}>
                  <h3 className={styles.cardName}>{workflow.name}</h3>
                </div>
                {workflow.description && <p className={styles.cardDesc}>{workflow.description}</p>}

                <div className={styles.cardSteps}>
                  {workflow.steps.map((step, index) => (
                    <span key={`${step.botId}-${index}`}>
                      <span className={styles.cardStep}>
                        <Bot size={12} />
                        {localizeStep(step).botName}
                      </span>
                      {index < workflow.steps.length - 1 && <span className={styles.cardArrow}> → </span>}
                    </span>
                  ))}
                </div>

                <div className={styles.cardActions}>
                  <button onClick={() => launchWorkflow(workflow)} className={styles.runBtn}>
                    <Play size={14} />
                    应用工作流
                  </button>
                  <button onClick={() => openEdit(workflow)} className={styles.editBtn}>
                    <Edit3 size={14} />
                    编辑
                  </button>
                  <button onClick={() => void handleDelete(workflow.id)} className={styles.deleteBtn} title="删除工作流">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

