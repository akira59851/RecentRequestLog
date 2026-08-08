/**
 * SillyTavern 第三方插件: 最近请求记录 (Recent Request Log)
 *
 * 安装方式：将 RecentRequestLog 整个文件夹复制到
 * SillyTavern/public/scripts/extensions/third-party/ 目录下
 * 然后启动或刷新 SillyTavern 即可。
 *
 * 功能:
 *  - 静默抓取每次发送给 AI 的完整提示词
 *  - 按角色分组展示每条消息，估算 tokens
 *  - 记录默认折叠，点击展开/收起
 *  - 消息默认折叠，点击各消息标题展开/收起
 *  - 每条消息及整条记录均支持一键复制
 *  - 最多保存 10 条记录 (滚动覆盖)
 *  - 仅存储于内存中，刷新/关闭后清空
 *  - 可清空全部记录
 *  - 昼/夜模式切换 (持久化)
 *  - 点击标题栏一键展开/折叠全部记录
 *  - 通过网络层拦截 fetch 请求捕获实际发送给 AI 的提示词
 */

// ── 动态加载 tour.js ──────────────────────────────
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

// ── 全局常量 ──────────────────────────────────────
const PLUGIN_KEY = 'RecentRequestLog';
const DEFAULT_MAX_RECORDS = 10;         // 默认最大记录数
const MIN_MAX_RECORDS = 10;              // 用户可设置的最小值
const MAX_MAX_RECORDS = 100;            // 用户可设置的最大值（防止滥用）
const DOUBLE_CLICK_THRESHOLD = 350;     // 双击判定时间阈值(ms)，小于此间隔视为双击
const STORAGE_THEME_KEY = `${PLUGIN_KEY}_theme`;
const STORAGE_MASTER_KEY = `${PLUGIN_KEY}_masterEnabled`;
const STORAGE_MAX_RECORDS_KEY = `${PLUGIN_KEY}_maxRecords`;  // 持久化最大记录数
const STORAGE_PREVIEW_KEY = `${PLUGIN_KEY}_contentPreview`;  // 持久化内容预览开关
const NATIVE_INTENT_WINDOW_MS = 5000;

// ── 动态最大记录数（持久化 + 运行时可变） ──────────
/** @type {number} 当前生效的最大记录数上限，从 localStorage 加载或使用默认值 */
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

// ── 延迟初始化的 ST 引用 ──────────────────────────
/** @type {object|null} ST eventSource */
let eventSource = null;
/** @type {object|null} ST event_types */
let event_types = null;

// ── 状态变量 ──────────────────────────────────────
/** @type {Array} 抓取到的记录列表 */
let records = [];

/** @type {HTMLElement|null} 面板 DOM 元素 */
let panelEl = null;

/** @type {HTMLElement|null} 扩展菜单中的按钮 */
let toggleBtn = null;

/** @type {boolean} 面板是否可见 */
let isPanelVisible = false;

/** @type {boolean} 面板内容是否需要重建（数据变化时置 true，渲染完成后清 false）
 * 面板隐藏时 DOM 完整保留；只有数据/渲染设置变化时才在下次打开时重建 DOM，
 * 避免展开大量消息时每次打开面板都全量重建造成卡顿。 */
let panelContentDirty = true;

/** @type {boolean} 是否为明亮模式 */
let isLightTheme = false;

/** @type {boolean} 面板窗口是否折叠 */
let isPanelCollapsed = false;

/** @type {boolean} 插件总开关是否启用（持久化到 localStorage，首次安装默认开启） */
let masterEnabled = true;

/** @type {HTMLElement|null} 设置最大记录数的弹窗 DOM 元素 */
let maxRecordsDialog = null;

// 面板拖拽/缩放相关
let panelResizing = false;
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartW = 0;
let resizeStartH = 0;

// ── fetch 拦截相关状态 ─────────────────────────
/** @type {Function|null} 原始 window.fetch 的引用 */
let originalFetch = null;

/** @type {Function|null} 当前安装的 fetch 包装函数 */
let currentHook = null;

/** @type {boolean} fetch hook 执行中的重入保护标志 */
let fetchHookInFlight = false;

/** @type {string|null} 上一次记录的 messages 指纹，用于去重 */
let lastRecordFingerprint = null;

/** @type {number} 上一次记录的时间戳 */
let lastRecordTime = 0;

/** @type {{ timestamp: number, target: string, source: 'click'|'pointerdown'|'keydown' }|null} 最近一次 ST 原生生成入口 */
let lastNativeIntent = null;

/** @type {boolean} 是否已安装原生入口监听 */
let sourceTrackingInstalled = false;

/** @type {boolean} UI 是否已构建（防止 init() 竞态导致双重建构） */
let uiBuilt = false;

/** @type {boolean} 内容预览开关，默认关闭（持久化到 localStorage） */
let contentPreviewEnabled = false;

/** @type {boolean|null} 强制覆盖内容预览开关（用于引导程序演示） */
let forcePreviewState = null;

/** @type {object|null} 当前搜索状态（同一时间仅一条记录可搜索）
 * 结构: { recordIndex, keyword, matches, currentIdx, searchEl }
 * - recordIndex: 正在搜索的记录索引
 * - keyword: 当前搜索关键词（用于判断是否需重新搜索）
 * - matches: Array<{ msgIdx, start, end }> 所有匹配位置
 * - currentIdx: 当前高亮的是第几个匹配（-1 表示无匹配）
 * - searchEl: 搜索框容器 DOM 元素
 */
let searchState = null;

/** @type {number|null} 搜索输入 debounce 定时器 ID */
let searchDebounceTimer = null;

/** @type {number} 搜索输入防抖延迟(ms)，输入停止后过久再执行搜索 */
const SEARCH_DEBOUNCE_MS = 120;

/**
 * 从模型名称中提取「家族」标识
 * 同一家族的模型共享分词器（如 gemini-3.1-pro-preview 和 gemini-3.6-flash 都属 gemini 家族）。
 * 匹配逻辑参照 ST tokenizers.js 中 getTokenizerModel() 的模型名匹配规则。
 * @param {string} modelName 模型名称
 * @returns {string} 家族标识，无法识别时返回原始名称的小写
 */
function extractModelFamily(modelName) {
    if (!modelName || modelName === '未知模型') return '';
    const m = modelName.toLowerCase();

    // GPT 家族：gpt、o1、o3、o4、davinci、turbo
    if (m.includes('gpt') || m.includes('o1-') || m.includes('o3-') || m.includes('o4-') || m.includes('davinci')) return 'gpt';

    // Claude 家族
    if (m.includes('claude')) return 'claude';

    // Gemini/Gemma 家族（Google 所有模型用 Gemma 分词器）
    if (m.includes('gemini') || m.includes('gemma') || m.includes('palm')) return 'gemini';

    // Llama 家族：llama、mistral、mixtral、qwen、deepseek、yi、command-r、command-a、nemo、pixtral、jamba
    if (m.includes('llama') || m.includes('mistral') || m.includes('mixtral') || m.includes('qwen') || m.includes('deepseek') || m.includes('command-r') || m.includes('command-a') || m.includes('yi-') || m.includes('nemo') || m.includes('pixtral') || m.includes('jamba')) return 'llama';

    // NovelAI 家族
    if (m.includes('kayra') || m.includes('clio') || m.includes('erato')) return 'novelai';

    // 无法识别，返回原始名称作为家族标识（精确匹配也行）
    return m;
}

/**
 * 判断两个模型名是否属于同一家族（共享分词器）
 * 只要能被 extractModelFamily 识别为同一家族即返回 true
 * @param {string} modelA 模型名 A（来自请求体）
 * @param {string} modelB 模型名 B（来自 ST 主 API）
 * @returns {boolean} 是否同家族
 */
function isSameModelFamily(modelA, modelB) {
    if (!modelA || modelA === '未知模型' || !modelB) return true; // 无法判断时默认认为兼容
    return extractModelFamily(modelA) === extractModelFamily(modelB);
}

/**
 * 使用 ST 原生分词器为消息列表异步计算 Token 数量
 * 优先使用 ST context 暴露的 getTokenCountAsync，不可用时降级为字节估算
 * 逐条异步计算，结果直接写回消息对象的 tokens 字段
 * @param {Array} messages 消息列表，每条消息需要有 content 字段
 * @param {string} modelName 请求中提取的模型名，用于对比主 API 模型判断分词器兼容性
 */
async function computeTokensForMessages(messages, modelName) {
    const ctx = window.SillyTavern && typeof window.SillyTavern.getContext === 'function'
        ? window.SillyTavern.getContext()
        : null;
    const getTokenCountAsync = ctx && ctx.getTokenCountAsync;

    if (!getTokenCountAsync) {
        // 降级：ST context 不可用时，使用与 ST 一致的字节估算 (BYTES_PER_TOKEN = 3.35)
        const textEncoder = new TextEncoder();
        for (const msg of messages) {
            const byteLength = textEncoder.encode(msg.content).length;
            msg.tokens = Math.ceil(byteLength / 3.35);
            msg.tokenPrecise = false; // 标记为非精确值，UI 显示 ~ 前缀
        }
        return;
    }

    // 获取 ST 主 API 的当前模型名称，与请求模型名对比判断分词器是否匹配
    let stModelName = '';
    try {
        if (ctx && typeof ctx.getChatCompletionModel === 'function') {
            stModelName = ctx.getChatCompletionModel();
        }
    } catch (e) { /* ignore */ }

    // 按模型家族（而非全名）对比：同一家族的模型共享分词器，不需要显示 ~
    const tokenizerCompatible = isSameModelFamily(modelName, stModelName);

    // 逐条使用 ST 原生分词器精确计算（每条独立请求，ST 内部有缓存机制）
    for (const msg of messages) {
        try {
            msg.tokens = await getTokenCountAsync(msg.content, 0);
            msg.tokenPrecise = tokenizerCompatible; // 仅模型名匹配时才认为精确
        } catch (e) {
            // 分词器调用失败时降级为字节估算
            const byteLength = new TextEncoder().encode(msg.content).length;
            msg.tokens = Math.ceil(byteLength / 3.35);
            msg.tokenPrecise = false;
        }
    }
}

// ── AI 请求体结构验证 ────────────────────────────

/**
 * ST 内部聊天消息对象特征 — 用于排除非 AI 请求的聊天数据
 * 真正发送给 AI 的消息对象结构：{ role, content }
 * ST 内部存储的聊天对象结构：{ chat_metadata, mes, swipe_id, send_date, is_user, is_system, ... }
 */
const ST_INTERNAL_MSG_KEYS = new Set([
    'chat_metadata', 'mes', 'swipe_id', 'send_date', 'is_user', 'is_system',
    'extra', 'gen_id', 'gen_start', 'gen_finished', 'swipes', 'swipe_info',
    'fork', 'fork_id', 'ch_name', 'file_name', 'integrity', 'note_prompt',
    'note_interval', 'note_position', 'note_depth', 'note_role',
    'timedWorldInfo', 'LWB_PENDING_VAREVENT_BLOCKS',
]);

/**
 * 判断 fetch 输入对应的 URL。
 */
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

/**
 * 严格验证一个对象是否为标准 AI 消息。
 * 这里有意只接受 role + content，避免把 ST 内部聊天记录、角色卡或系统加载数据误判为生成请求。
 */
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

/**
 * 判断请求体是否为 AI API 生成请求。
 * 结构识别为主，URL 和生成参数作为辅助过滤，用于排除加载界面/进入对话时的 ST 内部接口。
 * 
 * 优化：检查顺序从最便宜到最昂贵排列——
 *   1. 基础类型校验（免费）
 *   2. URL 排除检查（字符串匹配）
 *   3. 顶层 key 扫描（hasGenerationRequestHints + generationUrl）
 *   4. 数组遍历 + 逐元素校验（最贵，仅在顶层特征匹配后才执行）
 */
function isAiRequestBody(body, requestUrl) {
    // 便宜检查 1：基础类型
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;

    // 便宜检查 2：URL 明确排除（字符串索引匹配，不用遍历数组）
    if (isExplicitNonGenerationUrl(requestUrl)) return false;

    // 便宜检查 3：顶层特征扫描 — 只需检查 body 的 key 集合
    const generationUrl = isPotentialGenerationUrl(requestUrl);
    const hasHints = hasGenerationRequestHints(body);

    // 如果既不是生成 URL 也没有生成参数特征，且顶层也没有 messages/chat/contents/system+prompt，
    // 那就快速退出，无需遍历数组做昂贵的逐元素校验
    if (!generationUrl && !hasHints) {
        // 快速检查顶层是否有可能包含消息的数组字段
        const hasMessagesArray = Array.isArray(body.messages) && body.messages.length > 0;
        const hasChatArray = Array.isArray(body.chat) && body.chat.length > 0;
        const hasContentsArray = Array.isArray(body.contents) && body.contents.length > 0;
        const hasSystemPrompt = typeof body.system === 'string' && body.system.length > 0;
        const hasPlainPrompt = typeof body.prompt === 'string' && body.prompt.length > 0;

        // 如果没有任何消息容器字段，直接退出
        if (!hasMessagesArray && !hasChatArray && !hasContentsArray && !hasSystemPrompt && !hasPlainPrompt) {
            return false;
        }

        // 如果有 prompt 但没有 generationUrl/hasHints，仍可能是纯文本补全
        if (hasPlainPrompt && !hasMessagesArray && !hasChatArray && !hasContentsArray && !hasSystemPrompt) {
            // 纯文本补全场景放行（由 parseFetchRequestBody 中单独处理）
            return true;
        }

        // 其他情况：有数组但没有生成特征，大概率是 ST 内部数据加载，跳过
        return false;
    }

    // 昂贵检查：只在顶层特征匹配后才遍历数组做逐元素校验
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


// ── 请求来源识别 ────────────────────────────────

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

    // ── 调试：收集近期点击事件日志 (上限 30 条) ──
    const recentClicks = [];
    const MAX_CLICK_LOG = 30;
    function logClick(action, detail) {
        recentClicks.push({ ts: Date.now(), action, detail });
        if (recentClicks.length > MAX_CLICK_LOG) recentClicks.shift();
    }

    const onNativeClickIntent = (e) => {
        const targetEl = e.target instanceof Element ? e.target : null;
        if (!targetEl) return;

        // ── 快速区域筛选：只在聊天相关区域内检查，避免菜单/设置等区域的无意义遍历 ──
        // #sheld 是 ST 主内容区容器，包含聊天界面和底部操作栏
        const chatZone = document.getElementById('sheld') || document.getElementById('chat') || document.getElementById('send_form');
        if (chatZone && !chatZone.contains(targetEl)) {
            return;
        }

        // 调试：记录每次捕获阶段的事件，包含目标 tag/id/class 和匹配情况
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
            // 调试：记录未匹配但可能相关的点击（如包含 mes_、swipe、regenerate 等关键词的元素）
            const cls = (typeof targetEl.className === 'string' ? targetEl.className : '') + ' ' + (targetEl.getAttribute('title') || '') + ' ' + (targetEl.getAttribute('data-action') || '');
            const hints = ['mes_swipe', 'regenerate', 'swipe', 'mes_continue', 'impersonate', 'send_but'];
            if (hints.some(h => cls.toLowerCase().indexOf(h) !== -1 || tagId.toLowerCase().indexOf(h) !== -1)) {
                logClick('NATIVE_MISS', `未匹配但含关键词: ${tagId} cls="${cls.slice(0, 100)}"`);
            }
        }
    };

    document.addEventListener('pointerdown', onNativeClickIntent, true);
    document.addEventListener('click', onNativeClickIntent, true);

    // 备选回复 / 重新生成可能不走 pointerdown/click，直接监听 GENERATION_STARTED 作为保底方案
    if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
        const stCtx = window.SillyTavern.getContext();
        if (stCtx && stCtx.eventSource && stCtx.event_types) {
            const onGenStarted = (type) => {
                const typeStr = String(type != null ? type : '');
                logClick('GEN_STARTED', `type=${typeStr}`);
                // 仅当 DOM 点击事件未能捕获时，由 GEN_STARTED 补充标记
                // 备选回复 / 重新生成等明确的原生生成类型。
                // normal/quiet 通常由插件或非用户触发的生成产生，不放行。
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
                    // send / quiet / normal / 其他 — 不标记，避免误伤插件
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

    // 暴露调试接口到 window
    window.__rlogDebug = {
        getRecentClicks: () => recentClicks.slice(),
        getLastNativeIntent: () => lastNativeIntent,
        getRecords: () => records,
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
        // 不立即消费原生入口，以确保重新生成/备选回复等操作中可能出现的中间请求不会错误消费标记。
        // 标记在窗口过期后由下方逻辑自动清除。
        return {
            type: 'native',
            label: '原生',
            detail: `原生请求-${lastNativeIntent.target}`,
        };
    }

    // 窗口过期后清除原生入口标记
    if (lastNativeIntent && (now - lastNativeIntent.timestamp) > NATIVE_INTENT_WINDOW_MS) {
        lastNativeIntent = null;
    }

    return {
        type: 'plugin',
        label: '插件',
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


// ── 暴露给其他模块的 API (如引导 tour.js) ────────
window.__RLogApi = {
    records: () => records,
    // 搜索相关（供 tour.js 使用）
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
            isDemo: true // 标记为演示记录
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
    // 替换整个记录列表（供 tour.js 在引导期间清空/恢复记录使用）
    setRecords: (newRecords) => {
        records = Array.isArray(newRecords) ? newRecords : [];
        panelContentDirty = true;
        if (panelEl && isPanelVisible) renderPanelContent();
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
    }
};

// ── 数据管理 ────────────────────────────────────

/**
 * 生成消息列表的去重指纹
 * 通过拼接每条消息的 role + content 生成一个简单哈希，用于判断两条记录是否内容相同
 */
function computeMessagesFingerprint(messages) {
    if (!messages || messages.length === 0) return '';
    // 只用前 50 条 + 每条前 500 字符做指纹，避免超大消息拖慢性能
    return messages.slice(0, 50).map(m => {
        const role = m.role || '';
        const content = typeof m.content === 'string' ? m.content.slice(0, 500) : '';
        return `${role}:${content}`;
    }).join('|');
}

function addRecord(characterName, messages, source, modelName) {
    if (!masterEnabled) return;
    if (!characterName || !messages || messages.length === 0) return;

    // 去重：如果与上一条记录的 messages 内容相同且在 500ms 内，则跳过
    const fingerprint = computeMessagesFingerprint(messages);
    const now = Date.now();
    if (fingerprint && fingerprint === lastRecordFingerprint && (now - lastRecordTime) < 500) {
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
        collapsed: true,
    };

    // 新记录到达时，折叠所有已有记录（仅折叠记录本身，保持各记录内部消息的折叠/展开状态不变）
    records.forEach(r => { r.collapsed = true; });

    records.unshift(record);
    if (records.length > MAX_RECORDS) {
        records.pop();
    }

    panelContentDirty = true;
    if (panelEl && isPanelVisible) {
        renderPanelContent();
        // 回到顶部最新一条
        const listEl = panelEl.querySelector('#rlog-list');
        if (listEl) listEl.scrollTop = 0;
    }
}

function clearAllRecords() {
    records = [];
    panelContentDirty = true;
    if (panelEl && isPanelVisible) {
        renderPanelContent();
    }
}


// ── 模型名称提取 ───────────────────────────────

/**
 * 从 AI 请求体中提取模型名称
 * 不同 API 格式的模型字段名称不同，按优先级尝试提取
 * @param {object} body 解析后的请求体 JSON
 * @returns {string} 模型名称，提取不到则返回 '未知模型'
 */
function extractModelName(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return '未知模型';

    // 1. 直接在顶层找 model 字段（OpenAI、大多数兼容格式）
    if (typeof body.model === 'string' && body.model) return body.model;

    // 2. Gemini 格式：generationConfig.model
    if (body.generationConfig && typeof body.generationConfig.model === 'string' && body.generationConfig.model) {
        return body.generationConfig.model;
    }

    // 3. 尝试从顶层其他常见字段推断
    const modelKeys = ['model_name', 'modelName', 'name', 'engine'];
    for (const key of modelKeys) {
        if (typeof body[key] === 'string' && body[key]) return body[key];
    }

    return '未知模型';
}

// ── Fetch 请求拦截 ──────────────────────────────

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

/**
 * 解析不同 AI 接口的请求体，统一提取消息列表
 * 返回 null 表示无法解析（静默跳过，不产生记录）
 */
function parseFetchRequestBody(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

    const messages = [];

    // 1. OpenAI / 兼容格式 — messages 数组
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
                    tokens: 0, // token 值在 parseFetchRequestBody 外由 computeTokensForMessages 异步计算
                    collapsed: true,
                });
            }
        }
    }

    // 2. chat 数组 — ST 内部事件格式（可能被 fetch 截获）
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
                    tokens: 0, // token 值在 parseFetchRequestBody 外由 computeTokensForMessages 异步计算
                    collapsed: true,
                });
            }
        }
    }

    // 3. Google Gemini 格式
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
                    tokens: 0, // token 值在 parseFetchRequestBody 外由 computeTokensForMessages 异步计算
                    collapsed: true,
                });
            }
        }
    }

    // 4. Anthropic 格式
    if (messages.length === 0 && typeof json.system === 'string' && Array.isArray(json.messages)) {
        if (json.system) {
            messages.push({
                role: 'system',
                content: json.system,
                tokens: 0, // token 值在 parseFetchRequestBody 外由 computeTokensForMessages 异步计算
                collapsed: true,
            });
        }
        for (const m of json.messages) {
            if (!isAiMessageObject(m)) continue;
            if (typeof m.content === 'string' && m.content) {
                messages.push({
                    role: normalizeRole(m.role),
                    content: m.content,
                    tokens: 0, // token 值在 parseFetchRequestBody 外由 computeTokensForMessages 异步计算
                    collapsed: true,
                });
            }
        }
    }

    // 5. 纯文本补全
    if (messages.length === 0 && typeof json.prompt === 'string' && json.prompt.length > 0) {
        messages.push({
            role: 'user',
            content: json.prompt,
            tokens: 0, // token 值在 parseFetchRequestBody 外由 computeTokensForMessages 异步计算
            collapsed: false,
        });
    }

    if (messages.length === 0) return null;
    return messages;
}

/**
 * 后台异步处理已捕获的 AI 请求体：解析消息、计算 token、存入记录。
 * 此函数与 fetch 请求的发送完全解耦，不阻塞 originalFetch 的调用。
 * @param {object} body 已解析的请求体 JSON
 * @param {string} requestUrl 请求 URL
 */
async function processCapturedBody(body, requestUrl) {
    // 严格请求体验证：先排除 ST 加载/切换对话等内部接口，再识别真实生成请求
    if (!body || !isAiRequestBody(body, requestUrl)) return;

    const messages = parseFetchRequestBody(body);
    if (!messages) return;

    const characterName = getCurrentCharacterName();
    const source = inferRequestSource();
    const modelName = extractModelName(body); // 从请求体中提取模型名称
    // 异步使用 ST 原生分词器精确计算每条消息的 token 数量
    // 传入 modelName 用于与 ST 主 API 模型对比，判断分词器是否兼容
    await computeTokensForMessages(messages, modelName);
    addRecord(characterName, messages, source, modelName);
}

/**
 * 安装 fetch 拦截钩子
 * 以简单包装方式拦截 window.fetch。由于本插件 loading_order 为 999，
 * 在安装时其他插件的 fetch 包装链已就绪，originalFetch 捕获的是完整的下游调用链。
 * 
 * 优化：添加快速通道（early return），避免对每一个 JSON POST 请求都做完整的
 * 结构体解析和 isAiRequestBody 深度检查。
 *   1. 非 POST/PUT/PATCH 请求直接跳过
 *   2. URL path 明确属于 ST 内部 API (/api/, /assets/, /backgrounds/) 且不匹配 AI 路径，直接跳过
 *   3. 仅对通过快速筛选的请求才解析 body
 * 
 * 锁策略（规则 5）：fetchHookInFlight 仅保护 body 的同步捕获（init.body 读取），
 * 锁持有时长极短（微秒级）。originalFetch 在锁释放后立即调用，
 * 分词计算和 addRecord 通过 Promise 链异步执行，不阻塞实际网络请求的发出。
 * 这避免了锁内 await 重操作（尤其是 computeTokensForMessages 逐条调分词器）
 * 导致 originalFetch 延迟，从而破坏其他插件（如记忆插件）的时序假设。
 */
function installFetchHook() {
    if (currentHook) return; // 已安装

    originalFetch = window.fetch;
    currentHook = async function hookedFetch(input, init) {
        // ── 快速通道 0：重入保护 ──
        // 如果其他插件的 fetch hijack 形成闭环导致本 hook 被重复进入，
        // 直接透传到 originalFetch，不参与无限循环。
        if (fetchHookInFlight) {
            return originalFetch.apply(window, [input, init]);
        }

        // ── 快速通道 1：总开关关闭时直接透传，不解析 body ──
        if (!masterEnabled) {
            return originalFetch.apply(window, [input, init]);
        }

        // ── 快速通道 2：非 POST/PUT/PATCH 请求直接跳过 ──
        let method = init && init.method ? init.method.toUpperCase() : 'GET';
        if (input instanceof Request && method === 'GET') {
            try { method = input.method.toUpperCase(); } catch (e) { /* ignore */ }
        }
        if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
            return originalFetch.apply(window, [input, init]);
        }

        // ── 快速通道 3：URL 完全不可能是 AI 生成端点，直接跳过（避免解析 body） ──
        const requestUrl = getFetchRequestUrl(input);
        const path = getUrlPathForMatch(requestUrl);
        if (path && !pathMatchesAny(path, AI_GENERATION_PATH_PATTERNS)
            && (path.startsWith('/api/') || path.startsWith('/assets/') || path.startsWith('/backgrounds/'))) {
            return originalFetch.apply(window, [input, init]);
        }

        // ── 加锁仅保护 body 同步捕获，持有时长极短 ──
        // 锁内只做 init.body 的同步读取（JSON.parse 或对象引用），不涉及任何 I/O 或 await。
        // 如果 init.body 不可用，则需要从 Request 中异步读取 body ——
        // 此时启动异步读取后立即退出锁，originalFetch 在锁外尽快调用。
        fetchHookInFlight = true;
        /** @type {object|null} 从 init.body 同步捕获到的请求体（无需异步读取时使用） */
        let syncBody = null;
        /** @type {Promise<object|null>|null} 从 Request.clone() 异步读取 body 的 Promise */
        let asyncBodyPromise = null;
        try {
            if (init && init.body) {
                if (typeof init.body === 'string') {
                    try { syncBody = JSON.parse(init.body); } catch (e) { syncBody = null; }
                } else if (typeof init.body === 'object' && !Array.isArray(init.body)) {
                    // 直接引用（不 clone，因为 processCapturedBody 只做读取）
                    syncBody = init.body;
                }
            }

            if (!syncBody && input instanceof Request) {
                try {
                    const clonedReq = input.clone();
                    // 启动异步 body 读取，Promise 在锁外 resolve
                    asyncBodyPromise = clonedReq.text().then(text => {
                        if (text) {
                            try { return JSON.parse(text); } catch (e) { return null; }
                        }
                        return null;
                    }).catch(() => null);
                } catch (e) {
                    // clone 失败（body 可能已被消费），忽略
                }
            }
        } finally {
            fetchHookInFlight = false;
            // 锁释放 — originalFetch 可以安全调用了
        }

        // ── 调用原始 fetch（锁外，尽早发出网络请求） ──
        // 通过闭包保存的引用调用，避免通过 window.fetch 访问导致递归
        const fetchPromise = originalFetch.apply(window, [input, init]);

        // ── 后台异步处理 body（不阻塞 fetch 返回） ──
        if (syncBody) {
            // 同步捕获的 body，直接异步处理
            processCapturedBody(syncBody, requestUrl).catch(() => { /* 静默处理 */ });
        } else if (asyncBodyPromise) {
            // 从 Request 异步读取的 body，等 Promise resolve 后处理
            asyncBodyPromise.then(body => {
                if (body) {
                    return processCapturedBody(body, requestUrl);
                }
            }).catch(() => { /* 静默处理 */ });
        }

        return fetchPromise;
    };
    window.fetch = currentHook;

    console.debug(`[${PLUGIN_KEY}] fetch 拦截已启用（网络层统一拦截模式）`);
}

/**
 * 卸载 fetch 拦截钩子
 */
function uninstallFetchHook() {
    if (!currentHook) return;

    // 仅当 window.fetch 仍指向我们的 hook 时才恢复，避免破坏其他插件后来安装的 wrapper
    if (window.fetch === currentHook && originalFetch) {
        window.fetch = originalFetch;
    }
    originalFetch = null;
    currentHook = null;

    console.debug(`[${PLUGIN_KEY}] fetch 拦截已停用`);
}


// ── 总开关 ──────────────────────────────────────

function setMasterEnabled(enabled) {
    masterEnabled = enabled;
    try {
        localStorage.setItem(STORAGE_MASTER_KEY, enabled ? '1' : '0');
    } catch (e) { /* ignore */ }
    updateMasterToggleUI();
    
    if (panelEl && isPanelVisible) {
        // 如果当前列表为空且面板可见，立即刷新空白提示文案
        if (records.length === 0) {
            panelContentDirty = true;
            renderPanelContent();
        }
    }
    
    // hook 始终安装（在 installFetchHook 内部通过 masterEnabled 判断是否记录），
    // 不再通过开关触发 hook 的安装/卸载，避免破坏其他插件的 fetch wrapper 链。
}

function updateMasterToggleUI() {
    if (!panelEl) return;
    
    const btn = panelEl.querySelector('#rlog-master-toggle');
    if (btn) {
        if (masterEnabled) {
            btn.classList.add('rlog-master-on');
            btn.classList.remove('rlog-master-off');
            btn.style.color = '#4caf50';
            btn.querySelector('i').className = 'fa-solid fa-power-off';
            btn.title = '插件开启-自动记录中';
        } else {
            btn.classList.add('rlog-master-off');
            btn.classList.remove('rlog-master-on');
            btn.style.color = '#999';
            btn.querySelector('i').className = 'fa-solid fa-power-off';
            btn.title = '插件关闭-已停止记录';
        }
    }

    // 根据总开关状态更新面板的遮罩层级
    if (!masterEnabled) {
        panelEl.classList.add('rlog-disabled');
    } else {
        panelEl.classList.remove('rlog-disabled');
    }
}


// ── 内容预览开关（持久化） ────────────────────────

/**
 * 从 localStorage 加载内容预览开关状态
 * 默认关闭（首次安装或未设置时返回 false）
 * @returns {boolean} 是否开启内容预览
 */
function loadContentPreview() {
    try { return localStorage.getItem(STORAGE_PREVIEW_KEY) === '1'; } catch (e) { return false; }
}

/**
 * 持久化内容预览开关状态到 localStorage
 * @param {boolean} enabled 是否开启
 */
function saveContentPreview(enabled) {
    try { localStorage.setItem(STORAGE_PREVIEW_KEY, enabled ? '1' : '0'); } catch (e) { /* ignore */ }
}

/**
 * 切换内容预览开关状态
 * 更新全局变量、持久化存储、UI 按钮外观，并刷新面板内容
 */
function toggleContentPreview() {
    contentPreviewEnabled = !contentPreviewEnabled;
    saveContentPreview(contentPreviewEnabled);
    updatePreviewToggleUI();
    // 预览开关影响每条消息的渲染内容，需要重建 DOM
    panelContentDirty = true;
    if (panelEl && isPanelVisible) {
        renderPanelContent();
    }
}

/**
 * 更新标题栏预览开关按钮的外观（开启/关闭状态）
 * 开启时滑块右移变色，关闭时滑块左移恢复默认色
 */
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

// ── 主题存储 ────────────────────────────────────

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


// ── 最大记录数持久化 ─────────────────────────────

/**
 * 从 localStorage 加载用户设定的最大记录数
 * 若无保存值或值非法，返回默认值 DEFAULT_MAX_RECORDS
 */
function loadMaxRecords() {
    try {
        const raw = localStorage.getItem(STORAGE_MAX_RECORDS_KEY);
        if (raw !== null && raw !== undefined) {
            const num = parseInt(raw, 10);
            // 合法性校验：必须是有效整数且在允许范围内
            if (!isNaN(num) && num >= MIN_MAX_RECORDS && num <= MAX_MAX_RECORDS) {
                return num;
            }
        }
    } catch (e) { /* ignore */ }
    return DEFAULT_MAX_RECORDS;
}

/**
 * 将用户设定的最大记录数持久化到 localStorage
 * @param {number} value 新的最大记录数
 */
function saveMaxRecords(value) {
    try {
        localStorage.setItem(STORAGE_MAX_RECORDS_KEY, String(value));
    } catch (e) { /* ignore */ }
}

/**
 * 设置新的最大记录数上限
 * 同时更新全局变量、持久化存储、裁剪超出上限的记录、刷新标题栏显示
 * @param {number} newMax 新的上限值
 */
function setMaxRecords(newMax) {
    // 合法性校验
    if (typeof newMax !== 'number' || isNaN(newMax) || newMax < MIN_MAX_RECORDS || newMax > MAX_MAX_RECORDS) {
        return false;
    }
    MAX_RECORDS = newMax;
    saveMaxRecords(MAX_RECORDS);

    // 如果当前记录数超过新上限，裁剪掉多余的旧记录
    while (records.length > MAX_RECORDS) {
        records.pop();
    }

    // 刷新标题栏显示
    updateHeaderTitle();

    // 记录数变化，需要重建 DOM
    panelContentDirty = true;

    // 如果面板可见，刷新内容（裁剪后的列表）
    if (panelEl && isPanelVisible) {
        renderPanelContent();
    }

    return true;
}

/**
 * 更新标题栏文字，反映当前记录数和最大上限
 */
function updateHeaderTitle() {
    if (!panelEl) return;
    const countEl = panelEl.querySelector('.rlog-title-count');
    if (countEl) {
        countEl.textContent = `${records.length} / ${MAX_RECORDS}`;
    }
}


// ── 最大记录数设置弹窗 ─────────────────────────────

/**
 * 创建并显示设置最大记录数的对话框
 * 双击标题栏文字时触发
 */
function showMaxRecordsDialog() {
    // 如果已有弹窗，先移除
    if (maxRecordsDialog) {
        maxRecordsDialog.remove();
    }

    // 创建弹窗遮罩层
    // 使用 inline style 设置定位尺寸，防止父页面 CSS (如 transform) 破坏 position:fixed 的参考系
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
        // 点击遮罩层外部关闭
        if (e.target === overlay) {
            closeMaxRecordsDialog();
        }
    });

    // 创建弹窗主体
    const dialog = document.createElement('div');
    dialog.className = 'rlog-dialog';

    // 根据当前主题添加对应的类名
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

    // 绑定关闭按钮事件
    dialog.querySelector('.rlog-dialog-close').addEventListener('click', closeMaxRecordsDialog);

    // 绑定确认按钮事件
    dialog.querySelector('#rlog-dialog-confirm').addEventListener('click', () => {
        const input = dialog.querySelector('#rlog-max-records-input');
        const rawValue = parseInt(input.value, 10);
        if (!isNaN(rawValue)) {
            // clamp 到允许范围
            const clamped = Math.max(MIN_MAX_RECORDS, Math.min(MAX_MAX_RECORDS, rawValue));
            setMaxRecords(clamped);
        }
        closeMaxRecordsDialog();
    });

    // 输入框回车直接确认
    dialog.querySelector('#rlog-max-records-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            dialog.querySelector('#rlog-dialog-confirm').click();
        } else if (e.key === 'Escape') {
            closeMaxRecordsDialog();
        }
    });

    // 输入框自动聚焦
    setTimeout(() => {
        const input = dialog.querySelector('#rlog-max-records-input');
        if (input) {
            input.focus();
            input.select();
        }
    }, 100);
}

/**
 * 关闭最大记录数设置弹窗
 */
function closeMaxRecordsDialog() {
    if (maxRecordsDialog) {
        maxRecordsDialog.remove();
        maxRecordsDialog = null;
    }
}


// ── 通用确认弹窗 ─────────────────────────────

/** @type {HTMLElement|null} 当前确认弹窗的 DOM 元素 */
let confirmDialogEl = null;

/**
 * 创建并显示通用确认弹窗（用于清空所有记录、删除单条记录等破坏性操作）
 * @param {object} options 配置项
 * @param {string} [options.title='确认操作'] 弹窗标题
 * @param {string} [options.message=''] 弹窗正文（支持 HTML）
 * @param {string} [options.confirmText='确认'] 确认按钮文字
 * @param {string} [options.cancelText='取消'] 取消按钮文字
 * @param {Function} [options.onConfirm] 点击确认后的回调函数
 * @param {Function} [options.onCancel] 点击取消/关闭后的回调函数
 */
function showConfirmDialog(options) {
    const {
        title = '确认操作',
        message = '',
        confirmText = '确认',
        cancelText = '取消',
        onConfirm = null,
        onCancel = null,
    } = options || {};

    // 如果已有弹窗，先移除
    closeConfirmDialog();

    // 创建弹窗遮罩层
    // 使用 inline style 设置定位尺寸，防止父页面 CSS (如 transform) 破坏 position:fixed 的参考系
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
        // 点击遮罩层外部关闭
        if (e.target === overlay) {
            closeConfirmDialog();
            if (typeof onCancel === 'function') onCancel();
        }
    });

    // 创建弹窗主体
    const dialog = document.createElement('div');
    dialog.className = 'rlog-dialog rlog-confirm-dialog';

    // 根据当前主题添加对应的类名
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

    // 绑定关闭按钮事件
    dialog.querySelector('.rlog-dialog-close').addEventListener('click', () => {
        closeConfirmDialog();
        if (typeof onCancel === 'function') onCancel();
    });

    // 绑定取消按钮事件
    dialog.querySelector('#rlog-confirm-cancel').addEventListener('click', () => {
        closeConfirmDialog();
        if (typeof onCancel === 'function') onCancel();
    });

    // 绑定确认按钮事件
    dialog.querySelector('#rlog-confirm-ok').addEventListener('click', () => {
        closeConfirmDialog();
        if (typeof onConfirm === 'function') onConfirm();
    });

    // 键盘支持：Enter 确认、Escape 取消
    dialog.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            dialog.querySelector('#rlog-confirm-ok').click();
        } else if (e.key === 'Escape') {
            closeConfirmDialog();
            if (typeof onCancel === 'function') onCancel();
        }
    });

    // 自动聚焦取消按钮（默认安全操作，避免误触确认）
    setTimeout(() => {
        const cancelBtn = dialog.querySelector('#rlog-confirm-cancel');
        if (cancelBtn) cancelBtn.focus();
    }, 100);
}

/**
 * 关闭通用确认弹窗
 */
function closeConfirmDialog() {
    if (confirmDialogEl) {
        confirmDialogEl.remove();
        confirmDialogEl = null;
    }
}


// ── 渲染 ───────────────────────────────────────

/**
 * 重置当前搜索状态（搜索框关闭、关键词清空、高亮清除、命中序号重置）
 * 用于折叠/删除/清空/新增记录等所有需要退出搜索模式的场景。
 * 安全设计：不依赖搜索框 UI 是否已构建，DOM 中存在才操作。
 */
function resetSearchIfActive() {
    // 清除 debounce 定时器
    if (searchDebounceTimer !== null) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
    }

    // 清除所有高亮标记（包括当前命中和其它残留 mark）
    if (searchState) {
        const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
        if (listEl) {
            listEl.querySelectorAll('mark.rlog-search-mark, mark.rlog-search-mark-current').forEach(mark => {
                const parent = mark.parentNode;
                if (parent) {
                    // 将 mark 替换为其文本内容，恢复原始文本
                    parent.replaceChild(document.createTextNode(mark.textContent), mark);
                    // 合并相邻文本节点，避免产生多余节点
                    parent.normalize();
                }
            });
        }

        // 如果搜索框 DOM 存在，恢复其初始状态
        const searchEl = searchState.searchEl;
        if (searchEl && searchEl.parentNode) {
            searchEl.parentNode.removeChild(searchEl);
        }
        // 恢复对应记录的原操作按钮显示、折叠/展开箭头、搜索中状态标记
        if (panelEl && searchState.recordIndex !== undefined) {
            const recordEl = panelEl.querySelector(`.rlog-record[data-record-index="${searchState.recordIndex}"]`);
            if (recordEl) {
                // 移除「搜索中」标记（CSS 依赖它恢复被隐藏的按钮显示）
                recordEl.classList.remove('rlog-searching');
                // 恢复记录折叠/展开箭头（▾）
                const toggleIcon = recordEl.querySelector('.rlog-toggle-icon');
                if (toggleIcon) toggleIcon.style.visibility = '';
            }
        }

        searchState = null;
    }
}

/** @type {Set<string>} \s 等价的空白字符集合（避免循环内逐字符正则开销） */
const WHITESPACE_CHARS = new Set([' ', '\t', '\n', '\r', '\f', '\v', '\u00a0', '\u1680',
    '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007',
    '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff']);

/**
 * 将文本归一化用于搜索匹配：所有空白字符（空格、换行、回车、Tab、全角空格等）的连续序列折叠为单个空格。
 * 同时返回归一化后每个字符在原始文本中的索引映射，用于将匹配偏移恢复为原始内容偏移。
 *
 * 为什么需要：用户从外部复制多段文本搜索时，换行符在复制粘贴过程中常被转换为空格。
 * 若消息内容中段落间是换行（\n 或 \r\n），直接按原文本匹配会失败。
 * 归一化让「内容中的换行/空白」与「关键词中的空格」等价，实现跨换行匹配。
 *
 * @param {string} text 原始文本
 * @returns {{normalized: string, map: number[]}}
 *   normalized: 空白折叠后的文本（长度 ≤ 原始长度）
 *   map: 长度为 normalized.length，map[i] = normalized 第 i 个字符在原始文本中的索引
 */
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
            // 连续空白只保留一个空格（折叠）
        } else {
            normalized += ch;
            map.push(i);
            lastWasSpace = false;
        }
    }
    return { normalized, map };
}

/**
 * 在指定记录的所有消息内容中查找匹配位置
 * 仅做字符串索引扫描，不触碰 DOM，保证极端长文本下性能稳定。
 * 匹配前对内容和关键词做统一归一化（空白折叠），因此：
 *   - 从外部复制多段文本搜索（换行被复制系统转为空格）也能正常匹配
 *   - 消息内容中的 \n / \r\n / 空行与关键词中的空格等价
 *   - 匹配结果 start/end 为原始内容偏移（经映射恢复），可直接用于 DOM 高亮
 * @param {number} recordIndex 记录索引
 * @param {string} keyword 搜索关键词
 * @returns {Array<{msgIdx: number, start: number, end: number}>} 匹配位置列表
 */
function findMatchesInRecord(recordIndex, keyword) {
    const record = records[recordIndex];
    if (!record || !record.messages || !keyword) return [];

    // 归一化搜索关键词：所有空白折叠为单个空格，并去除首尾空白
    const normalizedKeyword = keyword.replace(/\s+/g, ' ').trim();
    if (!normalizedKeyword) return [];
    // 大小写不敏感搜索
    const lowerKeyword = normalizedKeyword.toLowerCase();

    const matches = [];

    record.messages.forEach((msg, msgIdx) => {
        if (typeof msg.content !== 'string') return;
        const content = msg.content;
        // 归一化消息内容（空白折叠 + 偏移映射）
        const { normalized, map } = normalizeTextWithMap(content);
        const lowerContent = normalized.toLowerCase();

        let pos = 0;
        // 快速通道：归一化内容中没有关键词则跳过该消息
        const firstIdx = lowerContent.indexOf(lowerKeyword);
        if (firstIdx === -1) return;

        // 遍历所有出现位置（最多保护 5000 处，防止极端重复文本拖慢）
        let count = 0;
        while (pos <= normalized.length && count < 5000) {
            const idx = lowerContent.indexOf(lowerKeyword, pos);
            if (idx === -1) break;
            // 将归一化内容中的匹配偏移映射回原始内容偏移
            const origStart = map[idx];
            const normEnd = idx + normalizedKeyword.length;
            const origEnd = map[normEnd - 1] + 1;
            matches.push({ msgIdx, start: origStart, end: origEnd });
            pos = idx + normalizedKeyword.length;
            count++;
        }
    });

    return matches;
}

/**
 * 清除所有搜索高亮 <mark>（普通黄色匹配 + 当前橙色命中），恢复原始文本节点
 */
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

/**
 * 将当前命中的橙色高亮降级为普通黄色高亮（保留在 DOM 中）
 * 供导航跳转时复用已绘制的黄色高亮，避免全量重绘卡顿。
 * 与 clearSearchHighlights 不同：它不删除 mark，只切换 CSS 类名，
 * 因此旧命中重新变回黄色，折叠消息中的旧命中在重新展开后也保留黄色高亮。
 * 降级时记录旧命中的 matchIdx，保证后续跳回该位置时能被 removeYellowMarkByMatchIdx 找到。
 * @param {number} [oldMatchIdx] 旧命中的 matchIdx（可选，用于记录标记）
 */
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

/**
 * 删除指定 matchIdx 的黄色普通匹配 mark（目标位置将由橙色覆盖绘制）
 * @param {number} matchIdx 匹配在 matches 中的下标
 */
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

/**
 * 在指定消息的内容区域中，将字符偏移 [start, end) 对应的文本包裹为 <mark>
 * 使用 TreeWalker 遍历 text node 精确定位偏移。
 * @param {HTMLElement} contentEl .rmsg-content 元素
 * @param {number} start 起始偏移（相对该消息的纯文本）
 * @param {number} end 结束偏移
 * @param {string} [className='rlog-search-mark-current'] <mark> 的 CSS 类名（普通匹配用黄色，当前命中用橙色）
 * @returns {HTMLElement|null} 创建的 <mark> 元素，失败返回 null
 */
function highlightRange(contentEl, start, end, className = 'rlog-search-mark-current') {
    if (!contentEl || start < 0 || end <= start) return null;

    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
    let currentOffset = 0;
    let node = null;

    // 找到包含 start 偏移的文本节点
    while ((node = walker.nextNode())) {
        const nodeLen = node.textContent.length;
        if (currentOffset + nodeLen > start) break;
        currentOffset += nodeLen;
    }
    if (!node) return null;

    // 在该节点内拆分：before / mark / after
    const nodeStart = currentOffset;
    const splitStart = start - nodeStart;
    const splitEnd = end - nodeStart;

    if (splitEnd > node.textContent.length) {
        // 跨节点边界的情况（关键词跨多个 text node），简化处理：只取当前节点内可匹配部分
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

/**
 * 高亮本条记录内所有匹配位置（黄色），但不包括当前命中（当前命中由 applyCurrentMatch 单独绘制橙色）
 * 同一消息内按 start 降序处理，避免先插入的 mark 影响后续文本偏移计算。
 * @param {HTMLElement} recordEl 当前记录的 DOM 元素
 * @param {number} recordIndex 记录索引
 */
function highlightAllMatches(recordEl, recordIndex) {
    if (!searchState || !recordEl) return;
    const record = records[recordIndex];
    if (!record) return;

    // 按消息分组（跳过当前命中，橙色单独绘制）
    // 同时保留每个匹配在 matches 中的下标，供黄色 mark 记录 data-match-idx
    const matchesByMsg = new Map();
    searchState.matches.forEach((match, idx) => {
        if (idx === searchState.currentIdx) return;
        if (!matchesByMsg.has(match.msgIdx)) matchesByMsg.set(match.msgIdx, []);
        matchesByMsg.get(match.msgIdx).push({ match, idx });
    });

    matchesByMsg.forEach((msgMatches, msgIdx) => {
        const msg = record.messages[msgIdx];
        if (!msg) return;
        // 确保消息展开（搜索高亮需要可见内容区）
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

        // 同一消息内按 start 降序处理，避免 mark 插入影响后续偏移
        msgMatches.sort((a, b) => b.match.start - a.match.start);
        msgMatches.forEach(({ match, idx }) => {
            const markEl = highlightRange(contentEl, match.start, match.end, 'rlog-search-mark');
            // 记录匹配下标，供 removeYellowMarkByMatchIdx 准确定位要删除的黄色 mark
            if (markEl) markEl.dataset.matchIdx = String(idx);
        });
    });
}

/**
 * 将当前命中滚动到视野内舒适位置
 * 步骤：
 *   1. 滚动所在消息的 .rmsg-content 内部，使匹配出现在该滚动容器中
 *   2. 手动计算 .rlog-list 的 scrollTop，让消息区域出现在固定标题栏下方
 * 说明：不使用 scrollIntoView——它会递归滚动所有可滚动祖先容器，
 *       在移动端会连带滚动 ST 主界面（body/#sheld 等），造成整个界面位移。
 * @param {HTMLElement} markEl 当前高亮的 <mark> 元素
 * @param {HTMLElement} contentEl 所在 .rmsg-content 元素
 */
function scrollToMatch(markEl, contentEl) {
    if (!markEl || !contentEl) return;

    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    if (!listEl) return;

    // 1. 消息内部滚动：将 mark 对齐到 contentEl 可视区域中部偏上
    const contentRect = contentEl.getBoundingClientRect();
    const markRect = markEl.getBoundingClientRect();
    const contentScrollTop = contentEl.scrollTop;
    const relativeTop = markRect.top - contentRect.top + contentScrollTop;
    // 目标位置：距消息内容区顶部约 25% 高度处（视觉舒适区）
    const targetScroll = relativeTop - contentRect.height * 0.25;
    const clampedContentScroll = Math.max(0, targetScroll);
    contentEl.scrollTo({ top: clampedContentScroll, behavior: 'smooth' });

    // 2. 外层列表滚动：手动定位，避免 scrollIntoView 联动滚动 ST 主界面
    // 内层平滑滚动尚未完成，但 mark 在 list 中的逻辑位置可由滚动增量推算：
    //   内层滚动 delta > 0 时内容上移，mark 视觉上移 delta
    //   滚动后的 mark 视觉 top = markRect.top - delta
    // 期望 mark 出现在所有 sticky 标题栏（记录标题栏 + 消息标题栏）下方 8px 处
    const delta = clampedContentScroll - contentScrollTop;
    const markFinalTop = markRect.top - delta;
    const listRect = listEl.getBoundingClientRect();

    // 累加两个 sticky 标题栏的高度（吸顶时占用的垂直空间），而非固定 48px：
    // - .rlog-record-header：吸在列表顶部（高约 40px）
    // - .rmsg-header：吸在记录标题栏下方（高约 32px+）
    // 用 offsetHeight 实测可自动兼容桌面/移动端不同高度，以及移动端标题栏换行变高。
    // 注意：不能测量 getBoundingClientRect().bottom 的视觉位置——
    // 当 mark 所在消息不在视口内时其 header 并未吸顶，bottom 会位于视口外很远，
    // 导致目标 scrollTop 被 clamp 到 0（列表滚回顶部）。offsetHeight 不受吸顶状态影响。
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

    // mark 在列表内容中的逻辑位置（不受滚动状态影响）
    const markInList = listEl.scrollTop + markFinalTop - listRect.top;
    // 目标：mark 出现在标题栏下方、列表可视区域约 1/3 高度处（视觉舒适区）
    // 可见内容高度 = 列表可视高度 - sticky 标题栏占用的高度
    const visibleHeight = Math.max(0, listEl.clientHeight - stickyHeight);
    const targetListScroll = markInList - stickyHeight - visibleHeight * 0.33;

    // clamp 到合法滚动范围（避免浏览器静默 clamp 导致意外跳变）
    const maxListScroll = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
    const clampedListScroll = Math.max(0, Math.min(targetListScroll, maxListScroll));

    // 仅在需要调整时滚动外层（mark 已可见时保持不动，避免触发任何外部滚动）
    if (Math.abs(clampedListScroll - listEl.scrollTop) > 1) {
        listEl.scrollTo({ top: clampedListScroll, behavior: 'smooth' });
    }
}

/**
 * 更新搜索框计数显示（如 3/18）
 */
function updateSearchCounter() {
    if (!searchState || !searchState.searchEl) return;
    const counter = searchState.searchEl.querySelector('.rlog-search-count');
    if (!counter) return;

    const total = searchState.matches.length;
    const current = total > 0 ? searchState.currentIdx + 1 : 0;
    counter.textContent = `${current}/${total}`;

    // 无结果或仅一个结果时禁用上下箭头
    const prevBtn = searchState.searchEl.querySelector('.rlog-search-prev');
    const nextBtn = searchState.searchEl.querySelector('.rlog-search-next');
    if (prevBtn) prevBtn.disabled = total <= 1;
    if (nextBtn) nextBtn.disabled = total <= 1;
}

/**
 * 在指定消息索引处执行搜索，并高亮当前命中 + 滚动到该位置
 * @param {number} msgIdx 消息索引
 * @param {number} matchIdx 匹配在 matches 中的下标
 * @param {boolean} [redrawYellowHighlights=true] 是否重绘普通匹配的黄色高亮
 *   - true（搜索词变化时）: 清除所有高亮后重新绘制全部黄色匹配
 *   - false（上下键导航时）: 只清除当前橙色命中，复用已绘制的黄色高亮（性能优化）
 */
function applyCurrentMatch(msgIdx, matchIdx, redrawYellowHighlights = true) {
    if (!searchState) return;
    const recordIndex = searchState.recordIndex;
    const record = records[recordIndex];
    if (!record || !record.messages[msgIdx]) return;

    const listEl = panelEl.querySelector('#rlog-list');
    const recordEl = listEl.querySelector(`.rlog-record[data-record-index="${recordIndex}"]`);
    if (!recordEl) return;

    if (redrawYellowHighlights) {
        // 搜索词变化：清除所有高亮（黄色匹配 + 橙色当前）后重新绘制
        clearSearchHighlights();

        // 确保记录处于展开状态
        if (record.collapsed) {
            record.collapsed = false;
            recordEl.classList.add('expanded');
            recordEl.classList.remove('collapsed');
        }

        // 高亮本条内所有匹配（黄色，跳过当前命中）
        // 同时会展开所有匹配到的折叠消息
        highlightAllMatches(recordEl, recordIndex);
    } else {
        // 导航跳转：将旧橙色的当前命中降级为黄色（保留 DOM 中的 mark，仅切换类名）
        // 复用已绘制的黄色高亮，避免全量重绘卡顿
        const oldIdx = searchState.currentIdx;
        clearCurrentHighlight(oldIdx);

        // 删除目标位置已有的黄色 mark（如果该位置之前被导航过，会残留黄色 mark）
        // 必须先删除，否则画新橙色时 DOM 偏移计算会失效
        removeYellowMarkByMatchIdx(matchIdx);

        // 确保记录处于展开状态（搜索模式打开时记录可能被折叠）
        if (record.collapsed) {
            record.collapsed = false;
            recordEl.classList.add('expanded');
            recordEl.classList.remove('collapsed');
        }
    }

    // 确保当前消息处于展开状态（折叠时内容不可见无法定位）
    const msg = record.messages[msgIdx];
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

    // 异步创建滚动条（消息刚展开，需要等布局稳定）
    setTimeout(() => createScrollbarForContent(contentEl), 50);

    const match = searchState.matches[matchIdx];
    if (!match) return;

    // 高亮当前命中（橙色）
    const markEl = highlightRange(contentEl, match.start, match.end, 'rlog-search-mark-current');

    // 更新计数
    searchState.currentIdx = matchIdx;
    updateSearchCounter();

    if (markEl) {
        scrollToMatch(markEl, contentEl);
    }
}

/**
 * 执行搜索（输入关键词变更后由 debounce 调用）
 * @param {number} recordIndex 记录索引
 * @param {string} keyword 搜索关键词
 */
function performSearch(recordIndex, keyword) {
    if (!searchState || !panelEl) return;

    // 清空上一次搜索的 matches 与高亮
    searchState.matches = findMatchesInRecord(recordIndex, keyword);
    searchState.currentIdx = -1;
    searchState.keyword = keyword;

    if (!keyword) {
        clearSearchHighlights();
        updateSearchCounter();
        return;
    }

    if (searchState.matches.length > 0) {
        // 自动跳转到第一个匹配
        searchState.currentIdx = 0;
        applyCurrentMatch(searchState.matches[0].msgIdx, 0);
    } else {
        // 无匹配：清除高亮，计数显示 0/0
        clearSearchHighlights();
        updateSearchCounter();
    }
}

/**
 * 跳转到下一个/上一个匹配
 * @param {number} direction 1=下一个, -1=上一个
 */
function navigateSearch(direction) {
    if (!searchState || !searchState.matches || searchState.matches.length === 0) return;

    const total = searchState.matches.length;
    let nextIdx = searchState.currentIdx + direction;
    // 循环跳转
    if (nextIdx >= total) nextIdx = 0;
    if (nextIdx < 0) nextIdx = total - 1;

    const match = searchState.matches[nextIdx];
    // 第三个参数 false：导航跳转时只清除橙色当前命中，复用已绘制的黄色高亮（性能优化）
    applyCurrentMatch(match.msgIdx, nextIdx, false);
}

/**
 * 关闭搜索框并重置搜索状态
 */
function closeSearch() {
    resetSearchIfActive();
}

/**
 * 为指定记录打开搜索模式（排他原则：一次仅一条记录处于搜索状态）
 * 点击记录操作区中的放大镜按钮时触发。
 * @param {number} recordIndex 记录索引
 */
function openSearchForRecord(recordIndex) {
    if (!panelEl) return;
    // 排他：先关闭任何已有的搜索（包含其它记录或本记录）
    resetSearchIfActive();

    const listEl = panelEl.querySelector('#rlog-list');
    const recordEl = listEl.querySelector(`.rlog-record[data-record-index="${recordIndex}"]`);
    if (!recordEl) return;

    const actionsEl = recordEl.querySelector('.rlog-record-actions');
    const actionsInner = recordEl.querySelector('.rlog-record-actions-inner');
    if (!actionsEl || !actionsInner) return;

    // 标记记录为「搜索中」（CSS 隐藏除放大镜外的其他操作按钮与下箭头，
    // 释放空间给搜索框向右展开覆盖）
    recordEl.classList.add('rlog-searching');

    // 隐藏记录折叠/展开箭头（▾）—— 用 visibility 保留其空间占位，
    // 配合 CSS 固定 actions-inner 宽度，保证放大镜位置不被推移
    const toggleIcon = recordEl.querySelector('.rlog-toggle-icon');
    if (toggleIcon) toggleIcon.style.visibility = 'hidden';

    // 若记录处于折叠状态，自动展开（搜索高亮需要可见内容区）
    const record = records[recordIndex];
    if (record && record.collapsed) {
        record.collapsed = false;
        recordEl.classList.add('expanded');
        recordEl.classList.remove('collapsed');
        // 展开后为消息内容区懒创建进度条（仅视口内立即创建，其余延迟）
        queueScrollbarsForEls(recordEl.querySelectorAll('.rmsg-content'));
    }

    // 构建搜索框 DOM（不含放大镜：普通放大镜按钮保持原位作为视觉锚点，
    // 搜索框紧随其右侧展开，占用被隐藏按钮释放的空间）
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

    // 插入到放大镜按钮右侧（放大镜保持原位，搜索框向右展开）
    const searchBtn = actionsInner.querySelector('.rlog-search-btn');
    if (searchBtn) {
        searchBtn.insertAdjacentElement('afterend', searchBox);
    } else {
        actionsInner.appendChild(searchBox);
    }

    // 初始化搜索状态
    searchState = {
        recordIndex,
        keyword: '',
        matches: [],
        currentIdx: -1,
        searchEl: searchBox,
    };

    // 绑定搜索框内部事件
    const input = searchBox.querySelector('.rlog-search-input');
    const prevBtn = searchBox.querySelector('.rlog-search-prev');
    const nextBtn = searchBox.querySelector('.rlog-search-next');

    /** @type {boolean} 输入法组合状态标志（拼音未上屏时 input 事件不触发搜索） */
    let isComposing = false;
    /** 防抖搜索调度函数：input 事件与 compositionend 共用 */
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

    // 输入法组合开始：置标志，组合期间的 input 事件全部跳过
    input.addEventListener('compositionstart', () => { isComposing = true; });
    // 输入法组合结束（文字已上屏）：清除标志并补一次搜索（组合期间可能错过了 input）
    input.addEventListener('compositionend', () => {
        isComposing = false;
        scheduleSearch();
    });

    // 输入实时搜索（debounce 防抖），组合阶段跳过
    input.addEventListener('input', (e) => {
        if (isComposing || e.isComposing || e.keyCode === 229) return;
        scheduleSearch();
    });

    // 键盘快捷键：Enter 下一个 / Shift+Enter 上一个 / Esc 关闭
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

    // 自动聚焦输入框
    setTimeout(() => {
        if (input && searchState && searchState.searchEl === searchBox) {
            input.focus();
        }
    }, 50);
}

function getFullPromptText(record) {
    return record.messages
        .map((m) => `[${m.role}]: ${m.content}`)
        .join('\n\n');
}

function getTotalTokens(messages) {
    return messages.reduce((sum, m) => sum + m.tokens, 0);
}

function getRoleClass(role) {
    const map = {
        'system': 'role-system',
        'user': 'role-user',
        'assistant': 'role-assistant',
        'tool': 'role-tool',
    };
    return map[role] || 'role-other';
}

function getRoleLabel(role) {
    const map = {
        'system': 'System',
        'user': 'User',
        'assistant': 'Assistant',
        'tool': 'Tool',
    };
    return map[role] || role;
}

/**
 * 提取消息内容开头的预览文字（用于在角色标签旁边显示提示）
 * 原样保留所有文本（包括 XML 标签），跨行取内容，尽可能多地在预览中显示。
 * 换行符替换为空格（CSS white-space: nowrap 下单行显示）。
 * JS 端截断到 200 字符作为安全上限，实际视觉省略由 CSS 根据面板宽度动态处理。
 * @param {string} content 消息完整内容
 * @returns {string} 预览文字，内容为空时返回空字符串
 */
function getContentPreview(content) {
    if (!content || typeof content !== 'string') return '';
    // 将换行符替换为空格，然后去掉首尾空白
    const collapsed = content.replace(/\n/g, ' ').trim();
    if (!collapsed) return '';
    // 截断到 200 字符作为安全上限，CSS 会进一步根据宽度做视觉省略
    return collapsed.length > 200 ? collapsed.slice(0, 200) + '…' : collapsed;
}

function buildMessageHtml(msg, recordIdx, msgIdx) {
    const roleClass = getRoleClass(msg.role);
    const roleLabel = getRoleLabel(msg.role);
    const collapsedClass = msg.collapsed ? 'collapsed' : 'expanded';
    // tokenPrecise 为 true 表示使用了 ST 原生分词器的精确值，不显示 ~ 估算标记
    const tokenPrefix = msg.tokenPrecise ? '' : '~';
    // 内容预览文字（仅当开关开启时显示，或处于强制预览演示状态）
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

    // 重建 DOM 前必须先清理搜索状态（搜索高亮、搜索框引用旧 DOM 节点会失效）
    resetSearchIfActive();

    const listEl = panelEl.querySelector('#rlog-list');
    if (!listEl) return;

    const countEl = panelEl.querySelector('.rlog-title-count');
    if (countEl) {
        countEl.textContent = `${records.length} / ${MAX_RECORDS}`;
    }

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

    listEl.innerHTML = records
        .map((rec, idx) => {
            const totalTokens = getTotalTokens(rec.messages);
            const collapsedClass = rec.collapsed ? 'collapsed' : 'expanded';
            const sourceLabel = getSourceLabel(rec.source);
            const sourceClass = getSourceClass(rec.source);
            const sourceTitle = (rec.source && rec.source.detail) || sourceLabel;

            // 判断整条记录是否所有消息都使用了精确 token（非估算值）
            const allPrecise = rec.messages.every(m => m.tokenPrecise === true);
            const recordTokenPrefix = allPrecise ? '' : '~';

            const messagesHtml = rec.messages
                .map((msg, mIdx) => buildMessageHtml(msg, idx, mIdx))
                .join('');

            return `
                <div class="rlog-record ${collapsedClass}" data-record-index="${idx}">
                    <div class="rlog-record-header">
                        <div class="rlog-record-info">
                            <span class="rlog-char-name">${escapeHtml(rec.characterName)}</span>
                            <span class="rlog-source-badge ${sourceClass}" title="${escapeHtml(sourceTitle)}"><span class="rlog-status-dot"></span>${escapeHtml(sourceLabel)}</span>
                            <span class="rlog-time">${escapeHtml(rec.timestamp)}</span>
                            <span class="rlog-model-badge" title="请求模型">${escapeHtml(rec.modelName || '未知模型')}</span>
                            <span class="rlog-total-tokens">${recordTokenPrefix}${totalTokens} tokens / ${rec.messages.length} 条消息</span>
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
                                <button class="rlog-copy-all-btn" data-record="${idx}" title="复制整条记录">
                                    <i class="fa-solid fa-copy"></i>
                                </button>
                                <button class="rlog-delete-record-btn" data-record="${idx}" title="删除本条记录">
                                    <i class="fa-solid fa-trash-can"></i>
                                </button>
                            </div>
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

    // 为消息内容区创建 overlay 进度条
    attachScrollIndicators(listEl);

    // 渲染完成，清除脏标记（下次打开面板时无需重建 DOM）
    panelContentDirty = false;
}

/**
 * 滚动锚定包装器：在执行展开/折叠动作前后记录元素位置，
 * 并反向补偿滚动条，使目标元素在视口中保持绝对静止。
 * @param {HTMLElement} anchorEl 需要在视口中保持静止的锚点元素
 * @param {Function} action 执行导致高度变化的 DOM 操作
 */
function preserveScrollTop(action) {
    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    if (!listEl) { action(); return; }
    const saved = listEl.scrollTop;
    action();
    listEl.scrollTop = saved;
}

function bindListEvents(listEl) {
    listEl.querySelectorAll('.rmsg-header').forEach((header) => {
        header.addEventListener('click', function (e) {
            if (e.target.closest('button')) return;
            const msgItem = this.closest('.rmsg-item');
            const recIdx = Number(msgItem.dataset.record);
            const msgIdx = Number(msgItem.dataset.msg);
            preserveScrollTop(() => {
                toggleMessageCollapse(recIdx, msgIdx, msgItem);
            });
        });
    });

    listEl.querySelectorAll('.rlog-record-header').forEach((header) => {
        /** @type {boolean} 本次按下的起点是否在搜索框内（拖动选中文字越界时不触发折叠） */
        let mouseDownInSearchBox = false;
        header.addEventListener('mousedown', (e) => {
            mouseDownInSearchBox = e.target.closest('.rlog-search-box') !== null;
        });
        header.addEventListener('touchstart', (e) => {
            mouseDownInSearchBox = e.target.closest('.rlog-search-box') !== null;
        });
        header.addEventListener('click', function (e) {
            if (e.target.closest('button')) return;
            // 搜索框区域（输入框/计数/空白）不触发折叠/展开，保持搜索状态稳定
            if (e.target.closest('.rlog-search-box')) return;
            // 从搜索框内按下并拖动到外部松开时，click 目标为两者的共同祖先（header），
            // 此时不应触发折叠/展开，否则拖动选中文字越界会意外取消搜索面板
            if (mouseDownInSearchBox) return;
            const recordEl = this.closest('.rlog-record');
            const idx = Number(recordEl.dataset.recordIndex);
            // 展开/折叠单条记录时保持滚动位置不变（标题栏固定在视口，内容只向下展开）
            preserveScrollTop(() => {
                toggleRecordCollapse(idx, recordEl);
            });
        });
    });

    listEl.querySelectorAll('.rlog-search-btn').forEach((btn) => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const idx = Number(this.dataset.record);
            // 放大镜点击逻辑：
            // - 未展开搜索菜单时 → 开启搜索菜单
            // - 已展开当前记录的搜索菜单 → 关闭搜索菜单
            // - 已展开其他记录的搜索菜单 → 关闭其他记录并开启当前记录的搜索
            if (searchState && searchState.recordIndex === idx) {
                closeSearch();
            } else {
                openSearchForRecord(idx);
            }
        });
    });

    listEl.querySelectorAll('.rlog-copy-all-btn').forEach((btn) => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const idx = Number(this.dataset.record);
            copyFullRecord(idx, this);
        });
    });

    listEl.querySelectorAll('.rlog-msg-collapse-btn').forEach((btn) => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const idx = Number(this.dataset.record);
            preserveScrollTop(() => {
                collapseRecordMessages(idx);
            });
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

    listEl.querySelectorAll('.rlog-delete-record-btn').forEach((btn) => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const idx = Number(this.dataset.record);
            const record = records[idx];
            if (!record) return;

            // 确认后再删除，避免误触
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

    listEl.querySelectorAll('.rmsg-copy-btn').forEach((btn) => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const recIdx = Number(this.dataset.record);
            const msgIdx = Number(this.dataset.msg);
            copySingleMessage(recIdx, msgIdx, this);
        });
    });
}

function toggleRecordCollapse(index, recordEl) {
    // 折叠记录时退出搜索模式（折叠会改变内容区可见性，搜索状态不应保留）
    resetSearchIfActive();
    records[index].collapsed = !records[index].collapsed;
    if (records[index].collapsed) {
        recordEl.classList.add('collapsed');
        recordEl.classList.remove('expanded');
    } else {
        recordEl.classList.add('expanded');
        recordEl.classList.remove('collapsed');
        // 展开记录后，为消息内容区懒创建进度条（仅视口内立即创建，其余延迟）
        queueScrollbarsForEls(recordEl.querySelectorAll('.rmsg-content'));
    }
}

function toggleMessageCollapse(recIdx, msgIdx, msgItem) {
    // 折叠/展开消息属于单条记录内部操作，不退出搜索模式
    //（搜索高亮保留在 DOM 中，折叠只是隐藏内容，展开后自动恢复可见）
    records[recIdx].messages[msgIdx].collapsed = !records[recIdx].messages[msgIdx].collapsed;
    if (records[recIdx].messages[msgIdx].collapsed) {
        msgItem.classList.add('collapsed');
        msgItem.classList.remove('expanded');
    } else {
        msgItem.classList.add('expanded');
        msgItem.classList.remove('collapsed');
        // 展开消息后，内容区回到顶部
        const contentEl = msgItem.querySelector('.rmsg-content');
        if (contentEl) {
            contentEl.scrollTop = 0; // 折叠后再展开时，从消息内容顶部开始看
            createScrollbarForContent(contentEl);
        }
    }
}

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
        // 恢复时使用 auto 高度，让内容驱动窗口高度（受 CSS min-height / max-height 约束），
        // 否则固定像素高度会阻止记录增多时的窗口自动扩展
        panelEl.style.height = 'auto';
        panelEl.style.minHeight = '';
        panelEl.style.maxHeight = '80vh';
        delete panelEl.dataset.rlogSavedWidth;
        delete panelEl.dataset.rlogSavedHeight;
        panelEl.classList.remove('rlog-window-collapsed');
    }
}

/**
 * 标题栏「折叠所有条目」按钮 — 将所有记录折叠，同时将每条记录内的所有消息也折叠
 */
function collapseAllEntries() {
    // 折叠全部条目前退出搜索模式
    resetSearchIfActive();
    if (records.length === 0) return;
    records.forEach((r, i) => {
        r.collapsed = true;
        // 折叠该记录内的所有消息
        r.messages.forEach(m => { m.collapsed = true; });
        const recordEl = panelEl.querySelector(`.rlog-record[data-record-index="${i}"]`);
        if (recordEl) {
            recordEl.classList.add('collapsed');
            recordEl.classList.remove('expanded');
            // 折叠所有消息 DOM
            recordEl.querySelectorAll('.rmsg-item').forEach(el => {
                el.classList.add('collapsed');
                el.classList.remove('expanded');
            });
        }
    });
    // 折叠全部后回到顶部最新一条
    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    if (listEl) listEl.scrollTop = 0;
}

/**
 * 单条记录「折叠所有消息」按钮 — 折叠本条记录内所有角色的消息
 * @param {number} index 记录索引
 */
function collapseRecordMessages(index) {
    // 折叠本条记录的所有消息前退出搜索模式（搜索中的消息折叠后高亮无意义）
    resetSearchIfActive();
    const record = records[index];
    if (!record || !record.messages) return;

    // 更新数据状态：全部折叠
    record.messages.forEach(m => { m.collapsed = true; });

    // 更新 DOM
    const recordEl = panelEl.querySelector(`.rlog-record[data-record-index="${index}"]`);
    if (recordEl) {
        recordEl.querySelectorAll('.rmsg-item').forEach(el => {
            el.classList.add('collapsed');
            el.classList.remove('expanded');
        });
    }
}

/**
 * 单条记录「展开所有消息」按钮 — 展开本条记录内所有角色的消息
 * @param {number} index 记录索引
 */
function expandRecordMessages(index) {
    const record = records[index];
    if (!record || !record.messages) return;

    // 更新数据状态：全部展开
    record.messages.forEach(m => { m.collapsed = false; });

    // 更新 DOM
    const recordEl = panelEl.querySelector(`.rlog-record[data-record-index="${index}"]`);
    if (recordEl) {
        recordEl.querySelectorAll('.rmsg-item').forEach(el => {
            el.classList.add('expanded');
            el.classList.remove('collapsed');
        });
        // 为消息内容区懒创建进度条（仅视口内立即创建，其余延迟）
        queueScrollbarsForEls(recordEl.querySelectorAll('.rmsg-content'));
    }
}

/**
 * 单条记录「删除」按钮 — 从列表中移除本条记录
 * @param {number} index 记录索引
 */
function deleteRecord(index) {
    if (index < 0 || index >= records.length) return;
    records.splice(index, 1);
    panelContentDirty = true;
    if (panelEl && isPanelVisible) {
        renderPanelContent();
    }
}

// ── 复制功能 ────────────────────────────────────

async function copyFullRecord(index, btnEl) {
    const record = records[index];
    if (!record) return;
    const text = getFullPromptText(record);
    await doCopy(text, btnEl);
}

async function copySingleMessage(recIdx, msgIdx, btnEl) {
    const msg = records[recIdx] && records[recIdx].messages ? records[recIdx].messages[msgIdx] : null;
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

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}


// ── Overlay 进度条（自定义滚动条） ──────────────────

/**
 * 存储每个 .rmsg-content 对应的进度条清理数据
 * Map key: contentEl -> { scrollHandler, hitboxEl, thumbEl }
 */
const scrollbarCleanups = new Map();

/** @type {Set<HTMLElement>} 所有已创建进度条的 .rmsg-content 元素（供共享 ResizeObserver 批量更新） */
const scrollbarElements = new Set();

/** @type {Set<HTMLElement>} 等待进入视口后懒创建进度条的 .rmsg-content 元素 */
const pendingScrollbarContentEls = new Set();

/** @type {ResizeObserver|null} 共享 ResizeObserver：所有进度条共用一个，替代每元素一个 */
let sharedResizeObserver = null;

/** @type {IntersectionObserver|null} 懒创建进度条的 IntersectionObserver */
let scrollbarLazyObserver = null;

/** @type {boolean} 是否已有 RAF 排队更新 thumb */
let thumbUpdateQueued = false;

/** @type {boolean} 是否等待全量更新所有进度条（ResizeObserver 触发） */
let thumbFullUpdatePending = false;

/** @type {HTMLElement|null} 单个需要更新 thumb 的 contentEl（scroll 事件触发） */
let thumbPendingElement = null;

/**
 * 确保共享 ResizeObserver 已创建
 * 所有进度条统一由它监听，回调中批量更新 thumb，避免 100+ 个独立 ResizeObserver 的额外开销
 */
function ensureSharedResizeObserver() {
    if (sharedResizeObserver) return;
    sharedResizeObserver = new ResizeObserver(() => {
        // 任一内容区尺寸变化：全量更新所有进度条的 thumb
        // 回调本身由浏览器在布局后批量触发，这里再合并到同一 RAF 帧
        requestThumbUpdate();
    });
}

/**
 * 确保懒创建 IntersectionObserver 已创建
 * 进度条只在内容区进入视口（或接近视口）时才创建，
 * 避免展开 100+ 消息时瞬间创建 100+ 进度条导致的同步 layout 卡顿。
 * rootMargin 200px：提前创建，保证滚动到之前进度条已就绪。
 */
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

/**
 * 请求更新进度条 thumb 位置（RAF 批处理）
 * - 不传参：全量更新所有活跃进度条（ResizeObserver 触发）
 * - 传 contentEl：只更新该元素对应的进度条（scroll 事件触发）
 * 同一帧内多次请求合并为一次更新，避免高频事件触发连续强制 layout。
 * @param {HTMLElement} [contentEl] 需要更新的内容区元素；不传则全量更新
 */
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

/**
 * 根据 contentEl 当前滚动状态更新其进度条 thumb 位置
 * @param {HTMLElement} contentEl 内容区元素
 * @param {object} cleanup 该进度条的清理数据（含 hitboxEl/thumbEl）
 */
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

    // hitbox 对齐 contentEl 的位置（因为挂载在 .rmsg-item 上而非 contentEl 内部）
    const contentTop = contentEl.offsetTop;
    hitbox.style.top = contentTop + 'px';
    hitbox.style.height = clientHeight + 'px';

    // 轨道可用高度（track 的 top:4px, bottom:4px）
    const trackHeight = clientHeight - 8;

    // 滑块高度 = 可见比例 × 轨道高度，最小 20px
    const thumbRatio = clientHeight / scrollHeight;
    const thumbHeight = Math.max(20, thumbRatio * trackHeight);
    thumb.style.height = thumbHeight + 'px';

    // 滑块可移动范围
    const thumbRange = trackHeight - thumbHeight;

    // 滑块位置 = 当前滚动比例 × 可移动范围
    const thumbTop = maxScroll > 0 ? (scrollTop / maxScroll) * thumbRange : 0;
    thumb.style.top = thumbTop.toFixed(1) + 'px';
}

/**
 * 为一批 .rmsg-content 元素按需（懒加载）创建进度条
 * 元素进入视口或接近视口时才真正创建进度条。
 * 已在观察队列中或有进度条的元素自动跳过。
 * @param {NodeListOf<HTMLElement>|HTMLElement[]|Array} contentEls 内容区元素集合
 */
function queueScrollbarsForEls(contentEls) {
    ensureScrollbarLazyObserver();
    contentEls.forEach((contentEl) => {
        if (!contentEl || !contentEl.classList || !contentEl.classList.contains('rmsg-content')) return;
        if (pendingScrollbarContentEls.has(contentEl)) return;
        if (scrollbarCleanups.has(contentEl)) return;
        pendingScrollbarContentEls.add(contentEl);
        scrollbarLazyObserver.observe(contentEl);
    });
}

/**
 * 为单个 .rmsg-content 元素创建 overlay 进度条
 * @param {HTMLElement} contentEl .rmsg-content 元素
 */
function createScrollbarForContent(contentEl) {
    // 先清理已有进度条（避免重复创建）
    detachScrollbarForContent(contentEl);

    // 内容不需要滚动时不需要进度条
    // 注意：这里读取 scrollHeight 布局值不可避免，但仅在进入视口时才执行（懒创建 + 单个元素）
    if (contentEl.scrollHeight <= contentEl.clientHeight) return;

    // 挂载目标：.rmsg-item（contentEl 的父容器），而不是 contentEl 内部
    // 这样 hitbox 使用 position: absolute 定位时不会随 contentEl 滚动而移出视口
    const container = contentEl.parentElement;
    if (!container || !container.classList.contains('rmsg-item')) return;

    // 确保容器有 position: relative 作为定位参考
    const currentPosition = getComputedStyle(container).position;
    if (currentPosition === 'static') {
        container.style.position = 'relative';
    }

    // --- 创建 DOM 结构 ---
    const hitbox = document.createElement('div');
    hitbox.className = 'rlog-scroll-hitbox';

    const track = document.createElement('div');
    track.className = 'rlog-scroll-track';

    const thumb = document.createElement('div');
    thumb.className = 'rlog-scroll-thumb';

    const dot = document.createElement('div');
    dot.className = 'rlog-scroll-dot';

    // dot 作为 hitbox 的直接子元素（与 track 平级），避免被 track 的 overflow:hidden 裁剪
    track.appendChild(thumb);
    hitbox.appendChild(track);
    hitbox.appendChild(dot);
    container.appendChild(hitbox);

    // 记录到活跃元素集合（供共享 ResizeObserver 批量更新）
    scrollbarElements.add(contentEl);

    // 创建清理数据（scrollbarCleanups 注册后即可被 requestThumbUpdate 使用）
    const cleanup = {
        scrollHandler: null,
        hitboxEl: hitbox,
        thumbEl: thumb,
    };

    // 初始更新：合并到 RAF 批处理（当前帧剩余 layout 在下一帧统一完成）
    // 注意：需要先注册 cleanup 才能被 updateScrollbarThumb 找到
    scrollbarCleanups.set(contentEl, cleanup);
    requestThumbUpdate(contentEl);

    // 监听滚动事件（RAF 批处理，避免高频滚动触发连续强制 layout）
    const onScroll = () => requestThumbUpdate(contentEl);
    cleanup.scrollHandler = onScroll;
    contentEl.addEventListener('scroll', onScroll, { passive: true });

    // 确保共享 ResizeObserver 已注册覆盖此元素
    ensureSharedResizeObserver();
    if (sharedResizeObserver) {
        try {
            sharedResizeObserver.observe(contentEl);
        } catch (e) { /* ignore */ }
    }

    // --- 交互：pointer 事件 ---
    // 圆点跟随手指位置（不跟随 thumb），可到达轨道两端
    /** @type {boolean} 是否正在拖拽 */
    let dragging = false;
    /** @type {number|null} 当前 pointerId（用于 pointer capture） */
    let capturedPointerId = null;

    /**
     * 根据 clientY 计算圆点在 hitbox 内的 top 值（限制在轨道范围内）
     * @param {number} clientY 指针的页面 Y 坐标
     * @returns {number} dot 的 style.top 值（相对于 hitbox）
     */
    function clientYToDotTop(clientY) {
        const hitboxRect = hitbox.getBoundingClientRect();
        // 手指相对 hitbox 顶部的 Y 偏移（dot 是 hitbox 子元素，style.top 相对于 hitbox）
        let relativeY = clientY - hitboxRect.top;

        // 【可调参数】TRACK_PADDING — 轨道距 hitbox 边缘的间距
        // 必须与 CSS 中 .rlog-scroll-track 的 top/bottom 值保持一致
        const TRACK_PADDING = 4;          // CSS: .rlog-scroll-track { top: 4px; bottom: 4px; }
        const trackTop = TRACK_PADDING;
        const trackBottom = hitboxRect.height - TRACK_PADDING;
        relativeY = Math.max(trackTop, Math.min(trackBottom, relativeY));

        // 【可调参数】DOT_HALF — 圆点高度的一半
        // 必须与 CSS 中 .rlog-scroll-dot 的 height 值保持一致 (height/2)
        const DOT_HALF = 2.5;               // CSS: .rlog-scroll-dot { height: 6px; } → 6/2=3
        return (relativeY - DOT_HALF) + 'px';
    }

    /**
     * 根据圆点位置反推内容滚动位置
     * @param {number} clientY 指针的页面 Y 坐标
     * @returns {number} 对应的 scrollTop 值
     */
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

        // 圆点在轨道中的比例（0~1）
        const ratio = (relativeY - trackTop) / trackHeight;
        return Math.round(ratio * maxScroll);
    }

    function onPointerDown(e) {
        // 只处理主按钮（鼠标左键或触摸）
        if (e.button !== undefined && e.button !== 0) return;

        dragging = true;
        capturedPointerId = e.pointerId;
        hitbox.setPointerCapture(e.pointerId);
        hitbox.classList.add('active');

        // 立即将圆点定位到按下位置，并滚动到对应位置
        dot.style.top = clientYToDotTop(e.clientY);
        contentEl.scrollTop = dotPositionToScroll(e.clientY);
        e.preventDefault();
    }

    function onPointerMove(e) {
        if (!dragging) return;

        const maxScroll = contentEl.scrollHeight - contentEl.clientHeight;
        if (maxScroll <= 0) return;

        // 圆点跟随手指
        dot.style.top = clientYToDotTop(e.clientY);
        // 内容滚动跟随圆点
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
    // lostpointercapture 作为兜底清理
    hitbox.addEventListener('lostpointercapture', onPointerUp);

}

/**
 * 移除单个 .rmsg-content 的 overlay 进度条并清理资源
 * @param {HTMLElement} contentEl .rmsg-content 元素
 */
function detachScrollbarForContent(contentEl) {
    const cleanup = scrollbarCleanups.get(contentEl);
    if (!cleanup) return;

    // 移除 scroll 事件监听
    contentEl.removeEventListener('scroll', cleanup.scrollHandler);
    // 若该元素被共享 ResizeObserver 监听，解除监听
    if (sharedResizeObserver) {
        try { sharedResizeObserver.unobserve(contentEl); } catch (e) { /* ignore */ }
    }
    // 从活跃集合与懒观察集合中移除
    scrollbarElements.delete(contentEl);
    pendingScrollbarContentEls.delete(contentEl);
    if (scrollbarLazyObserver) {
        try { scrollbarLazyObserver.unobserve(contentEl); } catch (e) { /* ignore */ }
    }
    // 从 DOM 中移除 hitbox
    if (cleanup.hitboxEl && cleanup.hitboxEl.parentNode) {
        cleanup.hitboxEl.remove();
    }
    scrollbarCleanups.delete(contentEl);
}

/**
 * 为列表中的所有 .rmsg-content 创建 overlay 进度条
 * 用于 renderPanelContent 后挂载，也用于展开/折叠后刷新
 * 改为懒创建：所有 .rmsg-content 进入视口（或接近视口）时才创建进度条，
 * 避免展开/重新渲染大量消息时一次性创建大量进度条导致的卡顿。
 * @param {HTMLElement} listEl 列表容器元素
 */
function attachScrollIndicators(listEl) {
    // 清理所有已有进度条（因为 renderPanelContent 使用 innerHTML 重建了 DOM）
    scrollbarCleanups.forEach((_, contentEl) => {
        detachScrollbarForContent(contentEl);
    });

    // 所有 .rmsg-content 进入懒创建观察队列（IntersectionObserver 自动按视口按需创建）
    queueScrollbarsForEls(listEl.querySelectorAll('.rmsg-content'));
}


// ── 面板控制 ────────────────────────────────────

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

    // 延迟重新 append，确保在所有同步初始化的插件之后排在末尾
    // appendChild 对已存在的节点会将其移动到容器末尾
    setTimeout(() => {
        if (toggleBtn && toggleBtn.parentNode) {
            toggleBtn.parentNode.appendChild(toggleBtn);
        }
    }, 100);
}

function buildUI() {
    if (uiBuilt) return;
    uiBuilt = true;

    addMenuEntry();

    // 加载持久化设置
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
                <span class="rlog-title-count" title="双击修改记录上限">${records.length} / ${MAX_RECORDS}</span>
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
                <button id="rlog-more-btn" class="rlog-header-btn" title="更多选项">
                    <i class="fa-solid fa-ellipsis"></i>
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

    // H4 标题文字拆分：文字部分单击折叠/展开，数字部分双击设置最大记录数
    {
        const textEl = panelEl.querySelector('.rlog-title-text');
        const countEl = panelEl.querySelector('.rlog-title-count');
        /** @type {number|null} 用于延迟判断双单击的定时器 ID（仅数字部分使用） */
        let countClickTimer = null;

        // 文字部分：单击立即折叠/展开窗口（无延迟）
        textEl.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePanelWindow();
        });

        // 数字部分：双击弹出设置对话框（单击无反应）
        countEl.addEventListener('click', (e) => {
            e.stopPropagation();

            if (countClickTimer) {
                // 第二次点击 —— 判定为双击
                clearTimeout(countClickTimer);
                countClickTimer = null;
                showMaxRecordsDialog();
                return;
            }

            // 第一次点击 —— 启动定时器，等待可能的第二次点击
            countClickTimer = setTimeout(() => {
                countClickTimer = null;
                // 单击无反应，不做任何操作
            }, DOUBLE_CLICK_THRESHOLD);
        });
    }

    const moreBtn = panelEl.querySelector('#rlog-more-btn');
    const moreDrawer = panelEl.querySelector('#rlog-more-drawer');
    moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        moreDrawer.classList.toggle('expanded');
        if (moreDrawer.classList.contains('expanded')) {
            moreBtn.classList.add('active-drawer-btn');
        } else {
            moreBtn.classList.remove('active-drawer-btn');
        }
    });

    // 全局点击监听，用于点击外部收起“更多”抽屉
    if (!document.rlogMoreDrawerListenerInstalled) {
        document.rlogMoreDrawerListenerInstalled = true;
        document.addEventListener('click', (e) => {
            if (panelEl && isPanelVisible) {
                const drawer = panelEl.querySelector('#rlog-more-drawer');
                const btn = panelEl.querySelector('#rlog-more-btn');
                if (drawer && drawer.classList.contains('expanded')) {
                    // 如果点击区域不在抽屉内，且不在更多按钮上，则收起抽屉
                    if (!drawer.contains(e.target) && !btn.contains(e.target)) {
                        drawer.classList.remove('expanded');
                        btn.classList.remove('active-drawer-btn');
                    }
                }
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
            // 没有记录时无需确认，直接提示无内容可清空
            return;
        }
        showConfirmDialog({
            title: '清空所有记录',
            message: `确定要清空全部 <strong>${records.length}</strong> 条请求记录吗？<br>此操作不可撤销。`,
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
            // 确保面板展开并且更多菜单收起
            const moreDrawer = panelEl.querySelector('#rlog-more-drawer');
            const moreBtn = panelEl.querySelector('#rlog-more-btn');
            moreDrawer.classList.remove('expanded');
            moreBtn.classList.remove('active-drawer-btn');
            
            if (isPanelCollapsed) togglePanelWindow();
            
            window.__RLogTour.start();
        }
    });

    panelEl.querySelector('#rlog-theme-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        isLightTheme = !isLightTheme;
        saveTheme(isLightTheme);
        applyTheme();
        updateThemeButtonIcon();
        
        // 触发主题切换专属缩放特效（不在打开窗口时触发）
        panelEl.classList.remove('rlog-anim-light', 'rlog-anim-dark');

        // 移动端（窄屏）禁用颜色过渡快速切换：大量展开消息时同时做 0.35s 渐变会明显卡顿，
        // 主题色在双 RAF 后瞬间切换完成再播放缩放动画；
        // 桌面端保留原有渐变特效（void offsetWidth 强制回流以重置动画状态）。
        // 注：禁用过渡不影响最终颜色，只是不播放颜色渐变过程。
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
            // 桌面端：保留渐变过渡 + 强制回流重启动画
            void panelEl.offsetWidth;
            if (isLightTheme) {
                panelEl.classList.add('rlog-anim-light');
            } else {
                panelEl.classList.add('rlog-anim-dark');
            }
        }

        // 动画结束后自动清除动画类，防止关闭再打开窗口时重新触发残留动画
        const onAnimEnd = () => {
            panelEl.classList.remove('rlog-anim-light', 'rlog-anim-dark');
            panelEl.removeEventListener('animationend', onAnimEnd);
        };
        panelEl.addEventListener('animationend', onAnimEnd);
    });
    updateThemeButtonIcon();

    // 绑定总开关
    const masterToggleBtn = panelEl.querySelector('#rlog-master-toggle');
    if (masterToggleBtn) {
        masterToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setMasterEnabled(!masterEnabled);
            e.target.blur();
        });
    }
    updateMasterToggleUI();

    // 加载并应用内容预览开关状态（持久化）
    contentPreviewEnabled = loadContentPreview();
    updatePreviewToggleUI();

    // 绑定预览开关事件
    const previewToggleEl = panelEl.querySelector('#rlog-preview-toggle');
    if (previewToggleEl) {
        previewToggleEl.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleContentPreview();
        });
    }

    makeDraggable(panelEl);
    makeResizable(panelEl);

    // 安装来源识别监听（仅记录用户原生入口，不受总开关影响）
    installSourceTracking();

    // 安装 fetch 拦截（hook 始终安装，内部通过 masterEnabled 决定是否记录）
    installFetchHook();

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
    // 仅当数据/渲染设置变化时才重建 DOM；否则保留原有 DOM，避免大量展开消息时打开面板卡顿
    if (panelContentDirty) {
        renderPanelContent();
    }

    // 在面板显示后检查是否需要进行引导
    if (window.__RLogTour && typeof window.__RLogTour.check === 'function') {
        setTimeout(() => window.__RLogTour.check(), 300);
    }
}

function hidePanel() {
    // 关闭面板时退出搜索模式
    resetSearchIfActive();
    if (panelEl) {
        panelEl.style.display = 'none';
        // 关闭面板时清理残留的主题切换动画类，防止下次打开时重播
        panelEl.classList.remove('rlog-anim-light', 'rlog-anim-dark');
    }
    isPanelVisible = false;
    if (toggleBtn) toggleBtn.classList.remove('active');
}


// ── 拖拽/缩放 ──────────────────────────────────

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
        // 跳过按钮、H4 标题及其子元素、预览开关（它们有各自的交互，不参与拖拽）
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
        }
    });

    document.addEventListener('touchend', () => {
        if (dragging) {
            dragging = false;
            el.style.transition = '';
        }
    });
}


// ── 初始化 ──────────────────────────────────────

function init() {
    if (!window.SillyTavern || typeof window.SillyTavern.getContext !== 'function') {
        console.debug(`[${PLUGIN_KEY}] 等待 SillyTavern 初始化...`);
        setTimeout(init, 200);
        return;
    }

    const ctx = window.SillyTavern.getContext();
    if (!ctx || !ctx.eventSource || !ctx.event_types) {
        console.debug(`[${PLUGIN_KEY}] ST 上下文未就绪，稍后重试...`);
        setTimeout(init, 300);
        return;
    }

    eventSource = ctx.eventSource;
    event_types = ctx.event_types;

    // 通过 APP_READY 事件或兜底 setTimeout 触发 UI 构建，但只执行一次
    const tryBuildUI = () => {
        if (!uiBuilt) buildUI();
    };

    eventSource.once(event_types.APP_READY, () => {
        tryBuildUI();
    });

    // 兜底：如果 APP_READY 已经触发过（插件后加载），直接构建 UI
    setTimeout(() => {
        tryBuildUI();
    }, 500);

    console.debug(`[${PLUGIN_KEY}] 初始化完成 - 静默监听提示词发送`);
}

init();
