/**
 * 最近请求记录 - 使用引导 (Product Tour)
 */

(function () {
    let currentTourVersion = '1.6.0'; // 兜底版本号
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
            desc: '更多选项、折叠所有条目、关闭面板'
        },
        {
            targetSelector: '#rlog-more-drawer',
            desc: '点击<strong>更多选项</strong>显示：<br>内容预览开关、插件总开关、使用引导、清空所有记录、昼/夜模式切换',
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
            desc: '角色名、请求来源、时间戳、模型名称、token数（数字前有“~”时表示降级为估算）/消息条数'
        },
        {
            targetSelector: '.rlog-record[data-record-index="0"] .rlog-record-actions-inner',
            desc: '展开时显示：<br>展开/折叠内部所有消息、复制整条请求、删除本条记录'
        },
        {
            targetSelector: '.rlog-record[data-record-index="0"] .rmsg-item .rmsg-copy-btn',
            desc: '展开时显示：<br>复制单条消息<br><br>引导已结束，点击❔图标重看'
        }
    ];

    let currentStep = 0;
    let overlay = null;
    let tooltip = null;
    let highlightBox = null;
    let isActive = false;
    let isDemoInjected = false;
    let stepTimer = null;

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

        // 检查是否需要注入演示记录
        const listEl = document.getElementById('rlog-list');
        const emptyEl = listEl ? listEl.querySelector('.rlog-empty') : null;
        if (emptyEl) {
            isDemoInjected = true;
            if (window.__RLogApi && typeof window.__RLogApi.injectDemo === 'function') {
                window.__RLogApi.injectDemo();
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

        // 如果注入了演示记录，清理掉
        if (isDemoInjected && window.__RLogApi && typeof window.__RLogApi.removeDemo === 'function') {
            window.__RLogApi.removeDemo();
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
            // 如果找不到目标元素，跳过这一步
            console.warn(`[Tour] Target not found: ${step.targetSelector}`);
            executeStep(index + 1);
            return;
        }

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
