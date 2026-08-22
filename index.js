/* ============================================================
   最近请求记录 (Recent Request Log) — 主逻辑模块（index.js）
   ============================================================ */

/* 【区块索引】（按文件从上到下的顺序）
   1. 动态加载 tour.js   插件启动时加载使用引导模块（保持最前）
   2. 可调参数与常量     全部可调数值/存储键/路径模式，调参只改这里
   3. 状态变量           面板/数据/搜索/回复追踪等运行时内存状态
   4. 工具函数           无副作用的纯函数（转义/模型名/token/角色映射等）
   5. AI 请求体结构验证  判断请求体是否为 AI 生成请求
   6. 请求来源识别       原生入口监听与来源推断（原生/插件）
   7. Fetch 请求拦截     网络层捕获请求体（parse/process/install，含同源 iframe 扩展）
   8. 回复追踪与解析     回复捕获/SSE 解析/错误提取/终态挂载
   9. 数据管理           记录增删、去重指纹、条数上限
   10. 持久化设置        总开关/内容预览/主题/最大记录数读写
   11. 通用弹窗          最大记录数设置 + 通用确认弹窗
   12. 搜索              搜索状态/匹配/高亮/导航
   13. 筛选              筛选状态/匹配/抽屉与分段按钮/指示器
   14. 渲染与 HTML 构建  记录/消息 HTML、renderPanelContent、事件绑定
   15. 折叠展开与回顶闪烁 折叠/展开、滚动锚定、置底回顶、闪烁提示
   16. 记录删除与复制    单条删除、整条/单消息复制、复制反馈
   17. 查看全文覆盖层    覆盖层开合、格式切换、滚动、Esc 关闭
   18. 自定义滚动条      共享观察器、滚动条创建/更新/拖拽、滚动指示器
   19. 面板控制          菜单入口、buildUI、开合/折叠/主题按钮
   20. 拖拽与缩放        面板拖动/右下角缩放
   21. 初始化            等待 ST 就绪并构建 UI
   22. 对外 API          window.__RLogApi 面向 tour.js 的接口
   23. 临时测试功能      烧瓶按钮与模拟注入（后续删除）
   ============================================================ */

/* ── 动态加载 tour.js ─────────────────── */

(function loadTourScript() {
    const currentScript = document.currentScript;
    if (currentScript && currentScript.src) {
        const tourUrl = currentScript.src.replace('index.js', 'tour.js');
        const script = document.createElement('script');
        script.src = tourUrl;
        document.head.appendChild(script);
    } else {
        const script = document.createElement('script');
        script.src = '/scripts/extensions/third-party/RecentRequestLog/tour.js';
        document.head.appendChild(script);
    }
})();

/* ── 可调参数与常量 ──────────────────────── */

const PLUGIN_KEY = 'RecentRequestLog';
const DEFAULT_MAX_RECORDS = 10;         /* 默认最大记录数 */
const MIN_MAX_RECORDS = 10;              /* 用户可设置的最小值 */
const MAX_MAX_RECORDS = 100;            /* 用户可设置的最大值（防止滥用） */
const DOUBLE_CLICK_THRESHOLD = 350;     /* 双击判定时间阈值(ms)，小于此间隔视为双击 */
const STORAGE_THEME_KEY = `${PLUGIN_KEY}_theme`;
const STORAGE_MASTER_KEY = `${PLUGIN_KEY}_masterEnabled`;
const STORAGE_MAX_RECORDS_KEY = `${PLUGIN_KEY}_maxRecords`;  /* 持久化最大记录数 */
const STORAGE_PREVIEW_KEY = `${PLUGIN_KEY}_contentPreview`;  /* 持久化内容预览开关 */
const NATIVE_INTENT_WINDOW_MS = 5000;

/* number: 当前生效的最大记录数上限，从 localStorage 加载或使用默认值 */
let MAX_RECORDS = DEFAULT_MAX_RECORDS;
const AI_GENERATION_PATH_PATTERNS = [
    '/generate',
    '/completions',
    '/chat/completions',
    '/messages',
    'generatecontent',
    'streamgeneratecontent',
];
const ST_NON_GENERATION_PATH_PATTERNS = [
    '/api/chats',
    '/api/characters',
    '/api/settings',
    '/api/backgrounds',
    '/api/assets',
    '/api/extensions',
    '/api/plugins',
    '/api/secrets',
    '/api/sprites',
    '/api/tags',
    '/api/users',
    '/api/content',
    '/api/files',
    '/api/worldinfo',
    '/api/personas',
    '/api/groups',
];
const AI_GENERATION_BODY_KEYS = new Set([
    'model', 'temperature', 'max_tokens', 'max_new_tokens', 'max_length',
    'max_context_length', 'n_predict', 'stream', 'stop', 'stopping_strings',
    'top_p', 'top_k', 'top_a', 'min_p', 'typical_p', 'tfs', 'mirostat',
    'presence_penalty', 'frequency_penalty', 'repetition_penalty',
    'sampler_order', 'samplers', 'chat_completion_source', 'api_server',
    'generationConfig', 'safetySettings', 'tools', 'tool_choice',
    'logit_bias', 'seed',
]);

/* number: 回复追踪超时（5 分钟）：超时未结束即停止追踪并标记 Timeout */
const REPLY_TIMEOUT_MS = 5 * 60 * 1000;

/* number: 回复终态后、记录尚未建成时的最长保留时间（等待 addRecord 挂载） */
const PENDING_REPLY_KEEP_MS = 60 * 1000;
/* number: 回复待办区最大条目数（防止并发请求过多导致内存膨胀） */
const MAX_PENDING_REPLIES = 100;

/* number: 搜索输入防抖延迟(ms)，输入停止后过久再执行搜索 */
const SEARCH_DEBOUNCE_MS = 120;

/* 非 2xx 错误响应体读取上限（字节）：超过即停止读取，避免大错误页浪费 */
const MAX_ERROR_BODY_BYTES = 8192;

/* 置底闪烁兜底定时（ms）：平滑滚动后 scrollend 事件未触发时的兜底等待 */
const SCROLLEND_FALLBACK_MS = 2000;
/* 滚动条懒创建延时（ms）：内容区出现后延迟创建进度条，避免同步重排 */
const SCROLLBAR_CREATE_DELAY_MS = 50;
/* 菜单按钮重排延时（ms）：确保在所有同步初始化的插件之后排在末尾 */
const MENU_REORDER_DELAY_MS = 100;
/* 初始化重试延时（ms）：ST 全局对象尚未就绪时的重试间隔 */
const INIT_RETRY_ST_MS = 200;
/* 初始化重试延时（ms）：ST 上下文尚未就绪时的重试间隔 */
const INIT_RETRY_CTX_MS = 300;
/* APP_READY 兜底等待（ms）：事件可能已触发过，兜底触发 UI 构建 */
const APP_READY_FALLBACK_MS = 500;
/* Token 区间上边界（降序，单位 token）：getTokenTier 按 >= 边界返回区间等级 1-7 */
const TOKEN_TIER_BOUNDARIES = [200000, 128000, 64000, 32000, 16000, 8000, 4000];

/* ── 状态变量 ─────────────────────────── */

/* object|null: ST eventSource */
let eventSource = null;
/* object|null: ST event_types */
let event_types = null;

/* Array: 抓取到的记录列表 */
let records = [];

/* boolean: 使用引导是否进行中（进行中新记录只暂存不显示，避免打断引导 DOM 定位） */
let tourActive = false;

/* Array: 引导期间暂存的新记录（引导结束后由 endTour 合并恢复，保证不丢失） */
let tourPendingRecords = [];

/* HTMLElement|null: 面板 DOM 元素 */
let panelEl = null;

/* HTMLElement|null: 扩展菜单中的按钮 */
let toggleBtn = null;

/* boolean: 面板是否可见 */
let isPanelVisible = false;

/* @type {boolean} 面板内容是否需要重建（数据变化时置 true，渲染完成后清 false）
   面板隐藏时 DOM 完整保留；只有数据/渲染设置变化时才在下次打开时重建 DOM，
   避免展开大量消息时每次打开面板都全量重建造成卡顿。 */
let panelContentDirty = true;

/* boolean: 是否为明亮模式 */
let isLightTheme = false;

/* boolean: 面板窗口是否折叠 */
let isPanelCollapsed = false;

/* boolean: 面板隐藏/折叠期间是否有新记录到达，恢复显示时需要回到列表顶部 */
let pendingScrollToTop = false;

/* boolean: 插件总开关是否启用（持久化到 localStorage，首次安装默认开启） */
let masterEnabled = true;

/* HTMLElement|null: 设置最大记录数的弹窗 DOM 元素 */
let maxRecordsDialog = null;

/* 面板拖拽/缩放相关 */
let panelResizing = false;
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartW = 0;
let resizeStartH = 0;

/* Function|null: 原始 window.fetch 的引用 */
let originalFetch = null;

/* Function|null: 当前安装的 fetch 包装函数 */
let currentHook = null;

/* 注：fetch 重入保护改为每个 realm（主窗口/iframe）独立，见 createFetchHook。 */

/* WeakMap<Window, Function>: 已安装 fetch 包装的窗口 → 包装函数（主窗口 + 同源 iframe）
   用途：① 防止同一窗口重复包装破坏原有 fetch 包装链；
        ② 包装被 iframe 内部脚本替换后据此刻断是否需要重新包装。 */
const hookedFetchHooks = new WeakMap();

/* WeakSet<HTMLIFrameElement>: 已挂「重载后重装包装」监听的 iframe 元素（防重复挂监听） */
const iframeLoadListenersAttached = new WeakSet();

/* boolean: iframe fetch 包装（初始扫描 + MutationObserver 动态监听）是否已安装 */
let iframeHooksInstalled = false;

/* number: 递增的请求捕获编号，用于把回复精确挂回对应记录 */
let captureSeq = 0;

/* 尚未挂载到记录的回复待办区（key: captureId）
   value: {
   startTime,   开始追踪时间（Date.now()）
   timer,       超时定时器 id（超时 → Timeout 标记）
   expireTimer, 终态后短暂保留的清理定时器 id（记录尚未建成时等待挂载）
   status,      终态：'succeed' | 'fail' | 'timeout'
   content,     已累积的正文文本
   reasoning,   已累积的思考文本（reasoning/thinking/thought）
   failReason,  失败/超时原因（悬停提示用）
   time,        终态时间（格式同记录 timestamp）
   reader,      流读取器（超时/清理时 cancel 释放）
   finished,    是否已终态（避免重复 finalize）
   } */
const pendingReplies = new Map();

/* string|null: 上一次记录的 messages 指纹，用于去重 */
let lastRecordFingerprint = null;

/* number: 上一次记录的时间戳 */
let lastRecordTime = 0;

/* { timestamp: number, target: string, source: 'click'|'pointerdown'|'keydown' : |null} 最近一次 ST 原生生成入口 */
let lastNativeIntent = null;

/* boolean: 是否已安装原生入口监听 */
let sourceTrackingInstalled = false;

/* boolean: UI 是否已构建（防止 init() 竞态导致双重建构） */
let uiBuilt = false;

/* boolean: 内容预览开关，默认关闭（持久化到 localStorage） */
let contentPreviewEnabled = false;

/* boolean|null: 强制覆盖内容预览开关（用于引导程序演示） */
let forcePreviewState = null;

/* @type {object|null} 当前搜索状态（同一时间仅一条记录可搜索）
   结构: { recordIndex, keyword, matches, currentIdx, searchEl }
   - recordIndex: 正在搜索的记录索引
   - keyword: 当前搜索关键词（用于判断是否需重新搜索）
   - matches: Array<{ msgIdx, start, end }> 所有匹配位置
   - currentIdx: 当前高亮的是第几个匹配（-1 表示无匹配）
   - searchEl: 搜索框容器 DOM 元素 */
let searchState = null;

/* number|null: 搜索输入 debounce 定时器 ID */
let searchDebounceTimer = null;

/* 筛选状态（会话级内存态：页面存活期内关面板/折叠窗口保留，刷新即重置）
   结构: { source: {native, plugin}, role: {system, user, assistant, other},
           model: {gemini, claude, deepseek, other} }
   默认全开 = 不筛选；任一项为 false 表示「隐藏该分类」。
   来源/模型控制整条记录的显隐；角色控制记录内部子消息（含回复伪消息）的显隐。 */
let filterState = {
    source: { native: true, plugin: true },
    role: { system: true, user: true, assistant: true, other: true },
    model: { gemini: true, claude: true, deepseek: true, other: true },
};

/* HTMLElement|null: 置底跳转后待闪烁的标题栏（平滑滚动到位后触发） */
let pendingFlashHeader = null;
/* number|null: 置底闪烁兜底定时器（scrollend 未触发时兜底） */
let pendingFlashTimer = null;
/* number: 最近一次回顶闪烁触发时间戳（回复挂载重渲染打断时用于补闪） */
let lastTopHintFlashAt = 0;
/* HTMLElement|null: 折叠触发回顶的记录元素（展开同一条记录时才闪烁） */
let recordCollapseToppedEl = null;

/* HTMLElement|null: 当前「查看全文」覆盖层 DOM 元素 */
let readFullOverlayEl = null;

/* number|null: 当前打开覆盖层对应的记录索引 */
let readFullRecordIndex = null;

/* string: 当前显示格式：'formatted'（整理）或 'raw'（原始 JSON） */
let readFullFormat = 'formatted';

/* ── 工具函数 ─────────────────────────── */

/* 从模型名称中提取「家族」标识
   同一家族的模型共享分词器（如 gemini-3.1-pro-preview 和 gemini-3.6-flash 都属 gemini 家族）。
   匹配逻辑参照 ST tokenizers.js 中 getTokenizerModel() 的模型名匹配规则。
   @param {string} modelName 模型名称
   @returns {string} 家族标识，无法识别时返回原始名称的小写 */
function extractModelFamily(modelName) {
    if (!modelName || modelName === '未知模型') return '';
    const m = modelName.toLowerCase();

    /* GPT 家族：gpt、o1、o3、o4、davinci、turbo */
    if (m.includes('gpt') || m.includes('o1-') || m.includes('o3-') || m.includes('o4-') || m.includes('davinci')) return 'gpt';

    /* Claude 家族 */
    if (m.includes('claude')) return 'claude';

    /* Gemini/Gemma 家族（Google 所有模型用 Gemma 分词器） */
    if (m.includes('gemini') || m.includes('gemma') || m.includes('palm')) return 'gemini';

    /* Llama 家族：llama、mistral、mixtral、qwen、deepseek、yi、command-r、command-a、nemo、pixtral、jamba */
    if (m.includes('llama') || m.includes('mistral') || m.includes('mixtral') || m.includes('qwen') || m.includes('deepseek') || m.includes('command-r') || m.includes('command-a') || m.includes('yi-') || m.includes('nemo') || m.includes('pixtral') || m.includes('jamba')) return 'llama';

    /* NovelAI 家族 */
    if (m.includes('kayra') || m.includes('clio') || m.includes('erato')) return 'novelai';

    /* 无法识别，返回原始名称作为家族标识（精确匹配也行） */
    return m;
}

/* 判断两个模型名是否属于同一家族（共享分词器）
   只要能被 extractModelFamily 识别为同一家族即返回 true
   @param {string} modelA 模型名 A（来自请求体）
   @param {string} modelB 模型名 B（来自 ST 主 API）
   @returns {boolean} 是否同家族 */
function isSameModelFamily(modelA, modelB) {
    if (!modelA || modelA === '未知模型' || !modelB) return true; /* 无法判断时默认认为兼容 */
    return extractModelFamily(modelA) === extractModelFamily(modelB);
}

/* 使用 ST 原生分词器为消息列表异步计算 Token 数量
   优先使用 ST context 暴露的 getTokenCountAsync，不可用时降级为字节估算
   逐条异步计算，结果直接写回消息对象的 tokens 字段
   @param {Array} messages 消息列表，每条消息需要有 content 字段
   @param {string} modelName 请求中提取的模型名，用于对比主 API 模型判断分词器兼容性 */
async function computeTokensForMessages(messages, modelName) {
    const ctx = window.SillyTavern && typeof window.SillyTavern.getContext === 'function'
        ? window.SillyTavern.getContext()
        : null;
    const getTokenCountAsync = ctx && ctx.getTokenCountAsync;

    if (!getTokenCountAsync) {
        /* 降级：ST context 不可用时，使用与 ST 一致的字节估算 (BYTES_PER_TOKEN = 3.35) */
        const textEncoder = new TextEncoder();
        for (const msg of messages) {
            const byteLength = textEncoder.encode(msg.content).length;
            msg.tokens = Math.ceil(byteLength / 3.35);
            msg.tokenPrecise = false; /* 标记为非精确值，UI 显示 ~ 前缀 */
        }
        return;
    }

    /* 获取 ST 主 API 的当前模型名称，与请求模型名对比判断分词器是否匹配 */
    let stModelName = '';
    try {
        if (ctx && typeof ctx.getChatCompletionModel === 'function') {
            stModelName = ctx.getChatCompletionModel();
        }
    } catch (e) { /* ignore */ }

    /* 按模型家族（而非全名）对比：同一家族的模型共享分词器，不需要显示 ~ */
    const tokenizerCompatible = isSameModelFamily(modelName, stModelName);

    /* 逐条使用 ST 原生分词器精确计算（每条独立请求，ST 内部有缓存机制） */
    for (const msg of messages) {
        try {
            msg.tokens = await getTokenCountAsync(msg.content, 0);
            msg.tokenPrecise = tokenizerCompatible; /* 仅模型名匹配时才认为精确 */
        } catch (e) {
            /* 分词器调用失败时降级为字节估算 */
            const byteLength = new TextEncoder().encode(msg.content).length;
            msg.tokens = Math.ceil(byteLength / 3.35);
            msg.tokenPrecise = false;
        }
    }
}

/* 从 AI 请求体中提取模型名称
   不同 API 格式的模型字段名称不同，按优先级尝试提取
   @param {object} body 解析后的请求体 JSON
   @returns {string} 模型名称，提取不到则返回 '未知模型' */
function extractModelName(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return '未知模型';

    /* 1. 直接在顶层找 model 字段（OpenAI、大多数兼容格式） */
    if (typeof body.model === 'string' && body.model) return body.model;

    /* 2. Gemini 格式：generationConfig.model */
    if (body.generationConfig && typeof body.generationConfig.model === 'string' && body.generationConfig.model) {
        return body.generationConfig.model;
    }

    /* 3. 尝试从顶层其他常见字段推断 */
    const modelKeys = ['model_name', 'modelName', 'name', 'engine'];
    for (const key of modelKeys) {
        if (typeof body[key] === 'string' && body[key]) return body[key];
    }

    return '未知模型';
}

function getFullPromptText(record) {
    return record.messages
        .map((m) => `[${m.role}]\n${m.content}`)
        .join('\n\n');
}

function getTotalTokens(messages) {
    return messages.reduce((sum, m) => sum + m.tokens, 0);
}

/* 根据 token 总数返回区间等级（0-7）
   @param {number} tokens token 总数
   @returns {number} 0-7 的区间等级 */
function getTokenTier(tokens) {
    for (let i = 0; i < TOKEN_TIER_BOUNDARIES.length; i++) {
        if (tokens >= TOKEN_TIER_BOUNDARIES[i]) return TOKEN_TIER_BOUNDARIES.length - i;
    }
    return 0;
}

function getRoleClass(role) {
    const map = {
        'system': 'role-system',
        'user': 'role-user',
        'assistant': 'role-assistant',
        'tool': 'role-tool',
        'response': 'role-response',
    };
    return map[role] || 'role-other';
}

function getRoleLabel(role) {
    const map = {
        'system': 'System',
        'user': 'User',
        'assistant': 'Assistant',
        'tool': 'Tool',
        'response': 'Response',
    };
    return map[role] || role;
}

/* 提取消息内容开头的预览文字（用于在角色标签旁边显示提示）
   原样保留所有文本（包括 XML 标签），跨行取内容，尽可能多地在预览中显示。
   换行符替换为空格（CSS white-space: nowrap 下单行显示）。
   JS 端截断到 200 字符作为安全上限，实际视觉省略由 CSS 根据面板宽度动态处理。
   @param {string} content 消息完整内容
   @returns {string} 预览文字，内容为空时返回空字符串 */
function getContentPreview(content) {
    if (!content || typeof content !== 'string') return '';
    /* 将换行符替换为空格，然后去掉首尾空白 */
    const collapsed = content.replace(/\n/g, ' ').trim();
    if (!collapsed) return '';
    /* 截断到 200 字符作为安全上限，CSS 会进一步根据宽度做视觉省略 */
    return collapsed.length > 200 ? collapsed.slice(0, 200) + '…' : collapsed;
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/* ── AI 请求体结构验证 ───────────────────── */

/* ST 内部聊天消息对象特征 — 用于排除非 AI 请求的聊天数据
   真正发送给 AI 的消息对象结构：{ role, content }
   ST 内部存储的聊天对象结构：{ chat_metadata, mes, swipe_id, send_date, is_user, is_system, ... } */
const ST_INTERNAL_MSG_KEYS = new Set([
    'chat_metadata', 'mes', 'swipe_id', 'send_date', 'is_user', 'is_system',
    'extra', 'gen_id', 'gen_start', 'gen_finished', 'swipes', 'swipe_info',
    'fork', 'fork_id', 'ch_name', 'file_name', 'integrity', 'note_prompt',
    'note_interval', 'note_position', 'note_depth', 'note_role',
    'timedWorldInfo', 'LWB_PENDING_VAREVENT_BLOCKS',
]);

/* 判断 fetch 输入对应的 URL。 */
function getFetchRequestUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    try {
        if (input instanceof URL) return input.toString();
    } catch (e) { /* ignore */ }
    return '';
}

function getUrlPathForMatch(url) {
    if (!url || typeof url !== 'string') return '';
    try {
        return new URL(url, window.location.href).pathname.toLowerCase();
    } catch (e) {
        return url.toLowerCase();
    }
}

function pathMatchesAny(path, patterns) {
    if (!path) return false;
    return patterns.some(pattern => path.indexOf(pattern) !== -1);
}

function isExplicitNonGenerationUrl(url) {
    const path = getUrlPathForMatch(url);
    return pathMatchesAny(path, ST_NON_GENERATION_PATH_PATTERNS)
        && !pathMatchesAny(path, AI_GENERATION_PATH_PATTERNS);
}

function isPotentialGenerationUrl(url) {
    const path = getUrlPathForMatch(url);
    return pathMatchesAny(path, AI_GENERATION_PATH_PATTERNS);
}

function hasGenerationRequestHints(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    return Object.keys(body).some(k => AI_GENERATION_BODY_KEYS.has(k));
}

/* 严格验证一个对象是否为标准 AI 消息。
   这里有意只接受 role + content，避免把 ST 内部聊天记录、角色卡或系统加载数据误判为生成请求。 */
function isAiMessageObject(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const keys = Object.keys(obj);

    if (keys.some(k => ST_INTERNAL_MSG_KEYS.has(k))) return false;

    if (!keys.includes('role') || !keys.includes('content')) return false;

    const role = typeof obj.role === 'string' ? obj.role.toLowerCase().trim() : '';
    if (!['system', 'user', 'assistant', 'tool', 'function', 'developer', 'model', 'human'].includes(role)) return false;

    if (typeof obj.content === 'string') return obj.content.length > 0;
    if (Array.isArray(obj.content)) return obj.content.length > 0;

    return false;
}

function isGeminiContentObject(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const keys = Object.keys(obj);
    if (keys.some(k => ST_INTERNAL_MSG_KEYS.has(k))) return false;
    if (!('parts' in obj) || !Array.isArray(obj.parts) || obj.parts.length === 0) return false;

    return obj.parts.some(part => {
        if (!part || typeof part !== 'object') return false;
        return typeof part.text === 'string' && part.text.length > 0;
    });
}

/* 判断请求体是否为 AI API 生成请求。
   结构识别为主，URL 和生成参数作为辅助过滤，用于排除加载界面/进入对话时的 ST 内部接口。
   
   优化：检查顺序从最便宜到最昂贵排列——
   1. 基础类型校验（免费）
   2. URL 排除检查（字符串匹配）
   3. 顶层 key 扫描（hasGenerationRequestHints + generationUrl）
   4. 数组遍历 + 逐元素校验（最贵，仅在顶层特征匹配后才执行） */
function isAiRequestBody(body, requestUrl) {
    /* 便宜检查 1：基础类型 */
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;

    /* 便宜检查 2：URL 明确排除（字符串索引匹配，不用遍历数组） */
    if (isExplicitNonGenerationUrl(requestUrl)) return false;

    /* 便宜检查 3：顶层特征扫描 — 只需检查 body 的 key 集合 */
    const generationUrl = isPotentialGenerationUrl(requestUrl);
    const hasHints = hasGenerationRequestHints(body);

    /* 如果既不是生成 URL 也没有生成参数特征，且顶层也没有 messages/chat/contents/system+prompt， */
    /* 那就快速退出，无需遍历数组做昂贵的逐元素校验 */
    if (!generationUrl && !hasHints) {
        /* 快速检查顶层是否有可能包含消息的数组字段 */
        const hasMessagesArray = Array.isArray(body.messages) && body.messages.length > 0;
        const hasChatArray = Array.isArray(body.chat) && body.chat.length > 0;
        const hasContentsArray = Array.isArray(body.contents) && body.contents.length > 0;
        const hasSystemPrompt = typeof body.system === 'string' && body.system.length > 0;
        const hasPlainPrompt = typeof body.prompt === 'string' && body.prompt.length > 0;

        /* 如果没有任何消息容器字段，直接退出 */
        if (!hasMessagesArray && !hasChatArray && !hasContentsArray && !hasSystemPrompt && !hasPlainPrompt) {
            return false;
        }

        /* 如果有 prompt 但没有 generationUrl/hasHints，仍可能是纯文本补全 */
        if (hasPlainPrompt && !hasMessagesArray && !hasChatArray && !hasContentsArray && !hasSystemPrompt) {
            /* 纯文本补全场景放行（由 parseFetchRequestBody 中单独处理） */
            return true;
        }

        /* 其他情况：有数组但没有生成特征，大概率是 ST 内部数据加载，跳过 */
        return false;
    }

    /* 昂贵检查：只在顶层特征匹配后才遍历数组做逐元素校验 */
    const looksLikeGeneration = generationUrl || hasHints;

    if (typeof body.system === 'string' && Array.isArray(body.messages) && body.messages.length > 0) {
        return looksLikeGeneration && body.messages.some(isAiMessageObject);
    }

    if (Array.isArray(body.messages) && body.messages.length > 0) {
        return looksLikeGeneration && body.messages.some(isAiMessageObject);
    }

    if (Array.isArray(body.chat) && body.chat.length > 0) {
        return looksLikeGeneration && body.chat.some(isAiMessageObject);
    }

    if (Array.isArray(body.contents) && body.contents.length > 0) {
        return looksLikeGeneration && body.contents.some(isGeminiContentObject);
    }

    if (typeof body.prompt === 'string' && body.prompt.length > 0) {
        return true;
    }

    return false;
}

/* ── 请求来源识别 ───────────────────────── */

function rememberNativeIntent(target, source) {
    lastNativeIntent = {
        timestamp: Date.now(),
        target,
        source,
    };
}

function installSourceTracking() {
    if (sourceTrackingInstalled) return;
    sourceTrackingInstalled = true;

    const nativeTargets = [
        { selector: '#send_but', label: '发送按钮' },
        { selector: '#option_regenerate', label: '重新生成' },
        { selector: '#option_continue, #mes_continue', label: '继续' },
        { selector: '#mes_impersonate', label: '扮演' },
        { selector: '.swipe_right, .mes_swipe_right, [data-action="swipe-right"], [title="Swipe right"]', label: '生成备选回复' },
    ];

    /* ── 调试：收集近期点击事件日志 (上限 30 条) ── */
    const recentClicks = [];
    const MAX_CLICK_LOG = 30;
    function logClick(action, detail) {
        recentClicks.push({ ts: Date.now(), action, detail });
        if (recentClicks.length > MAX_CLICK_LOG) recentClicks.shift();
    }

    const onNativeClickIntent = (e) => {
        const targetEl = e.target instanceof Element ? e.target : null;
        if (!targetEl) return;

        /* ── 快速区域筛选：只在聊天相关区域内检查，避免菜单/设置等区域的无意义遍历 ── */
        /* #sheld 是 ST 主内容区容器，包含聊天界面和底部操作栏 */
        const chatZone = document.getElementById('sheld') || document.getElementById('chat') || document.getElementById('send_form');
        if (chatZone && !chatZone.contains(targetEl)) {
            return;
        }

        /* 调试：记录每次捕获阶段的事件，包含目标 tag/id/class 和匹配情况 */
        const tagId = targetEl.tagName + (targetEl.id ? '#' + targetEl.id : '') + (targetEl.className && typeof targetEl.className === 'string' ? '.' + targetEl.className.split(' ').slice(0, 3).join('.') : '');
        let matched = null;

        for (const item of nativeTargets) {
            if (targetEl.closest(item.selector)) {
                matched = item;
                break;
            }
        }

        if (matched) {
            logClick('NATIVE_MATCH', `${matched.label} via ${e.type} on ${tagId}`);
            rememberNativeIntent(matched.label, e.type === 'pointerdown' ? 'pointerdown' : 'click');
        } else {
            /* 调试：记录未匹配但可能相关的点击（如包含 mes_、swipe、regenerate 等关键词的元素） */
            const cls = (typeof targetEl.className === 'string' ? targetEl.className : '') + ' ' + (targetEl.getAttribute('title') || '') + ' ' + (targetEl.getAttribute('data-action') || '');
            const hints = ['mes_swipe', 'regenerate', 'swipe', 'mes_continue', 'impersonate', 'send_but'];
            if (hints.some(h => cls.toLowerCase().indexOf(h) !== -1 || tagId.toLowerCase().indexOf(h) !== -1)) {
                logClick('NATIVE_MISS', `未匹配但含关键词: ${tagId} cls="${cls.slice(0, 100)}"`);
            }
        }
    };

    document.addEventListener('pointerdown', onNativeClickIntent, true);
    document.addEventListener('click', onNativeClickIntent, true);

    /* 备选回复 / 重新生成可能不走 pointerdown/click，直接监听 GENERATION_STARTED 作为保底方案 */
    if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
        const stCtx = window.SillyTavern.getContext();
        if (stCtx && stCtx.eventSource && stCtx.event_types) {
            const onGenStarted = (type) => {
                const typeStr = String(type != null ? type : '');
                logClick('GEN_STARTED', `type=${typeStr}`);
                /* 仅当 DOM 点击事件未能捕获时，由 GEN_STARTED 补充标记 */
                /* 备选回复 / 重新生成等明确的原生生成类型。 */
                /* normal/quiet 通常由插件或非用户触发的生成产生，不放行。 */
                if (!lastNativeIntent || (Date.now() - lastNativeIntent.timestamp) > NATIVE_INTENT_WINDOW_MS) {
                    if (typeStr === 'impersonate') {
                        rememberNativeIntent('扮演 (ST事件)', 'generationStarted');
                    } else if (typeStr === 'continue') {
                        rememberNativeIntent('继续 (ST事件)', 'generationStarted');
                    } else if (typeStr === 'regenerate') {
                        rememberNativeIntent('重新生成 (ST事件)', 'generationStarted');
                    } else if (typeStr === 'swipe') {
                        rememberNativeIntent('生成备选回复 (ST事件)', 'generationStarted');
                    }
                    /* send / quiet / normal / 其他 — 不标记，避免误伤插件 */
                }
            };
            try {
                stCtx.eventSource.on(stCtx.event_types.GENERATION_STARTED, onGenStarted);
                logClick('SETUP', '已注册 GENERATION_STARTED 监听 (保底方案)');
            } catch (err) {
                logClick('SETUP_ERR', '注册 GENERATION_STARTED 失败: ' + String(err));
            }
        } else {
            logClick('SETUP', 'ST context 未就绪，无法注册 GENERATION_STARTED');
        }
    }

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (e.isComposing || e.keyCode === 229) return;
        if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;

        const targetEl = e.target;
        if (!(targetEl instanceof HTMLTextAreaElement)) return;
        if (targetEl.id !== 'send_textarea') return;

        logClick('NATIVE_ENTER', '输入框 Enter');
        rememberNativeIntent('输入框 Enter', 'keydown');
    }, true);

    /* 暴露调试接口到 window */
    window.__rlogDebug = {
        getRecentClicks: () => recentClicks.slice(),
        getLastNativeIntent: () => lastNativeIntent,
        getRecords: () => records,
        getIframeHookCount: () => {
            let count = 0;
            document.querySelectorAll('iframe').forEach((f) => {
                try {
                    if (f.contentWindow && hookedFetchHooks.get(f.contentWindow)) count++;
                } catch (e) { /* 跨域 iframe 跳过 */ }
            });
            return count;
        },
        dumpClicks: () => {
            console.table(recentClicks.map(c => ({ time: new Date(c.ts).toISOString().slice(11, 23), ...c })));
            return recentClicks;
        },
    };

    console.debug(`[${PLUGIN_KEY}] 请求来源识别已启用（ST 原生入口监听 + GENERATION_STARTED 保底）。调试接口: window.__rlogDebug`);
}

function inferRequestSource() {
    const now = Date.now();
    if (lastNativeIntent && (now - lastNativeIntent.timestamp) <= NATIVE_INTENT_WINDOW_MS) {
        /* 不立即消费原生入口，以确保重新生成/备选回复等操作中可能出现的中间请求不会错误消费标记。 */
        /* 标记在窗口过期后由下方逻辑自动清除。 */
        return {
            type: 'native',
            label: getSourceLabel({ type: 'native' }),
            detail: `原生请求-${lastNativeIntent.target}`,
        };
    }

    /* 窗口过期后清除原生入口标记 */
    if (lastNativeIntent && (now - lastNativeIntent.timestamp) > NATIVE_INTENT_WINDOW_MS) {
        lastNativeIntent = null;
    }

    return {
        type: 'plugin',
        label: getSourceLabel({ type: 'plugin' }),
        detail: '插件/非原生请求',
    };
}

function getSourceLabel(source) {
    if (source && source.type === 'native') return '原生';
    return '插件';
}

function getSourceClass(source) {
    if (source && source.type === 'native') return 'rlog-source-native';
    return 'rlog-source-plugin';
}

/* ── Fetch 请求拦截 ───────────────────── */

function getCurrentCharacterName() {
    try {
        const ctx = window.SillyTavern && typeof window.SillyTavern.getContext === 'function'
            ? window.SillyTavern.getContext()
            : null;
        if (ctx && ctx.name2) return ctx.name2;
        if (ctx && ctx.characterName) return ctx.characterName;
        const charId = ctx && ctx.characterId;
        if (charId && ctx.characters && ctx.characters[charId] && ctx.characters[charId].name) return ctx.characters[charId].name;
        if (ctx && ctx.groupId && ctx.groups && ctx.groups[ctx.groupId] && ctx.groups[ctx.groupId].name) {
            return ctx.groups[ctx.groupId].name;
        }
    } catch (e) { /* ignore */ }
    return '未知角色';
}

function normalizeRole(role) {
    if (!role || typeof role !== 'string') return 'unknown';
    const r = role.toLowerCase().trim();
    const mapping = {
        'model': 'assistant',
        'bot': 'assistant',
        'ai': 'assistant',
        'human': 'user',
        'usr': 'user',
        'sys': 'system',
        'function': 'tool',
        'tool_calls': 'tool',
        'tool_call': 'tool',
    };
    return mapping[r] || r;
}

/* 解析不同 AI 接口的请求体，统一提取消息列表
   返回 null 表示无法解析（静默跳过，不产生记录） */
function parseFetchRequestBody(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

    const messages = [];

    /* 1. OpenAI / 兼容格式 — messages 数组 */
    if (Array.isArray(json.messages)) {
        for (const m of json.messages) {
            if (!isAiMessageObject(m)) continue;
            let content = '';
            if (typeof m.content === 'string' && m.content) {
                content = m.content;
            } else if (Array.isArray(m.content)) {
                content = m.content
                    .filter(c => c.type === 'text' && c.text)
                    .map(c => c.text)
                    .join('\n');
            }
            if (content) {
                messages.push({
                    role: normalizeRole(m.role),
                    content,
                    tokens: 0, /* token 值在 parseFetchRequestBody 外由 computeTokensForMessages 异步计算 */
                    collapsed: true,
                });
            }
        }
    }

    /* 2. chat 数组 — ST 内部事件格式（可能被 fetch 截获） */
    if (messages.length === 0 && Array.isArray(json.chat)) {
        for (const m of json.chat) {
            if (!isAiMessageObject(m)) continue;
            let content = '';
            if (typeof m.content === 'string' && m.content) {
                content = m.content;
            }
            if (content) {
                messages.push({
                    role: normalizeRole(m.role),
                    content,
                    tokens: 0, /* token 值在 parseFetchRequestBody 外由 computeTokensForMessages 异步计算 */
                    collapsed: true,
                });
            }
        }
    }

    /* 3. Google Gemini 格式 */
    if (messages.length === 0 && Array.isArray(json.contents)) {
        for (const c of json.contents) {
            if (!c || typeof c !== 'object') continue;
            const itemKeys = Object.keys(c);
            if (itemKeys.some(k => ST_INTERNAL_MSG_KEYS.has(k))) continue;
            let content = '';
            if (typeof c.parts === 'object' && Array.isArray(c.parts)) {
                content = c.parts
                    .filter(p => typeof p.text === 'string' && p.text)
                    .map(p => p.text)
                    .join('\n');
            } else if (typeof c.text === 'string') {
                content = c.text;
            }
            if (content) {
                messages.push({
                    role: normalizeRole(c.role || 'user'),
                    content,
                    tokens: 0, /* token 值在 parseFetchRequestBody 外由 computeTokensForMessages 异步计算 */
                    collapsed: true,
                });
            }
        }
    }

    /* 4. Anthropic 格式 */
    if (messages.length === 0 && typeof json.system === 'string' && Array.isArray(json.messages)) {
        if (json.system) {
            messages.push({
                role: 'system',
                content: json.system,
                tokens: 0, /* token 值在 parseFetchRequestBody 外由 computeTokensForMessages 异步计算 */
                collapsed: true,
            });
        }
        for (const m of json.messages) {
            if (!isAiMessageObject(m)) continue;
            if (typeof m.content === 'string' && m.content) {
                messages.push({
                    role: normalizeRole(m.role),
                    content: m.content,
                    tokens: 0, /* token 值在 parseFetchRequestBody 外由 computeTokensForMessages 异步计算 */
                    collapsed: true,
                });
            }
        }
    }

    /* 5. 纯文本补全 */
    if (messages.length === 0 && typeof json.prompt === 'string' && json.prompt.length > 0) {
        messages.push({
            role: 'user',
            content: json.prompt,
            tokens: 0, /* token 值在 parseFetchRequestBody 外由 computeTokensForMessages 异步计算 */
            collapsed: false,
        });
    }

    if (messages.length === 0) return null;
    return messages;
}

/* 后台异步处理已捕获的 AI 请求体：解析消息、计算 token、存入记录。
   此函数与 fetch 请求的发送完全解耦，不阻塞 originalFetch 的调用。
   @param {object} body 已解析的请求体 JSON
   @param {string} requestUrl 请求 URL */
async function processCapturedBody(body, requestUrl, captureId) {
    /* 严格请求体验证：先排除 ST 加载/切换对话等内部接口，再识别真实生成请求 */
    if (!body || !isAiRequestBody(body, requestUrl)) return;

    const messages = parseFetchRequestBody(body);
    if (!messages) return;

    const characterName = getCurrentCharacterName();
    const source = inferRequestSource();
    const modelName = extractModelName(body); /* 从请求体中提取模型名称 */
    /* 异步使用 ST 原生分词器精确计算每条消息的 token 数量 */
    /* 传入 modelName 用于与 ST 主 API 模型对比，判断分词器是否兼容 */
    await computeTokensForMessages(messages, modelName);
    /* captureId 用于把该请求的回复精确挂回这条记录 */
    addRecord(characterName, messages, source, modelName, body, captureId); /* 传入原始 body 供「查看全文」原始格式使用 */
}

/* 判断 fetch 输入是否为 Request 对象。
   用鸭子类型而非 instanceof：跨 realm 时 iframe 内的 Request 在主窗口的
   `instanceof Request` 恒为 false，但 clone/text 方法仍然可用。 */
function isRequestLike(input) {
    return !!(input && typeof input === 'object' && typeof input.clone === 'function' && typeof input.text === 'function');
}

/* 构造一个 fetch 拦截包装：主窗口与同源 iframe 共用同一套捕获逻辑。
   每个 realm（窗口）用独立的重入保护标记；包装内部始终调用该 realm 自己的原始 fetch，
   避免把 iframe realm 的 Request 对象传给主窗口 fetch（跨 realm 会抛错）。

   快速通道（early return），避免对每一个 JSON POST 请求都做完整解析：
   1. 非 POST/PUT/PATCH 请求直接跳过
   2. URL path 明确属于 ST 内部 API (/api/, /assets/, /backgrounds/) 且不匹配 AI 路径，直接跳过
   3. 仅对通过快速筛选的请求才解析 body

   锁策略：realmHookInFlight 仅保护 body 的同步捕获（init.body 读取），
   持有时长极短（微秒级）；originalFetch 在锁释放后立即调用，
   分词计算和 addRecord 通过 Promise 链异步执行，不阻塞实际网络请求的发出。

   @param {Window} realmWindow 被包装的窗口（主窗口或 iframe.contentWindow）
   @param {Function} getOriginalFetch () => Function 返回该 realm 当前原始 fetch
   @returns {Function} 包装后的 fetch */
function createFetchHook(realmWindow, getOriginalFetch) {
    let realmHookInFlight = false; /* 该 realm 的重入保护（防其他包装形成闭环） */
    return async function hookedFetch(input, init) {
        const originalFetch = getOriginalFetch();

        /* ── 快速通道 0：重入保护 ── */
        if (realmHookInFlight) {
            return originalFetch.apply(realmWindow, [input, init]);
        }

        /* ── 快速通道 1：总开关关闭时直接透传，不解析 body ── */
        if (!masterEnabled) {
            return originalFetch.apply(realmWindow, [input, init]);
        }

        /* ── 快速通道 2：非 POST/PUT/PATCH 请求直接跳过 ── */
        let method = init && init.method ? init.method.toUpperCase() : 'GET';
        if (isRequestLike(input) && method === 'GET') {
            try { method = input.method.toUpperCase(); } catch (e) { /* ignore */ }
        }
        if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
            return originalFetch.apply(realmWindow, [input, init]);
        }

        /* ── 快速通道 3：URL 完全不可能是 AI 生成端点，直接跳过（避免解析 body） ── */
        const requestUrl = getFetchRequestUrl(input);
        const path = getUrlPathForMatch(requestUrl);
        if (path && !pathMatchesAny(path, AI_GENERATION_PATH_PATTERNS)
            && (path.startsWith('/api/') || path.startsWith('/assets/') || path.startsWith('/backgrounds/'))) {
            return originalFetch.apply(realmWindow, [input, init]);
        }

        /* ── 加锁仅保护 body 同步捕获，持有时长极短 ── */
        /* 锁内只做 init.body 的同步读取（JSON.parse 或对象引用），不涉及任何 I/O 或 await。 */
        /* 如果 init.body 不可用，则需要从 Request 中异步读取 body —— */
        /* 此时启动异步读取后立即退出锁，originalFetch 在锁外尽快调用。 */
        realmHookInFlight = true;
        /* object|null: 从 init.body 同步捕获到的请求体（无需异步读取时使用） */
        let syncBody = null;
        /* Promise<object|null>|null: 从 Request.clone() 异步读取 body 的 Promise */
        let asyncBodyPromise = null;
        try {
            if (init && init.body) {
                if (typeof init.body === 'string') {
                    try { syncBody = JSON.parse(init.body); } catch (e) { syncBody = null; }
                } else if (typeof init.body === 'object' && !Array.isArray(init.body)) {
                    /* 直接引用（不 clone，因为 processCapturedBody 只做读取） */
                    syncBody = init.body;
                }
            }

            if (!syncBody && isRequestLike(input)) {
                try {
                    const clonedReq = input.clone();
                    /* 启动异步 body 读取，Promise 在锁外 resolve */
                    asyncBodyPromise = clonedReq.text().then(text => {
                        if (text) {
                            try { return JSON.parse(text); } catch (e) { return null; }
                        }
                        return null;
                    }).catch(() => null);
                } catch (e) {
                    /* clone 失败（body 可能已被消费），忽略 */
                }
            }
        } finally {
            realmHookInFlight = false;
            /* 锁释放 — originalFetch 可以安全调用了 */
        }

        /* ── 调用原始 fetch（锁外，尽早发出网络请求） ── */
        /* 通过闭包保存的引用调用，避免通过 window.fetch 访问导致递归 */
        const fetchPromise = originalFetch.apply(realmWindow, [input, init]);

        /* ── 后台异步处理 body（不阻塞 fetch 返回） ── */
        if (syncBody || asyncBodyPromise) {
            /* 本次请求捕获编号：回复挂载、待办区清理都依赖它 */
            const captureId = ++captureSeq;
            /* 在返回给调用方的同一个 fetchPromise 上挂回复追踪（精确对应，乱序/并发不串） */
            captureResponseForRequest(fetchPromise, requestUrl, captureId);
            if (syncBody) {
                /* 同步捕获的 body，直接异步处理 */
                processCapturedBody(syncBody, requestUrl, captureId).catch(() => { /* 静默处理 */ });
            } else if (asyncBodyPromise) {
                /* 从 Request 异步读取的 body，等 Promise resolve 后处理 */
                asyncBodyPromise.then(body => {
                    if (body) {
                        return processCapturedBody(body, requestUrl, captureId);
                    }
                }).catch(() => { /* 静默处理 */ });
            }
        }

        return fetchPromise;
    };
}

function installFetchHook() {
    if (currentHook) return; /* 已安装 */

    /* 主窗口：由于本插件 loading_order 为 999，安装时其他插件的 fetch 包装链已就绪，
       originalFetch 捕获的是完整的下游调用链。 */
    originalFetch = window.fetch;
    currentHook = createFetchHook(window, () => originalFetch);
    window.fetch = currentHook;
    hookedFetchHooks.set(window, currentHook);

    console.debug(`[${PLUGIN_KEY}] fetch 拦截已启用（网络层统一拦截模式）`);
}

/* 给单个 iframe 安装 fetch 包装（仅同源）。
   跨域 iframe 无法访问 contentWindow，直接跳过（同源判定用 try/catch）；
   已安装且未被替换的窗口跳过，避免重复包装破坏该 realm 原有的 fetch 包装链。
   @param {HTMLIFrameElement} iframe
   @returns {boolean} 是否已安装（含已安装无需重装的场景） */
function hookIframeFetch(iframe) {
    if (!iframe) return false;
    if (!iframe.contentWindow) {
        /* contentWindow 尚未就绪：挂 load 监听，加载完成后重试 */
        if (!iframeLoadListenersAttached.has(iframe)) {
            iframeLoadListenersAttached.add(iframe);
            iframe.addEventListener('load', () => hookIframeFetch(iframe));
        }
        return false;
    }
    const win = iframe.contentWindow;
    try {
        /* 同源判定：跨域访问 contentWindow.document 会抛 SecurityError */
        void win.document;
    } catch (e) {
        return false;
    }
    const existingHook = hookedFetchHooks.get(win);
    if (existingHook && win.fetch === existingHook) return true; /* 已安装且未被替换 */
    if (typeof win.fetch !== 'function') return false;

    /* 捕获该 realm 当前的原始 fetch；iframe 重载（realm 重建）或内部脚本替换 fetch
       后，由 load 监听重新包装。 */
    const iframeOriginalFetch = win.fetch;
    const hook = createFetchHook(win, () => iframeOriginalFetch);
    win.fetch = hook;
    hookedFetchHooks.set(win, hook);

    if (!iframeLoadListenersAttached.has(iframe)) {
        iframeLoadListenersAttached.add(iframe);
        iframe.addEventListener('load', () => hookIframeFetch(iframe));
    }
    return true;
}

/* 安装 iframe fetch 包装：
   初始扫描现有 iframe（如酒馆助手脚本 iframe），并用 MutationObserver 监听后续动态创建
   （脚本启停、角色/预设切换重建、消息渲染等）。包装始终安装，内部由 masterEnabled 决定是否记录。 */
function installIframeFetchHooks() {
    if (iframeHooksInstalled) return;
    iframeHooksInstalled = true;

    /* 初始扫描：安装时页面里可能已存在同源 iframe */
    let hookedCount = 0;
    let totalCount = 0;
    for (const iframe of document.querySelectorAll('iframe')) {
        totalCount++;
        if (hookIframeFetch(iframe)) hookedCount++;
    }

    /* 监听动态新增的 iframe（含子树内新增） */
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.tagName === 'IFRAME') {
                    hookIframeFetch(node);
                } else if (node.querySelectorAll) {
                    for (const inner of node.querySelectorAll('iframe')) {
                        hookIframeFetch(inner);
                    }
                }
            }
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    console.debug(`[${PLUGIN_KEY}] iframe fetch 拦截已启用（初始 ${hookedCount}/${totalCount} 个 iframe + 动态监听）`);
}

/* ── 回复追踪与解析 ──────────────────────── */

/* 当前生效的回复超时时长（有调试覆盖时用覆盖值，否则用默认 5 分钟）
   @returns {number} */
function getReplyTimeoutMs() {
    return replyTimeoutOverrideMs != null ? replyTimeoutOverrideMs : REPLY_TIMEOUT_MS;
}

/* 状态标记显示文本（英文，首字母大写）
   @param {string} status 'succeed' | 'fail' | 'timeout'
   @returns {string} */
function getReplyStatusLabel(status) {
    if (status === 'fail') return 'Fail';
    if (status === 'timeout') return 'Timeout';
    return 'Succeed';
}

/* 回复状态标签槽位宽度（px）缓存：由 getReplyStatusMaxWidth 实测一次，供占位/标签共用 */
let replyStatusMaxWidth = null;

/* 实测三个状态标签文本在面板实际字体下的最大宽度（px）。
   用与 .rlog-reply-status 相同的样式临时渲染到 body 外不可见位置测量，
   结果写入面板 CSS 变量 --rlog-status-w（在 renderPanelContent 中应用），
   使等待占位与到达后的状态标签共用同一槽位宽度，回复到达不引起布局跳动。
   探针挂到 body 且显式继承面板计算字体，面板窗口折叠/隐藏时也能测得真实宽度；
   仅当 body 异常隐藏等场景量出 0 时返回 0（占位退化为不占宽），
   且只在测出有效宽度时缓存，避免把 0 缓存成永久失效。
   @returns {number} */
function getReplyStatusMaxWidth() {
    if (replyStatusMaxWidth !== null) return replyStatusMaxWidth;
    /* 面板字体与 document.body 可能不同（实测宽度会差几像素），探针显式继承面板计算字体； */
    /* 挂到 body 测量：面板窗口折叠/隐藏（.rlog-panel-body display:none）时也能量出真实宽度 */
    if (!panelEl || !panelEl.isConnected) return 0;
    const probe = document.createElement('span');
    probe.className = 'rlog-reply-status';
    probe.style.fontFamily = getComputedStyle(panelEl).fontFamily;
    probe.style.position = 'fixed';
    probe.style.left = '-9999px';
    probe.style.top = '0';
    probe.style.visibility = 'hidden';
    probe.style.display = 'inline-flex';
    probe.style.minWidth = '0px'; /* 覆盖类规则里的 var()，避免测量循环依赖 */
    probe.style.pointerEvents = 'none';
    probe.style.whiteSpace = 'nowrap';
    let max = 0;
    for (const status of ['succeed', 'fail', 'timeout']) {
        probe.textContent = getReplyStatusLabel(status);
        document.body.appendChild(probe);
        max = Math.max(max, probe.offsetWidth);
        probe.remove();
    }
    /* 仅在测出有效宽度时缓存：异常情况下 body 隐藏会量出 0，缓存 0 会让占位永久失效 */
    if (max > 0) replyStatusMaxWidth = max;
    return max;
}

/* 状态标记悬停提示：状态 + 原因 + 回复终态时间
   状态已有标签上的字样展示，这里不再重复；只显示动态原因 + 时间。
   成功无特殊原因，统一显示固定文案 Succeed。
   @param {object} record 包含 record.reply 的记录
   @returns {string} */
function getReplyStatusTitle(record) {
    const reply = record && record.reply;
    if (!reply) return '';
    let reason;
    if (reply.status === 'succeed') {
        reason = 'Succeed'; /* 成功无动态原因，原因部分固定 */
    } else {
        reason = reply.failReason || getReplyStatusLabel(reply.status);
        if (reason === 'timeout') reason = 'Timeout'; /* 超时原因与状态同义，与标签大小写保持一致 */
    }
    return `${reason} · ${reply.time || ''}`;
}

/* 拼接回复最终展示内容：思考用 `<think>...</think>` 包裹，空一行后接正文（正文无标记）。
   只有思考或只有正文时只输出对应部分。
   @param {object} replyData { reasoning, content }
   @returns {string} */
function buildReplyContent(replyData) {
    const reasoning = (replyData.reasoning || '').trim();
    const content = (replyData.content || '').trim();
    const parts = [];
    if (reasoning) parts.push(`<think>\n${reasoning}\n</think>`);
    if (content) parts.push(content);
    return parts.join('\n\n');
}

/* 向正文/思考累积区追加一段文本。
   兼容「增量式」（OpenAI/Anthropic，逐块追加）与「累计式」（Gemini 等，
   每块携带截至当前的全部文本）：新文本是已累积文本的前缀且更长 → 替换；否则追加。
   与已累积文本完全相同的重复块视为无新增，跳过。
   @param {object} entry pendingReplies 中的条目
   @param {string} text 新增文本
   @param {boolean} isReasoning true 表示思考内容（reasoning/thinking/thought） */
function appendReplyText(entry, text, isReasoning) {
    if (!text) return;
    const key = isReasoning ? 'reasoning' : 'content';
    const acc = entry[key] || '';
    if (!acc) {
        entry[key] = text; /* 首段直接写入 */
        return;
    }
    if (text.startsWith(acc) && text.length > acc.length) {
        entry[key] = text; /* 累计式（Gemini 等）：整体替换 */
    } else if (!text.startsWith(acc)) {
        entry[key] = acc + text; /* 增量式：追加 */
    }
    /* text === acc（等长重复）视为无新增，跳过 */
}

/* 从单个 JSON chunk 中提取正文/思考增量。
   兼容 OpenAI 兼容格式（delta/message/text + reasoning_content/reasoning）、
   Anthropic（delta.text / delta.thinking / content 数组）、
   Gemini（candidates[0].content.parts，thought 部分归入思考）。
   @param {object} chunk 已解析的响应数据
   @param {number} captureId */
function extractReplyFromChunk(chunk, captureId) {
    const entry = pendingReplies.get(captureId);
    if (!entry || entry.finished) return;
    if (!chunk || typeof chunk !== 'object') return;

    /* OpenAI 兼容（流式 delta / 整包 message / text） */
    if (Array.isArray(chunk.choices) && chunk.choices[0]) {
        const c0 = chunk.choices[0];
        const delta = c0 && typeof c0.delta === 'object' ? c0.delta : null;
        if (delta) {
            if (typeof delta.reasoning_content === 'string') appendReplyText(entry, delta.reasoning_content, true);
            if (typeof delta.reasoning === 'string') appendReplyText(entry, delta.reasoning, true);
            if (typeof delta.content === 'string') appendReplyText(entry, delta.content, false);
            if (typeof delta.text === 'string') appendReplyText(entry, delta.text, false);
        }
        const msg = c0 && typeof c0.message === 'object' ? c0.message : null;
        if (msg) {
            if (typeof msg.reasoning_content === 'string') appendReplyText(entry, msg.reasoning_content, true);
            if (typeof msg.reasoning === 'string') appendReplyText(entry, msg.reasoning, true);
            if (typeof msg.content === 'string') appendReplyText(entry, msg.content, false);
        }
        if (typeof c0.text === 'string') appendReplyText(entry, c0.text, false);
        return;
    }

    /* Anthropic 流式（delta.thinking / delta.text） */
    if (chunk.delta && typeof chunk.delta === 'object') {
        if (typeof chunk.delta.thinking === 'string') appendReplyText(entry, chunk.delta.thinking, true);
        if (typeof chunk.delta.text === 'string') appendReplyText(entry, chunk.delta.text, false);
        return;
    }

    /* Gemini（candidates[0].content.parts） */
    if (Array.isArray(chunk.candidates) && chunk.candidates[0]) {
        const parts = chunk.candidates[0].content && chunk.candidates[0].content.parts;
        if (Array.isArray(parts)) {
            for (const part of parts) {
                if (part && typeof part.text === 'string' && part.text.length > 0) {
                    appendReplyText(entry, part.text, !!part.thought);
                }
            }
        }
        return;
    }

    /* Anthropic 非流式（content 数组） */
    if (Array.isArray(chunk.content)) {
        for (const part of chunk.content) {
            if (!part || typeof part !== 'object') continue;
            if (part.type === 'text' && typeof part.text === 'string') appendReplyText(entry, part.text, false);
            if (part.type === 'thinking' && typeof part.thinking === 'string') appendReplyText(entry, part.thinking, true);
        }
    }
}

/* 解析一段 SSE 文本（多个以空行分隔的事件），逐事件提取增量。
   兼容 `data:` 行、`[DONE]` 结束标记与事件内的错误对象。
   @param {string} text SSE 文本
   @param {number} captureId */
function processSseText(text, captureId) {
    if (!text) return;
    const events = text.split(/\r\n\r\n|\r\r|\n\n/);
    for (const evt of events) {
        if (!evt || !evt.trim()) continue;
        const dataLines = [];
        for (const line of evt.split(/\r\n|\r|\n/)) {
            if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).replace(/^ /, ''));
            }
        }
        const data = dataLines.join('\n').trim();
        if (!data || data === '[DONE]') continue;
        let chunk = null;
        try { chunk = JSON.parse(data); } catch (e) { continue; }
        if (chunk && chunk.error) {
            finalizeReply(captureId, 'fail', 'api error: ' + (chunk.error.message || chunk.error.code || 'unknown'));
            return;
        }
        extractReplyFromChunk(chunk, captureId);
    }
}

/* 统一增量读取响应体（不依赖 Content-Type 分流）：
   - 响应体内出现 `data:` 行即按 SSE 增量解析（兼容代理把流式响应标成 application/json 的情况）；
   - 未出现 SSE 标记则等到流结束后按 JSON（或纯文本）整体解析；
   - 流被中止/异常时，SSE 模式保留已解析内容（含半截思考），JSON 模式尚无可用内容则记空回复。
   读取的是 response.clone() 的 body，不影响 ST/其他插件消费原响应。
   @param {Response} clone response.clone()
   @param {number} captureId
   @param {string|null} hintMode 'sse'（Content-Type 已声明 text/event-stream）或 null（按内容识别） */
function readResponseBody(clone, captureId, hintMode = null) {
    if (!clone || !clone.body || typeof clone.body.getReader !== 'function') {
        finalizeReply(captureId, 'fail', 'empty body');
        return;
    }
    const reader = clone.body.getReader();
    const entry = pendingReplies.get(captureId);
    if (entry) entry.reader = reader;
    const decoder = new TextDecoder();
    let buffer = '';
    let mode = hintMode; /* null=未确定, 'sse', 'json' */

    function finalizeDone() {
        const cur = pendingReplies.get(captureId);
        if (!cur || cur.finished) return;
        if (mode === 'sse') {
            /* 处理未以空行结尾的最后一个事件 */
            if (buffer.trim()) processSseText(buffer, captureId);
        } else {
            const text = buffer.trim();
            if (text) {
                let data = null;
                try { data = JSON.parse(text); } catch (e) { data = null; }
                if (data) {
                    if (data.error) {
                        finalizeReply(captureId, 'fail', 'api error: ' + (data.error.message || data.error.code || 'unknown'));
                        return;
                    }
                    extractReplyFromChunk(data, captureId);
                } else if (!/^data:|\ndata:/.test(text)) {
                    /* 纯文本补全等：整段作为正文 */
                    appendReplyText(cur, text, false);
                }
            }
        }
        finalizeReply(captureId, 'succeed', '');
    }

    function pump() {
        reader.read().then(({ done, value }) => {
            const cur = pendingReplies.get(captureId);
            if (!cur || cur.finished) return;
            if (done) {
                finalizeDone();
                return;
            }
            buffer += decoder.decode(value, { stream: true });
            /* 未确定模式时按内容识别：出现 data: 行即视为 SSE */
            if (!mode && /^data:|\ndata:/.test(buffer)) {
                mode = 'sse';
            }
            if (mode === 'sse') {
                const parts = buffer.split(/\r\n\r\n|\r\r|\n\n/);
                buffer = parts.pop();
                processSseText(parts.join('\n\n'), captureId);
                /* 错误 chunk 等路径可能已 finalize，此时停止继续读取 */
                const after = pendingReplies.get(captureId);
                if (after && !after.finished) pump();
            } else {
                pump();
            }
        }).catch(() => {
            /* 流被中止/异常：SSE 模式保留已解析内容（含半截思考）；JSON 模式尚无可用内容 */
            const cur = pendingReplies.get(captureId);
            if (!cur || cur.finished) return;
            if (mode === 'sse' && buffer.trim()) {
                processSseText(buffer, captureId);
            }
            finalizeReply(captureId, 'fail', 'stream aborted');
        });
    }
    pump();
}

/* 从 JSON 错误对象中提取第一条可用错误消息（按常见接口约定的字段轮询）。
   @param {object} data 已解析的错误响应 JSON
   @returns {string} 提取到的消息文本，无则返回空字符串 */
function extractErrorMessage(data) {
    if (!data || typeof data !== 'object') return '';
    const candidates = [];
    if (data.error && typeof data.error === 'object') {
        if (typeof data.error.message === 'string') candidates.push(data.error.message);
        if (typeof data.error.code === 'string') candidates.push(data.error.code);
    }
    if (typeof data.error === 'string') candidates.push(data.error);
    if (typeof data.message === 'string') candidates.push(data.message);
    if (typeof data.detail === 'string') candidates.push(data.detail);
    return candidates.find(s => s && s.trim()) || '';
}

/* 尽力读取非 2xx 响应的错误正文，提取真实报错信息（如接口返回「模型不存在」）。
   响应体只能读一次，必须 clone 副本读取，不影响 ST/其他插件消费原响应；
   任何失败（克隆失败/流报错/空体/非 JSON/无可用字段）都回退到仅含状态码的 baseReason。
   @param {Response} response 原始（非 2xx）响应
   @param {number} captureId
   @param {string} baseReason 回退原因（如 `HTTP 500`） */
function readErrorResponseBody(response, captureId, baseReason) {
    let clone = null;
    try {
        /* clone 必须同步调用（在原响应被 ST 等消费之前），否则 body 已使用会抛错 */
        clone = response.clone();
    } catch (e) {
        finalizeReply(captureId, 'fail', baseReason);
        return;
    }
    if (!clone || !clone.body || typeof clone.body.getReader !== 'function') {
        finalizeReply(captureId, 'fail', baseReason);
        return;
    }
    const reader = clone.body.getReader();
    const entry = pendingReplies.get(captureId);
    if (entry) entry.reader = reader; /* 交给 abortPendingReply 统一释放 */
    const decoder = new TextDecoder();
    let text = '';

    function done() {
        let reason = baseReason;
        const trimmed = text.trim();
        if (trimmed) {
            let data = null;
            try { data = JSON.parse(trimmed); } catch (e) { data = null; }
            const message = data ? extractErrorMessage(data) : '';
            if (message) reason = `${baseReason}: ${message}`;
        }
        finalizeReply(captureId, 'fail', reason);
    }

    function pump() {
        reader.read().then(({ done: isDone, value }) => {
            const cur = pendingReplies.get(captureId);
            if (!cur || cur.finished) return;
            if (isDone) {
                done();
                return;
            }
            text += decoder.decode(value, { stream: true });
            if (text.length >= MAX_ERROR_BODY_BYTES) {
                done(); /* 超过上限：用已读内容提取，不再继续读 */
                return;
            }
            pump();
        }).catch(() => {
            finalizeReply(captureId, 'fail', baseReason);
        });
    }
    pump();
}

/* 为一次已捕获的 AI 请求挂回复追踪：在返回给调用方的 fetchPromise 上追加处理，
   不改变该 Promise 本身；读取 clone 不影响原响应。
   @param {Promise<Response>} fetchPromise 原始 fetch 返回的 Promise
   @param {string} requestUrl 请求 URL
   @param {number} captureId 请求捕获编号 */
function captureResponseForRequest(fetchPromise, requestUrl, captureId) {
    if (!isPotentialGenerationUrl(requestUrl)) return;

    /* 待办区满：淘汰最旧的追踪（释放其 reader），避免内存膨胀 */
    if (pendingReplies.size >= MAX_PENDING_REPLIES) {
        const oldestKey = pendingReplies.keys().next().value;
        if (oldestKey != null) abortPendingReply(oldestKey);
    }

    const entry = {
        startTime: Date.now(),
        timer: null,
        expireTimer: null,
        status: null,
        content: '',
        reasoning: '',
        failReason: '',
        time: '',
        reader: null,
        finished: false,
    };
    pendingReplies.set(captureId, entry);

    /* 超时兜底：5 分钟未结束 → 停止追踪并标记 Timeout（保留已累积内容） */
    entry.timer = setTimeout(() => {
        finalizeReply(captureId, 'timeout', 'timeout');
    }, getReplyTimeoutMs());

    fetchPromise.then(response => {
        try {
            if (!response || !response.ok) {
                if (response) {
                    /* 非 2xx：尽力读取错误正文提取真实报错，读不到则回退状态码 */
                    readErrorResponseBody(response, captureId, `HTTP ${response.status}`);
                } else {
                    finalizeReply(captureId, 'fail', 'no response');
                }
                return;
            }
            /* clone 必须同步调用（在原响应被 ST 等消费之前），否则 body 已使用会抛错 */
            const clone = response.clone();
            const contentType = (response.headers.get('content-type') || '').toLowerCase();
            /* Content-Type 只作提示；统一增量读取，靠正文识别 SSE， */
            /* 避免「代理对流式响应标 application/json」时中止导致已收内容丢失 */
            readResponseBody(clone, captureId, contentType.includes('text/event-stream') ? 'sse' : null);
        } catch (e) {
            finalizeReply(captureId, 'fail', 'response clone failed');
        }
    }, err => {
        /* 网络错误 / 用户中止（AbortError） */
        const reason = (err && err.name === 'AbortError') ? 'aborted' : 'network error';
        finalizeReply(captureId, 'fail', reason);
    });
}

/* 回复追踪终态处理：标记完成、释放读取器、挂到已存在的记录；
   记录尚未建成时保留在待办区，等待 addRecord 挂载（带 60s 保留上限）。
   @param {number} captureId
   @param {string} status 'succeed' | 'fail' | 'timeout'
   @param {string} failReason 失败/超时原因 */
function finalizeReply(captureId, status, failReason) {
    const entry = pendingReplies.get(captureId);
    if (!entry || entry.finished) return;
    entry.finished = true;
    clearTimeout(entry.timer);
    if (entry.reader) {
        try { Promise.resolve(entry.reader.cancel()).catch(() => { /* ignore */ }); } catch (e) { /* ignore */ }
    }

    /* 正常结束但正文为空/过短 → 视为失败（思考不计入长度判定） */
    if (status === 'succeed') {
        const content = (entry.content || '').trim();
        if (!content) {
            status = 'fail';
            failReason = 'empty reply';
        } else if (content.length <= 10) {
            status = 'fail';
            failReason = 'reply too short';
        }
    }

    entry.status = status;
    entry.failReason = failReason || '';
    const now = new Date();
    entry.time = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const record = findRecordByCaptureId(captureId);
    if (record) {
        attachReplyToRecord(record, entry);
        pendingReplies.delete(captureId);
    } else {
        /* 记录尚未建成：短暂保留供 addRecord 挂载，超时未挂载则丢弃 */
        entry.expireTimer = setTimeout(() => {
            pendingReplies.delete(captureId);
        }, PENDING_REPLY_KEEP_MS);
    }
}

/* 取消一次在途回复追踪：清定时器、释放读取器、删除待办（不插入任何标记）。
   @param {number} captureId */
function abortPendingReply(captureId) {
    const entry = pendingReplies.get(captureId);
    if (!entry) return;
    clearTimeout(entry.timer);
    clearTimeout(entry.expireTimer);
    if (entry.reader) {
        try { Promise.resolve(entry.reader.cancel()).catch(() => { /* ignore */ }); } catch (e) { /* ignore */ }
    }
    pendingReplies.delete(captureId);
}

/* 取出并删除一条已终态的回复待办（供 addRecord 挂载时消费）。
   仅在回复已终态（finished）时才返回，避免把尚在途的占位条目挂成空回复。
   @param {number} captureId
   @returns {object|null} */
function consumePendingReply(captureId) {
    const entry = pendingReplies.get(captureId);
    if (!entry || !entry.finished) return null;
    clearTimeout(entry.timer);
    clearTimeout(entry.expireTimer);
    pendingReplies.delete(captureId);
    return entry;
}

/* 按 captureId 查找记录：正常列表与引导暂存队列都查。
   @param {number} captureId
   @returns {object|null} */
function findRecordByCaptureId(captureId) {
    const found = records.find(r => r.id === captureId);
    if (found) return found;
    return tourPendingRecords.find(r => r.id === captureId) || null;
}

/* 把已终态的回复数据挂到记录上（record.reply），并异步计算 token。
   回复到达不重建整个列表 DOM：直接把 Response 子消息追加到记录末尾，
   不打断正在进行的阅读（列表滚动位置、消息内容区滚动位置、搜索状态都保持不动）。
   @param {object} record 目标记录
   @param {object} replyData 终态回复数据（pendingReplies 条目）
   @param {boolean} [skipRender=false] true 时本次不追加（记录尚未进入 DOM，由调用方统一渲染） */
function attachReplyToRecord(record, replyData, skipRender = false) {
    if (!record || record.reply) return;
    /* Fail/Timeout 时把失败原因写进回复内容：已有内容（如中止保留的半截回复）末尾空一行追加； */
    /* 内容为空则直接写原因。移动端没有悬停，这样展开/预览/复制/搜索都能直接看到报错。 */
    let content = buildReplyContent(replyData);
    if ((replyData.status === 'fail' || replyData.status === 'timeout') && replyData.failReason) {
        content = content ? `${content}\n\n${replyData.failReason}` : replyData.failReason;
    }
    record.reply = {
        role: 'response',
        content,
        tokens: 0,
        tokenPrecise: false,
        collapsed: true,
        status: replyData.status,
        failReason: replyData.failReason || '',
        time: replyData.time || '',
    };
    /* 异步精确计算回复 token（结果写回后只更新回复标题栏的数字，不重建列表） */
    computeTokensForMessages([record.reply], record.modelName || '').then(() => {
        updateReplyTokenInDom(record);
    }).catch(() => { /* 静默 */ });
    if (!skipRender) appendReplyToRecordDom(record);
}

/* 回复到达：把 Response 子消息追加到该记录消息列表末尾。
   只动「该记录末尾 + 标题栏状态标记」，不重建整个列表——
   正在阅读时列表滚动位置、消息内容区滚动位置、搜索状态都保持不动。
   面板不可见 / 记录不在 DOM / 引导期间只置脏标记，下次渲染自然带上回复。
   @param {object} record 目标记录 */
function appendReplyToRecordDom(record) {
    panelContentDirty = true;
    if (!panelEl || !isPanelVisible || tourActive) return;
    const listEl = panelEl.querySelector('#rlog-list');
    const recordEl = listEl ? listEl.querySelector(`.rlog-record[data-record-index="${records.indexOf(record)}"]`) : null;
    const bodyEl = recordEl ? recordEl.querySelector('.rlog-record-body') : null;
    if (!recordEl || !bodyEl) return;

    const idx = Number(recordEl.dataset.recordIndex);
    const replyMsgIdx = record.messages.length;
    /* 回复子消息被角色筛选隐藏时不追加子消息 DOM（数据已写入 record.reply，
       恢复显示后由下次渲染自然带出）；标题栏状态标记仍照常更新 */
    if (isMessageVisible(record.reply)) {
        /* 幂等：已追加过则跳过（避免重复触发时插两条） */
        if (!bodyEl.querySelector(`.rmsg-item[data-record="${idx}"][data-msg="${replyMsgIdx}"]`)) {
            bodyEl.insertAdjacentHTML('beforeend', buildMessageHtml(record.reply, idx, replyMsgIdx));
            const replyItemEl = bodyEl.querySelector(`.rmsg-item[data-record="${idx}"][data-msg="${replyMsgIdx}"]`);
            if (replyItemEl) bindMsgItemEvents(replyItemEl);
        }
    }

    /* 标题栏回复状态标记（仅折叠时显示，展开时 CSS 隐藏）：不存在则补上，存在则刷新内容 */
    let statusEl = recordEl.querySelector('.rlog-reply-status');
    if (!statusEl) {
        const toggleIconEl = recordEl.querySelector('.rlog-toggle-icon');
        if (toggleIconEl && toggleIconEl.parentNode) {
            statusEl = document.createElement('span');
            toggleIconEl.parentNode.insertBefore(statusEl, toggleIconEl);
        }
    }
    if (statusEl) {
        statusEl.className = `rlog-reply-status rlog-reply-status-${record.reply.status}`;
        statusEl.title = getReplyStatusTitle(record);
        statusEl.textContent = getReplyStatusLabel(record.reply.status);
    }
}

/* 回复 token 计算完成后只更新回复标题栏的 token 数字，不重建列表。
   记录不在 DOM 时（面板关闭/引导中）由下次渲染自然带上正确数字。
   @param {object} record 目标记录 */
function updateReplyTokenInDom(record) {
    panelContentDirty = true;
    if (!panelEl || !isPanelVisible) return;
    const idx = records.indexOf(record);
    if (idx < 0) return;
    const listEl = panelEl.querySelector('#rlog-list');
    if (!listEl) return;
    const replyItemEl = listEl.querySelector(`.rmsg-item[data-record="${idx}"][data-msg="${record.messages.length}"]`);
    const tokensEl = replyItemEl ? replyItemEl.querySelector('.rmsg-tokens') : null;
    if (tokensEl) {
        const reply = record.reply;
        tokensEl.textContent = `${reply.tokenPrecise ? '' : '~'}${reply.tokens} tokens`;
    }
}

/* ── 数据管理 ─────────────────────────── */

/* 生成消息列表的去重指纹
   通过拼接每条消息的 role + content 生成一个简单哈希，用于判断两条记录是否内容相同 */
function computeMessagesFingerprint(messages) {
    if (!messages || messages.length === 0) return '';
    /* 只用前 50 条 + 每条前 500 字符做指纹，避免超大消息拖慢性能 */
    return messages.slice(0, 50).map(m => {
        const role = m.role || '';
        const content = typeof m.content === 'string' ? m.content.slice(0, 500) : '';
        return `${role}:${content}`;
    }).join('|');
}

function addRecord(characterName, messages, source, modelName, rawBody, captureId) {
    if (!masterEnabled) return;
    if (!characterName || !messages || messages.length === 0) return;

    /* 去重：如果与上一条记录的 messages 内容相同且在 500ms 内，则跳过 */
    const fingerprint = computeMessagesFingerprint(messages);
    const now = Date.now();
    if (fingerprint && fingerprint === lastRecordFingerprint && (now - lastRecordTime) < 500) {
        /* 请求未建成记录，其回复追踪一并丢弃，避免待办区残留 */
        if (captureId != null) abortPendingReply(captureId);
        return;
    }
    lastRecordFingerprint = fingerprint;
    lastRecordTime = now;

    const date = new Date();
    const ts = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;

    const record = {
        characterName,
        timestamp: ts,
        source: source || { type: 'plugin', label: '插件', detail: '插件/非原生请求' },
        modelName: modelName || '未知模型',
        messages,
        rawBody: rawBody || null,   /* 原始请求体 JSON 对象（「查看全文」原始格式用） */
        collapsed: true,
        id: captureId != null ? captureId : null, /* 请求捕获编号，回复挂载用 */
        reply: null,                 /* 回复内容（独立存储，不计入请求消息/查看全文） */
    };

    /* 回复可能先于记录建成而到达（finalize 时记录尚未创建）：此时立即挂载， */
    /* 由 addRecord 后续统一的渲染路径展示（skipRender=true，避免重复渲染） */
    /* 仅当回复已终态时才挂载；仍在途的条目保留在待办区，由 finalizeReply 稍后挂载 */
    if (captureId != null) {
        const replyData = consumePendingReply(captureId);
        if (replyData) attachReplyToRecord(record, replyData, true);
    }

    /* 引导期间：新记录只暂存、不加入列表渲染（避免打断引导步骤的 DOM 定位）， */
    /* 引导结束后由 endTour 合并恢复，保证不丢失。同样受最大记录数上限约束。 */
    if (tourActive) {
        tourPendingRecords.unshift(record);
        if (tourPendingRecords.length > MAX_RECORDS) {
            const evicted = tourPendingRecords.pop();
            if (evicted && evicted.id != null) abortPendingReply(evicted.id);
        }
        return;
    }

    /* 筛选生效时先判断新记录是否可见：
       不可见则保持当前阅读位置（不折叠已有记录、不回顶、不闪烁），仅正常入列刷新计数 */
    const filterActive = isFilterActive();
    const newRecordVisible = filterActive ? matchesFilter(record) : true;

    /* 新记录到达时，折叠所有已有记录（仅折叠记录本身，保持各记录内部消息的折叠/展开状态不变）。
       新记录被筛选隐藏时不折叠，避免打断正在阅读的位置 */
    if (!filterActive || newRecordVisible) {
        records.forEach(r => { r.collapsed = true; });
    }

    records.unshift(record);
    if (records.length > MAX_RECORDS) {
        const evicted = records.pop();
        /* 被挤出的记录若仍有回复在途，取消追踪避免挂起的读取器占用资源 */
        if (evicted && evicted.id != null) abortPendingReply(evicted.id);
    }

    panelContentDirty = true;
    if (panelEl && isPanelVisible) {
        const listEl = panelEl.querySelector('#rlog-list');
        const prevScrollTop = listEl ? listEl.scrollTop : 0;
        renderPanelContent();
        if (!isPanelCollapsed) {
            if (!filterActive || newRecordVisible) {
                /* 面板完全展开可见时：新记录到达立即回顶到最新一条 + 闪烁 */
                if (listEl) listEl.scrollTop = 0;
                flashTopHint();
            } else if (listEl) {
                /* 新记录被筛选隐藏：保持原阅读位置 */
                listEl.scrollTop = prevScrollTop;
            }
        }
    }
    /* 面板未处于「完全展开可见」状态时（窗口折叠/完全关闭）， */
    /* 恢复显示后再回顶（见 togglePanelWindow / showPanel 中的 pendingScrollToTop 处理） */
    /* 新记录被筛选隐藏时也不置位：恢复显示后保持原位置，不打扰阅读 */
    if (!(panelEl && isPanelVisible && !isPanelCollapsed) && (!filterActive || newRecordVisible)) {
        pendingScrollToTop = true;
    }
}

function clearAllRecords() {
    /* 清空记录时同步取消所有在途回复追踪，避免残留读取器/待办 */
    pendingReplies.forEach((_, captureId) => abortPendingReply(captureId));
    records = [];
    panelContentDirty = true;
    if (panelEl && isPanelVisible) {
        renderPanelContent();
    }
}

/* ── 持久化设置 ────────────────────────── */

function setMasterEnabled(enabled) {
    masterEnabled = enabled;
    try {
        localStorage.setItem(STORAGE_MASTER_KEY, enabled ? '1' : '0');
    } catch (e) { /* ignore */ }
    updateMasterToggleUI();
    
    if (panelEl && isPanelVisible) {
        /* 如果当前列表为空且面板可见，立即刷新空白提示文案 */
        if (records.length === 0) {
            panelContentDirty = true;
            renderPanelContent();
        }
    }
    
    /* hook 始终安装（在 installFetchHook 内部通过 masterEnabled 判断是否记录）， */
    /* 不再通过开关触发 hook 的安装/卸载，避免破坏其他插件的 fetch wrapper 链。 */
}

function updateMasterToggleUI() {
    if (!panelEl) return;
    
    const btn = panelEl.querySelector('#rlog-master-toggle');
    if (btn) {
        if (masterEnabled) {
            btn.classList.add('rlog-master-on');
            btn.classList.remove('rlog-master-off');
            btn.style.color = '#4caf50'; /* 【标注】总开关开启时图标颜色（JS 内联覆盖 CSS 的 .rlog-master-on） */
            btn.querySelector('i').className = 'fa-solid fa-power-off';
            btn.title = '插件开启-自动记录中';
        } else {
            btn.classList.add('rlog-master-off');
            btn.classList.remove('rlog-master-on');
            btn.style.color = '#999'; /* 【标注】总开关关闭时图标颜色（JS 内联覆盖 CSS 的 .rlog-master-off） */
            btn.querySelector('i').className = 'fa-solid fa-power-off';
            btn.title = '插件关闭-已停止记录';
        }
    }

    /* 根据总开关状态更新面板的遮罩层级 */
    if (!masterEnabled) {
        panelEl.classList.add('rlog-disabled');
    } else {
        panelEl.classList.remove('rlog-disabled');
    }
}

/* 从 localStorage 加载内容预览开关状态
   默认关闭（首次安装或未设置时返回 false）
   @returns {boolean} 是否开启内容预览 */
function loadContentPreview() {
    try { return localStorage.getItem(STORAGE_PREVIEW_KEY) === '1'; } catch (e) { return false; }
}

/* 持久化内容预览开关状态到 localStorage
   @param {boolean} enabled 是否开启 */
function saveContentPreview(enabled) {
    try { localStorage.setItem(STORAGE_PREVIEW_KEY, enabled ? '1' : '0'); } catch (e) { /* ignore */ }
}

/* 切换内容预览开关状态
   更新全局变量、持久化存储、UI 按钮外观，并刷新面板内容 */
function toggleContentPreview() {
    contentPreviewEnabled = !contentPreviewEnabled;
    saveContentPreview(contentPreviewEnabled);
    updatePreviewToggleUI();
    /* 预览开关影响每条消息的渲染内容，需要重建 DOM */
    panelContentDirty = true;
    if (panelEl && isPanelVisible) {
        renderPanelContent();
    }
}

/* 更新标题栏预览开关按钮的外观（开启/关闭状态）
   开启时滑块右移变色，关闭时滑块左移恢复默认色 */
function updatePreviewToggleUI() {
    const toggleEl = panelEl ? panelEl.querySelector('#rlog-preview-toggle') : null;
    if (!toggleEl) return;
    if (contentPreviewEnabled) {
        toggleEl.classList.add('rlog-preview-on');
        toggleEl.classList.remove('rlog-preview-off');
        toggleEl.title = '内容预览-已开启';
    } else {
        toggleEl.classList.remove('rlog-preview-on');
        toggleEl.classList.add('rlog-preview-off');
        toggleEl.title = '内容预览-已关闭';
    }
}

function loadTheme() {
    try { return localStorage.getItem(STORAGE_THEME_KEY) === 'light'; } catch (e) { return false; }
}

function saveTheme(isLight) {
    try { localStorage.setItem(STORAGE_THEME_KEY, isLight ? 'light' : 'dark'); } catch (e) { /* ignore */ }
}

function applyTheme() {
    if (!panelEl) return;
    if (isLightTheme) {
        panelEl.classList.add('rlog-light');
    } else {
        panelEl.classList.remove('rlog-light');
    }
}

/* 从 localStorage 加载用户设定的最大记录数
   若无保存值或值非法，返回默认值 DEFAULT_MAX_RECORDS */
function loadMaxRecords() {
    try {
        const raw = localStorage.getItem(STORAGE_MAX_RECORDS_KEY);
        if (raw !== null && raw !== undefined) {
            const num = parseInt(raw, 10);
            /* 合法性校验：必须是有效整数且在允许范围内 */
            if (!isNaN(num) && num >= MIN_MAX_RECORDS && num <= MAX_MAX_RECORDS) {
                return num;
            }
        }
    } catch (e) { /* ignore */ }
    return DEFAULT_MAX_RECORDS;
}

/* 将用户设定的最大记录数持久化到 localStorage
   @param {number} value 新的最大记录数 */
function saveMaxRecords(value) {
    try {
        localStorage.setItem(STORAGE_MAX_RECORDS_KEY, String(value));
    } catch (e) { /* ignore */ }
}

/* 设置新的最大记录数上限
   同时更新全局变量、持久化存储、裁剪超出上限的记录、刷新标题栏显示
   @param {number} newMax 新的上限值 */
function setMaxRecords(newMax) {
    /* 合法性校验 */
    if (typeof newMax !== 'number' || isNaN(newMax) || newMax < MIN_MAX_RECORDS || newMax > MAX_MAX_RECORDS) {
        return false;
    }
    MAX_RECORDS = newMax;
    saveMaxRecords(MAX_RECORDS);

    /* 如果当前记录数超过新上限，裁剪掉多余的旧记录 */
    while (records.length > MAX_RECORDS) {
        records.pop();
    }

    /* 刷新标题栏显示 */
    updateHeaderTitle();

    /* 记录数变化，需要重建 DOM */
    panelContentDirty = true;

    /* 如果面板可见，刷新内容（裁剪后的列表） */
    if (panelEl && isPanelVisible) {
        renderPanelContent();
    }

    return true;
}

/* 计数显示文本的唯一生成处：面板标题栏「当前记录数 / 上限」的数字部分。
   以后要改计数显示格式只改这里一处即可（渲染函数与初始模板都调用它）。 */

/* ── 通用弹窗 ─────────────────────────── */

/* 创建并显示设置最大记录数的对话框
   双击标题栏文字时触发 */
function showMaxRecordsDialog() {
    /* 如果已有弹窗，先移除 */
    if (maxRecordsDialog) {
        maxRecordsDialog.remove();
    }

    /* 创建弹窗遮罩层 */
    /* 使用 inline style 设置定位尺寸，防止父页面 CSS (如 transform) 破坏 position:fixed 的参考系 */
    const overlay = document.createElement('div');
    overlay.className = 'rlog-dialog-overlay';
    overlay.style.cssText = `
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        max-width: 100vw !important;
        max-height: 100vh !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        z-index: 9999 !important;
    `;
    overlay.addEventListener('click', (e) => {
        /* 点击遮罩层外部关闭 */
        if (e.target === overlay) {
            closeMaxRecordsDialog();
        }
    });

    /* 创建弹窗主体 */
    const dialog = document.createElement('div');
    dialog.className = 'rlog-dialog';

    /* 根据当前主题添加对应的类名 */
    if (isLightTheme) {
        dialog.classList.add('rlog-dialog-light');
    }

        dialog.innerHTML = `
        <div class="rlog-dialog-header">
            <span>设置记录上限</span>
            <button class="rlog-dialog-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="rlog-dialog-body">
            <p class="rlog-dialog-desc">
                请输入记录上限，范围 ${MIN_MAX_RECORDS} ~ ${MAX_MAX_RECORDS}。
            </p>
            <div class="rlog-dialog-input-row">
                <input type="number" class="rlog-dialog-input" 
                       id="rlog-max-records-input" 
                       min="${MIN_MAX_RECORDS}" max="${MAX_MAX_RECORDS}" 
                       value="${MAX_RECORDS}" 
                       placeholder="${MAX_RECORDS}">
                <button class="rlog-dialog-btn rlog-dialog-btn-confirm" id="rlog-dialog-confirm">确定</button>
            </div>

        </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    maxRecordsDialog = overlay;

    /* 绑定关闭按钮事件 */
    dialog.querySelector('.rlog-dialog-close').addEventListener('click', closeMaxRecordsDialog);

    /* 绑定确认按钮事件 */
    dialog.querySelector('#rlog-dialog-confirm').addEventListener('click', () => {
        const input = dialog.querySelector('#rlog-max-records-input');
        const rawValue = parseInt(input.value, 10);
        if (!isNaN(rawValue)) {
            /* clamp 到允许范围 */
            const clamped = Math.max(MIN_MAX_RECORDS, Math.min(MAX_MAX_RECORDS, rawValue));
            setMaxRecords(clamped);
        }
        closeMaxRecordsDialog();
    });

    /* 输入框回车直接确认 */
    dialog.querySelector('#rlog-max-records-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            dialog.querySelector('#rlog-dialog-confirm').click();
        } else if (e.key === 'Escape') {
            closeMaxRecordsDialog();
        }
    });

    /* 输入框自动聚焦 */
    setTimeout(() => {
        const input = dialog.querySelector('#rlog-max-records-input');
        if (input) {
            input.focus();
            input.select();
        }
    }, 100);
}

/* 关闭最大记录数设置弹窗 */
function closeMaxRecordsDialog() {
    if (maxRecordsDialog) {
        maxRecordsDialog.remove();
        maxRecordsDialog = null;
    }
}

/* HTMLElement|null: 当前确认弹窗的 DOM 元素 */
let confirmDialogEl = null;

/* 创建并显示通用确认弹窗（用于清空所有记录、删除单条记录等破坏性操作）
   @param {object} options 配置项
   @param {string} [options.title='确认操作'] 弹窗标题
   @param {string} [options.message=''] 弹窗正文（支持 HTML）
   @param {string} [options.confirmText='确认'] 确认按钮文字
   @param {string} [options.cancelText='取消'] 取消按钮文字
   @param {Function} [options.onConfirm] 点击确认后的回调函数
   @param {Function} [options.onCancel] 点击取消/关闭后的回调函数 */
function showConfirmDialog(options) {
    const {
        title = '确认操作',
        message = '',
        confirmText = '确认',
        cancelText = '取消',
        onConfirm = null,
        onCancel = null,
    } = options || {};

    /* 如果已有弹窗，先移除 */
    closeConfirmDialog();

    /* 创建弹窗遮罩层 */
    /* 使用 inline style 设置定位尺寸，防止父页面 CSS (如 transform) 破坏 position:fixed 的参考系 */
    const overlay = document.createElement('div');
    overlay.className = 'rlog-dialog-overlay';
    overlay.style.cssText = `
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        max-width: 100vw !important;
        max-height: 100vh !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        z-index: 9999 !important;
    `;
    overlay.addEventListener('click', (e) => {
        /* 点击遮罩层外部关闭 */
        if (e.target === overlay) {
            closeConfirmDialog();
            if (typeof onCancel === 'function') onCancel();
        }
    });

    /* 创建弹窗主体 */
    const dialog = document.createElement('div');
    dialog.className = 'rlog-dialog rlog-confirm-dialog';

    /* 根据当前主题添加对应的类名 */
    if (isLightTheme) {
        dialog.classList.add('rlog-dialog-light');
    }

    dialog.innerHTML = `
        <div class="rlog-dialog-header">
            <span>${escapeHtml(title)}</span>
            <button class="rlog-dialog-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="rlog-dialog-body">
            <div class="rlog-confirm-message">${message}</div>
            <div class="rlog-confirm-actions">
                <button class="rlog-dialog-btn rlog-dialog-btn-cancel" id="rlog-confirm-cancel">${escapeHtml(cancelText)}</button>
                <button class="rlog-dialog-btn rlog-dialog-btn-danger" id="rlog-confirm-ok">${escapeHtml(confirmText)}</button>
            </div>
        </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    confirmDialogEl = overlay;

    /* 绑定关闭按钮事件 */
    dialog.querySelector('.rlog-dialog-close').addEventListener('click', () => {
        closeConfirmDialog();
        if (typeof onCancel === 'function') onCancel();
    });

    /* 绑定取消按钮事件 */
    dialog.querySelector('#rlog-confirm-cancel').addEventListener('click', () => {
        closeConfirmDialog();
        if (typeof onCancel === 'function') onCancel();
    });

    /* 绑定确认按钮事件 */
    dialog.querySelector('#rlog-confirm-ok').addEventListener('click', () => {
        closeConfirmDialog();
        if (typeof onConfirm === 'function') onConfirm();
    });

    /* 键盘支持：Enter 确认、Escape 取消 */
    dialog.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            dialog.querySelector('#rlog-confirm-ok').click();
        } else if (e.key === 'Escape') {
            closeConfirmDialog();
            if (typeof onCancel === 'function') onCancel();
        }
    });

    /* 自动聚焦取消按钮（默认安全操作，避免误触确认） */
    setTimeout(() => {
        const cancelBtn = dialog.querySelector('#rlog-confirm-cancel');
        if (cancelBtn) cancelBtn.focus();
    }, 100);
}

/* 关闭通用确认弹窗 */
function closeConfirmDialog() {
    if (confirmDialogEl) {
        confirmDialogEl.remove();
        confirmDialogEl = null;
    }
}

/* ── 搜索 ───────────────────────────── */

/* 重置当前搜索状态（搜索框关闭、关键词清空、高亮清除、命中序号重置）
   用于折叠/删除/清空/新增记录等所有需要退出搜索模式的场景。
   安全设计：不依赖搜索框 UI 是否已构建，DOM 中存在才操作。 */
function resetSearchIfActive() {
    /* 清除 debounce 定时器 */
    if (searchDebounceTimer !== null) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
    }

    /* 清除所有高亮标记（包括当前命中和其它残留 mark） */
    if (searchState) {
        const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
        if (listEl) {
            listEl.querySelectorAll('mark.rlog-search-mark, mark.rlog-search-mark-current').forEach(mark => {
                const parent = mark.parentNode;
                if (parent) {
                    /* 将 mark 替换为其文本内容，恢复原始文本 */
                    parent.replaceChild(document.createTextNode(mark.textContent), mark);
                    /* 合并相邻文本节点，避免产生多余节点 */
                    parent.normalize();
                }
            });
        }

        /* 如果搜索框 DOM 存在，恢复其初始状态 */
        const searchEl = searchState.searchEl;
        if (searchEl && searchEl.parentNode) {
            searchEl.parentNode.removeChild(searchEl);
        }
        /* 恢复对应记录的原操作按钮显示、折叠/展开箭头、搜索中状态标记 */
        if (panelEl && searchState.recordIndex !== undefined) {
            const recordEl = panelEl.querySelector(`.rlog-record[data-record-index="${searchState.recordIndex}"]`);
            if (recordEl) {
                /* 移除「搜索中」标记（CSS 依赖它恢复被隐藏的按钮显示） */
                recordEl.classList.remove('rlog-searching');
                /* 恢复记录折叠/展开箭头（▾） */
                const toggleIcon = recordEl.querySelector('.rlog-toggle-icon');
                if (toggleIcon) toggleIcon.style.visibility = '';
            }
        }

        searchState = null;
    }
}

/* Set<string>: \s 等价的空白字符集合（避免循环内逐字符正则开销） */
const WHITESPACE_CHARS = new Set([' ', '\t', '\n', '\r', '\f', '\v', '\u00a0', '\u1680',
    '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007',
    '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff']);

/* 将文本归一化用于搜索匹配：所有空白字符（空格、换行、回车、Tab、全角空格等）的连续序列折叠为单个空格。
   同时返回归一化后每个字符在原始文本中的索引映射，用于将匹配偏移恢复为原始内容偏移。
   
   为什么需要：用户从外部复制多段文本搜索时，换行符在复制粘贴过程中常被转换为空格。
   若消息内容中段落间是换行（\n 或 \r\n），直接按原文本匹配会失败。
   归一化让「内容中的换行/空白」与「关键词中的空格」等价，实现跨换行匹配。
   
   @param {string} text 原始文本
   @returns {{normalized: string, map: number[]}}
   normalized: 空白折叠后的文本（长度 ≤ 原始长度）
   map: 长度为 normalized.length，map[i] = normalized 第 i 个字符在原始文本中的索引 */
function normalizeTextWithMap(text) {
    let normalized = '';
    const map = [];
    let lastWasSpace = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (WHITESPACE_CHARS.has(ch)) {
            if (!lastWasSpace) {
                normalized += ' ';
                map.push(i);
                lastWasSpace = true;
            }
            /* 连续空白只保留一个空格（折叠） */
        } else {
            normalized += ch;
            map.push(i);
            lastWasSpace = false;
        }
    }
    return { normalized, map };
}

/* 在指定记录的所有消息内容中查找匹配位置
   仅做字符串索引扫描，不触碰 DOM，保证极端长文本下性能稳定。
   匹配前对内容和关键词做统一归一化（空白折叠），因此：
   - 从外部复制多段文本搜索（换行被复制系统转为空格）也能正常匹配
   - 消息内容中的 \n / \r\n / 空行与关键词中的空格等价
   - 匹配结果 start/end 为原始内容偏移（经映射恢复），可直接用于 DOM 高亮
   @param {number} recordIndex 记录索引
   @param {string} keyword 搜索关键词
   @returns {Array<{msgIdx: number, start: number, end: number}>} 匹配位置列表 */
function findMatchesInRecord(recordIndex, keyword) {
    const record = records[recordIndex];
    if (!record || !record.messages || !keyword) return [];

    /* 归一化搜索关键词：所有空白折叠为单个空格，并去除首尾空白 */
    const normalizedKeyword = keyword.replace(/\s+/g, ' ').trim();
    if (!normalizedKeyword) return [];
    /* 大小写不敏感搜索 */
    const lowerKeyword = normalizedKeyword.toLowerCase();

    const matches = [];

    record.messages.forEach((msg, msgIdx) => {
        /* 角色筛选隐藏的子消息不参与搜索：内容不在 DOM 中，导航高亮无法定位 */
        if (!isMessageVisible(msg)) return;
        addContentMatches(msg.content, msgIdx, normalizedKeyword, lowerKeyword, matches);
    });
    /* 回复作为最后一条伪消息参与搜索（msgIdx = messages.length） */
    if (record.reply && isMessageVisible(record.reply)) {
        addContentMatches(record.reply.content, record.messages.length, normalizedKeyword, lowerKeyword, matches);
    }

    return matches;
}

/* 在单条消息/回复内容中收集所有关键词匹配（归一化偏移映射，兼容 CRLF）。
   @param {string} content 消息/回复内容
   @param {number} msgIdx 消息索引（回复为 messages.length）
   @param {string} normalizedKeyword 归一化关键词
   @param {string} lowerKeyword 小写关键词
   @param {Array} matches 输出数组 */
function addContentMatches(content, msgIdx, normalizedKeyword, lowerKeyword, matches) {
    if (typeof content !== 'string' || !content) return;
    /* 与 DOM 渲染保持一致：浏览器解析 innerHTML 时会把 \r\n / \r 规范化为 \n， */
    /* 这里先做同样的换行规范化，匹配偏移才能直接用于 DOM 高亮； */
    /* 否则从第一个 \r 起，落点会按前面 \r 的数量逐步漂移（高亮到无关文字）。 */
    const normalizedContent = content.replace(/\r\n?/g, '\n');
    /* 归一化消息内容（空白折叠 + 偏移映射） */
    const { normalized, map } = normalizeTextWithMap(normalizedContent);
    const lowerContent = normalized.toLowerCase();

    let pos = 0;
    /* 快速通道：归一化内容中没有关键词则跳过该消息 */
    const firstIdx = lowerContent.indexOf(lowerKeyword);
    if (firstIdx === -1) return;

    /* 遍历所有出现位置（最多保护 5000 处，防止极端重复文本拖慢） */
    let count = 0;
    while (pos <= normalized.length && count < 5000) {
        const idx = lowerContent.indexOf(lowerKeyword, pos);
        if (idx === -1) break;
        /* 将归一化内容中的匹配偏移映射回原始内容偏移 */
        const origStart = map[idx];
        const normEnd = idx + normalizedKeyword.length;
        const origEnd = map[normEnd - 1] + 1;
        matches.push({ msgIdx, start: origStart, end: origEnd });
        pos = idx + normalizedKeyword.length;
        count++;
    }
}

/* 清除所有搜索高亮 <mark>（普通黄色匹配 + 当前橙色命中），恢复原始文本节点 */
function clearSearchHighlights() {
    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    if (!listEl) return;
    listEl.querySelectorAll('mark.rlog-search-mark, mark.rlog-search-mark-current').forEach(mark => {
        const parent = mark.parentNode;
        if (parent) {
            parent.replaceChild(document.createTextNode(mark.textContent), mark);
            parent.normalize();
        }
    });
}

/* 将当前命中的橙色高亮降级为普通黄色高亮（保留在 DOM 中）
   供导航跳转时复用已绘制的黄色高亮，避免全量重绘卡顿。
   与 clearSearchHighlights 不同：它不删除 mark，只切换 CSS 类名，
   因此旧命中重新变回黄色，折叠消息中的旧命中在重新展开后也保留黄色高亮。
   降级时记录旧命中的 matchIdx，保证后续跳回该位置时能被 removeYellowMarkByMatchIdx 找到。
   @param {number} [oldMatchIdx] 旧命中的 matchIdx（可选，用于记录标记） */
function clearCurrentHighlight(oldMatchIdx) {
    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    if (!listEl) return;
    listEl.querySelectorAll('mark.rlog-search-mark-current').forEach(mark => {
        mark.classList.remove('rlog-search-mark-current');
        mark.classList.add('rlog-search-mark');
        if (oldMatchIdx !== undefined && oldMatchIdx >= 0) {
            mark.dataset.matchIdx = String(oldMatchIdx);
        }
    });
}

/* 删除指定 matchIdx 的黄色普通匹配 mark（目标位置将由橙色覆盖绘制）
   @param {number} matchIdx 匹配在 matches 中的下标 */
function removeYellowMarkByMatchIdx(matchIdx) {
    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    if (!listEl) return;
    listEl.querySelectorAll(`mark.rlog-search-mark[data-match-idx="${matchIdx}"]`).forEach(mark => {
        const parent = mark.parentNode;
        if (parent) {
            parent.replaceChild(document.createTextNode(mark.textContent), mark);
            parent.normalize();
        }
    });
}

/* 在指定消息的内容区域中，将字符偏移 [start, end) 对应的文本包裹为 <mark>
   使用 TreeWalker 遍历 text node 精确定位偏移。
   @param {HTMLElement} contentEl .rmsg-content 元素
   @param {number} start 起始偏移（相对该消息的纯文本）
   @param {number} end 结束偏移
   @param {string} [className='rlog-search-mark-current'] <mark> 的 CSS 类名（普通匹配用黄色，当前命中用橙色）
   @returns {HTMLElement|null} 创建的 <mark> 元素，失败返回 null */
function highlightRange(contentEl, start, end, className = 'rlog-search-mark-current') {
    if (!contentEl || start < 0 || end <= start) return null;

    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
    let currentOffset = 0;
    let node = null;

    /* 找到包含 start 偏移的文本节点 */
    while ((node = walker.nextNode())) {
        const nodeLen = node.textContent.length;
        if (currentOffset + nodeLen > start) break;
        currentOffset += nodeLen;
    }
    if (!node) return null;

    /* 在该节点内拆分：before / mark / after */
    const nodeStart = currentOffset;
    const splitStart = start - nodeStart;
    const splitEnd = end - nodeStart;

    if (splitEnd > node.textContent.length) {
        /* 跨节点边界的情况（关键词跨多个 text node），简化处理：只取当前节点内可匹配部分 */
        const visibleStart = Math.max(0, splitStart);
        const visibleEnd = Math.min(node.textContent.length, splitEnd);
        if (visibleEnd <= visibleStart) return null;
        const range = document.createRange();
        range.setStart(node, visibleStart);
        range.setEnd(node, visibleEnd);
        const mark = document.createElement('mark');
        mark.className = className;
        try {
            range.surroundContents(mark);
        } catch (e) {
            return null;
        }
        return mark;
    }

    const range = document.createRange();
    range.setStart(node, splitStart);
    range.setEnd(node, splitEnd);
    const mark = document.createElement('mark');
    mark.className = className;
    try {
        range.surroundContents(mark);
    } catch (e) {
        return null;
    }
    return mark;
}

/* 高亮本条记录内所有匹配位置（黄色），但不包括当前命中（当前命中由 applyCurrentMatch 单独绘制橙色）
   同一消息内按 start 降序处理，避免先插入的 mark 影响后续文本偏移计算。
   @param {HTMLElement} recordEl 当前记录的 DOM 元素
   @param {number} recordIndex 记录索引 */
function highlightAllMatches(recordEl, recordIndex) {
    if (!searchState || !recordEl) return;
    const record = records[recordIndex];
    if (!record) return;

    /* 按消息分组（跳过当前命中，橙色单独绘制） */
    /* 同时保留每个匹配在 matches 中的下标，供黄色 mark 记录 data-match-idx */
    const matchesByMsg = new Map();
    searchState.matches.forEach((match, idx) => {
        if (idx === searchState.currentIdx) return;
        if (!matchesByMsg.has(match.msgIdx)) matchesByMsg.set(match.msgIdx, []);
        matchesByMsg.get(match.msgIdx).push({ match, idx });
    });

    matchesByMsg.forEach((msgMatches, msgIdx) => {
        const msg = getMessageByIndex(record, msgIdx);
        if (!msg) return;
        /* 确保消息展开（搜索高亮需要可见内容区） */
        if (msg.collapsed) {
            msg.collapsed = false;
            const msgItem = recordEl.querySelector(`.rmsg-item[data-msg="${msgIdx}"]`);
            if (msgItem) {
                msgItem.classList.add('expanded');
                msgItem.classList.remove('collapsed');
            }
        }
        const contentEl = recordEl.querySelector(`.rmsg-item[data-msg="${msgIdx}"] .rmsg-content`);
        if (!contentEl) return;

        /* 同一消息内按 start 降序处理，避免 mark 插入影响后续偏移 */
        msgMatches.sort((a, b) => b.match.start - a.match.start);
        msgMatches.forEach(({ match, idx }) => {
            const markEl = highlightRange(contentEl, match.start, match.end, 'rlog-search-mark');
            /* 记录匹配下标，供 removeYellowMarkByMatchIdx 准确定位要删除的黄色 mark */
            if (markEl) markEl.dataset.matchIdx = String(idx);
        });
    });
}

/* 将当前命中滚动到视野内舒适位置
   步骤：
   1. 滚动所在消息的 .rmsg-content 内部，使匹配出现在该滚动容器中
   2. 手动计算 .rlog-list 的 scrollTop，让消息区域出现在固定标题栏下方
   说明：不使用 scrollIntoView——它会递归滚动所有可滚动祖先容器，
   在移动端会连带滚动 ST 主界面（body/#sheld 等），造成整个界面位移。
   @param {HTMLElement} markEl 当前高亮的 <mark> 元素
   @param {HTMLElement} contentEl 所在 .rmsg-content 元素 */
function scrollToMatch(markEl, contentEl) {
    if (!markEl || !contentEl) return;

    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    if (!listEl) return;

    /* 1. 消息内部滚动：将 mark 对齐到 contentEl 可视区域中部偏上 */
    const contentRect = contentEl.getBoundingClientRect();
    const markRect = markEl.getBoundingClientRect();
    const contentScrollTop = contentEl.scrollTop;
    const relativeTop = markRect.top - contentRect.top + contentScrollTop;
    /* 目标位置：距消息内容区顶部约 25% 高度处（视觉舒适区） */
    const targetScroll = relativeTop - contentRect.height * 0.25;
    const clampedContentScroll = Math.max(0, targetScroll);
    contentEl.scrollTo({ top: clampedContentScroll, behavior: 'smooth' });

    /* 2. 外层列表滚动：手动定位，避免 scrollIntoView 联动滚动 ST 主界面 */
    /* 内层平滑滚动尚未完成，但 mark 在 list 中的逻辑位置可由滚动增量推算： */
    /*   内层滚动 delta > 0 时内容上移，mark 视觉上移 delta */
    /*   滚动后的 mark 视觉 top = markRect.top - delta */
    /* 期望 mark 出现在所有 sticky 标题栏（记录标题栏 + 消息标题栏）下方 8px 处 */
    const delta = clampedContentScroll - contentScrollTop;
    const markFinalTop = markRect.top - delta;
    const listRect = listEl.getBoundingClientRect();

    /* 累加两个 sticky 标题栏的高度（吸顶时占用的垂直空间），而非固定 48px： */
    /* - .rlog-record-header：吸在列表顶部（高约 40px） */
    /* - .rmsg-header：吸在记录标题栏下方（高约 32px+） */
    /* 用 offsetHeight 实测可自动兼容桌面/移动端不同高度，以及移动端标题栏换行变高。 */
    /* 注意：不能测量 getBoundingClientRect().bottom 的视觉位置—— */
    /* 当 mark 所在消息不在视口内时其 header 并未吸顶，bottom 会位于视口外很远， */
    /* 导致目标 scrollTop 被 clamp 到 0（列表滚回顶部）。offsetHeight 不受吸顶状态影响。 */
    const recordEl = markEl.closest('.rlog-record');
    const msgItemEl = markEl.closest('.rmsg-item');
    let stickyHeight = 0;
    if (recordEl) {
        const recordHeaderEl = recordEl.querySelector('.rlog-record-header');
        if (recordHeaderEl) stickyHeight += recordHeaderEl.offsetHeight;
    }
    if (msgItemEl) {
        const msgHeaderEl = msgItemEl.querySelector('.rmsg-header');
        if (msgHeaderEl) stickyHeight += msgHeaderEl.offsetHeight;
    }

    /* mark 在列表内容中的逻辑位置（不受滚动状态影响） */
    const markInList = listEl.scrollTop + markFinalTop - listRect.top;
    /* 目标：mark 出现在标题栏下方、列表可视区域约 1/3 高度处（视觉舒适区） */
    /* 可见内容高度 = 列表可视高度 - sticky 标题栏占用的高度 */
    const visibleHeight = Math.max(0, listEl.clientHeight - stickyHeight);
    const targetListScroll = markInList - stickyHeight - visibleHeight * 0.33;

    /* clamp 到合法滚动范围（避免浏览器静默 clamp 导致意外跳变） */
    const maxListScroll = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
    const clampedListScroll = Math.max(0, Math.min(targetListScroll, maxListScroll));

    /* 仅在需要调整时滚动外层（mark 已可见时保持不动，避免触发任何外部滚动） */
    if (Math.abs(clampedListScroll - listEl.scrollTop) > 1) {
        listEl.scrollTo({ top: clampedListScroll, behavior: 'smooth' });
    }
}

/* 更新搜索框计数显示（如 3/18） */
function updateSearchCounter() {
    if (!searchState || !searchState.searchEl) return;
    const counter = searchState.searchEl.querySelector('.rlog-search-count');
    if (!counter) return;

    const total = searchState.matches.length;
    const current = total > 0 ? searchState.currentIdx + 1 : 0;
    counter.textContent = `${current}/${total}`;

    /* 无结果或仅一个结果时禁用上下箭头 */
    const prevBtn = searchState.searchEl.querySelector('.rlog-search-prev');
    const nextBtn = searchState.searchEl.querySelector('.rlog-search-next');
    if (prevBtn) prevBtn.disabled = total <= 1;
    if (nextBtn) nextBtn.disabled = total <= 1;
}

/* 在指定消息索引处执行搜索，并高亮当前命中 + 滚动到该位置
   @param {number} msgIdx 消息索引
   @param {number} matchIdx 匹配在 matches 中的下标
   @param {boolean} [redrawYellowHighlights=true] 是否重绘普通匹配的黄色高亮
   - true（搜索词变化时）: 清除所有高亮后重新绘制全部黄色匹配
   - false（上下键导航时）: 只清除当前橙色命中，复用已绘制的黄色高亮（性能优化） */
function applyCurrentMatch(msgIdx, matchIdx, redrawYellowHighlights = true) {
    if (!searchState) return;
    const recordIndex = searchState.recordIndex;
    const record = records[recordIndex];
    const msg = getMessageByIndex(record, msgIdx);
    if (!record || !msg) return;

    const listEl = panelEl.querySelector('#rlog-list');
    const recordEl = listEl.querySelector(`.rlog-record[data-record-index="${recordIndex}"]`);
    if (!recordEl) return;

    if (redrawYellowHighlights) {
        /* 搜索词变化：清除所有高亮（黄色匹配 + 橙色当前）后重新绘制 */
        clearSearchHighlights();

        /* 确保记录处于展开状态 */
        if (record.collapsed) {
            record.collapsed = false;
            recordEl.classList.add('expanded');
            recordEl.classList.remove('collapsed');
        }

        /* 高亮本条内所有匹配（黄色，跳过当前命中） */
        /* 同时会展开所有匹配到的折叠消息 */
        highlightAllMatches(recordEl, recordIndex);
    } else {
        /* 导航跳转：将旧橙色的当前命中降级为黄色（保留 DOM 中的 mark，仅切换类名） */
        /* 复用已绘制的黄色高亮，避免全量重绘卡顿 */
        const oldIdx = searchState.currentIdx;
        clearCurrentHighlight(oldIdx);

        /* 删除目标位置已有的黄色 mark（如果该位置之前被导航过，会残留黄色 mark） */
        /* 必须先删除，否则画新橙色时 DOM 偏移计算会失效 */
        removeYellowMarkByMatchIdx(matchIdx);

        /* 确保记录处于展开状态（搜索模式打开时记录可能被折叠） */
        if (record.collapsed) {
            record.collapsed = false;
            recordEl.classList.add('expanded');
            recordEl.classList.remove('collapsed');
        }
    }

    /* 确保当前消息处于展开状态（折叠时内容不可见无法定位） */
    if (msg.collapsed) {
        msg.collapsed = false;
        const msgItem = recordEl.querySelector(`.rmsg-item[data-msg="${msgIdx}"]`);
        if (msgItem) {
            msgItem.classList.add('expanded');
            msgItem.classList.remove('collapsed');
        }
    }

    const contentEl = recordEl.querySelector(`.rmsg-item[data-msg="${msgIdx}"] .rmsg-content`);
    if (!contentEl) return;

    /* 异步创建滚动条（消息刚展开，需要等布局稳定） */
    setTimeout(() => createScrollbarForContent(contentEl), SCROLLBAR_CREATE_DELAY_MS);

    const match = searchState.matches[matchIdx];
    if (!match) return;

    /* 高亮当前命中（橙色） */
    const markEl = highlightRange(contentEl, match.start, match.end, 'rlog-search-mark-current');

    /* 更新计数 */
    searchState.currentIdx = matchIdx;
    updateSearchCounter();

    if (markEl) {
        scrollToMatch(markEl, contentEl);
    }
}

/* 执行搜索（输入关键词变更后由 debounce 调用）
   @param {number} recordIndex 记录索引
   @param {string} keyword 搜索关键词 */
function performSearch(recordIndex, keyword) {
    if (!searchState || !panelEl) return;

    /* 清空上一次搜索的 matches 与高亮 */
    searchState.matches = findMatchesInRecord(recordIndex, keyword);
    searchState.currentIdx = -1;
    searchState.keyword = keyword;

    if (!keyword) {
        clearSearchHighlights();
        updateSearchCounter();
        return;
    }

    if (searchState.matches.length > 0) {
        /* 自动跳转到第一个匹配 */
        searchState.currentIdx = 0;
        applyCurrentMatch(searchState.matches[0].msgIdx, 0);
    } else {
        /* 无匹配：清除高亮，计数显示 0/0 */
        clearSearchHighlights();
        updateSearchCounter();
    }
}

/* 跳转到下一个/上一个匹配
   @param {number} direction 1=下一个, -1=上一个 */
function navigateSearch(direction) {
    if (!searchState || !searchState.matches || searchState.matches.length === 0) return;

    const total = searchState.matches.length;
    let nextIdx = searchState.currentIdx + direction;
    /* 循环跳转 */
    if (nextIdx >= total) nextIdx = 0;
    if (nextIdx < 0) nextIdx = total - 1;

    const match = searchState.matches[nextIdx];
    /* 第三个参数 false：导航跳转时只清除橙色当前命中，复用已绘制的黄色高亮（性能优化） */
    applyCurrentMatch(match.msgIdx, nextIdx, false);
}

/* 关闭搜索框并重置搜索状态 */
function closeSearch() {
    resetSearchIfActive();
}

/* 为指定记录打开搜索模式（排他原则：一次仅一条记录处于搜索状态）
   点击记录操作区中的放大镜按钮时触发。
   @param {number} recordIndex 记录索引 */
function openSearchForRecord(recordIndex) {
    if (!panelEl) return;
    /* 排他：先关闭任何已有的搜索（包含其它记录或本记录） */
    resetSearchIfActive();

    const listEl = panelEl.querySelector('#rlog-list');
    const recordEl = listEl.querySelector(`.rlog-record[data-record-index="${recordIndex}"]`);
    if (!recordEl) return;

    const actionsEl = recordEl.querySelector('.rlog-record-actions');
    const actionsInner = recordEl.querySelector('.rlog-record-actions-inner');
    if (!actionsEl || !actionsInner) return;

    /* 标记记录为「搜索中」（CSS 隐藏除放大镜外的其他操作按钮与下箭头， */
    /* 释放空间给搜索框向右展开覆盖） */
    recordEl.classList.add('rlog-searching');

    /* 隐藏记录折叠/展开箭头（▾）—— 用 visibility 保留其空间占位， */
    /* 配合 CSS 固定 actions-inner 宽度，保证放大镜位置不被推移 */
    const toggleIcon = recordEl.querySelector('.rlog-toggle-icon');
    if (toggleIcon) toggleIcon.style.visibility = 'hidden';

    /* 若记录处于折叠状态，自动展开（搜索高亮需要可见内容区） */
    const record = records[recordIndex];
    if (record && record.collapsed) {
        record.collapsed = false;
        recordEl.classList.add('expanded');
        recordEl.classList.remove('collapsed');
        /* 展开后为消息内容区懒创建进度条（仅视口内立即创建，其余延迟） */
        queueScrollbarsForEls(recordEl.querySelectorAll('.rmsg-content'));
    }

    /* 构建搜索框 DOM（不含放大镜：普通放大镜按钮保持原位作为视觉锚点， */
    /* 搜索框紧随其右侧展开，占用被隐藏按钮释放的空间） */
    const searchBox = document.createElement('div');
    searchBox.className = 'rlog-search-box';
    searchBox.innerHTML = `
        <div class="rlog-search-input-wrap">
            <input type="text" class="rlog-search-input" placeholder="搜索..." autocomplete="off" spellcheck="false">
            <span class="rlog-search-count">0/0</span>
        </div>
        <button class="rlog-search-next" title="下一个 (Enter)" disabled>
            <i class="fa-solid fa-arrow-down"></i>
        </button>
        <button class="rlog-search-prev" title="上一个 (Shift+Enter)" disabled>
            <i class="fa-solid fa-arrow-up"></i>
        </button>
    `;

    /* 插入到放大镜按钮右侧（放大镜保持原位，搜索框向右展开） */
    const searchBtn = actionsInner.querySelector('.rlog-search-btn');
    if (searchBtn) {
        searchBtn.insertAdjacentElement('afterend', searchBox);
    } else {
        actionsInner.appendChild(searchBox);
    }

    /* 初始化搜索状态 */
    searchState = {
        recordIndex,
        keyword: '',
        matches: [],
        currentIdx: -1,
        searchEl: searchBox,
    };

    /* 绑定搜索框内部事件 */
    const input = searchBox.querySelector('.rlog-search-input');
    const prevBtn = searchBox.querySelector('.rlog-search-prev');
    const nextBtn = searchBox.querySelector('.rlog-search-next');

    /* boolean: 输入法组合状态标志（拼音未上屏时 input 事件不触发搜索） */
    let isComposing = false;
    /* 防抖搜索调度函数：input 事件与 compositionend 共用 */
    const scheduleSearch = () => {
        if (searchDebounceTimer !== null) {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = null;
        }
        searchDebounceTimer = setTimeout(() => {
            searchDebounceTimer = null;
            performSearch(recordIndex, input.value);
        }, SEARCH_DEBOUNCE_MS);
    };

    /* 输入法组合开始：置标志，组合期间的 input 事件全部跳过 */
    input.addEventListener('compositionstart', () => { isComposing = true; });
    /* 输入法组合结束（文字已上屏）：清除标志并补一次搜索（组合期间可能错过了 input） */
    input.addEventListener('compositionend', () => {
        isComposing = false;
        scheduleSearch();
    });

    /* 输入实时搜索（debounce 防抖），组合阶段跳过 */
    input.addEventListener('input', (e) => {
        if (isComposing || e.isComposing || e.keyCode === 229) return;
        scheduleSearch();
    });

    /* 键盘快捷键：Enter 下一个 / Shift+Enter 上一个 / Esc 关闭 */
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) {
                navigateSearch(-1);
            } else {
                navigateSearch(1);
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeSearch();
        }
    });

    prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigateSearch(-1);
    });

    nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigateSearch(1);
    });

    /* 自动聚焦输入框 */
    setTimeout(() => {
        if (input && searchState && searchState.searchEl === searchBox) {
            input.focus();
        }
    }, 50);
}

/* ── 筛选 ─────────────────────────────── */

/* 模型名称 → 筛选分组：DeepSeek / Claude / Gemini（含 Gemma、Palm）固定成组，其余归「其他」。
   与 extractModelFamily()（分词用途）分离、不复用：DeepSeek 需要独立成组。 */
function getModelFilterGroup(modelName) {
    if (!modelName || modelName === '未知模型') return 'other';
    const m = modelName.toLowerCase();
    if (m.includes('deepseek')) return 'deepseek';
    if (m.includes('claude')) return 'claude';
    if (m.includes('gemini') || m.includes('gemma') || m.includes('palm')) return 'gemini';
    return 'other';
}

/* 消息角色 → 筛选分组：system / user / assistant 固定，其余（tool、developer 等）归「其他」 */
function getRoleFilterGroup(role) {
    if (role === 'system') return 'system';
    if (role === 'user') return 'user';
    if (role === 'assistant') return 'assistant';
    return 'other';
}

/* 子消息（含回复伪消息）是否通过角色筛选：
   角色筛选按消息逐条判定，只控制单条子消息的显隐，不直接决定整条记录。 */
function isMessageVisible(msg) {
    if (!msg) return false;
    return !!filterState.role[getRoleFilterGroup(msg.role)];
}

/* 记录是否通过当前筛选：
   来源/模型按整条记录判定；角色按子消息逐条判定——记录自身只要还有
   至少一条可见子消息（普通消息或回复）即保留，否则随列表隐藏。 */
function matchesFilter(record) {
    if (!record) return false;
    const sourceKey = record.source && record.source.type === 'native' ? 'native' : 'plugin';
    if (!filterState.source[sourceKey]) return false;
    const hasVisibleMessage = record.messages.some(isMessageVisible)
        || (record.reply ? isMessageVisible(record.reply) : false);
    if (!hasVisibleMessage) return false;
    const modelKey = getModelFilterGroup(record.modelName);
    if (!filterState.model[modelKey]) return false;
    return true;
}

/* 可见记录列表（只影响渲染；records 数组保持原样，DOM 上的 data-record-index 仍是真实索引） */
function getVisibleRecords() {
    return records.filter(matchesFilter);
}

/* 是否已有生效的筛选（任一分组开关被关闭） */
function isFilterActive() {
    return Object.keys(filterState).some((group) =>
        Object.keys(filterState[group]).some((key) => !filterState[group][key])
    );
}

/* 新建一份「全开」默认筛选状态（供引导暂存/恢复使用） */
function createDefaultFilterState() {
    return {
        source: { native: true, plugin: true },
        role: { system: true, user: true, assistant: true, other: true },
        model: { gemini: true, claude: true, deepseek: true, other: true },
    };
}

/* 模型品牌图标 SVG 路径（simple-icons 单色 24×24，fill="currentColor"，内联无图片文件） */
const FILTER_MODEL_SVG = {
    gemini_full: `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
        <defs>
            <radialGradient id="gemini-top" cx="50%" cy="0%" r="60%">
                <stop offset="0%" stop-color="#FF5252" />
                <stop offset="100%" stop-color="#FF5252" stop-opacity="0" />
            </radialGradient>
            <radialGradient id="gemini-right" cx="100%" cy="50%" r="70%">
                <stop offset="0%" stop-color="#4285F4" />
                <stop offset="100%" stop-color="#4285F4" stop-opacity="0" />
            </radialGradient>
            <radialGradient id="gemini-bottom" cx="50%" cy="100%" r="60%">
                <stop offset="0%" stop-color="#0F9D58" />
                <stop offset="100%" stop-color="#0F9D58" stop-opacity="0" />
            </radialGradient>
            <radialGradient id="gemini-left" cx="0%" cy="50%" r="60%">
                <stop offset="0%" stop-color="#FBBC05" />
                <stop offset="100%" stop-color="#FBBC05" stop-opacity="0" />
            </radialGradient>
            <mask id="gemini-mask">
                <path fill="#ffffff" d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/>
            </mask>
        </defs>
        <g mask="url(#gemini-mask)">
            <rect width="24" height="24" fill="#4285F4" />
            <rect width="24" height="24" fill="url(#gemini-top)" />
            <rect width="24" height="24" fill="url(#gemini-bottom)" />
            <rect width="24" height="24" fill="url(#gemini-left)" />
        </g>
    </svg>`,
    claude: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
    deepseek: 'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45',
};

/* 更新标题旁「N隐藏」指示器（只显示被筛选隐藏的记录数）与筛选按钮激活圆点 */
function updateFilterIndicator() {
    if (!panelEl) return;
    const active = isFilterActive();
    const indicator = panelEl.querySelector('#rlog-filter-indicator');
    if (indicator) {
        /* 只展示因筛选被隐藏的记录数；没有隐藏（含记录为空）时隐藏指示器，只留按钮圆点提醒 */
        const hiddenCount = records.length - getVisibleRecords().length;
        const showText = active && hiddenCount > 0;
        indicator.hidden = !showText;
        if (showText) {
            const textEl = panelEl.querySelector('#rlog-filter-indicator-text');
            if (textEl) textEl.textContent = `${hiddenCount}隐藏`;
        }
    }
    const btn = panelEl.querySelector('#rlog-filter-btn');
    if (btn) btn.classList.toggle('rlog-filter-active', active);
}

/* 刷新抽屉内所有分段按钮的开/关视觉状态（aria-pressed 同步无障碍状态） */
function updateFilterChipUI() {
    if (!panelEl) return;
    panelEl.querySelectorAll('.rlog-filter-chip').forEach((chip) => {
        const group = chip.dataset.filterGroup;
        const value = chip.dataset.filterValue;
        const on = !!(filterState[group] && filterState[group][value]);
        chip.classList.toggle('rlog-filter-chip-on', on);
        chip.classList.toggle('rlog-filter-chip-off', !on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

/* 切换单个筛选开关并重建列表（重建时单条搜索自动退出，与现有渲染行为一致） */
function toggleFilterChip(group, value) {
    if (!filterState[group] || !(value in filterState[group])) return;
    filterState[group][value] = !filterState[group][value];
    updateFilterChipUI();
    panelContentDirty = true;
    if (panelEl && isPanelVisible) renderPanelContent();
}

/* 重置全部筛选为「全开」并刷新列表 */
function resetFilters() {
    filterState = createDefaultFilterState();
    updateFilterChipUI();
    updateFilterIndicator();
    panelContentDirty = true;
    if (panelEl && isPanelVisible) renderPanelContent();
}

/* ── 渲染与 HTML 构建 ──────────────────── */

function getHeaderCountText() {
    return `${records.length}/${MAX_RECORDS}`;
}

/* 更新标题栏计数文字（调用 getHeaderCountText，格式集中在一处） */
function updateHeaderTitle() {
    if (!panelEl) return;
    const countEl = panelEl.querySelector('.rlog-title-count');
    if (countEl) {
        countEl.textContent = getHeaderCountText();
    }
}

function buildMessageHtml(msg, recordIdx, msgIdx) {
    const roleClass = getRoleClass(msg.role);
    const roleLabel = getRoleLabel(msg.role);
    const collapsedClass = msg.collapsed ? 'collapsed' : 'expanded';
    /* tokenPrecise 为 true 表示使用了 ST 原生分词器的精确值，不显示 ~ 估算标记 */
    const tokenPrefix = msg.tokenPrecise ? '' : '~';
    /* 内容预览文字（仅当开关开启时显示，或处于强制预览演示状态） */
    const showPreview = forcePreviewState !== null ? forcePreviewState : contentPreviewEnabled;
    const previewHtml = showPreview
        ? `<span class="rmsg-preview-text" title="${escapeHtml(msg.content.slice(0, 200))}">${escapeHtml(getContentPreview(msg.content))}</span>`
        : '';
    return `
        <div class="rmsg-item ${collapsedClass} ${roleClass}" data-record="${recordIdx}" data-msg="${msgIdx}">
            <div class="rmsg-header">
                <span class="rmsg-expand-icon"><i class="fa-solid fa-chevron-right"></i></span>
                <span class="rmsg-role-badge ${roleClass}">${escapeHtml(roleLabel)}</span>
                ${previewHtml}
                <span class="rmsg-tokens">${tokenPrefix}${msg.tokens} tokens</span>
                <button class="rmsg-copy-btn" data-record="${recordIdx}" data-msg="${msgIdx}" title="复制此消息">
                    <i class="fa-solid fa-copy"></i>
                </button>
            </div>
            <pre class="rmsg-content">${escapeHtml(msg.content)}</pre>
        </div>
    `;
}

function renderPanelContent() {
    if (!panelEl) return;

    /* 重建 DOM 前必须先清理搜索状态（搜索高亮、搜索框引用旧 DOM 节点会失效） */
    resetSearchIfActive();

    const listEl = panelEl.querySelector('#rlog-list');
    if (!listEl) return;

    /* 计数格式统一由 updateHeaderTitle → getHeaderCountText 一处维护 */
    updateHeaderTitle();
    /* 筛选指示器（「N隐藏」+ 按钮圆点）随每次渲染刷新 */
    updateFilterIndicator();

    if (records.length === 0) {
        panelEl.classList.add('rlog-empty-list');
        const emptyMsg = masterEnabled 
            ? '暂无请求记录，请发送消息后查看。'
            : '记录功能已关闭，请点击电源图标开启。';
        listEl.innerHTML = `<div class="rlog-empty">${escapeHtml(emptyMsg)}</div>`;
        panelContentDirty = false;
        return;
    }
    panelEl.classList.remove('rlog-empty-list');

    /* 筛选后无可显示记录：专用空状态 + 一键重置（与「暂无记录」区分） */
    const visibleRecords = getVisibleRecords();
    if (visibleRecords.length === 0) {
        panelEl.classList.add('rlog-empty-list');
        listEl.innerHTML = `<div class="rlog-empty"><div>没有符合筛选条件的记录</div><button id="rlog-filter-reset-empty" class="rlog-filter-reset-empty-btn">重置筛选</button></div>`;
        const resetBtn = listEl.querySelector('#rlog-filter-reset-empty');
        if (resetBtn) {
            resetBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                resetFilters();
            });
        }
        panelContentDirty = false;
        return;
    }

    /* 状态标签槽位宽度：实测最宽标签并写入 CSS 变量， */
    /* 等待占位与到达后的状态标签共用该宽度，回复到达不引起标题栏布局跳动 */
    const statusMaxW = getReplyStatusMaxWidth();
    if (statusMaxW > 0) {
        panelEl.style.setProperty('--rlog-status-w', `${statusMaxW}px`);
    }

    /* 只渲染可见记录；DOM 的 data-record-index 仍写入 records 中的真实索引，
       搜索/复制/删除/查看全文/回复挂载等按索引取数的路径无需改语义 */
    const visibleIndexes = visibleRecords.map((rec) => records.indexOf(rec));
    listEl.innerHTML = visibleRecords
        .map((rec, vi) => {
            const idx = visibleIndexes[vi];
            const totalTokens = getTotalTokens(rec.messages);
            const collapsedClass = rec.collapsed ? 'collapsed' : 'expanded';
            const sourceLabel = getSourceLabel(rec.source);
            const sourceClass = getSourceClass(rec.source);
            const sourceType = sourceClass === 'rlog-source-native' ? 'native' : 'plugin';
            const sourceTitle = (rec.source && rec.source.detail) || sourceLabel;

            /* 判断整条记录是否所有消息都使用了精确 token（非估算值） */
            const allPrecise = rec.messages.every(m => m.tokenPrecise === true);
            const recordTokenPrefix = allPrecise ? '' : '~';

            /* 角色筛选按子消息逐条过滤：只渲染可见子消息，
               data-msg 仍写 messages 中的真实索引，复制/搜索/回复挂载等按索引取数无需改语义。
               回复作为最后一条伪消息（data-msg = messages.length），与其他 role 子消息同形态 */
            const messagesHtml = rec.messages
                .map((msg, mIdx) => ({ msg, mIdx }))
                .filter(({ msg }) => isMessageVisible(msg))
                .map(({ msg, mIdx }) => buildMessageHtml(msg, idx, mIdx))
                .join('')
                + (rec.reply && isMessageVisible(rec.reply)
                    ? buildMessageHtml(rec.reply, idx, rec.messages.length)
                    : '');

            /* 回复状态标记：仅折叠时显示在按钮组与折叠箭头之间（展开时隐藏，按钮区恢复正常）。 */
            /* 回复在途（已建记录、尚未终态）时先输出透明占位，占住最宽标签的槽位， */
            /* 到达后由 appendReplyToRecordDom 原位替换为状态标签，窄屏下不换行移位。 */
            const replyStatusHtml = rec.reply
                ? `<span class="rlog-reply-status rlog-reply-status-${rec.reply.status}" title="${escapeHtml(getReplyStatusTitle(rec))}">${getReplyStatusLabel(rec.reply.status)}</span>`
                : (rec.id != null && pendingReplies.has(rec.id)
                    ? '<span class="rlog-reply-status rlog-reply-status-placeholder"></span>'
                    : '');

            return `
                <div class="rlog-record ${collapsedClass}" data-source="${sourceType}" data-record-index="${idx}">
                    <div class="rlog-record-header">
                        <div class="rlog-record-info">
                            <span class="rlog-char-name">${escapeHtml(rec.characterName)}</span>
                            <span class="rlog-source-badge ${sourceClass}" title="${escapeHtml(sourceTitle)}"><span class="rlog-status-dot"></span>${escapeHtml(sourceLabel)}</span>
                            <span class="rlog-time">${escapeHtml(rec.timestamp)}</span>
                            <span class="rlog-model-badge" title="请求模型">${escapeHtml(rec.modelName || '未知模型')}</span>
                            <span class="rlog-total-tokens">${recordTokenPrefix}<span class="rlog-token-num rlog-token-tier-${getTokenTier(totalTokens)}">${totalTokens}</span>&nbsp;tokens [${rec.messages.length}]</span>
                        </div>
                        <div class="rlog-record-actions">
                            <div class="rlog-record-actions-inner" style="display:flex; gap:4px; align-items:center;">
                                <button class="rlog-search-btn" data-record="${idx}" title="搜索本条记录">
                                    <i class="fa-solid fa-magnifying-glass"></i>
                                </button>
                                <button class="rlog-msg-expand-btn" data-record="${idx}" title="展开所有消息">
                                    <i class="fa-solid fa-expand"></i>
                                </button>
                                <button class="rlog-msg-collapse-btn" data-record="${idx}" title="折叠所有消息">
                                    <i class="fa-solid fa-compress-alt"></i>
                                </button>
                                <button class="rlog-jump-bottom-btn" data-record="${idx}" title="快速置底">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="4" x2="12" y2="15"></line><line x1="5" y1="20" x2="19" y2="20"></line></svg>
                                </button>
                                <button class="rlog-read-full-btn" data-record="${idx}" title="查看全文">
                                    <i class="fa-solid fa-file-lines"></i>
                                </button>
                                <button class="rlog-delete-record-btn" data-record="${idx}" title="删除本条记录">
                                    <i class="fa-solid fa-trash-can"></i>
                                </button>
                            </div>
                            ${replyStatusHtml}
                            <span class="rlog-toggle-icon"><i class="fa-solid fa-chevron-down"></i></span>
                        </div>
                    </div>
                    <div class="rlog-record-body">
                        ${messagesHtml}
                    </div>
                </div>
            `;
        })
        .join('');

    bindListEvents(listEl);

    /* 为每条记录写入 --rlog-rec-h（记录标题栏实测高度），供消息标题栏吸顶定位 */
    syncRecordHeaderVars(listEl);

    /* 为消息内容区创建 overlay 进度条 */
    attachScrollIndicators(listEl);

    /* 渲染完成，清除脏标记（下次打开面板时无需重建 DOM） */
    panelContentDirty = false;
}

/* 同步每条记录的 --rlog-rec-h：记录标题栏（.rlog-record-header）的实际高度。
   
   消息标题栏（.rmsg-header）的 sticky top 需要等于记录标题栏的高度，才能正好吸在
   记录标题栏正下方。记录标题栏高度会随宽度变化（窄屏时信息换行，实测可达 100px+），
   写死 40px/36px 会让消息标题被记录标题遮挡。这里按每条记录实测写入 CSS 变量，
   浏览器原生 sticky 用该变量定位；变量只在布局变化时更新，不参与逐帧滚动。 */
function syncRecordHeaderVars(listEl) {
    if (!listEl) return;
    ensureSharedResizeObserver();
    /* 清理已不在列表中的旧观察目标（renderPanelContent 用 innerHTML 重建 DOM） */
    const currentHeaders = new Set(listEl.querySelectorAll('.rlog-record-header'));
    observedRecordHeaders.forEach((headerEl) => {
        if (!currentHeaders.has(headerEl)) {
            sharedResizeObserver.unobserve(headerEl);
            observedRecordHeaders.delete(headerEl);
        }
    });
    listEl.querySelectorAll('.rlog-record').forEach((recordEl) => {
        const headerEl = recordEl.querySelector('.rlog-record-header');
        if (headerEl) {
            /* 用 getBoundingClientRect().height（小数）而非 offsetHeight（取整）： */
            /* 换行高度常为小数（如 65.59px），取整会让消息标题与记录标题之间 */
            /* 出现亚像素缝隙（高分屏上肉眼可见 ~1px） */
            recordEl.style.setProperty('--rlog-rec-h', `${headerEl.getBoundingClientRect().height.toFixed(2)}px`);
            /* 标题栏高度变化（换行/字体/视口变化）时自动刷新偏移 */
            if (!observedRecordHeaders.has(headerEl)) {
                observedRecordHeaders.add(headerEl);
                sharedResizeObserver.observe(headerEl);
            }
        }
    });
}

/* 滚动锚定包装器：在执行展开/折叠动作前后记录元素位置，
   并补偿滚动条，使锚点元素（标题栏）在视口中保持相对静止。
   折叠会使锚点标题栏上移：一是内容变矮导致恢复的 scrollTop 被浏览器
   静默钳到新的最大值，二是吸顶标题栏随容器变矮而「脱钉」回落到流位置——
   两种机制都会把标题栏顶出视口。检测到锚点在视口内上移超过 1px 时，
   用折叠前后的视口相对位置差反向校正滚动；无上移（含展开时吸顶下移，
   属正常吸顶行为）不校正，行为逐像素不变。
   注意：折叠类操作必须传 anchorEl（被点击的记录/消息标题栏），
   否则钳制缺口会残留；「展开」类操作只增不减不钳制，可不传。
   @param {Function} action 执行导致高度变化的 DOM 操作
   @param {HTMLElement|null} [anchorEl] 需要在视口中保持静止的锚点元素 */
function preserveScrollTop(action, anchorEl) {
    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    if (!listEl) { action(); return; }
    const saved = listEl.scrollTop;
    /* 锚点元素操作前的视口内相对位置（相对列表可视区顶部；吸顶时即吸顶位置） */
    let beforeRelTop = null;
    if (anchorEl) {
        beforeRelTop = anchorEl.getBoundingClientRect().top - listEl.getBoundingClientRect().top;
    }
    action();
    listEl.scrollTop = saved;
    /* 锚点在视口内上移超过 1px（钳制或脱钉所致）时，用当前位置差反向校正， */
    /* 让标题栏回到折叠前所在位置；下移（吸顶钉住）是正常行为，不校正 */
    if (anchorEl && beforeRelTop !== null) {
        const curRelTop = anchorEl.getBoundingClientRect().top - listEl.getBoundingClientRect().top;
        if (curRelTop - beforeRelTop < -1) {
            listEl.scrollTop = listEl.scrollTop + (curRelTop - beforeRelTop);
        }
    }
}

/* 为单个消息条目绑定交互事件（标题栏折叠/展开 + 复制按钮）。
   既用于整表初始渲染，也用于回复到达时追加的单个 Response 条目。
   @param {HTMLElement} msgItem .rmsg-item 元素 */
function bindMsgItemEvents(msgItem) {
    const header = msgItem.querySelector('.rmsg-header');
    if (header) {
        header.addEventListener('click', function (e) {
            if (e.target.closest('button')) return;
            const item = this.closest('.rmsg-item');
            const recIdx = Number(item.dataset.record);
            const msgIdx = Number(item.dataset.msg);
            preserveScrollTop(() => {
                toggleMessageCollapse(recIdx, msgIdx, item);
            }, header);
        });
    }
    const copyBtn = msgItem.querySelector('.rmsg-copy-btn');
    if (copyBtn) {
        copyBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            const recIdx = Number(this.dataset.record);
            const msgIdx = Number(this.dataset.msg);
            copySingleMessage(recIdx, msgIdx, this);
        });
    }
}

function bindListEvents(listEl) {
    listEl.querySelectorAll('.rmsg-item').forEach(bindMsgItemEvents);

    listEl.querySelectorAll('.rlog-record-header').forEach((header) => {
        /* boolean: 本次按下的起点是否在搜索框内（拖动选中文字越界时不触发折叠） */
        let mouseDownInSearchBox = false;
        header.addEventListener('mousedown', (e) => {
            mouseDownInSearchBox = e.target.closest('.rlog-search-box') !== null;
        });
        header.addEventListener('touchstart', (e) => {
            mouseDownInSearchBox = e.target.closest('.rlog-search-box') !== null;
        });
        header.addEventListener('click', function (e) {
            if (e.target.closest('button')) return;
            /* 搜索框区域（输入框/计数/空白）不触发折叠/展开，保持搜索状态稳定 */
            if (e.target.closest('.rlog-search-box')) return;
            /* 从搜索框内按下并拖动到外部松开时，click 目标为两者的共同祖先（header）， */
            /* 此时不应触发折叠/展开，否则拖动选中文字越界会意外取消搜索面板 */
            if (mouseDownInSearchBox) return;
            const recordEl = this.closest('.rlog-record');
            const idx = Number(recordEl.dataset.recordIndex);
            /* 展开/折叠单条记录时保持滚动位置不变（标题栏固定在视口，内容只向下展开） */
            preserveScrollTop(() => {
                toggleRecordCollapse(idx, recordEl);
            }, this);
        });
    });

    listEl.querySelectorAll('.rlog-search-btn').forEach((btn) => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const idx = Number(this.dataset.record);
            /* 放大镜点击逻辑： */
            /* - 未展开搜索菜单时 → 开启搜索菜单 */
            /* - 已展开当前记录的搜索菜单 → 关闭搜索菜单 */
            /* - 已展开其他记录的搜索菜单 → 关闭其他记录并开启当前记录的搜索 */
            if (searchState && searchState.recordIndex === idx) {
                closeSearch();
            } else {
                openSearchForRecord(idx);
            }
        });
    });

    listEl.querySelectorAll('.rlog-read-full-btn').forEach((btn) => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const idx = Number(this.dataset.record);
            openReadFullOverlay(idx);
        });
    });

    listEl.querySelectorAll('.rlog-msg-collapse-btn').forEach((btn) => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const idx = Number(this.dataset.record);
            /* 折叠所有消息后要回顶，不能再保持原滚动位置（preserveScrollTop 会抵消回顶） */
            collapseRecordMessages(idx);
        });
    });

    listEl.querySelectorAll('.rlog-msg-expand-btn').forEach((btn) => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const idx = Number(this.dataset.record);
            preserveScrollTop(() => {
                expandRecordMessages(idx);
            });
        });
    });

    listEl.querySelectorAll('.rlog-jump-bottom-btn').forEach((btn) => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const idx = Number(this.dataset.record);
            scrollToRecordBottom(idx);
        });
    });

    listEl.querySelectorAll('.rlog-delete-record-btn').forEach((btn) => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const idx = Number(this.dataset.record);
            const record = records[idx];
            if (!record) return;

            /* 确认后再删除，避免误触 */
            showConfirmDialog({
                title: '删除单条记录',
                message: `确定要删除 <strong>${escapeHtml(record.characterName)}</strong> 的这条请求记录吗？<br>（${escapeHtml(record.timestamp)}，共 ${record.messages.length} 条消息）<br>此操作不可撤销。`,
                confirmText: '删除',
                cancelText: '取消',
                onConfirm: () => {
                    deleteRecord(idx);
                },
            });
        });
    });

}

/* ── 折叠展开与回顶闪烁 ────────────────────── */

function toggleRecordCollapse(index, recordEl) {
    /* 折叠记录时退出搜索模式（折叠会改变内容区可见性，搜索状态不应保留） */
    resetSearchIfActive();
    records[index].collapsed = !records[index].collapsed;
    if (records[index].collapsed) {
        /* 判定本次折叠是否触发「回顶」：折叠后列表内容变矮，浏览器会把 scrollTop */
        /* 压回顶部；仅当折叠前已滚动、折叠后确实到顶，才认为发生了回顶 */
        const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
        const wasScrolled = !!(listEl && listEl.scrollTop > 1);
        recordCollapseToppedEl = null;
        /* 折叠记录时打断进行中的置底闪烁（展开后不再重播） */
        clearHeaderFlash(recordEl);
        recordEl.classList.add('collapsed');
        recordEl.classList.remove('expanded');
        if (wasScrolled && listEl && listEl.scrollTop === 0) {
            recordCollapseToppedEl = recordEl;
        }
    } else {
        recordEl.classList.add('expanded');
        recordEl.classList.remove('collapsed');
        /* 折叠→展开后，内部子记录回到本条记录顶部：仅当本次折叠确实把列表压回顶部 */
        /* 时，才对第一条子消息标题栏做提示闪烁；停留在顶部反复折叠/展开、 */
        /* 以及新记录出现后的普通展开，都不闪 */
        if (recordCollapseToppedEl === recordEl) {
            const firstMsgHeader = recordEl.querySelector('.rmsg-item .rmsg-header');
            if (firstMsgHeader) triggerHeaderFlash(firstMsgHeader);
        }
        recordCollapseToppedEl = null;
        /* 展开记录后，为消息内容区懒创建进度条（仅视口内立即创建，其余延迟） */
        queueScrollbarsForEls(recordEl.querySelectorAll('.rmsg-content'));
    }
}

function toggleMessageCollapse(recIdx, msgIdx, msgItem) {
    /* 折叠/展开消息属于单条记录内部操作，不退出搜索模式 */
    /* （搜索高亮保留在 DOM 中，折叠只是隐藏内容，展开后自动恢复可见） */
    const record = records[recIdx];
    if (!record) return;
    const msg = getMessageByIndex(record, msgIdx);
    if (!msg) return;
    msg.collapsed = !msg.collapsed;
    if (msg.collapsed) {
        /* 折叠消息时打断进行中的置底闪烁（展开后不再重播） */
        clearHeaderFlash(msgItem);
        msgItem.classList.add('collapsed');
        msgItem.classList.remove('expanded');
    } else {
        msgItem.classList.add('expanded');
        msgItem.classList.remove('collapsed');
        /* 展开消息后，内容区回到顶部 */
        const contentEl = msgItem.querySelector('.rmsg-content');
        if (contentEl) {
            contentEl.scrollTop = 0; /* 折叠后再展开时，从消息内容顶部开始看 */
            createScrollbarForContent(contentEl);
        }
    }
}

/* 按消息索引取消息：前 N 条为 record.messages，最后一条伪消息为回复（data-msg = messages.length）。
   @param {object} record 记录对象
   @param {number} msgIdx 消息索引（含回复伪索引）
   @returns {object|null} */
function getMessageByIndex(record, msgIdx) {
    if (!record) return null;
    if (msgIdx < record.messages.length) return record.messages[msgIdx];
    if (msgIdx === record.messages.length) return record.reply || null;
    return null;
}

/* 标题栏「折叠所有条目」按钮 — 将所有记录折叠，同时将每条记录内的所有消息也折叠 */
function collapseAllEntries() {
    /* 折叠全部条目前退出搜索模式 */
    resetSearchIfActive();
    if (records.length === 0) return;
    /* 折叠全部记录时打断进行中的置底闪烁（展开后不再重播） */
    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    clearHeaderFlash(listEl);
    records.forEach((r, i) => {
        r.collapsed = true;
        /* 折叠该记录内的所有消息 */
        r.messages.forEach(m => { m.collapsed = true; });
        if (r.reply) r.reply.collapsed = true;
        const recordEl = panelEl.querySelector(`.rlog-record[data-record-index="${i}"]`);
        if (recordEl) {
            recordEl.classList.add('collapsed');
            recordEl.classList.remove('expanded');
            /* 折叠所有消息 DOM */
            recordEl.querySelectorAll('.rmsg-item').forEach(el => {
                el.classList.add('collapsed');
                el.classList.remove('expanded');
            });
        }
    });
    /* 折叠全部后回到顶部最新一条 */
    if (listEl) listEl.scrollTop = 0;
    /* 折叠全部回顶：对顶部最新一条做提示闪烁 */
    flashTopHint();
}

/* 单条记录「折叠所有消息」按钮 — 折叠本条记录内所有角色的消息，同时回到列表顶部
   并对顶部（最新一条）做提示闪烁（与主标题栏「折叠所有条目」逻辑一致）
   @param {number} index 记录索引 */
function collapseRecordMessages(index) {
    /* 折叠本条记录的所有消息前退出搜索模式（搜索中的消息折叠后高亮无意义） */
    resetSearchIfActive();
    const record = records[index];
    if (!record || !record.messages) return;

    /* 更新数据状态：全部折叠 */
    record.messages.forEach(m => { m.collapsed = true; });
    if (record.reply) record.reply.collapsed = true;

    /* 更新 DOM */
    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    const recordEl = listEl ? listEl.querySelector(`.rlog-record[data-record-index="${index}"]`) : null;
    if (recordEl) {
        /* 折叠本条所有消息时打断进行中的置底闪烁（展开后不再重播） */
        clearHeaderFlash(recordEl);
        recordEl.querySelectorAll('.rmsg-item').forEach(el => {
            el.classList.add('collapsed');
            el.classList.remove('expanded');
        });
    }
    /* 折叠本条所有消息后回到顶部（最新一条） */
    if (listEl) listEl.scrollTop = 0;
    /* 折叠本条所有消息回顶：对顶部最新一条做提示闪烁 */
    flashTopHint();
}

/* 单条记录「展开所有消息」按钮 — 展开本条记录内所有角色的消息
   @param {number} index 记录索引 */
function expandRecordMessages(index) {
    const record = records[index];
    if (!record || !record.messages) return;

    /* 更新数据状态：全部展开 */
    record.messages.forEach(m => { m.collapsed = false; });
    if (record.reply) record.reply.collapsed = false;

    /* 更新 DOM */
    const recordEl = panelEl.querySelector(`.rlog-record[data-record-index="${index}"]`);
    if (recordEl) {
        recordEl.querySelectorAll('.rmsg-item').forEach(el => {
            el.classList.add('expanded');
            el.classList.remove('collapsed');
        });
        /* 为消息内容区懒创建进度条（仅视口内立即创建，其余延迟） */
        queueScrollbarsForEls(recordEl.querySelectorAll('.rmsg-content'));
    }
}

/* 单条记录「快速置底」按钮 — 滚动到本条记录最后一条子消息（有回复时为 Response，
   无回复时为最后一条普通消息），并让该子消息标题栏闪烁提示位置。
   跳转只负责定位 + 闪烁，不改变任何消息的折叠/展开状态。
   @param {number} index 记录索引 */
function scrollToRecordBottom(index) {
    if (!panelEl) return;
    const listEl = panelEl.querySelector('#rlog-list');
    const recordEl = listEl.querySelector(`.rlog-record[data-record-index="${index}"]`);
    if (!recordEl) return;

    const lastItemEl = recordEl.querySelector('.rmsg-item:last-child');
    if (!lastItemEl) return;
    const headerEl = lastItemEl.querySelector('.rmsg-header');
    if (!headerEl) return;

    /* 计算标题栏在列表内容中的逻辑位置。不直接读 sticky 标题栏的视觉坐标： */
    /* 吸顶状态下 getBoundingClientRect 返回的是吸附后的位置而非自然位置。 */
    /* item 不是 sticky，用它的矩形 + 标题栏相对 item 的 offsetTop 推算。 */
    const listRect = listEl.getBoundingClientRect();
    const itemRect = lastItemEl.getBoundingClientRect();
    const headerTopInList = listEl.scrollTop + itemRect.top - listRect.top + headerEl.offsetTop;

    /* 目标：标题栏出现在记录标题栏（吸顶）正下方 8px 处 */
    const recordHeaderEl = recordEl.querySelector('.rlog-record-header');
    const stickyHeight = recordHeaderEl ? recordHeaderEl.getBoundingClientRect().height : 40;
    const targetScroll = Math.max(0, headerTopInList - stickyHeight - 8);

    /* clamp 到合法滚动范围（避免浏览器静默 clamp 导致意外跳变） */
    const maxListScroll = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
    const clampedListScroll = Math.max(0, Math.min(targetScroll, maxListScroll));

    /* 仅在需要调整时滚动（目标已可见时保持不动，闪烁照常触发） */
    if (Math.abs(clampedListScroll - listEl.scrollTop) > 1) {
        /* 平滑滚动需要时间，闪烁等滚动到位后再触发（scrollend + 兜底定时器）， */
        /* 避免「按钮刚点完动画已结束」：条目多/展开状态下跳转距离长时尤其明显 */
        cancelPendingFlash();
        pendingFlashHeader = headerEl;
        listEl.scrollTo({ top: clampedListScroll, behavior: 'smooth' });
        let settled = false;
        const onScrollEnd = () => {
            if (settled) return;
            settled = true;
            listEl.removeEventListener('scrollend', onScrollEnd);
            triggerDeferredFlash();
        };
        listEl.addEventListener('scrollend', onScrollEnd);
        pendingFlashTimer = setTimeout(onScrollEnd, SCROLLEND_FALLBACK_MS);
    } else {
        triggerHeaderFlash(headerEl);
    }
}

/* 触发等待中的置底闪烁（滚动到位后调用）。
   目标标题栏已被重建/移除时静默跳过（不闪），并清理兜底定时器。 */
function triggerDeferredFlash() {
    if (pendingFlashTimer !== null) {
        clearTimeout(pendingFlashTimer);
        pendingFlashTimer = null;
    }
    const header = pendingFlashHeader;
    pendingFlashHeader = null;
    if (header && header.isConnected) {
        triggerHeaderFlash(header);
    }
}

/* 取消尚未触发的置底闪烁（连续点击、折叠/关闭面板等场景）。 */
function cancelPendingFlash() {
    if (pendingFlashTimer !== null) {
        clearTimeout(pendingFlashTimer);
        pendingFlashTimer = null;
    }
    pendingFlashHeader = null;
}

/* 清除指定范围内的标题栏闪烁类，并取消该范围内待触发的闪烁。
   折叠记录/消息时调用：动画直接打断结束，展开后不会重播。
   @param {HTMLElement} scopeEl 作用范围（记录、消息项或整个列表） */
function clearHeaderFlash(scopeEl) {
    if (!scopeEl) return;
    let cleared = false;
    scopeEl.querySelectorAll('.rmsg-header.rlog-flash-bottom, .rlog-record-header.rlog-flash-bottom').forEach(el => {
        el.classList.remove('rlog-flash-bottom');
        cleared = true;
    });
    /* 主动打断（折叠/关面板）后清空回顶时间戳：回复重渲染不再补闪，打断优先； */
    /* 未打断任何闪烁时保留时间戳，正常补闪路径不受影响 */
    if (cleared) lastTopHintFlashAt = 0;
    if (pendingFlashHeader && scopeEl.contains(pendingFlashHeader)) {
        cancelPendingFlash();
    }
}

/* 无按钮回顶时的提示闪烁：列表回到顶部后，对顶部（最新一条）记录做一次
   与置底相同的轻微闪烁，提示「当前已回到最新一条」。
   顶部记录展开时闪第一条子消息标题栏（与置底镜像），折叠/不可见时闪记录标题栏
   （保证目标始终可见）。界面未打开（后台记录状态）或窗口折叠时不触发。 */
function flashTopHint() {
    if (!panelEl || !isPanelVisible || isPanelCollapsed) return;
    const listEl = panelEl.querySelector('#rlog-list');
    const firstRecord = listEl ? listEl.querySelector('.rlog-record') : null;
    if (!firstRecord) return;
    let target = firstRecord.querySelector('.rmsg-header');
    if (!target || !target.offsetParent) {
        target = firstRecord.querySelector('.rlog-record-header');
    }
    if (target) {
        triggerHeaderFlash(target);
        lastTopHintFlashAt = Date.now();
    }
}

/* 触发子消息标题栏的底色闪烁（跳转后提示「最后一条在这里」）。
   先移除类 + 强制回流再添加，保证连续点击可以重播动画；
   每个标题栏只挂一次 animationend 监听（按动画名过滤），动画结束后自动移除类。
   @param {HTMLElement} headerEl 目标 .rmsg-header 元素 */
function triggerHeaderFlash(headerEl) {
    if (!headerEl) return;
    headerEl.classList.remove('rlog-flash-bottom');
    void headerEl.offsetWidth; /* 强制回流，确保重复点击可重播动画 */
    headerEl.classList.add('rlog-flash-bottom');
    if (!headerEl.dataset.rlogFlashBound) {
        headerEl.dataset.rlogFlashBound = '1';
        headerEl.addEventListener('animationend', function onFlashEnd(e) {
            /* 亮/暗主题使用不同动画名（rlog-flash-bottom / rlog-flash-bottom-dark），按前缀匹配 */
            if (e.animationName.startsWith('rlog-flash-bottom')) {
                this.classList.remove('rlog-flash-bottom');
            }
        });
    }
}

/* ── 记录删除与复制 ──────────────────────── */

/* 单条记录「删除」按钮 — 从列表中移除本条记录
   @param {number} index 记录索引 */

function deleteRecord(index) {
    if (index < 0 || index >= records.length) return;
    const record = records[index];
    /* 删除记录时同步取消该请求的在途回复追踪 */
    if (record && record.id != null) abortPendingReply(record.id);
    records.splice(index, 1);
    panelContentDirty = true;
    if (panelEl && isPanelVisible) {
        renderPanelContent();
    }
}

async function copyFullRecord(index, btnEl) {
    const record = records[index];
    if (!record) return;
    const text = getFullPromptText(record);
    await doCopy(text, btnEl);
}

async function copySingleMessage(recIdx, msgIdx, btnEl) {
    const msg = getMessageByIndex(records[recIdx], msgIdx);
    if (!msg) return;
    await doCopy(msg.content, btnEl);
}

async function doCopy(text, btnEl) {
    try {
        await navigator.clipboard.writeText(text);
        showCopyFeedback(btnEl, true);
    } catch {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            showCopyFeedback(btnEl, true);
        } catch (e) {
            console.error(`[${PLUGIN_KEY}] 复制失败:`, e);
            showCopyFeedback(btnEl, false);
        }
        document.body.removeChild(textarea);
    }
}

function showCopyFeedback(btnEl, success) {
    const originalHtml = btnEl.innerHTML;
    if (success) {
        btnEl.innerHTML = '<i class="fa-solid fa-check"></i>';
        btnEl.classList.add('copy-success');
    } else {
        btnEl.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        btnEl.classList.add('copy-fail');
    }
    setTimeout(() => {
        btnEl.innerHTML = originalHtml;
        btnEl.classList.remove('copy-success', 'copy-fail');
    }, 1500);
}

/* ── 查看全文覆盖层 ──────────────────────── */

/* 获取覆盖层内容区的文本内容
   @param {object} record 记录对象
   @param {string} format 格式：'formatted' 或 'raw'
   @returns {string} 文本内容 */
function getReadContent(record, format) {
    if (format === 'raw') {
        if (!record.rawBody) {
            return '{"error": "原始请求体数据不可用"}';
        }
        try {
            return JSON.stringify(record.rawBody, null, 2);
        } catch (e) {
            return '{"error": "原始请求体数据不可用"}';
        }
    }
    return getFullPromptText(record);
}

/* 切换覆盖层显示格式并刷新内容区
   @param {string} format 'formatted' 或 'raw' */
function switchReadFormat(format) {
    if (!readFullOverlayEl) return;
    readFullFormat = format;
    const record = records[readFullRecordIndex];
    if (!record) return;

    const contentEl = readFullOverlayEl.querySelector('.rlog-read-content');
    if (contentEl) {
        contentEl.textContent = getReadContent(record, format);
        contentEl.scrollTop = 0; /* 切换格式时回到顶部 */
    }

    /* 更新 toggle 状态 */
    const toggleEl = readFullOverlayEl.querySelector('.rlog-read-format-toggle');
    if (toggleEl) {
        if (format === 'raw') {
            toggleEl.classList.add('raw');
            toggleEl.classList.remove('formatted');
        } else {
            toggleEl.classList.remove('raw');
            toggleEl.classList.add('formatted');
        }
    }
}

/* 「查看全文」覆盖层回顶/置底：直接滚动内容区到顶部/底部。
   覆盖层是连续长文本（无具体条目），只做功能滚动、不做闪烁动画。
   @param {'top'|'bottom'} position 滚动目标：'top' 顶部 / 'bottom' 底部 */
function scrollReadContentTo(position) {
    if (!readFullOverlayEl) return;
    const contentEl = readFullOverlayEl.querySelector('.rlog-read-content');
    if (!contentEl) return;
    /* 平滑滚动到顶部/底部；置底目标赋 scrollHeight，浏览器会自动 clamp 到最大可滚动位置 */
    contentEl.scrollTo({
        top: position === 'bottom' ? contentEl.scrollHeight : 0,
        behavior: 'smooth',
    });
}

/* 关闭「查看全文」覆盖层并从 DOM 中移除 */
function closeReadFullOverlay() {
    if (readFullOverlayEl) {
        /* 清理覆盖层内容区的自定义滚动条，避免残留 */
        const readContentEl = readFullOverlayEl.querySelector('.rlog-read-content');
        if (readContentEl) {
            detachScrollbarForContent(readContentEl);
        }
        readFullOverlayEl.remove();
        readFullOverlayEl = null;
    }
    readFullRecordIndex = null;
    /* 解绑 Escape 键监听 */
    document.removeEventListener('keydown', handleReadFullEscape);
}

/* Escape 键关闭覆盖层的处理器
   @param {KeyboardEvent} e 键盘事件 */
function handleReadFullEscape(e) {
    if (e.key === 'Escape' && readFullOverlayEl) {
        closeReadFullOverlay();
    }
}

/* 打开「查看全文」覆盖层，展示指定记录的完整提示词
   覆盖层挂载到 #rlog-panel 内部，完整遮挡面板（含主标题栏）。
   @param {number} index 记录索引 */
function openReadFullOverlay(index) {
    /* 先退出搜索模式（覆盖层打开期间搜索不可见不可操作） */
    resetSearchIfActive();

    const record = records[index];
    if (!record || !panelEl) return;

    /* 懒创建：关闭旧的覆盖层（如有） */
    closeReadFullOverlay();

    readFullRecordIndex = index;
    readFullFormat = 'formatted';

    /* 创建覆盖层 */
    const overlay = document.createElement('div');
    overlay.className = 'rlog-read-overlay';

    overlay.innerHTML = `
        <div class="rlog-read-header">
            <span class="rlog-read-title">查看全文</span>
            <div class="rlog-read-header-actions">
                <div class="rlog-read-format-toggle formatted" title="切换显示格式">
                    <span class="rlog-read-seg-slider"></span>
                    <span class="rlog-read-seg-option rlog-read-seg-formatted">整理</span>
                    <span class="rlog-read-seg-option rlog-read-seg-raw">JSON</span>
                </div>
                <button class="rlog-read-jump-top-btn" title="回顶">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="4" x2="19" y2="4"></line><line x1="12" y1="9" x2="12" y2="20"></line><polyline points="7 14 12 9 17 14"></polyline></svg>
                </button>
                <button class="rlog-read-jump-bottom-btn" title="置底">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="4" x2="12" y2="15"></line><line x1="5" y1="20" x2="19" y2="20"></line></svg>
                </button>
                <button class="rlog-read-copy-btn" title="复制当前内容">
                    <i class="fa-solid fa-copy"></i>
                </button>
                <button class="rlog-read-close-btn" title="关闭 (Esc)">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        </div>
        <div class="rlog-read-content"></div>
        <div class="rlog-read-footer"></div>
    `;

    /* 内容使用 textContent 设置纯文本，避免 innerHTML 解析开销 */
    const contentEl = overlay.querySelector('.rlog-read-content');
    contentEl.textContent = getReadContent(record, 'formatted');

    /* 绑定标题栏事件 */
    const toggleEl = overlay.querySelector('.rlog-read-format-toggle');
    toggleEl.addEventListener('click', (e) => {
        e.stopPropagation();
        /* 切换格式：当前 formatted → raw；raw → formatted */
        switchReadFormat(readFullFormat === 'formatted' ? 'raw' : 'formatted');
    });

    const jumpTopBtn = overlay.querySelector('.rlog-read-jump-top-btn');
    jumpTopBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        scrollReadContentTo('top');
    });

    const jumpBottomBtn = overlay.querySelector('.rlog-read-jump-bottom-btn');
    jumpBottomBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        scrollReadContentTo('bottom');
    });

    const copyBtn = overlay.querySelector('.rlog-read-copy-btn');
    copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const text = getReadContent(record, readFullFormat);
        await doCopy(text, copyBtn);
    });

    const closeBtn = overlay.querySelector('.rlog-read-close-btn');
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeReadFullOverlay();
    });

    /* 挂载到面板内部，覆盖整个面板 */
    panelEl.appendChild(overlay);
    readFullOverlayEl = overlay;

    /* 为覆盖层内容区创建自定义滚动条（复用 Overlay 进度条样式与交互） */
    const readContentElForScroll = overlay.querySelector('.rlog-read-content');
    if (readContentElForScroll) {
        queueScrollbarsForEls([readContentElForScroll]);
    }

    /* 绑定 Escape 键关闭 */
    document.addEventListener('keydown', handleReadFullEscape);
}

/* ── 自定义滚动条 ───────────────────────── */

/* 存储每个 .rmsg-content 对应的进度条清理数据
   Map key: contentEl -> { scrollHandler, hitboxEl, thumbEl } */
const scrollbarCleanups = new Map();

/* Set<HTMLElement>: 所有已创建进度条的 .rmsg-content 元素（供共享 ResizeObserver 批量更新） */
const scrollbarElements = new Set();

/* Set<HTMLElement>: 等待进入视口后懒创建进度条的 .rmsg-content 元素 */
const pendingScrollbarContentEls = new Set();

/* ResizeObserver|null: 共享 ResizeObserver：所有进度条共用一个，替代每元素一个 */
let sharedResizeObserver = null;

/* Set<HTMLElement>: 已监听高度变化的记录标题栏（--rlog-rec-h 吸顶偏移随高度自动刷新） */
const observedRecordHeaders = new Set();

/* IntersectionObserver|null: 懒创建进度条的 IntersectionObserver */
let scrollbarLazyObserver = null;

/* boolean: 是否已有 RAF 排队更新 thumb */
let thumbUpdateQueued = false;

/* boolean: 是否等待全量更新所有进度条（ResizeObserver 触发） */
let thumbFullUpdatePending = false;

/* HTMLElement|null: 单个需要更新 thumb 的 contentEl（scroll 事件触发） */
let thumbPendingElement = null;

/* 确保共享 ResizeObserver 已创建
   所有进度条统一由它监听，回调中批量更新 thumb，避免 100+ 个独立 ResizeObserver 的额外开销 */
function ensureSharedResizeObserver() {
    if (sharedResizeObserver) return;
    sharedResizeObserver = new ResizeObserver((entries) => {
        /* 记录标题栏高度变化（换行/字体/视口变化）→ 实时刷新吸顶偏移 */
        for (const entry of entries) {
            const headerEl = entry.target;
            if (headerEl && headerEl.classList && headerEl.classList.contains('rlog-record-header')) {
                const recordEl = headerEl.closest('.rlog-record');
                if (recordEl) {
                    recordEl.style.setProperty('--rlog-rec-h', `${headerEl.getBoundingClientRect().height.toFixed(2)}px`);
                }
            }
        }
        /* 任一内容区尺寸变化：全量更新所有进度条的 thumb */
        /* 回调本身由浏览器在布局后批量触发，这里再合并到同一 RAF 帧 */
        requestThumbUpdate();
    });
}

/* 确保懒创建 IntersectionObserver 已创建
   进度条只在内容区进入视口（或接近视口）时才创建，
   避免展开 100+ 消息时瞬间创建 100+ 进度条导致的同步 layout 卡顿。
   rootMargin 200px：提前创建，保证滚动到之前进度条已就绪。 */
function ensureScrollbarLazyObserver() {
    if (scrollbarLazyObserver) return;
    scrollbarLazyObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const contentEl = entry.target;
                pendingScrollbarContentEls.delete(contentEl);
                scrollbarLazyObserver.unobserve(contentEl);
                createScrollbarForContent(contentEl);
            }
        });
    }, { root: null, rootMargin: '200px 0px', threshold: 0 });
}

/* 请求更新进度条 thumb 位置（RAF 批处理）
   - 不传参：全量更新所有活跃进度条（ResizeObserver 触发）
   - 传 contentEl：只更新该元素对应的进度条（scroll 事件触发）
   同一帧内多次请求合并为一次更新，避免高频事件触发连续强制 layout。
   @param {HTMLElement} [contentEl] 需要更新的内容区元素；不传则全量更新 */
function requestThumbUpdate(contentEl) {
    if (contentEl) {
        thumbPendingElement = contentEl;
    } else {
        thumbFullUpdatePending = true;
    }
    if (thumbUpdateQueued) return;
    thumbUpdateQueued = true;
    requestAnimationFrame(() => {
        thumbUpdateQueued = false;
        if (thumbFullUpdatePending) {
            thumbFullUpdatePending = false;
            thumbPendingElement = null;
            scrollbarElements.forEach((el) => {
                const cleanup = scrollbarCleanups.get(el);
                if (cleanup) updateScrollbarThumb(el, cleanup);
            });
        } else if (thumbPendingElement) {
            const el = thumbPendingElement;
            thumbPendingElement = null;
            const cleanup = scrollbarCleanups.get(el);
            if (cleanup) updateScrollbarThumb(el, cleanup);
        }
    });
}

/* 根据 contentEl 当前滚动状态更新其进度条 thumb 位置
   @param {HTMLElement} contentEl 内容区元素
   @param {object} cleanup 该进度条的清理数据（含 hitboxEl/thumbEl） */
function updateScrollbarThumb(contentEl, cleanup) {
    const hitbox = cleanup.hitboxEl;
    const thumb = cleanup.thumbEl;
    if (!hitbox || !thumb) return;

    const scrollHeight = contentEl.scrollHeight;
    const clientHeight = contentEl.clientHeight;
    const scrollTop = contentEl.scrollTop;
    const maxScroll = scrollHeight - clientHeight;

    if (maxScroll <= 0) {
        hitbox.style.display = 'none';
        return;
    }
    hitbox.style.display = '';

    /* hitbox 对齐 contentEl 的位置（因为挂载在 .rmsg-item 上而非 contentEl 内部） */
    const contentTop = contentEl.offsetTop;
    hitbox.style.top = contentTop + 'px';
    hitbox.style.height = clientHeight + 'px';

    /* 轨道可用高度（track 的 top:4px, bottom:4px） */
    const trackHeight = clientHeight - 8;

    /* 滑块高度 = 可见比例 × 轨道高度，最小 20px */
    const thumbRatio = clientHeight / scrollHeight;
    const thumbHeight = Math.max(20, thumbRatio * trackHeight);
    thumb.style.height = thumbHeight + 'px';

    /* 滑块可移动范围 */
    const thumbRange = trackHeight - thumbHeight;

    /* 滑块位置 = 当前滚动比例 × 可移动范围 */
    const thumbTop = maxScroll > 0 ? (scrollTop / maxScroll) * thumbRange : 0;
    thumb.style.top = thumbTop.toFixed(1) + 'px';
}

/* 为一批 .rmsg-content 元素按需（懒加载）创建进度条
   元素进入视口或接近视口时才真正创建进度条。
   已在观察队列中或有进度条的元素自动跳过。
   @param {NodeListOf<HTMLElement>|HTMLElement[]|Array} contentEls 内容区元素集合 */
function queueScrollbarsForEls(contentEls) {
    ensureScrollbarLazyObserver();
    /* 支持 .rmsg-content（消息内容区）与 .rlog-read-content（查看全文覆盖层内容区） */
    const SCROLLABLE_CONTENT_CLASSES = ['rmsg-content', 'rlog-read-content'];
    contentEls.forEach((contentEl) => {
        if (!contentEl || !contentEl.classList) return;
        if (!SCROLLABLE_CONTENT_CLASSES.some(c => contentEl.classList.contains(c))) return;
        if (pendingScrollbarContentEls.has(contentEl)) return;
        if (scrollbarCleanups.has(contentEl)) return;
        pendingScrollbarContentEls.add(contentEl);
        scrollbarLazyObserver.observe(contentEl);
    });
}

/* 为单个 .rmsg-content 元素创建 overlay 进度条
   @param {HTMLElement} contentEl .rmsg-content 元素 */
function createScrollbarForContent(contentEl) {
    /* 先清理已有进度条（避免重复创建） */
    detachScrollbarForContent(contentEl);

    /* 内容不需要滚动时不需要进度条 */
    /* 注意：这里读取 scrollHeight 布局值不可避免，但仅在进入视口时才执行（懒创建 + 单个元素） */
    if (contentEl.scrollHeight <= contentEl.clientHeight) return;

    /* 挂载目标二选一（在 contentEl 的父容器上，而不是 contentEl 内部）： */
    /* - .rmsg-content → 挂载到 .rmsg-item（旧路径，行为完全不变） */
    /* - .rlog-read-content → 挂载到 .rlog-read-overlay（新路径） */
    /* 这样 hitbox 使用 position: absolute 定位时不会随 contentEl 滚动而移出视口 */
    const container = contentEl.parentElement;
    if (!container) return;

    const isRmsgItem = container.classList.contains('rmsg-item');
    const isReadOverlay = container.classList.contains('rlog-read-overlay');
    if (!isRmsgItem && !isReadOverlay) return;

    /* 确保容器有 position: relative 作为定位参考 */
    /* 对 .rmsg-item 保持旧行为；对 .rlog-read-overlay 为兜底（其本身是 absolute） */
    const currentPosition = getComputedStyle(container).position;
    if (currentPosition === 'static') {
        container.style.position = 'relative';
    }

    /* --- 创建 DOM 结构 --- */
    const hitbox = document.createElement('div');
    hitbox.className = 'rlog-scroll-hitbox';

    const track = document.createElement('div');
    track.className = 'rlog-scroll-track';

    const thumb = document.createElement('div');
    thumb.className = 'rlog-scroll-thumb';

    const dot = document.createElement('div');
    dot.className = 'rlog-scroll-dot';

    /* dot 作为 hitbox 的直接子元素（与 track 平级），避免被 track 的 overflow:hidden 裁剪 */
    track.appendChild(thumb);
    hitbox.appendChild(track);
    hitbox.appendChild(dot);
    container.appendChild(hitbox);

    /* 记录到活跃元素集合（供共享 ResizeObserver 批量更新） */
    scrollbarElements.add(contentEl);

    /* 创建清理数据（scrollbarCleanups 注册后即可被 requestThumbUpdate 使用） */
    const cleanup = {
        scrollHandler: null,
        hitboxEl: hitbox,
        thumbEl: thumb,
    };

    /* 初始更新：合并到 RAF 批处理（当前帧剩余 layout 在下一帧统一完成） */
    /* 注意：需要先注册 cleanup 才能被 updateScrollbarThumb 找到 */
    scrollbarCleanups.set(contentEl, cleanup);
    requestThumbUpdate(contentEl);

    /* 监听滚动事件（RAF 批处理，避免高频滚动触发连续强制 layout） */
    const onScroll = () => requestThumbUpdate(contentEl);
    cleanup.scrollHandler = onScroll;
    contentEl.addEventListener('scroll', onScroll, { passive: true });

    /* 确保共享 ResizeObserver 已注册覆盖此元素 */
    ensureSharedResizeObserver();
    if (sharedResizeObserver) {
        try {
            sharedResizeObserver.observe(contentEl);
        } catch (e) { /* ignore */ }
    }

    /* --- 交互：pointer 事件 --- */
    /* 圆点跟随手指位置（不跟随 thumb），可到达轨道两端 */
    /* boolean: 是否正在拖拽 */
    let dragging = false;
    /* number|null: 当前 pointerId（用于 pointer capture） */
    let capturedPointerId = null;

    /* 根据 clientY 计算圆点在 hitbox 内的 top 值（限制在轨道范围内）
       @param {number} clientY 指针的页面 Y 坐标
       @returns {number} dot 的 style.top 值（相对于 hitbox） */
    function clientYToDotTop(clientY) {
        const hitboxRect = hitbox.getBoundingClientRect();
        /* 手指相对 hitbox 顶部的 Y 偏移（dot 是 hitbox 子元素，style.top 相对于 hitbox） */
        let relativeY = clientY - hitboxRect.top;

        /* 【可调参数】TRACK_PADDING — 轨道距 hitbox 边缘的间距 */
        /* 必须与 CSS 中 .rlog-scroll-track 的 top/bottom 值保持一致 */
        const TRACK_PADDING = 4;          /* CSS: .rlog-scroll-track { top: 4px; bottom: 4px; } */
        const trackTop = TRACK_PADDING;
        const trackBottom = hitboxRect.height - TRACK_PADDING;
        relativeY = Math.max(trackTop, Math.min(trackBottom, relativeY));

        /* 【可调参数】DOT_HALF — 圆点高度的一半 */
        /* 必须与 CSS 中 .rlog-scroll-dot 的 height 值保持一致 (height/2) */
        const DOT_HALF = 2.5;               /* CSS: .rlog-scroll-dot { height: 6px; } → 6/2=3 */
        return (relativeY - DOT_HALF) + 'px';
    }

    /* 根据圆点位置反推内容滚动位置
       @param {number} clientY 指针的页面 Y 坐标
       @returns {number} 对应的 scrollTop 值 */
    function dotPositionToScroll(clientY) {
        const hitboxRect = hitbox.getBoundingClientRect();
        const clientHeight = contentEl.clientHeight;
        const maxScroll = contentEl.scrollHeight - clientHeight;
        if (maxScroll <= 0) return 0;

        let relativeY = clientY - hitboxRect.top;
        const trackHeight = clientHeight - 8;
        const trackTop = 4;
        const trackBottom = trackTop + trackHeight;
        relativeY = Math.max(trackTop, Math.min(trackBottom, relativeY));

        /* 圆点在轨道中的比例（0~1） */
        const ratio = (relativeY - trackTop) / trackHeight;
        return Math.round(ratio * maxScroll);
    }

    function onPointerDown(e) {
        /* 只处理主按钮（鼠标左键或触摸） */
        if (e.button !== undefined && e.button !== 0) return;

        dragging = true;
        capturedPointerId = e.pointerId;
        hitbox.setPointerCapture(e.pointerId);
        hitbox.classList.add('active');

        /* 立即将圆点定位到按下位置，并滚动到对应位置 */
        dot.style.top = clientYToDotTop(e.clientY);
        contentEl.scrollTop = dotPositionToScroll(e.clientY);
        e.preventDefault();
    }

    function onPointerMove(e) {
        if (!dragging) return;

        const maxScroll = contentEl.scrollHeight - contentEl.clientHeight;
        if (maxScroll <= 0) return;

        /* 圆点跟随手指 */
        dot.style.top = clientYToDotTop(e.clientY);
        /* 内容滚动跟随圆点 */
        contentEl.scrollTop = dotPositionToScroll(e.clientY);

        e.preventDefault();
    }

    function onPointerUp(e) {
        if (!dragging) return;
        dragging = false;
        hitbox.classList.remove('active');
        if (capturedPointerId !== null) {
            try { hitbox.releasePointerCapture(capturedPointerId); } catch (err) { /* ignore */ }
            capturedPointerId = null;
        }
    }

    hitbox.addEventListener('pointerdown', onPointerDown);
    hitbox.addEventListener('pointermove', onPointerMove);
    hitbox.addEventListener('pointerup', onPointerUp);
    hitbox.addEventListener('pointercancel', onPointerUp);
    /* lostpointercapture 作为兜底清理 */
    hitbox.addEventListener('lostpointercapture', onPointerUp);

}

/* 移除单个 .rmsg-content 的 overlay 进度条并清理资源
   @param {HTMLElement} contentEl .rmsg-content 元素 */
function detachScrollbarForContent(contentEl) {
    const cleanup = scrollbarCleanups.get(contentEl);
    if (!cleanup) return;

    /* 移除 scroll 事件监听 */
    contentEl.removeEventListener('scroll', cleanup.scrollHandler);
    /* 若该元素被共享 ResizeObserver 监听，解除监听 */
    if (sharedResizeObserver) {
        try { sharedResizeObserver.unobserve(contentEl); } catch (e) { /* ignore */ }
    }
    /* 从活跃集合与懒观察集合中移除 */
    scrollbarElements.delete(contentEl);
    pendingScrollbarContentEls.delete(contentEl);
    if (scrollbarLazyObserver) {
        try { scrollbarLazyObserver.unobserve(contentEl); } catch (e) { /* ignore */ }
    }
    /* 从 DOM 中移除 hitbox */
    if (cleanup.hitboxEl && cleanup.hitboxEl.parentNode) {
        cleanup.hitboxEl.remove();
    }
    scrollbarCleanups.delete(contentEl);
}

/* 为列表中的所有 .rmsg-content 创建 overlay 进度条
   用于 renderPanelContent 后挂载，也用于展开/折叠后刷新
   改为懒创建：所有 .rmsg-content 进入视口（或接近视口）时才创建进度条，
   避免展开/重新渲染大量消息时一次性创建大量进度条导致的卡顿。
   @param {HTMLElement} listEl 列表容器元素 */
function attachScrollIndicators(listEl) {
    /* 清理所有已有进度条（因为 renderPanelContent 使用 innerHTML 重建了 DOM） */
    scrollbarCleanups.forEach((_, contentEl) => {
        detachScrollbarForContent(contentEl);
    });

    /* 所有 .rmsg-content 进入懒创建观察队列（IntersectionObserver 自动按视口按需创建） */
    queueScrollbarsForEls(listEl.querySelectorAll('.rmsg-content'));
}

/* ── 面板控制 ─────────────────────────── */

function togglePanelWindow() {
    isPanelCollapsed = !isPanelCollapsed;
    if (isPanelCollapsed) {
        const rect = panelEl.getBoundingClientRect();
        panelEl.dataset.rlogSavedWidth = rect.width;
        panelEl.dataset.rlogSavedHeight = rect.height;
        panelEl.classList.add('rlog-window-collapsed');
        panelEl.style.width = rect.width + 'px';
        panelEl.style.height = 'auto';
        panelEl.style.minHeight = '0';
        panelEl.style.maxHeight = 'none';
    } else {
        const savedW = panelEl.dataset.rlogSavedWidth;
        if (savedW) panelEl.style.width = savedW + 'px';
        /* 恢复时使用 auto 高度，让内容驱动窗口高度（受 CSS min-height / max-height 约束）， */
        /* 否则固定像素高度会阻止记录增多时的窗口自动扩展 */
        panelEl.style.height = 'auto';
        panelEl.style.minHeight = '';
        panelEl.style.maxHeight = '80vh';
        delete panelEl.dataset.rlogSavedWidth;
        delete panelEl.dataset.rlogSavedHeight;
        panelEl.classList.remove('rlog-window-collapsed');
        /* 窗口重新展开后重测记录标题栏高度（隐藏期间 offsetHeight 为 0，吸顶偏移需刷新） */
        syncRecordHeaderVars(panelEl.querySelector('#rlog-list'));
        /* 折叠期间有新记录到达时，恢复展开后回到列表顶部最新一条 */
        /* （DOM 在隐藏状态下重建，浏览器重新显示时会恢复旧滚动位置，必须显式回顶） */
        if (pendingScrollToTop) {
            pendingScrollToTop = false;
            const listEl = panelEl.querySelector('#rlog-list');
            if (listEl) listEl.scrollTop = 0;
            /* 窗口折叠期间来新消息，展开回顶后提示最新一条位置 */
            flashTopHint();
        }
    }
}

function addMenuEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        setTimeout(addMenuEntry, 300);
        return;
    }

    toggleBtn = document.createElement('div');
    toggleBtn.id = 'prompt-capture-toggle';
    toggleBtn.className = 'list-group-item';
    toggleBtn.innerHTML = '<i class="fa-solid fa-book"></i> 最近请求记录';
    toggleBtn.addEventListener('click', togglePanel);
    menu.appendChild(toggleBtn);

    /* 延迟重新 append，确保在所有同步初始化的插件之后排在末尾 */
    /* appendChild 对已存在的节点会将其移动到容器末尾 */
    setTimeout(() => {
        if (toggleBtn && toggleBtn.parentNode) {
            toggleBtn.parentNode.appendChild(toggleBtn);
        }
    }, MENU_REORDER_DELAY_MS);
}

/* 收起「更多」抽屉（供互斥、点击外部、引导使用） */
function closeMoreDrawer() {
    if (!panelEl) return;
    const drawer = panelEl.querySelector('#rlog-more-drawer');
    const btn = panelEl.querySelector('#rlog-more-btn');
    if (drawer) drawer.classList.remove('expanded');
    if (btn) btn.classList.remove('active-drawer-btn');
}

/* 收起「筛选」抽屉（供互斥、点击外部、引导使用） */
function closeFilterDrawer() {
    if (!panelEl) return;
    const drawer = panelEl.querySelector('#rlog-filter-drawer');
    const btn = panelEl.querySelector('#rlog-filter-btn');
    if (drawer) drawer.classList.remove('expanded');
    if (btn) btn.classList.remove('active-drawer-btn');
}

/* 切换抽屉时用：旧抽屉瞬时收起（跳过收起动画）。
   原因：两个抽屉宽度叠加会先把整行撑宽再回落（左右弹跳）；切换时让旧抽屉直接消失、
   新抽屉照常展开，就不会出现两者同时接近满宽的重叠。
   做法：临时禁用过渡 → 移除展开类 → 强制回流提交瞬时收起 → 恢复过渡（与 tour.js 抽屉步骤同款写法）。 */
function closeDrawerInstant(drawer, btn) {
    if (!drawer) return;
    drawer.style.transition = 'none';
    drawer.classList.remove('expanded');
    if (btn) btn.classList.remove('active-drawer-btn');
    void drawer.offsetWidth; /* 强制回流：提交瞬时收起，恢复过渡后不会补播动画 */
    drawer.style.transition = '';
}

function buildUI() {
    if (uiBuilt) return;
    uiBuilt = true;

    addMenuEntry();

    /* 加载持久化设置 */
    isLightTheme = loadTheme();
    MAX_RECORDS = loadMaxRecords();
    try {
        masterEnabled = localStorage.getItem(STORAGE_MASTER_KEY) !== '0';
    } catch (e) {
        masterEnabled = true;
    }

    panelEl = document.createElement('div');
    panelEl.id = 'rlog-panel';
    panelEl.style.display = 'none';

    applyTheme();

    panelEl.innerHTML = `
        <div class="rlog-panel-header">
            <h4>
                <span class="rlog-title-text" title="单击折叠/展开">最近请求记录</span>
                <span class="rlog-title-count" title="双击修改记录上限">${getHeaderCountText()}</span>
                <span class="rlog-filter-indicator" id="rlog-filter-indicator" hidden>
                    <span id="rlog-filter-indicator-text"></span>
                    <button id="rlog-filter-reset-btn" title="重置筛选" aria-label="重置筛选"><i class="fa-solid fa-rotate-left"></i></button>
                </span>
            </h4>
            <div class="rlog-header-drag-space" style="flex: 1; height: 28px; cursor: move; margin: 0 10px;"></div>
            <div class="rlog-header-actions">
                <div class="rlog-more-drawer" id="rlog-more-drawer">
                    <div class="rlog-preview-segmented" id="rlog-preview-toggle" title="内容预览开关">
                        <span class="rlog-seg-slider"></span>
                        <span class="rlog-seg-option rlog-seg-off">隐藏</span>
                        <span class="rlog-seg-option rlog-seg-on">预览</span>
                    </div>
                    <button id="rlog-master-toggle" class="rlog-header-btn rlog-master-on" title="总开关：已启用 — 点击关闭">
                        <i class="fa-solid fa-power-off"></i>
                    </button>
                    <button id="rlog-help-btn" class="rlog-header-btn" title="查看使用引导">
                        <i class="fa-solid fa-question"></i>
                    </button>
                    <button id="rlog-clear-btn" class="rlog-header-btn" title="清空所有记录">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                    <button id="rlog-theme-btn" class="rlog-header-btn" title="切换昼/夜模式">
                        <i class="fa-solid fa-sun"></i>
                    </button>
                </div>
                <div class="rlog-filter-drawer" id="rlog-filter-drawer">
                    <span class="rlog-filter-group">
                        <button class="rlog-filter-chip rlog-filter-chip-on" data-filter-group="source" data-filter-value="native" title="原生请求"><i class="fa-solid fa-paper-plane"></i></button>
                        <button class="rlog-filter-chip rlog-filter-chip-on" data-filter-group="source" data-filter-value="plugin" title="插件/非原生请求"><i class="fa-solid fa-puzzle-piece"></i></button>
                    </span>
                    <span class="rlog-filter-group">
                        <button class="rlog-filter-chip rlog-filter-chip-on rlog-filter-chip-model" data-filter-group="model" data-filter-value="gemini" title="Gemini">${FILTER_MODEL_SVG.gemini_full}</button>
                        <button class="rlog-filter-chip rlog-filter-chip-on rlog-filter-chip-model" data-filter-group="model" data-filter-value="claude" title="Claude"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${FILTER_MODEL_SVG.claude}"/></svg></button>
                        <button class="rlog-filter-chip rlog-filter-chip-on rlog-filter-chip-model" data-filter-group="model" data-filter-value="deepseek" title="DeepSeek"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${FILTER_MODEL_SVG.deepseek}"/></svg></button>
                        <button class="rlog-filter-chip rlog-filter-chip-on" data-filter-group="model" data-filter-value="other" title="其他"><i class="fa-solid fa-list"></i></button>
                    </span>
                    <span class="rlog-filter-group">
                        <button class="rlog-filter-chip rlog-filter-chip-on" data-filter-group="role" data-filter-value="system" title="System"><i class="fa-solid fa-gear"></i></button>
                        <button class="rlog-filter-chip rlog-filter-chip-on" data-filter-group="role" data-filter-value="assistant" title="Assistant"><i class="fa-solid fa-comment-dots"></i></button>
                        <button class="rlog-filter-chip rlog-filter-chip-on" data-filter-group="role" data-filter-value="user" title="User"><i class="fa-solid fa-user"></i></button>
                        <button class="rlog-filter-chip rlog-filter-chip-on" data-filter-group="role" data-filter-value="other" title="其他"><i class="fa-solid fa-list"></i></button>
                    </span>
                </div>
                <button id="rlog-more-btn" class="rlog-header-btn" title="更多选项">
                    <i class="fa-solid fa-ellipsis"></i>
                </button>
                <button id="rlog-filter-btn" class="rlog-header-btn" title="筛选记录">
                    <i class="fa-solid fa-filter"></i>
                    <span class="rlog-filter-dot"></span>
                </button>
                <button id="rlog-collapse-all-btn" class="rlog-header-btn" title="折叠所有条目">
                    <i class="fa-solid fa-compress-alt"></i>
                </button>
                <button id="rlog-close-btn" class="rlog-close-btn" title="关闭面板"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </div>
        <div class="rlog-panel-body">
            <div id="rlog-list" class="rlog-list">
                <div class="rlog-empty">${escapeHtml(masterEnabled ? '暂无请求记录，请发送消息后查看。' : '记录功能已关闭，请点击电源图标开启。')}</div>
            </div>
            <div class="rlog-resize-grip" title="拖动调整窗口大小"></div>
        </div>
    `;

    panelEl.classList.remove('rlog-window-collapsed');

    document.body.appendChild(panelEl);

    /* H4 标题文字拆分：文字部分单击折叠/展开，数字部分双击设置最大记录数 */
    {
        const textEl = panelEl.querySelector('.rlog-title-text');
        const countEl = panelEl.querySelector('.rlog-title-count');
        /* number|null: 用于延迟判断双单击的定时器 ID（仅数字部分使用） */
        let countClickTimer = null;

        /* 文字部分：单击立即折叠/展开窗口（无延迟） */
        textEl.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePanelWindow();
        });

        /* 数字部分：双击弹出设置对话框（单击无反应） */
        countEl.addEventListener('click', (e) => {
            e.stopPropagation();

            if (countClickTimer) {
                /* 第二次点击 —— 判定为双击 */
                clearTimeout(countClickTimer);
                countClickTimer = null;
                showMaxRecordsDialog();
                return;
            }

            /* 第一次点击 —— 启动定时器，等待可能的第二次点击 */
            countClickTimer = setTimeout(() => {
                countClickTimer = null;
                /* 单击无反应，不做任何操作 */
            }, DOUBLE_CLICK_THRESHOLD);
        });
    }

    const moreBtn = panelEl.querySelector('#rlog-more-btn');
    const moreDrawer = panelEl.querySelector('#rlog-more-drawer');
    const filterBtn = panelEl.querySelector('#rlog-filter-btn');
    const filterDrawer = panelEl.querySelector('#rlog-filter-drawer');

    moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (filterDrawer.classList.contains('expanded')) {
            /* 切换抽屉：旧抽屉瞬时收起（跳过过渡），新抽屉正常展开，避免两抽屉宽度叠加弹跳 */
            closeDrawerInstant(filterDrawer, filterBtn);
        } else {
            closeFilterDrawer();
        }
        moreDrawer.classList.toggle('expanded');
        if (moreDrawer.classList.contains('expanded')) {
            moreBtn.classList.add('active-drawer-btn');
        } else {
            moreBtn.classList.remove('active-drawer-btn');
        }
    });

    filterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (moreDrawer.classList.contains('expanded')) {
            /* 切换抽屉：旧抽屉瞬时收起（跳过过渡），新抽屉正常展开，避免两抽屉宽度叠加弹跳 */
            closeDrawerInstant(moreDrawer, moreBtn);
        } else {
            closeMoreDrawer();
        }
        filterDrawer.classList.toggle('expanded');
        if (filterDrawer.classList.contains('expanded')) {
            filterBtn.classList.add('active-drawer-btn');
        } else {
            filterBtn.classList.remove('active-drawer-btn');
        }
    });

    /* 筛选分段按钮点击：切换对应分组的开关 */
    filterDrawer.querySelectorAll('.rlog-filter-chip').forEach((chip) => {
        chip.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFilterChip(chip.dataset.filterGroup, chip.dataset.filterValue);
        });
    });

    /* 标题旁「重置筛选」按钮 */
    const filterResetBtn = panelEl.querySelector('#rlog-filter-reset-btn');
    if (filterResetBtn) {
        filterResetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            resetFilters();
        });
    }

    /* 全局点击监听：点击外部收起任一展开的抽屉（「更多」「筛选」互斥） */
    if (!document.rlogHeaderDrawerListenerInstalled) {
        document.rlogHeaderDrawerListenerInstalled = true;
        document.addEventListener('click', (e) => {
            if (panelEl && isPanelVisible) {
                const drawerPairs = [
                    { drawer: panelEl.querySelector('#rlog-more-drawer'), btn: panelEl.querySelector('#rlog-more-btn') },
                    { drawer: panelEl.querySelector('#rlog-filter-drawer'), btn: panelEl.querySelector('#rlog-filter-btn') },
                ];
                drawerPairs.forEach(({ drawer, btn }) => {
                    if (drawer && drawer.classList.contains('expanded')
                        && !drawer.contains(e.target) && !btn.contains(e.target)) {
                        drawer.classList.remove('expanded');
                        btn.classList.remove('active-drawer-btn');
                    }
                });
            }
        });
    }

    panelEl.querySelector('#rlog-close-btn').addEventListener('click', hidePanel);

    panelEl.querySelector('#rlog-collapse-all-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        collapseAllEntries();
    });

    panelEl.querySelector('#rlog-clear-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (records.length === 0) {
            /* 没有记录时无需确认，直接提示无内容可清空 */
            return;
        }
        /* 筛选生效时在确认文案中注明被隐藏的记录也会一并清空 */
        const visibleCount = getVisibleRecords().length;
        const hiddenCount = records.length - visibleCount;
        showConfirmDialog({
            title: '清空所有记录',
            message: hiddenCount > 0
                ? `确定要清空全部 <strong>${records.length}</strong> 条请求记录吗？（其中 <strong>${hiddenCount}</strong> 条被筛选隐藏，也会一并清空）<br>此操作不可撤销。`
                : `确定要清空全部 <strong>${records.length}</strong> 条请求记录吗？<br>此操作不可撤销。`,
            confirmText: '清空',
            cancelText: '取消',
            onConfirm: () => {
                clearAllRecords();
            },
        });
    });

    panelEl.querySelector('#rlog-help-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.__RLogTour && typeof window.__RLogTour.start === 'function') {
            /* 确保面板展开并且两个抽屉都收起 */
            closeMoreDrawer();
            closeFilterDrawer();
            
            if (isPanelCollapsed) togglePanelWindow();
            
            window.__RLogTour.start();
        }
    });

    buildTempTestButton(panelEl);

    panelEl.querySelector('#rlog-theme-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        isLightTheme = !isLightTheme;
        saveTheme(isLightTheme);
        applyTheme();
        updateThemeButtonIcon();
        
        /* 触发主题切换专属缩放特效（不在打开窗口时触发） */
        panelEl.classList.remove('rlog-anim-light', 'rlog-anim-dark');

        /* 移动端（窄屏）禁用颜色过渡快速切换：大量展开消息时同时做 0.35s 渐变会明显卡顿， */
        /* 主题色在双 RAF 后瞬间切换完成再播放缩放动画； */
        /* 桌面端保留原有渐变特效（void offsetWidth 强制回流以重置动画状态）。 */
        /* 注：禁用过渡不影响最终颜色，只是不播放颜色渐变过程。 */
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        if (isMobile) {
            panelEl.classList.add('rlog-theme-transitioning');
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    panelEl.classList.remove('rlog-theme-transitioning');
                    if (isLightTheme) {
                        panelEl.classList.add('rlog-anim-light');
                    } else {
                        panelEl.classList.add('rlog-anim-dark');
                    }
                });
            });
        } else {
            /* 桌面端：保留渐变过渡 + 强制回流重启动画 */
            void panelEl.offsetWidth;
            if (isLightTheme) {
                panelEl.classList.add('rlog-anim-light');
            } else {
                panelEl.classList.add('rlog-anim-dark');
            }
        }

        /* 动画结束后自动清除动画类，防止关闭再打开窗口时重新触发残留动画 */
        const onAnimEnd = () => {
            panelEl.classList.remove('rlog-anim-light', 'rlog-anim-dark');
            panelEl.removeEventListener('animationend', onAnimEnd);
        };
        panelEl.addEventListener('animationend', onAnimEnd);
    });
    updateThemeButtonIcon();

    /* 绑定总开关 */
    const masterToggleBtn = panelEl.querySelector('#rlog-master-toggle');
    if (masterToggleBtn) {
        masterToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setMasterEnabled(!masterEnabled);
            e.target.blur();
        });
    }
    updateMasterToggleUI();

    /* 加载并应用内容预览开关状态（持久化） */
    contentPreviewEnabled = loadContentPreview();
    updatePreviewToggleUI();

    /* 绑定预览开关事件 */
    const previewToggleEl = panelEl.querySelector('#rlog-preview-toggle');
    if (previewToggleEl) {
        previewToggleEl.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleContentPreview();
        });
    }

    makeDraggable(panelEl);
    makeResizable(panelEl);

    /* 视口/面板宽度变化（含桌面↔移动切换、拖拽改宽）会让记录标题栏换行高度变化， */
    /* 重测吸顶偏移（--rlog-rec-h） */
    if (!window.rlogHeaderVarResizeInstalled) {
        window.rlogHeaderVarResizeInstalled = true;
        window.addEventListener('resize', () => {
            syncRecordHeaderVars(panelEl && panelEl.querySelector('#rlog-list'));
        });
    }

    /* 安装来源识别监听（仅记录用户原生入口，不受总开关影响） */
    installSourceTracking();

    /* 安装 fetch 拦截（hook 始终安装，内部通过 masterEnabled 决定是否记录） */
    installFetchHook();
    /* 安装同源 iframe fetch 拦截（酒馆助手等 iframe 内脚本的请求同样捕获） */
    installIframeFetchHooks();

    /* 同步筛选分段按钮视觉状态（默认全开；引导/API 改动过状态时以实际状态为准） */
    updateFilterChipUI();

    renderPanelContent();
}

function updateThemeButtonIcon() {
    const btn = panelEl ? panelEl.querySelector('#rlog-theme-btn') : null;
    if (!btn) return;
    btn.innerHTML = isLightTheme
        ? '<i class="fa-solid fa-moon"></i>'
        : '<i class="fa-solid fa-sun"></i>';
}

function togglePanel() {
    isPanelVisible ? hidePanel() : showPanel();
}

function showPanel() {
    if (!panelEl) buildUI();
    panelEl.style.display = 'flex';
    isPanelVisible = true;
    if (toggleBtn) toggleBtn.classList.add('active');
    /* 仅当数据/渲染设置变化时才重建 DOM；否则保留原有 DOM，避免大量展开消息时打开面板卡顿 */
    if (panelContentDirty) {
        renderPanelContent();
    }
    /* 面板显示后重测记录标题栏高度：隐藏状态下渲染时 offsetHeight 为 0， */
    /* 消息标题栏的吸顶偏移（--rlog-rec-h）必须以可见状态的实际高度为准 */
    syncRecordHeaderVars(panelEl.querySelector('#rlog-list'));
    /* 面板关闭期间有新记录到达时，重新打开后回到列表顶部最新一条 */
    if (pendingScrollToTop && !isPanelCollapsed) {
        pendingScrollToTop = false;
        const listEl = panelEl.querySelector('#rlog-list');
        if (listEl) listEl.scrollTop = 0;
        /* 面板关闭期间来新消息，重新打开回顶后提示最新一条位置 */
        flashTopHint();
    }

    /* 在面板显示后检查是否需要进行引导 */
    if (window.__RLogTour && typeof window.__RLogTour.check === 'function') {
        setTimeout(() => window.__RLogTour.check(), 300);
    }
}

function hidePanel() {
    /* 关闭面板时退出搜索模式 */
    resetSearchIfActive();
    /* 关闭面板时取消尚未触发的置底闪烁（避免关闭后定时器在隐藏 DOM 上触发） */
    cancelPendingFlash();
    /* 关闭面板时隐式清理「查看全文」覆盖层（如存在） */
    closeReadFullOverlay();
    if (panelEl) {
        /* 清理置底跳转的标题栏闪烁类，防止下次打开面板时动画重播 */
        let cleared = false;
        panelEl.querySelectorAll('.rmsg-header.rlog-flash-bottom, .rlog-record-header.rlog-flash-bottom').forEach(el => {
            el.classList.remove('rlog-flash-bottom');
            cleared = true;
        });
        /* 关闭面板等同主动打断：清空回顶时间戳，重开后回复重渲染不再补闪 */
        if (cleared) lastTopHintFlashAt = 0;
        panelEl.style.display = 'none';
        /* 关闭面板时清理残留的主题切换动画类，防止下次打开时重播 */
        panelEl.classList.remove('rlog-anim-light', 'rlog-anim-dark');
    }
    isPanelVisible = false;
    if (toggleBtn) toggleBtn.classList.remove('active');
}


/* ── 拖拽与缩放 ────────────────────────── */

function makeResizable(el) {
    const grip = el.querySelector('.rlog-resize-grip');
    if (!grip) return;

    grip.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        panelResizing = true;
        resizeStartX = e.clientX;
        resizeStartY = e.clientY;
        resizeStartW = el.offsetWidth;
        resizeStartH = el.offsetHeight;
        /* 锚定左/上边缘：面板默认是水平居中定位（left:50% + translateX(-50%)）， */
        /* 若只改 width，左右两侧会对称移动；与标题栏拖拽一样改为 left/top 定位后， */
        /* 缩放只影响右/下边缘（右下角小三角的常规行为）。 */
        const rect = el.getBoundingClientRect();
        el.style.transform = 'none';
        el.style.left = `${rect.left}px`;
        el.style.top = `${rect.top}px`;
        el.style.transition = 'none';
    });

    grip.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        e.preventDefault();
        panelResizing = true;
        resizeStartX = e.touches[0].clientX;
        resizeStartY = e.touches[0].clientY;
        resizeStartW = el.offsetWidth;
        resizeStartH = el.offsetHeight;
        /* 与 mousedown 相同：锚定左/上边缘，缩放只影响右/下边缘 */
        const rect = el.getBoundingClientRect();
        el.style.transform = 'none';
        el.style.left = `${rect.left}px`;
        el.style.top = `${rect.top}px`;
        el.style.transition = 'none';
    });
}

(function initGlobalResize() {
    document.addEventListener('mousemove', (e) => {
        if (!panelResizing || !panelEl) return;
        const dx = e.clientX - resizeStartX;
        const dy = e.clientY - resizeStartY;
        const newW = Math.max(350, resizeStartW + dx);
        const newH = Math.max(200, resizeStartH + dy);
        panelEl.style.width = `${newW}px`;
        panelEl.style.height = `${newH}px`;
        panelEl.style.maxHeight = 'none';
    });

    document.addEventListener('mouseup', () => {
        if (panelResizing) {
            panelResizing = false;
            if (panelEl) panelEl.style.transition = '';
            /* 面板宽度变化可能改变记录标题栏换行高度，重测吸顶偏移 */
            syncRecordHeaderVars(panelEl && panelEl.querySelector('#rlog-list'));
        }
    });

    document.addEventListener('touchmove', (e) => {
        if (!panelResizing || !panelEl) return;
        e.preventDefault();
        const dx = e.touches[0].clientX - resizeStartX;
        const dy = e.touches[0].clientY - resizeStartY;
        const newW = Math.max(350, resizeStartW + dx);
        const newH = Math.max(200, resizeStartH + dy);
        panelEl.style.width = `${newW}px`;
        panelEl.style.height = `${newH}px`;
        panelEl.style.maxHeight = 'none';
    }, { passive: false });

    document.addEventListener('touchend', () => {
        if (panelResizing) {
            panelResizing = false;
            if (panelEl) panelEl.style.transition = '';
            syncRecordHeaderVars(panelEl && panelEl.querySelector('#rlog-list'));
        }
    });
})();

function makeDraggable(el) {
    const header = el.querySelector('.rlog-panel-header');
    if (!header) return;

    let startX, startY, origX, origY;
    let dragging = false;

    header.style.cursor = 'move';

    header.addEventListener('mousedown', (e) => {
        /* 跳过按钮、H4 标题及其子元素、预览开关（它们有各自的交互，不参与拖拽） */
        if (e.target.tagName === 'BUTTON' || e.target.closest('h4') || e.target.closest('#rlog-preview-toggle')) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = el.getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;
        el.style.transform = 'none';
        el.style.left = `${origX}px`;
        el.style.top = `${origY}px`;
        el.style.transition = 'none';
        e.preventDefault();
    });

    header.addEventListener('touchstart', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.closest('h4') || e.target.closest('#rlog-preview-toggle')) return;
        dragging = true;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        const rect = el.getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;
        el.style.transform = 'none';
        el.style.left = `${origX}px`;
        el.style.top = `${origY}px`;
        el.style.transition = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        el.style.left = `${origX + dx}px`;
        el.style.top = `${origY + dy}px`;
        el.style.bottom = 'auto';
        el.style.right = 'auto';
    });

    document.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        e.preventDefault();
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        el.style.left = `${origX + dx}px`;
        el.style.top = `${origY + dy}px`;
        el.style.bottom = 'auto';
        el.style.right = 'auto';
    }, { passive: false });

    document.addEventListener('mouseup', () => {
        if (dragging) {
            dragging = false;
            el.style.transition = '';
            /* 拖拽不改变宽度，但保留重测以覆盖偶发换行变化 */
            syncRecordHeaderVars(panelEl && panelEl.querySelector('#rlog-list'));
        }
    });

    document.addEventListener('touchend', () => {
        if (dragging) {
            dragging = false;
            el.style.transition = '';
            syncRecordHeaderVars(panelEl && panelEl.querySelector('#rlog-list'));
        }
    });
}

/* ── 初始化 ──────────────────────────── */

function init() {
    if (!window.SillyTavern || typeof window.SillyTavern.getContext !== 'function') {
        console.debug(`[${PLUGIN_KEY}] 等待 SillyTavern 初始化...`);
        setTimeout(init, INIT_RETRY_ST_MS);
        return;
    }

    const ctx = window.SillyTavern.getContext();
    if (!ctx || !ctx.eventSource || !ctx.event_types) {
        console.debug(`[${PLUGIN_KEY}] ST 上下文未就绪，稍后重试...`);
        setTimeout(init, INIT_RETRY_CTX_MS);
        return;
    }

    eventSource = ctx.eventSource;
    event_types = ctx.event_types;

    /* 通过 APP_READY 事件或兜底 setTimeout 触发 UI 构建，但只执行一次 */
    const tryBuildUI = () => {
        if (!uiBuilt) buildUI();
    };

    eventSource.once(event_types.APP_READY, () => {
        tryBuildUI();
    });

    /* 兜底：如果 APP_READY 已经触发过（插件后加载），直接构建 UI */
    setTimeout(() => {
        tryBuildUI();
    }, APP_READY_FALLBACK_MS);

    console.debug(`[${PLUGIN_KEY}] 初始化完成 - 静默监听提示词发送`);
}

init();

/* ── 对外 API ───────────────────────── */

window.__RLogApi = {
    records: () => records,
    /* 搜索相关（供 tour.js 使用） */
    openSearchForRecord: (recordIndex) => openSearchForRecord(recordIndex),
    performSearch: (recordIndex, keyword) => performSearch(recordIndex, keyword),
    closeSearch: () => closeSearch(),
    injectDemo: () => {
        const demoRecord = {
            characterName: '未知角色',
            timestamp: new Date().toLocaleString('zh-CN', { hour12: false }),
            source: { type: 'plugin', label: '插件', detail: '插件/非原生请求' },
            modelName: 'Human-Brain-1.0-Pro',
            messages: [
                { 
                    role: 'assistant', 
                    content: '<thinking>\nGenerating example message...\n\n等等，示例究竟该写什么？\n我到底为什么要做这个？\n算了，随便写一句吧。\n</thinking>\n\n您好！欢迎使用本插件。', 
                    tokens: 42, 
                    collapsed: false, 
                    tokenPrecise: true 
                }
            ],
            collapsed: false,
            isDemo: true /* 标记为演示记录 */
        };
        records.unshift(demoRecord);
        panelContentDirty = true;
        if (panelEl && isPanelVisible) renderPanelContent();
    },
    removeDemo: () => {
        records = records.filter(r => !r.isDemo);
        panelContentDirty = true;
        if (panelEl && isPanelVisible) renderPanelContent();
    },
    openDrawer: () => {
        if (!panelEl) return;
        closeFilterDrawer();
        const moreDrawer = panelEl.querySelector('#rlog-more-drawer');
        const moreBtn = panelEl.querySelector('#rlog-more-btn');
        if (moreDrawer) moreDrawer.classList.add('expanded');
        if (moreBtn) moreBtn.classList.add('active-drawer-btn');
    },
    closeDrawer: () => {
        if (!panelEl) return;
        const moreDrawer = panelEl.querySelector('#rlog-more-drawer');
        const moreBtn = panelEl.querySelector('#rlog-more-btn');
        if (moreDrawer) moreDrawer.classList.remove('expanded');
        if (moreBtn) moreBtn.classList.remove('active-drawer-btn');
    },
    /* 筛选抽屉开关（供 tour.js 使用）；打开时自动收起「更多」抽屉 */
    setFilterDrawer: (open) => {
        if (!panelEl) return;
        const filterDrawer = panelEl.querySelector('#rlog-filter-drawer');
        const filterBtn = panelEl.querySelector('#rlog-filter-btn');
        if (!filterDrawer) return;
        if (open) {
            closeMoreDrawer();
            filterDrawer.classList.add('expanded');
            filterBtn.classList.add('active-drawer-btn');
        } else {
            filterDrawer.classList.remove('expanded');
            filterBtn.classList.remove('active-drawer-btn');
        }
    },
    /* 筛选状态读写（供 tour.js 暂存/恢复；setFilterState 触发重建） */
    getFilterState: () => JSON.parse(JSON.stringify(filterState)),
    setFilterState: (state) => {
        filterState = state && typeof state === 'object' ? state : createDefaultFilterState();
        updateFilterChipUI();
        panelContentDirty = true;
        if (panelEl && isPanelVisible) renderPanelContent();
    },
    /* 重置筛选（供引导/回归测试/外部调用） */
    resetFilters: () => resetFilters(),
    toggleFilterChip: (group, value) => toggleFilterChip(group, value),
    getVisibleRecordsCount: () => getVisibleRecords().length,
    /* 替换整个记录列表（供 tour.js 在引导期间清空/恢复记录使用） */
    setRecords: (newRecords) => {
        records = Array.isArray(newRecords) ? newRecords : [];
        /* 保持「记录数不超过上限」的既有约束（引导恢复时暂存记录可能使总数超限） */
        if (records.length > MAX_RECORDS) {
            records.length = MAX_RECORDS;
        }
        panelContentDirty = true;
        if (panelEl && isPanelVisible) renderPanelContent();
    },
    /* 引导状态控制（供 tour.js 使用）：引导期间新记录暂存、不显示 */
    setTourActive: (active) => {
        tourActive = !!active;
    },
    /* 取出并清空引导期间暂存的新记录（供 tour.js 在引导结束时合并恢复） */
    drainTourPendingRecords: () => {
        const pending = tourPendingRecords;
        tourPendingRecords = [];
        return pending;
    },
    expandDemo: () => {
        if (records.length > 0) {
            records[0].collapsed = false;
            records[0].messages.forEach(m => m.collapsed = false);
            panelContentDirty = true;
            if (panelEl && isPanelVisible) renderPanelContent();
        }
    },
    collapseDemo: () => {
        if (records.length > 0) {
            records[0].collapsed = true;
            records[0].messages.forEach(m => m.collapsed = true);
            panelContentDirty = true;
            if (panelEl && isPanelVisible) renderPanelContent();
        }
    },
    forcePreview: (state) => {
        forcePreviewState = state ? true : null;
        panelContentDirty = true;
        if (panelEl && isPanelVisible) renderPanelContent();
    },
};

/* ── 临时测试功能 ───────────────────────── */

/* number|null: 临时调试：覆盖回复超时时长（供 simulateReplyTimeout 模拟测试用，后续删除） */
let replyTimeoutOverrideMs = null;

/* 一键注入全部测试数据（临时功能，后续删除）：
   1. 8 条 Token 区间记录（tier 0-7，验证区间颜色）
   2. 1 条成功回复模拟记录（Succeed 标记）
   3. 1 条失败回复模拟记录（Fail 标记，HTTP 500）
   4. 触发超时模拟（真实 2 秒超时收尾 → Timeout 标记）
   移动端：点击面板标题栏「更多」抽屉中的烧瓶图标按钮即可注入；
   桌面端：也可在浏览器控制台执行 window.__RLogApi.injectTokenTierTest() */
window.__RLogApi.injectTokenTierTest = function injectTokenTierTest() {
        /* 每个区间的典型 token 数（对应 getTokenTier 的边界） */
        const tierValues = [
            { tokens: 2000,  label: '<4K' },
            { tokens: 6000,  label: '4K-8K' },
            { tokens: 12000, label: '8K-16K' },
            { tokens: 24000, label: '16K-32K' },
            { tokens: 48000, label: '32K-64K' },
            { tokens: 96000, label: '64K-128K' },
            { tokens: 160000, label: '128K-200K' },
            { tokens: 240000, label: '>200K' },
        ];
        const baseTs = new Date();
        const tsStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        const tierRecords = tierValues.map((t, i) => {
            const ts = new Date(baseTs.getTime() - i * 60000);
            return {
                characterName: '示例角色',
                timestamp: tsStr(ts),
                source: { type: 'plugin', label: '插件', detail: '插件/非原生请求' },
                modelName: 'Test-Model',
                messages: [{
                    role: 'system',
                    content: `区间测试 ${t.label}`,
                    tokens: t.tokens,
                    collapsed: true,
                    tokenPrecise: true,
                }],
                collapsed: true,
                isDemo: true, /* 标记为演示记录，可被 removeDemo 清理 */
            };
        });

        /* 成功 / 失败回复模拟记录（供验证 Succeed / Fail 标记与回复子消息展示） */
        const successRecord = {
            characterName: '成功示例',
            timestamp: tsStr(new Date(baseTs.getTime() - 8 * 60000)),
            source: { type: 'native', label: '原生', detail: '模拟测试' },
            modelName: 'Test-Model',
            messages: [{
                role: 'user',
                content: '模拟请求：这是一条成功回复的记录。',
                tokens: 96,
                collapsed: true,
                tokenPrecise: true,
            }],
            collapsed: true,
            isDemo: true,
            reply: {
                role: 'response',
                content: '<think>\n模拟思考：模型正常完成思考过程。\n</think>\n\n模拟回复：这是一条完整且足够长的成功回复内容，用于验证 Succeed 标记与正文展示。',
                tokens: 188,
                tokenPrecise: true,
                collapsed: true,
                status: 'succeed',
                failReason: '',
                time: tsStr(new Date(baseTs.getTime() - 8 * 60000 + 5000)),
            },
        };
        const failRecord = {
            characterName: '失败示例',
            timestamp: tsStr(new Date(baseTs.getTime() - 9 * 60000)),
            source: { type: 'native', label: '原生', detail: '模拟测试' },
            modelName: 'Test-Model',
            messages: [{
                role: 'user',
                content: '模拟请求：这是一条失败回复的记录。',
                tokens: 88,
                collapsed: true,
                tokenPrecise: true,
            }],
            collapsed: true,
            isDemo: true,
            reply: {
                role: 'response',
                content: 'HTTP 500', /* 与真实挂载路径一致：Fail 时回复内容写入失败原因（移动端无需悬停即可见） */
                tokens: 2,
                tokenPrecise: true,
                collapsed: true,
                status: 'fail',
                failReason: 'HTTP 500',
                time: tsStr(new Date(baseTs.getTime() - 9 * 60000 + 3000)),
            },
        };

        /* 替换现有演示记录，避免叠加 */
        records = records.filter(r => !r.isDemo);
        records.unshift(...tierRecords);
        records.unshift(failRecord, successRecord);
        panelContentDirty = true;
        if (panelEl && isPanelVisible) renderPanelContent();

        /* 触发超时模拟：真实 2 秒超时收尾，addRecord 会把超时记录置顶并折叠其它记录 */
        if (window.__RLogApi && typeof window.__RLogApi.simulateReplyTimeout === 'function') {
            window.__RLogApi.simulateReplyTimeout({
                reasoning: '模拟思考：模型思考到一半卡住了…',
                content: '模拟正文：这是已经输出的一部分内容。',
            });
        }
    };
    /* 临时调试功能（后续删除）：模拟「回复 5 分钟超时」。
       真实 5 分钟很难遇到，这里把超时临时缩短为 2 秒：
       创建一条「请求已发、回复永不返回」的记录，2 秒后走真实的超时收尾流程，
       记录出现 Timeout 标记并保留已收到的半截内容（若有）。
       @param {object} [opts] { reasoning, content } 模拟已收到的半截思考/正文
       @returns {number|null} 模拟记录的 captureId（总开关关闭时返回 null） */

window.__RLogApi.simulateReplyTimeout = function simulateReplyTimeout(opts = {}) {
        if (!masterEnabled) {
            console.warn(`[${PLUGIN_KEY}] 总开关已关闭，无法模拟超时。`);
            return null;
        }
        const savedOverride = replyTimeoutOverrideMs;
        replyTimeoutOverrideMs = 2000; /* 临时缩短到 2 秒 */
        const captureId = ++captureSeq;
        const entry = {
            startTime: Date.now(),
            timer: null,
            expireTimer: null,
            status: null,
            content: opts.content || '',
            reasoning: opts.reasoning || '',
            failReason: '',
            time: '',
            reader: null,
            finished: false,
        };
        pendingReplies.set(captureId, entry);
        entry.timer = setTimeout(() => finalizeReply(captureId, 'timeout', 'timeout'), getReplyTimeoutMs());
        /* 走真实 addRecord 路径建记录（内容带时间戳，避免 500ms 去重误跳过） */
        addRecord(
            '超时示例',
            [{ role: 'user', content: `【超时模拟】回复永不返回 · ${Date.now()}` }],
            { type: 'native', label: '原生', detail: '超时模拟测试' },
            'Test-model',
            null,
            captureId
        );
        replyTimeoutOverrideMs = savedOverride; /* 恢复默认（对这条模拟记录已生效） */
        console.debug(`[${PLUGIN_KEY}] 已注入超时模拟记录，2 秒后出现 Timeout 标记。`);
        return captureId;
    };

function buildTempTestButton(panelEl) {
    const btn = document.createElement('button');
    btn.id = 'rlog-test-btn';
    btn.className = 'rlog-header-btn';
    btn.title = '注入测试数据（Token 区间 / 成功 / 失败 / 超时）';
    btn.innerHTML = '<i class="fa-solid fa-vial"></i>';
    const helpBtn = panelEl.querySelector('#rlog-help-btn');
    if (helpBtn) {
        helpBtn.insertAdjacentElement('afterend', btn);
    } else {
        const drawer = panelEl.querySelector('#rlog-more-drawer');
        if (drawer) drawer.appendChild(btn);
    }
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.__RLogApi && typeof window.__RLogApi.injectTokenTierTest === 'function') {
            window.__RLogApi.injectTokenTierTest();
            /* 注入后收起「更多」抽屉，展示测试记录 */
            const moreDrawer = panelEl.querySelector('#rlog-more-drawer');
            const moreBtn = panelEl.querySelector('#rlog-more-btn');
            moreDrawer.classList.remove('expanded');
            moreBtn.classList.remove('active-drawer-btn');
        }
    });
}
