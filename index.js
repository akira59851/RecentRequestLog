/* ============================================================
   最近请求记录 (Recent Request Log) — 主逻辑模块（index.js）
   ============================================================ */

/* 【区块索引】（按文件从上到下的顺序）
   1. 动态加载 tour.js   插件启动时加载使用引导模块（保持最前）
   2. 可调参数与常量     全部可调数值/存储键/路径模式，调参只改这里
   3. 状态变量           面板/数据/搜索/回复追踪等运行时内存状态
   4. 工具函数           无副作用的纯函数（转义/模型名/token/角色映射等）
   5. AI 请求体结构验证  判断请求体是否为 AI 生成请求
   6. 请求来源识别       主生成轮次跟踪 + 证据分层判定（信封→E1→E2→X2-X5→E3→兜底→默认插件）
                         + 响应落楼后的有限提升修正；旧原生入口监听保留为最低优先级兜底
   7. 请求拦截（fetch + XHR）  网络层捕获请求体（parse/process/install + XHR 包装，含同源 iframe 扩展）
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
   19. 正文卸载与按需恢复  视口外正文清空为等高占位、进入视野前按需补回（含滚动带维护）
   20. 面板控制          菜单入口、buildUI、开合/折叠(↔浮标)/主题按钮
   21. 拖拽与缩放        面板拖动/右下角缩放/浮标拖动
   22. 初始化            等待 ST 就绪并构建 UI
   23. 对外 API          window.__RLogApi 面向 tour.js 的接口
   24. 临时测试功能      仅剩控制台调试函数（测试注入 / 超时模拟，后续删除）
   25. 模拟提示词（不发请求） 真实组装 + 发前截断，生成一条模拟记录（不发送网络请求）
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
const STORAGE_PREF_MOBILE_FULL = `${PLUGIN_KEY}_prefMobileFull`;      /* 偏好：移动端全屏（移动端打开面板自动铺满全屏） */
const STORAGE_PREF_CLICK_OUTSIDE = `${PLUGIN_KEY}_prefClickOutside`;  /* 偏好：点击插件面板外关闭整个面板（双端生效） */
const STORAGE_PREF_FILTER_PERSIST = `${PLUGIN_KEY}_prefFilterPersist`; /* 偏好：筛选状态持久化（开启后跨页面保留筛选状态） */
const STORAGE_PREF_MINIMAL = `${PLUGIN_KEY}_prefMinimal`;            /* 偏好：极简模式（去掉过渡/动画/平滑滚动/闪烁/浮层虚化） */
const STORAGE_PREF_BADGE_DEFAULT = `${PLUGIN_KEY}_prefBadgeDefault`; /* 偏好：浮标默认入口（启动默认显示浮标，右上角默认位置） */
const STORAGE_PREF_FOLLOW_ST_THEME = `${PLUGIN_KEY}_prefFollowStTheme`; /* 偏好：昼夜模式跟随 ST 主题（主面板亮暗自动跟随 ST 主题） */
const STORAGE_FILTER_STATE_KEY = `${PLUGIN_KEY}_filterState`;        /* 持久化的筛选状态对象（仅当「筛选状态持久化」偏好开启时读写） */
const NATIVE_INTENT_WINDOW_MS = 5000;
const BADGE_SIZE = 34;               /* 浮标边长(px)：桌面端 34×34 */
const BADGE_SIZE_MOBILE = 30;        /* 浮标边长(px)：移动端（≤768px）30×30；桌面/移动由 getBadgeSize() 按断点返回 */
const BADGE_DRAG_THRESHOLD = 5;      /* 浮标拖动判定阈值(px)：位移超过该值视为拖动，否则视为点击恢复面板 */
const BADGE_DEFAULT_MARGIN_RIGHT = 16; /* 浮标默认位置距视口右缘的距离(px)：「浮标默认入口」开启时启动默认位置 */
const BADGE_DEFAULT_MARGIN_TOP = 12;  /* 浮标默认位置在 ST 顶部设置栏下缘往下的距离(px) */
const LONG_PRESS_MS = 550;            /* 长按判定阈值(ms)：按下超过此时间且移动未超过容差视为长按 */
const LONG_PRESS_MOVE_TOLERANCE = 8;  /* 长按移动容差(px)：按下后位移超过该值取消长按 */
const PIN_TOAST_DURATION_MS = 1800;   /* 置顶/取消置顶提示自动消失时间(ms) */
const SIMULATE_TIMEOUT_MS = 15000;    /* 生成模拟记录全程兜底超时(ms)：到点停止组装链路、丢弃结果并提示失败 */
const ST_THEME_DARK_LUMINANCE = 0.5;  /* ST 主题背景色相对感知亮度低于该值视为深色主题（浮标改用浅色一套） */

/* ── 请求来源识别（证据分层判定，RQ-32）相关常量 ── */
const SOURCE_PLUGIN_DEFAULT_DETAIL = '插件/非原生请求'; /* 判「插件」时的悬停说明（沿用既有文案，值域不变） */
const ST_CHAT_COMPLETION_ENDPOINT = '/api/backends/chat-completions/generate'; /* X3「请求地址」比对用的 ST 聊天补全端点路径 */
const PASS_MAX_AGE_MS = 5 * 60 * 1000;        /* 主生成轮次最长存活时间(ms)：兜底清除「结束事件丢失」导致的悬挂轮次 */
const SOURCE_CORRECTION_WINDOW_MS = 5000;     /* 修正触发窗口(ms)：响应定稿与 ST 消息事件间隔超过该值不再修正 */
const SOURCE_CORRECTION_RETRY_MS = 400;       /* 修正短延迟重试(ms)：消息事件先到、响应还没读完时补一次 */
const SOURCE_CORRECTION_PENDING_TTL_MS = 15000; /* 待修正记录保留时长(ms)：超出后不再尝试修正 */
const SOURCE_CORRECTION_PENDING_GRACE_MS = 1000; /* 待修正记录宽限(ms)：刚登记的记录还没进列表时不按成员关系清理 */
const SOURCE_CORRECTION_MIN_OVERLAP = 24;     /* 修正匹配的最小重叠长度(字符)：短于此长度只认完全相等 */

/* ── 原始请求体敏感字段遮蔽 ── */
const SENSITIVE_BODY_FIELDS = ['proxy_password'];
const SENSITIVE_BODY_MASK = '***';

/* 影子内 FA 固壳：仅插件实际使用的 33 个实心图标（content 取自 ST 现版 fontawesome.min.css 6.5.2，非猜测）
   新增图标时在此补一行「图标名: '\\fXXX'」即可 */
const FA_SOLID_CONTENT = {
    'arrow-down': '\\f063',
    'arrow-up': '\\f062',
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
    'clock-rotate-left': '\\f1da',
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

/* RegExp: 信封式请求「URL 形状」预筛 —— http(s):// + 生成路径关键词（大小写不敏感）。
   关键词复用 AI_GENERATION_PATH_PATTERNS；字符类排除引号/空白/反斜杠，保证匹配到的是一个
   完整地址串而不是跨字段的文本。 */
const ENVELOPE_URL_SHAPE_RE = new RegExp(
    'https?://[^\\s"\'`\\\\]*(?:'
        + AI_GENERATION_PATH_PATTERNS.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
        + ')',
    'i'
);

/* object: 信封解包命中后强制使用的来源（判定按设计是终局的：不参与证据分层判定，
   也不参与「响应落楼修正」） */
const ENVELOPE_PROXY_SOURCE = { type: 'plugin', label: '插件', detail: '插件代理请求', rule: 'envelope' };

/* RegExp: ST 自家真实生成端点（/api/backends/<api>/generate）。模拟预览期间用它硬拦请求，
   确保「只组装、绝不发网络」 */
const GENERATE_ENDPOINT_RE = /\/api\/backends\/[^/?#]+\/generate\b/i;

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
/* number: 进度条创建队列每帧最多处理几个内容区。滚动时同一帧会有多条长消息进入视口，
   一次性全部创建（各含 4 个小 DOM 与若干监听）会造成掉帧；摊到连续几帧完成，创建条件与效果不变 */
const SCROLLBAR_CREATE_PER_FRAME = 4;
/* number: 轨道相对 hitbox 的上下内缩量(px)，供轨道高度与拖动坐标换算共用；
   必须与 CSS 中 .rlog-scroll-track 的 top/bottom 保持一致 */
const SCROLLBAR_TRACK_PADDING = 4;
/* number: 「正文卸载与按需恢复」保留带宽（屏）：列表可视区上下各保留这么多屏的正文不卸载。
   卸载掉的正文换成同一元素上的等高占位，面板关闭/重开时就不必为视口外的正文付排版与绘制。 */
const BODY_KEEP_SCREENS = 1;
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

/* boolean: 模拟预览进行中——窗口内的生成请求一律不发网络（目标那条先建档再阻断，见 simulateCaptureCtx）；
   只在 captureSimulatedPrompt 内短暂置真，finally 必定复位 */
let simulatePromptActive = false;

/* boolean: 生成模拟记录流程进行中（含组装、还原、本地统计）——期间按钮置灰、不可重复触发 */
let simulatePromptRunning = false;

/* object|null: 本次模拟的捕获上下文（形状见 createSimulateCaptureCtx），只在一次模拟内存在。
   跟着目标请求一路传进记录管线，供异步建档阶段判断归属；不靠回头读全局标志（那时可能已复位） */
let simulateCaptureCtx = null;

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
   独立 host 挂在 document.body，供第三方收纳插件识别/收纳；
   可见视觉在其自己的 shadow root 内（.rlog-badge-visual）。 */
let badgeEl = null;

/* HTMLElement|null: 浮标可见视觉元素（挂在 badgeEl 自己的 shadow root 内，
   document 查找不到，仅供 __RLogApi.getBadgeVisualEl() 等测试辅助使用） */
let badgeVisualEl = null;

/* string|null: style.css 规则序列化结果缓存（面板与浮标两个影子根各要一份 <style> 节点，
   规则文本只序列化一次） */
let selfCssTextCache = null;

/* {left,top}|null: 浮标会话内位置（浮标左上角坐标）。
   首次收起记录点击坐标，拖动后更新，再次收起复用；刷新即清。 */
let badgePos = null;

/* boolean: 是否拦截「点击浮标恢复面板」后浏览器派发的原生 click（一次性标记）。
   浮标隐藏、面板出现在同一坐标时，该 click 会 hit-test 到面板标题栏按钮，可能误开抽屉。 */
let badgeSuppressNextClick = false;

/* boolean: ST 当前是否深色主题（浮标配色取其反：深色 ST → 浅色浮标），由 syncBadgeTheme() 维护 */
let stThemeIsDark = false;

/* MutationObserver|null: 监听 <html> 的 style 属性变化以感知 ST 主题切换（见 initBadgeThemeSync） */
let badgeThemeObserver = null;

/* HTMLElement|null: 扩展菜单中的按钮 */
let toggleBtn = null;

/* boolean: 面板是否可见 */
let isPanelVisible = false;

/* @type {boolean} 面板内容是否需要重建（数据/渲染设置变化时置 true，渲染完成后清 false）。
   面板隐藏时 DOM 保留，避免每次打开都全量重建造成卡顿。 */
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

/* WeakMap<Window, Function>: 已安装 fetch 包装的窗口 → 包装函数（主窗口 + 同源 iframe）
   用途：① 防止同一窗口重复包装破坏原有 fetch 包装链；
        ② 包装被 iframe 内部脚本替换后据此刻断是否需要重新包装。 */
const hookedFetchHooks = new WeakMap();

/* WeakSet<HTMLIFrameElement>: 已挂「重载后重装包装」监听的 iframe 元素（防重复挂监听） */
const iframeLoadListenersAttached = new WeakSet();

/* WeakMap<XMLHttpRequest, {method, url, async}>: XHR 实例的 open 参数（send 时读取；重复 open 覆盖） */
const xhrOpenMeta = new WeakMap();

/* WeakMap<Window, {open, send}>: 已安装 XHR 包装的窗口（主窗口 + 同源 iframe）→ 安装时的原型方法。
   用途与 hookedFetchHooks 相同：防同一 realm 重复包装；iframe 重载或内部脚本替换原型后重新包装。 */
const hookedXhrProtos = new WeakMap();

/* boolean: iframe 请求包装（fetch + XHR，初始扫描 + MutationObserver 动态监听）是否已安装 */
let iframeHooksInstalled = false;

/* object: 最近一次信封解包尝试的结果（供 __rlogDebug 查询；只记原因与候选序号，不记真实地址） */
let lastEnvelopeResult = { hit: false, reason: 'none', urlCandidateIndex: null, bodyCandidateIndex: null };

/* number: 递增的请求捕获编号，用于把回复精确挂回对应记录 */
let captureSeq = 0;

/* 尚未挂载到记录的回复待办区（key: captureId）：{ startTime, timer, expireTimer, status,
   content, reasoning, failReason, time, reader, finished }，记录建成后由 consumePendingReply 消费。 */
const pendingReplies = new Map();

/* string|null: 上一次记录的 messages 指纹，用于去重 */
let lastRecordFingerprint = null;

/* number: 上一次记录的时间戳 */
let lastRecordTime = 0;

/* { timestamp: number, target: string, source: 'click'|'pointerdown'|'keydown' : |null} 最近一次 ST 原生生成入口 */
let lastNativeIntent = null;

/* boolean: 是否已安装原生入口监听 */
let sourceTrackingInstalled = false;

/* object|null: 当前主生成轮次（pass）状态（RQ-32 正向识别的锚点）
   { id, active, type, startTime, depth, dataTime, bodyRef, chatBodyRef, promptArray, e2Claimed, candidateCount, positionForfeited }
   - bodyRef     非聊天补全主 API：公开数据载荷对象（就是请求体对象）
   - chatBodyRef 聊天补全主 API：「请求体即将发出」事件的载荷（就是请求体对象）
   - promptArray 聊天补全主 API：公开数据载荷里的提示词数组（E2 同源附加要求用）
   轮次由「生成开始（非安静、非只组装）」打开、「生成结束 / 生成被停止」关闭；
   群聊的嵌套通知按「最近一次公开数据归属于当前轮」处理（见 openOrResetGenerationPass）。 */
let generationPass = null;

/* number: 轮次编号（自增；E3 位置证据作废时按编号找回本轮已按位置证据判原生的记录） */
let generationPassSeq = 0;

/* number|null: 最近一次「位置证据已作废」的轮次编号（轮次对象可能已关闭，故单独留一份：
   轮次内两条请求的「判定」与「建档」是异步两步，第二条可能在第一条建档之前就作废掉证据） */
let lastForfeitedPositionPassId = null;

/* boolean: 是否已安装主生成轮次跟踪 */
let generationPassTrackingInstalled = false;

/* object|null: 最近一次 ST 消息事件（消息到达 / 角色消息已渲染 / 翻页已切换）的楼层候选文本
   { mesId, texts: string[], at }；供「响应落楼后的来源修正」使用。 */
let lastFloorEvent = null;

/* Map<record, {at}>: 「响应已定稿、等待落楼修正」的插件记录（需要遍历，故不用 WeakMap） */
const pendingSourceCorrections = new Map();

/* number|timeout|null: 修正短延迟重试定时器 */
let sourceCorrectionTimer = null;

/* object: 修正统计（供 __rlogDebug.getSourceCorrectionStats 查询） */
let sourceCorrectionStats = { count: 0, lastReason: '', lastTime: '' };

/* boolean: 是否已安装来源修正跟踪（ST 消息事件监听） */
let sourceCorrectionTrackingInstalled = false;

/* object|null: 最近一次来源判定结果（规则名 / 悬停说明 / 原因；供 __rlogDebug 查询） */
let lastSourceDecision = null;

/* string: 最近一次判「插件」的排除原因（供 __rlogDebug.getLastExclusion 查询） */
let lastExclusionReason = '';

/* boolean: UI 是否已构建（防止 init() 竞态导致双重建构） */
let uiBuilt = false;

/* boolean: 内容预览开关，默认关闭（持久化到 localStorage） */
let contentPreviewEnabled = false;

/* boolean|null: 强制覆盖内容预览开关（用于引导程序演示） */
let forcePreviewState = null;

/* @type {object} 偏好设置状态（6 项，默认全关；持久化到 localStorage） */
let preferences = {
    badgeDefault: false,   /* boolean: 浮标默认入口（开启后插件启动默认显示浮标，右上角默认位置；关闭面板/最小化时浮标回到 badgePos） */
    followStTheme: false,  /* boolean: 昼夜模式跟随 ST 主题（开启后主面板亮暗自动跟随 ST 主题，手动昼/夜按钮不生效；与浮标配色互不相干） */
    mobileFull: false,     /* boolean: 手机端全屏（移动端打开面板自动铺满全屏） */
    clickOutside: false,   /* boolean: 点击插件面板外关闭整个面板（双端通用，全屏时自然不生效） */
    filterPersist: false,  /* boolean: 筛选状态持久化（开启后跨页面保留筛选状态；关闭时不改动当前筛选） */
    minimal: false,        /* boolean: 极简模式（开启后去掉过渡/动画/平滑滚动/闪烁/浮层虚化，保留状态反馈与引导动效） */
};

/* HTMLElement|null: 偏好设置浮层（遮罩 + 面板）DOM 元素 */
let prefOverlayEl = null;

/* HTMLElement|null: 偏好设置「更多」抽屉入口按钮（用于切换心形图标态） */
let prefBtnEl = null;

/* MutationObserver|null: 监听 <html> 的 style 属性变化，感知 ST 主题切换以同步面板主题
   （仅「昼夜模式跟随 ST 主题」开启时挂载；浮标有自己独立的同名观察者，两者互不共用、互不影响） */
let panelThemeObserver = null;

/* @type {object|null} 当前搜索状态（同一时间仅一条记录可搜索）
   { recordIndex, keyword, matches: [{msgIdx, start, end}], currentIdx, searchEl } */
let searchState = null;

/* number|null: 搜索输入 debounce 定时器 ID */
let searchDebounceTimer = null;

/* 筛选状态（会话级内存态，刷新重置）：{ source, role, model } 三组布尔，默认全开＝不筛选，
   任一项 false 表示隐藏该分类；来源/模型控制整条记录，角色控制记录内子消息。 */
let filterState = {
    source: { native: true, plugin: true },
    role: { system: true, user: true, assistant: true, other: true },
    model: { gemini: true, claude: true, deepseek: true, other: true },
};

/* HTMLElement|null: 置底跳转后待闪烁的标题栏（平滑滚动到位后触发） */
let pendingFlashHeader = null;
/* number|null: 置底闪烁兜底定时器（scrollend 未触发时兜底） */
let pendingFlashTimer = null;
/* HTMLElement|null: 折叠触发回顶的记录元素（展开同一条记录时才闪烁） */
let recordCollapseToppedEl = null;

/* HTMLElement|null: 当前「查看全文」覆盖层 DOM 元素 */
let readFullOverlayEl = null;

/* number|null: 当前打开覆盖层对应的记录索引 */
let readFullRecordIndex = null;

/* string: 当前显示格式：'formatted'（整理）或 'raw'（原始 JSON） */
let readFullFormat = 'formatted';

/* ── 工具函数 ─────────────────────────── */

/* 安全读取 ST 上下文：未就绪或内部异常一律返回 null（来源判定的 X3 与轮次跟踪都用它）
   @returns {object|null} */
function getStContextSafe() {
    try {
        return (window.SillyTavern && typeof window.SillyTavern.getContext === 'function')
            ? window.SillyTavern.getContext()
            : null;
    } catch (e) {
        return null;
    }
}

/* 时间戳格式化（与 addRecord 内联格式一致：YYYY-MM-DD HH:mm:ss）
   @param {Date|number} value @returns {string} */
function formatTimestamp(value) {
    const d = (value instanceof Date) ? value : new Date(value);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
        + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/* 从模型名提取「家族」标识（同家族共享分词器），匹配规则参照 ST tokenizers.js 的 getTokenizerModel()。
   @param {string} modelName @returns {string} 家族标识，无法识别时返回原名小写 */
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

/* 两个模型名是否同家族（按 extractModelFamily 判定、共享分词器）
   @param {string} modelA @param {string} modelB @returns {boolean} */
function isSameModelFamily(modelA, modelB) {
    if (!modelA || modelA === '未知模型' || !modelB) return true; /* 无法判断时默认认为兼容 */
    return extractModelFamily(modelA) === extractModelFamily(modelB);
}

/* 用 ST 原生分词器异步算 Token 并写回 messages[i].tokens（不可用时降级字节估算）
   @param {Array} messages @param {string} modelName 用于判断分词器兼容性 */
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

    let stModelName = '';
    try {
        if (ctx && typeof ctx.getChatCompletionModel === 'function') {
            stModelName = ctx.getChatCompletionModel();
        }
    } catch (e) { /* ignore */ }

    /* 按模型家族对比：同家族共享分词器，不需要显示 ~ */
    const tokenizerCompatible = isSameModelFamily(modelName, stModelName);

    /* 逐条用 ST 原生分词器精确计算（ST 内部有缓存） */
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

/* 从请求体提取模型名（各 API 字段名不同）
   @param {object} body @returns {string} 提取不到返回 未知模型 */
function extractModelName(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return '未知模型';

    /* 顶层 model 字段（OpenAI、大多数兼容格式） */
    if (typeof body.model === 'string' && body.model) return body.model;

    /* Gemini 格式：generationConfig.model */
    if (body.generationConfig && typeof body.generationConfig.model === 'string' && body.generationConfig.model) {
        return body.generationConfig.model;
    }

    /* 其他常见字段 */
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

/* 取消息开头预览文字：原样保留文本、换行转空格、JS 端截断 200 字符（视觉省略交给 CSS）
   @param {string} content @returns {string} */
function getContentPreview(content) {
    if (!content || typeof content !== 'string') return '';
    const collapsed = content.replace(/\n/g, ' ').trim();
    if (!collapsed) return '';
    /* 200 字符为安全上限，视觉省略交给 CSS */
    return collapsed.length > 200 ? collapsed.slice(0, 200) + '…' : collapsed;
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/* 解析颜色字符串的 RGB 通道：只覆盖 ST 主题色会用到的写法（#rgb / #rrggbb / rgb() / rgba()）；
   alpha 不参与解析——主题明暗只看颜色方向。
   @param {string} color @returns {{r,g,b}|null} */
function parseCssColorChannels(color) {
    if (!color) return null;
    const text = String(color).trim();
    const fn = text.match(/^rgba?\(([^)]+)\)$/i);
    if (fn) {
        const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
        if (parts.length < 3) return null;
        const rgb = parts.slice(0, 3).map(part => parseFloat(part));
        if (rgb.some(num => Number.isNaN(num))) return null;
        return { r: rgb[0], g: rgb[1], b: rgb[2] };
    }
    const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
        const body = hex[1].length === 3
            ? hex[1].split('').map(c => c + c).join('')
            : hex[1];
        return {
            r: parseInt(body.slice(0, 2), 16),
            g: parseInt(body.slice(2, 4), 16),
            b: parseInt(body.slice(4, 6), 16),
        };
    }
    return null;
}

/* WCAG 相对感知亮度（sRGB 线性化后加权），用于判断主题底色明暗
   @param {number} r @param {number} g @param {number} b @returns {number} */
function relativeLuminance(r, g, b) {
    const toLinear = (value) => {
        const s = Math.min(Math.max(value, 0), 255) / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/* ── AI 请求体结构验证 ───────────────────── */

/* ST 内部聊天消息对象特征，用于排除非 AI 请求的聊天数据
   仅收录 ST 自有字段；第三方插件写入聊天数据的自定义键不用于判断 */
const ST_INTERNAL_MSG_KEYS = new Set([
    'chat_metadata', 'mes', 'swipe_id', 'send_date', 'is_user', 'is_system',
    'extra', 'gen_id', 'gen_finished', 'swipes', 'swipe_info',
    'ch_name', 'file_name', 'integrity', 'note_prompt',
    'note_interval', 'note_position', 'note_depth', 'note_role',
    'timedWorldInfo',
]);

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

/* 外层快速通道（fetch 与 XHR 共用）：地址是 ST 内部接口且不含生成端点特征时，跳过外层判定，
   只尝试信封解包。 */
function isOuterFastPathUrl(url) {
    const path = getUrlPathForMatch(url);
    return !!(path && !pathMatchesAny(path, AI_GENERATION_PATH_PATTERNS)
        && (path.startsWith('/api/') || path.startsWith('/assets/') || path.startsWith('/backgrounds/')));
}

function hasGenerationRequestHints(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    return Object.keys(body).some(k => AI_GENERATION_BODY_KEYS.has(k));
}

/* 严格验证一个对象是否为标准 AI 消息
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

/* 判断请求体是否为 AI 生成请求：结构识别为主，URL 与生成参数辅助过滤（排除 ST 内部接口）。
   检查顺序由便宜到昂贵：类型校验 → URL 排除 → 顶层 key 扫描 → 数组逐元素校验。 */
function isAiRequestBody(body, requestUrl) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;

    /* URL 明确排除（字符串索引匹配，不用遍历数组） */
    if (isExplicitNonGenerationUrl(requestUrl)) return false;

    const generationUrl = isPotentialGenerationUrl(requestUrl);
    const hasHints = hasGenerationRequestHints(body);

    /* 既不是生成 URL 也没有生成参数特征时，只在顶层存在消息容器字段的情况下继续：
       放行纯文本补全，同时避免昂贵的逐元素校验 */
    if (!generationUrl && !hasHints) {
        const hasMessagesArray = Array.isArray(body.messages) && body.messages.length > 0;
        const hasChatArray = Array.isArray(body.chat) && body.chat.length > 0;
        const hasContentsArray = Array.isArray(body.contents) && body.contents.length > 0;
        const hasSystemPrompt = typeof body.system === 'string' && body.system.length > 0;
        const hasPlainPrompt = typeof body.prompt === 'string' && body.prompt.length > 0;

        if (!hasMessagesArray && !hasChatArray && !hasContentsArray && !hasSystemPrompt && !hasPlainPrompt) {
            return false;
        }

        if (hasPlainPrompt && !hasMessagesArray && !hasChatArray && !hasContentsArray && !hasSystemPrompt) {
            /* 纯文本补全场景放行（由 parseFetchRequestBody 中单独处理） */
            return true;
        }

        /* 有数组但没有生成特征，大概率是 ST 内部数据加载 */
        return false;
    }

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

/* ── 信封式代理请求解包 ─────────────────── */

/* 记录一次信封解包尝试的结果（供 __rlogDebug 查询；只记原因与顶层候选序号，不记任何真实地址） */
function rememberEnvelopeResult(hit, reason, urlIndex, bodyIndex) {
    lastEnvelopeResult = {
        hit: !!hit,
        reason,
        urlCandidateIndex: hit ? urlIndex : null,
        bodyCandidateIndex: hit ? bodyIndex : null,
    };
}

/* 解析请求文本为 JSON 对象（数组/标量/非法 JSON 一律返回 null，不抛错） */
function parseJsonText(text) {
    if (typeof text !== 'string' || !text) return null;
    try {
        const parsed = JSON.parse(text);
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    } catch (e) {
        return null;
    }
}

/* 信封内层 body 候选取值（G4 + G7）：object（非数组）直接取用；字符串最多 JSON.parse 一次、
   解析结果仍是 object 才取用；其余一律视为该候选无效（不再递归深入）。 */
function normalizeEnvelopeBody(value) {
    if (!value) return null;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
        return parseJsonText(value);
    }
    return null;
}

/* 按信封形状解包一次请求（纯函数，只读入参；不递归、不搜索内层对象、一次请求最多命中一组）：
   输入 方法 + 原始请求文本 → { effectiveUrl, effectiveBody, viaProxyEnvelope } 或 null（不是信封）。
   闸门顺序：G1 方法 → G3「URL 形状」文本预筛 → G4/G7 body 取值 → G9 顶层确定性枚举 →
   G6① 内层须为完整 http(s) 绝对地址 → G5 复用现有请求体校验（不认字段名，只认值）。 */
function resolveRequestEnvelope(method, rawText) {
    /* G1：只处理写方法（与现有拦截一致） */
    const upperMethod = typeof method === 'string' ? method.toUpperCase() : '';
    if (upperMethod !== 'POST' && upperMethod !== 'PUT' && upperMethod !== 'PATCH') {
        rememberEnvelopeResult(false, 'method-not-writable');
        return null;
    }

    /* G3：廉价文本预筛 —— 原始文本里必须出现「URL 形状」命中，未命中不解析 JSON */
    if (typeof rawText !== 'string' || !rawText || !ENVELOPE_URL_SHAPE_RE.test(rawText)) {
        rememberEnvelopeResult(false, 'url-shape-miss');
        return null;
    }

    const outer = parseJsonText(rawText);
    if (!outer) {
        rememberEnvelopeResult(false, 'outer-not-object');
        return null;
    }

    /* G9：只在外层顶层自有可枚举字段中枚举（Object.keys 顺序）；URL 候选外循环、
       body 候选内循环，命中第一组同时满足 G6①/G5 的组合即停。 */
    const keys = Object.keys(outer);
    let sawUrlCandidate = false;
    for (let urlIndex = 0; urlIndex < keys.length; urlIndex++) {
        const urlCandidate = outer[keys[urlIndex]];
        if (typeof urlCandidate !== 'string' || !urlCandidate) continue;
        if (!isPotentialGenerationUrl(urlCandidate)) continue;
        sawUrlCandidate = true;
        /* G6①：内层目标地址必须是完整的 http(s) 绝对地址（排除 ST 内部相对路径） */
        if (!/^https?:\/\//i.test(urlCandidate)) continue;
        for (let bodyIndex = 0; bodyIndex < keys.length; bodyIndex++) {
            if (bodyIndex === urlIndex) continue; /* 同一字段不能同时充当两种角色 */
            const innerBody = normalizeEnvelopeBody(outer[keys[bodyIndex]]);
            if (!innerBody) continue;
            /* G5：内层复用现有全部校验（最终要求存在真正的 role/content 消息数组） */
            if (!isAiRequestBody(innerBody, urlCandidate)) continue;
            rememberEnvelopeResult(true, 'hit', urlIndex, bodyIndex);
            return { effectiveUrl: urlCandidate, effectiveBody: innerBody, viaProxyEnvelope: true };
        }
    }

    rememberEnvelopeResult(false, sawUrlCandidate ? 'no-valid-pair' : 'no-url-candidate');
    return null;
}

/* 统一请求判定（fetch 与 XHR 共用）：外层判定通过 → 按外层记录（不再解包）；外层判定不通过
   （含被快速通道跳过）→ 尝试信封解包。两者互斥，一条请求最多产出一条记录。
   @param {object} capture { requestUrl, method, rawText, getBody, context }
     getBody: 惰性取外层请求体的函数（返回 object|null；信封路径不需要时就省掉这次解析）
     context: 来源判定上下文（RQ-32），外层判定通过时补上 bodyObject / rawText 一并下传
   @returns {{effectiveUrl, effectiveBody, viaProxyEnvelope, context?}|null} */
function decideCapturedRequest(capture) {
    if (!isOuterFastPathUrl(capture.requestUrl)) {
        let outerBody = null;
        try {
            outerBody = capture.getBody ? capture.getBody() : null;
        } catch (e) {
            outerBody = null;
        }
        if (outerBody && isAiRequestBody(outerBody, capture.requestUrl)) {
            return {
                effectiveUrl: capture.requestUrl,
                effectiveBody: outerBody,
                viaProxyEnvelope: false,
                /* 请求上下文：补上外层请求体对象引用（与保存的公开数据引用同一时，E2 直接成立） */
                context: Object.assign({}, capture.context || {}, {
                    bodyObject: outerBody,
                    rawText: (typeof capture.rawText === 'string') ? capture.rawText : (capture.context ? capture.context.rawText : null),
                }),
            };
        }
    }
    return resolveRequestEnvelope(capture.method, capture.rawText);
}

/* ── 请求来源识别（证据分层判定，RQ-32） ───────── */

/* 【判定顺序（固定，定义见 requirements.md「RQ-32 附」）】
   0 现有请求体校验 + 信封解包（唯一可前置终止的排除项，RQ-31）
   → 1 E1 可中止句柄对象同一（仅 fetch 且仅流式）
   → 2 E2 请求体来自本轮主生成的公开数据（每轮只认领第一条命中的请求）
   → 3 通用排除 X2（生成类型字段异常）/ X3（API 身份与主配置不一致）/ X4（不在任何主生成轮次内）/ X5（同源 iframe）
   → 4 E3 位置备用证据（公开数据事件之后、本轮结束之前，且本轮只出现这一条候选写请求）
   → 5 旧兜底：原生入口点击 / 回车 + 5 秒窗口 + 生成开始事件的类型保底（保留不删，最低优先级）
   → 6 其余一律「插件」（默认）

   【顺序理由（务必保留）】X3 在「拦截瞬间」比对，而插件可能在生成过程中临时改动主 API 配置（临时切模型 /
   换渠道），此时真主请求与当前配置不一致；排除项若前置终止会把真主请求标成插件。E2 是同源判定，
   插件请求不可能满足，故正向证据先跑无风险。 */

/* 来源判定用到的规则名（供调试口 __rlogDebug.getLastSourceDecision 与文档对照，不参与展示）：
   envelope / E1 / E2 / X2 / X3 / X4 / X5 / E3 / legacy / default / E3-revoked / correct */

/* 构造来源对象：值域仍是「原生 / 插件」两个值；rule / evidence / passId 是内部判定元数据
   （Rule 名供调试与回归断言，evidence = 'position' 时记录可随 E3 唯一性失效退回「插件」）。
   @param {'native'|'plugin'} type @param {string} detail 悬停说明 @param {string} rule @returns {object} */
function makeSource(type, detail, rule) {
    const normalized = type === 'native' ? 'native' : 'plugin';
    return {
        type: normalized,
        label: getSourceLabel({ type: normalized }),
        detail,
        rule: rule || '',
        evidence: null,
        passId: null,
    };
}

/* 记录最近一次来源判定结果（调试口用）并返回该结果
   @param {object} result @param {string} reason 人类可读原因 @returns {object} */
function noteSourceDecision(result, reason) {
    lastSourceDecision = {
        type: result.type,
        rule: result.rule,
        detail: result.detail,
        reason: reason || '',
        at: Date.now(),
    };
    if (result.type === 'plugin') {
        lastExclusionReason = `${result.rule}: ${reason || ''}`.trim();
    }
    return result;
}

/* ── 主生成轮次（pass）跟踪 ───────────────── */

/* 读取 ST 主 API 名（'openai' 表示聊天补全路径，其余为文本补全类路径）
   @returns {string} */
function getStMainApi() {
    const stCtx = getStContextSafe();
    return (stCtx && typeof stCtx.mainApi === 'string') ? stCtx.mainApi : '';
}

/* 结束本轮（清空轮次对象；悬挂超时也走这里） */
function resetGenerationPassState() {
    generationPass = null;
}

/* 打开 / 重置一个主生成轮次（收到「生成开始」事件，类型非安静、非只组装不发送）。
   群聊的主生成通知会嵌套出现多份：按「最近一次公开数据归属于当前轮」处理——已有轮次不新建对象，
   只清空本轮公开数据与候选计数（E2 认领与 E3 计数随之重新开始），并累计嵌套深度。
   @param {string} type 生成类型 */
function openOrResetGenerationPass(type) {
    const now = Date.now();
    if (generationPass && (now - generationPass.startTime) > PASS_MAX_AGE_MS) {
        resetGenerationPassState(); /* 悬挂轮次（结束事件丢失）：先清掉再开新轮 */
    }
    if (!generationPass) {
        generationPass = {
            id: ++generationPassSeq,
            active: true,
            type: '',
            startTime: now,
            depth: 0,
            dataTime: null,
            bodyRef: null,
            chatBodyRef: null,
            promptArray: null,
            e2Claimed: false,
            candidateCount: 0,
        };
    }
    generationPass.active = true;
    generationPass.type = String(type || '') || generationPass.type;
    generationPass.startTime = now;
    generationPass.depth++;
    generationPass.dataTime = null;
    generationPass.bodyRef = null;
    generationPass.chatBodyRef = null;
    generationPass.promptArray = null;
    generationPass.e2Claimed = false;
    generationPass.candidateCount = 0;
}

/* 收到「生成结束 / 生成被停止」：减少嵌套深度，深度归零即结束本轮 */
function closeGenerationPass() {
    if (!generationPass) return;
    generationPass.depth--;
    if (generationPass.depth <= 0) resetGenerationPassState();
}

/* 当前主生成轮次（悬挂超时视为没有轮次 → 交给 X4 判「插件」）
   @returns {object|null} */
function getActiveGenerationPass() {
    if (!generationPass || !generationPass.active) return null;
    if ((Date.now() - generationPass.startTime) > PASS_MAX_AGE_MS) {
        resetGenerationPassState();
        return null;
    }
    return generationPass;
}

/* 「请求数据组装完成」事件：保存本轮公开数据载荷引用，并记下公开数据时间（E3 的起点）。
   - 非聊天补全主 API：载荷就是请求体对象（E2 直接现场序列化比对）
   - 聊天补全主 API：载荷是提示词数组（{ prompt: [...] }），请求体对象等「请求体即将发出」事件补上
   @param {object} payload @param {boolean} dryRun */
function onPassDataGathered(payload, dryRun) {
    const pass = getActiveGenerationPass();
    if (!pass) return;
    if (dryRun === true) return; /* 只组装、不发送 */
    pass.dataTime = Date.now();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    if (getStMainApi() === 'openai') {
        pass.promptArray = Array.isArray(payload.prompt) ? payload.prompt : null;
    } else {
        pass.bodyRef = payload;
    }
}

/* 「请求体即将发出」事件（聊天补全路径）：载荷就是即将被 JSON.stringify 的请求体对象。
   安静生成（type === 'quiet'）不是主剧情请求，不写入本轮（否则会把插件自己的安静请求当成主请求）。 */
function onChatCompletionSettingsReady(payload) {
    const pass = getActiveGenerationPass();
    if (!pass) return;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    if (payload.type === 'quiet') return;
    pass.chatBodyRef = payload;
}

/* 安装主生成轮次跟踪（生成开始 / 请求数据组装完成 / 请求体即将发出 / 生成结束 / 生成被停止） */
function installGenerationPassTracking() {
    if (generationPassTrackingInstalled) return;
    if (!eventSource || !event_types) return;
    generationPassTrackingInstalled = true;

    const on = (key, handler) => {
        const evt = event_types[key];
        if (evt) eventSource.on(evt, handler);
    };

    on('GENERATION_STARTED', (type, _options, dryRun) => {
        if (dryRun === true) return;              /* 只组装、不发送 */
        if (String(type) === 'quiet') return;     /* 安静生成：非主剧情请求，不视为主生成轮次 */
        openOrResetGenerationPass(String(type));
    });
    on('GENERATE_AFTER_DATA', (payload, dryRun) => onPassDataGathered(payload, dryRun));
    on('CHAT_COMPLETION_SETTINGS_READY', (payload) => onChatCompletionSettingsReady(payload));
    on('GENERATION_ENDED', () => closeGenerationPass());
    on('GENERATION_STOPPED', () => closeGenerationPass());
}

/* ── 正向证据（E1 / E2） ─────────────────── */

/* E1：请求携带的信号对象 === 当前流式处理器实例上的信号对象（仅 fetch 且仅流式）。
   两个信号都在「拦截瞬间」由 createFetchHook 同步读取后放进请求上下文（见 buildFetchRequestContext），
   因此不存在「判定晚于流式处理器销毁」的时序窗口。XHR 没有请求身上的可中止句柄，永远不适用。
   @param {object|null} context @returns {boolean} */
function matchHandleIdentity(context) {
    if (!context || context.fromXhr) return false;
    return !!(context.signal && context.streamingSignal && context.signal === context.streamingSignal);
}

/* 聊天补全形状的请求体（messages 为非空数组）：X2 / X3 的字段判据只适用于这一形状，
   非聊天补全主 API 依赖 X4 / X5 / E2 覆盖。
   @param {object} body @returns {boolean} */
function isChatCompletionShaped(body) {
    return !!(body && typeof body === 'object' && !Array.isArray(body)
        && Array.isArray(body.messages) && body.messages.length > 0);
}

/* 现场序列化对象引用（循环引用 / 序列化失败返回 null）
   @param {object} value @returns {string|null} */
function stringifyRef(value) {
    try {
        return JSON.stringify(value);
    } catch (e) {
        return null;
    }
}

/* 剔除非法项后的消息数组（非对象项按「非法项」剔除）
   @param {Array} list @returns {Array} */
function validMessageItems(list) {
    return Array.isArray(list) ? list.filter((m) => m && typeof m === 'object') : [];
}

/* 聊天补全路径的附加要求：请求体对象的 messages 与本轮提示词数组同源（逐元素一致，允许剔除非法项）
   @param {Array} messages @param {Array} promptArray @returns {boolean} */
function isSameSourceMessages(messages, promptArray) {
    const a = validMessageItems(messages);
    const b = validMessageItems(promptArray);
    if (a.length === 0 || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/* E2：请求体来自本轮主生成的公开数据。必须保存引用、在拦截瞬间现场序列化比对（不得提前序列化，
   中间可能被其他监听者原地修改）；ST 是「先序列化、紧接着发送」，两步之间不插入其他代码。
   两条路径：
   - 非聊天补全主 API：公开数据载荷就是请求体对象 → 对象引用相同或现场序列化完全相等
   - 聊天补全主 API：请求体对象来自「请求体即将发出」事件 → 现场序列化相等，且 messages 与本轮提示词数组同源
   比对不上即降级，交后续层处理。
   @param {object|null} context @returns {boolean} */
function matchDataSameSource(context) {
    const pass = getActiveGenerationPass();
    if (!pass || pass.e2Claimed) return false;
    const bodyObject = context ? context.bodyObject : null;
    const rawText = context ? context.rawText : null;

    if (pass.bodyRef) {
        if (bodyObject && bodyObject === pass.bodyRef) return true;
        const serialized = stringifyRef(pass.bodyRef);
        if (serialized !== null && typeof rawText === 'string' && rawText === serialized) return true;
    }
    if (pass.chatBodyRef) {
        const serialized = stringifyRef(pass.chatBodyRef);
        if (serialized !== null && typeof rawText === 'string' && rawText === serialized
            && isSameSourceMessages(pass.chatBodyRef.messages, pass.promptArray)) {
            return true;
        }
    }
    return false;
}

/* ── 通用排除项（X2 / X3） ───────────────── */

/* 身份值归一化（undefined / null 与空串等同：ST 不设置某字段与设置为空是同一件事）
   @param {*} value @returns {string} */
function normalizeIdentityValue(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

/* 渠道地址（自定义地址 / 反代）：两者都是「请求被送往哪里」的渠道信息，取先出现的非空值
   @param {object} source @returns {string} */
function getChannelAddress(source) {
    if (!source || typeof source !== 'object') return '';
    return normalizeIdentityValue(source.reverse_proxy) || normalizeIdentityValue(source.custom_url);
}

/* 请求地址是否为 ST 聊天补全生成端点（只比路径：主窗口拦到的是相对地址，iframe / XHR 拦到的是绝对地址）
   @param {string} url @returns {boolean} */
function isStChatCompletionEndpoint(url) {
    return getUrlPathForMatch(url) === ST_CHAT_COMPLETION_ENDPOINT;
}

/* X3：API 身份与主配置一致性（仅聊天补全形状的请求体）。拦截瞬间比对四项：
   服务商 / 请求地址 / 渠道地址（自定义地址、反代）/ 模型。任一项不一致即「插件」；
   **四项一致不构成原生证据**（故不参与正向判定，只用于排除）。
   @param {object} body @param {string} requestUrl @returns {boolean} */
function isApiIdentityConsistent(body, requestUrl) {
    const stCtx = getStContextSafe();
    const settings = stCtx && stCtx.chatCompletionSettings;
    if (!settings) return false; /* 拿不到主配置 → 无法证明一致 */

    /* ① 服务商 */
    if (normalizeIdentityValue(body.chat_completion_source) !== normalizeIdentityValue(settings.chat_completion_source)) {
        return false;
    }
    /* ② 请求地址（ST 聊天补全生成端点） */
    if (!isStChatCompletionEndpoint(requestUrl)) return false;
    /* ③ 渠道地址（自定义地址 / 反代） */
    if (getChannelAddress(body) !== getChannelAddress(settings)) return false;
    /* ④ 模型 */
    let expectedModel = '';
    try {
        expectedModel = (typeof stCtx.getChatCompletionModel === 'function')
            ? stCtx.getChatCompletionModel(settings)
            : settings.model;
    } catch (e) {
        expectedModel = settings.model;
    }
    if (normalizeIdentityValue(body.model) !== normalizeIdentityValue(expectedModel)) return false;

    return true;
}

/* ── 位置备用证据（E3）与分层判定入口 ───────── */

/* 放弃本轮的位置证据（本轮候选写请求出现第二条）：把已按「位置」证据判原生的记录退回「插件」。
   仅退回「仍是位置证据判定的原始结果、且没有被响应落楼修正过」的记录——已由响应落楼修正
   （record.sourceCorrected）提升为原生的记录保留原生（那是另一条独立证据）。 */
function revokePositionEvidence(pass) {
    if (!pass) return;
    let revoked = 0;
    for (const list of [records, tourPendingRecords]) {
        for (const record of list) {
            const src = record && record.source;
            if (!src || src.evidence !== 'position' || src.passId !== pass.id) continue;
            if (record.sourceCorrected) continue;
            const prevType = src.type;
            record.source = makeSource('plugin', SOURCE_PLUGIN_DEFAULT_DETAIL, 'E3-revoked');
            refreshRecordSourceDom(record, prevType);
            revoked++;
        }
    }
    if (revoked > 0) {
        lastExclusionReason = `E3-revoked: 本轮出现多条候选写请求，位置证据作废（${revoked} 条退回「插件」）`;
    }
}

/* 作废本轮的位置证据：标记轮次 + 记下编号（供「已在途但尚未建档」的请求在 addRecord 时自查）+
   把已建档的按位置证据判原生的记录退回「插件」 */
function forfeitPositionEvidence(pass) {
    if (!pass) return;
    pass.positionForfeited = true;
    lastForfeitedPositionPassId = pass.id;
    revokePositionEvidence(pass);
}

/* E3 位置证据的最终确认：判定（拦截时）与建档（异步、要等 token 计算）是两步，中间本轮可能已经
   出现第二条候选写请求——此时位置证据不成立，直接按「插件」建档，避免先「原生」再退回的可见抖动。 */
function finalizePositionEvidenceSource(source) {
    if (!source || source.evidence !== 'position') return source;
    const forfeitedByLive = !!(generationPass && generationPass.id === source.passId
        && generationPass.candidateCount >= 2);
    if (forfeitedByLive || lastForfeitedPositionPassId === source.passId) {
        lastExclusionReason = 'E3-revoked: 本轮出现多条候选写请求，位置证据作废';
        return makeSource('plugin', SOURCE_PLUGIN_DEFAULT_DETAIL, 'E3-revoked');
    }
    return source;
}

/* E3 候选计数：本轮内、公开数据事件（本轮起点）之后的每一个候选写请求都计数，信封解包命中的同样算；
   出现两条及以上即放弃位置证据。为避免重复计数，只由 processCapturedBody 在通过请求体校验后调用一次。 */
function notePassWriteCandidate() {
    const pass = getActiveGenerationPass();
    if (!pass || pass.dataTime == null) return;
    pass.candidateCount++;
    if (pass.candidateCount >= 2) forfeitPositionEvidence(pass);
}

/* 旧兜底（最低优先级，保留不删）：原生入口点击 / 回车 + 5 秒窗口 + 生成开始事件的类型保底。
   不立即消费原生入口（重新生成 / 备选回复等操作中可能有中间请求），标记在窗口过期后自动清除。
   @returns {object|null} 命中返回来源对象，否则 null */
function legacyNativeIntentSource() {
    const now = Date.now();
    if (lastNativeIntent && (now - lastNativeIntent.timestamp) <= NATIVE_INTENT_WINDOW_MS) {
        return makeSource('native', `原生请求-${lastNativeIntent.target}`, 'legacy');
    }
    if (lastNativeIntent && (now - lastNativeIntent.timestamp) > NATIVE_INTENT_WINDOW_MS) {
        lastNativeIntent = null;
    }
    return null;
}

/* 请求来源分层判定入口（固定顺序见本节顶部注释；顺序理由务必保留）
   @param {object} body 已通过校验的请求体对象
   @param {string} requestUrl 生效请求地址
   @param {object|null} context 请求上下文 { rawText, bodyObject, method, topWindow, signal, streamingSignal, fromXhr }
   @returns {object} 来源对象（原生 / 插件） */
function decideRequestSource(body, requestUrl, context) {
    const ctxInfo = context || {};
    const pass = getActiveGenerationPass();

    /* 1 E1 可中止句柄对象同一（仅 fetch 且仅流式）→ 原生 */
    if (matchHandleIdentity(ctxInfo)) {
        return noteSourceDecision(makeSource('native', '原生请求-流式句柄', 'E1'), '请求携带的信号对象与当前流式处理器实例一致');
    }

    /* 2 E2 请求体来自本轮主生成的公开数据（主判据；每轮只认领第一条命中的请求）→ 原生 */
    if (matchDataSameSource(ctxInfo)) {
        if (pass) pass.e2Claimed = true;
        return noteSourceDecision(makeSource('native', '原生请求-数据同源', 'E2'), '请求体与本轮公开数据同源');
    }

    /* 3 通用排除项（仅信封可前置终止，已在入口完成）→ 插件 */
    if (isChatCompletionShaped(body)) {
        if (!Object.prototype.hasOwnProperty.call(body, 'type')) {
            return noteSourceDecision(makeSource('plugin', SOURCE_PLUGIN_DEFAULT_DETAIL, 'X2'), '聊天补全请求体缺 type 字段（体不是 ST 构造的）');
        }
        if (body.type === 'quiet') {
            return noteSourceDecision(makeSource('plugin', SOURCE_PLUGIN_DEFAULT_DETAIL, 'X2'), 'type === quiet（安静生成，非主剧情请求）');
        }
        if (!isApiIdentityConsistent(body, requestUrl)) {
            return noteSourceDecision(makeSource('plugin', SOURCE_PLUGIN_DEFAULT_DETAIL, 'X3'), 'API 身份与主配置不一致（服务商 / 请求地址 / 渠道地址 / 模型）');
        }
    }
    if (!pass) {
        return noteSourceDecision(makeSource('plugin', SOURCE_PLUGIN_DEFAULT_DETAIL, 'X4'), '不在任何主生成轮次内');
    }
    if (!ctxInfo.topWindow) {
        return noteSourceDecision(makeSource('plugin', SOURCE_PLUGIN_DEFAULT_DETAIL, 'X5'), '来自同源 iframe（非顶层窗口）');
    }

    /* 4 E3 位置备用证据（公开数据事件之后、本轮结束之前，且本轮只出现这一条候选写请求）→ 原生 */
    if (pass && pass.dataTime != null && pass.candidateCount === 1) {
        const result = makeSource('native', '原生请求-位置证据', 'E3');
        result.evidence = 'position';
        result.passId = pass.id;
        return noteSourceDecision(result, '公开数据事件之后、本轮唯一候选写请求');
    }

    /* 5 旧兜底（最低优先级）→ 原生 */
    const legacy = legacyNativeIntentSource();
    if (legacy) return noteSourceDecision(legacy, '旧时间窗兜底（原生入口点击 / 回车）');

    /* 6 其余 → 插件（默认） */
    return noteSourceDecision(makeSource('plugin', SOURCE_PLUGIN_DEFAULT_DETAIL, 'default'), '默认插件');
}

/* ── 响应落楼后的来源修正（只做「插件 → 原生」提升） ── */

/* 楼层文本归一化：统一换行、折叠行内空白、去掉行首尾空白与空行。
   （ST 落楼时会做停止串裁剪、提示词偏置拼接等加工，这里只做空白层面的归一化。） */
function normalizeFloorText(text) {
    if (typeof text !== 'string' || !text) return '';
    return text.replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[\t\u00a0 ]+/g, ' ').trim())
        .filter((line) => line.length > 0)
        .join('\n');
}

/* 回复的「纯正文」（不含思考）：记录里的回复是 `<think>…</think>` + 空行 + 正文的拼接形式 */
function getReplyPlainContent(record) {
    const content = (record && record.reply && record.reply.content) || '';
    return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/* 楼层正文是否与记录纯正文匹配（两侧都已归一化）：完全相等，或长度足够时「楼层包含正文」
   （续写生成会把新内容拼到楼层末尾、提示词偏置会加在楼层开头；短文本只认完全相等，避免误判） */
function isFloorTextMatch(floorText, replyText) {
    if (!floorText || !replyText) return false;
    if (floorText === replyText) return true;
    if (replyText.length < SOURCE_CORRECTION_MIN_OVERLAP) return false;
    return floorText.indexOf(replyText) !== -1;
}

/* 记住最近一次 ST 消息事件（消息到达 / 角色消息已渲染 / 翻页已切换）的楼层候选文本：
   当前楼层正文 + 该楼层的翻页候选（swipes）。 */
function rememberFloorEvent(mesId) {
    const stCtx = getStContextSafe();
    const chat = stCtx && stCtx.chat;
    const idx = Number(mesId);
    const message = (Array.isArray(chat) && Number.isFinite(idx)) ? chat[idx] : null;
    if (!message || typeof message !== 'object') return;

    const texts = [];
    if (typeof message.mes === 'string' && message.mes.trim()) texts.push(message.mes);
    if (Array.isArray(message.swipes)) {
        for (const swipe of message.swipes) {
            if (typeof swipe === 'string' && swipe.trim()) texts.push(swipe);
        }
    }
    const normalized = texts.map(normalizeFloorText).filter((t) => t);
    if (normalized.length === 0) return;

    lastFloorEvent = { mesId: idx, texts: normalized, at: Date.now() };
    scheduleSourceCorrectionCheck();
}

/* 登记一条「待修正」记录（响应正文定稿时调用）：只登记当前标「插件」的非演示记录。
   演示记录跳过；查找修正目标时同时覆盖正常列表与引导暂存队列（见 prunePendingSourceCorrections）。 */
function queueSourceCorrection(record) {
    if (!record || record.isDemo) return;
    if (!record.source || record.source.type !== 'plugin') return;
    if (record.source.rule === 'envelope') return; /* 信封解包记录来源固定为「插件」，不参与修正 */
    pendingSourceCorrections.set(record, { at: Date.now() });
    scheduleSourceCorrectionCheck();
}

/* 清理待修正表：记录已不在列表（被裁剪 / 清空 / 删除）或超出保留时长。
   宽限期内的条目只按存活时长判断——「回复先到、记录后入列表」时记录还没进列表，
   按成员关系判定会把刚登记的条目误删。 */
function prunePendingSourceCorrections(now) {
    for (const [record, meta] of pendingSourceCorrections) {
        const age = now - meta.at;
        if (age <= SOURCE_CORRECTION_PENDING_GRACE_MS) continue;
        const alive = records.indexOf(record) !== -1 || tourPendingRecords.indexOf(record) !== -1;
        if (!alive || age > SOURCE_CORRECTION_PENDING_TTL_MS) {
            pendingSourceCorrections.delete(record);
        }
    }
}

/* 触发一次修正尝试：立即一次 + 一次短延迟重试（消息事件先到、响应还没读完时补一次；
   响应后到的那一侧由 queueSourceCorrection → 本函数负责触发，谁后到由谁触发）。 */
function scheduleSourceCorrectionCheck() {
    if (pendingSourceCorrections.size === 0) return;
    tryPromoteSourcesFromFloor();
    if (sourceCorrectionTimer === null) {
        sourceCorrectionTimer = setTimeout(() => {
            sourceCorrectionTimer = null;
            tryPromoteSourcesFromFloor();
        }, SOURCE_CORRECTION_RETRY_MS);
    }
}

/* 修正：当前标「插件」的记录，其响应纯正文（不含思考）归一化后与刚出现的楼层正文 / 翻页候选
   匹配、且匹配唯一 → 提升为「原生」。只做提升、绝不做降级；匹配到 0 条或多条一律不修
   （以「响应没有落楼」当证据不安全：失败、中止、安静生成、扮演都不落楼）。 */
function tryPromoteSourcesFromFloor() {
    const floorEvent = lastFloorEvent;
    if (!floorEvent || !floorEvent.texts.length) return;
    const now = Date.now();
    if ((now - floorEvent.at) > SOURCE_CORRECTION_WINDOW_MS) return; /* 楼层事件太旧：不做修正 */

    prunePendingSourceCorrections(now);
    if (pendingSourceCorrections.size === 0) return;

    let matchedRecord = null;
    let matchedCount = 0;
    for (const [record] of pendingSourceCorrections) {
        if (!record.reply || !record.source || record.source.type !== 'plugin') continue;
        const replyText = normalizeFloorText(getReplyPlainContent(record));
        if (!floorEvent.texts.some((text) => isFloorTextMatch(text, replyText))) continue;
        matchedCount++;
        matchedRecord = record;
        if (matchedCount > 1) break;
    }
    if (matchedCount !== 1) return;
    promoteRecordSource(matchedRecord);
}

/* 把记录来源提升为「原生」（只改来源三个字段：类型 / 显示名 / 悬停说明；记录其它内容不动） */
function promoteRecordSource(record) {
    const prevType = record.source && record.source.type;
    record.source = makeSource('native', '原生请求-响应落楼修正', 'correct');
    record.sourceCorrected = true;
    pendingSourceCorrections.delete(record);
    sourceCorrectionStats.count++;
    sourceCorrectionStats.lastReason = '响应纯正文与楼层正文 / 翻页候选唯一匹配';
    sourceCorrectionStats.lastTime = formatTimestamp(Date.now());
    refreshRecordSourceDom(record, prevType);
}

/* 安装来源修正跟踪：ST 消息事件（消息到达 / 角色消息已渲染 / 翻页已切换）→ 记住楼层候选并尝试修正 */
function installSourceCorrectionTracking() {
    if (sourceCorrectionTrackingInstalled) return;
    if (!eventSource || !event_types) return;
    sourceCorrectionTrackingInstalled = true;

    const onFloorEvent = (mesId) => rememberFloorEvent(mesId);
    for (const key of ['MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SWIPED']) {
        const evt = event_types[key];
        if (evt) eventSource.on(evt, onFloorEvent);
    }
}

/* fetch 请求的来源判定上下文（拦截瞬间同步读取；XHR 侧由 beginXhrCapture 单独构造） */
function buildFetchRequestContext(realmWindow, input, init, method) {
    let signal = (init && init.signal) ? init.signal : null;
    if (!signal && isRequestLike(input)) {
        try { signal = input.signal || null; } catch (e) { signal = null; }
    }
    const stCtx = getStContextSafe();
    const processor = stCtx ? stCtx.streamingProcessor : null;
    const streamingSignal = (processor && processor.abortController) ? processor.abortController.signal : null;
    return {
        rawText: (init && typeof init.body === 'string') ? init.body : null,
        bodyObject: null, /* 外层判定通过时由 decideCapturedRequest 补上（对象引用相同也是 E2 证据） */
        method,
        topWindow: realmWindow === window,
        fromXhr: false,
        signal,
        streamingSignal,
    };
}

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

    const onNativeClickIntent = (e) => {
        const targetEl = e.target instanceof Element ? e.target : null;
        if (!targetEl) return;

        /* 只在聊天相关区域内检查（#sheld 是 ST 主内容区容器），避免菜单/设置等区域的无意义遍历 */
        const chatZone = document.getElementById('sheld') || document.getElementById('chat') || document.getElementById('send_form');
        if (chatZone && !chatZone.contains(targetEl)) {
            return;
        }

        let matched = null;

        for (const item of nativeTargets) {
            if (targetEl.closest(item.selector)) {
                matched = item;
                break;
            }
        }

        if (matched) {
            rememberNativeIntent(matched.label, e.type === 'pointerdown' ? 'pointerdown' : 'click');
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
                /* 仅当 DOM 点击事件未能捕获时补充标记，且只认明确的原生生成类型 */
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
                }
            };
            try {
                stCtx.eventSource.on(stCtx.event_types.GENERATION_STARTED, onGenStarted);
            } catch (err) {
                /* 注册失败只影响保底识别，DOM 入口监听照常工作 */
                console.debug(`[${PLUGIN_KEY}] 注册 GENERATION_STARTED 监听失败:`, err);
            }
        }
    }

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (e.isComposing || e.keyCode === 229) return;
        if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;

        const targetEl = e.target;
        if (!(targetEl instanceof HTMLTextAreaElement)) return;
        if (targetEl.id !== 'send_textarea') return;

        rememberNativeIntent('输入框 Enter', 'keydown');
    }, true);

    /* 暴露调试接口到 window */
    window.__rlogDebug = {
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
        /* XHR 包装计数（统计已挂钩的同源 iframe realm） */
        getXhrHookCount: () => {
            let count = 0;
            document.querySelectorAll('iframe').forEach((f) => {
                try {
                    if (f.contentWindow && hookedXhrProtos.has(f.contentWindow)) count++;
                } catch (e) { /* 跨域 iframe 跳过 */ }
            });
            return count;
        },
        /* 最近一次信封解包尝试的结果（命中与否 + 原因；命中时含 G9 选中的顶层候选序号，不含真实地址） */
        getLastEnvelopeResult: () => lastEnvelopeResult,
        /* 回复待办区当前条目数（回归断言用：非记录类请求不应占用名额） */
        getPendingReplyCount: () => pendingReplies.size,
        /* 当前主生成轮次状态与类型（只读摘要；不含请求体引用） */
        getGenerationPass: () => {
            const pass = generationPass;
            if (!pass) return { active: false };
            return {
                active: !!pass.active,
                id: pass.id,
                type: pass.type,
                startTime: pass.startTime,
                ageMs: Date.now() - pass.startTime,
                depth: pass.depth,
                hasData: pass.dataTime != null,
                hasBodyRef: !!pass.bodyRef,
                hasChatBodyRef: !!pass.chatBodyRef,
                promptCount: Array.isArray(pass.promptArray) ? pass.promptArray.length : 0,
                e2Claimed: !!pass.e2Claimed,
                candidateCount: pass.candidateCount,
            };
        },
        /* 最近一次来源判定（主证据命中类型：E1 句柄同一 / E2 数据同源 / E3 位置；排除：X2–X5 / 默认） */
        getLastSourceDecision: () => (lastSourceDecision ? { ...lastSourceDecision } : null),
        /* 最近一次判「插件」的排除原因 */
        getLastExclusion: () => lastExclusionReason,
        /* 修正次数与最近一次原因（只做「插件 → 原生」提升） */
        getSourceCorrectionStats: () => ({ ...sourceCorrectionStats }),
        /* 当前待修正记录数（响应已定稿、等待落楼匹配） */
        getPendingCorrectionCount: () => pendingSourceCorrections.size,
        /* 正文卸载/恢复统计（只读）：loaded/unloaded 为列表内当前状态，passes/lastPassMs 为带宽维护计数 */
        getBodyUnloadStats: () => {
            const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
            let loaded = 0;
            if (listEl) {
                listEl.querySelectorAll('.rmsg-content').forEach((contentEl) => {
                    if (!unloadedBodies.has(contentEl)) loaded++;
                });
            }
            return {
                loaded,
                unloaded: unloadedBodies.size,
                passes: bodyUnloadStats.passes,
                lastPassMs: Math.round(bodyUnloadStats.lastPassMs * 10) / 10,
                restoreAllCount: bodyUnloadStats.restoreAllCount,
            };
        },
    };

    console.debug(`[${PLUGIN_KEY}] 请求来源识别已启用（证据分层判定 + 原生入口监听保底）。调试接口: window.__rlogDebug`);
}

function getSourceLabel(source) {
    if (source && source.type === 'native') return '原生';
    return '插件';
}

function getSourceClass(source) {
    if (source && source.type === 'native') return 'rlog-source-native';
    return 'rlog-source-plugin';
}

/* ── 请求拦截（fetch + XHR） ────────────── */

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
                    tokens: 0, /* 由 computeTokensForMessages 异步计算 */
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
                    tokens: 0,
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
                    tokens: 0,
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
                tokens: 0,
                collapsed: true,
            });
        }
        for (const m of json.messages) {
            if (!isAiMessageObject(m)) continue;
            if (typeof m.content === 'string' && m.content) {
                messages.push({
                    role: normalizeRole(m.role),
                    content: m.content,
                    tokens: 0,
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
            tokens: 0,
            collapsed: false,
        });
    }

    if (messages.length === 0) return null;
    return messages;
}

/* 遮蔽原始请求体里的敏感字段（入库用）；不改动入参对象，未命中时原样返回
   @param {object} body @returns {object} */
function redactSensitiveBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;

    let redacted = null;
    for (const field of SENSITIVE_BODY_FIELDS) {
        /* 空值无需遮蔽 */
        if (!body[field]) continue;
        if (!redacted) redacted = Object.assign({}, body);
        redacted[field] = SENSITIVE_BODY_MASK;
    }
    return redacted || body;
}

/* 后台异步处理已捕获的请求体（解析消息、算 token、存记录），与请求发送解耦、不阻塞网络
   @param {object} body @param {string} requestUrl @param {number|null} captureId
   @param {boolean} [viaProxyEnvelope=false] 是否由信封解包得到（来源强制标「插件」）
   @param {object|null} [requestContext=null] 来源判定上下文（RQ-32：原始文本 / 请求体对象 / 是否顶层 / 信号对象）
   @param {object|null} [simulateCtx=null] 本次模拟的捕获上下文（非空即「这条是模拟捕获」；来源固定为模拟、不参与来源判定） */
async function processCapturedBody(body, requestUrl, captureId, viaProxyEnvelope = false, requestContext = null, simulateCtx = null) {
    const isSimulated = !!simulateCtx;
    if (!body || !isAiRequestBody(body, requestUrl)) {
        if (isSimulated) simulateCtx.settle(null);
        return;
    }

    const messages = parseFetchRequestBody(body);
    if (!messages) {
        if (isSimulated) simulateCtx.settle(null);
        return;
    }

    const characterName = getCurrentCharacterName();
    /* E3 候选计数（本轮候选写请求，两条及以上即作废位置证据）：一条请求只计一次；模拟捕获不计入 */
    if (!isSimulated) notePassWriteCandidate();
    /* 信封解包命中（判定序 0，唯一可前置终止的排除项）：来源固定为「插件」，不做证据分层判定；
       模拟捕获固定用模拟来源，同样不做判定 */
    const source = isSimulated
        ? { ...SIMULATED_PROMPT_SOURCE }
        : (viaProxyEnvelope
            ? noteSourceDecision(ENVELOPE_PROXY_SOURCE, '信封解包命中（RQ-31，判定终局）')
            : decideRequestSource(body, requestUrl, requestContext));
    let modelName = extractModelName(body);
    /* 模拟记录的模型名回退：请求体里取不到时用 ST 当前模型名 */
    if (isSimulated && modelName === '未知模型') modelName = getStChatCompletionModelName() || modelName;
    /* 模拟已判失败（超时）就不再建档：分词前后各查一次，避免白算 */
    if (isSimulated && simulateCtx.canceled) {
        simulateCtx.settle(null);
        return;
    }
    /* 用 ST 原生分词器精确计算 token（modelName 用于判断分词器是否兼容） */
    await computeTokensForMessages(messages, modelName);
    /* 分词期间也可能超时：同样不建档 */
    if (isSimulated && simulateCtx.canceled) {
        simulateCtx.settle(null);
        return;
    }
    /* captureId 用于把该请求的回复精确挂回这条记录；rawBody 入库前先遮蔽敏感字段 */
    const record = addRecord(characterName, messages, source, modelName, redactSensitiveBody(body), captureId,
        { simulated: isSimulated });
    /* 模拟捕获：兑现「记录已建好」的完成信号；没建成记录兑现空值，模拟流程按失败处理 */
    if (isSimulated) simulateCtx.settle(record || null);
}

/* 判断 fetch 输入是否为 Request 对象。
   用鸭子类型而非 instanceof：跨 realm 时 iframe 内的 Request 在主窗口的
   `instanceof Request` 恒为 false，但 clone/text 方法仍然可用。 */
function isRequestLike(input) {
    return !!(input && typeof input === 'object' && typeof input.clone === 'function' && typeof input.text === 'function');
}

/* 构造 fetch 拦截包装（主窗口与同源 iframe 共用）：每个 realm 用独立重入标记，包装内部始终调用
   该 realm 自己的原始 fetch（跨 realm 传 Request 会抛错）。快速通道按「非写请求 → ST 内部 API →
   才解析 body」逐级过滤；锁只保护 body 的同步捕获，originalFetch 在锁释放后立即调用，
   分词与 addRecord 走异步，不阻塞网络请求发出。
   外层判定不通过（含被快速通道跳过）时，异步阶段再尝试按信封形状解包（见 decideCapturedRequest）。
   @param {Window} realmWindow @param {Function} getOriginalFetch @returns {Function} */
function createFetchHook(realmWindow, getOriginalFetch) {
    let realmHookInFlight = false; /* 该 realm 的重入保护（防其他包装形成闭环） */
    return async function hookedFetch(input, init) {
        const originalFetch = getOriginalFetch();

        /* ── 模拟预览 ──
           发前通知一到就「武装」的目标请求即本次模拟那条：继续往下走、按正常记录管线建档，
           最后不交给原始 fetch（见下方 fetchPromise）；窗口内没被认领的生成请求仍旧只拦不记 */
        const simulateWindowHit = simulatePromptActive && GENERATE_ENDPOINT_RE.test(getFetchRequestUrl(input));
        /* 目标请求只可能由主窗口发出（ST 自己的发送链路）：iframe 内的生成请求只拦不认领 */
        const simulateCapture = (simulateWindowHit && simulateCaptureCtx && simulateCaptureCtx.armed && realmWindow === window)
            ? simulateCaptureCtx
            : null;
        if (simulateCapture) simulateCapture.armed = false; /* 只认领这一条 */
        if (simulateWindowHit && !simulateCapture) {
            return Promise.reject(new DOMException('Simulate mode: generation request blocked', 'AbortError'));
        }

        /* ── 快速通道 0：重入保护（模拟捕获这条要建档，不受此限） ── */
        if (realmHookInFlight && !simulateCapture) {
            return originalFetch.apply(realmWindow, [input, init]);
        }

        /* ── 快速通道 1：总开关关闭时直接透传，不解析 body（模拟捕获这条不受此限） ── */
        if (!masterEnabled && !simulateCapture) {
            return originalFetch.apply(realmWindow, [input, init]);
        }

        /* ── 快速通道 2：非 POST/PUT/PATCH 请求直接跳过 ── */
        let method = init && init.method ? init.method.toUpperCase() : 'GET';
        if (isRequestLike(input) && method === 'GET') {
            try { method = input.method.toUpperCase(); } catch (e) { /* ignore */ }
        }
        if (!simulateCapture && method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
            return originalFetch.apply(realmWindow, [input, init]);
        }

        /* ── 快速通道 3：URL 是 ST 内部接口且不含生成端点特征 ──
           既有的「直接跳过」保持不变：只有 body 是同步可读字符串、且文本命中「URL 形状」预筛
           （信封式代理请求的通用特征）时才继续往下捕获，其余照旧直接透传、不解析 body。 */
        const requestUrl = getFetchRequestUrl(input);
        const outerFastPath = isOuterFastPathUrl(requestUrl);
        const shapeText = (init && typeof init.body === 'string') ? init.body : null;
        if (!simulateCapture && outerFastPath && (!shapeText || !ENVELOPE_URL_SHAPE_RE.test(shapeText))) {
            return originalFetch.apply(realmWindow, [input, init]);
        }
        /* 回复追踪的闸门地址：外层地址被快速通道跳过时，用预筛命中的内层候选地址
           （captureResponseForRequest 只在「地址像生成端点」时才追踪回复） */
        let replyGateUrl = requestUrl;
        if (outerFastPath && shapeText) {
            const shapeMatch = shapeText.match(ENVELOPE_URL_SHAPE_RE);
            if (shapeMatch) replyGateUrl = shapeMatch[0];
        }

        /* ── 加锁仅保护 body 的同步捕获（不涉及 I/O 或 await）；需要从 Request 异步读 body 时，
           启动读取后立即退出锁，originalFetch 在锁外尽快调用 ── */
        realmHookInFlight = true;
        /* object|null: 从 init.body 同步捕获到的请求体（无需异步读取时使用） */
        let syncBody = null;
        /* string|null: 从 init.body 同步捕获到的原始请求文本（信封解包用） */
        let rawText = null;
        /* Promise<object|null>|null: 从 Request.clone() 异步读取 body 的 Promise */
        let asyncBodyPromise = null;
        try {
            if (init && init.body) {
                if (typeof init.body === 'string') {
                    rawText = init.body;
                    /* 外层被快速通道跳过时不解析：是否解析交给信封预筛命中后的异步判定 */
                    if (!outerFastPath) {
                        try { syncBody = JSON.parse(init.body); } catch (e) { syncBody = null; }
                    }
                } else if (typeof init.body === 'object' && !Array.isArray(init.body)) {
                    /* 直接引用（不 clone，因为 processCapturedBody 只做读取） */
                    syncBody = init.body;
                }
            }

            /* Request 对象 body 不额外读取（信封探测只针对同步可读的 init.body 字符串） */
            if (!outerFastPath && !syncBody && isRequestLike(input)) {
                try {
                    const clonedReq = input.clone();
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
        }

        /* ── 请求上下文（来源判定用，RQ-32）──
           在拦截瞬间同步读取；E1（句柄对象同一）的两个信号取自同一时刻，
           故不存在「判定晚于流式处理器销毁」的时序窗口。 */
        const requestContext = buildFetchRequestContext(realmWindow, input, init, method);

        /* ── 调用原始 fetch（锁外；经闭包引用调用，避免经 window.fetch 递归）──
           模拟捕获这条例外：记录跑完就返回「已中止」，不把请求交出去 */
        const fetchPromise = simulateCapture
            ? Promise.reject(new DOMException('Simulate mode: generation request blocked', 'AbortError'))
            : originalFetch.apply(realmWindow, [input, init]);

        /* ── 后台异步处理 body（不阻塞 fetch 返回） ── */
        if (syncBody || rawText || asyncBodyPromise) {
            /* 本次请求捕获编号：回复挂载、待办区清理都依赖它；模拟捕获这条不发网络，没有回复可追 */
            const captureId = simulateCapture ? null : ++captureSeq;
            /* 在返回给调用方的同一个 fetchPromise 上挂回复追踪（精确对应，乱序/并发不串）；
               模拟捕获这条没有回复可追 */
            if (captureId != null) captureResponseForRequest(fetchPromise, replyGateUrl, captureId);
            /* 统一判定（外层优先、外层不通过才尝试信封解包），命中即用生效地址与生效请求体建档；
               getBody 惰性求值，被快速通道跳过时不重复解析外层 body */
            const handleBody = (getBody) => {
                const decision = decideCapturedRequest({
                    requestUrl,
                    method,
                    rawText,
                    context: requestContext,
                    getBody,
                });
                if (!decision) {
                    /* 模拟捕获这条没过请求体判定：不建档，也别让模拟流程一直等 */
                    if (simulateCapture) simulateCapture.settle(null);
                    return null;
                }
                return processCapturedBody(decision.effectiveBody, decision.effectiveUrl, captureId,
                    decision.viaProxyEnvelope, decision.context, simulateCapture);
            };
            if (syncBody || rawText) {
                /* 同步捕获的 body / 原始文本：解析与判定放到请求发出之后的异步阶段 */
                Promise.resolve().then(() => handleBody(() => syncBody || parseJsonText(rawText)))
                    .catch(() => { /* 静默处理 */ });
            } else if (asyncBodyPromise) {
                asyncBodyPromise.then(body => {
                    if (body) return handleBody(() => body);
                }).catch(() => { /* 静默处理 */ });
            }
        }

        return fetchPromise;
    };
}

/* 安装主窗口请求拦截（fetch + XHR）：两套包装都始终安装，内部由 masterEnabled 决定是否记录。
   本插件的包装在 buildUI（APP_READY / 延迟兜底）时才装上，因此比「脚本执行期就装好」的包装更靠外；
   originalFetch / 原 XHR 原型方法捕获到的，是当时已经就绪的那条下游调用链。 */
function installRequestHooks() {
    if (currentHook) return; /* 已安装 */

    originalFetch = window.fetch;
    currentHook = createFetchHook(window, () => originalFetch);
    window.fetch = currentHook;
    hookedFetchHooks.set(window, currentHook);
    hookRealmXhr(window);

    console.debug(`[${PLUGIN_KEY}] 请求拦截已启用（fetch + XHR，网络层统一拦截模式）`);
}

/* 给单个同源 iframe 安装请求包装（fetch + XHR）：跨域拿不到 contentWindow 直接跳过；
   已装且未被替换则跳过，避免破坏该 realm 的包装链。
   @param {HTMLIFrameElement} iframe @returns {boolean} 是否已安装 */
function hookIframeRequests(iframe) {
    if (!iframe) return false;
    if (!iframe.contentWindow) {
        /* contentWindow 尚未就绪：挂 load 监听，加载完成后重试 */
        if (!iframeLoadListenersAttached.has(iframe)) {
            iframeLoadListenersAttached.add(iframe);
            iframe.addEventListener('load', () => hookIframeRequests(iframe));
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

    /* fetch 包装：已装且未被替换则跳过 */
    let ready = true;
    const existingHook = hookedFetchHooks.get(win);
    if (existingHook && win.fetch === existingHook) {
        ready = true;
    } else if (typeof win.fetch === 'function') {
        /* 捕获该 realm 当前的原始 fetch；iframe 重载（realm 重建）或内部脚本替换 fetch
           后，由 load 监听重新包装。 */
        const iframeOriginalFetch = win.fetch;
        const hook = createFetchHook(win, () => iframeOriginalFetch);
        win.fetch = hook;
        hookedFetchHooks.set(win, hook);
    } else {
        ready = false;
    }

    /* XHR 包装：同一个 realm 只装一次，已装且未被替换则跳过 */
    if (!hookRealmXhr(win)) ready = false;

    if (!iframeLoadListenersAttached.has(iframe)) {
        iframeLoadListenersAttached.add(iframe);
        iframe.addEventListener('load', () => hookIframeRequests(iframe));
    }
    return ready;
}

/* 安装同源 iframe 请求包装（fetch + XHR）：
   初始扫描现有 iframe，并用 MutationObserver 监听后续动态创建
   （脚本启停、角色/预设切换重建、消息渲染等）。包装始终安装，内部由 masterEnabled 决定是否记录。 */
function installIframeRequestHooks() {
    if (iframeHooksInstalled) return;
    iframeHooksInstalled = true;

    /* 初始扫描：安装时页面里可能已存在同源 iframe */
    let hookedCount = 0;
    let totalCount = 0;
    for (const iframe of document.querySelectorAll('iframe')) {
        totalCount++;
        if (hookIframeRequests(iframe)) hookedCount++;
    }

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.tagName === 'IFRAME') {
                    hookIframeRequests(node);
                } else if (node.querySelectorAll) {
                    for (const inner of node.querySelectorAll('iframe')) {
                        hookIframeRequests(inner);
                    }
                }
            }
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    console.debug(`[${PLUGIN_KEY}] iframe 请求拦截已启用（fetch + XHR，初始 ${hookedCount}/${totalCount} 个 iframe + 动态监听）`);
}

/* ── XHR 包装与旁听 ─────────────────────── */

/* 把 open 收到的地址按该 realm 自身的 location 解析为绝对地址（主窗口与 iframe 的 location 不同）。 */
function resolveRealmUrl(realmWindow, url) {
    const raw = (typeof url === 'string') ? url : (url != null ? String(url) : '');
    if (!raw) return '';
    try {
        const base = (realmWindow && realmWindow.location) ? realmWindow.location.href : undefined;
        return new URL(raw, base).toString();
    } catch (e) {
        return raw;
    }
}

/* 开始一次 XHR 旁听（只旁听、绝不打扰）：send 阶段同步建「被动缓冲」合成流并挂事件监听，
   此时不分配 captureId、不注册回复追踪；判定通过后由调用方接管。
   来源判定上下文里 signal / streamingSignal 恒为 null：XHR 没有请求身上的可中止句柄，
   E1（句柄对象同一）只适用于 fetch，绝不可套到 XHR 上。
   @param {XMLHttpRequest} xhr @param {*} body @param {Window} realmWindow 发出该请求的 realm
   @returns {{method, url, rawText, trackReply, responsePromise, discard, context}|null} */
function beginXhrCapture(xhr, body, realmWindow) {
    if (!masterEnabled) return null;
    if (!xhr || typeof xhr !== 'object') return null;
    const meta = xhrOpenMeta.get(xhr);
    if (!meta || !meta.async) return null;              /* 未经过 open 或同步 XHR（第三参 false）不追踪 */
    if (typeof body !== 'string' || !body) return null; /* 只旁听字符串 body */
    const requestUrl = meta.url;
    const rawText = body;
    /* 请求上下文（来源判定用，RQ-32）：是否顶层窗口 / 方法 / 原始请求文本 */
    const context = {
        rawText,
        bodyObject: null, /* 外层判定通过时由 decideCapturedRequest 补上 */
        method: meta.method,
        topWindow: realmWindow === window,
        fromXhr: true,
        signal: null,
        streamingSignal: null,
    };
    /* 外层快速通道：地址是 ST 内部接口且不含生成端点特征时，只有文本命中「URL 形状」预筛才继续
       （非信封的 /api/ 写请求在这一步就退出，成本与既有拦截的快速通道一致） */
    if (isOuterFastPathUrl(requestUrl) && !ENVELOPE_URL_SHAPE_RE.test(rawText)) return null;

    /* responseType 不是空/`text` 时只记请求、不追回复（因此不需要建流与监听） */
    let responseType = '';
    try { responseType = xhr.responseType || ''; } catch (e) { responseType = ''; }
    const trackReply = (responseType === '' || responseType === 'text');
    if (!trackReply) {
        return {
            method: meta.method,
            url: requestUrl,
            rawText,
            trackReply: false,
            responsePromise: null,
            discard: () => { /* 只记请求，无需清理缓冲 */ },
            context,
        };
    }

    /* 被动缓冲：ReadableStream 队列承接 progress 增量，判定通过前没有任何读取方 */
    let controller = null;
    const stream = new ReadableStream({ start(c) { controller = c; } });
    const encoder = new TextEncoder();
    let fedLength = 0;     /* 已喂入的 responseText 字符数（只保留增量，不整段累积） */
    let stopped = false;   /* 判定不通过/流已报错：停止继续喂入 */
    let settled = false;   /* 响应已到终态（load/error/abort/timeout 之一） */
    let resolveResponse = null;
    let rejectResponse = null;
    const responsePromise = new Promise((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
    });
    /* 判定不通过（未注册回复追踪）时不产生未处理的 Promise 拒绝 */
    responsePromise.catch(() => { /* 静默 */ });

    /* 增量喂入（只取本次新增的一段） */
    function feed(fullText) {
        if (stopped || typeof fullText !== 'string') return;
        const delta = fullText.slice(fedLength);
        if (!delta) return;
        fedLength = fullText.length;
        try { controller.enqueue(encoder.encode(delta)); } catch (e) { stopped = true; }
    }
    /* 网络失败/中止/超时：映射到现有失败分支（中止用 AbortError 名，走既有「用户中止」分支） */
    function fail(err) {
        if (settled) return;
        settled = true;
        stopped = true;
        try { controller.error(err); } catch (e) { /* ignore */ }
        rejectResponse(err);
    }

    xhr.addEventListener('progress', () => {
        if (settled) return;
        try { feed(xhr.responseText); } catch (e) { stopped = true; }
    });
    xhr.addEventListener('load', () => {
        if (settled) return;
        let text = '';
        try { text = xhr.responseText; } catch (e) { stopped = true; }
        feed(text);
        const status = Number(xhr.status) || 0;
        /* status 0（跨域被拒/网络失败）等非 200–599 按网络失败处理，不构造合成 Response */
        if (status < 200 || status > 599) {
            fail(new Error('network error'));
            return;
        }
        let response = null;
        try {
            const init = { status, statusText: xhr.statusText || '' };
            const contentType = xhr.getResponseHeader && xhr.getResponseHeader('content-type');
            if (contentType) init.headers = { 'content-type': contentType };
            /* 204/205/304 为无正文状态：必须不带 body 构造 */
            const noBody = (status === 204 || status === 205 || status === 304);
            response = noBody ? new Response(null, init) : new Response(stream, init);
        } catch (e) {
            response = null;
        }
        if (!response) {
            fail(new Error('network error'));
            return;
        }
        settled = true;
        try { controller.close(); } catch (e) { /* ignore */ }
        resolveResponse(response);
    });
    xhr.addEventListener('error', () => fail(new Error('network error')));
    xhr.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        fail(err);
    });
    xhr.addEventListener('timeout', () => fail(new Error('network error')));

    return {
        method: meta.method,
        url: requestUrl,
        rawText,
        trackReply: true,
        responsePromise,
        context,
        /* 判定不通过：丢弃被动缓冲（不分配 captureId、不占用回复待办名额） */
        discard: () => {
            stopped = true;
            try { controller.error(new Error('discarded')); } catch (e) { /* ignore */ }
        },
    };
}

/* 异步处理一次旁听到的 XHR：判定 → 分配捕获编号并注册回复追踪 → 走既有记录管道。
   @param {object} capture beginXhrCapture 的返回句柄 */
function processCapturedXhr(capture) {
    const decision = decideCapturedRequest({
        requestUrl: capture.url,
        method: capture.method,
        rawText: capture.rawText,
        context: capture.context,
        getBody: () => parseJsonText(capture.rawText),
    });
    if (!decision) {
        capture.discard();
        return null;
    }
    /* 判定通过才分配 captureId 并注册回复追踪：非记录类 XHR 完全不占用待办名额 */
    const captureId = capture.trackReply ? ++captureSeq : null;
    if (captureId != null) {
        captureResponseForRequest(capture.responsePromise, decision.effectiveUrl, captureId);
    }
    return processCapturedBody(decision.effectiveBody, decision.effectiveUrl, captureId,
        decision.viaProxyEnvelope, decision.context);
}

/* 给单个 realm 安装 XHR 包装（主窗口与同源 iframe 共用）：只旁听、绝不打扰原调用。
   open 记录方法与地址（相对地址按该 realm 自身 location 解析为绝对），send 捕获字符串 body；
   实例元数据用 WeakMap 存、重复 open 覆盖。已装且未被替换则跳过；
   iframe 重载（realm 重建）或内部脚本替换原型后由 load 监听重新包装。
   @param {Window} realmWindow @returns {boolean} 是否已安装 */
function hookRealmXhr(realmWindow) {
    if (!realmWindow) return false;
    let proto = null;
    try {
        const ctor = realmWindow.XMLHttpRequest;
        proto = ctor && ctor.prototype;
    } catch (e) {
        return false;
    }
    if (!proto || typeof proto.open !== 'function' || typeof proto.send !== 'function') return false;

    const installed = hookedXhrProtos.get(realmWindow);
    if (installed && proto.open === installed.open && proto.send === installed.send) return true; /* 已安装 */

    const originalOpen = proto.open;
    const originalSend = proto.send;

    const hookedOpen = function hookedXhrOpen(method, url, async) {
        try {
            xhrOpenMeta.set(this, {
                method: typeof method === 'string' ? method.toUpperCase() : 'GET',
                url: resolveRealmUrl(realmWindow, url),
                async: async !== false, /* 同步 XHR（open 第三参为 false）不追踪 */
            });
        } catch (e) { /* 忽略捕获异常，原 open 照常调用 */ }
        return originalOpen.apply(this, arguments);
    };

    const hookedSend = function hookedXhrSend(body) {
        let capture = null;
        try {
            capture = beginXhrCapture(this, body, realmWindow);
        } catch (e) {
            capture = null;
        }
        try {
            const result = originalSend.apply(this, arguments);
            if (capture) {
                /* 判定与记录放到请求发出之后的异步阶段，不阻塞 send */
                Promise.resolve().then(() => processCapturedXhr(capture))
                    .catch(() => { try { capture.discard(); } catch (e) { /* ignore */ } });
            }
            return result;
        } catch (err) {
            /* 原 send 自身抛错：丢弃本次捕获并按原样抛出，不改变错误语义 */
            try { if (capture) capture.discard(); } catch (e) { /* ignore */ }
            throw err;
        }
    };

    try {
        proto.open = hookedOpen;
        proto.send = hookedSend;
    } catch (e) {
        return false;
    }
    hookedXhrProtos.set(realmWindow, { open: hookedOpen, send: hookedSend });
    return true;
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
    if (status === 'simulated') return 'Simulated';
    if (status === 'fail') return 'Fail';
    if (status === 'timeout') return 'Timeout';
    return 'Succeed';
}

/* 取记录标题栏「状态标签」的状态值：模拟记录固定在 simulated，其余取真实回复状态
   @param {object} record @returns {string|null} */
function getRecordStatus(record) {
    if (record && record.simulated) return 'simulated';
    return (record && record.reply && record.reply.status) || null;
}

/* 回复状态标签槽位宽度（px）缓存：由 getReplyStatusMaxWidth 实测一次，供占位/标签共用 */
let replyStatusMaxWidth = null;

/* 实测三个状态标签在当前字体下的最大宽度（px），写入 --rlog-status-w，供等待占位共用槽位宽度，
   避免回复到达引起布局跳动。探针挂 body 并显式继承面板字体，只有测出有效宽度才缓存。
   @returns {number} */
function getReplyStatusMaxWidth() {
    if (replyStatusMaxWidth !== null) return replyStatusMaxWidth;
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

/* 状态标记悬停提示：只显示动态原因 + 终态时间（状态字样标签上已有）；成功统一显示 Succeed
   @param {object} record @returns {string} */
function getReplyStatusTitle(record) {
    if (record && record.simulated) return `Simulated · ${record.timestamp || ''}`;
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

/* 拼接回复展示内容：思考用 <think> 包裹、空一行后接正文
   @param {object} replyData { reasoning, content } @returns {string} */
function buildReplyContent(replyData) {
    const reasoning = (replyData.reasoning || '').trim();
    const content = (replyData.content || '').trim();
    const parts = [];
    if (reasoning) parts.push(`<think>\n${reasoning}\n</think>`);
    if (content) parts.push(content);
    return parts.join('\n\n');
}

/* 向正文/思考累积区追加文本：新文本是已累积文本的前缀且更长 → 替换（Gemini 等累计式），
   否则追加（OpenAI/Anthropic 增量式）；完全相同的重复块视为无新增、跳过。
   @param {object} entry @param {string} text @param {boolean} isReasoning */
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

/* 从单个 JSON chunk 提取正文/思考增量（兼容 OpenAI delta/message/text + reasoning_content、
   Anthropic delta.text/delta.thinking/content 数组、Gemini candidates[0].content.parts）
   @param {object} chunk @param {number} captureId */
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

/* 解析一段 SSE 文本（多个空行分隔的事件），逐事件提取增量，兼容 data: 行与 [DONE]
   @param {string} text @param {number} captureId */
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

/* 统一增量读取响应体（不依赖 Content-Type）：出现 data: 行即按 SSE 解析（兼容代理把流式响应标成
   application/json）；否则等流结束后整体解析 JSON/文本。中止/异常时 SSE 保留已收内容，
   JSON 无可用内容则记空回复。读取 clone，不影响 ST 与其他插件。
   @param {Response} clone @param {number} captureId @param {string|null} hintMode */
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

/* 读取非 2xx 响应正文提取真实报错（响应体只能读一次，必须读 clone）；任何失败回退到 baseReason
   @param {Response} response @param {number} captureId @param {string} baseReason */
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

/* 为已捕获的请求挂回复追踪：在 fetchPromise 上追加处理、不改动该 Promise，读 clone 不影响原响应
   @param {Promise<Response>} fetchPromise @param {string} requestUrl @param {number} captureId */
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
            /* clone 必须同步调用，否则 body 已使用会抛错 */
            const clone = response.clone();
            const contentType = (response.headers.get('content-type') || '').toLowerCase();
            /* Content-Type 只作提示：统一增量读取、靠正文识别 SSE，避免「代理对流式响应标
               application/json」时中止导致已收内容丢失 */
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

/* 回复追踪终态：标记完成、释放读取器、挂到已有记录；记录未建成则留在待办区（60s 上限）
   @param {number} captureId @param {string} status @param {string} failReason */
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

/* 取出并删除一条已终态的回复待办（仅在 finished 时返回，避免把在途占位挂成空回复）
   @param {number} captureId @returns {object|null} */
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

/* 把终态回复挂到记录（record.reply）并异步算 token；只追加 Response 子消息、不重建列表，
   阅读位置与搜索状态不受影响。
   @param {object} record @param {object} replyData @param {boolean} [skipRender=false] */
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
    /* 响应正文已定稿：登记为「待修正」（等 ST 消息事件落楼后做一次「插件 → 原生」的有限提升） */
    queueSourceCorrection(record);
}

/* 回复到达：只把 Response 子消息追加到该记录末尾并更新标题栏状态，不重建列表（阅读位置、
   内容区滚动、搜索状态保持不变）；面板不可见/记录不在 DOM/引导期间只置脏标记。
   @param {object} record */
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
        /* 幂等：已追加过则跳过（避免重复触发时插两条）；
           折叠记录的正文还没生成，此时不追加子消息 DOM（回复数据已在 record.reply 里，
           下次展开由 ensureRecordBody() 一并带出），只更新标题栏状态标记 */
        if (bodyEl.dataset.bodyBuilt === '1' && !bodyEl.querySelector(`.rmsg-item[data-record="${idx}"][data-msg="${replyMsgIdx}"]`)) {
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

/* 生成消息列表的去重指纹：拼接每条消息的 role + content，用于判断两条记录是否内容相同 */
function computeMessagesFingerprint(messages) {
    if (!messages || messages.length === 0) return '';
    /* 只用前 50 条 + 每条前 500 字符做指纹，避免超大消息拖慢性能 */
    return messages.slice(0, 50).map(m => {
        const role = m.role || '';
        const content = typeof m.content === 'string' ? m.content.slice(0, 500) : '';
        return `${role}:${content}`;
    }).join('|');
}

/* 当前普通记录（未置顶）列表 */
function getNormalRecords() {
    return records.filter(r => !r.pinned);
}

/* 裁剪超出普通记录上限的最旧普通记录（从数组末尾向前找并删除，保持 records 原顺序）。
   置顶记录跳过、不计入上限（因此 records.length 可能大于 MAX_RECORDS）；被删除记录若有在途回复则取消追踪。 */
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

function addRecord(characterName, messages, source, modelName, rawBody, captureId, options = {}) {
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
        /* 来源判定在拦截时完成、建档要等 token 计算，两步之间本轮状态可能已变，
           故建档前对「位置证据」做一次最终确认（见 finalizePositionEvidenceSource） */
        source: finalizePositionEvidenceSource(source)
            || { type: 'plugin', label: '插件', detail: SOURCE_PLUGIN_DEFAULT_DETAIL },
        modelName: modelName || '未知模型',
        messages,
        rawBody: rawBody || null,   /* 原始请求体 JSON 对象（「查看全文」原始格式用） */
        collapsed: true,
        pinned: false,                /* 临时置顶标记：不占用普通记录上限，刷新即重置 */
        id: captureId != null ? captureId : null, /* 请求捕获编号，回复挂载用 */
        reply: null,                 /* 回复内容（独立存储，不计入请求消息/查看全文） */
    };

    /* 模拟记录：没有真实回复，直接在标题栏标一个 simulated 状态标签 */
    if (options.simulated) record.simulated = true;

    /* 回复可能先于记录建成而到达（finalize 时记录尚未创建）：仅当回复已终态时才立即挂载，
       并交给 addRecord 后续的渲染路径展示（skipRender=true 避免重复渲染）；
       仍在途的条目保留在待办区，由 finalizeReply 稍后挂载 */
    if (captureId != null) {
        const replyData = consumePendingReply(captureId);
        if (replyData) attachReplyToRecord(record, replyData, true);
    }

    /* 引导期间：新记录只暂存、不加入列表渲染（避免打断引导步骤的 DOM 定位），
       引导结束后由 endTour 合并恢复；同样受最大记录数上限约束 */
    if (tourActive) {
        tourPendingRecords.unshift(record);
        if (tourPendingRecords.length > MAX_RECORDS) {
            const evicted = tourPendingRecords.pop();
            if (evicted && evicted.id != null) abortPendingReply(evicted.id);
        }
        return record;
    }

    /* 筛选生效时先判断新记录是否可见：
       不可见则保持当前阅读位置（不折叠已有记录、不回顶、不闪烁），仅正常入列刷新计数 */
    const filterActive = isFilterActive();
    const newRecordVisible = filterActive ? matchesFilter(record) : true;

    /* 新记录到达时折叠所有已有记录（只折叠记录本身，不动各记录内部消息的折叠状态）；
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
    /* 面板未处于「完全展开可见」状态时（窗口折叠/完全关闭）留待恢复显示后回顶
       （见 togglePanelWindow / showPanel）；新记录被筛选隐藏时也不置位，恢复后保持原位置 */
    if (!(panelEl && isPanelVisible && !isPanelCollapsed) && (!filterActive || newRecordVisible)) {
        pendingScrollToTop = true;
    }

    /* 返回记录对象：模拟捕获要在建档当刻兑现完成信号；跳过建档（去重 / 总开关等）时返回 undefined */
    return record;
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
    
    /* hook 始终安装（内部按 masterEnabled 判断是否记录），不随开关装卸，避免破坏其他插件的 wrapper 链 */
}

function updateMasterToggleUI() {
    if (!panelEl) return;
    
    const btn = panelEl.querySelector('#rlog-master-toggle');
    if (btn) {
        if (masterEnabled) {
            btn.classList.add('rlog-master-on');
            btn.classList.remove('rlog-master-off');
            btn.style.color = '#4caf50'; /* 总开关开启时图标颜色（内联覆盖 CSS 的 .rlog-master-on） */
            btn.querySelector('i').className = 'fa-solid fa-power-off';
            btn.title = '插件开启-自动记录中';
        } else {
            btn.classList.add('rlog-master-off');
            btn.classList.remove('rlog-master-on');
            btn.style.color = '#999'; /* 总开关关闭时图标颜色（内联覆盖 CSS 的 .rlog-master-off） */
            btn.querySelector('i').className = 'fa-solid fa-power-off';
            btn.title = '插件关闭-已停止记录';
        }
    }

    if (!masterEnabled) {
        panelEl.classList.add('rlog-disabled');
    } else {
        panelEl.classList.remove('rlog-disabled');
    }
}

/* 从 localStorage 加载内容预览开关状态（默认关闭）
   @returns {boolean} 是否开启内容预览 */
function loadContentPreview() {
    try { return localStorage.getItem(STORAGE_PREVIEW_KEY) === '1'; } catch (e) { return false; }
}

function saveContentPreview(enabled) {
    try { localStorage.setItem(STORAGE_PREVIEW_KEY, enabled ? '1' : '0'); } catch (e) { /* ignore */ }
}

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

/* 更新标题栏预览开关按钮的外观（开启 fa-eye / 关闭 fa-eye-slash） */
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

/* ── 偏好设置（持久化 + 图标态） ─────────────── */

/* 偏好设置键 → localStorage 存储键 映射 */
const PREF_STORAGE_KEYS = {
    badgeDefault: STORAGE_PREF_BADGE_DEFAULT,
    followStTheme: STORAGE_PREF_FOLLOW_ST_THEME,
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
    return preferences.badgeDefault || preferences.followStTheme || preferences.mobileFull
        || preferences.clickOutside || preferences.filterPersist || preferences.minimal;
}

/* 更新「偏好设置」入口图标：任意偏好激活 → fa-heart-circle-check，全部关闭 → fa-heart */
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

/* 设置某个偏好：更新状态 + 持久化 + 刷新图标态与开关视觉 */
function setPreference(key, value) {
    if (!(key in preferences)) return;
    preferences[key] = !!value;
    savePreference(key, preferences[key]);
    updatePrefButtonIcon();
    syncPrefToggleUI();
    /* 偏好开关的即时行为：多数开关只被对应逻辑读取标志，个别需要立即生效的按 key 处理 */
    if (key === 'mobileFull') updateMobileFullscreenClass();
    if (key === 'filterPersist' && preferences.filterPersist) saveFilterState();
    if (key === 'minimal') updateMinimalClass();
    if (key === 'followStTheme') setPreferenceFollowStThemeBehavior();
    if (key === 'badgeDefault') setPreferenceBadgeDefaultBehavior();
}

/* 「昼夜模式跟随 ST 主题」切换后的即时行为：开启→挂 ST 主题监听并立即同步（面板已打开时按
   现有昼/夜动画切换）；关闭→把当前主题落盘一次（记住它），此后 ST 变化不再影响面板。 */
function setPreferenceFollowStThemeBehavior() {
    if (preferences.followStTheme) {
        initPanelThemeFollow(true);
    } else {
        saveTheme(isLightTheme);
    }
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
    const active = isMobileFullActive();
    const changed = panelEl.classList.contains('rlog-mobile-fullscreen') !== active;
    panelEl.classList.toggle('rlog-mobile-fullscreen', active);
    /* 面板尺寸变了 → 正文换行宽度可能变化：跑一次带宽维护（宽度一旦变化它会先全量恢复再重新卸载） */
    if (changed) scheduleBodyBandPass(panelEl.querySelector('#rlog-list'));
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

/* 关闭偏好设置浮层（唯一关闭方式是右上角 ×）。
   遮罩点击不触发关闭；「点击面板外关闭」偏好针对的是整个插件主面板，与浮层无关。 */
function closePrefPanel() {
    if (!prefOverlayEl) return;
    prefOverlayEl.classList.remove('rlog-pref-open');
}

/* 更新偏好列表滚动提示箭头：仅内容真需要滚动时显示对应方向箭头，只作提示、不参与交互
   （依赖 buildUI 绑定的 scroll 事件与 openPrefPanel 的首帧更新）。 */
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
    /* 主题类同步到影子宿主：影子内的弹窗靠宿主上的 .rlog-light 切亮暗（跨影子边界继承）；
       浮标是独立宿主、配色反向跟随 ST 主题，由 syncBadgeTheme() 单独处理。 */
    if (shadowHostEl) {
        if (isLightTheme) shadowHostEl.classList.add('rlog-light');
        else shadowHostEl.classList.remove('rlog-light');
    }
}

/* 把面板主题同步到 ST 当前主题（同向；浮标反向取色属另一套逻辑）。复用现有机制：
   isStThemeDark() 取信号、applyTheme() 切面板与影子宿主主题类、updateThemeButtonIcon() 刷图标。
   @param {boolean} animate 主题确实变化时是否播放切换动画（面板已打开且非极简才生效） */
function syncPanelThemeToSt(animate) {
    if (!preferences.followStTheme) return;
    const isLight = !isStThemeDark();
    /* 状态与 DOM 类都已一致就跳过（多一道类检查：宿主重建后也能自愈） */
    if (isLight === isLightTheme && (!panelEl || panelEl.classList.contains('rlog-light') === isLight)) return;
    isLightTheme = isLight;
    /* 跟随时不写主题存储：「记住当前主题」只在关闭开关那一下执行一次 */
    applyTheme();
    updateThemeButtonIcon();
    if (animate && isPanelVisible) playThemeSwitchAnimation();
}

/* 初始化「昼夜模式跟随 ST 主题」：先静默同步一次，再挂 <html> style 属性监听（与浮标同一挂点，
   ST 没有主题变化事件）；挂点将来失效只表现为不再自动跟随。观察者只挂一次。
   @param {boolean} animate 首次同步是否允许播动画（初始化传 false） */
function initPanelThemeFollow(animate) {
    if (!preferences.followStTheme) return;
    syncPanelThemeToSt(animate);
    if (panelThemeObserver) return;
    panelThemeObserver = new MutationObserver(() => syncPanelThemeToSt(true));
    panelThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
}

/* 从 localStorage 加载用户设定的最大记录数（无保存值或值非法时返回默认值） */
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

function saveMaxRecords(value) {
    try {
        localStorage.setItem(STORAGE_MAX_RECORDS_KEY, String(value));
    } catch (e) { /* ignore */ }
}

/* 设置新的最大记录数上限：更新全局变量、持久化、裁剪超出上限的记录、刷新标题栏显示
   @param {number} newMax 新的上限值 */
function setMaxRecords(newMax) {
    if (typeof newMax !== 'number' || isNaN(newMax) || newMax < MIN_MAX_RECORDS || newMax > MAX_MAX_RECORDS) {
        return false;
    }
    MAX_RECORDS = newMax;
    saveMaxRecords(MAX_RECORDS);

    /* 如果当前普通记录数超过新上限，裁剪掉最旧的普通记录；置顶记录不受影响 */
    pruneNormalRecords();

    updateHeaderTitle();
    panelContentDirty = true;

    if (panelEl && isPanelVisible) {
        renderPanelContent();
    }

    return true;
}

/* ── 通用弹窗 ─────────────────────────── */

/* 创建并显示设置最大记录数的对话框（双击标题栏文字时触发） */
function showMaxRecordsDialog() {
    if (maxRecordsDialog) {
        maxRecordsDialog.remove();
    }

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
        if (e.target === overlay) {
            closeMaxRecordsDialog();
        }
    });

    const dialog = document.createElement('div');
    dialog.className = 'rlog-dialog';

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

    dialog.querySelector('.rlog-dialog-close').addEventListener('click', closeMaxRecordsDialog);

    dialog.querySelector('#rlog-dialog-confirm').addEventListener('click', () => {
        const input = dialog.querySelector('#rlog-max-records-input');
        const rawValue = parseInt(input.value, 10);
        if (!isNaN(rawValue)) {
            const clamped = Math.max(MIN_MAX_RECORDS, Math.min(MAX_MAX_RECORDS, rawValue));
            setMaxRecords(clamped);
        }
        closeMaxRecordsDialog();
    });

    dialog.querySelector('#rlog-max-records-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            dialog.querySelector('#rlog-dialog-confirm').click();
        } else if (e.key === 'Escape') {
            closeMaxRecordsDialog();
        }
    });

    setTimeout(() => {
        const input = dialog.querySelector('#rlog-max-records-input');
        if (input) {
            input.focus();
            input.select();
        }
    }, 100);
}

function closeMaxRecordsDialog() {
    if (maxRecordsDialog) {
        maxRecordsDialog.remove();
        maxRecordsDialog = null;
    }
}

/* HTMLElement|null: 当前确认弹窗的 DOM 元素 */
let confirmDialogEl = null;

/* 通用确认弹窗（清空记录、删除单条等破坏性操作）
   @param {object} options { title=确认操作, message=, confirmText=确认, cancelText=取消,
   onConfirm, onCancel } */
function showConfirmDialog(options) {
    const {
        title = '确认操作',
        message = '',
        confirmText = '确认',
        cancelText = '取消',
        onConfirm = null,
        onCancel = null,
    } = options || {};

    closeConfirmDialog();

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
        if (e.target === overlay) {
            closeConfirmDialog();
            if (typeof onCancel === 'function') onCancel();
        }
    });

    const dialog = document.createElement('div');
    dialog.className = 'rlog-dialog rlog-confirm-dialog';

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

    dialog.querySelector('.rlog-dialog-close').addEventListener('click', () => {
        closeConfirmDialog();
        if (typeof onCancel === 'function') onCancel();
    });

    dialog.querySelector('#rlog-confirm-cancel').addEventListener('click', () => {
        closeConfirmDialog();
        if (typeof onCancel === 'function') onCancel();
    });

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

function closeConfirmDialog() {
    if (confirmDialogEl) {
        confirmDialogEl.remove();
        confirmDialogEl = null;
    }
}

/* ── 搜索 ───────────────────────────── */

/* 重置当前搜索状态（搜索框关闭、关键词清空、高亮清除、命中序号重置），用于所有需要退出搜索模式的场景。
   不依赖搜索框 UI 是否已构建，DOM 中存在才操作。 */
function resetSearchIfActive() {
    if (searchDebounceTimer !== null) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
    }

    /* 清除所有高亮标记 */
    if (searchState) {
        const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
        if (listEl) restoreSearchHighlights(listEl);

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
                const toggleIcon = recordEl.querySelector('.rlog-toggle-icon');
                if (toggleIcon) toggleIcon.style.visibility = '';
            }
        }

        searchState = null;
    }

    /* 搜索框被移除时若仍处于聚焦态，blur 不保证触发：兜底解除面板高度冻结 */
    unfreezePanelForSearchKeyboard();
}

/* Set<string>: \s 等价的空白字符集合（避免循环内逐字符正则开销） */
const WHITESPACE_CHARS = new Set([' ', '\t', '\n', '\r', '\f', '\v', '\u00a0', '\u1680',
    '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007',
    '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff']);

/* 搜索用文本归一化：空白连续序列折叠为单个空格，并返回「归一化字符 → 原始索引」映射。
   目的是让内容里的换行/空白与关键词里的空格等价——从外部复制的多段文本常把换行转成空格。
   @param {string} text @returns {{normalized, map}} */
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
        } else {
            normalized += ch;
            map.push(i);
            lastWasSpace = false;
        }
    }
    return { normalized, map };
}

/* 在指定记录的所有消息中查找匹配（纯字符串扫描、不碰 DOM，长文本下性能稳定）。双方都做归一化，
   跨换行/复制进来的空格也能匹配；返回的 start/end 是原始内容偏移，可直接用于高亮。
   @param {number} recordIndex @param {string} keyword @returns {Array<{msgIdx,start,end}>} */
function findMatchesInRecord(recordIndex, keyword) {
    const record = records[recordIndex];
    if (!record || !record.messages || !keyword) return [];

    const normalizedKeyword = keyword.replace(/\s+/g, ' ').trim();
    if (!normalizedKeyword) return [];
    const lowerKeyword = normalizedKeyword.toLowerCase();
    /* 关键词不含空白字符时（绝大多数搜索）归一化不会改变匹配结果——归一化只折叠空白、
       不改动非空白字符的相对顺序，故可直接在「页面实际文字」上扫描，
       省掉每条消息的归一化文本与索引映射构造（长记录下这一项可达十几毫秒/次输入） */
    const plainScan = normalizedKeyword.indexOf(' ') === -1;

    const matches = [];

    record.messages.forEach((msg, msgIdx) => {
        /* 角色筛选隐藏的子消息不参与搜索：内容不在 DOM 中，导航高亮无法定位 */
        if (!isMessageVisible(msg)) return;
        addContentMatches(msg.content, msgIdx, normalizedKeyword, lowerKeyword, matches, plainScan);
    });
    /* 回复作为最后一条伪消息参与搜索（msgIdx = messages.length） */
    if (record.reply && isMessageVisible(record.reply)) {
        addContentMatches(record.reply.content, record.messages.length, normalizedKeyword, lowerKeyword, matches, plainScan);
    }

    return matches;
}

/* 把消息原文换算成「页面显示文字」：渲染走 <pre>，解析器会做两件事，这里逐条对齐
   （任一项漏掉，关键词落点就会整体漂移）——① \r\n / \r → \n；② 丢弃 NUL。
   开头第一个换行由 buildMessageHtml 在 <pre> 后垫一个换行抵消，此处不再处理。
   @param {string} content @returns {string} */
function toRenderedText(content) {
    return content.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
}

/* 在单条消息/回复内容中收集关键词匹配（偏移基于 toRenderedText，与页面文字同源）
   @param {string} content @param {number} msgIdx @param {string} normalizedKeyword
   @param {string} lowerKeyword @param {Array} matches
   @param {boolean} [plainScan=false] 关键词不含空白时走快速路径：不建归一化文本与索引映射 */
function addContentMatches(content, msgIdx, normalizedKeyword, lowerKeyword, matches, plainScan = false) {
    if (typeof content !== 'string' || !content) return;

    if (plainScan) {
        const rendered = toRenderedText(content);
        const lowerContent = rendered.toLowerCase();
        let pos = 0;
        let count = 0;
        while (pos <= lowerContent.length && count < 5000) {
            const idx = lowerContent.indexOf(lowerKeyword, pos);
            if (idx === -1) break;
            matches.push({ msgIdx, start: idx, end: idx + normalizedKeyword.length });
            pos = idx + normalizedKeyword.length;
            count++;
        }
        return;
    }

    const { normalized, map } = normalizeTextWithMap(toRenderedText(content));
    const lowerContent = normalized.toLowerCase();

    let pos = 0;
    /* 归一化内容中没有关键词则跳过该消息 */
    const firstIdx = lowerContent.indexOf(lowerKeyword);
    if (firstIdx === -1) return;

    /* 遍历所有出现位置（最多保护 5000 处，防止极端重复文本拖慢） */
    let count = 0;
    while (pos <= normalized.length && count < 5000) {
        const idx = lowerContent.indexOf(lowerKeyword, pos);
        if (idx === -1) break;
        /* 把归一化文本里的匹配偏移还原为页面文字偏移（可直接用于高亮） */
        const origStart = map[idx];
        const normEnd = idx + normalizedKeyword.length;
        const origEnd = map[normEnd - 1] + 1;
        matches.push({ msgIdx, start: origStart, end: origEnd });
        pos = idx + normalizedKeyword.length;
        count++;
    }
}

/* 把当前所有搜索高亮还原为纯文本：只对「确实含 mark 的消息」整体重设一次 textContent。
   逐个拆 mark（replaceChild + normalize）在命中多时很贵（实测 2000 处约 478ms、10460 处约 20.7s），
   整体重设等价且是每消息一次赋值；文本基准与高亮共用 toRenderedText，与页面文字逐字一致。
   @param {HTMLElement} listEl */
function restoreSearchHighlights(listEl) {
    if (!listEl) return;
    const markedItems = new Set();
    listEl.querySelectorAll('mark.rlog-search-mark, mark.rlog-search-mark-current').forEach((mark) => {
        const item = mark.closest('.rmsg-item');
        if (item) markedItems.add(item);
    });
    markedItems.forEach((item) => {
        const msg = getMessageByIndex(records[Number(item.dataset.record)], Number(item.dataset.msg));
        const contentEl = item.querySelector('.rmsg-content');
        if (msg && contentEl) contentEl.textContent = toRenderedText(msg.content);
    });
}

/* 清除所有搜索高亮 <mark>（普通黄色匹配 + 当前橙色命中），恢复纯文本内容区 */
function clearSearchHighlights() {
    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    if (!listEl) return;
    restoreSearchHighlights(listEl);
}

/* 把当前命中的橙色高亮降级为黄色（只换类名、不删 mark），供导航复用已绘制的高亮避免全量重绘；
   降级时记录 matchIdx，便于跳回时定位。@param {number} [oldMatchIdx] */
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

/* 把消息内容中 [start, end) 的文本包成 <mark>（TreeWalker 精确定位偏移）
   @param {HTMLElement} contentEl @param {number} start @param {number} end
   @param {string} [className=rlog-search-mark-current] @returns {HTMLElement|null} */
function highlightRange(contentEl, start, end, className = 'rlog-search-mark-current') {
    if (!contentEl || start < 0 || end <= start) return null;

    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
    let currentOffset = 0;
    let node = null;

    while ((node = walker.nextNode())) {
        const nodeLen = node.textContent.length;
        if (currentOffset + nodeLen > start) break;
        currentOffset += nodeLen;
    }
    if (!node) return null;

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

/* 高亮本条记录内所有匹配（黄色，不含当前命中——它由 applyCurrentMatch 画橙色）。
   每条消息一次性构造「文本节点 + <mark>」片段并整体替换内容区子节点：
   逐处 Range.surroundContents 是在同一文本块里反复切开，代价随该块内命中数超线性增长
   （实测单块 420 处时最后 60 处比最初 60 处贵十几倍），而一次性构造是线性的、
   产出 DOM 与逐处包裹等价（同样的 mark 类名与 data-match-idx，文字用 textContent 写入无需转义）。
   @param {HTMLElement} recordEl @param {number} recordIndex */
function highlightAllMatches(recordEl, recordIndex) {
    if (!searchState || !recordEl) return;
    const record = records[recordIndex];
    if (!record) return;
    /* 折叠记录的正文还未生成，高亮落点要在补建后的子树里找 */
    ensureRecordBody(recordEl);

    /* 按消息分组（跳过当前命中，橙色单独绘制），并保留匹配在 matches 中的下标供 mark 记录 */
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
        const contentEl = ensureMessageContent(recordEl.querySelector(`.rmsg-item[data-msg="${msgIdx}"]`));
        if (!contentEl) return;

        /* 同一消息内按 start 升序拼片段：文本节点与 mark 元素交替，末尾补剩余文本 */
        const text = toRenderedText(msg.content);
        const sorted = msgMatches.slice().sort((a, b) => a.match.start - b.match.start);
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        sorted.forEach(({ match, idx }) => {
            if (match.start > cursor) {
                fragment.appendChild(document.createTextNode(text.slice(cursor, match.start)));
            }
            const markEl = document.createElement('mark');
            markEl.className = 'rlog-search-mark';
            /* 记录匹配下标，供 removeYellowMarkByMatchIdx 定位黄色 mark */
            markEl.dataset.matchIdx = String(idx);
            markEl.textContent = text.slice(match.start, match.end);
            fragment.appendChild(markEl);
            cursor = match.end;
        });
        if (cursor < text.length) {
            fragment.appendChild(document.createTextNode(text.slice(cursor)));
        }
        contentEl.replaceChildren(fragment);
        /* 文字与高度都没变，但内容区被整体替换过，顺手刷一次该消息的滚动条拇指（无进度条时为空操作） */
        requestThumbUpdate(contentEl);
    });
}

/* 返回当前应使用的滚动行为：极简模式用 'auto' 直接跳转，否则 'smooth' 平滑。 */
function getScrollBehavior() {
    return preferences.minimal ? 'auto' : 'smooth';
}

/* 把当前命中滚到舒适位置：先滚 .rmsg-content 内部，再算 .rlog-list 的 scrollTop 让消息落在
   吸顶标题栏下方。不用 scrollIntoView——它会递归滚动所有可滚动祖先，移动端会连带滚动 ST 主界面。
   @param {HTMLElement} markEl @param {HTMLElement} contentEl */
function scrollToMatch(markEl, contentEl) {
    if (!markEl || !contentEl) return;

    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    if (!listEl) return;

    const contentRect = contentEl.getBoundingClientRect();
    const markRect = markEl.getBoundingClientRect();
    const contentScrollTop = contentEl.scrollTop;
    const relativeTop = markRect.top - contentRect.top + contentScrollTop;
    const targetScroll = relativeTop - contentRect.height * 0.25;
    /* 上下都要夹到内容区真实可滚范围：命中靠近长消息末尾时浏览器会把下面的超界值夹回
       maxScroll，若这里不先夹，下面按 delta 推算的「命中最终位置」就会偏大，
       外层列表据此定位会把命中留在偏下的位置（实测最多偏数百像素） */
    const maxContentScroll = Math.max(0, contentEl.scrollHeight - contentEl.clientHeight);
    const clampedContentScroll = Math.max(0, Math.min(targetScroll, maxContentScroll));
    contentEl.scrollTo({ top: clampedContentScroll, behavior: getScrollBehavior() });

    /* 外层列表滚动手动定位：内层滚动尚未完成，但 mark 的最终视觉位置可由滚动增量推算
       （markRect.top - delta），期望它落在两级吸顶标题栏下方、剩余可视区约 1/3 处 */
    const delta = clampedContentScroll - contentScrollTop;
    const markFinalTop = markRect.top - delta;
    const listRect = listEl.getBoundingClientRect();

    /* 累加两个 sticky 标题栏（.rlog-record-header / .rmsg-header）的 offsetHeight 而非固定值，
       以自动兼容桌面/移动端不同高度与移动端标题栏换行变高。注意不能用 getBoundingClientRect().bottom：
       mark 所在消息不在视口内时 header 并未吸顶，bottom 会远在视口外，导致目标 scrollTop 被夹到 0。 */
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
    const visibleHeight = Math.max(0, listEl.clientHeight - stickyHeight);
    const targetListScroll = markInList - stickyHeight - visibleHeight * 0.33;

    /* 夹到合法滚动范围（避免浏览器静默夹取导致意外跳变） */
    const maxListScroll = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
    /* 下界：记录顶边在列表里的逻辑位置。低于它，记录顶边会露到列表上方、标题栏随之从吸顶位置
       掉下来；命中位置不足以满足标准落点时优先保证记录标题栏不动，允许高亮停在更靠下的位置 */
    const recordTopInList = recordEl
        ? listEl.scrollTop + recordEl.getBoundingClientRect().top - listRect.top
        : 0;
    const minListScroll = Math.max(0, Math.min(recordTopInList, maxListScroll));
    const clampedListScroll = Math.max(minListScroll, Math.min(targetListScroll, maxListScroll));

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

    /* 有关键词但无命中：计数转红 */
    counter.classList.toggle('rlog-search-count-empty', !!searchState.keyword && total === 0);

    /* 无结果或仅一个结果时禁用上下箭头 */
    const prevBtn = searchState.searchEl.querySelector('.rlog-search-prev');
    const nextBtn = searchState.searchEl.querySelector('.rlog-search-next');
    if (prevBtn) prevBtn.disabled = total <= 1;
    if (nextBtn) nextBtn.disabled = total <= 1;
}

/* 在指定消息处执行搜索并高亮当前命中 + 滚动到该位置
   @param {number} msgIdx @param {number} matchIdx
   @param {boolean} [redrawYellowHighlights=true] 搜索词变化传 true（清掉全部高亮重绘）；
   上下键导航传 false（只清当前橙色命中，复用已绘制的黄色高亮） */
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
        /* 搜索词变化：清除全部高亮后重新绘制 */
        clearSearchHighlights();

        if (record.collapsed) {
            record.collapsed = false;
            recordEl.classList.add('expanded');
            recordEl.classList.remove('collapsed');
        }

        /* 高亮本条内所有匹配（黄色，跳过当前命中；同时展开匹配到的折叠消息） */
        highlightAllMatches(recordEl, recordIndex);
    } else {
        /* 导航跳转：把旧橙色命中降级为黄色，复用已绘制的 mark，避免全量重绘 */
        const oldIdx = searchState.currentIdx;
        clearCurrentHighlight(oldIdx);

        /* 必须先删目标位置残留的黄色 mark，否则画新橙色时 DOM 偏移计算会失效 */
        removeYellowMarkByMatchIdx(matchIdx);

        if (record.collapsed) {
            record.collapsed = false;
            recordEl.classList.add('expanded');
            recordEl.classList.remove('collapsed');
        }
    }

    /* 折叠记录 / 折叠消息的内容都不可见、无法定位，先按需补建再展开 */
    ensureRecordBody(recordEl);
    if (msg.collapsed) {
        msg.collapsed = false;
        const msgItem = recordEl.querySelector(`.rmsg-item[data-msg="${msgIdx}"]`);
        if (msgItem) {
            msgItem.classList.add('expanded');
            msgItem.classList.remove('collapsed');
        }
    }

    const contentEl = ensureMessageContent(recordEl.querySelector(`.rmsg-item[data-msg="${msgIdx}"]`));
    if (!contentEl) return;

    /* 异步创建滚动条（消息刚展开，需要等布局稳定） */
    setTimeout(() => createScrollbarForContent(contentEl), SCROLLBAR_CREATE_DELAY_MS);

    const match = searchState.matches[matchIdx];
    if (!match) return;

    const markEl = highlightRange(contentEl, match.start, match.end, 'rlog-search-mark-current');

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

function closeSearch() {
    resetSearchIfActive();
}

/* 为指定记录打开搜索模式（排他原则：一次仅一条记录处于搜索状态）
   @param {number} recordIndex 记录索引 */
function openSearchForRecord(recordIndex) {
    if (!panelEl) return;
    /* 排他：先关闭任何已有的搜索 */
    resetSearchIfActive();

    const listEl = panelEl.querySelector('#rlog-list');
    const recordEl = listEl.querySelector(`.rlog-record[data-record-index="${recordIndex}"]`);
    if (!recordEl) return;

    const actionsEl = recordEl.querySelector('.rlog-record-actions');
    const actionsInner = recordEl.querySelector('.rlog-record-actions-inner');
    if (!actionsEl || !actionsInner) return;

    /* 标记「搜索中」：CSS 隐藏除放大镜外的其他按钮与下箭头，把空间释放给向右展开的搜索框 */
    recordEl.classList.add('rlog-searching');

    /* 隐藏折叠/展开箭头（▾）：用 visibility 保留占位、配合 CSS 固定 actions-inner 宽度，
       保证放大镜位置不被推移 */
    const toggleIcon = recordEl.querySelector('.rlog-toggle-icon');
    if (toggleIcon) toggleIcon.style.visibility = 'hidden';

    /* 折叠记录自动展开（搜索高亮需要可见内容区） */
    const record = records[recordIndex];
    if (record && record.collapsed) {
        record.collapsed = false;
        recordEl.classList.add('expanded');
        recordEl.classList.remove('collapsed');
        ensureRecordBody(recordEl);
        /* 展开后为消息内容区懒创建进度条（仅视口内立即创建，其余延迟） */
        queueScrollbarsForEls(recordEl.querySelectorAll('.rmsg-content'));
    }

    /* 构建搜索框 DOM：放大镜按钮保持原位作视觉锚点，搜索框在其右侧展开 */
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

    const searchBtn = actionsInner.querySelector('.rlog-search-btn');
    if (searchBtn) {
        searchBtn.insertAdjacentElement('afterend', searchBox);
    } else {
        actionsInner.appendChild(searchBox);
    }

    searchState = {
        recordIndex,
        keyword: '',
        matches: [],
        currentIdx: -1,
        searchEl: searchBox,
    };

    const input = searchBox.querySelector('.rlog-search-input');
    const prevBtn = searchBox.querySelector('.rlog-search-prev');
    const nextBtn = searchBox.querySelector('.rlog-search-next');

    /* 移动端：聚焦期间冻结面板高度，避免虚拟键盘顶起/收起时面板跟着变高变矮引发卡顿
       （只钉高度、不改其它尺寸来源；失焦即还原并补跑一次视口同步） */
    input.addEventListener('focus', () => freezePanelForSearchKeyboard(input));
    input.addEventListener('blur', () => unfreezePanelForSearchKeyboard());

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

    /* 输入法组合期间跳过 input 事件 */
    input.addEventListener('compositionstart', () => { isComposing = true; });
    /* 组合结束（文字已上屏）：补一次搜索（组合期间可能错过了 input） */
    input.addEventListener('compositionend', () => {
        isComposing = false;
        scheduleSearch();
    });

    /* 输入实时搜索（防抖） */
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

/* 子消息（含回复伪消息）是否通过角色筛选：角色筛选按消息逐条判定，不直接决定整条记录 */
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

/* 把当前筛选状态持久化到 localStorage（仅当「筛选状态持久化」开关开启时调用） */
function saveFilterState() {
    try { localStorage.setItem(STORAGE_FILTER_STATE_KEY, JSON.stringify(filterState)); } catch (e) { /* 忽略异常 */ }
}

/* 清洗从 localStorage 读回的筛选状态：以默认全开为基准，逐分组逐键只采纳布尔值，其余回退 true */
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

/* 加载持久化的筛选状态并覆盖当前 filterState（仅当「筛选状态持久化」开关开启时读取）；
   无值 / 解析失败 / 数据非法一律回退默认全开。 */
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

/* 更新标题旁「N隐藏」指示器（只显示被筛选隐藏的记录数）与筛选按钮激活圆点
   @param {Array} [visibleRecords] 已算好的可见记录（renderPanelContent 已算过一份，传进来避免重复遍历） */
function updateFilterIndicator(visibleRecords) {
    if (!panelEl) return;
    const active = isFilterActive();
    const indicator = panelEl.querySelector('#rlog-filter-indicator');
    if (indicator) {
        /* 只展示因筛选被隐藏的记录数；没有隐藏时隐藏指示器，只留按钮圆点 */
        const hiddenCount = records.length - (visibleRecords || getVisibleRecords()).length;
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
    /* 「筛选状态持久化」开启时立即落盘 */
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

/* 来源标记的实时更新（来源修正 / E3 位置证据作废后调用）：
   筛选归属不变 → 定点更新该条记录的来源标记与徽标；筛选归属改变 → 整表重绘并刷新指示器与计数；
   面板不可见 / 引导进行中 → 只置脏标记，下次渲染带上。
   @param {object} record 目标记录 @param {string} prevSourceType 变更前的来源类型 */
function refreshRecordSourceDom(record, prevSourceType) {
    panelContentDirty = true;
    if (!record) return;

    const newType = (record.source && record.source.type === 'native') ? 'native' : 'plugin';
    const membershipChanged = isFilterActive() && !!prevSourceType && prevSourceType !== newType
        && !filterState.source[newType];
    if (membershipChanged) {
        if (panelEl && isPanelVisible && !tourActive) renderPanelContent();
        return;
    }
    if (!panelEl || !isPanelVisible || tourActive) return;

    const idx = records.indexOf(record);
    const listEl = idx >= 0 ? panelEl.querySelector('#rlog-list') : null;
    const recordEl = listEl ? listEl.querySelector(`.rlog-record[data-record-index="${idx}"]`) : null;
    if (!recordEl) {
        /* 记录不在 DOM（被角色 / 模型筛选隐藏、或还在引导暂存队列）：只需刷新指示器与计数 */
        updateFilterIndicator();
        return;
    }

    recordEl.setAttribute('data-source', newType);
    const badge = recordEl.querySelector('.rlog-source-badge');
    if (badge) {
        badge.className = `rlog-source-badge ${getSourceClass(record.source)}`;
        badge.title = (record.source && record.source.detail) || getSourceLabel(record.source);
        badge.innerHTML = `<span class="rlog-status-dot"></span>${escapeHtml(getSourceLabel(record.source))}`;
    }
    updateFilterIndicator();
}

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
    /* 折叠消息不生成正文：正文要留到展开时由 ensureMessageContent() 补建，否则每次整表重建
       都要把全部记录（含折叠部分）的提示词正文重新拼串并解析一遍。
       <pre> 后垫一个换行：解析器吞掉的是它，正文（含开头空行）原样显示 */
    const contentHtml = msg.collapsed ? '' : `<pre class="rmsg-content">\n${escapeHtml(msg.content)}</pre>`;
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
            ${contentHtml}
        </div>
    `;
}

/* 记录正文（可见子消息 + 回复）的 HTML 拼装：整表渲染与折叠记录的按需补建共用。
   角色筛选按子消息逐条过滤：只拼可见子消息，data-msg 仍写真实索引；
   回复作为最后一条伪消息（data-msg = messages.length），与其他子消息同形态。
   @param {object} rec @param {number} idx @returns {string} */
function buildRecordMessagesHtml(rec, idx) {
    return rec.messages
        .map((msg, mIdx) => ({ msg, mIdx }))
        .filter(({ msg }) => isMessageVisible(msg))
        .map(({ msg, mIdx }) => buildMessageHtml(msg, idx, mIdx))
        .join('')
        + (rec.reply && isMessageVisible(rec.reply)
            ? buildMessageHtml(rec.reply, idx, rec.messages.length)
            : '');
}

/* 折叠记录只出标题栏，正文（子消息标题 + 正文）留到展开时按需补建；已建过的直接复用。
   凡需要正文 DOM 的路径（展开记录、搜索与高亮、展开/折叠所有消息、快速置底）都要先过这里。
   离屏卸载过的记录：元素与标题栏都还在，只有正文文字被清空，此时按 needText 决定是否先补回来——
   只要元素与几何的路径（折叠本条所有消息、快速置底）传 false，避免白建整条正文。
   @param {HTMLElement} recordEl @param {boolean} [needText=true] @returns {HTMLElement|null} */
function ensureRecordBody(recordEl, needText = true) {
    if (!recordEl) return null;
    const bodyEl = recordEl.querySelector('.rlog-record-body');
    if (!bodyEl) return null;
    if (bodyEl.dataset.bodyBuilt !== '1') {
        const idx = Number(recordEl.dataset.recordIndex);
        const rec = records[idx];
        if (!rec) return bodyEl;
        bodyEl.innerHTML = buildRecordMessagesHtml(rec, idx);
        bodyEl.dataset.bodyBuilt = '1';
        bodyEl.querySelectorAll('.rmsg-item').forEach(bindMsgItemEvents);
    }
    /* 记录正文已建过、但其中有些消息正文被离屏卸载：本路径要读正文就先补回来 */
    if (needText) restoreRecordBodies(recordEl);
    return bodyEl;
}

/* 折叠消息只出标题栏，正文留到展开时按需补建。
   文本基准与整表渲染同源（走 toRenderedText），否则记录内搜索的偏移会与页面文字错位。
   离屏卸载过的正文元素还在（只是文字被清空、高度被锁定），必须先恢复再返回，
   否则「元素已存在」会被误判成正文已就绪，展开后得到一片空白。
   @param {HTMLElement} msgItem @returns {HTMLElement|null} */
function ensureMessageContent(msgItem) {
    if (!msgItem) return null;
    const existing = msgItem.querySelector('.rmsg-content');
    if (existing) {
        if (unloadedBodies.has(existing)) restoreBody(existing);
        return existing;
    }
    const msg = getMessageByIndex(records[Number(msgItem.dataset.record)], Number(msgItem.dataset.msg));
    if (!msg) return null;
    const pre = document.createElement('pre');
    pre.className = 'rmsg-content';
    pre.textContent = toRenderedText(msg.content);
    msgItem.appendChild(pre);
    return pre;
}

function renderPanelContent() {
    if (!panelEl) return;

    /* 重建 DOM 前必须先清理搜索状态（搜索高亮、搜索框引用旧 DOM 节点会失效） */
    resetSearchIfActive();

    const listEl = panelEl.querySelector('#rlog-list');
    if (!listEl) return;

    /* 可见记录只算一次：「N隐藏」指示器与下面渲染列表共用同一份（每条记录都要遍历子消息判角色筛选） */
    const visibleRecords = getVisibleRecords();
    updateHeaderTitle();
    updateFilterIndicator(visibleRecords);

    if (records.length === 0) {
        panelEl.classList.add('rlog-empty-list');
        const emptyMsg = masterEnabled 
            ? '暂无请求记录，请发送消息后查看。'
            : '记录功能已关闭，请点击电源图标开启。';
        listEl.innerHTML = `<div class="rlog-empty">${escapeHtml(emptyMsg)}</div>`;
        pruneDetachedUnloadedBodies();
        panelContentDirty = false;
        return;
    }
    panelEl.classList.remove('rlog-empty-list');

    /* 筛选后无可显示记录：专用空状态 + 一键重置（与「暂无记录」区分） */
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
        pruneDetachedUnloadedBodies();
        return;
    }

    /* 状态标签槽位宽度写入 CSS 变量：等待占位与到达后的标签共用，避免标题栏布局跳动 */
    const statusMaxW = getReplyStatusMaxWidth();
    if (statusMaxW > 0) {
        panelEl.style.setProperty('--rlog-status-w', `${statusMaxW}px`);
    }

    /* 只渲染可见记录；置顶记录先渲染、普通记录随后，子组内保持 records 原顺序（新→旧）。
       DOM 的 data-record-index 写入 records 中的真实索引而非显示位置，按索引取数的路径无需改语义 */
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

            const allPrecise = rec.messages.every(m => m.tokenPrecise === true);
            const recordTokenPrefix = allPrecise ? '' : '~';

            /* 折叠记录只出标题栏，整段正文留到展开时由 ensureRecordBody() 补建 */
            const messagesHtml = rec.collapsed ? '' : buildRecordMessagesHtml(rec, idx);

            /* 回复状态标记：仅折叠时显示在按钮组与折叠箭头之间；回复在途时先输出透明占位占住槽位，
               到达后由 appendReplyToRecordDom 原位替换为状态标签，窄屏下不换行移位 */
            const recordStatus = getRecordStatus(rec);
            const replyStatusHtml = recordStatus
                ? `<span class="rlog-reply-status rlog-reply-status-${recordStatus}" title="${escapeHtml(getReplyStatusTitle(rec))}">${getReplyStatusLabel(recordStatus)}</span>`
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
                    <div class="rlog-record-body" data-body-built="${rec.collapsed ? '0' : '1'}">
                        ${messagesHtml}
                    </div>
                </div>
            `;
        })
        .join('');

    bindListEvents(listEl);

    /* 把视口外的正文就地卸载（此刻列表已挂载、几何可测）：本次打开只需为可见部分付排版与绘制成本。
       放在 syncRecordHeaderVars 之前，随后的标题高度重测就落在「正文已卸载」的轻量版面上 */
    runBodyBandPass(listEl);
    pruneDetachedUnloadedBodies();

    /* 为每条记录写入 --rlog-rec-h（记录标题栏实测高度），供消息标题栏吸顶定位 */
    syncRecordHeaderVars(listEl);

    /* 为消息内容区创建 overlay 进度条 */
    attachScrollIndicators(listEl);

    /* 渲染完成，清除脏标记（下次打开面板时无需重建 DOM） */
    panelContentDirty = false;
}

/* 同步每条记录的 --rlog-rec-h = 记录标题栏实际高度：消息标题栏的 sticky top 必须等于它才能吸在
   记录标题栏正下方，而记录标题栏会因换行变高（窄屏可达 100px+），写死高度会被遮住。
   只在布局变化时写入，不参与逐帧滚动。
   所有高度一次性读完再统一写变量：写变量会使样式失效，读写交替会把每条记录的读取都变成一次强制布局。 */
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
    const measured = [];
    listEl.querySelectorAll('.rlog-record').forEach((recordEl) => {
        const headerEl = recordEl.querySelector('.rlog-record-header');
        if (!headerEl) return;
        /* 用 getBoundingClientRect().height（小数）而非 offsetHeight（取整）：
           换行高度常为小数，取整会在消息标题与记录标题之间留下亚像素缝隙 */
        measured.push([recordEl, headerEl.getBoundingClientRect().height]);
        /* 标题栏高度变化（换行/字体/视口变化）时自动刷新偏移 */
        if (!observedRecordHeaders.has(headerEl)) {
            observedRecordHeaders.add(headerEl);
            /* 观察边框盒：--rlog-rec-h 写的就是边框盒高度（含内边距），而默认的 content-box
               在「只有内边距变化」时不通知，会漏掉这类高度变化导致吸顶偏移不更新 */
            sharedResizeObserver.observe(headerEl, { box: 'border-box' });
        }
    });
    measured.forEach(([recordEl, height]) => {
        recordEl.style.setProperty('--rlog-rec-h', `${height.toFixed(2)}px`);
    });
}

/* boolean: 是否已有「视口尺寸变化」的重测排在下一帧（连续 resize 合并成一帧一次） */
let viewportSyncQueued = false;

/* number|null: 搜索输入聚焦（虚拟键盘会话）期间被冻结的面板高度(px)；null = 未冻结。
   仅移动端生效：键盘会缩小布局视口，面板高度若继续用 vh 就会跟着变高变矮，连带触发
   吸顶重测 / 进度条刷新 / 正文带宽维护等重活。 */
let searchKeyboardFreezeHeight = null;
/* HTMLElement|null: 触发本次面板高度冻结的搜索输入框（解除冻结时清理） */
let searchKeyboardFreezeInput = null;
/* Array<[string,string,string]>|null: 冻结前面板行内 height/min-height/max-height 的原值快照
   （含优先级），解除冻结时原样还原——不改变用户手动拖拽缩放后的面板尺寸 */
let searchKeyboardFreezeStyleSnapshot = null;

/* 移动端视口判定：与样式断点一致（唯一断点 768px） */
function isMobileViewport() {
    return window.matchMedia('(max-width: 768px)').matches;
}

/* 搜索输入聚焦期间冻结面板高度（仅移动端）：键盘会缩小布局视口，面板高度若继续由 vh 决定
   就会跟着变高变矮，连带触发吸顶重测 / 进度条刷新 / 正文带宽维护（批量卸载与恢复），输入时
   明显卡顿。这里在聚焦瞬间（视口还没缩）记下面板实测高度并用内联 !important 钉住；先快照
   原有行内尺寸，解除时原样还原，用户手动拖拽缩放的结果不受影响。 */
function freezePanelForSearchKeyboard(inputEl) {
    if (!panelEl || !inputEl || searchKeyboardFreezeHeight !== null) return;
    if (!isMobileViewport()) return;
    const height = panelEl.getBoundingClientRect().height;
    if (!(height > 0)) return;
    const props = ['height', 'min-height', 'max-height'];
    searchKeyboardFreezeStyleSnapshot = props.map((prop) => [
        prop,
        panelEl.style.getPropertyValue(prop),
        panelEl.style.getPropertyPriority(prop),
    ]);
    searchKeyboardFreezeHeight = height;
    searchKeyboardFreezeInput = inputEl;
    const value = height.toFixed(2) + 'px';
    props.forEach((prop) => panelEl.style.setProperty(prop, value, 'important'));
}

/* 解除搜索键盘会话的面板高度冻结：还原行内尺寸快照，再补跑一次视口同步
   （冻结期间被跳过的重活在这一帧统一执行） */
function unfreezePanelForSearchKeyboard() {
    if (searchKeyboardFreezeHeight === null) return;
    searchKeyboardFreezeHeight = null;
    searchKeyboardFreezeInput = null;
    if (panelEl && searchKeyboardFreezeStyleSnapshot) {
        searchKeyboardFreezeStyleSnapshot.forEach(([prop, value, priority]) => {
            if (value) panelEl.style.setProperty(prop, value, priority);
            else panelEl.style.removeProperty(prop);
        });
    }
    searchKeyboardFreezeStyleSnapshot = null;
    scheduleViewportSync();
}

/* 键盘弹出后搜索框若落到可视区之外（被冻结的面板下沿被键盘盖住），把该记录标题栏（含搜索框）
   滚到「完整露出」为止——只补足露不出来的那一段（下边被键盘挡住就往上滚刚好露出底边，上边被
   列表顶边切掉就往下滚刚好露出顶边），不把标题栏直接置顶；已完整可见则不动，不做任何重建与重测。 */
function ensureSearchInputVisible() {
    if (searchKeyboardFreezeHeight === null) return;
    const inputEl = searchKeyboardFreezeInput;
    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    if (!inputEl || !inputEl.isConnected || !listEl) return;
    const listRect = listEl.getBoundingClientRect();
    const headerEl = inputEl.closest('.rlog-record-header');
    if (!headerEl) return;
    const headerRect = headerEl.getBoundingClientRect();
    /* 可视下界取「列表底边」与「布局视口高度」的较小值：Android 键盘挤压页面时，
       window.innerHeight 就是键盘上沿，而冻结的面板下沿可能落在它下面 */
    const visibleTop = listRect.top;
    const visibleBottom = Math.min(listRect.bottom, window.innerHeight);
    const margin = 8;
    /* 只补足缺的那一段：正数＝往上滚露出底边，负数＝往下滚露出顶边 */
    let delta = 0;
    if (headerRect.bottom > visibleBottom - margin) {
        delta = headerRect.bottom - (visibleBottom - margin);
    } else if (headerRect.top < visibleTop + margin) {
        delta = headerRect.top - (visibleTop + margin);
    }
    if (delta !== 0) listEl.scrollTop += delta;
}

/* 视口/面板尺寸变化的重测入口：地址栏收放、键盘弹出、拖拽缩放会连续触发 resize，
   每次都重测全部记录标题栏会成倍放大开销，故合并到下一帧统一执行一次。
   合并只减少执行次数，不缩减重测内容——尺寸变化最终仍会反映到吸顶偏移。 */
function scheduleViewportSync() {
    if (viewportSyncQueued) return;
    viewportSyncQueued = true;
    requestAnimationFrame(() => {
        viewportSyncQueued = false;
        /* 搜索键盘会话期间面板高度已冻结，RRL 自身几何没有变化：跳过重活，只兜底确认输入框可见 */
        if (searchKeyboardFreezeHeight !== null) {
            ensureSearchInputVisible();
            return;
        }
        syncRecordHeaderVars(panelEl && panelEl.querySelector('#rlog-list'));
        /* 视口尺寸变化可能整体改动版面（媒体查询切换内边距/字号等），未必伴随内容区自身尺寸变化，
           这里保留一次全量更新兜底（定向更新只覆盖「观察到的尺寸变化」） */
        requestThumbUpdate();
        /* 视口变化也可能改变正文换行宽度（桌面↔移动断点）：带宽维护内部会检测宽度并重建占位高度 */
        scheduleBodyBandPass(panelEl && panelEl.querySelector('#rlog-list'));
        /* 桌面↔移动切换时同步浮标尺寸 */
        updateBadgeSize();
        /* 浮标可见时随视口变化夹回可视区域；不限定折叠态——默认入口模式下浮标在非折叠态也会显示 */
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

/* 滚动锚定：动作前后比较锚点在视口内的位置，上移超过 1px 就用位置差反向校正滚动。
   只保 scrollTop 数值不够——恢复值会被浏览器静默钳到新上限，吸顶标题栏还会随容器变矮脱钉回落。
   折叠类操作必须传 anchorEl（被点击的记录/消息标题栏），否则钳制缺口会残留；展开类可不传。
   @param {Function} action @param {HTMLElement|null} [anchorEl] */
function preserveScrollTop(action, anchorEl) {
    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    if (!listEl) { action(); return; }
    const saved = listEl.scrollTop;
    /* 锚点元素操作前相对列表可视区顶部的位置（吸顶时即吸顶位置） */
    let beforeRelTop = null;
    if (anchorEl) {
        beforeRelTop = anchorEl.getBoundingClientRect().top - listEl.getBoundingClientRect().top;
    }
    action();
    listEl.scrollTop = saved;
    /* 锚点上移超过 1px（钳制或脱钉所致）时用位置差反向校正；下移（吸顶钉住）是正常行为 */
    if (anchorEl && beforeRelTop !== null) {
        const curRelTop = anchorEl.getBoundingClientRect().top - listEl.getBoundingClientRect().top;
        if (curRelTop - beforeRelTop < -1) {
            listEl.scrollTop = listEl.scrollTop + (curRelTop - beforeRelTop);
        }
    }
    /* 折叠/展开会改变列表高度，可能把视口外（带宽外）的内容直接拉进视口——这类变化没有滚动事件，
       必须补排一次带宽维护，否则补位上来的正文仍是等高占位（表现为「只有标题栏、正文空白」） */
    scheduleBodyBandPass(listEl);
}

/* 为单个消息条目绑定交互事件（标题栏折叠/展开 + 复制按钮），整表渲染与回复追加共用。
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
            /* 从搜索框内按下、拖到外部松开时 click 目标是共同祖先 header，不应触发折叠/展开 */
            if (mouseDownInSearchBox) return;
            const recordEl = this.closest('.rlog-record');
            const idx = Number(recordEl.dataset.recordIndex);
            /* 展开/折叠单条记录时保持滚动位置不变（标题栏固定在视口，内容只向下展开） */
            preserveScrollTop(() => {
                toggleRecordCollapse(idx, recordEl);
            }, this);
        });

        /* 长按记录标题栏切换置顶（Pointer Events：移动超容差或提前抬起即取消）；
           长按触发后抑制后续 click，避免与单击折叠/展开打架 */
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

        /* 长按是否应跳过：真实按钮与搜索框都排除，其余空白/状态不防御性屏蔽 */
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
        /* 折叠后列表内容变矮，浏览器会把 scrollTop 压回顶部；仅当折叠前已滚动、
           折叠后确实到顶，才认为发生了回顶 */
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
        /* 必须先补建正文：「回顶后闪第一条子消息标题」要在这个新生成的子树里取目标 */
        ensureRecordBody(recordEl);
        /* 仅当本次折叠确实把列表压回顶部时，才对第一条子消息标题栏闪烁提示；
           停留在顶部反复折叠/展开、新记录出现后的普通展开都不闪 */
        if (recordCollapseToppedEl === recordEl) {
            const firstMsgHeader = recordEl.querySelector('.rmsg-item .rmsg-header');
            if (firstMsgHeader) triggerHeaderFlash(firstMsgHeader);
        }
        recordCollapseToppedEl = null;
        /* 展开记录后，为消息内容区懒创建进度条（仅视口内立即创建，其余延迟） */
        queueScrollbarsForEls(recordEl.querySelectorAll('.rmsg-content'));
    }
}

/* 切换单条记录的临时置顶：置顶不占普通记录上限、不被自动清理；置顶时折叠整条（子消息折叠态不变）；
   取消置顶不自动展开、恢复参与清理；不主动滚动，只用 toast 反馈。 */
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

/* 显示轻量 toast（面板顶部居中，置顶/清空/主题跟随与占位入口等共用）；
   连续多次只替换文本、重置定时器，不堆叠。
   @param {string} text 提示文字
   @param {{persist?: boolean}} [options] persist=true 时持续显示不自动消失（用于模拟进行中等状态提示），
   由后续 toast 或点击关闭替换/消除 */
function showPinToast(text, options = {}) {
    if (!panelEl) return;
    if (!pinToastEl) pinToastEl = panelEl.querySelector('#rlog-pin-toast');
    if (!pinToastEl) return;
    if (pinToastTimer !== null) clearTimeout(pinToastTimer);
    pinToastEl.textContent = text;
    pinToastEl.classList.add('rlog-pin-toast-active');
    pinToastTimer = options.persist ? null : setTimeout(hidePinToast, PIN_TOAST_DURATION_MS);
}

function hidePinToast() {
    if (pinToastTimer !== null) {
        clearTimeout(pinToastTimer);
        pinToastTimer = null;
    }
    if (pinToastEl) {
        pinToastEl.classList.remove('rlog-pin-toast-active');
    }
}

/* 移动端长按重排期间给 #rlog-list 加临时类，让补位记录不因触摸模拟 hover 凭空高亮 */
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

    /* 抑制类不随本次手势的 pointerup/pointercancel 清除（触屏会残留 :hover，重排还可能触发
       pointercancel），改在下一次 pointerdown / 鼠标 pointermove 时清除；不设兜底超时，
       否则抑制自动恢复后残留的 hover 会再冒出来 */
    document.addEventListener('pointerdown', end, { capture: true });
    document.addEventListener('pointermove', onMouseMove, { capture: true });
}

function toggleMessageCollapse(recIdx, msgIdx, msgItem) {
    /* 折叠/展开消息属于单条记录内部操作，不退出搜索模式（搜索高亮保留在 DOM 中） */
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
        const contentEl = ensureMessageContent(msgItem);
        if (contentEl) {
            contentEl.scrollTop = 0; /* 折叠后再展开时，从消息内容顶部开始看 */
            createScrollbarForContent(contentEl);
        }
    }
}

/* 按消息索引取消息：前 N 条为 record.messages，最后一条伪消息是回复（data-msg = messages.length）
   @param {object} record @param {number} msgIdx @returns {object|null} */
function getMessageByIndex(record, msgIdx) {
    if (!record) return null;
    if (msgIdx < record.messages.length) return record.messages[msgIdx];
    if (msgIdx === record.messages.length) return record.reply || null;
    return null;
}

/* 标题栏「折叠所有条目」：折叠所有记录及其内部的所有消息 */
function collapseAllEntries() {
    resetSearchIfActive();
    if (records.length === 0) return;
    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    clearHeaderFlash(listEl);
    records.forEach((r, i) => {
        r.collapsed = true;
        r.messages.forEach(m => { m.collapsed = true; });
        if (r.reply) r.reply.collapsed = true;
        const recordEl = panelEl.querySelector(`.rlog-record[data-record-index="${i}"]`);
        if (recordEl) {
            recordEl.classList.add('collapsed');
            recordEl.classList.remove('expanded');
            recordEl.querySelectorAll('.rmsg-item').forEach(el => {
                el.classList.add('collapsed');
                el.classList.remove('expanded');
            });
        }
    });
    if (listEl) listEl.scrollTop = 0;
    /* 回顶后对顶部最新一条做提示闪烁 */
    flashTopHint();
    /* 一次性折叠全部记录会让列表高度骤减、内容整体上移：补排一次带宽维护，避免空白补位 */
    scheduleBodyBandPass(listEl);
}

/* 单条记录「折叠所有消息」：折叠本条内所有角色的消息，回滚到本条内最顶端角色消息标题栏并闪烁
   （定位与闪烁目标都只认本条记录，与主标题栏「折叠所有条目」回列表顶部不同）
   @param {number} index 记录索引 */
function collapseRecordMessages(index) {
    /* 搜索中的消息折叠后高亮无意义，先退出搜索模式 */
    resetSearchIfActive();
    const record = records[index];
    if (!record || !record.messages) return;

    record.messages.forEach(m => { m.collapsed = true; });
    if (record.reply) record.reply.collapsed = true;

    const listEl = panelEl ? panelEl.querySelector('#rlog-list') : null;
    const recordEl = listEl ? listEl.querySelector(`.rlog-record[data-record-index="${index}"]`) : null;
    if (recordEl) {
        /* 只要元素与几何（折类名 + 定位 + 闪烁目标都是标题栏），不需要把正文补回来 */
        ensureRecordBody(recordEl, false);
        /* 折叠本条所有消息时打断进行中的置底闪烁（展开后不再重播） */
        clearHeaderFlash(recordEl);
        recordEl.querySelectorAll('.rmsg-item').forEach(el => {
            el.classList.add('collapsed');
            el.classList.remove('expanded');
        });
        /* 回滚到本条记录（消息标题栏吸顶在本条记录标题栏之下），不再回列表顶部 */
        scrollToRecordEl(recordEl);
        /* 闪烁本条内最顶端的角色消息标题栏（DOM 顺序第一条即最顶端；角色筛选已在渲染阶段生效） */
        triggerHeaderFlash(recordEl.querySelector('.rmsg-header'));
        /* 折叠本条所有消息会让下方内容整体上移（可能拉进视口）：补排一次带宽维护 */
        scheduleBodyBandPass(listEl);
    }
}

/* 单条记录「展开所有消息」：展开本条记录内所有角色的消息
   @param {number} index 记录索引 */
function expandRecordMessages(index) {
    const record = records[index];
    if (!record || !record.messages) return;

    record.messages.forEach(m => { m.collapsed = false; });
    if (record.reply) record.reply.collapsed = false;

    const recordEl = panelEl.querySelector(`.rlog-record[data-record-index="${index}"]`);
    if (recordEl) {
        ensureRecordBody(recordEl);
        recordEl.querySelectorAll('.rmsg-item').forEach(el => {
            el.classList.add('expanded');
            el.classList.remove('collapsed');
            ensureMessageContent(el);
        });
        /* 为消息内容区懒创建进度条（仅视口内立即创建，其余延迟） */
        queueScrollbarsForEls(recordEl.querySelectorAll('.rmsg-content'));
        /* 展开会让下方内容整体下移、把上方带宽外的内容顶进视口：补排一次带宽维护 */
        scheduleBodyBandPass(panelEl.querySelector('#rlog-list'));
    }
}

/* 单条记录「快速置底」：滚到本条最后一条子消息（有回复即 Response）并让其标题栏闪烁；
   只定位 + 闪烁，不改任何折叠/展开状态。@param {number} index */
function scrollToRecordBottom(index) {
    if (!panelEl) return;
    const listEl = panelEl.querySelector('#rlog-list');
    const recordEl = listEl.querySelector(`.rlog-record[data-record-index="${index}"]`);
    if (!recordEl) return;
    /* 只按最后一条子消息的标题栏定位并闪烁，不需要正文文字 */
    ensureRecordBody(recordEl, false);

    const lastItemEl = recordEl.querySelector('.rmsg-item:last-child');
    if (!lastItemEl) return;
    const headerEl = lastItemEl.querySelector('.rmsg-header');
    if (!headerEl) return;

    /* 计算标题栏在列表内容中的逻辑位置：吸顶状态下 getBoundingClientRect 返回的是吸附后的
       位置而非自然位置，故用非 sticky 的 item 矩形 + 标题栏相对 item 的 offsetTop 推算 */
    const listRect = listEl.getBoundingClientRect();
    const itemRect = lastItemEl.getBoundingClientRect();
    const headerTopInList = listEl.scrollTop + itemRect.top - listRect.top + headerEl.offsetTop;

    const recordHeaderEl = recordEl.querySelector('.rlog-record-header');
    /* 落点只按记录标题栏算（不叠加消息标题栏）；offsetHeight 是元素自身高度，不随吸顶状态变化 */
    const stickyHeight = recordHeaderEl ? recordHeaderEl.offsetHeight : 0;
    /* 目标标题栏落在记录标题栏下方，位置取剩余可视区的比例（越小越靠上） */
    const visibleHeight = Math.max(0, listEl.clientHeight - stickyHeight);
    const targetScroll = headerTopInList - stickyHeight - visibleHeight * 0.13;

    /* 夹到合法滚动范围；下界取记录顶边在列表里的逻辑位置——低于它列表会滚过记录顶边、
       记录标题栏从吸顶位掉下来。碰不到目标落点时优先保证标题栏吸顶不动 */
    const maxListScroll = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
    const recordTopInList = listEl.scrollTop + recordEl.getBoundingClientRect().top - listRect.top;
    const minListScroll = Math.max(0, Math.min(recordTopInList, maxListScroll));
    const clampedListScroll = Math.max(minListScroll, Math.min(targetScroll, maxListScroll));

    /* 仅在需要调整时滚动（目标已可见时保持不动，闪烁照常触发） */
    if (Math.abs(clampedListScroll - listEl.scrollTop) > 1) {
        /* 平滑滚动需要时间，闪烁等滚动到位后再触发（scrollend + 兜底定时器） */
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

/* 触发等待中的置底闪烁（滚动到位后调用）；目标标题栏已被重建/移除时静默跳过 */
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

function cancelPendingFlash() {
    if (pendingFlashTimer !== null) {
        clearTimeout(pendingFlashTimer);
        pendingFlashTimer = null;
    }
    pendingFlashHeader = null;
}

/* 清除指定范围内的标题栏闪烁类，并取消该范围内待触发的闪烁（折叠记录/消息时调用）。
   @param {HTMLElement} scopeEl 作用范围（记录、消息项或整个列表） */
function clearHeaderFlash(scopeEl) {
    if (!scopeEl) return;
    scopeEl.querySelectorAll('.rmsg-header.rlog-flash-bottom, .rlog-record-header.rlog-flash-bottom')
        .forEach(el => clearFlashClasses(el));
    if (pendingFlashHeader && scopeEl.contains(pendingFlashHeader)) {
        cancelPendingFlash();
    }
}

/* 按真实 records 索引取列表中的记录 DOM 元素（data-record-index 始终写真实索引） */
function getRecordElByIndex(index) {
    if (!panelEl) return null;
    const listEl = panelEl.querySelector('#rlog-list');
    return listEl ? listEl.querySelector(`.rlog-record[data-record-index="${index}"]`) : null;
}

/* 滚动列表，使指定记录标题栏出现在可视区顶部（用视图坐标差计算，不依赖 offsetTop） */
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

/* 无按钮回顶的提示闪烁：展开时闪第一条子消息标题栏，折叠/不可见时闪记录标题栏；
   面板未打开或窗口折叠时不触发 */
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
    }
}

/* 摘掉闪烁相关的全部类（标记类 + 两个轮换动画名类）：打断闪烁 / 关闭面板共用。
   三个类名与 style.css 的闪烁规则一一对应，改那边要同步改这里 */
function clearFlashClasses(el) {
    el.classList.remove('rlog-flash-bottom', 'rlog-flash-a', 'rlog-flash-b');
}

/* 标题栏底色闪烁：两个内容相同的动画名（rlog-flash-a / -b）轮换添加，
   同一标题栏在动画没播完时再次触发也能从头重播。
   轮换状态记在 dataset 而不看类名：clearHeaderFlash() 可能刚把类摘掉，
   按类名判断会选回同一个动画名，同一任务内等于没换名（不重播）。
   @param {HTMLElement} headerEl */
function triggerHeaderFlash(headerEl) {
    if (!headerEl) return;
    /* 极简模式：不做闪烁（仅保留滚动定位），也避免 animation:none 下 animationend
       不触发导致 .rlog-flash-bottom 类残留 */
    if (preferences.minimal) return;
    const nextAlt = headerEl.dataset.rlogFlashAlt === 'a' ? 'b' : 'a';
    headerEl.dataset.rlogFlashAlt = nextAlt;
    clearFlashClasses(headerEl);
    headerEl.classList.add('rlog-flash-bottom', `rlog-flash-${nextAlt}`);
    if (!headerEl.dataset.rlogFlashBound) {
        headerEl.dataset.rlogFlashBound = '1';
        headerEl.addEventListener('animationend', function onFlashEnd(e) {
            /* 两个轮换动画名（rlog-flash-bottom-a / -b）按前缀匹配 */
            if (e.animationName.startsWith('rlog-flash-bottom')) {
                clearFlashClasses(this);
            }
        });
    }
}

/* ── 记录删除与复制 ──────────────────────── */

/* 单条记录「删除」：从列表中移除本条记录
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

/* 取覆盖层内容区的文本 @param {object} record @param {string} format formatted 或 raw @returns {string} */
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

function switchReadFormat(format) {
    if (!readFullOverlayEl) return;
    readFullFormat = format;
    const record = records[readFullRecordIndex];
    if (!record) return;

    const contentEl = readFullOverlayEl.querySelector('.rlog-read-content');
    if (contentEl) {
        contentEl.textContent = getReadContent(record, format);
        contentEl.scrollTop = 0;
    }

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

/* 「查看全文」覆盖层回顶/置底：直接滚动内容区（连续长文本，只做功能滚动、不做闪烁动画）
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
    document.removeEventListener('keydown', handleReadFullEscape);
}

/* Escape 键关闭覆盖层的处理器 @param {KeyboardEvent} e 键盘事件 */
function handleReadFullEscape(e) {
    if (e.key === 'Escape' && readFullOverlayEl) {
        closeReadFullOverlay();
    }
}

/* 打开「查看全文」覆盖层，展示指定记录的完整提示词；覆盖层挂到 #rlog-panel 内、完整遮挡面板
   @param {number} index 记录索引 */
function openReadFullOverlay(index) {
    /* 先退出搜索模式（覆盖层打开期间搜索不可见不可操作） */
    resetSearchIfActive();

    const record = records[index];
    if (!record || !panelEl) return;

    /* 关闭旧的覆盖层（如有） */
    closeReadFullOverlay();

    readFullRecordIndex = index;
    readFullFormat = 'formatted';

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

    const toggleEl = overlay.querySelector('.rlog-read-format-btn');
    toggleEl.addEventListener('click', (e) => {
        e.stopPropagation();
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

    panelEl.appendChild(overlay);
    readFullOverlayEl = overlay;

    /* 为覆盖层内容区创建自定义滚动条（复用 Overlay 进度条样式与交互） */
    const readContentElForScroll = overlay.querySelector('.rlog-read-content');
    if (readContentElForScroll) {
        queueScrollbarsForEls([readContentElForScroll]);
    }

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

/* Array<HTMLElement>: 已进入视口、等待分帧创建进度条的内容区（同帧命中多条时排队摊开） */
const scrollbarCreateQueue = [];

/* boolean: 是否已有一次「分帧创建进度条」排在下一帧 */
let scrollbarCreateFlushQueued = false;

/* boolean: 是否已有 RAF 排队更新 thumb */
let thumbUpdateQueued = false;

/* boolean: 是否等待全量更新所有进度条（整体几何变化时用，如视口尺寸变化） */
let thumbFullUpdatePending = false;

/* Set<HTMLElement>: 待定向更新的内容区（scroll 事件、ResizeObserver 报告的尺寸/位置变化）。
   RO 回调只负责收集，实际「读布局值 → 写样式」统一放到同一帧 rAF 里做——
   在 RO 回调里读布局会触发强制重算，还可能引发 resize loop 告警。 */
const pendingThumbElements = new Set();

/* 取 ResizeObserver 回调自带的高度：borderBoxSize 与 getBoundingClientRect().height 同为
   边框盒、同为小数，而观察器已量好尺寸——再读 DOM 只会白触发一次强制布局。
   个别环境缺 borderBoxSize 时才回退到读 DOM。 */
function readObservedHeight(entry, el) {
    const box = entry.borderBoxSize && entry.borderBoxSize[0];
    if (box && typeof box.blockSize === 'number') return box.blockSize;
    return el.getBoundingClientRect().height;
}

/* 确保共享 ResizeObserver 已创建：所有进度条统一由它监听，避免 100+ 个独立观察者的额外开销 */
function ensureSharedResizeObserver() {
    if (sharedResizeObserver) return;
    sharedResizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
            const entryEl = entry.target;
            if (!entryEl || !entryEl.classList) continue;
            /* 记录标题栏高度变化（换行/字体/视口变化）→ 实时刷新吸顶偏移 */
            if (entryEl.classList.contains('rlog-record-header')) {
                const recordEl = entryEl.closest('.rlog-record');
                if (recordEl) {
                    recordEl.style.setProperty('--rlog-rec-h', `${readObservedHeight(entry, entryEl).toFixed(2)}px`);
                }
                continue;
            }
            /* 内容区自身尺寸变化 → 只把「这一个」排进待更新集合 */
            if (entryEl.classList.contains('rmsg-content') || entryEl.classList.contains('rlog-read-content')) {
                requestThumbUpdate(entryEl);
                continue;
            }
            /* 消息标题栏高度变化：同一条消息的正文会被挤上/挤下，正文自身尺寸没变（观察器不会报它），
               但它相对消息项的偏移变了 → 按消息项取回正文，走同一套定向更新 */
            if (entryEl.classList.contains('rmsg-header')) {
                const itemEl = entryEl.closest('.rmsg-item');
                const contentEl = itemEl ? itemEl.querySelector('.rmsg-content') : null;
                if (contentEl) requestThumbUpdate(contentEl);
            }
        }
    });
}

/* 懒创建 IntersectionObserver：进度条只在内容区接近视口时才建（rootMargin 200px），
   避免展开 100+ 消息时瞬间创建大量进度条造成同步 layout 卡顿。 */
function ensureScrollbarLazyObserver() {
    if (scrollbarLazyObserver) return;
    scrollbarLazyObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const contentEl = entry.target;
                pendingScrollbarContentEls.delete(contentEl);
                scrollbarLazyObserver.unobserve(contentEl);
                scrollbarCreateQueue.push(contentEl);
            }
        });
        scheduleScrollbarCreateFlush();
    }, { root: null, rootMargin: '200px 0px', threshold: 0 });
}

/* 把「创建进度条」摊到连续帧：一帧最多处理 SCROLLBAR_CREATE_PER_FRAME 个，剩下的下一帧继续。
   只改变创建的时机分布，创建条件、判定与进度条行为都不变。 */
function scheduleScrollbarCreateFlush() {
    if (scrollbarCreateFlushQueued) return;
    scrollbarCreateFlushQueued = true;
    requestAnimationFrame(flushScrollbarCreateQueue);
}

function flushScrollbarCreateQueue() {
    scrollbarCreateFlushQueued = false;
    const batch = [];
    while (scrollbarCreateQueue.length > 0 && batch.length < SCROLLBAR_CREATE_PER_FRAME) {
        const contentEl = scrollbarCreateQueue.shift();
        /* 已脱离文档 / 已有进度条 / 已卸载成占位 / 重新回到懒观察队列的，都不在这里处理：
           占位没有溢出，恢复与重新入队各由现有路径负责 */
        if (!contentEl || !contentEl.isConnected) continue;
        if (scrollbarCleanups.has(contentEl) || unloadedBodies.has(contentEl)) continue;
        if (pendingScrollbarContentEls.has(contentEl)) continue;
        batch.push(contentEl);
    }
    if (batch.length > 0) {
        /* 先读完这一批的布局值，再统一创建 DOM：创建本身会改 DOM，若「建一个读一个」
           每建一条都让下一条的读取撞上失效的布局，会被迫多做 N 次强制布局 */
        const measured = batch.map((contentEl) => ({ contentEl, m: measureScrollbarCreation(contentEl) }));
        measured.forEach(({ contentEl, m }) => {
            /* 容器结构异常（元素已脱离 contentEl→容器关系）：不收尾也不再登记，交给 isConnected 清理 */
            if (!m) return;
            /* 「没量成」≠「不溢出」：当前不可见 / 无布局时 clientHeight 为 0，测出的「不溢出」是假象。
               重新登记进懒观察队列，等它真正可见时由观察器再报一次 → 下一帧重测。
               重新 observe 由观察器去重（已在观察列表时不会重复登记）、pending 是 Set 也不重复加入；
               没量成 ⇒ 元素当前零尺寸、观察器不会判为相交，故不会形成每帧空转的重试循环 */
            if (!m.measurable) {
                queueScrollbarsForEls([contentEl]);
                return;
            }
            /* 量成了且确实溢出 → 建条；量成了但不需要滚动（短消息）是终态，不重试 */
            if (m.hasOverflow) buildScrollbar(contentEl, m);
        });
    }
    if (scrollbarCreateQueue.length > 0) scheduleScrollbarCreateFlush();
}

/* 请求更新进度条 thumb 位置（RAF 批处理）：不传参＝全量更新（整体几何变化时的兜底），
   传 contentEl＝只更新该元素对应进度条；同一帧内多次请求合并成一次。
   定向请求按元素去重后逐个更新（不能只留最后一个：同帧多个元素变化会漏）。
   @param {HTMLElement} [contentEl] */
function requestThumbUpdate(contentEl) {
    if (contentEl) {
        pendingThumbElements.add(contentEl);
    } else {
        thumbFullUpdatePending = true;
    }
    if (thumbUpdateQueued) return;
    thumbUpdateQueued = true;
    requestAnimationFrame(() => {
        thumbUpdateQueued = false;
        if (thumbFullUpdatePending) {
            thumbFullUpdatePending = false;
            pendingThumbElements.clear();
            updateScrollbarThumbs(scrollbarElements);
            return;
        }
        if (pendingThumbElements.size === 0) return;
        const targets = [...pendingThumbElements];
        pendingThumbElements.clear();
        updateScrollbarThumbs(targets);
    });
}

/* 读阶段：一次读完这个内容区需要的全部布局值（四个值互不依赖，且后面写的样式只作用于
   hitbox/thumb——它们都是 position:absolute 的兄弟节点，不会反过来改这些值）
   @param {HTMLElement} contentEl 内容区元素 @returns {object} */
function measureScrollbarThumb(contentEl) {
    const scrollHeight = contentEl.scrollHeight;
    const clientHeight = contentEl.clientHeight;
    const scrollTop = contentEl.scrollTop;
    const contentTop = contentEl.offsetTop;
    return { scrollHeight, clientHeight, scrollTop, contentTop, maxScroll: scrollHeight - clientHeight };
}

/* 写阶段：按已测得的数值写进度条样式（本函数内不再读布局值）
   @param {object} cleanup 该进度条的清理数据（含 hitboxEl/thumbEl）
   @param {object} m measureScrollbarThumb 的返回值 */
function applyScrollbarThumb(cleanup, m) {
    const hitbox = cleanup.hitboxEl;
    const thumb = cleanup.thumbEl;
    if (!hitbox || !thumb) return;

    const { scrollHeight, clientHeight, scrollTop, contentTop, maxScroll } = m;

    /* 几何先同步、再按需隐藏：内容不需要滚动时（折叠消息、被离屏卸载的等高占位）
       hitbox 仍然留在 DOM 里但不可见，位置与高度也要跟着内容走，避免留下过期数值 */
    hitbox.style.top = contentTop + 'px';
    hitbox.style.height = clientHeight + 'px';
    if (maxScroll <= 0) {
        hitbox.style.display = 'none';
        return;
    }
    hitbox.style.display = '';

    /* 轨道可用高度：扣掉轨道相对 hitbox 的上下内缩量 */
    const trackHeight = clientHeight - SCROLLBAR_TRACK_PADDING * 2;

    const thumbRatio = clientHeight / scrollHeight;
    const thumbHeight = Math.max(20, thumbRatio * trackHeight);
    thumb.style.height = thumbHeight + 'px';

    const thumbRange = trackHeight - thumbHeight;

    const thumbTop = maxScroll > 0 ? (scrollTop / maxScroll) * thumbRange : 0;
    thumb.style.top = thumbTop.toFixed(1) + 'px';
}

/* 更新一组内容区的进度条：整批先读完（布局值），再整批写样式。
   逐个「写一个、读下一个」会让每次读取都撞上前一次写入造成的样式/布局失效，被迫多做强制布局。
   @param {Iterable<HTMLElement>} contentEls */
function updateScrollbarThumbs(contentEls) {
    const plan = [];
    for (const contentEl of contentEls) {
        const cleanup = scrollbarCleanups.get(contentEl);
        if (!cleanup || !cleanup.hitboxEl || !cleanup.thumbEl) continue;
        plan.push({ cleanup, metrics: measureScrollbarThumb(contentEl) });
    }
    plan.forEach(({ cleanup, metrics }) => applyScrollbarThumb(cleanup, metrics));
}

/* 为一组 .rmsg-content 懒创建进度条（进入/接近视口才建；已在观察队列或已有进度条则跳过）
   @param {NodeListOf<HTMLElement>|HTMLElement[]} contentEls */
function queueScrollbarsForEls(contentEls) {
    ensureScrollbarLazyObserver();
    /* 支持 .rmsg-content（消息内容区）与 .rlog-read-content（查看全文覆盖层内容区） */
    const SCROLLABLE_CONTENT_CLASSES = ['rmsg-content', 'rlog-read-content'];
    contentEls.forEach((contentEl) => {
        if (!contentEl || !contentEl.classList) return;
        if (!SCROLLABLE_CONTENT_CLASSES.some(c => contentEl.classList.contains(c))) return;
        /* 被离屏卸载的占位没有内容、也不该有进度条；而且一旦被懒观察器消费掉就会从观察队列里摘除，
           恢复后这条消息将永久没有进度条——统一由 restoreBody() 在恢复后再入队 */
        if (unloadedBodies.has(contentEl)) return;
        if (pendingScrollbarContentEls.has(contentEl)) return;
        if (scrollbarCleanups.has(contentEl)) return;
        pendingScrollbarContentEls.add(contentEl);
        scrollbarLazyObserver.observe(contentEl);
    });
}

/* 取「高度变化会把该内容区挤上/挤下」的相邻标题栏：只有消息内容区（.rmsg-item 内）有——
   「查看全文」覆盖层的内容区在固定弹窗里滚动，位置不受同级元素影响，返回 null。
   @param {HTMLElement} contentEl @returns {HTMLElement|null} */
function getContentAnchorHeaderEl(contentEl) {
    const container = contentEl.parentElement;
    if (!container || !container.classList.contains('rmsg-item')) return null;
    return container.querySelector('.rmsg-header');
}

/* 读阶段：创建进度条前要读的布局/样式值。单独拆出是为了批量创建能「先把一批读完、再统一建」，
   避免「建一个读一个」反复触发强制布局。
   @param {HTMLElement} contentEl .rmsg-content 元素 @returns {object|null} */
function measureScrollbarCreation(contentEl) {
    /* 挂载在 contentEl 的父容器上（非 contentEl 内部）：
       .rmsg-content → .rmsg-item；.rlog-read-content → .rlog-read-overlay */
    /* 这样 hitbox 使用 position: absolute 定位时不会随 contentEl 滚动而移出视口 */
    const container = contentEl.parentElement;
    if (!container) return null;
    const isRmsgItem = container.classList.contains('rmsg-item');
    const isReadOverlay = container.classList.contains('rlog-read-overlay');
    if (!isRmsgItem && !isReadOverlay) return null;
    const clientHeight = contentEl.clientHeight;
    return {
        container,
        /* 是否量到了有效布局：内容区被折叠 / 整块隐藏时 clientHeight 为 0，
           此时的「不溢出」是假象，不能当成「不需要进度条」收尾（会永久漏条），
           要留回待办等可见后重试。正常显示的内容区带内边距，clientHeight 必然 > 0 */
        measurable: clientHeight > 0,
        /* 内容不需要滚动时不需要进度条；这里读 scrollHeight 布局值不可避免，
           但仅在进入视口时才执行（懒创建 + 批量） */
        hasOverflow: contentEl.scrollHeight > clientHeight,
        /* 容器需要 position: relative 作为 hitbox 的定位参考 */
        needsPositionFix: getComputedStyle(container).position === 'static',
    };
}

/* 为单个 .rmsg-content 元素创建 overlay 进度条
   @param {HTMLElement} contentEl .rmsg-content 元素 */
function createScrollbarForContent(contentEl) {
    detachScrollbarForContent(contentEl);
    const measured = measureScrollbarCreation(contentEl);
    if (!measured || !measured.hasOverflow) return;
    buildScrollbar(contentEl, measured);
}

/* 写阶段：按 measureScrollbarCreation 的结果建 DOM 与监听（本函数内不再读布局值）
   @param {HTMLElement} contentEl .rmsg-content 元素
   @param {object} measured measureScrollbarCreation 的返回值 */
function buildScrollbar(contentEl, measured) {
    const container = measured.container;

    /* 确保容器有 position: relative 作为定位参考 */
    if (measured.needsPositionFix) {
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

    scrollbarElements.add(contentEl);

    const cleanup = {
        scrollHandler: null,
        hitboxEl: hitbox,
        thumbEl: thumb,
    };

    /* 先注册 cleanup 再请求初始更新（更新时按内容区查 cleanup 找 hitbox/thumb） */
    scrollbarCleanups.set(contentEl, cleanup);
    requestThumbUpdate(contentEl);

    /* 监听滚动事件（RAF 批处理，避免高频滚动触发连续强制 layout） */
    const onScroll = () => requestThumbUpdate(contentEl);
    cleanup.scrollHandler = onScroll;
    contentEl.addEventListener('scroll', onScroll, { passive: true });

    ensureSharedResizeObserver();
    if (sharedResizeObserver) {
        try {
            sharedResizeObserver.observe(contentEl);
        } catch (e) { /* ignore */ }
        /* 一并观察上面的消息标题栏：它变高会把正文挤下去，而正文自身尺寸没变
           （观察器不会报正文）——交给 RO 回调映射回本条正文做定向更新 */
        const anchorHeaderEl = getContentAnchorHeaderEl(contentEl);
        if (anchorHeaderEl) {
            try {
                sharedResizeObserver.observe(anchorHeaderEl, { box: 'border-box' });
            } catch (e) { /* ignore */ }
        }
    }

    /* --- 交互：圆点跟随手指位置（不跟随 thumb），可到达轨道两端 --- */
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

        const trackTop = SCROLLBAR_TRACK_PADDING;
        const trackBottom = hitboxRect.height - SCROLLBAR_TRACK_PADDING;
        relativeY = Math.max(trackTop, Math.min(trackBottom, relativeY));

        /* 圆点高度的一半：让返回值指向圆点中心（dot 的 top 是左上角）。
           取值必须等于 CSS 中 .rlog-scroll-dot 实际高度的一半，圆点尺寸调整时同步改这里 */
        const DOT_HALF = 2.5;
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
        const trackHeight = clientHeight - SCROLLBAR_TRACK_PADDING * 2;
        const trackTop = SCROLLBAR_TRACK_PADDING;
        const trackBottom = trackTop + trackHeight;
        relativeY = Math.max(trackTop, Math.min(trackBottom, relativeY));

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

        dot.style.top = clientYToDotTop(e.clientY);
        contentEl.scrollTop = dotPositionToScroll(e.clientY);
        e.preventDefault();
    }

    function onPointerMove(e) {
        if (!dragging) return;

        const maxScroll = contentEl.scrollHeight - contentEl.clientHeight;
        if (maxScroll <= 0) return;

        dot.style.top = clientYToDotTop(e.clientY);
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
    /* 登记侧注销无条件执行：无论进度条有没有建出来，都要把「等待创建」的登记清干净。
       否则正文在排队期被卸载时，pending / 观察器会留下过期登记，
       之后恢复走 queueScrollbarsForEls() 会被「已在待办」挡下 → 永久缺条。
       顺带把还在分帧创建队列里的元素出队，避免与本次清理、或随后的重新入队撞车 */
    const queuedIdx = scrollbarCreateQueue.indexOf(contentEl);
    if (queuedIdx !== -1) scrollbarCreateQueue.splice(queuedIdx, 1);
    pendingScrollbarContentEls.delete(contentEl);
    if (scrollbarLazyObserver) {
        try { scrollbarLazyObserver.unobserve(contentEl); } catch (e) { /* ignore */ }
    }

    const cleanup = scrollbarCleanups.get(contentEl);
    if (!cleanup) return;

    contentEl.removeEventListener('scroll', cleanup.scrollHandler);
    if (sharedResizeObserver) {
        try { sharedResizeObserver.unobserve(contentEl); } catch (e) { /* ignore */ }
        const anchorHeaderEl = getContentAnchorHeaderEl(contentEl);
        if (anchorHeaderEl) {
            try { sharedResizeObserver.unobserve(anchorHeaderEl); } catch (e) { /* ignore */ }
        }
    }
    scrollbarElements.delete(contentEl);
    if (cleanup.hitboxEl && cleanup.hitboxEl.parentNode) {
        cleanup.hitboxEl.remove();
    }
    scrollbarCleanups.delete(contentEl);
}

/* 清掉「排队等进视口再创建进度条」队列里已经离开文档的元素（整表重建后旧元素已被销毁）。
   观察队列与 Set 都强引用元素，不切断的话每轮重建都会把上一轮整份列表 DOM 留在内存里；
   仍在文档中的元素（如「查看全文」覆盖层的内容区，重建不会销毁它）保留在队列中，行为不变。 */
function clearDetachedPendingScrollbarEls() {
    if (pendingScrollbarContentEls.size === 0) return;
    pendingScrollbarContentEls.forEach((contentEl) => {
        if (contentEl.isConnected) return;
        if (scrollbarLazyObserver) {
            try { scrollbarLazyObserver.unobserve(contentEl); } catch (e) { /* ignore */ }
        }
        pendingScrollbarContentEls.delete(contentEl);
    });
}

/* 为列表内所有 .rmsg-content 创建/刷新进度条（重建 DOM 后与展开/折叠后调用），懒创建避免批量卡顿
   @param {HTMLElement} listEl */
function attachScrollIndicators(listEl) {
    /* 清理已随重建一起销毁的进度条：只处理已经离开文档的元素。
       renderPanelContent 用 innerHTML 重建了 DOM，列表内旧元素必然已脱离文档；
       而「查看全文」覆盖层的内容区与列表平级、重建不会销毁它（它的进度条只在打开覆盖层时挂载一次），
       一并拆掉就再也没人重建，故保留。 */
    scrollbarCleanups.forEach((_, contentEl) => {
        if (contentEl.isConnected) return;
        detachScrollbarForContent(contentEl);
    });
    /* 上一轮排队等待创建进度条的旧元素同样随重建一起销毁，这里一并出队 */
    clearDetachedPendingScrollbarEls();

    /* 全部进入懒创建观察队列，由 IntersectionObserver 按视口按需创建 */
    queueScrollbarsForEls(listEl.querySelectorAll('.rmsg-content'));
}

/* ── 正文卸载与按需恢复 ─────────────────── */

/* Map<HTMLElement, {scrollTop:number}>: 已被离屏卸载的消息正文元素（文字已清空、高度已锁定）。
   正文文字不在这里备份——records[].messages[].content 就是唯一来源，恢复时按 toRenderedText 写回，
   与搜索高亮共用同一文本基准；这里只需要记下元素内部的滚动位置。 */
const unloadedBodies = new Map();

/* number: 上一次带宽维护时列表的宽度（px）。面板缩放/移动端全屏/桌面↔移动切换都会改变正文换行宽度，
   已锁定的占位高度随即失效——检测到宽度变化就先把正文全部恢复，下一帧再按新几何重新卸载。 */
let lastBandListWidth = 0;

/* boolean: 是否已有一次带宽维护排在下一帧（滚动/重建等连续触发合并成一帧一次） */
let bodyBandPassQueued = false;

/* 正文卸载统计（只读调试口 __rlogDebug.getBodyUnloadStats 用；回归断言与性能探针也读它） */
const bodyUnloadStats = { passes: 0, lastPassMs: 0, restoreAllCount: 0 };

/* 初始化列表的滚动带维护：滚动时按需恢复进入带宽的正文、卸载离开带宽的正文。
   只在 buildUI 建好列表后绑定一次（#rlog-list 元素本身在整表重建时不会被替换）。 */
function initBodyBandMaintenance(listEl) {
    if (!listEl || listEl.dataset.rlogBandBound === '1') return;
    listEl.dataset.rlogBandBound = '1';
    listEl.addEventListener('scroll', () => scheduleBodyBandPass(listEl), { passive: true });
}

/* 列表可视带宽：视口上下各 BODY_KEEP_SCREENS 屏。列表被面板裁剪，用列表自身矩形最准 */
function getBodyBand(listEl) {
    const rect = listEl.getBoundingClientRect();
    const margin = rect.height * BODY_KEEP_SCREENS;
    return { top: rect.top - margin, bottom: rect.bottom + margin };
}

/* 该正文是否被「钉住」不许卸载：含搜索高亮 <mark> 的元素、以及正在搜索的那条记录。
   搜索高亮与命中跳转都依赖真实文本节点，卸载它们会让高亮失效。 */
function isBodyPinned(contentEl) {
    if (contentEl.querySelector('mark.rlog-search-mark, mark.rlog-search-mark-current')) return true;
    if (!searchState) return false;
    const recordEl = contentEl.closest('.rlog-record');
    return !!recordEl && Number(recordEl.dataset.recordIndex) === searchState.recordIndex;
}

/* 卸载单条正文：清空文字、把高度锁死为实测高度（等高等占位），并记下元素内滚动位置。
   height 由调用方在「读阶段」一并量好传入；不传时才自己读一次（避免在写阶段里再触发一次强制布局）。
   注意不要在这里写 contentEl.scrollTop：清空后元素已不可滚、它会自动归零，
   而赋值会强制一次布局（实测每条约 1ms，400 条就是几百毫秒）。 */
function unloadBody(contentEl, height) {
    if (!contentEl || unloadedBodies.has(contentEl)) return false;
    const measuredHeight = typeof height === 'number' ? height : contentEl.getBoundingClientRect().height;
    if (measuredHeight <= 0) return false;
    unloadedBodies.set(contentEl, { scrollTop: contentEl.scrollTop });
    contentEl.textContent = '';
    contentEl.style.height = `${measuredHeight}px`;
    contentEl.dataset.rlogUnloaded = '1';
    /* 占位不再需要内部进度条：连带清掉 hitbox DOM、scroll 监听与观察注册，资源随占位一起释放。
       恢复时由 restoreBody 按现有机制重新入队、重新创建，滚动位置已在上方记入 unloadedBodies。 */
    detachScrollbarForContent(contentEl);
    return true;
}

/* 恢复单条正文：从数据层写回文字、解除高度锁定、还原元素内滚动位置，并重新排进进度条懒创建队列。
   元素已脱离文档（整表重建后的旧节点）时直接丢弃表项，避免把整棵旧列表子树留在内存里。 */
function restoreBody(contentEl) {
    if (!contentEl) return false;
    const state = unloadedBodies.get(contentEl);
    if (!state) return false;
    if (!contentEl.isConnected) {
        unloadedBodies.delete(contentEl);
        return false;
    }
    const msgItem = contentEl.closest('.rmsg-item');
    const msg = msgItem
        ? getMessageByIndex(records[Number(msgItem.dataset.record)], Number(msgItem.dataset.msg))
        : null;
    if (!msg) {
        unloadedBodies.delete(contentEl);
        delete contentEl.dataset.rlogUnloaded;
        contentEl.style.height = '';
        return false;
    }
    unloadedBodies.delete(contentEl);
    contentEl.textContent = toRenderedText(msg.content);
    contentEl.style.height = '';
    delete contentEl.dataset.rlogUnloaded;
    if (state.scrollTop) contentEl.scrollTop = state.scrollTop;
    /* 进度条必须重新入队：占位没有溢出，懒观察器若在占位状态下看到它，会提前返回并把元素摘出观察队列，
       那样恢复后这条消息就永久没有进度条了（见 queueScrollbarsForEls 里的同款判定） */
    queueScrollbarsForEls([contentEl]);
    return true;
}

/* 恢复一条记录内所有已卸载正文（展开这条记录、以及对该记录做搜索前的必做步骤） */
function restoreRecordBodies(recordEl) {
    if (!recordEl) return 0;
    let count = 0;
    recordEl.querySelectorAll('.rmsg-content').forEach((contentEl) => {
        if (restoreBody(contentEl)) count++;
    });
    return count;
}

/* 全量恢复：面板宽度变化使占位高度失效时用（罕见路径，代价可接受） */
function restoreAllBodies() {
    [...unloadedBodies.keys()].forEach((contentEl) => restoreBody(contentEl));
}

/* 丢弃已脱离文档的表项（整表重建用 innerHTML 换掉整份列表后，旧节点必须及时出表，
   否则 Map 会强引用它们、把上一轮的整棵列表子树留在内存里） */
function pruneDetachedUnloadedBodies() {
    if (unloadedBodies.size === 0) return;
    unloadedBodies.forEach((_, contentEl) => {
        if (!contentEl.isConnected) unloadedBodies.delete(contentEl);
    });
}

/* 一次带宽维护。读阶段先把所有正文的几何与状态读完（不写 DOM），再统一执行恢复与卸载：
   写一个读下一个会让每次读取都撞上刚写完造成的样式失效，被迫多做强制布局。 */
function runBodyBandPass(listEl) {
    if (!listEl || !listEl.isConnected) return;
    /* 面板隐藏 / 列表没有实际布局时不做：此时 rect 全为 0，带宽判定没有意义 */
    if (!isPanelVisible || listEl.clientHeight === 0) return;

    const startedAt = performance.now();

    /* 宽度变化 → 占位高度是按旧宽度量的，先全部恢复，下一帧再按新几何重新卸载 */
    const width = listEl.clientWidth;
    if (lastBandListWidth > 0 && width !== lastBandListWidth) {
        restoreAllBodies();
        bodyUnloadStats.restoreAllCount++;
        lastBandListWidth = width;
        scheduleBodyBandPass(listEl);
        bodyUnloadStats.lastPassMs = performance.now() - startedAt;
        return;
    }
    lastBandListWidth = width;

    const band = getBodyBand(listEl);

    /* 读阶段：内容区矩形 + 是否被钉住 + 是否已卸载（全程不写 DOM） */
    const measured = [];
    listEl.querySelectorAll('.rmsg-content').forEach((contentEl) => {
        measured.push({
            contentEl,
            rect: contentEl.getBoundingClientRect(),
            unloaded: unloadedBodies.has(contentEl),
            pinned: isBodyPinned(contentEl),
        });
    });

    const inBand = (rect) => rect.bottom > band.top && rect.top < band.bottom;

    /* 写阶段：先恢复（恢复优先于卸载，避免带宽边缘来回抖动），再卸载 */
    measured.forEach(({ contentEl, rect, unloaded }) => {
        if (unloaded && inBand(rect)) restoreBody(contentEl);
    });
    let unloadedCount = 0;
    measured.forEach(({ contentEl, rect, unloaded, pinned }) => {
        if (unloaded || pinned || inBand(rect)) return;
        if (unloadBody(contentEl, rect.height)) unloadedCount++;
    });

    bodyUnloadStats.passes++;
    bodyUnloadStats.lastPassMs = performance.now() - startedAt;
    return unloadedCount;
}

/* 把带宽维护合并到下一帧（滚动/视口变化等连续触发时，一帧最多跑一次） */
function scheduleBodyBandPass(listEl) {
    if (bodyBandPassQueued) return;
    bodyBandPassQueued = true;
    requestAnimationFrame(() => {
        bodyBandPassQueued = false;
        const target = listEl && listEl.isConnected
            ? listEl
            : (panelEl ? panelEl.querySelector('#rlog-list') : null);
        runBodyBandPass(target);
    });
}

/* ── 面板控制 ─────────────────────────── */

/* 浮标实际边长：桌面 BADGE_SIZE（34×34）、移动端（≤768px）BADGE_SIZE_MOBILE（30×30）；
   尺寸走 inline 样式（浮标定位与越界校正需要具体像素值），style.css 里只调图标字号 */
function getBadgeSize() {
    return window.matchMedia('(max-width: 768px)').matches ? BADGE_SIZE_MOBILE : BADGE_SIZE;
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

/* 「浮标默认入口」的默认落位：距右缘 BADGE_DEFAULT_MARGIN_RIGHT、ST 顶栏下缘再往下
   BADGE_DEFAULT_MARGIN_TOP，最后经 clampBadgeToViewport 兜底；拖动后由 badgePos 接管。 */
function getDefaultBadgePos() {
    const size = getBadgeSize();
    const topBarEl = document.getElementById('top-settings-holder');
    const minTop = topBarEl ? Math.ceil(topBarEl.getBoundingClientRect().height) : 0;
    return clampBadgeToViewport(
        window.innerWidth - size - BADGE_DEFAULT_MARGIN_RIGHT,
        minTop + BADGE_DEFAULT_MARGIN_TOP
    );
}

/* 浮标尺寸同步：host 宽/高按断点切换，初始化与 resize 时调用 */
function updateBadgeSize() {
    if (!badgeEl) return;
    const size = getBadgeSize();
    badgeEl.style.width = size + 'px';
    badgeEl.style.height = size + 'px';
}

/* ST 当前是否深色主题：读 --SmartThemeBlurTintColor 算相对感知亮度 < 阈值判深色；
   读不到/不认识/解析失败一律按深色（退回深色浮标）。@returns {boolean} */
function isStThemeDark() {
    let raw = '';
    try {
        raw = getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBlurTintColor').trim();
    } catch (e) { /* 读取失败：按深色处理 */ }
    const channels = parseCssColorChannels(raw);
    if (!channels) return true;
    return relativeLuminance(channels.r, channels.g, channels.b) < ST_THEME_DARK_LUMINANCE;
}

/* 同步浮标配色：浅色 ST → 深色浮标、深色 ST → 浅色浮标（始终反向，保证对比度）。
   只在浮标宿主上加减 .rlog-badge-light（配色数值在总表）；判定结果没变时不动 DOM，免得打断过渡。 */
function syncBadgeTheme() {
    if (!badgeEl) return;
    const isDark = isStThemeDark();
    /* 状态与宿主类都已一致才跳过（多一道类检查：宿主重建后也能自愈） */
    if (isDark === stThemeIsDark && badgeEl.classList.contains('rlog-badge-light') === isDark) return;
    stThemeIsDark = isDark;
    badgeEl.classList.toggle('rlog-badge-light', isDark);
}

/* 初始化浮标配色的主题跟随：先同步一次，再监听 <html> 的 style 属性（ST 没有主题变化事件）；
   挂点将来失效只表现为浮标配色不再更新 */
function initBadgeThemeSync() {
    syncBadgeTheme();
    if (badgeThemeObserver) return;
    badgeThemeObserver = new MutationObserver(() => syncBadgeTheme());
    badgeThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
}

/* 重置面板为默认定位/尺寸：清掉拖拽/缩放写入的 inline 样式，让 style.css 的默认值生效
   （默认定位本就在视口内，不做额外边界修正） */
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
        /* 收起为浮标：会话内首次收起记下当次点击坐标作为浮标中心，再次收起复用记录的位置
           （拖动后即为拖动后位置）；刷新后 badgePos 重置为 null，按首次收起处理 */
        hidePinToast();
        /* 与关闭面板一致：隐藏前清掉播放中的动画类（闪烁 / 主题切换），
          否则隐藏期间动画不推进，重新展开会从头补播一次 */
        clearPanelAnimations();
        /* 与关闭面板一致：收起前趁布局有效把视口外正文卸载，展开时不必为它们付排版与绘制 */
        runBodyBandPass(panelEl.querySelector('#rlog-list'));
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
        /* 重新展开后面板不会自己发 scroll 事件，主动跑一次带宽维护（与前一条打开路径一致） */
        runBodyBandPass(panelEl.querySelector('#rlog-list'));
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
    toggleBtn.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i> 最近请求记录';
    toggleBtn.addEventListener('click', togglePanel);
    menu.appendChild(toggleBtn);

    /* 延迟重新 append，确保排在所有同步初始化的插件之后（appendChild 会移动已有节点） */
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

/* 抽屉切换时旧抽屉瞬时收起（跳过动画）：两个抽屉宽度叠加会先把整行撑宽再回落（左右弹跳），
   让旧的直接消失、新的照常展开即可避免。做法：禁用过渡 → 移除展开类 → 强制回流 → 恢复过渡。 */
function closeDrawerInstant(drawer, btn) {
    if (!drawer) return;
    drawer.style.transition = 'none';
    drawer.classList.remove('expanded');
    if (btn) btn.classList.remove('active-drawer-btn');
    void drawer.offsetWidth; /* 强制回流：提交瞬时收起，恢复过渡后不会补播动画 */
    drawer.style.transition = '';
}

/* 定位本插件自身的 style.css 真实地址：优先用 ST 已注入的插件样式 <link>（id 形如 "<目录>-css"），
   找不到时回退硬编码路径。不用 import.meta：ST 以 ES Module 加载时 document.currentScript 为 null，
   且逻辑测试用 Node VM 载入本文件（非 module）。 */
function getSelfCssUrl() {
    try {
        const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find(l => l.id && l.id.endsWith('RecentRequestLog-css'));
        if (link) return link.href;
    } catch (e) { /* 无 document（如逻辑测试 VM 不执行到此）或异常，走兜底 */ }
    return '/scripts/extensions/third-party/RecentRequestLog/style.css';
}

/* 影子内样式源（优先）：从 ST 已加载的本插件 style.css <link> 同步拷贝规则成影子内 <style>，
   避免 <link> 异步加载导致早期测量（如状态占位宽度探针）采不到 class 样式。
   面板影子根与浮标影子根各要一份；规则序列化走 selfCssTextCache 只做一次。 */
function buildSelfCssElement() {
    try {
        const selfCssUrl = getSelfCssUrl();
        const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find(l => l.href === selfCssUrl);
        if (link && link.sheet && link.sheet.cssRules && link.sheet.cssRules.length) {
            if (selfCssTextCache === null) {
                selfCssTextCache = [...link.sheet.cssRules].map(r => r.cssText).join('\n');
            }
            const style = document.createElement('style');
            style.textContent = selfCssTextCache;
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
    const faWoff2 = new URL('webfonts/fa-solid-900.woff2', location.href).href;
    const faTtf = new URL('webfonts/fa-solid-900.ttf', location.href).href;
    const rules = [
        /* 影子内通用基准：ST 全局 * 的 box-sizing/字体平滑等进不了影子，这里补上；
           text-shadow 是可继承属性，ST 全局 * 会经 shadow host 把主题辉光渗进来，必须重置为 none。 */
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

/* 影子内「极简模式」样式：用 :host(.rlog-minimal) 一次性关掉面板/弹窗的全部过渡与动画
   （弹窗与 #rlog-panel 平级，只有 :host 能同时兜住），保留瞬时状态反馈；去掉偏好浮层的虚化；
   显式豁免使用引导（.rlog-tour-*）。这类 :host 规则只能在 JS 运行时注入，写进 style.css 会被丢弃。 */
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
                <button id="rlog-global-search-btn" class="rlog-header-btn" title="搜索所有记录（占位）">
                    <i class="fa-solid fa-magnifying-glass"></i>
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
                                <span class="rlog-pref-label">昼夜模式跟随 ST 主题</span>
                                <div class="rlog-pref-item-desc">开启后，昼夜模式自动跟随亮暗主题切换<br>此模式下手动切换按钮不生效</div>
                            </div>
                            <button class="rlog-toggle" data-pref-key="followStTheme" role="switch" aria-checked="false" aria-label="昼夜模式跟随 ST 主题"></button>
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

    /* 面板打开期间的正文带宽维护：滚动时按需补回进入视口的正文、把离开视口的卸载掉 */
    initBodyBandMaintenance(panelEl.querySelector('#rlog-list'));

    /* 影子 DOM 隔离：宿主 + 影子根，面板与其样式放进影子，不被第三方主题 CSS 覆盖 */
    shadowHostEl = document.createElement('div');
    shadowHostEl.id = 'rlog-shadow-host';
    panelShadowRoot = shadowHostEl.attachShadow({ mode: 'open' });
    panelShadowRoot.appendChild(buildSelfCssElement());
    panelShadowRoot.appendChild(buildFaShimStyle());
    panelShadowRoot.appendChild(buildMinimalShimStyle());
    panelShadowRoot.appendChild(panelEl);
    document.body.appendChild(shadowHostEl);

    /* 浮标：独立 light DOM host（#rlog-badge-host）+ 自己的 shadow root。
       host 暴露在普通 DOM（带 script_id/role/title/class/固定定位）供第三方收纳识别；
       可见视觉在 host 的 shadow root 内（.rlog-badge-visual），第三方主题碰不到。 */
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
    /* light DOM 图标：供第三方收纳插件 querySelector(i) 读入口图标。宿主有自己的 shadow root，
       light 子元素本就不参与渲染；hidden 只是意图声明——ST 的 FA CSS 会给 .fa-solid 设 display。 */
    badgeEl.innerHTML = '<i class="fa-solid fa-clock-rotate-left" hidden></i>';

    const badgeShadowRoot = badgeEl.attachShadow({ mode: 'open' });
    /* 浮标可见视觉的样式来源：与面板影子根同款做法，把同一份 style.css 复制进影子根 */
    badgeShadowRoot.appendChild(buildSelfCssElement());
    badgeShadowRoot.appendChild(buildFaShimStyle());
    badgeVisualEl = document.createElement('div');
    badgeVisualEl.className = 'rlog-badge-visual';
    badgeVisualEl.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i>';
    badgeShadowRoot.appendChild(badgeVisualEl);
    document.body.appendChild(badgeEl);

    /* 同步浮标当前尺寸，然后交给指针交互（配色由 style.css 里挂 #rlog-badge-host 的变量提供） */
    updateBadgeSize();
    initBadgeInteraction();
    /* 浮标配色跟随 ST 亮暗主题（含后续主题切换的监听；配色取值仍在 style.css 变量总表） */
    initBadgeThemeSync();
    /* host 就绪后重放主题类（供面板/弹窗用；浮标配色由上面单独跟随 ST 主题） */
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
                clearTimeout(countClickTimer);
                countClickTimer = null;
                showMaxRecordsDialog();
                return;
            }

            countClickTimer = setTimeout(() => {
                countClickTimer = null;
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

    filterDrawer.querySelectorAll('.rlog-filter-chip').forEach((chip) => {
        chip.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFilterChip(chip.dataset.filterGroup, chip.dataset.filterValue);
        });
    });

    const filterResetBtn = panelEl.querySelector('#rlog-filter-reset-btn');
    if (filterResetBtn) {
        filterResetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            resetFilters();
        });
    }

    /* 全局搜索目前只有入口占位：点击给一条轻量提示（功能正式实现时替换本段） */
    const globalSearchBtn = panelEl.querySelector('#rlog-global-search-btn');
    if (globalSearchBtn) {
        globalSearchBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showPinToast('全局搜索请等待后续更新');
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

    /* 全局点击监听：开启「点击面板外关闭」时，点在面板外就关面板。
       影子内点击会重定向到 #rlog-shadow-host，故用 e.target === shadowHostEl ||
       e.composedPath().includes(panelEl) 判定面板内；同时放行插件自己的菜单切换按钮，
       否则用它打开面板的那次点击会立刻把面板关掉。 */
    if (!document.rlogOutsideCloseListenerInstalled) {
        document.rlogOutsideCloseListenerInstalled = true;
        document.addEventListener('click', (e) => {
            if (!preferences.clickOutside || !isPanelVisible) return;
            /* 浮标态：点面板外不清除浮标（它是用户主动收起产生的入口），点击浮标本身由浮标自己处理 */
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
            /* 没有普通记录：只给轻量提示，不弹确认弹窗、不删除任何记录 */
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

    buildSimulatePromptButton(panelEl);

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

        /* 每个 Toggle：点击翻转状态 + 持久化 + 更新入口图标态 */
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

        const prefListEl = prefOverlayEl.querySelector('.rlog-pref-list');
        if (prefListEl) {
            prefListEl.addEventListener('scroll', () => updatePrefScrollArrows(), { passive: true });
        }

        /* 遮罩点击什么都不做：它只负责盖住面板、阻断底层交互，浮层只能通过右上角 × 关闭 */
    }

    /* 加载持久化偏好并同步入口图标 + 开关视觉 */
    loadPreferences();
    updatePrefButtonIcon();
    syncPrefToggleUI();
    /* 移动端全屏：按偏好 + 当前视口设置全屏类（面板此刻 display:none，样式待展示时生效） */
    updateMobileFullscreenClass();
    /* 极简模式：按偏好给影子宿主加/去类（触发 :host 极简规则） */
    updateMinimalClass();
    /* 「昼夜模式跟随 ST 主题」：开启时静默同步到 ST 当前主题并挂上主题变化监听（此刻不播动画） */
    initPanelThemeFollow(false);
    /* 筛选状态持久化：开启时读取上次持久化的筛选覆盖默认值（须在 updateFilterChipUI 前生效） */
    loadPersistedFilterState();
    /* 「浮标默认入口」：开启时启动默认显示浮标（右上角默认位置），面板保持隐藏、非折叠态；
       badgePos 仍不持久化——刷新/重新初始化回到默认位置 */
    if (preferences.badgeDefault && badgeEl) {
        if (!badgePos) badgePos = getDefaultBadgePos();
        else badgePos = clampBadgeToViewport(badgePos.left, badgePos.top);
        badgeEl.style.left = badgePos.left + 'px';
        badgeEl.style.top = badgePos.top + 'px';
        setBadgeActive(true);
    }

    panelEl.querySelector('#rlog-theme-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        /* 「昼夜模式跟随 ST 主题」开启时手动切换不生效：按钮交互不变，只弹 toast 提示原因 */
        if (preferences.followStTheme) {
            showPinToast('请先关闭自动跟随主题');
            return;
        }
        isLightTheme = !isLightTheme;
        saveTheme(isLightTheme);
        applyTheme();
        updateThemeButtonIcon();
        playThemeSwitchAnimation();
    });
    updateThemeButtonIcon();

    const masterToggleBtn = panelEl.querySelector('#rlog-master-toggle');
    if (masterToggleBtn) {
        masterToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setMasterEnabled(!masterEnabled);
            e.target.blur();
        });
    }
    updateMasterToggleUI();

    contentPreviewEnabled = loadContentPreview();
    updatePreviewToggleUI();

    const previewToggleEl = panelEl.querySelector('#rlog-preview-btn');
    if (previewToggleEl) {
        previewToggleEl.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleContentPreview();
        });
    }

    makeDraggable(panelEl);
    makeResizable(panelEl);

    /* 视口/面板宽度变化（含桌面↔移动切换、拖拽改宽）会让记录标题栏换行高度变化，需重测吸顶偏移；
       连续 resize 由 scheduleViewportSync 合并到下一帧，一帧最多重测一次 */
    if (!window.rlogHeaderVarResizeInstalled) {
        window.rlogHeaderVarResizeInstalled = true;
        window.addEventListener('resize', scheduleViewportSync);
    }

    /* 安装来源识别监听（仅记录用户原生入口，不受总开关影响） */
    installSourceTracking();

    /* 安装主生成轮次跟踪（RQ-32 正向识别的锚点） */
    installGenerationPassTracking();
    /* 安装来源修正跟踪（RQ-32：响应落楼后的「插件 → 原生」有限提升） */
    installSourceCorrectionTracking();

    /* 安装请求拦截（fetch + XHR；内部按 masterEnabled 决定是否记录） */
    installRequestHooks();
    /* 安装同源 iframe 请求拦截 */
    installIframeRequestHooks();

    /* 同步筛选分段按钮视觉状态（引导/API 改动过状态时以实际状态为准） */
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

/* 昼/夜主题切换动画（缩放呼吸 + 主题色瞬切）：昼/夜按钮与「跟随 ST 主题」自动切换复用同一段编排。
   前提：调用前 isLightTheme 已更新、主题类已应用。
   主题色走瞬切而非逐个元素渐变：面板内消息级元素与伪元素各自带 0.35s 颜色过渡，
   逐个渐变会在切换那一帧起大量过渡、连续掉帧；切换的视觉反馈由缩放呼吸动画承担。 */
function playThemeSwitchAnimation() {
    if (!panelEl) return;
    panelEl.classList.remove('rlog-anim-light', 'rlog-anim-dark');

    /* 极简模式：主题已通过 applyTheme() 瞬时切换，跳过动画编排（也避免动画类残留） */
    if (preferences.minimal) return;

    /* 先禁用面板内所有颜色过渡：跨两帧让主题色在这两帧里一次提交成最终色，
       再摘掉禁用类、播放缩放呼吸动画 */
    panelEl.classList.add('rlog-theme-transitioning');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            panelEl.classList.remove('rlog-theme-transitioning');
            /* 这两帧内面板可能已被隐藏（关闭 / 收起为浮标）：隐藏期间不补动画类，
               否则重新显示时会从头补播一次 */
            if (!isPanelVisible || isPanelCollapsed) return;
            if (isLightTheme) {
                panelEl.classList.add('rlog-anim-light');
            } else {
                panelEl.classList.add('rlog-anim-dark');
            }
            /* 动画结束后清除动画类，防止关闭再打开窗口时重播 */
            const onAnimEnd = () => {
                panelEl.classList.remove('rlog-anim-light', 'rlog-anim-dark');
                panelEl.removeEventListener('animationend', onAnimEnd);
            };
            panelEl.addEventListener('animationend', onAnimEnd);
        });
    });
}

function togglePanel() {
    isPanelVisible ? hidePanel() : showPanel();
}

/* 面板隐藏前（关闭面板 / 收起为浮标）清掉正在播的动画类、取消待触发的闪烁。
   元素隐藏期间动画不推进、也不派发 animationend，类留着会在重新显示时从头补播；
   两条隐藏路径共用这里，保证清理行为一致。
   rlog-theme-transitioning 本来由双 rAF 摘除，若恰好在这两帧内被隐藏也一并清掉。 */
function clearPanelAnimations() {
    if (!panelEl) return;
    clearHeaderFlash(panelEl);   /* 清闪烁类 + 取消面板内待触发的置底闪烁 */
    cancelPendingFlash();        /* 兜底：待触发目标已被重建/移出面板时同样清掉定时器 */
    panelEl.classList.remove('rlog-anim-light', 'rlog-anim-dark', 'rlog-theme-transitioning');
}

function showPanel() {
    if (!panelEl) buildUI();
    /* 兜底：确保从浮标/折叠态回到展开面板 */
    setBadgeActive(false);
    panelEl.classList.remove('rlog-window-collapsed');
    isPanelCollapsed = false;
    /* 「浮标默认入口」：重新打开面板一律回到插件默认位置/尺寸（两个打开路径统一）；
       非默认入口维持原展示位置 */
    if (preferences.badgeDefault) resetPanelToDefault();
    panelEl.style.display = 'flex';
    isPanelVisible = true;
    /* 移动端全屏：偏好开启 + 移动端视口才生效 */
    updateMobileFullscreenClass();
    if (toggleBtn) toggleBtn.classList.add('active');
    /* 仅当数据/渲染设置变化时才重建 DOM；否则保留原有 DOM，避免大量展开消息时打开面板卡顿 */
    if (panelContentDirty) {
        renderPanelContent();
    }
    /* 面板显示后重测记录标题栏高度：隐藏状态下 offsetHeight 为 0，吸顶偏移需以可见高度为准 */
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

    /* 重新显示面板不会触发 scroll 事件，主动跑一次带宽维护：
       按当前视口（含上面刚做过的回顶）补回需要的正文、把远处的卸载掉 */
    runBodyBandPass(panelEl.querySelector('#rlog-list'));

    /* 面板显示后检查是否需要进行引导 */
    if (window.__RLogTour && typeof window.__RLogTour.check === 'function') {
        setTimeout(() => window.__RLogTour.check(), 300);
    }
}

function hidePanel() {
    /* 关闭面板时退出搜索模式 */
    resetSearchIfActive();
    /* 关闭面板时隐藏置顶/取消置顶 toast */
    hidePinToast();
    /* 关闭面板时隐式清理「查看全文」覆盖层（如存在） */
    closeReadFullOverlay();
    /* 关闭面板时同时收起「偏好设置」浮层，避免浮层开着时关面板、重开仍残留打开态 */
    closePrefPanel();
    /* 关闭前趁布局仍然有效，把视口外的正文一次性卸载（实测约 3ms）：
       重新打开时只需为可见部分付排版与绘制，不再为全部已展开正文买单。
       必须排在 resetSearchIfActive() 之后——搜索高亮先还原成纯文本，这里才不会卸掉带 <mark> 的正文 */
    runBodyBandPass(panelEl ? panelEl.querySelector('#rlog-list') : null);
    isPanelCollapsed = false;
    if (panelEl) {
        /* 清理播放中的动画类（闪烁 / 主题切换），防止下次打开时重播 */
        clearPanelAnimations();
        panelEl.classList.remove('rlog-window-collapsed');
        panelEl.style.display = 'none';
    }
    isPanelVisible = false;
    if (toggleBtn) toggleBtn.classList.remove('active');
    /* 「浮标默认入口」：关闭面板后浮标回到 badgePos（为空则用右上默认位置），仍不持久化；
       非默认入口保持原状——面板完全关闭、浮标消失 */
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
        /* 锚定左/上边缘：面板默认水平居中（left:50% + translateX(-50%)），只改 width 会左右对称
           移动；改为 left/top 定位后缩放只影响右/下边缘 */
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
            /* 面板宽度变化也会改变正文换行宽度 → 让带宽维护按新几何重建占位高度 */
            scheduleBodyBandPass(panelEl && panelEl.querySelector('#rlog-list'));
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
            /* 触屏拖动缩放同理：宽度变了就按新几何重建占位高度 */
            scheduleBodyBandPass(panelEl && panelEl.querySelector('#rlog-list'));
        }
    });
})();

/* 浮标拖拽/点击交互（Pointer Events 统一鼠标与触屏）：位移 > BADGE_DRAG_THRESHOLD 视为拖动，
   pointerup 时不恢复面板；未达到阈值视为点击，恢复面板 */
function initBadgeInteraction() {
    if (!badgeEl) return;
    /* 点浮标恢复面板后浮标隐藏、同坐标出现面板，浏览器随后派发的原生 click 会 hit-test 到该位置的
       面板按钮/标题上（误开抽屉或误触折叠）；用捕获阶段的一次性守卫按标记拦掉 */
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
        /* 未拖动：打开面板交给随后的 click 阶段处理——让浮标在整个 click 派发期间保持可见，
           面板打开延后到 click 之后，两者不会互相误接同一次 click */
        dragged = false;
    };
    badgeEl.addEventListener('pointerup', onBadgeUp);
    badgeEl.addEventListener('pointercancel', onBadgeUp);
    /* 浮标 click（含第三方对 host 直接触发的原生 click）：把「打开面板」延后到本次 click
       全部派发完之后，保持浮标在该阶段可见；不主动 stopPropagation */
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
    /* 浮标访问（测试辅助）：light DOM host 可用 document 查到（视觉在其 shadow root 内），
       可见视觉元素用 getBadgeVisualEl() 获取 */
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
    /* 重置筛选（供引导/回归测试/外部调用）：引导开始时用它把筛选重置为全开以展示 demo，故不落盘；
       用户手动重置走界面按钮 resetFilters()（默认持久化） */
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

/* ── 临时测试功能（仅控制台调试函数） ────── */

/* number|null: 临时调试：覆盖回复超时时长（供 simulateReplyTimeout 模拟测试用，后续删除） */
let replyTimeoutOverrideMs = null;

/* 一键注入全部测试数据（临时功能，后续删除）：8 条 Token 区间记录 + 成功/失败回复模拟 +
   一次 2 秒超时收尾；入口统一为控制台 __RLogApi.injectTokenTierTest()（原「更多」抽屉烧瓶按钮
   的功能已移到这里，行为不变：注入后同样收起「更多」抽屉） */
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

        /* 注入后收起「更多」抽屉，展示测试记录（与原烧瓶按钮点击行为一致） */
        closeMoreDrawer();
    };
    /* 临时调试功能（后续删除）：模拟回复超时——把 5 分钟缩短成 2 秒，走真实超时收尾流程
       @param {object} [opts] { reasoning, content } @returns {number|null} captureId */

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

/* ── 模拟提示词（真实组装，不发请求） ─────── */

/* 模拟记录的来源标记：与真实捕获记录区分（真实记录来自网络层拦截） */
const SIMULATED_PROMPT_SOURCE = { type: 'plugin', label: '模拟', detail: '模拟记录-未实际发送' };

/* string: 未连接时临时把 ST 连接状态置成这个值，好让真实组装链路能跑（跑完还原原值）；
   取一个非 no_connection 的说明性文字，状态栏瞬时显示时也能看出是模拟 */
const SIMULATE_ONLINE_STATUS = '模拟预览';

/* 取 ST 当前聊天补全模型名（模拟记录的模型名回退用；取不到返回 null） */
function getStChatCompletionModelName() {
    try {
        const ctx = window.SillyTavern && typeof window.SillyTavern.getContext === 'function'
            ? window.SillyTavern.getContext()
            : null;
        const name = ctx && typeof ctx.getChatCompletionModel === 'function' ? ctx.getChatCompletionModel() : null;
        return (typeof name === 'string' && name) ? name : null;
    } catch (e) {
        return null;
    }
}

/* 建一次模拟的捕获上下文（fetch 包装认领目标请求后一路传进记录管线）：
   - armed：发前通知一到置真，包装据此认出本次模拟那条、认领后置回假；
   - canceled：超时判失败置真，记录管线建档前查它；
   - ready / settle：记录已建好的完成信号（只兑现一次；没建成记录兑现空值，模拟流程按失败处理） */
function createSimulateCaptureCtx() {
    let settle = null;
    const captureCtx = {
        armed: false,
        canceled: false,
        ready: null,
        settle(record) {
            const resolve = settle;
            settle = null;
            if (typeof resolve === 'function') {
                try { resolve(record || null); } catch (e) { /* ignore */ }
            }
        },
    };
    captureCtx.ready = new Promise((resolve) => { settle = resolve; });
    return captureCtx;
}

/* 组装当前提示词并生成一条模拟记录（绝不发出真实生成请求）。
   走 ST 真实发送链路，让「压缩系统消息 / 生成拦截器 / 发前钩子 / 提示词管理器条目 / 世界书 / 正则」
   全部照常生效；请求拼好走到 fetch 层时由本插件自己的记录管线建档，然后再阻断发送。
   发前通知（聊天补全 CHAT_COMPLETION_SETTINGS_READY / 其它 API GENERATE_AFTER_DATA）一到即
   武装本次模拟的目标请求，并在同一通知里 stopGeneration()：既让 ST 把这次当「用户中止」处理，
   也作为「绝不发网络」的兜底。
   `automatic_trigger: true` 只关掉 ST「把输入框内容插成用户消息」那两个分支（不含其它逻辑），
   因此不会产生楼层、不会落盘；输入框里的草稿改为我们自己以纯内存对象临时放进 chat，
   让正则 / 世界书 / 拦截器都能看到它。所有临时改动都在 finally 里逐项还原。
   全程有兜底超时（SIMULATE_TIMEOUT_MS）：到点停止组装链路、替换 toast，并丢弃本次结果。 */
async function captureSimulatedPrompt() {
    if (simulatePromptRunning) return;
    if (!masterEnabled) {
        showPinToast('记录功能已关闭，无法生成模拟记录');
        return;
    }
    const ctx = window.SillyTavern && typeof window.SillyTavern.getContext === 'function'
        ? window.SillyTavern.getContext()
        : null;
    if (!ctx || typeof ctx.generate !== 'function' || !ctx.eventSource || !ctx.eventTypes || typeof ctx.stopGeneration !== 'function') {
        showPinToast('模拟失败：未找到 ST 生成接口');
        return;
    }
    /* 群聊的真实链路会走「多角色批量生成」，可能真的发出请求，故不支持 */
    if (ctx.groupId) {
        showPinToast('模拟暂不支持群聊');
        return;
    }
    if (ctx.streamingProcessor) {
        showPinToast('模拟失败：当前有生成正在进行');
        return;
    }

    /* 进入模拟：置运行标志、置灰按钮、显示常驻进度 toast，并启动全程兜底超时 */
    simulatePromptRunning = true;
    setSimulateButtonDisabled(true);
    showPinToast('模拟并拦截中，请稍候（不会实际发送）', { persist: true });

    /* 本次模拟的捕获上下文：贯穿「武装 → 认领建档 → 完成信号」整条链路 */
    let timedOut = false;
    const captureCtx = createSimulateCaptureCtx();
    simulateCaptureCtx = captureCtx;

    const timeoutTimer = setTimeout(() => {
        timedOut = true;
        /* 超时＝失败：后到的结果一律丢弃（记录管线建档前会查这个标记），并结束等待 */
        captureCtx.canceled = true;
        /* 掐断 ST 组装链路；期间 fetch 硬拦仍生效 */
        try { ctx.stopGeneration(); } catch (e) { /* ignore */ }
        showPinToast('模拟失败：生成模拟记录超时');
        captureCtx.settle(null);
    }, SIMULATE_TIMEOUT_MS);

    try {
        await runSimulatedPromptCapture(ctx, () => timedOut, captureCtx);
    } finally {
        clearTimeout(timeoutTimer);
        simulateCaptureCtx = null;
        captureCtx.armed = false;
        /* 收尾后即便还有迟到的记录管线在跑，也不再落记录 */
        captureCtx.canceled = true;
        simulatePromptRunning = false;
        simulatePromptActive = false;
        setSimulateButtonDisabled(false);
    }
}

/* 模拟流程主体（前置检查通过后调用）：真实组装 + 武装目标请求 + fetch 层建档 + 还原。
   @param {object} ctx ST context
   @param {() => boolean} isTimedOut 兜底超时是否已触发；触发后丢弃本次结果
   @param {object} captureCtx 本次模拟的捕获上下文（武装 / 取消 / 完成信号，见 createSimulateCaptureCtx） */
async function runSimulatedPromptCapture(ctx, isTimedOut, captureCtx) {
    /* —— 快照（finally 里逐项还原） —— */
    const meta = ctx.chatMetadata;
    const hadTainted = !!(meta && Object.prototype.hasOwnProperty.call(meta, 'tainted'));
    const taintedValue = hadTainted ? meta.tainted : undefined;
    const textarea = document.querySelector('#send_textarea');
    const savedDraft = textarea ? String(textarea.value || '') : '';

    /* 草稿以纯内存对象临时进 chat（不渲染、不分配 mesid、不发事件、不落盘） */
    const injectedMessage = savedDraft.length > 0 ? {
        name: ctx.name1,
        is_user: true,
        is_system: false,
        send_date: Date.now(),
        mes: typeof ctx.substituteParams === 'function' ? ctx.substituteParams(savedDraft) : savedDraft,
        extra: {},
    } : null;

    const isChatCompletion = ctx.mainApi === 'openai';
    /* 发前通知 = 「请求已拼好、马上要发包」：武装本次模拟的目标请求；同时中止真实发送
      （fetch 会因 signal 已中止而直接失败，作为「绝不发网络」的兜底） */
    const onBeforeSend = () => {
        /* 迟到的通知（模拟已收尾，例如超时之后才发出）不再武装，只做中止 */
        if (simulatePromptActive) captureCtx.armed = true;
        ctx.stopGeneration();
    };
    const onChatSettingsReady = () => onBeforeSend();
    const onAfterData = () => onBeforeSend();

    /* 未连接时，ST 会在组装前直接 return；这里临时把连接状态改成非 no_connection 以放行，
       跑完在 finally 还原原值。拿不到 setOnlineStatus（内部接口）就回退为「无法模拟」提示。 */
    const previousOnlineStatus = ctx.onlineStatus;
    let forcedOnlineModule = null;
    if (previousOnlineStatus === 'no_connection') {
        try {
            const scriptModule = await import('/script.js');
            if (scriptModule && typeof scriptModule.setOnlineStatus === 'function') {
                scriptModule.setOnlineStatus(SIMULATE_ONLINE_STATUS);
                forcedOnlineModule = scriptModule;
            }
        } catch (e) {
            forcedOnlineModule = null;
        }
        if (!forcedOnlineModule) {
            showPinToast('模拟失败：ST 当前未连接 API');
            return;
        }
    }

    /* 超时可能发生在动态引入 / 等待期间：不再进入组装 */
    if (isTimedOut()) return;

    simulatePromptActive = true;
    try {
        if (isChatCompletion) ctx.eventSource.on(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY, onChatSettingsReady);
        else ctx.eventSource.on(ctx.eventTypes.GENERATE_AFTER_DATA, onAfterData);

        if (injectedMessage) ctx.chat.push(injectedMessage);

        /* automatic_trigger 只跳过「插入用户消息」两分支；ST 自己会读取并清空输入框，finally 还原 */
        await ctx.generate('normal', { automatic_trigger: true });
    } catch (e) {
        /* 中止 / 硬拦导致的失败属预期路径，记录到控制台即可，不向用户报错 */
        console.debug(`[${PLUGIN_KEY}] 模拟提示词链路结束`, e);
    } finally {
        /* —— 不论成功、中止还是异常，逐项还原，绝不遗漏 —— */
        try { ctx.eventSource.removeListener(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY, onChatSettingsReady); } catch (e) { /* ignore */ }
        try { ctx.eventSource.removeListener(ctx.eventTypes.GENERATE_AFTER_DATA, onAfterData); } catch (e) { /* ignore */ }

        const injectedIndex = injectedMessage ? ctx.chat.lastIndexOf(injectedMessage) : -1;
        if (injectedIndex !== -1) ctx.chat.splice(injectedIndex, 1);

        if (textarea) {
            textarea.value = savedDraft;
            try { textarea.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* ignore */ }
        }
        if (meta) {
            if (hadTainted) meta.tainted = taintedValue;
            else delete meta.tainted;
        }

        /* 还原真实链路开头动过的发送 / 滑动 / 停止按钮与 is_send_press */
        try { if (typeof ctx.activateSendButtons === 'function') ctx.activateSendButtons(); } catch (e) { /* ignore */ }

        /* 还原临时改过的连接状态（仅在仍是我们塞进去的值时还原，避免覆盖 ST 期间的真实状态更新） */
        if (forcedOnlineModule) {
            try {
                const liveStatus = window.SillyTavern && typeof window.SillyTavern.getContext === 'function'
                    ? window.SillyTavern.getContext().onlineStatus
                    : null;
                if (liveStatus === SIMULATE_ONLINE_STATUS) forcedOnlineModule.setOnlineStatus(previousOnlineStatus);
            } catch (e) { /* ignore */ }
        }

        simulatePromptActive = false;
    }

    /* 超时后丢弃本次结果：状态已在上面还原，不再等记录、不再改 toast */
    if (isTimedOut()) return;

    /* 等 fetch 层把这条模拟请求记完：由记录管线在建档当刻兑现；
       兜底超时到点同样结束等待（此时按失败处理） */
    const record = await captureCtx.ready;
    if (isTimedOut()) return;
    if (!record) {
        showPinToast('模拟失败：没有拿到可用的提示词数据');
        return;
    }
    showPinToast('已生成模拟记录（未实际发送，仅供参考）');
}

/* 模拟按钮：追加到「更多」抽屉末尾，点击组装当前提示词并生成一条模拟记录（不发送请求） */
function buildSimulatePromptButton(panelEl) {
    const btn = document.createElement('button');
    btn.id = 'rlog-simulate-btn';
    btn.className = 'rlog-header-btn';
    btn.title = '生成模拟记录（不实际发送）';
    btn.innerHTML = '<i class="fa-solid fa-vial"></i>';
    /* 追加到抽屉末尾（保证顺序：总开关-引导-偏好设置-预览-清空-昼夜-模拟） */
    const drawer = panelEl.querySelector('#rlog-more-drawer');
    if (drawer) drawer.appendChild(btn);
    btn.addEventListener('click', (e) => {
        /* 拦住冒泡：点击事件会穿透影子根、被 document 上的「点外部收起抽屉」监听当成面板外点击 */
        e.stopPropagation();
        captureSimulatedPrompt().catch((err) => {
            console.debug(`[${PLUGIN_KEY}] 模拟提示词失败`, err);
            showPinToast('模拟失败：发生未预期的错误');
        });
    });
}

/* 模拟进行中把按钮置灰（视觉上表示不可重复触发；真正的拦截由 simulatePromptRunning 保证） */
function setSimulateButtonDisabled(disabled) {
    if (!panelEl) return;
    const btn = panelEl.querySelector('#rlog-simulate-btn');
    if (btn) btn.disabled = !!disabled;
}
