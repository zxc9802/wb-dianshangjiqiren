export const QIYA_ENTERPRISE_MANAGEMENT_BOT_ID = '35';
export const GENERIC_CHAT_BOT_ID = '36';
export const VIDEO_BREAKDOWN_BOT_ID = '37';

export interface BuiltinBotDefinition {
    routeId: string;
    slug: string;
    name: string;
    category: string;
    icon: string;
    description: string;
    pointsPerUse: number;
    welcome: string;
    homepageTrial?: boolean;
    showOnHomepage?: boolean;
    systemPromptFallback?: string;
}

export const BUILTIN_BOTS: BuiltinBotDefinition[] = [
    {
        routeId: GENERIC_CHAT_BOT_ID,
        slug: 'generic-chat',
        name: '通用聊天',
        category: '管理工具',
        icon: 'bot',
        description: '不预设固定人设，先帮你把目标、限制和交付要求问清，再给可执行方案。',
        pointsPerUse: 3,
        welcome: '先告诉我你想解决什么。我会先把关键要求问清，再给你方案。',
        homepageTrial: false,
        showOnHomepage: false,
        systemPromptFallback: [
            '回答规则：',
            '1. 默认使用中文。',
            '2. 不使用固定人设口吻，不自称，不做角色扮演。',
            '3. 当用户目标、背景、限制条件、对象、优先级或交付形式还不清楚时，先提出 1 到 3 个最关键的澄清问题，再继续给方案。',
            '4. 当信息已经足够时，直接给出结构化、具体、可执行的回答。',
            '5. 如果用户明确要求不要继续追问，就基于合理假设直接回答，并先列出关键假设。',
            '6. 回答避免空话，优先给步骤、判断标准、方案对比和下一步建议。',
        ].join('\n'),
    },
    {
        routeId: QIYA_ENTERPRISE_MANAGEMENT_BOT_ID,
        slug: 'qiya-enterprise-management',
        name: '起芽成长特助',
        category: '管理工具',
        icon: 'sprout',
        description: '升职加薪问我，不管是SOP,OKR,KPI如何制定，还是工作中有迷茫都可以找我',
        pointsPerUse: 8,
        welcome: '你好，我是起芽成长特助。无论是 SOP、OKR、KPI 的制定，还是工作中的迷茫，都可以直接告诉我。',
        homepageTrial: false,
        systemPromptFallback: [
            '你是“起芽成长特助”，定位是职场成长与管理提效智能体。',
            '你的任务是帮助用户处理升职加薪、SOP、OKR、KPI 制定，以及工作迷茫、成长方向、团队协同与管理提效相关问题。',
            '回答时保持专业、清晰、务实，优先给出可执行结论、判断依据和落地步骤。',
            '如果问题涉及规则、方法论或公司管理口径，优先结合内置知识库回答；如果知识库未覆盖，再用通用管理理解补充。',
            '不要空泛喊口号，也不要大段照抄材料原文。',
        ].join('\n'),
    },
    { routeId: '1', slug: 'kpi-coach', name: 'KPI教练', category: '管理工具', icon: 'target', description: '设计可量化的 KPI 体系，让团队目标清晰可追踪。', pointsPerUse: 5, welcome: '你好，你们团队现在是怎么做绩效考核的？', homepageTrial: true },
    { routeId: '2', slug: 'sop-coach', name: 'SOP梳理AI教练', category: '管理工具', icon: 'list-checks', description: '把经验沉淀成标准流程，提升组织复制效率。', pointsPerUse: 5, welcome: '你好，你想梳理哪个环节的流程？', homepageTrial: true },
    { routeId: '3', slug: 'okr-coach', name: 'OKR教练', category: '管理工具', icon: 'goal', description: '聚焦战略目标，用 OKR 帮团队上下对齐。', pointsPerUse: 5, welcome: '你好，你们今年最重要的目标是什么？', homepageTrial: true },
    { routeId: '4', slug: 'business-advisor', name: '电商商业顾问', category: '管理工具', icon: 'briefcase', description: '多维度分析业务问题，给出可执行的增长建议。', pointsPerUse: 8, welcome: '你好，说说你现在遇到的业务问题。', homepageTrial: true },
    { routeId: '5', slug: 'recruit-coach', name: '招聘教练', category: '管理工具', icon: 'users', description: '从岗位画像到面试评估，优化招聘全流程。', pointsPerUse: 5, welcome: '你好，最近在招什么岗位？', homepageTrial: true },
    { routeId: '6', slug: 'general-assistant', name: 'AI通用助手', category: '管理工具', icon: 'bot', description: '写作、分析、总结、改写等通用任务处理。', pointsPerUse: 3, welcome: '你好，说说你的需求。', homepageTrial: true },
    { routeId: '7', slug: 'image-prompts', name: '一键出10图提示词', category: '电商工具', icon: 'image', description: '快速生成多套电商出图提示词，覆盖不同场景。', pointsPerUse: 8, welcome: '你好，你的产品是什么？', homepageTrial: true },
    { routeId: '8', slug: 'tmall-trends', name: '天猫爆款趋势拆解', category: '电商工具', icon: 'trending-up', description: '拆解类目趋势逻辑，发现潜在爆款机会。', pointsPerUse: 8, welcome: '你好，你想看哪个品类的趋势？', homepageTrial: true },
    { routeId: '9', slug: 'selling-point', name: '卖点教练', category: '电商工具', icon: 'zap', description: '提炼核心卖点，形成更强购买转化表达。', pointsPerUse: 5, welcome: '你好，你的产品是什么？', homepageTrial: true },
    { routeId: '10', slug: 'tmall-main-image', name: '天猫主图策划教练', category: '电商工具', icon: 'layout', description: '输出主图结构、视觉层级与点击优化策略。', pointsPerUse: 5, welcome: '你好，你的产品是什么？目前主图点击率怎么样？', homepageTrial: true },
    { routeId: '11', slug: 'viral-analysis', name: '爆款裂变分析AI教练', category: '电商工具', icon: 'git-branch', description: '拆解爆款可复制元素，扩展到更多人群与场景。', pointsPerUse: 8, welcome: '你好，你想复制哪个爆款的打法？', homepageTrial: true },
    { routeId: '12', slug: 'tmall-reviews', name: '天猫评价教练', category: '电商工具', icon: 'star', description: '优化评价内容结构，提升信任与转化。', pointsPerUse: 5, welcome: '你好，你是什么品类的？', homepageTrial: true },
    { routeId: '13', slug: 'tmall-competition', name: '天猫竞争策略教练', category: '电商工具', icon: 'swords', description: '分析竞品优劣势，制定差异化竞争方案。', pointsPerUse: 8, welcome: '你好，你想分析哪个竞品？', homepageTrial: true },
    { routeId: '14', slug: 'tmall-aov', name: '天猫客单价提升教练', category: '电商工具', icon: 'dollar-sign', description: '通过组合策略与定价设计提升客单价。', pointsPerUse: 5, welcome: '你好，你目前客单价多少？卖什么品类的？', homepageTrial: true },
    { routeId: '15', slug: 'xhs-cover', name: '小红书爆文封面拆解', category: '小红书', icon: 'camera', description: '拆解封面构图、配色与文案排版，提炼爆点模板。', pointsPerUse: 5, welcome: '你好，把爆文封面发过来看看。', homepageTrial: true },
    { routeId: '16', slug: 'xhs-private', name: '小红书私域搭建SOP', category: '小红书', icon: 'link', description: '设计合规引流路径，打通公域到私域转化。', pointsPerUse: 8, welcome: '你好，你目前小红书粉丝量级有多少？', homepageTrial: true },
    { routeId: '17', slug: 'xhs-viral-copy', name: '小红书爆文拆解复制', category: '小红书', icon: 'copy', description: '逆向拆解爆文，沉淀可复用创作方法。', pointsPerUse: 5, welcome: '你好，把想拆解的爆文发过来。', homepageTrial: true },
    { routeId: '18', slug: 'xhs-titles', name: '小红书爆款标题', category: '小红书', icon: 'type', description: '生成多套高点击标题并给出使用建议。', pointsPerUse: 3, welcome: '你好，你做什么方向的内容？', homepageTrial: true },
    { routeId: '19', slug: 'xhs-startup', name: '小红书起号话题', category: '小红书', icon: 'rocket', description: '为新账号制定起号阶段的话题与内容方向。', pointsPerUse: 5, welcome: '你好，你的账号定位和目标人群是什么？', homepageTrial: true },
    { routeId: '20', slug: 'xhs-kol-sop', name: '小红书达人SOP流程', category: '小红书', icon: 'clipboard', description: '规范达人合作流程，从筛选到复盘闭环。', pointsPerUse: 8, welcome: '你好，你的产品是什么？预算大概多少？', homepageTrial: true },
    { routeId: '21', slug: 'xhs-content', name: '小红书正文拆解SOP', category: '小红书', icon: 'file-text', description: '优化正文结构，提升阅读完成率与互动率。', pointsPerUse: 5, welcome: '你好，把想拆解的爆文发过来。', homepageTrial: true },
    { routeId: '22', slug: 'xhs-comments', name: '小红书笔记评论生成', category: '小红书', icon: 'message-circle', description: '批量生成高互动评论，提高内容活跃度。', pointsPerUse: 3, welcome: '你好，你是什么产品？想营造什么样的评论氛围？', homepageTrial: true },
    { routeId: '23', slug: 'mao-strategy', name: '毛泽东战略智能体', category: '企业教练', icon: 'flag', description: '以战略视角分析复杂问题，拆解关键矛盾。', pointsPerUse: 10, welcome: '你好，说说你现在面对的挑战。', homepageTrial: true },
    { routeId: '24', slug: 'jobs-product', name: '乔布斯产品教练', category: '企业教练', icon: 'smartphone', description: '围绕用户体验与产品本质优化方案。', pointsPerUse: 10, welcome: '你好，你的产品解决的是什么问题？', homepageTrial: true },
    { routeId: '25', slug: 'zhangyiming-biz', name: '张一鸣商业教练', category: '企业教练', icon: 'bar-chart', description: '数据驱动决策，建立可验证增长机制。', pointsPerUse: 10, welcome: '你好，你想分析什么问题？', homepageTrial: true },
    { routeId: '26', slug: 'tax-reduction', name: '降税模型测算', category: '财税', icon: 'calculator', description: '评估不同方案的税负影响，支持合规优化。', pointsPerUse: 8, welcome: '你好，你的企业类型和年营收大概多少？', homepageTrial: true },
    { routeId: '27', slug: 'equity-design', name: '股权架构设计', category: '财税', icon: 'git-merge', description: '设计更稳健的股权结构与控制权安排。', pointsPerUse: 10, welcome: '你好，你们目前几个合伙人？股权怎么分的？', homepageTrial: true },
    { routeId: '28', slug: 'platform-compliance', name: '电商平台专项合规', category: '财税', icon: 'shield', description: '梳理平台规则与税务合规重点，规避风险。', pointsPerUse: 8, welcome: '你好，你在哪个平台经营？', homepageTrial: true },
    { routeId: '29', slug: 'salary-tax', name: '薪酬与个税规划', category: '财税', icon: 'wallet', description: '优化薪酬结构，兼顾激励与税务合规。', pointsPerUse: 8, welcome: '你好，你们团队多少人？现在薪酬结构是怎样的？', homepageTrial: true },
    { routeId: '30', slug: 'tax-audit', name: '预警诊断&稽查', category: '财税', icon: 'alert-triangle', description: '提前识别税务风险，完善应对与稽查准备。', pointsPerUse: 10, welcome: '你好，说说你担心的税务问题。', homepageTrial: true },
    { routeId: '31', slug: 'ai-workflow-req', name: 'AI工作流开发需求细化', category: 'AI陪跑教练', icon: 'settings', description: '将模糊想法细化为可执行需求文档。', pointsPerUse: 5, welcome: '你好，你想用 AI 解决什么业务场景？', homepageTrial: true },
    { routeId: '32', slug: 'ai-interview', name: '调研访谈-高价值场景', category: 'AI陪跑教练', icon: 'search', description: '通过调研定位 AI 应用高价值场景。', pointsPerUse: 8, welcome: '你好，你们是做什么业务的？', homepageTrial: true },
    { routeId: '33', slug: 'prompt-debug', name: '火火提示词调试', category: 'AI陪跑教练', icon: 'terminal', description: '快速调试提示词，提升模型输出稳定性。', pointsPerUse: 3, welcome: '你好，把你的提示词发过来看看。', homepageTrial: true },
    { routeId: '34', slug: 'ai-workflow-coach', name: 'AI工作流访谈教练', category: 'AI陪跑教练', icon: 'git-pull-request', description: '梳理流程痛点，设计可落地的 AI 改造路径。', pointsPerUse: 5, welcome: '你好，说说你的业务流程。', homepageTrial: true },
    {
        routeId: VIDEO_BREAKDOWN_BOT_ID,
        slug: 'video-breakdown-director',
        name: '视频拆解导演',
        category: '电商工具',
        icon: 'camera',
        description: '以导演、编导和剪辑的专业视角拆解视频结构、镜头语言、节奏和转化设计。',
        pointsPerUse: 8,
        welcome: '把视频发给我，我会从选题、开场、镜头、节奏、文案、情绪推进和转化设计几个层面帮你拆解。',
        homepageTrial: true,
        systemPromptFallback: [
            '你是“视频拆解导演”，是一名兼具导演、编导、广告策划、剪辑指导能力的视频分析专家。',
            '你的核心任务不是泛泛点评，而是像专业创意总监一样，把视频拆成可复用的方法和可执行的优化建议。',
            '默认优先分析用户上传的视频本体；如果没有视频，再基于脚本、文案、分镜、口播稿或用户描述进行判断。',
            '分析时重点覆盖：选题与目标受众、开场钩子、脚本结构、镜头语言、景别与机位、转场与字幕、节奏与情绪推进、卖点表达、转化动作、结尾收束。',
            '如果视频是带货、种草、投流、品牌宣传、剧情、口播、探店、知识分享等类型，要先判断其内容目标，再围绕该目标给结论。',
            '回答结构尽量稳定：先给整体判断，再给分段拆解，再给亮点、问题、原因和优化建议；能按时间轴拆解时优先按时间轴输出。',
            '不要只给观后感，不要空泛夸奖。每一条判断都尽量说明为什么成立，以及具体该怎么改。',
            '当用户要求复刻或优化视频时，要主动总结可复用公式，包括开头模板、镜头组织方式、节奏设计、文案套路和适用场景。',
            '如果信息不足以做准确判断，先指出缺口，再给基于合理假设的初步拆解方案。',
        ].join('\n'),
    },
];

export const BUILTIN_BOT_MAP = Object.fromEntries(
    BUILTIN_BOTS.map((bot) => [bot.routeId, bot]),
) as Record<string, BuiltinBotDefinition>;

export const BUILTIN_BOT_NAME_MAP = Object.fromEntries(
    BUILTIN_BOTS.map((bot) => [bot.routeId, bot.name]),
) as Record<string, string>;

export const BUILTIN_CATEGORY_ORDER = [...new Set(BUILTIN_BOTS.map((bot) => bot.category))];

export const BUILTIN_DISPLAY_ORDER = Object.fromEntries(
    BUILTIN_BOTS.map((bot, index) => [bot.routeId, index]),
) as Record<string, number>;
