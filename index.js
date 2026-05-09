/**
 * SillyTavern 第三方插件: 最近请求记录 (Recent Request Log)
 *
 * 安装方式：将 RecentRequestLog 整个文件夹复制到
 * SillyTavern-release/public/scripts/extensions/third-party/ 目录下，
 * 然后启动或刷新 SillyTavern 即可。
 *
 * 功能:
 *  - 静默抓取每次发送给 AI 的完整提示词（原生请求 + 第三方插件请求）
 *  - 按角色分组展示每条消息，估算 tokens
 *  - 记录默认折叠，点击展开/收起
 *  - 消息默认折叠，点击各消息标题展开/收起
 *  - 每条消息及整条记录均支持一键复制
 *  - 最多保存 10 条记录 (滚动覆盖)
 *  - 仅存储于内存中，刷新/关闭后清空
 *  - 可清空全部记录
 *  - 昼/夜模式切换 (持久化)
 *  - 点击标题栏一键展开/折叠全部记录
 *  - fetch 请求拦截：捕获绕过 SillyTavern 直接发出的 AI 请求（可开关）
 */


// ── 全局常量 ──────────────────────────────────────
const PLUGIN_KEY = 'RecentRequestLog';
const MAX_RECORDS = 10;
const STORAGE_THEME_KEY = `${PLUGIN_KEY}_theme`;
const STORAGE_FETCH_INTERCEPTION_KEY = `${PLUGIN_KEY}_fetchInterception`;
const STORAGE_MASTER_KEY = `${PLUGIN_KEY}_masterEnabled`;

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

/** @type {boolean} 插件总开关是否启用（持久化到 localStorage） */
let masterEnabled = true;

// 面板拖拽/缩放相关
let panelResizing = false;
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartW = 0;
let resizeStartH = 0;

// ── fetch 拦截相关状态 ─────────────────────────
/** @type {boolean} fetch 拦截是否启用 */
let fetchInterceptionEnabled = false;

/** @type {Function|null} 保存的当前 window.fetch（可能已被其他插件包装过） */
let savedFetch = null;

/** @type {number} 上次 ST 原生事件抓取的时间戳（用于防重复） */
let lastStPromptTimestamp = 0;

/** @type {string|null} 上次 ST 原生事件抓取的内容指纹 */
let lastStPromptFingerprint = null;

/**
 * 计算文本指纹（用于去重）
 */
function computeTextFingerprint(text) {
    if (!text) return '';
    const normalized = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    return normalized;
}

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
        if (/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(ch)) {
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
 * 严格验证一个对象是否为 AI 消息
 * 必须同时具备角色标识 + 内容字段，且不包含 ST 内部聊天特征键
 */
function isAiMessageObject(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const keys = Object.keys(obj);

    // 如果有任何 ST 内部聊天特征键 → 不是 AI 消息
    if (keys.some(k => ST_INTERNAL_MSG_KEYS.has(k))) return false;

    // 必须同时有 role（或等效）和 content（或等效）
    const hasRole = keys.includes('role') || keys.includes('author') || keys.includes('type');
    const hasContent = keys.includes('content') || keys.includes('text') || keys.includes('parts');

    return hasRole && hasContent;
}

/**
 * 判断请求体是否为 AI API 请求
 * 不依赖 URL，纯粹通过请求体结构判断
 */
function isAiRequestBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;

    const keys = Object.keys(body);

    // 1. messages 数组 — 检查其中是否有 AI 消息对象
    if (Array.isArray(body.messages) && body.messages.length > 0) {
        return body.messages.some(isAiMessageObject);
    }

    // 2. chat 数组 — ST 原生事件格式，检查是否有 AI 消息对象
    if (Array.isArray(body.chat) && body.chat.length > 0) {
        return body.chat.some(isAiMessageObject);
    }

    // 3. contents 数组 — Google Gemini 格式
    if (Array.isArray(body.contents) && body.contents.length > 0) {
        return body.contents.some(item => {
            if (!item || typeof item !== 'object') return false;
            // 排除 ST 内部消息对象（可能有多余字段混入）
            const itemKeys = Object.keys(item);
            if (itemKeys.some(k => ST_INTERNAL_MSG_KEYS.has(k))) return false;
            // Gemini 消息有 role 和 parts，或者有 text
            return ('parts' in item && Array.isArray(item.parts) && item.parts.length > 0)
                || ('text' in item && typeof item.text === 'string' && item.text.length > 0)
                || (itemKeys.includes('role') && (itemKeys.includes('content') || itemKeys.includes('parts') || itemKeys.includes('text')));
        });
    }

    // 4. prompt 字符串 — Text Completions / Oobabooga / KoboldCPP 格式
    if (typeof body.prompt === 'string' && body.prompt.length > 0) {
        // 排除纯配置中的 prompt 字段（短且无上下文）
        const hasOtherAiKeys = keys.some(k =>
            ['model', 'max_tokens', 'temperature', 'stop', 'top_p', 'stream'].includes(k) ||
            Array.isArray(body[k])
        );
        if (hasOtherAiKeys || body.prompt.length > 50) return true;
    }

    // 5. system 配合 messages — Anthropic 格式
    if (typeof body.system === 'string' && Array.isArray(body.messages) && body.messages.length > 0) {
        return body.messages.some(isAiMessageObject);
    }

    return false;
}


// ── ST 原生事件处理 ─────────────────────────────

/**
 * CHAT_COMPLETION_PROMPT_READY: ST 发送 Chat Completions 请求前触发
 * payload: { chat: Array<{role, content}>, dryRun: boolean }
 */
function onChatCompletionPromptReady(data) {
    if (data && data.dryRun) return;

    lastStPromptTimestamp = Date.now();

    const characterName = getCurrentCharacterName() || '未知角色';

    const rawMessages = data.chat || data.messages || [];
    const messages = rawMessages
        .filter(m => m && typeof m === 'object' && isAiMessageObject(m))
        .map(m => ({
            role: normalizeRole(m.role),
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
            tokens: typeof m.tokens === 'number' ? m.tokens : estimateTokens(typeof m.content === 'string' ? m.content : ''),
            collapsed: true,
        }));

    // 计算内容指纹用于 fetch 拦截去重
    const fingerprintText = Array.isArray(data.chat)
        ? data.chat.map(m => (typeof m === 'string' ? m : (m.content || m.text || ''))).join('||')
        : '';
    lastStPromptFingerprint = computeTextFingerprint(fingerprintText);

    if (messages.length > 0) {
        addRecord(characterName, messages);
    }
}

/**
 * GENERATE_AFTER_COMBINE_PROMPTS: ST 发送 Text Completions 请求前触发
 * payload: { prompt: string, dryRun: boolean }
 */
function onTextCompletionPromptReady(data) {
    if (data && data.dryRun) return;

    lastStPromptTimestamp = Date.now();

    const characterName = getCurrentCharacterName() || '未知角色';
    const promptText = data.prompt || '';
    const messages = [];
    if (promptText) {
        messages.push({
            role: 'user',
            content: promptText,
            tokens: estimateTokens(promptText),
            collapsed: false,
        });
    }

    lastStPromptFingerprint = computeTextFingerprint(promptText);

    if (messages.length > 0) {
        addRecord(characterName, messages);
    }
}


// ── 数据管理 ────────────────────────────────────

function addRecord(characterName, messages) {
    if (!masterEnabled) return;
    if (!characterName || !messages || messages.length === 0) return;

    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const record = {
        characterName,
        timestamp: ts,
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
    lastStPromptTimestamp = 0;
    lastStPromptFingerprint = null;
    if (panelEl && isPanelVisible) {
        renderPanelContent();
    }
}


// ── Fetch 请求拦截 ──────────────────────────────

function getCurrentCharacterName() {
    try {
        const ctx = window.SillyTavern?.getContext();
        if (ctx?.name2) return ctx.name2;
        if (ctx?.characterName) return ctx.characterName;
        const charId = ctx?.characterId;
        if (charId && ctx?.characters?.[charId]?.name) return ctx.characters[charId].name;
        if (ctx?.groupId && ctx?.groups?.[ctx.groupId]?.name) {
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
                tokens: estimateTokens(content),
                collapsed: true,
            });
        }
        for (const m of json.messages) {
            if (!isAiMessageObject(m)) continue;
            if (typeof m.content === 'string' && m.content) {
                messages.push({
                    role: normalizeRole(m.role),
                    content: m.content,
                    tokens: estimateTokens(content),
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
            tokens: estimateTokens(content),
            collapsed: false,
        });
    }

    if (messages.length === 0) return null;
    return messages;
}

/**
 * 判断是否与最近一次 ST 原生事件抓取重复（基于内容指纹 + 时间窗口）
 */
function isDuplicateOfStEvent(body) {
    const elapsed = Date.now() - lastStPromptTimestamp;

    // 超过 5 秒肯定不是同一次请求
    if (elapsed > 5000) return false;

    // 3 秒内且指纹匹配
    if (elapsed <= 3000 && lastStPromptFingerprint) {
        let currentFingerprint = '';
        if (body) {
            const rawMessages = body.messages || body.chat || body.contents || [];
            const rawText = Array.isArray(rawMessages)
                ? rawMessages.map(m => (typeof m === 'string' ? m : (m.content || m.text || ''))).join('||')
                : (body.prompt || '');
            currentFingerprint = computeTextFingerprint(rawText);
        }
        if (currentFingerprint && currentFingerprint === lastStPromptFingerprint) {
            return true;
        }
    }

    return false;
}

/**
 * 安装 fetch 拦截钩子（链式兼容）
 */
function installFetchHook() {
    if (!fetchInterceptionEnabled) return;

    savedFetch = window.fetch;

    window.fetch = async function hookedFetch(input, init) {
        let body = null;

        // 只拦截 JSON POST 请求
        if (init?.body) {
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
            } catch (e) { /* body 已被消费 */ }
        }

        // 严格请求体验证 — 不依赖 URL
        if (body && isAiRequestBody(body)) {
            if (!isDuplicateOfStEvent(body)) {
                const messages = parseFetchRequestBody(body);
                if (messages) {
                    const characterName = getCurrentCharacterName();
                    addRecord(characterName, messages);
                }
            }
        }

        return savedFetch.call(window, input, init);
    };

    console.log(`[${PLUGIN_KEY}] fetch 拦截已启用（链式兼容模式）`);
}

/**
 * 卸载 fetch 拦截钩子
 */
function uninstallFetchHook() {
    if (savedFetch) {
        window.fetch = savedFetch;
        savedFetch = null;
    }
    console.log(`[${PLUGIN_KEY}] fetch 拦截已停用`);
}

function toggleFetchInterception(enable) {
    fetchInterceptionEnabled = enable;
    try {
        localStorage.setItem(STORAGE_FETCH_INTERCEPTION_KEY, enable ? '1' : '0');
    } catch (e) { /* ignore */ }

    if (enable) {
        installFetchHook();
    } else {
        uninstallFetchHook();
    }

    updateFetchToggleUI();
}

function updateFetchToggleUI() {
    const btn = panelEl?.querySelector('#rlog-fetch-toggle');
    if (!btn) return;
    if (fetchInterceptionEnabled) {
        btn.classList.add('rlog-fetch-on');
        btn.querySelector('i').className = 'fa-solid fa-toggle-on';
    } else {
        btn.classList.remove('rlog-fetch-on');
        btn.querySelector('i').className = 'fa-solid fa-toggle-off';
    }
}


// ── 总开关 ──────────────────────────────────────

function setMasterEnabled(enabled) {
    masterEnabled = enabled;
    try {
        localStorage.setItem(STORAGE_MASTER_KEY, enabled ? '1' : '0');
    } catch (e) { /* ignore */ }
    updateMasterToggleUI();

    if (!enabled) {
        // 关闭时卸载 fetch 拦截
        if (fetchInterceptionEnabled) {
            uninstallFetchHook();
        }
    } else {
        // 开启时恢复 fetch 拦截（仅当用户之前开启了）
        if (fetchInterceptionEnabled) {
            installFetchHook();
        }
    }
}

function updateMasterToggleUI() {
    const btn = panelEl?.querySelector('#rlog-master-toggle');
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

            const messagesHtml = rec.messages
                .map((msg, mIdx) => buildMessageHtml(msg, idx, mIdx))
                .join('');

            return `
                <div class="rlog-record ${collapsedClass}" data-record-index="${idx}">
                    <div class="rlog-record-header">
                        <div class="rlog-record-info">
                            <span class="rlog-char-name">${escapeHtml(rec.characterName)}</span>
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
        panelEl.style.maxHeight = 'none';
    } else {
        const savedW = panelEl.dataset.rlogSavedWidth;
        const savedH = panelEl.dataset.rlogSavedHeight;
        if (savedW) panelEl.style.width = savedW + 'px';
        if (savedH) panelEl.style.height = savedH + 'px';
        else panelEl.style.height = '';
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
    const msg = records[recIdx]?.messages?.[msgIdx];
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
}

function buildUI() {
    if (panelEl) return;

    addMenuEntry();

    // 加载持久化设置
    isLightTheme = loadTheme();
    try {
        masterEnabled = localStorage.getItem(STORAGE_MASTER_KEY) !== '0';
    } catch (e) {
        masterEnabled = true;
    }
    try {
        fetchInterceptionEnabled = localStorage.getItem(STORAGE_FETCH_INTERCEPTION_KEY) === '1';
    } catch (e) {
        fetchInterceptionEnabled = false;
    }

    panelEl = document.createElement('div');
    panelEl.id = 'rlog-panel';
    panelEl.style.display = 'none';

    applyTheme();

    panelEl.innerHTML = `
        <div class="rlog-panel-header">
            <h4 title="点击折叠/展开窗口">最近请求记录 (${records.length}/${MAX_RECORDS})</h4>
            <div class="rlog-header-actions">
                <div class="rlog-fetch-toggle-wrapper" title="尝试捕获通过浏览器 fetch 直接发送的 AI 请求（例如某些第三方插件绕过 ST 原生事件发出的请求）。&#10;&#10;由于各插件实现方式不同，部分请求可能无法被此钩子截获。&#10;&#10;注意：启用后将拦截全局 fetch 调用，仅分析与 AI 相关的请求体，不会影响其他网络请求或造成性能问题。&#10;默认关闭。">
                    <button id="rlog-fetch-toggle" class="rlog-header-btn rlog-fetch-toggle-btn">
                        <i class="fa-solid fa-toggle-off"></i>
                    </button>
                    <span class="rlog-fetch-label">广播监听</span>
                </div>
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

    const fetchToggleBtn = panelEl.querySelector('#rlog-fetch-toggle');
    if (fetchToggleBtn) {
        fetchToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFetchInterception(!fetchInterceptionEnabled);
        });
    }
    updateFetchToggleUI();

    if (fetchInterceptionEnabled) {
        installFetchHook();
    }

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

    renderPanelContent();
}

function updateThemeButtonIcon() {
    const btn = panelEl?.querySelector('#rlog-theme-btn');
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
    toggleBtn?.classList.add('active');
    renderPanelContent();
}

function hidePanel() {
    if (panelEl) panelEl.style.display = 'none';
    isPanelVisible = false;
    toggleBtn?.classList.remove('active');
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
        if (e.target.tagName === 'BUTTON') return;
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
    if (typeof window.SillyTavern?.getContext !== 'function') {
        console.debug(`[${PLUGIN_KEY}] 等待 SillyTavern 初始化...`);
        setTimeout(init, 200);
        return;
    }

    const ctx = window.SillyTavern.getContext();
    if (!ctx?.eventSource || !ctx?.event_types) {
        console.debug(`[${PLUGIN_KEY}] ST 上下文未就绪，稍后重试...`);
        setTimeout(init, 300);
        return;
    }

    eventSource = ctx.eventSource;
    event_types = ctx.event_types;

    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, onTextCompletionPromptReady);

    eventSource.once(event_types.APP_READY, () => {
        buildUI();
    });

    // 兜底：如果 APP_READY 已经触发过（插件后加载），直接构建 UI
    setTimeout(() => {
        if (!panelEl) buildUI();
    }, 500);

    console.log(`[${PLUGIN_KEY}] 初始化完成 - 静默监听提示词发送`);
}

init();
