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
   10. 持久化设置        总开关/内容预览/主题/最大记录数/偏好设置读写
   11. 通用弹窗          最大记录数设置 + 通用确认弹窗
   12. 搜索              搜索状态/匹配/高亮/导航
   13. 筛选              筛选状态/匹配/抽屉与分段按钮/指示器
   14. 渲染与 HTML 构建  记录/消息 HTML、renderPanelContent、事件绑定
   15. 折叠展开与回顶闪烁 折叠/展开、滚动锚定、置底回顶、闪烁提示
   16. 记录删除与复制    单条删除、整条/单消息复制、复制反馈
   17. 查看全文覆盖层    覆盖层开合、格式切换、滚动、Esc 关闭
   18. 自定义滚动条      共享观察器、滚动条创建/更新/拖拽、滚动指示器
   19. 面板控制          菜单入口、buildUI、开合/折叠(↔浮标)/主题按钮
   20. 拖拽与缩放        面板拖动/右下角缩放/浮标拖动
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
const STORAGE_PREF_MOBILE_FULL = `${PLUGIN_KEY}_prefMobileFull`;      /* 偏好：移动端全屏（已实现：移动端打开面板自动铺满全屏） */
const STORAGE_PREF_CLICK_OUTSIDE = `${PLUGIN_KEY}_prefClickOutside`;  /* 偏好：点击插件面板外关闭整个面板（已实现：双端点击面板外即关闭） */
const STORAGE_PREF_FILTER_PERSIST = `${PLUGIN_KEY}_prefFilterPersist`; /* 偏好：筛选状态持久化（已实现：开启后跨页面保留筛选状态） */
const STORAGE_PREF_MINIMAL = `${PLUGIN_KEY}_prefMinimal`;            /* 偏好：极简模式（已实现：开启后去掉过渡/动画/平滑滚动/闪烁/浮层虚化） */
const STORAGE_PREF_BADGE_DEFAULT = `${PLUGIN_KEY}_prefBadgeDefault`; /* 偏好：浮标默认入口（已实现：开启后插件启动默认显示浮标，右上角默认位置） */
const STORAGE_FILTER_STATE_KEY = `${PLUGIN_KEY}_filterState`;        /* 持久化的筛选状态对象（仅当「筛选状态持久化」偏好开启时读写） */
const NATIVE_INTENT_WINDOW_MS = 5000;
const BADGE_SIZE = 36;               /* 浮标边长(px)：桌面端 36×36（移动端在媒体查询里可缩到 32） */
const BADGE_DRAG_THRESHOLD = 5;      /* 浮标拖动判定阈值(px)：位移超过该值视为拖动，否则视为点击恢复面板 */
const BADGE_DEFAULT_MARGIN_RIGHT = 16; /* 浮标默认位置距视口右缘的距离(px)：「浮标默认入口」开启时启动默认位置 */
const BADGE_DEFAULT_MARGIN_TOP = 12;  /* 浮标默认位置在 ST 顶部设置栏下缘往下的距离(px) */
const LONG_PRESS_MS = 550;            /* 长按判定阈值(ms)：按下超过此时间且移动未超过容差视为长按 */
const LONG_PRESS_MOVE_TOLERANCE = 8;  /* 长按移动容差(px)：按下后位移超过该值取消长按 */
const PIN_TOAST_DURATION_MS = 1800;   /* 置顶/取消置顶提示自动消失时间(ms) */

/* 影子内 FA 固壳：仅插件实际使用的 33 个实心图标（content 取自 ST 现版 fontawesome.min.css 6.5.2，非猜测）
   新增图标时在此补一行「图标名: '\\fXXX'」即可 */
const FA_SOLID_CONTENT = {
    'arrow-down': '\\f063',
    'arrow-up': '\\f062',
    'book': '\\f02d',
    'check': '\\f00c',
    'chevron-down': '\\f078',
    'chevron-right': '\\f054',
    'chevron-up': '\\f077',
    'comment-dots': '\\f4ad',
    'compress-alt': '\\f422',
    'copy': '\\f0c5',
    'ellipsis': '\\f141',
    'eye': '\\f06e',
    'eye-slash': '\\f070',
    'expand': '\\f065',
    'file-lines': '\\f15c',
    'filter': '\\f0b0',
    'gear': '\\f013',
    'heart': '\\f004',
    'heart-circle-check': '\\e4fd',
    'list': '\\f03a',
    'magnifying-glass': '\\f002',
    'moon': '\\f186',
    'paper-plane': '\\f1d8',
    'power-off': '\\f011',
    'puzzle-piece': '\\f12e',
    'question': '\\3f',
    'rotate-left': '\\f2ea',
    'sun': '\\f185',
    'trash-can': '\\f2ed',
    'user': '\\f007',
    'vial': '\\f492',
    'xmark': '\\f00d',
    'caret-down': '\\f0d7',
};

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

/* ShadowRoot|null: 插件面板的影子根（面板与样式放里面，隔离第三方主题 CSS） */
let panelShadowRoot = null;

/* HTMLElement|null: 影子宿主元素（挂在 body 上，承载影子根） */
let shadowHostEl = null;

/* HTMLElement|null: 浮标 light DOM 宿主（收起面板后的小型插件入口）。
   新版拆成独立 light DOM host（#rlog-badge-host）并挂到 document.body，
   供第三方收纳插件识别/收纳；可见视觉在其自己的 shadow root 内（.rlog-badge-visual）。 */
let badgeEl = null;

/* HTMLElement|null: 浮标可见视觉元素（挂在 badgeEl 自己的 shadow root 内）。
   document 查找不到，仅供 __RLogApi.getBadgeVisualEl() 等测试辅助使用。 */
let badgeVisualEl = null;

/* {left,top}|null: 浮标会话内位置（浮标左上角坐标）。
   首次收起记录点击座标，拖动后更新，再次收起复用；页面刷新/重新初始化时随模块重载自动清空。 */
let badgePos = null;

/* boolean: 是否拦截「点击浮标恢复面板」后浏览器派发的原生 click（一次性标记）。
   浮标隐藏、面板出现在同一坐标时，该 click 会 hit-test 到面板标题栏按钮，可能误开抽屉。 */
let badgeSuppressNextClick = false;

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

/* HTMLElement|null: 置顶/取消置顶轻量提示 toast 元素（面板顶部居中） */
let pinToastEl = null;

/* timeout|null: 置顶/取消置顶提示自动消失的定时器 */
let pinToastTimer = null;

/* boolean: 长按置顶触发后置为 true，用于抑制随后一次的记录标题栏 click（避免误折叠/展开） */
let suppressRecordHeaderClick = false;

/* boolean: 移动端长按重排期间是否已绑定 hover 抑制清理（避免重复监听/堆积） */
let hoverSuppressBound = false;

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

/* @type {object} 偏好设置状态（5 项，默认全关；持久化到 localStorage）
   五项偏好「浮标默认入口」「移动端全屏」「点击面板外关闭」「筛选状态持久化」「极简模式」均已接入实际行为。 */
let preferences = {
    badgeDefault: false,  /* boolean: 浮标默认入口（开启后插件启动默认显示浮标，右上角默认位置；关闭面板/最小化时浮标回到 badgePos） */
    mobileFull: false,    /* boolean: 手机端全屏（移动端打开面板自动铺满全屏） */
    clickOutside: false,  /* boolean: 点击插件面板外关闭整个面板（双端通用，全屏时自然不生效） */
    filterPersist: false, /* boolean: 筛选状态持久化（开启后跨页面保留筛选状态；关闭时不改动当前筛选） */
    minimal: false,       /* boolean: 极简模式（开启后去掉过渡/动画/平滑滚动/闪烁/浮层虚化，保留状态反馈与引导动效） */
};

/* HTMLElement|null: 偏好设置浮层（遮罩 + 面板）DOM 元素 */
let prefOverlayEl = null;

/* HTMLElement|null: 偏好设置「更多」抽屉入口按钮（用于切换心形图标态） */
let prefBtnEl = null;

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
            /* 挂到影子根内测量，样式与面板一致且不受第三方主题影响 */
            if (panelShadowRoot) panelShadowRoot.appendChild(probe);
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

/* 返回当前普通记录（未置顶）列表。置顶记录单独存在 pinned 标记里，不参与普通容量。 */
function getNormalRecords() {
    return records.filter(r => !r.pinned);
}

/* 裁剪超出普通记录上限的最旧普通记录（从数组末尾向前找并删除，保持 records 原顺序）。
   置顶记录跳过，不被清理；被删除记录若有在途回复则取消追踪。
   置顶记录不计入上限，因此 records.length 可能大于 MAX_RECORDS。 */
function pruneNormalRecords() {
    let overCount = getNormalRecords().length - MAX_RECORDS;
    if (overCount <= 0) return;
    for (let i = records.length - 1; i >= 0 && overCount > 0; i--) {
        const rec = records[i];
        if (rec.pinned) continue;
        records.splice(i, 1);
        if (rec.id != null) abortPendingReply(rec.id);
        overCount--;
    }
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
        pinned: false,                /* 临时置顶标记：不占用普通记录上限，刷新即重置 */
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
    pruneNormalRecords();

    panelContentDirty = true;
    if (panelEl && isPanelVisible) {
        const listEl = panelEl.querySelector('#rlog-list');
        const prevScrollTop = listEl ? listEl.scrollTop : 0;
        renderPanelContent();
        if (!isPanelCollapsed) {
            if (!filterActive || newRecordVisible) {
                /* 面板完全展开可见时：定位到新记录自身（置顶记录可能在其上方），并闪烁新记录 */
                const newRecordEl = getRecordElByIndex(0);
                if (newRecordEl) {
                    scrollToRecordEl(newRecordEl);
                    flashTopHint(newRecordEl);
                } else {
                    if (listEl) listEl.scrollTop = 0;
                    flashTopHint();
                }
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
    /* 只清空普通记录；置顶记录保留，且其未终态回复继续追踪 */
    records = records.filter(r => {
        if (r.pinned) return true;
        if (r.id != null) abortPendingReply(r.id);
        return false;
    });
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
   开启时图标为眼睛（fa-eye），关闭时图标为眼睛划掉（fa-eye-slash） */
function updatePreviewToggleUI() {
    const toggleEl = panelEl ? panelEl.querySelector('#rlog-preview-btn') : null;
    if (!toggleEl) return;
    const iconEl = toggleEl.querySelector('i');
    if (contentPreviewEnabled) {
        toggleEl.classList.add('rlog-preview-on');
        toggleEl.classList.remove('rlog-preview-off');
        if (iconEl) iconEl.className = 'fa-solid fa-eye';
        toggleEl.title = '内容预览-已开启';
    } else {
        toggleEl.classList.remove('rlog-preview-on');
        toggleEl.classList.add('rlog-preview-off');
        if (iconEl) iconEl.className = 'fa-solid fa-eye-slash';
        toggleEl.title = '内容预览-已关闭';
    }
}

/* ── 偏好设置（持久化 + 图标态；5 项行为已实现） ─────────────── */

/* 偏好设置键 → localStorage 存储键 映射（与「可调参数」区同风格集中管理） */
const PREF_STORAGE_KEYS = {
    badgeDefault: STORAGE_PREF_BADGE_DEFAULT,
    mobileFull: STORAGE_PREF_MOBILE_FULL,
    clickOutside: STORAGE_PREF_CLICK_OUTSIDE,
    filterPersist: STORAGE_PREF_FILTER_PERSIST,
    minimal: STORAGE_PREF_MINIMAL,
};

/* 从 localStorage 加载全部偏好设置（默认全关；存储值 !== '1' 一律视为关） */
function loadPreferences() {
    for (const key of Object.keys(preferences)) {
        try { preferences[key] = localStorage.getItem(PREF_STORAGE_KEYS[key]) === '1'; }
        catch (e) { preferences[key] = false; }
    }
}

/* 持久化单个偏好设置到 localStorage（与现有开关同一机制：'1'/'0'） */
function savePreference(key, value) {
    try { localStorage.setItem(PREF_STORAGE_KEYS[key], value ? '1' : '0'); } catch (e) { /* ignore */ }
}

/* 是否至少有一项偏好处于激活（用于切换「偏好设置」入口图标 fa-heart ↔ fa-heart-circle-check） */
function hasActivePreference() {
    return preferences.badgeDefault || preferences.mobileFull || preferences.clickOutside || preferences.filterPersist || preferences.minimal;
}

/* 更新「偏好设置」入口图标：
   任意偏好激活 → fa-heart-circle-check；全部关闭 → fa-heart。
   样式/间距与其他标题栏按钮一致，仅切换字形、不着色。 */
function updatePrefButtonIcon() {
    if (!prefBtnEl) return;
    const iconEl = prefBtnEl.querySelector('i');
    if (!iconEl) return;
    if (hasActivePreference()) {
        iconEl.className = 'fa-solid fa-heart-circle-check';
    } else {
        iconEl.className = 'fa-solid fa-heart';
    }
}

/* 同步偏好浮层内所有 Toggle 的视觉状态（开/关 + role/aria-checked） */
function syncPrefToggleUI() {
    if (!prefOverlayEl) return;
    const toggles = prefOverlayEl.querySelectorAll('.rlog-toggle');
    toggles.forEach((toggle) => {
        const key = toggle.getAttribute('data-pref-key');
        const on = key ? !!preferences[key] : false;
        toggle.classList.toggle('rlog-toggle-on', on);
        toggle.setAttribute('aria-checked', on ? 'true' : 'false');
    });
}

/* 设置某个偏好：更新状态 + 持久化 + 刷新图标态与开关视觉。
   五项偏好均已接入实际行为（见下方各 key 处理）。 */
function setPreference(key, value) {
    if (!(key in preferences)) return;
    preferences[key] = !!value;
    savePreference(key, preferences[key]);
    updatePrefButtonIcon();
    syncPrefToggleUI();
    /* 「移动端全屏」：切换后立即应用/撤销全屏（仅移动端视口生效）。
       「点击面板外关闭」无需即时动作：全局点击监听在点击时读取该标志即可生效。
       「筛选状态持久化」：开启时用当前内存态立即落盘（避免读到陈旧值）；关闭时不改动当前筛选。
       「极简模式」：切换后立即给影子宿主加/去类，关掉全部动效。
       「浮标默认入口」：开启且面板隐藏时立即显示浮标（按默认位置定位）；关闭时若浮标并非因「折叠」
       而显示则隐藏（否则保留折叠态浮标），避免 API 直接改设置留下残留。 */
    if (key === 'mobileFull') updateMobileFullscreenClass();
    if (key === 'filterPersist' && preferences.filterPersist) saveFilterState();
    if (key === 'minimal') updateMinimalClass();
    if (key === 'badgeDefault') setPreferenceBadgeDefaultBehavior();
}

/* 应用「浮标默认入口」偏好切换后的即时行为（开启/关闭的边界处理）。
   - 开启：面板隐藏时立即显示浮标（badgePos 为空则用右上默认位置）。
   - 关闭：若浮标当前是因「折叠」显示（isPanelCollapsed）则保留；否则隐藏。 */
function setPreferenceBadgeDefaultBehavior() {
    if (!badgeEl) return;
    if (preferences.badgeDefault) {
        if (!isPanelVisible) {
            if (!badgePos) badgePos = getDefaultBadgePos();
            else badgePos = clampBadgeToViewport(badgePos.left, badgePos.top);
            badgeEl.style.left = badgePos.left + 'px';
            badgeEl.style.top = badgePos.top + 'px';
            setBadgeActive(true);
        }
    } else {
        if (!isPanelCollapsed) setBadgeActive(false);
    }
}

/* 判断「移动端全屏」当前是否应生效：偏好开启 + 移动端视口（唯一断点 768px）。
   桌面端因断点隔离，该项始终不生效，不影响其它逻辑。 */
function isMobileFullActive() {
    return preferences.mobileFull && window.matchMedia('(max-width: 768px)').matches;
}

/* 应用/撤销「移动端全屏」：给面板加/去 .rlog-mobile-fullscreen 类，样式由 CSS 移动端适配区负责。
   切换偏好、打开面板、初始化时各调用一次，保证面板窗口位置/尺寸始终与偏好一致。 */
function updateMobileFullscreenClass() {
    if (!panelEl) return;
    panelEl.classList.toggle('rlog-mobile-fullscreen', isMobileFullActive());
}

/* 应用/撤销「极简模式」：把 .rlog-minimal 类加到影子宿主（而非面板）上，
   配合影子内 `:host(.rlog-minimal)` 样式一次性关掉全部过渡/动画（含与面板平级的弹窗）。
   切换偏好、初始化时各调用一次。 */
function updateMinimalClass() {
    if (!shadowHostEl) return;
    shadowHostEl.classList.toggle('rlog-minimal', !!preferences.minimal);
}

/* 打开偏好设置浮层：
   先收起「更多」抽屉，再显示遮罩浮层（设置面板居中显示）。 */
function openPrefPanel() {
    if (!prefOverlayEl) return;
    closeMoreDrawer();
    syncPrefToggleUI();
    prefOverlayEl.classList.add('rlog-pref-open');
    /* 等一帧让遮罩显示、测量完成，再更新滚动提示箭头 */
    requestAnimationFrame(() => updatePrefScrollArrows());
}

/* 关闭偏好设置浮层（唯一关闭方式是右上角 ×，由 buildUI 内的事件绑定触发）。
   注意：遮罩点击不触发关闭、也不做任何其他动作；「点击面板外关闭」偏好针对的是
   关闭整个插件主面板（点整个插件面板外部），与浮层的关闭方式无关，该偏好行为已实现。 */
function closePrefPanel() {
    if (!prefOverlayEl) return;
    prefOverlayEl.classList.remove('rlog-pref-open');
}

/* 更新偏好设置列表的滚动提示箭头：
   仅在内容真的需要滚动时显示对应方向的箭头（向上有内容→下箭头提示仍可滚动范围），
   到底/到顶/无需滚动时隐藏；箭头只作状态提示，不参与交互。
   依赖 buildUI 内绑定的 .rlog-pref-list scroll 事件与 openPrefPanel 里的首帧更新。 */
function updatePrefScrollArrows() {
    if (!prefOverlayEl) return;
    const list = prefOverlayEl.querySelector('.rlog-pref-list');
    const up = prefOverlayEl.querySelector('.rlog-pref-scroll-up');
    const down = prefOverlayEl.querySelector('.rlog-pref-scroll-down');
    if (!list || !up || !down) return;
    const canUp = list.scrollTop > 1;
    const canDown = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
    up.classList.toggle('rlog-pref-arrow-visible', canUp);
    down.classList.toggle('rlog-pref-arrow-visible', canDown);
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
    /* 主题类同步到影子宿主：浮标的主题色变量挂 #rlog-shadow-host（宿主自定义属性跨影子边界
       继承给浮标），亮色时给宿主加 .rlog-light 使浮标切到亮色配色。 */
    if (shadowHostEl) {
        if (isLightTheme) shadowHostEl.classList.add('rlog-light');
        else shadowHostEl.classList.remove('rlog-light');
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

    /* 如果当前普通记录数超过新上限，裁剪掉最旧的普通记录；置顶记录不受影响 */
    pruneNormalRecords();

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
    /* 弹窗挂到影子根（而非 document.body）：同时被主题隔离，且避免挂到带 transform 的面板内破坏 fixed 参考系 */
    if (panelShadowRoot) panelShadowRoot.appendChild(overlay);
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
    if (panelShadowRoot) panelShadowRoot.appendChild(overlay);
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
/* 返回当前应使用的滚动行为：极简模式用 'auto' 直接跳转，否则 'smooth' 平滑。
   极简定位逻辑不变（位置计算/夹取照旧），只把滚动方式由平滑改成瞬时。 */
function getScrollBehavior() {
    return preferences.minimal ? 'auto' : 'smooth';
}

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
    contentEl.scrollTo({ top: clampedContentScroll, behavior: getScrollBehavior() });

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
        listEl.scrollTo({ top: clampedListScroll, behavior: getScrollBehavior() });
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

/* 把当前筛选状态持久化到 localStorage（仅当「筛选状态持久化」开关开启时调用）。
   存整个 filterState 对象（source/role/model 三组布尔），刷新/重开页面后据此恢复。 */
function saveFilterState() {
    try { localStorage.setItem(STORAGE_FILTER_STATE_KEY, JSON.stringify(filterState)); } catch (e) { /* 忽略异常 */ }
}

/* 清洗从 localStorage 读回的筛选状态：
   以默认全开为基准，逐分组逐键只采纳布尔值，未知/缺失/非法一律回退 true，防止脏数据。 */
function sanitizeFilterState(state) {
    const def = createDefaultFilterState();
    if (!state || typeof state !== 'object') return def;
    const out = createDefaultFilterState();
    for (const group of Object.keys(def)) {
        if (state[group] && typeof state[group] === 'object') {
            for (const key of Object.keys(def[group])) {
                if (typeof state[group][key] === 'boolean') out[group][key] = state[group][key];
            }
        }
    }
    return out;
}

/* 加载持久化的筛选状态并覆盖当前 filterState。
   仅当「筛选状态持久化」开关开启时读取；无值/解析失败/数据非法一律回退默认全开。
   开关关闭时不读取，保持原有的会话级逻辑（刷新即重置为全开）。 */
function loadPersistedFilterState() {
    if (!preferences.filterPersist) return;
    try {
        const raw = localStorage.getItem(STORAGE_FILTER_STATE_KEY);
        if (raw === null) return;
        filterState = sanitizeFilterState(JSON.parse(raw));
    } catch (e) { /* 解析失败：回退默认全开 */
        filterState = createDefaultFilterState();
    }
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
    /* 「筛选状态持久化」开启时，每次切换立即落盘，刷新/重开页面后据此恢复 */
    if (preferences.filterPersist) saveFilterState();
    if (panelEl && isPanelVisible) renderPanelContent();
}

/* 重置全部筛选为「全开」并刷新列表
   @param {boolean} [persist=true] 是否在重置后落盘（用户手动重置=真；引导等程序化调用传 false，
      避免引导在开始时把用户已持久化的筛选覆盖成全开） */
function resetFilters(persist = true) {
    filterState = createDefaultFilterState();
    updateFilterChipUI();
    updateFilterIndicator();
    panelContentDirty = true;
    if (persist && preferences.filterPersist) saveFilterState();
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

    /* 只渲染可见记录；置顶记录先渲染，普通记录随后，两条子组内均保持 records 原顺序（新→旧）。
       DOM 的 data-record-index 仍写入 records 中的真实索引，而非显示位置，
       搜索/复制/删除/查看全文/回复挂载等按索引取数的路径无需改语义 */
    const displayRecords = visibleRecords.filter(r => r.pinned)
        .concat(visibleRecords.filter(r => !r.pinned));
    const displayIndexes = displayRecords.map((rec) => records.indexOf(rec));
    listEl.innerHTML = displayRecords
        .map((rec, vi) => {
            const idx = displayIndexes[vi];
            const totalTokens = getTotalTokens(rec.messages);
            const collapsedClass = rec.collapsed ? 'collapsed' : 'expanded';
            const pinnedClass = rec.pinned ? 'rlog-pinned' : '';
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
                <div class="rlog-record ${collapsedClass} ${pinnedClass}" data-source="${sourceType}" data-record-index="${idx}">
                    <div class="rlog-record-header">
                        <div class="rlog-record-info" title="长按置顶 / 长按取消置顶">
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
            /* 长按置顶后，本次触发的 native click 不再折叠/展开记录 */
            if (suppressRecordHeaderClick) {
                suppressRecordHeaderClick = false;
                return;
            }
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

        /* 长按记录标题栏切换置顶：绑定到整个 .rlog-record-header。
           - 折叠状态：按钮隐藏，整行（含空白/状态标签/箭头）都可长按；
           - 展开状态：仅排除真实 <button> 实际所占区域，以及搜索框这个交互区；
           - 单击折叠/展开逻辑不交叠（长按触发后抑制后续 click）。
           使用 Pointer Events 实现：移动超容差或提前抬起即取消。 */
        let longPressTimer = null;
        let activePointerId = null;
        let currentPointerType = null;
        let startX = 0;
        let startY = 0;

        const cancelLongPress = () => {
            if (longPressTimer !== null) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            if (activePointerId !== null && header.hasPointerCapture) {
                /* 尝试释放 capture；异常静默 */
                try { header.releasePointerCapture(activePointerId); } catch (err) { /* ignore */ }
            }
            activePointerId = null;
        };

        /* 长按是否应跳过：真实按钮始终排除；搜索框是交互区也排除（其余空白/状态都不防御性屏蔽） */
        const isLongPressExcluded = (e) => e.target.closest('button') !== null
            || e.target.closest('.rlog-search-box') !== null;

        header.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (isLongPressExcluded(e)) return;
            const recordEl = header.closest('.rlog-record');
            if (!recordEl) return;
            const index = Number(recordEl.dataset.recordIndex);
            cancelLongPress();
            currentPointerType = e.pointerType;
            activePointerId = e.pointerId;
            startX = e.clientX;
            startY = e.clientY;
            /* 鼠标：显式 capture 以便移动超容差时仍收到 pointermove；触屏用隐式 capture + touch-action 控制滚动 */
            if (e.pointerType !== 'touch') {
                try { header.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            }
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                suppressRecordHeaderClick = true;
                setTimeout(() => { suppressRecordHeaderClick = false; }, 50);
                /* 仅移动端：长按重排后抑制补位记录的触摸模拟 hover，手指抬起后恢复正常 */
                if (currentPointerType === 'touch') beginHoverSuppress();
                toggleRecordPinned(index, header);
            }, LONG_PRESS_MS);
        });

        header.addEventListener('pointermove', (e) => {
            if (longPressTimer === null) return;
            const dx = Math.abs(e.clientX - startX);
            const dy = Math.abs(e.clientY - startY);
            if (dx > LONG_PRESS_MOVE_TOLERANCE || dy > LONG_PRESS_MOVE_TOLERANCE) {
                cancelLongPress();
            }
        });

        header.addEventListener('pointerup', () => cancelLongPress());
        header.addEventListener('pointercancel', () => cancelLongPress());
        /* 移动端长按非按钮标题栏不弹系统菜单（按钮/搜索框保持原生行为） */
        header.addEventListener('contextmenu', (e) => {
            if (isLongPressExcluded(e)) return;
            e.preventDefault();
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

/* 切换单条记录的临时置顶状态。
   - 置顶时不占用普通记录上限、不参与自动清理。
   - 从普通变置顶且记录展开时折叠整条记录（子消息折叠状态不变）。
   - 取消置顶不自动展开，记录恢复参与普通记录清理。
   - 不主动滚动到该记录（保留当前滚动位置），仅用 toast 反馈。 */
function toggleRecordPinned(index, infoEl) {
    if (index < 0 || index >= records.length) return;
    const record = records[index];
    if (!record) return;

    resetSearchIfActive();

    record.pinned = !record.pinned;
    if (record.pinned && !record.collapsed) {
        record.collapsed = true;
    }

    panelContentDirty = true;
    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    const prevScrollTop = listEl ? listEl.scrollTop : 0;
    if (panelEl && isPanelVisible) {
        renderPanelContent();
        /* 渲染重建后保留当前滚动位置（置顶/取消置顶不主动跳到记录所在处） */
        if (listEl && listEl.isConnected) {
            const maxScroll = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
            listEl.scrollTop = Math.min(prevScrollTop, maxScroll);
        }
    }

    showPinToast(record.pinned
        ? '已置顶，不受普通记录清理影响'
        : '已取消置顶，将重新参与普通记录清理');
}

/* 显示置顶/取消置顶的轻量 toast（面板顶部居中）。
   连续多次只替换文本并重置自动消失定时器，不堆叠。 */
function showPinToast(text) {
    if (!panelEl) return;
    if (!pinToastEl) pinToastEl = panelEl.querySelector('#rlog-pin-toast');
    if (!pinToastEl) return;
    if (pinToastTimer !== null) clearTimeout(pinToastTimer);
    pinToastEl.textContent = text;
    pinToastEl.classList.add('rlog-pin-toast-active');
    pinToastTimer = setTimeout(hidePinToast, PIN_TOAST_DURATION_MS);
}

/* 隐藏置顶/取消置顶 toast（自动消失或点击提前消除）。 */
function hidePinToast() {
    if (pinToastTimer !== null) {
        clearTimeout(pinToastTimer);
        pinToastTimer = null;
    }
    if (pinToastEl) {
        pinToastEl.classList.remove('rlog-pin-toast-active');
    }
}

/* 移动端长按重排期间的 hover 抑制：
   给 #rlog-list 加临时类，让补位记录不因触摸模拟 hover 凭空高亮；
   抑制类在「下一次新触摸/点击(pointerdown)」或「鼠标移动(pointermove)」时移除，
   不随本次手势的 pointerup/pointercancel 清除，避免触摸浏览器残留 :hover 重新冒出。 */
function beginHoverSuppress() {
    if (!panelEl) return;
    const listEl = panelEl.querySelector('#rlog-list');
    if (!listEl) return;
    listEl.classList.add('rlog-hover-suppress');
    if (hoverSuppressBound) return;
    hoverSuppressBound = true;

    const end = () => {
        if (!hoverSuppressBound) return;
        hoverSuppressBound = false;
        const cur = panelEl ? panelEl.querySelector('#rlog-list') : null;
        if (cur) cur.classList.remove('rlog-hover-suppress');
        document.removeEventListener('pointerdown', end, { capture: true });
        document.removeEventListener('pointermove', onMouseMove, { capture: true });
    };

    const onMouseMove = (e) => { if (e.pointerType === 'mouse') end(); };

    /* 不在本次手势的 pointerup/pointercancel 就清除：触摸浏览器（Android WebView 等）会残留 :hover，
       且重排时可能触发 pointercancel，过早清除都会让补位条目重新显示 hover。
       改为：下一次新触摸/点击(pointerdown)或鼠标移动(pointermove)时再清除。
       不设兜底超时——纯触屏没有鼠标 hover，等待下一次 pointerdown 才清除，
       避免「隔一会儿自动恢复抑制导致残留 hover 又冒出来」。 */
    document.addEventListener('pointerdown', end, { capture: true });
    document.addEventListener('pointermove', onMouseMove, { capture: true });
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
        listEl.scrollTo({ top: clampedListScroll, behavior: getScrollBehavior() });
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

/* 按真实 records 索引取当前列表中的记录 DOM 元素（渲染顺序可能与 records 顺序不同，
   但 data-record-index 始终写真实索引，故查询可用）。 */
function getRecordElByIndex(index) {
    if (!panelEl) return null;
    const listEl = panelEl.querySelector('#rlog-list');
    return listEl ? listEl.querySelector(`.rlog-record[data-record-index="${index}"]`) : null;
}

/* 滚动列表，使指定记录标题栏出现在可视区顶部（置顶记录可能排在目标记录上方）。
   用视图坐标差计算，避免依赖 offsetTop 与定位父级。 */
function scrollToRecordEl(recordEl) {
    if (!panelEl || !recordEl) return;
    const listEl = panelEl.querySelector('#rlog-list');
    if (!listEl) return;
    const listRect = listEl.getBoundingClientRect();
    const recordRect = recordEl.getBoundingClientRect();
    const target = listEl.scrollTop + (recordRect.top - listRect.top);
    const maxScroll = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
    const clamped = Math.min(Math.max(0, target), maxScroll);
    if (Math.abs(clamped - listEl.scrollTop) > 1) {
        listEl.scrollTop = clamped;
    }
}

/* 无按钮回顶时的提示闪烁：列表回到顶部后，对顶部（最新一条）记录做一次
   与置底相同的轻微闪烁，提示「当前已回到最新一条」。
   顶部记录展开时闪第一条子消息标题栏（与置底镜像），折叠/不可见时闪记录标题栏
   （保证目标始终可见）。界面未打开（后台记录状态）或窗口折叠时不触发。 */
function flashTopHint(recordEl) {
    if (!panelEl || !isPanelVisible || isPanelCollapsed) return;
    const listEl = panelEl.querySelector('#rlog-list');
    const firstRecord = recordEl || (listEl ? listEl.querySelector('.rlog-record') : null);
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
    /* 极简模式：不做标题栏底色闪烁（仅保留滚动定位），同时避免 animation:none 下
       animationend 不触发导致 .rlog-flash-bottom 类残留。 */
    if (preferences.minimal) return;
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
    const toggleEl = readFullOverlayEl.querySelector('.rlog-read-format-btn');
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
        behavior: getScrollBehavior(),
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
                <button class="rlog-read-format-btn formatted" title="切换显示格式" aria-label="切换显示格式">{}</button>
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
    const toggleEl = overlay.querySelector('.rlog-read-format-btn');
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

/* 浮标实际边长：桌面 36×36，移动端（≤768px）32×32（与 style.css 末尾媒体查询一致） */
function getBadgeSize() {
    return window.matchMedia('(max-width: 768px)').matches ? 32 : BADGE_SIZE;
}

/* 浮标在视口内的合法位置：入参为浮标左上角坐标，clamp 到视口内（保证浮标完全可见）。
   top 下限取 ST 顶部设置栏实际高度：浮标层级低于顶部设置栏，若进入该高度会被它遮住点不到，
   故禁止浮标进入顶部栏区域，确保任何位置都可见可点。 */
function clampBadgeToViewport(left, top) {
    const size = getBadgeSize();
    const topBarEl = document.getElementById('top-settings-holder');
    const minTop = topBarEl ? Math.ceil(topBarEl.getBoundingClientRect().height) : 0;
    const maxLeft = Math.max(0, window.innerWidth - size);
    const maxTop = Math.max(minTop, window.innerHeight - size);
    return {
        left: Math.min(Math.max(0, left), maxLeft),
        top: Math.min(Math.max(minTop, top), maxTop),
    };
}

/* 「浮标默认入口」开启时，浮标在右上角的默认位置：
   距右缘 BADGE_DEFAULT_MARGIN_RIGHT、在 ST 顶部设置栏下缘再往 BADGE_DEFAULT_MARGIN_TOP 处，
   最后经 clampBadgeToViewport 兜底（保证不进顶栏、不出视口）。
   仅用于启动/关闭面板后 badgePos 为空（或需重置）时的初始落位；拖动后 badgePos 接管。 */
function getDefaultBadgePos() {
    const size = getBadgeSize();
    const topBarEl = document.getElementById('top-settings-holder');
    const minTop = topBarEl ? Math.ceil(topBarEl.getBoundingClientRect().height) : 0;
    return clampBadgeToViewport(
        window.innerWidth - size - BADGE_DEFAULT_MARGIN_RIGHT,
        minTop + BADGE_DEFAULT_MARGIN_TOP
    );
}

/* 浮标尺寸同步：host 的宽/高随桌面 36 / 移动 32 切换（getBadgeSize 已按断点返回）。
   初始化与 resize 时调用，避免桌面↔移动切换后尺寸不同步。 */
function updateBadgeSize() {
    if (!badgeEl) return;
    const size = getBadgeSize();
    badgeEl.style.width = size + 'px';
    badgeEl.style.height = size + 'px';
}

/* 浮标主题变量：把原挂 #rlog-shadow-host 的三个浮标变量接到新的 light DOM host 上，
   由 host 跨影子边界继承给 shadow root 内的 .rlog-badge-visual，配色仍跟随 ST 主题。 */
function syncBadgeThemeVars() {
    if (!badgeEl) return;
    badgeEl.style.setProperty('--rlog-badge-bg', 'color-mix(in srgb, var(--SmartThemeQuoteColor, #52525b) 75%, transparent)');
    badgeEl.style.setProperty('--rlog-badge-icon', '#ffffff');
    badgeEl.style.setProperty('--rlog-badge-border', 'var(--SmartThemeQuoteColor, #52525b)');
}

/* 重置面板为默认定位/尺寸：清掉此前拖拽/缩放写入的 inline 样式，让 CSS 默认值生效
   （默认：top:80px + left:50% + translateX(-50%) + 宽高/上下限走 style.css 基准）。
   不额外做边界修正：默认定位本就居中/贴边、在视口内（水平由 95vw 上限保证，
   垂直仅极端小视口底部略超，与刷新后初始布局一致），无需防跑出界面。 */
function resetPanelToDefault() {
    if (!panelEl) return;
    panelEl.style.left = '';
    panelEl.style.top = '';
    panelEl.style.right = '';
    panelEl.style.bottom = '';
    panelEl.style.transform = '';
    panelEl.style.width = '';
    panelEl.style.height = '';
    panelEl.style.minHeight = '';
    panelEl.style.maxHeight = '';
    panelEl.style.transition = '';
}

/* 切换浮标显隐：浮标仅在「收起面板」态显示（.rlog-badge-active），其余时间隐藏 */
function setBadgeActive(active) {
    if (!badgeEl) return;
    if (active) badgeEl.classList.add('rlog-badge-active');
    else badgeEl.classList.remove('rlog-badge-active');
    /* host 是 light DOM，用 inline display 最稳，避免第三方主题通过普通 CSS 影响显隐 */
    badgeEl.style.display = active ? 'flex' : 'none';
}

/* 标题文字点击触发的「面板 ↔ 浮标」切换。
   @param {MouseEvent} [ev] 点击事件（用于以点击坐标作为浮标中心；首次收起且无事件时居中兜底） */
function togglePanelWindow(ev) {
    isPanelCollapsed = !isPanelCollapsed;
    if (isPanelCollapsed) {
        /* 收起为浮标：会话内首次收起以当次点击标题文字的坐标作为浮标中心并记录；
           会话内再次收起复用记录的位置（拖动过后即为拖动后位置）。
           展开/拖动标题栏不影响记录值；刷新/重新初始化后 badgePos 重置为 null，按首次收起处理。 */
        hidePinToast();
        panelEl.classList.add('rlog-window-collapsed');
        panelEl.style.display = 'none';
        if (badgeEl) {
            if (!badgePos) {
                const size = getBadgeSize();
                const cx = ev ? ev.clientX : window.innerWidth / 2;
                const cy = ev ? ev.clientY : window.innerHeight / 2;
                badgePos = clampBadgeToViewport(cx - size / 2, cy - size / 2);
            } else {
                /* 复用记录位置，并在当前视口/尺寸下 clamp（窗口缩小或断点切换后仍保证可见） */
                badgePos = clampBadgeToViewport(badgePos.left, badgePos.top);
            }
            badgeEl.style.left = badgePos.left + 'px';
            badgeEl.style.top = badgePos.top + 'px';
        }
        setBadgeActive(true);
    } else {
        /* 恢复面板：隐藏浮标，把面板重置为默认定位/尺寸后重新显示 */
        setBadgeActive(false);
        panelEl.classList.remove('rlog-window-collapsed');
        panelEl.style.display = 'flex';
        resetPanelToDefault();
        /* 折叠期间可能已有数据/渲染变化（新记录到达），恢复前先重建 DOM */
        if (panelContentDirty) {
            renderPanelContent();
        }
        /* 窗口重新展开后重测记录标题栏高度（隐藏期间 offsetHeight 为 0，吸顶偏移需刷新） */
        syncRecordHeaderVars(panelEl.querySelector('#rlog-list'));
        /* 折叠期间有新记录到达时，恢复展开后回到列表顶部最新一条 */
        if (pendingScrollToTop) {
            pendingScrollToTop = false;
            const newRecordEl = getRecordElByIndex(0);
            if (newRecordEl) {
                scrollToRecordEl(newRecordEl);
                flashTopHint(newRecordEl);
            } else {
                const listEl = panelEl.querySelector('#rlog-list');
                if (listEl) listEl.scrollTop = 0;
                flashTopHint();
            }
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

/* 定位本插件自身的 style.css 真实地址：优先用 ST 已注入的插件样式 <link>（id 形如 "<目录>-css"，
   这里按插件目录名 RecentRequestLog 匹配），找不到时回退硬编码路径（与 loadTourScript 兜底一致）。
   不用 import.meta：ST 以 ES Module 加载时 document.currentScript 为 null，且逻辑测试用 Node VM 载入本文件（非 module）。 */
function getSelfCssUrl() {
    try {
        const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find(l => l.id && l.id.endsWith('RecentRequestLog-css'));
        if (link) return link.href;
    } catch (e) { /* 无 document（如逻辑测试 VM 不执行到此）或异常，走兜底 */ }
    return '/scripts/extensions/third-party/RecentRequestLog/style.css';
}

/* 影子内样式源（优先）：从 ST 已加载的本插件 style.css <link> 的样式表规则同步拷贝成影子内 <style>。
   这样影子内样式立即生效，避免用 <link> 异步加载导致早期测量（如状态占位宽度探针）采不到 class 样式。 */
function buildSelfCssElement() {
    try {
        const selfCssUrl = getSelfCssUrl();
        const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find(l => l.href === selfCssUrl);
        if (link && link.sheet && link.sheet.cssRules && link.sheet.cssRules.length) {
            const style = document.createElement('style');
            style.textContent = [...link.sheet.cssRules].map(r => r.cssText).join('\n');
            return style;
        }
    } catch (e) {
        /* 跨域或样式表未就绪等：走下方 <link> 兜底 */
    }
    return buildSelfCssLink();
}

/* 影子内样式源（兜底）：直接引用本插件自身的 style.css 文件（浏览器缓存复用，不重复加载内容） */
function buildSelfCssLink() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = getSelfCssUrl();
    return link;
}

/* 影子内 FA 固壳：文档级 @font-face / .fa 规则进不了影子，这里在影子内补最小可用的一层。
   - @font-face 复用 ST 现有 fa-solid-900 字体文件（绝对地址，不下载不复制）
   - 只写插件实际使用的 33 个图标的 ::before content；新增图标在 FA_SOLID_CONTENT 补一行 */
function buildFaShimStyle() {
    const style = document.createElement('style');
    /* 影子内复用 ST 现有 fa-solid-900 字体文件（绝对地址，不下载不复制）；在浏览器运行时换算一次 */
    const faWoff2 = new URL('webfonts/fa-solid-900.woff2', location.href).href;
    const faTtf = new URL('webfonts/fa-solid-900.ttf', location.href).href;
    const rules = [
        /* 影子内通用基准：ST 全局的 *{box-sizing:border-box;text-shadow:...} 等不进入影子，这里补上（去主题化）。
           text-shadow 是可继承属性——ST 全局 * 会命中挂在 body 下的 shadow host，把主题算出的
           text-shadow（某主题可把 --SmartThemeShadowColor/--shadowWidth 设成彩色辉光）经继承渗进影子，
           必须在影子内重置为 none。其余则因 shadow 隔离丢了宿主全局基准，需一并补上，
           否则元素默认 content-box、min-width/padding 计算会与旧版不一致（如状态占位槽位宽）。 */
        '*,*::before,*::after{box-sizing:border-box;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;-webkit-tap-highlight-color:transparent;text-shadow:none}',
        '@font-face{font-family:"Font Awesome 6 Free";font-style:normal;font-weight:900;font-display:block;'
            + `src:url("${faWoff2}") format("woff2"),url("${faTtf}") format("truetype")}`,
        '.fa,.fa-solid,.fas{font-family:"Font Awesome 6 Free";font-weight:900;font-style:normal;font-variant:normal;'
            + 'line-height:1;text-rendering:auto;display:inline-block;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}',
    ];
    for (const [name, code] of Object.entries(FA_SOLID_CONTENT)) {
        rules.push(`.fa-solid.fa-${name}:before{content:"${code}"}`);
    }
    style.textContent = rules.join('\n');
    return style;
}

/* 浮标视觉样式：浮标已拆成独立 light DOM host（#rlog-badge-host），可见视觉放在它自己的 shadow root 内。
   - host 本身只负责定位/尺寸/光标/透明背景（走 inline 样式），不放视觉；
   - 视觉（背景/边框/圆角/图标颜色/字号）全部由 shadow root 内 .rlog-badge-visual 提供，
     第三方主题的普通 CSS 依然碰不到（继续受 Shadow DOM 隔离）；
   - --rlog-badge-* 自定义属性由 syncBadgeThemeVars() 写到 host 上，跨影子边界继承给视觉元素，
     配色仍跟随 ST 主题（--SmartThemeQuoteColor 引用文本色）。 */
function buildBadgeStyle() {
    const style = document.createElement('style');
    style.textContent = [
        ':host{box-sizing:border-box;background:transparent;border:0;padding:0;margin:0}',
        '.rlog-badge-visual{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;'
            + 'border-radius:6px;background:var(--rlog-badge-bg,#52525b);'
            + 'border:1px solid var(--rlog-badge-border,#52525b);color:var(--rlog-badge-icon,#fff);'
            + 'font-size:16px;cursor:pointer;user-select:none;-webkit-user-select:none}',
        '@media(max-width:768px){.rlog-badge-visual{font-size:14px}}',
    ].join('\n');
    return style;
}

/* 影子内「极简模式」样式：通过 :host(.rlog-minimal) 一次性关闭面板/弹窗的全部过渡与动画。
   用 :host 而不是 #rlog-panel 前缀，是因为设置上限/确认弹窗挂在 panelShadowRoot、
   与 #rlog-panel 平级（不在面板内），只有 :host 能同时兜住面板与弹窗。
   要点：
   - 去掉全部 transition/animation（hover 渐变、抽屉滑出、箭头旋转、token 脉冲、
     搜索框展开、主题呼吸、弹窗淡入、滚动条淡入淡出等），保留瞬时状态反馈；
   - 去掉偏好浮层 1px 虚化（遮罩本身与半透明背景保留）；
   - 显式豁免使用引导（.rlog-tour-*）：引导气泡淡入与小三角 left 平滑跟随照旧，
     不受极简模式影响。此类规则不能写进外部 style.css（文档里的 :host 会被丢弃且拷不进影子），
     只能在 JS 运行时注入影子。 */
function buildMinimalShimStyle() {
    const style = document.createElement('style');
    const rules = [
        ':host(.rlog-minimal){transition:none!important;animation:none!important}',
        ':host(.rlog-minimal) *,:host(.rlog-minimal) *::before,:host(.rlog-minimal) *::after{transition:none!important;animation:none!important}',
        ':host(.rlog-minimal) .rlog-pref-overlay{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}',
        ':host(.rlog-minimal) .rlog-tour-highlight::before,:host(.rlog-minimal) .rlog-tour-highlight::after{transition:none!important;animation:none!important}',
        ':host(.rlog-minimal) .rlog-tour-highlight{transition:all .3s cubic-bezier(.4,0,.2,1)!important;animation:none!important}',
        ':host(.rlog-minimal) .rlog-tour-tooltip::before,:host(.rlog-minimal) .rlog-tour-tooltip::after{transition:left .3s cubic-bezier(.4,0,.2,1)!important;animation:none!important}',
        ':host(.rlog-minimal) .rlog-tour-tooltip{transition:all .3s cubic-bezier(.4,0,.2,1)!important;animation:rlog-dialog-fadein .3s ease-out!important}',
    ];
    style.textContent = rules.join('\n');
    return style;
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
                    <button id="rlog-master-toggle" class="rlog-header-btn rlog-master-on" title="总开关：已启用 — 点击关闭">
                        <i class="fa-solid fa-power-off"></i>
                    </button>
                    <button id="rlog-help-btn" class="rlog-header-btn" title="查看使用引导">
                        <i class="fa-solid fa-question"></i>
                    </button>
                    <button id="rlog-pref-btn" class="rlog-header-btn" title="偏好设置">
                        <i class="fa-solid fa-heart"></i>
                    </button>
                    <button id="rlog-preview-btn" class="rlog-header-btn" title="内容预览-已关闭">
                        <i class="fa-solid fa-eye-slash"></i>
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
        <div id="rlog-pin-toast" class="rlog-pin-toast" aria-live="polite"></div>
        <div class="rlog-pref-overlay" id="rlog-pref-overlay">
            <div class="rlog-pref-panel">
                <div class="rlog-pref-header">
                    <div class="rlog-pref-header-text">
                        <span class="rlog-pref-title">偏好设置</span>
                        <div class="rlog-pref-sub">一些针对特定偏好的持久化设置</div>
                    </div>
                    <button class="rlog-pref-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="rlog-pref-divider"></div>
                <div class="rlog-pref-list-wrap">
                    <i class="rlog-pref-scroll rlog-pref-scroll-up fa-solid fa-chevron-up"></i>
                    <div class="rlog-pref-list">
                        <div class="rlog-pref-item">
                            <div class="rlog-pref-item-text">
                                <span class="rlog-pref-label">浮标作为默认入口</span>
                                <div class="rlog-pref-item-desc">开启后，插件启动默认显示浮标<br>否则仅最小化时出现浮标</div>
                            </div>
                            <button class="rlog-toggle" data-pref-key="badgeDefault" role="switch" aria-checked="false" aria-label="浮标默认入口"></button>
                        </div>
                        <div class="rlog-pref-item">
                            <div class="rlog-pref-item-text">
                                <span class="rlog-pref-label">移动端默认全屏</span>
                                <div class="rlog-pref-item-desc">阅读区域最大化，覆盖下一项设置<br>因为没有面板外区域了</div>
                            </div>
                            <button class="rlog-toggle" data-pref-key="mobileFull" role="switch" aria-checked="false" aria-label="移动端全屏"></button>
                        </div>
                        <div class="rlog-pref-item">
                            <div class="rlog-pref-item-text">
                                <span class="rlog-pref-label">点击面板外关闭</span>
                                <div class="rlog-pref-item-desc">不用跟 x 较劲了，点哪都能关</div>
                            </div>
                            <button class="rlog-toggle" data-pref-key="clickOutside" role="switch" aria-checked="false" aria-label="点击面板外关闭"></button>
                        </div>
                        <div class="rlog-pref-item">
                            <div class="rlog-pref-item-text">
                                <span class="rlog-pref-label">筛选状态持久化</span>
                                <div class="rlog-pref-item-desc">筛选项不再自动重置<br>开启后找不着内容记得先重置筛选</div>
                            </div>
                            <button class="rlog-toggle" data-pref-key="filterPersist" role="switch" aria-checked="false" aria-label="筛选状态持久化"></button>
                        </div>
                        <div class="rlog-pref-item">
                            <div class="rlog-pref-item-text">
                                <span class="rlog-pref-label">极简模式</span>
                                <div class="rlog-pref-item-desc">去掉所有平滑滚动、悬浮、闪烁提示<br>等视觉效果，非常直来直去</div>
                            </div>
                            <button class="rlog-toggle" data-pref-key="minimal" role="switch" aria-checked="false" aria-label="极简模式"></button>
                        </div>
                    </div>
                    <i class="rlog-pref-scroll rlog-pref-scroll-down fa-solid fa-chevron-down"></i>
                </div>
            </div>
        </div>
    `;

    panelEl.classList.remove('rlog-window-collapsed');

    /* 影子 DOM 隔离：宿主 + 影子根，面板与其样式放进影子，从而不被第三方主题 CSS 覆盖 */
    shadowHostEl = document.createElement('div');
    shadowHostEl.id = 'rlog-shadow-host';
    panelShadowRoot = shadowHostEl.attachShadow({ mode: 'open' });
    panelShadowRoot.appendChild(buildSelfCssElement());
    panelShadowRoot.appendChild(buildFaShimStyle());
    panelShadowRoot.appendChild(buildMinimalShimStyle());
    panelShadowRoot.appendChild(panelEl);
    document.body.appendChild(shadowHostEl);

    /* 浮标：拆成独立 light DOM host（#rlog-badge-host）+ 自己的 shadow root。
       - host 暴露在普通 DOM，带 script_id/role/title/class/固定定位，供第三方收纳插件识别/收纳；
       - 可见视觉放在 host 自己的 shadow root 内（.rlog-badge-visual），第三方主题 CSS 碰不到；
       - 里面放一个隐藏的 light DOM 图标，方便收纳插件用 querySelector('i') 提取图标；
       - host 只承担定位/尺寸/光标/透明背景，不放视觉。 */
    badgeEl = document.createElement('div');
    badgeEl.id = 'rlog-badge-host';
    badgeEl.className = 'rlog-badge-host rlog-floating-button';
    badgeEl.setAttribute('script_id', 'recent-request-log-badge');
    badgeEl.setAttribute('role', 'button');
    badgeEl.setAttribute('aria-label', '最近请求记录');
    badgeEl.title = '最近请求记录';
    badgeEl.style.cssText =
        `position:fixed;display:none;width:${getBadgeSize()}px;height:${getBadgeSize()}px;`
        + 'cursor:pointer;z-index:2999;box-sizing:border-box;background:transparent;border:0;padding:0;margin:0;';
    /* 隐藏的 light DOM 图标：宿主有 shadow root，light 子元素默认不渲染，且带 hidden，双保险不显示 */
    badgeEl.innerHTML = '<i class="fa-solid fa-book" hidden></i>';

    const badgeShadowRoot = badgeEl.attachShadow({ mode: 'open' });
    badgeShadowRoot.appendChild(buildBadgeStyle());
    badgeShadowRoot.appendChild(buildFaShimStyle());
    badgeVisualEl = document.createElement('div');
    badgeVisualEl.className = 'rlog-badge-visual';
    badgeVisualEl.innerHTML = '<i class="fa-solid fa-book"></i>';
    badgeShadowRoot.appendChild(badgeVisualEl);
    document.body.appendChild(badgeEl);

    /* 把浮标主题变量挂到 host，并同步当前尺寸；然后交给指针交互 */
    syncBadgeThemeVars();
    updateBadgeSize();
    initBadgeInteraction();
    /* host 就绪后重放主题类（浮标可见视觉由 host 上的 --rlog-badge-* 提供） */
    applyTheme();

    /* H4 标题文字拆分：文字部分单击折叠/展开，数字部分双击设置最大记录数 */
    {
        const textEl = panelEl.querySelector('.rlog-title-text');
        const countEl = panelEl.querySelector('.rlog-title-count');
        /* number|null: 用于延迟判断双单击的定时器 ID（仅数字部分使用） */
        let countClickTimer = null;

        /* 文字部分：单击立即折叠/展开窗口（无延迟） */
        textEl.addEventListener('click', (e) => {
            e.stopPropagation();
            /* 引导期间不收起：浮标会让引导高亮目标（面板内元素）消失，破坏引导 */
            if (tourActive) return;
            togglePanelWindow(e);
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

    /* 全局点击监听：开启「点击面板外关闭」偏好时，点在主面板之外就关闭整个面板。
       要点：
       - 影子 DOM 下面板/弹窗/偏好浮层内的点击会重定向到 #rlog-shadow-host，用
         `e.target === shadowHostEl || e.composedPath().includes(panelEl)` 判定「面板内」；
       - 点击插件自己的菜单切换按钮（#prompt-capture-toggle）要放行——否则用切换按钮
         "打开面板"的那一次点击会立刻把面板关掉（该按钮在面板外，但属插件自身开关）；
       - 偏好标志在点击时读取，无需随开关增删监听。 */
    if (!document.rlogOutsideCloseListenerInstalled) {
        document.rlogOutsideCloseListenerInstalled = true;
        document.addEventListener('click', (e) => {
            if (!preferences.clickOutside || !isPanelVisible) return;
            /* 浮标态：点面板外不清除浮标（浮标是插件入口，用户主动收起产生，不应被当待关闭面板处理）；
               点击浮标本身由浮标自己的 pointerup 处理（恢复面板）。 */
            if (isPanelCollapsed) return;
            if (toggleBtn && toggleBtn.contains(e.target)) return;
            const insidePanel = e.target === shadowHostEl || e.composedPath().includes(panelEl);
            if (insidePanel) return;
            hidePanel();
        });
    }

    panelEl.querySelector('#rlog-close-btn').addEventListener('click', hidePanel);

    panelEl.querySelector('#rlog-collapse-all-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        collapseAllEntries();
    });

    panelEl.querySelector('#rlog-clear-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const normalCount = getNormalRecords().length;
        const pinnedCount = records.length - normalCount;
        if (normalCount === 0) {
            /* 没有普通记录：统一用轻量提示反馈，不弹确认弹窗、不删除任何记录 */
            showPinToast(pinnedCount > 0
                ? '没有可清空的普通记录，置顶记录不会被清除'
                : '没有可清空的记录');
            return;
        }
        /* 筛选生效时在确认文案中注明被隐藏的普通记录也会一并清空 */
        const visibleNormalCount = getVisibleRecords().filter(r => !r.pinned).length;
        const hiddenNormalCount = normalCount - visibleNormalCount;
        const pinnedNote = pinnedCount > 0
            ? `<br>（<strong>${pinnedCount}</strong> 条置顶记录会保留）`
            : '<br>（无置顶记录）';
        showConfirmDialog({
            title: '清空所有记录',
            message: hiddenNormalCount > 0
                ? `确定要清空全部 <strong>${normalCount}</strong> 条普通请求记录吗？（其中 <strong>${hiddenNormalCount}</strong> 条被筛选隐藏，也会一并清空）${pinnedNote}<br>此操作不可撤销。`
                : `确定要清空全部 <strong>${normalCount}</strong> 条普通请求记录吗？${pinnedNote}<br>此操作不可撤销。`,
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

    /* 偏好设置：入口按钮 + 浮层 */
    prefBtnEl = panelEl.querySelector('#rlog-pref-btn');
    prefOverlayEl = panelEl.querySelector('#rlog-pref-overlay');

    if (prefBtnEl) {
        prefBtnEl.addEventListener('click', (e) => {
            e.stopPropagation();
            openPrefPanel();
            e.currentTarget.blur();
        });
    }

    if (prefOverlayEl) {
        /* 右上角 × 为浮层唯一关闭方式 */
        const prefCloseEl = prefOverlayEl.querySelector('.rlog-pref-close');
        if (prefCloseEl) {
            prefCloseEl.addEventListener('click', (e) => {
                e.stopPropagation();
                closePrefPanel();
                e.currentTarget.blur();
            });
        }

        /* 每个 Toggle：点击翻转状态 + 持久化 + 更新入口图标态（4 项行为均已接入实际行为） */
        const toggles = prefOverlayEl.querySelectorAll('.rlog-toggle');
        toggles.forEach((toggle) => {
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const key = toggle.getAttribute('data-pref-key');
                if (!key) return;
                setPreference(key, !preferences[key]);
                e.currentTarget.blur();
            });
        });

        /* 滚动提示箭头：内容需要滚动时更新上下方向提示 */
        const prefListEl = prefOverlayEl.querySelector('.rlog-pref-list');
        if (prefListEl) {
            prefListEl.addEventListener('scroll', () => updatePrefScrollArrows(), { passive: true });
        }

        /* 遮罩点击：什么都不做（既不开也不关）——只作为「盖住面板、阻断底层内容交互」的层。
           点击浮层外主面板范围不关闭浮层；浮层只能通过右上角 × 关闭。 */
    }

    /* 加载持久化偏好并同步入口图标 + 开关视觉（首次构建面板时初始化） */
    loadPreferences();
    updatePrefButtonIcon();
    syncPrefToggleUI();
    /* 移动端全屏：初始化时按偏好 + 当前视口设置全屏类（面板此刻 display:none，样式待展示时生效） */
    updateMobileFullscreenClass();
    /* 极简模式：初始化时按偏好给影子宿主加/去类（触发 :host 极简规则，关掉全部动效） */
    updateMinimalClass();
    /* 筛选状态持久化：开启时读取上次持久化的筛选并覆盖默认真实状态（在 updateFilterChipUI 前生效） */
    loadPersistedFilterState();
    /* 「浮标默认入口」：开启时启动默认显示浮标（右上角默认位置），面板保持隐藏、非折叠态，
       扩展菜单入口不亮 active。badgePos 仍不持久化——刷新/重新初始化回到默认位置。 */
    if (preferences.badgeDefault && badgeEl) {
        if (!badgePos) badgePos = getDefaultBadgePos();
        else badgePos = clampBadgeToViewport(badgePos.left, badgePos.top);
        badgeEl.style.left = badgePos.left + 'px';
        badgeEl.style.top = badgePos.top + 'px';
        setBadgeActive(true);
    }

    panelEl.querySelector('#rlog-theme-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        isLightTheme = !isLightTheme;
        saveTheme(isLightTheme);
        applyTheme();
        updateThemeButtonIcon();
        
        /* 触发主题切换专属缩放特效（不在打开窗口时触发） */
        panelEl.classList.remove('rlog-anim-light', 'rlog-anim-dark');

        /* 极简模式：主题已通过 applyTheme() 瞬时切换，跳过缩放呼吸/颜色渐变编排，
           避免 animation:none 下 animationend 不触发导致动画类残留。 */
        if (preferences.minimal) return;

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
    const previewToggleEl = panelEl.querySelector('#rlog-preview-btn');
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
            /* 桌面↔移动切换时同步浮标尺寸 */
            updateBadgeSize();
            /* 浮标可见时随视口变化 clamp 回可视区域，避免窗口缩小后浮标跑出屏幕。
               不限定折叠态：默认入口模式下浮标可能在非折叠态（面板关闭）显示，同样需要 clamp。 */
            if (badgeEl && badgeEl.classList.contains('rlog-badge-active')) {
                const pos = clampBadgeToViewport(
                    parseFloat(badgeEl.style.left) || 0,
                    parseFloat(badgeEl.style.top) || 0
                );
                badgeEl.style.left = pos.left + 'px';
                badgeEl.style.top = pos.top + 'px';
                /* resize 后同步更新会话内记录位置 */
                badgePos = pos;
            }
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

    /* 置顶/取消置顶提示：点击可提前消除（阻止事件冒泡避免触发文档级「点击面板外关闭」） */
    const pinToast = panelEl.querySelector('#rlog-pin-toast');
    if (pinToast) {
        pinToast.addEventListener('click', (e) => {
            e.stopPropagation();
            hidePinToast();
        });
    }

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
    /* 兜底：确保从浮标/折叠态回到展开面板（正常流程经 hidePanel 已复位，此处防御） */
    setBadgeActive(false);
    panelEl.classList.remove('rlog-window-collapsed');
    isPanelCollapsed = false;
    /* 「浮标默认入口」：重新打开面板一律回到插件默认位置/尺寸（点浮标与扩展菜单入口两个打开路径统一，
       与「折叠→浮标→点浮标恢复」语义一致）；非默认入口维持原展示位置。 */
    if (preferences.badgeDefault) resetPanelToDefault();
    panelEl.style.display = 'flex';
    isPanelVisible = true;
    /* 移动端全屏：打开面板时应用/撤销全屏类（偏好开启 + 移动端视口才生效） */
    updateMobileFullscreenClass();
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
        const newRecordEl = getRecordElByIndex(0);
        if (newRecordEl) {
            scrollToRecordEl(newRecordEl);
            flashTopHint(newRecordEl);
        } else {
            const listEl = panelEl.querySelector('#rlog-list');
            if (listEl) listEl.scrollTop = 0;
            flashTopHint();
        }
    }

    /* 在面板显示后检查是否需要进行引导 */
    if (window.__RLogTour && typeof window.__RLogTour.check === 'function') {
        setTimeout(() => window.__RLogTour.check(), 300);
    }
}

function hidePanel() {
    /* 关闭面板时退出搜索模式 */
    resetSearchIfActive();
    /* 关闭面板时隐藏置顶/取消置顶 toast */
    hidePinToast();
    /* 关闭面板时取消尚未触发的置底闪烁（避免关闭后定时器在隐藏 DOM 上触发） */
    cancelPendingFlash();
    /* 关闭面板时隐式清理「查看全文」覆盖层（如存在） */
    closeReadFullOverlay();
    /* 关闭面板时同时收起「偏好设置」浮层，避免浮层开着时关面板、重开仍残留打开态 */
    closePrefPanel();
    isPanelCollapsed = false;
    if (panelEl) {
        /* 清理置底跳转的标题栏闪烁类，防止下次打开面板时动画重播 */
        let cleared = false;
        panelEl.querySelectorAll('.rmsg-header.rlog-flash-bottom, .rlog-record-header.rlog-flash-bottom').forEach(el => {
            el.classList.remove('rlog-flash-bottom');
            cleared = true;
        });
        /* 关闭面板等同主动打断：清空回顶时间戳，重开后回复重渲染不再补闪 */
        if (cleared) lastTopHintFlashAt = 0;
        panelEl.classList.remove('rlog-window-collapsed');
        panelEl.style.display = 'none';
        /* 关闭面板时清理残留的主题切换动画类，防止下次打开时重播 */
        panelEl.classList.remove('rlog-anim-light', 'rlog-anim-dark');
    }
    isPanelVisible = false;
    if (toggleBtn) toggleBtn.classList.remove('active');
    /* 「浮标默认入口」：关闭面板后浮标回到 badgePos（为空则用右上默认位置），浮标仍不持久化；
       非默认入口保持现状——面板完全关闭、浮标消失。 */
    if (preferences.badgeDefault && badgeEl) {
        if (!badgePos) badgePos = getDefaultBadgePos();
        else badgePos = clampBadgeToViewport(badgePos.left, badgePos.top);
        badgeEl.style.left = badgePos.left + 'px';
        badgeEl.style.top = badgePos.top + 'px';
        setBadgeActive(true);
    } else {
        setBadgeActive(false);
    }
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

/* 浮标拖拽/点击交互（Pointer Events 统一鼠标与触屏）。
   拖动只移动浮标自身；拖动结束时不能误触发 click 恢复面板——用位移阈值区分：
   位移 > BADGE_DRAG_THRESHOLD 视为拖动，pointerup 时不再恢复；未达到阈值视为点击，恢复面板。 */
function initBadgeInteraction() {
    if (!badgeEl) return;
    /* 点击浮标恢复面板后，浮标随即隐藏、同坐标出现面板；浏览器随后派发的原生 click
       会被 hit-test 到该位置的面板按钮/标题上（误开「更多/筛选」抽屉或误触折叠）。
       这里用 document 捕获阶段一次性守卫按 badgeSuppressNextClick 标记拦掉这一次 click。 */
    if (!document.rlogBadgeClickGuardInstalled) {
        document.rlogBadgeClickGuardInstalled = true;
        document.addEventListener('click', (e) => {
            if (badgeSuppressNextClick) {
                badgeSuppressNextClick = false;
                e.stopPropagation();
                e.preventDefault();
            }
        }, true);
    }
    let dragActive = false;
    let dragged = false;
    let startX = 0, startY = 0, origLeft = 0, origTop = 0;

    badgeEl.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        dragActive = true;
        dragged = false;
        startX = e.clientX;
        startY = e.clientY;
        origLeft = parseFloat(badgeEl.style.left) || 0;
        origTop = parseFloat(badgeEl.style.top) || 0;
        try { badgeEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        e.preventDefault();
    });

    badgeEl.addEventListener('pointermove', (e) => {
        if (!dragActive) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!dragged && Math.hypot(dx, dy) > BADGE_DRAG_THRESHOLD) {
            dragged = true;
        }
        if (dragged) {
            const pos = clampBadgeToViewport(origLeft + dx, origTop + dy);
            badgeEl.style.left = pos.left + 'px';
            badgeEl.style.top = pos.top + 'px';
            /* 拖动后更新会话内记录位置，供下次收起复用 */
            badgePos = pos;
        }
    });

    const onBadgeUp = (e) => {
        if (!dragActive) return;
        dragActive = false;
        e.stopPropagation();
        try { badgeEl.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        const wasDrag = dragged;
        if (wasDrag) {
            /* 拖拽：浏览器仍会在 pointerup 后补发原生 click，拦掉它以免误当成「点击打开面板」 */
            badgeSuppressNextClick = true;
            setTimeout(() => { badgeSuppressNextClick = false; }, 0);
        }
        if (e.type === 'pointercancel') {
            /* 指针取消（如触摸被系统打断）：不派生 click，直接结束 */
            dragged = false;
            return;
        }
        /* 未拖动：这里不再打开面板/隐藏浮标，交给随后的 click 阶段处理。
           让浮标在整个 click 事件派发期间保持可见，需要在该阶段识别它的第三方插件不会因我们提前隐藏而失效；
           面板打开延后到 click 之后（下面 click 监听里 setTimeout），因此面板也不会误接同一次 click。 */
        dragged = false;
    };
    badgeEl.addEventListener('pointerup', onBadgeUp);
    badgeEl.addEventListener('pointercancel', onBadgeUp);
    /* 点击（含第三方对 host 直接触发的原生 click）：
       - 拖拽后的补发 click 已被上面 badgeSuppressNextClick 守卫拦掉，不会走到这里；
       - 这里只把「打开面板」延后到本次 click 全部派发完之后执行，保持浮标在该阶段可见；
       - 不再主动 stopPropagation，让 click 正常冒泡，不挡住其他监听（各 state 已保证不会误关面板）。 */
    badgeEl.addEventListener('click', (e) => {
        /* 兜底：若拖拽后的 click 未被上游拦掉（极少数），这里再拦一次 */
        if (badgeSuppressNextClick) return;
        setTimeout(() => {
            if (preferences.badgeDefault) showPanel();
            else togglePanelWindow();
        }, 0);
    });
}

function makeDraggable(el) {
    const header = el.querySelector('.rlog-panel-header');
    if (!header) return;

    let startX, startY, origX, origY;
    let dragging = false;

    header.style.cursor = 'move';

    header.addEventListener('mousedown', (e) => {
        /* 跳过按钮、H4 标题及其子元素、预览开关（它们有各自的交互，不参与拖拽） */
        if (e.target.tagName === 'BUTTON' || e.target.closest('h4') || e.target.closest('#rlog-preview-btn')) return;
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
        if (e.target.tagName === 'BUTTON' || e.target.closest('h4') || e.target.closest('#rlog-preview-btn')) return;
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
    /* 面板/影子根访问（供 tour.js 使用）：面板已挂进影子根，document 查找不到，改从这里取 */
    getPanelEl: () => panelEl,
    /* 浮标访问（测试辅助）：真实浮标已拆为 light DOM host #rlog-badge-host（视觉在其 shadow root 内），
       document 可直接查到该 host；可见视觉元素用 getBadgeVisualEl() 获取。 */
    getBadgeEl: () => badgeEl,
    getBadgeVisualEl: () => badgeVisualEl,
    q: (sel) => (panelShadowRoot ? panelShadowRoot.querySelector(sel) : null),
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
    /* 重置筛选（供引导/回归测试/外部调用）。
       引导开始时用它把筛选重置为全开以展示 demo，故不落盘；用户手动重置走界面按钮 resetFilters()（默认持久化）。 */
    resetFilters: () => resetFilters(false),
    toggleFilterChip: (group, value) => toggleFilterChip(group, value),
    getVisibleRecordsCount: () => getVisibleRecords().length,
    /* 替换整个记录列表（供 tour.js 在引导期间清空/恢复记录使用） */
    setRecords: (newRecords) => {
        records = Array.isArray(newRecords) ? newRecords : [];
        /* 只裁剪超出普通上限的普通记录；置顶记录保留（引导恢复的暂存记录可能使总数超限） */
        pruneNormalRecords();
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
    /* 偏好设置（供测试/后续迭代使用） */
    openPreferences: () => openPrefPanel(),
    closePreferences: () => closePrefPanel(),
    getPreferences: () => JSON.parse(JSON.stringify(preferences)),
    setPreference: (key, value) => setPreference(key, value),
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
    /* 测试按钮插到「偏好设置」按钮之后（保证顺序：总开关-引导-偏好设置-测试-预览-删除-昼夜）；
       偏好设置按钮已被临时移除时兜底插到「引导」之后。 */
    const prefBtn = panelEl.querySelector('#rlog-pref-btn');
    const anchor = prefBtn || panelEl.querySelector('#rlog-help-btn');
    if (anchor) {
        anchor.insertAdjacentElement('afterend', btn);
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
