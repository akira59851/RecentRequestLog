/**
 * SillyTavern 第三方插件: 最近请求记录 (Recent Request Log)
 *
 * 安装方式：将 RecentRequestLog 整个文件夹复制到
 * SillyTavern-release/public/scripts/extensions/third-party/ 目录下，
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


// ── 全局常量 ──────────────────────────────────────
const PLUGIN_KEY = 'RecentRequestLog';
const MAX_RECORDS = 10;
const STORAGE_THEME_KEY = `${PLUGIN_KEY}_theme`;
const STORAGE_MASTER_KEY = `${PLUGIN_KEY}_masterEnabled`;
const NATIVE_INTENT_WINDOW_MS = 5000;
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

/** @type {boolean} 是否为明亮模式 */
let isLightTheme = false;

/** @type {boolean} 面板窗口是否折叠 */
let isPanelCollapsed = false;

/** @type {boolean} 插件总开关是否启用（持久化到 localStorage，首次安装默认开启） */
let masterEnabled = true;

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

/**
 * 估算文本的 Token 数量
 * 中文字符按 ~0.9 个 token 估算，英文/其他字符按 4 字符 ≈ 1 token 估算
 */
function estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    let chineseChars = 0;
    let otherChars = 0;
    for (const ch of text) {
        // CJK 统一汉字范围（基本区 + 扩展A + 兼容汉字）
        if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)) {
            chineseChars++;
        } else {
            otherChars++;
        }
    }
    return Math.ceil(chineseChars * 0.9 + otherChars / 4);
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
            detail: `匹配到 ST 原生入口：${lastNativeIntent.target}`,
        };
    }

    // 窗口过期后清除原生入口标记
    if (lastNativeIntent && (now - lastNativeIntent.timestamp) > NATIVE_INTENT_WINDOW_MS) {
        lastNativeIntent = null;
    }

    return {
        type: 'plugin',
        label: '插件',
        detail: '未匹配到 ST 原生入口，按插件/非原生请求标记',
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

function addRecord(characterName, messages, source) {
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
        source: source || { type: 'plugin', label: '插件', detail: '未匹配到 ST 原生入口，按插件/非原生请求标记' },
        messages,
        collapsed: true,
    };

    records.unshift(record);
    if (records.length > MAX_RECORDS) {
        records.pop();
    }

    if (panelEl && isPanelVisible) {
        renderPanelContent();
    }
}

function clearAllRecords() {
    records = [];
    if (panelEl && isPanelVisible) {
        renderPanelContent();
    }
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
                    tokens: estimateTokens(content),
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
                    tokens: estimateTokens(content),
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
                    tokens: estimateTokens(content),
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
                tokens: estimateTokens(json.system),
                collapsed: true,
            });
        }
        for (const m of json.messages) {
            if (!isAiMessageObject(m)) continue;
            if (typeof m.content === 'string' && m.content) {
                messages.push({
                    role: normalizeRole(m.role),
                    content: m.content,
                    tokens: estimateTokens(m.content),
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
            tokens: estimateTokens(json.prompt),
            collapsed: false,
        });
    }

    if (messages.length === 0) return null;
    return messages;
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

        // ── 设置重入锁，保护后续的 body 解析和记录逻辑 ──
        fetchHookInFlight = true;
        try {
            // ── 仅对候选请求解析 body ──
            let body = null;
            if (init && init.body) {
                if (typeof init.body === 'string') {
                    try { body = JSON.parse(init.body); } catch (e) { body = null; }
                } else if (typeof init.body === 'object' && !Array.isArray(init.body)) {
                    body = init.body;
                }
            }

            if (!body && input instanceof Request) {
                try {
                    const clonedReq = input.clone();
                    const text = await clonedReq.text();
                    if (text) {
                        try { body = JSON.parse(text); } catch (e) { body = null; }
                    }
                } catch (e) { /* body 可能已被消费 */ }
            }

            // 严格请求体验证：先排除 ST 加载/切换对话等内部接口，再识别真实生成请求
            if (body && isAiRequestBody(body, requestUrl)) {
                const messages = parseFetchRequestBody(body);
                if (messages) {
                    const characterName = getCurrentCharacterName();
                    const source = inferRequestSource();
                    addRecord(characterName, messages, source);
                }
            }

            // 调用原始 fetch（通过闭包保存的引用，避免通过 window.fetch 访问导致递归）
            return originalFetch.apply(window, [input, init]);
        } finally {
            fetchHookInFlight = false;
        }
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
    // hook 始终安装（在 installFetchHook 内部通过 masterEnabled 判断是否记录），
    // 不再通过开关触发 hook 的安装/卸载，避免破坏其他插件的 fetch wrapper 链。
}

function updateMasterToggleUI() {
    const btn = panelEl ? panelEl.querySelector('#rlog-master-toggle') : null;
    if (!btn) return;
    if (masterEnabled) {
        btn.classList.add('rlog-master-on');
        btn.classList.remove('rlog-master-off');
        btn.style.color = '#4caf50';
        btn.querySelector('i').className = 'fa-solid fa-power-off';
        btn.title = '总开关：已启用 — 点击关闭';
    } else {
        btn.classList.add('rlog-master-off');
        btn.classList.remove('rlog-master-on');
        btn.style.color = '#999';
        btn.querySelector('i').className = 'fa-solid fa-power-off';
        btn.title = '总开关：已关闭 — 点击启用';
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


// ── 渲染 ───────────────────────────────────────

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

function buildMessageHtml(msg, recordIdx, msgIdx) {
    const roleClass = getRoleClass(msg.role);
    const roleLabel = getRoleLabel(msg.role);
    const collapsedClass = msg.collapsed ? 'collapsed' : 'expanded';
    return `
        <div class="rmsg-item ${collapsedClass}" data-record="${recordIdx}" data-msg="${msgIdx}">
            <div class="rmsg-header">
                <span class="rmsg-expand-icon"><i class="fa-solid fa-chevron-right"></i></span>
                <span class="rmsg-role-badge ${roleClass}">${escapeHtml(roleLabel)}</span>
                <span class="rmsg-tokens">~${msg.tokens} tokens</span>
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

    const listEl = panelEl.querySelector('#rlog-list');
    if (!listEl) return;

    const headerEl = panelEl.querySelector('.rlog-panel-header h4');
    if (headerEl) {
        headerEl.textContent = `最近请求记录 (${records.length}/${MAX_RECORDS})`;
    }

    if (records.length === 0) {
        listEl.innerHTML = '<div class="rlog-empty">暂无抓取记录。发送一条消息后将自动捕获。</div>';
        return;
    }

    listEl.innerHTML = records
        .map((rec, idx) => {
            const totalTokens = getTotalTokens(rec.messages);
            const collapsedClass = rec.collapsed ? 'collapsed' : 'expanded';
            const sourceLabel = getSourceLabel(rec.source);
            const sourceClass = getSourceClass(rec.source);
            const sourceTitle = (rec.source && rec.source.detail) || sourceLabel;

            const messagesHtml = rec.messages
                .map((msg, mIdx) => buildMessageHtml(msg, idx, mIdx))
                .join('');

            return `
                <div class="rlog-record ${collapsedClass}" data-record-index="${idx}">
                    <div class="rlog-record-header">
                        <div class="rlog-record-info">
                            <span class="rlog-char-name">${escapeHtml(rec.characterName)}</span>
                            <span class="rlog-source-badge ${sourceClass}" title="${escapeHtml(sourceTitle)}">${escapeHtml(sourceLabel)}</span>
                            <span class="rlog-time">${escapeHtml(rec.timestamp)}</span>
                            <span class="rlog-total-tokens">~${totalTokens} tokens / ${rec.messages.length} 条消息</span>
                        </div>
                        <div class="rlog-record-actions">
                            <button class="rlog-copy-all-btn" data-record="${idx}" title="复制整条记录">
                                <i class="fa-solid fa-copy"></i> 复制全部
                            </button>
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
}

function bindListEvents(listEl) {
    listEl.querySelectorAll('.rmsg-header').forEach((header) => {
        header.addEventListener('click', function (e) {
            if (e.target.closest('button')) return;
            const msgItem = this.closest('.rmsg-item');
            const recIdx = Number(msgItem.dataset.record);
            const msgIdx = Number(msgItem.dataset.msg);
            toggleMessageCollapse(recIdx, msgIdx, msgItem);
        });
    });

    listEl.querySelectorAll('.rlog-record-header').forEach((header) => {
        header.addEventListener('click', function (e) {
            if (e.target.closest('button')) return;
            const recordEl = this.closest('.rlog-record');
            const idx = Number(recordEl.dataset.recordIndex);
            toggleRecordCollapse(idx, recordEl);
        });
    });

    listEl.querySelectorAll('.rlog-copy-all-btn').forEach((btn) => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const idx = Number(this.dataset.record);
            copyFullRecord(idx, this);
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
    records[index].collapsed = !records[index].collapsed;
    if (records[index].collapsed) {
        recordEl.classList.add('collapsed');
        recordEl.classList.remove('expanded');
    } else {
        recordEl.classList.add('expanded');
        recordEl.classList.remove('collapsed');
    }
}

function toggleMessageCollapse(recIdx, msgIdx, msgItem) {
    records[recIdx].messages[msgIdx].collapsed = !records[recIdx].messages[msgIdx].collapsed;
    if (records[recIdx].messages[msgIdx].collapsed) {
        msgItem.classList.add('collapsed');
        msgItem.classList.remove('expanded');
    } else {
        msgItem.classList.add('expanded');
        msgItem.classList.remove('collapsed');
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

function toggleAllRecords() {
    if (records.length === 0) return;
    const allCollapsed = records.every(r => r.collapsed);
    const newState = !allCollapsed;
    records.forEach((r, i) => {
        r.collapsed = newState;
        const el = panelEl.querySelector(`.rlog-record[data-record-index="${i}"]`);
        if (el) {
            if (newState) {
                el.classList.add('collapsed');
                el.classList.remove('expanded');
            } else {
                el.classList.add('expanded');
                el.classList.remove('collapsed');
            }
        }
    });
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
    toggleBtn.title = '最近请求记录';
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
            <h4 title="点击折叠/展开窗口">最近请求记录 (${records.length}/${MAX_RECORDS})</h4>
            <div class="rlog-header-actions">
                <button id="rlog-master-toggle" class="rlog-header-btn rlog-master-on" title="总开关：已启用 — 点击关闭">
                    <i class="fa-solid fa-power-off"></i>
                </button>
                <button id="rlog-clear-btn" class="rlog-header-btn" title="清空所有记录">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
                <button id="rlog-theme-btn" class="rlog-header-btn" title="切换昼/夜模式">
                    <i class="fa-solid fa-sun"></i>
                </button>
                <button id="rlog-close-btn" class="rlog-close-btn">&times;</button>
            </div>
        </div>
        <div class="rlog-panel-body">
            <div id="rlog-list" class="rlog-list">
                <div class="rlog-empty">暂无抓取记录。发送一条消息后将自动捕获。</div>
            </div>
            <div class="rlog-resize-grip" title="拖动改变窗口大小">
                <i class="fa-solid fa-grip-lines"></i>
            </div>
        </div>
    `;

    panelEl.classList.remove('rlog-window-collapsed');

    document.body.appendChild(panelEl);

    // 绑定事件
    panelEl.querySelector('.rlog-panel-header h4').addEventListener('click', (e) => {
        e.stopPropagation();
        togglePanelWindow();
    });

    panelEl.querySelector('#rlog-close-btn').addEventListener('click', hidePanel);

    panelEl.querySelector('#rlog-clear-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        clearAllRecords();
    });

    panelEl.querySelector('#rlog-theme-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        isLightTheme = !isLightTheme;
        saveTheme(isLightTheme);
        applyTheme();
        updateThemeButtonIcon();
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
    renderPanelContent();
}

function hidePanel() {
    if (panelEl) panelEl.style.display = 'none';
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
        // 跳过按钮和 H4 标题（标题用于折叠窗口，不参与拖拽）
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'H4') return;
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
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'H4') return;
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
