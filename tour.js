/**
 * 最近请求记录 - 使用引导 (Product Tour)
 */

(function () {
    // ⚠️ 兜底版本号：仅当获取 manifest.json 失败时才使用，语义与插件版本号无关。
    // 不要随插件发布版本更新此值！此值表示「最后一次成功加载的引导版本」的兜底：
    // - 若误改为新版本号（如 1.8.0），manifest 获取失败时会被误判为「已看过新引导」而跳过展示。
    // - 保持旧值（1.6.0）是为了在 manifest 获取失败时触发引导展示，避免用户完全看不到新功能引导。
    let currentTourVersion = '1.6.0'; // 兜底版本号（勿随插件版本更新，见上方说明）
    const STORAGE_KEY = 'RecentRequestLog_tour_version';

    const steps = [
        {
            targetSelector: '.rlog-title-text',
            desc: '单击此处<strong>折叠/展开</strong>'
        },
        {
            targetSelector: '.rlog-title-count',
            desc: '<strong>双击</strong>数字设置记录上限',
            padding: 0
        },
        {
            targetSelector: '.rlog-header-drag-space',
            desc: '按住空白处<strong>拖动窗口</strong>'
        },
        {
            targetSelector: '.rlog-resize-grip',
            desc: '按住&nbsp;<i class="fa-solid fa-caret-down" style="transform: rotate(-45deg);"></i>&nbsp;拖动，<strong>调整窗口大小</strong>',
            placement: 'top',
            padding: 0
        },
        {
            targetSelector: '.rlog-header-actions',
            desc: '• 更多选项<br>• 折叠所有条目<br>• 关闭面板'
        },
        {
            targetSelector: '#rlog-more-drawer',
            desc: '点击<strong>更多选项</strong>显示：<br>• 内容预览开关<br>• 插件总开关<br>• 使用引导<br>• 临时测试按钮（后续移除）<br>• 清空所有记录<br>• 昼/夜模式切换',
            onEnter: () => {
                const drawer = document.getElementById('rlog-more-drawer');
                if (drawer) drawer.style.transition = 'none';
                if (window.__RLogApi && window.__RLogApi.openDrawer) {
                    window.__RLogApi.openDrawer();
                }
                if (drawer) {
                    void drawer.offsetWidth;
                    drawer.style.transition = '';
                }
            },
            onLeave: () => {
                const drawer = document.getElementById('rlog-more-drawer');
                if (drawer) drawer.style.transition = 'none';
                if (window.__RLogApi && window.__RLogApi.closeDrawer) {
                    window.__RLogApi.closeDrawer();
                }
                if (drawer) {
                    void drawer.offsetWidth;
                    drawer.style.transition = '';
                }
            }
        },
        {
            targetSelector: '.rlog-record[data-record-index="0"] .rmsg-item .rmsg-preview-text',
            desc: '开启<strong>内容预览</strong>后，显示消息开头的部分文字',
            onEnter: () => {
                if (window.__RLogApi && window.__RLogApi.expandDemo) {
                    window.__RLogApi.expandDemo(); // 确保记录和消息展开
                }
                if (window.__RLogApi && window.__RLogApi.forcePreview) {
                    window.__RLogApi.forcePreview(true);
                }
            },
            onLeave: () => {
                if (window.__RLogApi && window.__RLogApi.forcePreview) {
                    window.__RLogApi.forcePreview(false);
                }
            }
        },
        {
            targetSelector: '.rlog-record[data-record-index="0"] .rlog-record-info',
            desc: '• 角色名<br>• 请求来源<br>• 时间戳<br>• 模型名称<br>• token数/消息条数（tokens前的数字有“~”时表示降级为估算）'
        },
        {
            targetSelector: '.rlog-record[data-record-index="0"] .rlog-record-actions-inner',
            desc: '<strong>展开时显示：</strong><br>• 搜索<br>• 展开/折叠内部所有消息<br>• <strong>New 查看全文</strong>（原<strong>复制整条请求</strong>移入内部）<br>• 删除本条记录'
        },
        {
            targetSelector: '.rlog-search-box',
            desc: '• 点击 🔍︎ ，输入关键字进行搜索<br>• 点击箭头或按 Enter/Shift+Enter 在结果间跳转<br>• 再次点击 🔍︎ 可退出搜索',
            // 自定义高亮框：左边缘对齐放大镜按钮左边缘（自动适配桌面 24px / 移动端 20px 按钮宽度），
            // 裁剪上下各 8px 点击防护区
            highlightAdjust: {
                leftAlignTo: '.rlog-search-btn',
                topExtra: 8,
                bottomExtra: 8
            },
            onEnter: () => {
                // demo 已在 startTour 中注入（始终注入），这里无需再检查列表是否为空。
                // 打开搜索框并搜索「示例」（demo 数据包含该词，确保有匹配结果）
                // 注意：不要在 openSearchForRecord 之前或之后调用 expandDemo/injectDemo 等方法，
                // 它们会触发 renderPanelContent() → resetSearchIfActive() 移除刚创建的搜索框。
                // openSearchForRecord/performSearch/closeSearch 在 index.js 中非全局作用域，
                // 需要通过 __RLogApi 访问。
                if (window.__RLogApi && typeof window.__RLogApi.openSearchForRecord === 'function') {
                    window.__RLogApi.openSearchForRecord(0);
                }
                // 设置输入框内容（performSearch 只更新 searchState，不会写回 input.value）
                const searchBox = document.querySelector('#rlog-panel .rlog-search-box');
                const inputEl = searchBox ? searchBox.querySelector('.rlog-search-input') : null;
                if (inputEl) {
                    inputEl.value = '示例';
                }
                if (window.__RLogApi && typeof window.__RLogApi.performSearch === 'function') {
                    window.__RLogApi.performSearch(0, '示例');
                }
            },
            onLeave: () => {
                if (window.__RLogApi && typeof window.__RLogApi.closeSearch === 'function') {
                    window.__RLogApi.closeSearch();
                }
            }
        },
        {
            targetSelector: '.rlog-record[data-record-index="0"] .rmsg-item .rmsg-copy-btn',
            desc: '<strong>展开时显示：</strong><br>• 复制单条消息<br><br>【引导已结束，点击❔图标重看】'
        }
    ];

    let currentStep = 0;
    let overlay = null;
    let tooltip = null;
    let highlightBox = null;
    let isActive = false;
    let isDemoInjected = false;
    /** 引导开始前备份的真实记录列表（引导期间清空列表，结束后恢复） */
    let savedRecords = null;
    let stepTimer = null;
    /** 查找目标元素的失败重试计数（避免 DOM 尚未就绪时被跳过） */
    let findTargetRetryCount = 0;

    async function checkAndStartTour(force = false) {
        try {
            // 尝试动态获取 manifest.json 的路径
            let manifestUrl = '/scripts/extensions/third-party/RecentRequestLog/manifest.json';
            const scripts = document.getElementsByTagName('script');
            for (let i = 0; i < scripts.length; i++) {
                if (scripts[i].src && scripts[i].src.includes('RecentRequestLog/tour.js')) {
                    manifestUrl = scripts[i].src.replace('tour.js', 'manifest.json');
                    break;
                }
            }

            // 加上时间戳防止缓存
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

        const savedVersion = localStorage.getItem(STORAGE_KEY);
        if (force || savedVersion !== currentTourVersion) {
            startTour();
        }
    }

    function startTour() {
        if (isActive) return;
        
        // 面板必须是可见的才能进行引导
        const panel = document.getElementById('rlog-panel');
        if (!panel || panel.style.display === 'none') return;

        // 如果处于折叠状态，先展开面板
        if (panel.classList.contains('rlog-window-collapsed')) {
            const titleText = panel.querySelector('.rlog-title-text');
            if (titleText) titleText.click();
        }

        isActive = true;
        currentStep = 0;
        isDemoInjected = false;

        // 引导期间只展示演示记录（demo），不展示真实记录：
        // 1. 备份当前真实记录列表到 savedRecords
        // 2. 标记引导进行中（此后新到达的记录只暂存、不显示，由 index.js 处理）
        // 3. 清空列表（setRecords([])）
        // 4. 注入 demo（unshift 至最前，所有 data-record-index="0" 步骤均作用于 demo）
        // 这样保证引导各步骤的 DOM 完全可控，避免列表有真实记录时
        // 最后一步「复制单条消息」定位到不可控的真实记录导致选框错位。
        // endTour 中会移除 demo 并恢复 savedRecords。
        if (window.__RLogApi) {
            const api = window.__RLogApi;
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
                isDemoInjected = true;
            }
        }

        createUI();
        
        // 稍微延迟一下以等待 DOM 和过渡动画完成
        setTimeout(() => {
            executeStep(currentStep);
        }, 100);
    }

    function endTour() {
        if (!isActive) return;

        // 执行最后一步的 onLeave
        if (steps[currentStep] && typeof steps[currentStep].onLeave === 'function') {
            steps[currentStep].onLeave();
        }

        isActive = false;

        // 记录版本号
        localStorage.setItem(STORAGE_KEY, currentTourVersion);

        // 移除 UI
        if (overlay) overlay.remove();
        if (tooltip) tooltip.remove();
        if (highlightBox) highlightBox.remove();
        
        overlay = null;
        tooltip = null;
        highlightBox = null;

        // 恢复引导前的记录列表 + 引导期间暂存的新记录：
        // - 引导期间新到达的记录被 index.js 暂存（不显示），这里先取出，
        //   再与引导前备份合并恢复（新记录在前、旧记录在后，符合「最新在上」的展示顺序）
        // - 若引导前无记录（savedRecords 为空数组）→ 只恢复引导期间的新记录
        // 使用 requestAnimationFrame 延迟到下一帧恢复：让引导 UI 移除先完成渲染（立即反馈），
        // 再执行重量级的列表恢复渲染（极端场景 100 条记录 × 100+ 消息时，全量重建可能数百 ms）。
        // 这样用户点击「完成」后引导气泡先消失，列表在下一次渲染帧中恢复，避免同步阻塞卡死 UI。
        if (savedRecords !== null && window.__RLogApi && typeof window.__RLogApi.setRecords === 'function') {
            const recordsBeforeTour = savedRecords;
            savedRecords = null;
            requestAnimationFrame(() => {
                const api = window.__RLogApi;
                if (api && typeof api.setRecords === 'function') {
                    // 先取出引导期间暂存的新记录（延迟到恢复前一刻再取，
                    // 避免 rAF 间隙中新到达的记录漏进旧列表后被覆盖丢失）
                    let pendingRecords = [];
                    if (typeof api.drainTourPendingRecords === 'function') {
                        pendingRecords = api.drainTourPendingRecords();
                    }
                    // 引导期间有新记录到达时，与正常 addRecord 行为保持一致：
                    // 新记录到达会折叠所有已有记录（仅折叠记录本身，子消息展开状态不变）。
                    // 无新记录到达时保持引导前状态原样恢复，不扰动用户的展开状态。
                    if (pendingRecords.length > 0) {
                        recordsBeforeTour.forEach(r => { r.collapsed = true; });
                    }
                    api.setRecords(pendingRecords.concat(recordsBeforeTour));
                }
                // 恢复完成后再解除引导状态，此后新记录按正常逻辑直接加入列表
                if (api && typeof api.setTourActive === 'function') {
                    api.setTourActive(false);
                }
            });
        } else {
            savedRecords = null;
            if (window.__RLogApi && typeof window.__RLogApi.setTourActive === 'function') {
                window.__RLogApi.setTourActive(false);
            }
        }
        isDemoInjected = false;
    }

    function executeStep(nextIndex) {
        if (nextIndex < 0 || nextIndex >= steps.length) {
            endTour();
            return;
        }

        if (stepTimer) {
            clearTimeout(stepTimer);
            stepTimer = null;
        }

        // 执行上一步的 onLeave
        if (steps[currentStep] && currentStep !== nextIndex && typeof steps[currentStep].onLeave === 'function') {
            steps[currentStep].onLeave();
        }

        currentStep = nextIndex;

        // 执行当前步的 onEnter
        if (steps[currentStep] && typeof steps[currentStep].onEnter === 'function') {
            steps[currentStep].onEnter();
        }

        // 立即显示步骤的气泡文本，消除点击后的“卡顿感”
        showStep(currentStep);
    }

    function createUI() {
        // 遮罩层
        overlay = document.createElement('div');
        overlay.className = 'rlog-tour-overlay';
        
        // 高亮框
        highlightBox = document.createElement('div');
        highlightBox.className = 'rlog-tour-highlight';

        // 提示气泡
        tooltip = document.createElement('div');
        tooltip.className = 'rlog-tour-tooltip';
        
        // 添加到面板内部，确保跟随面板移动
        const panel = document.getElementById('rlog-panel');
        if (panel) {
            panel.appendChild(overlay);
            panel.appendChild(highlightBox);
            panel.appendChild(tooltip);

            // 遮罩层点击：非弹窗区域 → 下一步（最后一步则结束引导）
            overlay.addEventListener('click', (e) => {
                e.stopPropagation();
                // 点击弹窗内部则不处理（弹窗有自己的按钮事件）
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

    function showStep(index) {
        const step = steps[index];
        const panel = document.getElementById('rlog-panel');
        const targetEl = panel ? panel.querySelector(step.targetSelector) : null;

        if (!targetEl) {
            // 如果找不到目标元素，延迟重试（等待 DOM 稳定，如搜索框动态创建）
            if (findTargetRetryCount < 3) {
                findTargetRetryCount++;
                setTimeout(() => {
                    if (isActive && currentStep === index) {
                        showStep(index);
                    }
                }, 100);
            } else {
                findTargetRetryCount = 0;
                console.warn(`[Tour] Target not found: ${step.targetSelector}`);
                executeStep(index + 1);
            }
            return;
        }
        findTargetRetryCount = 0;

        // 更新提示气泡内容
        const isLast = index === steps.length - 1;
        const isFirst = index === 0;

        tooltip.innerHTML = `
            <button class="rlog-tour-close" title="退出引导"><i class="fa-solid fa-xmark"></i></button>
            <div class="rlog-tour-body">${step.desc}</div>
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

        // 绑定按钮事件
        const btnPrev = tooltip.querySelector('.rlog-tour-prev');
        const btnNext = tooltip.querySelector('.rlog-tour-next');
        const btnSkip = tooltip.querySelector('.rlog-tour-skip');
        const btnClose = tooltip.querySelector('.rlog-tour-close');

        if (btnPrev) btnPrev.addEventListener('click', (e) => { e.stopPropagation(); executeStep(currentStep - 1); });
        if (btnNext) btnNext.addEventListener('click', (e) => { e.stopPropagation(); executeStep(currentStep + 1); });
        if (btnSkip) btnSkip.addEventListener('click', (e) => { e.stopPropagation(); endTour(); });
        if (btnClose) btnClose.addEventListener('click', (e) => { e.stopPropagation(); endTour(); });

        // 绑定圆点点击跳转事件
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

        // 定位高亮框和气泡
        positionElements(targetEl, step);

        // 如果配置了 delay（例如有 CSS 动画），我们在动画期间使用帧循环持续更新高亮框的位置，
        // 实现完美贴合的跟随效果，而不是死板地等待。
        if (step.delay && step.delay > 0) {
            let start = Date.now();
            function trackAnimation() {
                const updatedTarget = panel.querySelector(step.targetSelector);
                if (updatedTarget) positionElements(updatedTarget, step);
                
                if (Date.now() - start < step.delay) {
                    requestAnimationFrame(trackAnimation);
                }
            }
            requestAnimationFrame(trackAnimation);
        }
    }

    function positionElements(targetEl, step) {
        const panel = document.getElementById('rlog-panel');
        if (!panel) return;

        const placement = step.placement;
        const padding = step.padding !== undefined ? step.padding : 4;

        const panelRect = panel.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();

        // 计算相对面板内部的位置
        const top = targetRect.top - panelRect.top;
        const left = targetRect.left - panelRect.left;
        const width = targetRect.width;
        const height = targetRect.height;

        let boxTop = top - padding;
        let boxLeft = left - padding;
        let boxWidth = width + padding * 2;
        let boxHeight = height + padding * 2;

        // 自定义高亮框调整（用于精准框住搜索区域等）
        // leftExtra/topExtra/bottomExtra 为正表示向内收缩（裁剪），为负表示向外扩展
        if (step.highlightAdjust) {
            const adj = step.highlightAdjust;
            // leftAlignTo：左边界精确对齐指定锚点元素的左边缘（如放大镜按钮）。
            // 动态读取锚点实际位置，自动适配桌面 24px / 移动端 20px 的按钮宽度差异，
            // 替代固定 leftExtra 硬编码偏移（固定偏移在移动端会多出 4px 误差）。
            if (adj.leftAlignTo) {
                const anchorEl = targetEl.parentElement
                    ? targetEl.parentElement.querySelector(adj.leftAlignTo)
                    : null;
                if (anchorEl) {
                    const anchorRect = anchorEl.getBoundingClientRect();
                    const anchorLeft = anchorRect.left - panelRect.left;
                    // 左边界 = 锚点左边缘（精确对齐，无额外 padding），
                    // 右边界保持 = 原目标右边缘 + padding（与上下 padding 语义一致）
                    boxLeft = anchorLeft;
                    boxWidth = (left + width + padding) - anchorLeft;
                }
            }
            if (adj.leftExtra !== undefined) {
                boxLeft += adj.leftExtra;
                boxWidth -= adj.leftExtra;
            }
            if (adj.topExtra !== undefined) {
                boxTop += adj.topExtra;
                boxHeight -= adj.topExtra;
            }
            if (adj.bottomExtra !== undefined) {
                boxHeight -= adj.bottomExtra;
            }
        }

        // 专门针对右下角调整大小的特殊处理，不影响其他框
        if (step.targetSelector === '.rlog-resize-grip') {
            // 在默认的 content-box 模型下，2px 的边框会向外扩展。由于目标元素贴边，导致右下角高亮框边框被面板的 overflow: hidden 裁剪。
            boxLeft -= 0;
            boxTop -= 0;
        }

        // 定位高亮框
        highlightBox.style.boxSizing = ''; // 恢复默认，防止残留的 border-box 影响
        highlightBox.style.top = `${boxTop}px`;
        highlightBox.style.left = `${boxLeft}px`;
        highlightBox.style.width = `${boxWidth}px`;
        highlightBox.style.height = `${boxHeight}px`;

        // 显示气泡（必须先 display:block 才能获取尺寸）
        tooltip.style.display = 'block';
        tooltip.style.opacity = '1';

        // 延迟一下定位气泡，确保能拿到正确的 offsetHeight
        requestAnimationFrame(() => {
            const tooltipWidth = tooltip.offsetWidth;
            const tooltipHeight = tooltip.offsetHeight;
            
            let tooltipTop = 0;
            let tooltipLeft = 0;

            if (placement === 'top') {
                tooltipTop = top - tooltipHeight - padding - 8;
                tooltip.classList.add('rlog-tour-top');
            } else {
                // 默认 placement 为 bottom
                tooltipTop = top + height + padding + 8; // 8px 是气泡小三角的间距
                tooltip.classList.remove('rlog-tour-top');
            }
            
            // 水平居中对齐目标元素
            tooltipLeft = left + (width / 2) - (tooltipWidth / 2);
            let arrowLeft = tooltipWidth / 2;
            
            // 防止溢出面板右侧
            if (tooltipLeft + tooltipWidth > panelRect.width - 10) {
                tooltipLeft = panelRect.width - tooltipWidth - 10;
                arrowLeft = targetRect.left - panelRect.left - tooltipLeft + targetRect.width / 2;
            } else if (tooltipLeft < 10) {
                // 防止溢出左侧
                tooltipLeft = 10;
                arrowLeft = targetRect.left - panelRect.left - tooltipLeft + targetRect.width / 2;
            }

            // 限制小三角不要超出气泡边界（保留距离边缘 24px，防止长在圆角外面或者浮空）
            if (arrowLeft > tooltipWidth - 24) arrowLeft = tooltipWidth - 24;
            if (arrowLeft < 24) arrowLeft = 24;

            tooltip.style.setProperty('--arrow-left', `${arrowLeft}px`);
            tooltip.style.top = `${tooltipTop}px`;
            tooltip.style.left = `${tooltipLeft}px`;
        });
    }

    // 暴露 API 供外部调用
    window.__RLogTour = {
        check: checkAndStartTour,
        start: startTour,
        end: endTour
    };

})();
