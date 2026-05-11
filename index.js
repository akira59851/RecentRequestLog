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

/** @type {string|null} 上一次记录的 messages 指纹，用于去重 */
let lastRecordFingerprint = null;

/** @type {number} 上一次记录的时间戳 */
let lastRecordTime = 0;

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
            const itemKeys = Object.keys(item);
            if (itemKeys.some(k => ST_INTERNAL_MSG_KEYS.has(k))) return false;
            return ('parts' in item && Array.isArray(item.parts) && item.parts.length > 0)
                || ('text' in item && typeof item.text === 'string' && item.text.length > 0)
                || (itemKeys.includes('role') && (itemKeys.includes('content') || itemKeys.includes('parts') || itemKeys.includes('text')));
        });
    }

    // 4. prompt 字符串 — Text Completions / Oobabooga / KoboldCPP 格式
    if (typeof body.prompt === 'string' && body.prompt.length > 0) {
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

function addRecord(characterName, messages) {
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
 */
function installFetchHook() {
    if (currentHook) return; // 已安装

    originalFetch = window.fetch;
    currentHook = async function hookedFetch(input, init) {
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
            } catch (e) { /* body 可能已被消费 */ }
        }

        // 严格请求体验证 — 不依赖 URL
        if (body && isAiRequestBody(body)) {
            const messages = parseFetchRequestBody(body);
            if (messages) {
                const characterName = getCurrentCharacterName();
                addRecord(characterName, messages);
            }
        }

        // 调用原始 fetch（通过闭包保存的引用，避免通过 window.fetch 访问导致递归）
        return originalFetch.apply(window, [input, init]);
    };
    window.fetch = currentHook;

    console.log(`[${PLUGIN_KEY}] fetch 拦截已启用（网络层统一拦截模式）`);
}

/**
 * 卸载 fetch 拦截钩子
 */
function uninstallFetchHook() {
    if (!currentHook) return;

    if (originalFetch) {
        window.fetch = originalFetch;
    }
    originalFetch = null;
    currentHook = null;

    console.log(`[${PLUGIN_KEY}] fetch 拦截已停用`);
}


// ── 总开关 ──────────────────────────────────────

function setMasterEnabled(enabled) {
    masterEnabled = enabled;
    try {
        localStorage.setItem(STORAGE_MASTER_KEY, enabled ? '1' : '0');
    } catch (e) { /* ignore */ }
    updateMasterToggleUI();

    if (!enabled) {
        uninstallFetchHook();
    } else {
        installFetchHook();
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

    // 延迟重新 append，确保在所有同步初始化的插件之后排在末尾
    // appendChild 对已存在的节点会将其移动到容器末尾
    setTimeout(() => {
        if (toggleBtn && toggleBtn.parentNode) {
            toggleBtn.parentNode.appendChild(toggleBtn);
        }
    }, 100);
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

    // 安装 fetch 拦截（受总开关控制）
    if (masterEnabled) {
        installFetchHook();
    }

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
