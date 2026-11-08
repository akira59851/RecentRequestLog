/* ============================================================
   最近请求记录 (Recent Request Log) — 使用引导模块（Product Tour）
   ============================================================ */

/* 【区块索引】（按文件从上到下的顺序）
   1. 可调参数          引导交互的数值常量（延时、边距等），调参只改这里
   2. 状态变量          引导运行期间的内存状态（当前步、UI 元素引用、记录备份等）
   3. 面板访问助手      经 __RLogApi 走影子根取面板节点 / 在面板内查询
   4. 引导步骤配置      10 个引导步骤的声明：目标元素、文案、行为引用（新增步骤改这里）
   5. 步骤行为辅助函数  步骤配置引用的具名动作（开/关抽屉、预览、搜索），与步骤一一对应
   6. 版本检查与启动    获取 manifest 版本号，与服务器「已看版本」比对后决定是否展示引导
   7. 引导生命周期      开始 / 结束 / 切换步骤，含引导期间真实记录的备份与恢复
   8. UI 创建与展示     遮罩 / 高亮框 / 气泡的创建，气泡内容构建与事件绑定
   9. 高亮与气泡定位    高亮框与气泡的几何位置计算（positionElements）
   10. 对外 API         暴露给 index.js 调用的 window.__RLogTour
   ============================================================ */

(function () {
    /* ── 可调参数 ───────────────────────────────────────────── */
    /* 与 CSS 变量总表对应：引导交互的数值集中在这里。 */
    const START_DELAY_MS = 100;          /* 引导开始等待延时：先等 DOM 与过渡动画稳定，再显示第一步 */
    const TARGET_RETRY_DELAY_MS = 100;   /* 目标元素重试延时：找不到目标元素（如搜索框动态创建）时的重试间隔 */
    const TARGET_RETRY_MAX = 3;          /* 目标元素最大重试次数：超过后跳过该步，避免 DOM 一直未就绪时卡住引导 */
    const HIGHLIGHT_PADDING_DEFAULT = 4; /* 高亮框默认内边距：高亮框比目标元素向外扩展的像素数（步骤里可单独覆盖） */
    const TOOLTIP_ARROW_GAP = 8;         /* 气泡与目标元素的间距：气泡小三角到目标边缘的距离（px） */
    const TOOLTIP_EDGE_MARGIN = 10;      /* 气泡防溢出边距：气泡贴近面板左右边缘时的最小留白（px） */
    const ARROW_EDGE_LIMIT = 24;         /* 小三角距气泡边缘限制：防止小三角长在圆角外面或浮空（px） */
    const DIM_MASK_ID = 'rlog-tour-dim-mask';

    /* ⚠️ 兜底版本号：仅当获取 manifest.json 失败时才使用，语义与插件版本号无关。
       不要随插件发布版本更新此值！此值表示「最后一次成功加载的引导版本」的兜底：
       - 若误改为新版本号（如 1.8.0），manifest 获取失败时会被误判为「已看过新引导」而跳过展示。
       - 保持旧值（1.6.0）是为了在 manifest 获取失败时触发引导展示，避免用户完全看不到新功能引导。 */
    let currentTourVersion = '1.6.0'; /* 兜底版本号（勿随插件版本更新，见上方说明） */
    /* ── 状态变量 ───────────────────────────────────────────── */
    let currentStep = 0;
    let overlay = null;
    let dimLayer = null;
    let tooltip = null;
    let highlightBox = null;
    let isActive = false;
    /* 引导开始前备份的真实记录列表（引导期间清空列表，结束后恢复） */
    let savedRecords = null;
    /* 引导开始前备份的筛选状态（引导期间重置为全开，结束后恢复） */
    let savedFilterState = null;
    /* 查找目标元素的失败重试计数（避免 DOM 尚未就绪时被跳过） */
    let findTargetRetryCount = 0;

    /* ── 面板访问助手 ──────────────────────────────────────── */
    /* 面板已挂进影子根（#rlog-shadow-host 的 open shadow root），document 整页查找不到，
       统一从这里经 index.js 暴露的 __RLogApi 取面板节点 / 影子根内查询。 */
    function getPanel() {
        return window.__RLogApi && typeof window.__RLogApi.getPanelEl === 'function'
            ? window.__RLogApi.getPanelEl()
            : null;
    }
    function q(sel) {
        return window.__RLogApi && typeof window.__RLogApi.q === 'function'
            ? window.__RLogApi.q(sel)
            : null;
    }

    /* ── 引导步骤配置 ───────────────────────────────────────── */
    /* 每个步骤 = 目标元素 + 文案 + 可选项；需要行为（开抽屉/预览/搜索等）的步骤
       引用下方「步骤行为辅助函数」区里的具名函数。 */
    const steps = [
        {
            targetSelector: '.rlog-header-actions',
            desc: '<strong>主标题栏按钮区：</strong><br>生成模拟记录｜功能抽屉｜窗口控制'
        },
        {
            targetSelectors: ['#rlog-filter-btn', '.rlog-filter-controls'],
            tooltipTargetSelector: '.rlog-filter-controls',
            targetHighlightAdjustments: {
                1: { offsetY: 2 },
            },
            desc: '<strong>筛选记录：</strong><br>按来源｜按模型｜按角色',
            onEnter: enterFilterDrawerStep,
            onLeave: leaveFilterDrawerStep
        },
        {
            targetSelectors: ['#rlog-global-search-btn', '.rlog-global-search-controls'],
            tooltipTargetSelector: '.rlog-global-search-controls',
            targetHighlightAdjustments: {
                1: { offsetY: 2 },
            },
            desc: '<strong>全局搜索：</strong><br>输入关键字，手动点击搜索开始<br>搜索按钮变为更新时，点击可刷新结果<br>点击序号输入数字可快速跳转',
            onEnter: enterGlobalSearchStep,
            onLeave: leaveGlobalSearchStep
        },
        {
            targetSelectors: ['#rlog-more-btn', '.rlog-more-controls'],
            tooltipTargetSelector: '.rlog-more-controls',
            targetHighlightAdjustments: {
                1: { offsetY: 2 },
            },
            desc: '<strong>更多选项：</strong><br>开关与引导｜设置与显示｜批量操作',
            onEnter: enterDrawerStep,
            onLeave: leaveDrawerStep
        },
        {
            targetSelector: '.rlog-record[data-record-index="0"] .rlog-record-info',
            desc: '<strong>记录标题栏：</strong><br>角色名｜来源｜时间戳｜模型｜token总数 [消息条数]<br>长按可置顶 / 取消置顶'
        },
        {
            targetSelector: '.rlog-record[data-record-index="0"] .rlog-record-actions-inner',
            desc: '<strong>记录展开时显示：</strong><br>搜索｜全部展开 / 折叠｜快速置底｜<br>查看全文（原始JSON、复制与导出）<br>｜删除'
        },
        {
            targetSelector: '.rlog-search-box',
            desc: '<strong>单条记录内搜索：</strong><br>点击 🔍︎ 进入搜索模式，再次点击退出<br>输入关键字自动搜索<br>点击序号输入数字可快速跳转',
            /* 自定义高亮框：左边缘对齐放大镜按钮左边缘，上下裁剪点击防护区 */
            highlightAdjust: {
                leftAlignTo: '.rlog-search-btn',
                topExtra: 8,
                bottomExtra: 8
            },
            onEnter: enterSearchStep,
            onLeave: leaveSearchStep
        },
        {
            targetSelector: '.rlog-record[data-record-index="0"] .rmsg-item .rmsg-preview-text',
            desc: '<strong>内容预览：</strong><br>在更多选项中开启，将展示消息开头部分文字',
            onEnter: enterPreviewStep,
            onLeave: leavePreviewStep
        },
        {
            targetSelectors: [
                '.rlog-record[data-record-index="0"] .rmsg-item.role-system .rmsg-read-btn',
                '.rlog-record[data-record-index="0"] .rmsg-item.role-system .rmsg-copy-btn',
            ],
            combineTargets: true,
            desc: '<strong>角色消息展开时显示：</strong><br>长消息独立阅读（≥800 tokens 出现）｜复制单条消息'
        },
        {
            targetSelector: '.rlog-record[data-record-index="0"] .rmsg-item.role-response .rmsg-response-meta',
            placement: 'top',
            desc: '<strong>响应信息：</strong><br>首字｜TPS｜耗时<br>点击 ⓘ 查看更多详情'
        }
    ];

    /* ── 步骤行为辅助函数 ───────────────────────────────────── */
    /* 抽屉步骤：进入时打开「更多选项」抽屉、离开时关闭。
       通过临时禁用 transition + 强制回流，让抽屉瞬间到位，避免高亮框位置跳动。 */
    function setDrawerState(open) {
        const drawer = q('#rlog-more-drawer');
        if (drawer) drawer.style.transition = 'none';
        const api = window.__RLogApi;
        const action = api && (open ? api.openDrawer : api.closeDrawer);
        if (action) {
            action.call(api);
        }
        if (drawer) {
            void drawer.offsetWidth;
            drawer.style.transition = '';
        }
    }

    function enterDrawerStep() {
        setDrawerState(true);
    }

    function leaveDrawerStep() {
        setDrawerState(false);
    }

    /* 筛选抽屉步骤：进入时打开「筛选」抽屉、离开时关闭 */
    function setFilterDrawerState(open) {
        const drawer = q('#rlog-filter-drawer');
        if (drawer) drawer.style.transition = 'none';
        const api = window.__RLogApi;
        if (api && typeof api.setFilterDrawer === 'function') {
            api.setFilterDrawer(open);
        }
        if (drawer) {
            void drawer.offsetWidth;
            drawer.style.transition = '';
        }
    }

    function enterFilterDrawerStep() {
        setFilterDrawerState(true);
    }

    function leaveFilterDrawerStep() {
        setFilterDrawerState(false);
    }

    /* 全局搜索抽屉步骤：进入时打开抽屉并演示一次关键词搜索，离开时关闭并清理结果 */
    function setGlobalSearchDrawerState(open) {
        const drawer = q('#rlog-global-search-drawer');
        if (drawer) drawer.style.transition = 'none';
        const api = window.__RLogApi;
        if (api && typeof api.setGlobalSearchDrawer === 'function') {
            api.setGlobalSearchDrawer(open);
        }
        if (drawer) {
            void drawer.offsetWidth;
            drawer.style.transition = '';
        }
    }

    function enterGlobalSearchStep() {
        setGlobalSearchDrawerState(true);
        const inputEl = q('#rlog-global-search-input');
        if (inputEl) inputEl.value = '示例';
        if (window.__RLogApi && typeof window.__RLogApi.performGlobalSearch === 'function') {
            window.__RLogApi.performGlobalSearch();
        }
    }

    function leaveGlobalSearchStep() {
        setGlobalSearchDrawerState(false);
    }

    /* 内容预览步骤：进入时只展开用于预览的演示消息并开启预览，其他消息沿用原折叠状态 */
    function enterPreviewStep() {
        if (window.__RLogApi && window.__RLogApi.prepareDemoPreview) {
            window.__RLogApi.prepareDemoPreview();
        }
        if (window.__RLogApi && window.__RLogApi.forcePreview) {
            window.__RLogApi.forcePreview(true);
        }
    }

    function leavePreviewStep() {
        if (window.__RLogApi && window.__RLogApi.forcePreview) {
            window.__RLogApi.forcePreview(false);
        }
    }

    /* 搜索步骤：进入时打开搜索框并搜索「示例」，离开时关闭搜索 */
    function enterSearchStep() {
        /* 注意：不要在 openSearchForRecord 之前或之后调用 prepareDemoPreview/injectDemo 等方法，
           它们会触发 renderPanelContent() → resetSearchIfActive() 移除刚创建的搜索框。 */
        if (window.__RLogApi && typeof window.__RLogApi.openSearchForRecord === 'function') {
            window.__RLogApi.openSearchForRecord(0);
        }
        /* 设置输入框内容（performSearch 只更新 searchState，不会写回 input.value） */
        const searchBox = q('#rlog-panel .rlog-search-box');
        const inputEl = searchBox ? searchBox.querySelector('.rlog-search-input') : null;
        if (inputEl) {
            inputEl.value = '示例';
        }
        if (window.__RLogApi && typeof window.__RLogApi.performSearch === 'function') {
            window.__RLogApi.performSearch(0, '示例');
        }
    }

    function leaveSearchStep() {
        if (window.__RLogApi && typeof window.__RLogApi.closeSearch === 'function') {
            window.__RLogApi.closeSearch();
        }
    }

    /* ── 版本检查与启动 ─────────────────────────────────────── */
    /* 动态获取 manifest.json 的版本号并写入 currentTourVersion；
       获取失败时保持兜底版本（见上方「兜底版本号」说明）。 */
    async function loadManifestVersion() {
        try {
            let manifestUrl = '/scripts/extensions/third-party/RecentRequestLog/manifest.json';
            const scripts = document.getElementsByTagName('script');
            for (let i = 0; i < scripts.length; i++) {
                if (scripts[i].src && scripts[i].src.includes('RecentRequestLog/tour.js')) {
                    manifestUrl = scripts[i].src.replace('tour.js', 'manifest.json');
                    break;
                }
            }

            const response = await fetch(`${manifestUrl}?t=${Date.now()}`, { cache: 'no-cache' });
            if (response.ok) {
                const manifest = await response.json();
                if (manifest && manifest.version) {
                    currentTourVersion = manifest.version;
                }
            }
        } catch (e) {
            console.warn('[RecentRequestLog] 获取 manifest.json 版本号失败，使用兜底版本', e);
        }
    }

    function getSavedTourVersion() {
        return window.__RLogApi && typeof window.__RLogApi.getTourVersion === 'function'
            ? window.__RLogApi.getTourVersion()
            : '';
    }

    function saveTourVersion(version) {
        if (window.__RLogApi && typeof window.__RLogApi.setTourVersion === 'function') {
            window.__RLogApi.setTourVersion(version);
        }
    }

    /* 比对「已看版本」与「manifest 当前版本」：不一致（或 force）时开始引导。 */
    async function checkAndStartTour(force = false) {
        await loadManifestVersion();
        const savedVersion = getSavedTourVersion();
        if (force || savedVersion !== currentTourVersion) {
            startTour();
        }
    }

    /* ── 引导生命周期 ───────────────────────────────────────── */
    function startTour() {
        if (isActive) return;

        const panel = getPanel();
        if (!panel || panel.style.display === 'none') return;

        /* 收起三个抽屉，避免残留展开状态影响步骤定位 */
        if (window.__RLogApi) {
            if (typeof window.__RLogApi.closeDrawer === 'function') {
                window.__RLogApi.closeDrawer();
            }
            if (typeof window.__RLogApi.setFilterDrawer === 'function') {
                window.__RLogApi.setFilterDrawer(false);
            }
            if (typeof window.__RLogApi.setGlobalSearchDrawer === 'function') {
                window.__RLogApi.setGlobalSearchDrawer(false);
            }
        }

        isActive = true;
        currentStep = 0;

        /* 引导期间只展示 demo、不展示真实记录（demo 置于第 0 条，带 data-record-index="0"
           的步骤都作用于它），真实记录与筛选状态先备份、结束后由 endTour 恢复。
           这样各步骤的 DOM 完全可控，避免最后一步「复制单条消息」定位到真实记录而错位。 */
        if (window.__RLogApi) {
            const api = window.__RLogApi;
            /* 备份筛选状态并重置为全开：demo 记录必须可见，引导步骤定位才可靠 */
            if (typeof api.getFilterState === 'function') {
                savedFilterState = api.getFilterState();
            }
            if (typeof api.resetFilters === 'function') {
                api.resetFilters();
            }
            if (typeof api.records === 'function') {
                savedRecords = api.records() || [];
            } else {
                savedRecords = [];
            }
            if (typeof api.setTourActive === 'function') {
                api.setTourActive(true);
            }
            if (typeof api.setRecords === 'function') {
                api.setRecords([]);
            }
            if (typeof api.injectDemo === 'function') {
                api.injectDemo();
            }
        }

        createUI();

        setTimeout(() => {
            executeStep(currentStep);
        }, START_DELAY_MS);
    }

    function endTour() {
        if (!isActive) return;

        if (steps[currentStep] && typeof steps[currentStep].onLeave === 'function') {
            steps[currentStep].onLeave();
        }

        isActive = false;

        saveTourVersion(currentTourVersion);

        if (overlay) overlay.remove();
        if (dimLayer) dimLayer.remove();
        if (tooltip) tooltip.remove();
        if (highlightBox) highlightBox.remove();

        overlay = null;
        dimLayer = null;
        tooltip = null;
        highlightBox = null;

        /* 恢复引导前的记录列表 + 引导期间暂存的新记录（新记录在前、旧记录在后，符合「最新在上」）。
           用 requestAnimationFrame 延后到下一帧：让引导 UI 的移除先完成渲染（立即反馈），
           再做重量级的列表恢复，避免点击「完成」后同步阻塞 UI。 */
        if (savedRecords !== null && window.__RLogApi && typeof window.__RLogApi.setRecords === 'function') {
            const recordsBeforeTour = savedRecords;
            savedRecords = null;
            requestAnimationFrame(() => {
                const api = window.__RLogApi;
                if (api && typeof api.setRecords === 'function') {
                    /* 延迟到恢复前一刻再取，避免 rAF 间隙中新到达的记录被旧列表覆盖丢失 */
                    let pendingRecords = [];
                    if (typeof api.drainTourPendingRecords === 'function') {
                        pendingRecords = api.drainTourPendingRecords();
                    }
                    /* 有新记录时与正常 addRecord 一致：折叠所有已有记录（只折叠记录本身，
                       子消息展开状态不变）；无新记录时保持引导前状态原样恢复。 */
                    if (pendingRecords.length > 0) {
                        recordsBeforeTour.forEach(r => { r.collapsed = true; });
                    }
                    api.setRecords(pendingRecords.concat(recordsBeforeTour));
                    if (savedFilterState !== null && typeof api.setFilterState === 'function') {
                        api.setFilterState(savedFilterState);
                        savedFilterState = null;
                    }
                }
                /* 恢复完成后再解除引导状态，此后新记录按正常逻辑直接加入列表 */
                if (api && typeof api.setTourActive === 'function') {
                    api.setTourActive(false);
                }
            });
        } else {
            savedRecords = null;
            savedFilterState = null;
            if (window.__RLogApi && typeof window.__RLogApi.setTourActive === 'function') {
                window.__RLogApi.setTourActive(false);
            }
        }
    }

    function executeStep(nextIndex) {
        if (nextIndex < 0 || nextIndex >= steps.length) {
            endTour();
            return;
        }

        if (steps[currentStep] && currentStep !== nextIndex && typeof steps[currentStep].onLeave === 'function') {
            steps[currentStep].onLeave();
        }

        currentStep = nextIndex;

        if (steps[currentStep] && typeof steps[currentStep].onEnter === 'function') {
            steps[currentStep].onEnter();
        }

        /* 立即显示步骤的气泡文本，消除点击后的“卡顿感” */
        showStep(currentStep);
    }

    /* ── UI 创建与展示 ──────────────────────────────────────── */
    function createUI() {
        overlay = document.createElement('div');
        overlay.className = 'rlog-tour-overlay';

        const svgNs = 'http://www.w3.org/2000/svg';
        dimLayer = document.createElementNS(svgNs, 'svg');
        dimLayer.classList.add('rlog-tour-dim');
        dimLayer.setAttribute('aria-hidden', 'true');
        dimLayer.innerHTML = `
            <defs>
                <mask id="${DIM_MASK_ID}" maskUnits="userSpaceOnUse">
                    <rect data-rlog-tour-mask-base="1" x="0" y="0" width="100%" height="100%" fill="white"></rect>
                    <g data-rlog-tour-mask-holes="1"></g>
                </mask>
            </defs>
            <rect data-rlog-tour-dim-fill="1" x="0" y="0" width="100%" height="100%"
                  mask="url(#${DIM_MASK_ID})"></rect>
        `;

        highlightBox = document.createElement('div');
        highlightBox.className = 'rlog-tour-highlight-layer';

        tooltip = document.createElement('div');
        tooltip.className = 'rlog-tour-tooltip';

        /* 添加到面板内部，确保跟随面板移动 */
        const panel = getPanel();
        if (panel) {
            panel.appendChild(overlay);
            panel.appendChild(dimLayer);
            panel.appendChild(highlightBox);
            panel.appendChild(tooltip);

            /* 遮罩层点击：非弹窗区域 → 下一步（最后一步则结束引导） */
            overlay.addEventListener('click', (e) => {
                e.stopPropagation();
                /* 点击弹窗内部则不处理（弹窗有自己的按钮事件） */
                if (tooltip && tooltip.contains(e.target)) return;
                if (currentStep >= steps.length - 1) {
                    endTour();
                } else {
                    executeStep(currentStep + 1);
                }
            });
            tooltip.addEventListener('click', e => e.stopPropagation());
        }
    }

    function buildTooltipHtml(index) {
        const step = steps[index];
        const isLast = index === steps.length - 1;
        const isFirst = index === 0;
        const formattedDesc = step.desc.replace(
            /｜/g,
            '<span class="rlog-tour-separator" aria-hidden="true">｜</span>',
        );
        return `
            <button class="rlog-tour-close" title="退出引导"><i class="fa-solid fa-xmark"></i></button>
            <div class="rlog-tour-body">${formattedDesc}</div>
            <div class="rlog-tour-footer">
                <div class="rlog-tour-dots">
                    ${steps.map((_, i) => `<span class="rlog-tour-dot ${i === index ? 'active' : ''}" data-index="${i}"></span>`).join('')}
                </div>
                <div class="rlog-tour-buttons">
                    ${!isFirst ? `<button class="rlog-tour-btn rlog-tour-prev">上一步</button>` : `<button class="rlog-tour-btn rlog-tour-skip">跳过</button>`}
                    <button class="rlog-tour-btn rlog-tour-next rlog-tour-primary">${isLast ? '完成' : '下一步'}</button>
                </div>
            </div>
        `;
    }

    function bindTooltipEvents() {
        const btnPrev = tooltip.querySelector('.rlog-tour-prev');
        const btnNext = tooltip.querySelector('.rlog-tour-next');
        const btnSkip = tooltip.querySelector('.rlog-tour-skip');
        const btnClose = tooltip.querySelector('.rlog-tour-close');

        if (btnPrev) btnPrev.addEventListener('click', (e) => { e.stopPropagation(); executeStep(currentStep - 1); });
        if (btnNext) btnNext.addEventListener('click', (e) => { e.stopPropagation(); executeStep(currentStep + 1); });
        if (btnSkip) btnSkip.addEventListener('click', (e) => { e.stopPropagation(); endTour(); });
        if (btnClose) btnClose.addEventListener('click', (e) => { e.stopPropagation(); endTour(); });

        const dots = tooltip.querySelectorAll('.rlog-tour-dot');
        dots.forEach(dot => {
            dot.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetIndex = parseInt(dot.getAttribute('data-index'), 10);
                if (!isNaN(targetIndex) && targetIndex !== currentStep) {
                    executeStep(targetIndex);
                }
            });
        });
    }

    function showStep(index) {
        const step = steps[index];
        const selectors = step.targetSelectors || [step.targetSelector];
        const targetEls = selectors.map((selector) => q(selector));

        if (targetEls.some((targetEl) => !targetEl)) {
            /* 找不到目标元素时延迟重试（等待 DOM 稳定，如搜索框动态创建） */
            if (findTargetRetryCount < TARGET_RETRY_MAX) {
                findTargetRetryCount++;
                setTimeout(() => {
                    if (isActive && currentStep === index) {
                        showStep(index);
                    }
                }, TARGET_RETRY_DELAY_MS);
            } else {
                findTargetRetryCount = 0;
                console.warn(`[Tour] Target not found: ${selectors.join(', ')}`);
                executeStep(index + 1);
            }
            return;
        }
        findTargetRetryCount = 0;

        tooltip.innerHTML = buildTooltipHtml(index);

        bindTooltipEvents();

        positionElements(targetEls, step);
    }

    /* ── 高亮与气泡定位 ─────────────────────────────────────── */
    function positionElements(targetEls, step) {
        const panel = getPanel();
        if (!panel) return;

        const placement = step.placement;
        const padding = step.padding !== undefined ? step.padding : HIGHLIGHT_PADDING_DEFAULT;

        const panelRect = panel.getBoundingClientRect();
        const targetRects = targetEls.map((targetEl) => {
            const rect = targetEl.getBoundingClientRect();
            return {
                top: rect.top - panelRect.top,
                left: rect.left - panelRect.left,
                width: rect.width,
                height: rect.height,
            };
        });

        let boxes = targetRects.map((targetRect, index) => {
            let boxTop = targetRect.top - padding;
            let boxLeft = targetRect.left - padding;
            let boxWidth = targetRect.width + padding * 2;
            let boxHeight = targetRect.height + padding * 2;

            /* 自定义高亮框调整（用于精准框住搜索区域等）
               topExtra/bottomExtra 为正表示向内收缩（裁剪），为负表示向外扩展 */
            if (index === 0 && step.highlightAdjust) {
                const adj = step.highlightAdjust;
                /* leftAlignTo：左边界对齐锚点元素（如放大镜按钮）左边缘，
                   动态读取实际位置以适配不同按钮宽度，避免写死固定偏移。 */
                if (adj.leftAlignTo) {
                    const anchorEl = targetEls[index].parentElement
                        ? targetEls[index].parentElement.querySelector(adj.leftAlignTo)
                        : null;
                    if (anchorEl) {
                        const anchorRect = anchorEl.getBoundingClientRect();
                        const anchorLeft = anchorRect.left - panelRect.left;
                        /* 左边界 = 锚点左边缘（无额外 padding）；
                           右边界保持原目标右边缘 + padding（与上下 padding 语义一致） */
                        boxLeft = anchorLeft;
                        boxWidth = (targetRect.left + targetRect.width + padding) - anchorLeft;
                    }
                }
                if (adj.topExtra !== undefined) {
                    boxTop += adj.topExtra;
                    boxHeight -= adj.topExtra;
                }
                if (adj.bottomExtra !== undefined) {
                    boxHeight -= adj.bottomExtra;
                }
            }
            const targetAdjust = step.targetHighlightAdjustments
                && step.targetHighlightAdjustments[index];
            if (targetAdjust) {
                if (targetAdjust.offsetX !== undefined) boxLeft += targetAdjust.offsetX;
                if (targetAdjust.offsetY !== undefined) boxTop += targetAdjust.offsetY;
            }

            return { top: boxTop, left: boxLeft, width: boxWidth, height: boxHeight };
        });

        /* 相邻按钮合并为一个框；抽屉入口与抽屉控件保持两个独立框。 */
        if (step.combineTargets && boxes.length > 1) {
            const right = Math.max(...boxes.map((box) => box.left + box.width));
            const bottom = Math.max(...boxes.map((box) => box.top + box.height));
            const left = Math.min(...boxes.map((box) => box.left));
            const top = Math.min(...boxes.map((box) => box.top));
            boxes = [{ top, left, width: right - left, height: bottom - top }];
        }

        highlightBox.replaceChildren(...boxes.map((box) => {
            const highlight = document.createElement('div');
            highlight.className = 'rlog-tour-highlight';
            highlight.style.top = `${box.top}px`;
            highlight.style.left = `${box.left}px`;
            highlight.style.width = `${box.width}px`;
            highlight.style.height = `${box.height}px`;
            return highlight;
        }));

        /* 单个遮罩通过 SVG mask 挖出全部目标，避免多个高亮阴影叠加导致双重压暗。 */
        const maskBase = dimLayer.querySelector('[data-rlog-tour-mask-base="1"]');
        const maskHoles = dimLayer.querySelector('[data-rlog-tour-mask-holes="1"]');
        const dimFill = dimLayer.querySelector('[data-rlog-tour-dim-fill="1"]');
        const svgNs = 'http://www.w3.org/2000/svg';
        maskBase.setAttribute('width', panelRect.width);
        maskBase.setAttribute('height', panelRect.height);
        dimFill.setAttribute('width', panelRect.width);
        dimFill.setAttribute('height', panelRect.height);
        maskHoles.replaceChildren(...boxes.map((box) => {
            const hole = document.createElementNS(svgNs, 'rect');
            hole.setAttribute('x', box.left);
            hole.setAttribute('y', box.top);
            hole.setAttribute('width', box.width);
            hole.setAttribute('height', box.height);
            hole.setAttribute('rx', '4');
            hole.setAttribute('ry', '4');
            hole.setAttribute('fill', 'black');
            return hole;
        }));

        let anchorRect = targetRects[0];
        if (step.combineTargets) {
            const right = Math.max(...targetRects.map((rect) => rect.left + rect.width));
            const bottom = Math.max(...targetRects.map((rect) => rect.top + rect.height));
            const left = Math.min(...targetRects.map((rect) => rect.left));
            const top = Math.min(...targetRects.map((rect) => rect.top));
            anchorRect = { top, left, width: right - left, height: bottom - top };
        }
        if (step.tooltipTargetSelector) {
            const anchorEl = q(step.tooltipTargetSelector);
            if (anchorEl) {
                const rect = anchorEl.getBoundingClientRect();
                anchorRect = {
                    top: rect.top - panelRect.top,
                    left: rect.left - panelRect.left,
                    width: rect.width,
                    height: rect.height,
                };
            }
        }

        /* 气泡须先置为显示才能取到尺寸，因此延后一帧再定位 */
        tooltip.style.display = 'block';
        tooltip.style.opacity = '1';

        requestAnimationFrame(() => {
            const tooltipWidth = tooltip.offsetWidth;
            const tooltipHeight = tooltip.offsetHeight;

            let tooltipTop = 0;
            let tooltipLeft = 0;

            if (placement === 'top') {
                tooltipTop = anchorRect.top - tooltipHeight - padding - TOOLTIP_ARROW_GAP;
                tooltip.classList.add('rlog-tour-top');
            } else {
                /* 默认 placement 为 bottom */
                tooltipTop = anchorRect.top + anchorRect.height + padding + TOOLTIP_ARROW_GAP;
                tooltip.classList.remove('rlog-tour-top');
            }

            /* 水平居中对齐目标元素 */
            tooltipLeft = anchorRect.left + (anchorRect.width / 2) - (tooltipWidth / 2);
            let arrowLeft = tooltipWidth / 2;

            /* 防止溢出面板右侧 */
            if (tooltipLeft + tooltipWidth > panelRect.width - TOOLTIP_EDGE_MARGIN) {
                tooltipLeft = panelRect.width - tooltipWidth - TOOLTIP_EDGE_MARGIN;
                arrowLeft = anchorRect.left - tooltipLeft + anchorRect.width / 2;
            } else if (tooltipLeft < TOOLTIP_EDGE_MARGIN) {
                /* 防止溢出左侧 */
                tooltipLeft = TOOLTIP_EDGE_MARGIN;
                arrowLeft = anchorRect.left - tooltipLeft + anchorRect.width / 2;
            }

            /* 限制小三角不要超出气泡边界（防止长在圆角外面或浮空） */
            if (arrowLeft > tooltipWidth - ARROW_EDGE_LIMIT) arrowLeft = tooltipWidth - ARROW_EDGE_LIMIT;
            if (arrowLeft < ARROW_EDGE_LIMIT) arrowLeft = ARROW_EDGE_LIMIT;

            tooltip.style.setProperty('--arrow-left', `${arrowLeft}px`);
            tooltip.style.top = `${tooltipTop}px`;
            tooltip.style.left = `${tooltipLeft}px`;
        });
    }

    /* ── 对外 API ────────────────────────────────────────────── */
    /* 暴露 API 供外部调用（index.js 动态加载本文件后使用） */
    window.__RLogTour = {
        check: checkAndStartTour,
        start: startTour,
        end: endTour
    };

})();
