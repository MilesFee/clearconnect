// ============ DECLARATIVE SPA ARCHITECTURE ============
// Two-Layer Render: Shell (body theme) + View (app-root content)
// Navigation = updating uiNavigation.currentTab in storage
// Event Delegation = single listener on app-root

// XSS prevention: escape user-sourced strings before innerHTML injection
function escapeHTML(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SENT_URL = 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';
const DEFAULTS = {
    safeThreshold: 1,
    safeUnit: 'month',
    withdrawCount: 10,
    ageValue: 3,
    ageUnit: 'month',
    currentMode: 'count',
    safeMode: true,
    theme: 'light',
    debugMode: false
};

// Default state structure
const DEFAULT_STATE = {
    isRunning: false,
    isPaused: false,
    currentMode: 'count',
    subMode: 'idle',
    lastError: null,
    stats: {
        processed: 0,
        total: 0,
        oldestCleared: '-',
        startTime: null,
        pendingInvitations: null,
        pendingUpdatedAt: null,
        alltimeCleared: 0
    },
    settings: { ...DEFAULTS },
    status: { text: 'Ready', progress: 0 },
    sessionLog: [],
    foundMatchingPeople: [],
    batchStart: 0,
    uiNavigation: { currentTab: 'home' },
    lastRunResult: null,
    sessionCleared: []
};

// Runtime state (not persisted)
let activeTabId = null;
let localSettings = { ...DEFAULTS };
let pageStatus = 'ok'; // 'ok' | 'offPlatform' | 'wrongPage' | 'connectionError' - transient, not saved

// Scan results state
let selectedScanHashes = new Set();
let foundScanResults = [];

// ============ FOOTER STATUS HELPER ============
// Renders semantic status in footer based on stopType
function getFooterStatusHTML(state) {
    // P1: Off-Page - no footer status (warning view is the status)
    if (pageStatus !== 'ok') return '';

    // P2: Already on Results - hide footer (you're already viewing results)
    const currentTab = state?.uiNavigation?.currentTab || 'home';
    if (currentTab === 'completed') return '';

    // P3: Post-Run - semantic banner based on stopType
    if (state?.lastRunResult && !state?.isRunning) {
        const { processed, oldestCleared, stopType, message } = state.lastRunResult;
        const showViewResults = processed > 0;

        // Map stopType to CSS class and icon
        let cssClass, icon, displayMessage;
        switch (stopType) {
            case 'manual':
                cssClass = 'status-error';
                icon = '&#10006;'; // X
                displayMessage = `Run Stopped. ${processed} cleared.`;
                break;
            case 'safety':
                cssClass = 'status-warning';
                icon = '&#9888;'; // Warning
                displayMessage = `Safety Stop Triggered. ${processed} cleared.`;
                break;
            case 'error':
                cssClass = 'status-critical';
                icon = '&#10071;'; // !
                displayMessage = `Error: ${message || 'Unknown error'}. ${processed} cleared.`;
                break;
            case 'success':
            default:
                cssClass = 'status-success';
                icon = '&#10003;'; // Check
                displayMessage = `Run Completed. ${processed} cleared.`;
                break;
        }

        return `
            <div class="status-box ${cssClass}">
                <div class="status-icon-circle ${stopType === 'success' ? 'success' : stopType === 'manual' ? 'error' : 'warning'}">
                    <div class="status-icon">${icon}</div>
                </div>
                <div class="status-content">
                    <strong>${displayMessage}</strong>
                    ${oldestCleared !== '-' ? `<span class="status-detail">Oldest: ${oldestCleared}</span>` : ''}
                </div>
                <button class="status-close-btn" data-action="close-footer" aria-label="Close message">&times;</button>
            </div>
        `;
    }

    // P4: Active Run - no footer status (progress view handles it)
    if (state?.isRunning) return '';

    // P5: Idle + Correct Page - green confirmation (unless dismissed)
    if (localSettings.hideReadyStatus) return '';

    return `
        <div class="status-box status-confirm">
            <div class="status-icon-circle confirm">
                <div class="status-icon">&#10003;</div>
            </div>
            <div class="status-content">
                <span>You are on the correct page.</span>
            </div>
            <button class="status-close-btn" data-action="close-footer" aria-label="Close message">&times;</button>
        </div>
    `;
}

// Show a transient error in the footer (auto-clears after 4s)
function showFooterError(msg) {
    const hint = document.getElementById('footer-hint');
    const errIcon = document.getElementById('footer-icon-error');
    const footerMsg = document.getElementById('footer-content');

    if (hint) {
        hint.textContent = msg;
        hint.style.color = 'var(--status-error, #dc2828)';
    }
    if (errIcon) errIcon.style.display = 'inline';
    if (footerMsg) {
        footerMsg.classList.add('visible');
        footerMsg.classList.add('error');
    }

    setTimeout(() => {
        if (hint) { hint.textContent = ''; hint.style.color = ''; }
        if (errIcon) errIcon.style.display = 'none';
        if (footerMsg) {
            footerMsg.classList.remove('visible');
            footerMsg.classList.remove('error');
        }
    }, 4000);
}

// ============ CORE RENDER SYSTEM ============

// Shell render - applies global state to body (theme, debug mode indicator)
function renderShell(state) {
    // Apply theme on every render
    const theme = localSettings.theme || 'light';
    document.documentElement.setAttribute('data-theme', theme);

    // Debug mode indicator
    if (localSettings.debugMode) {
        document.body.classList.add('debug-active');
    } else {
        document.body.classList.remove('debug-active');
    }

    // Active lock - disable nav buttons when running
    const isRunning = state?.isRunning || false;
    const settingsBtn = document.getElementById('settings-btn');
    const statsBtn = document.getElementById('stats-btn');
    const historyBtn = document.getElementById('history-btn');

    if (settingsBtn) {
        settingsBtn.disabled = isRunning;
        settingsBtn.classList.toggle('disabled', isRunning);
    }
    if (statsBtn) {
        statsBtn.disabled = isRunning;
        statsBtn.classList.toggle('disabled', isRunning);
    }
    if (historyBtn) {
        historyBtn.disabled = isRunning;
        historyBtn.classList.toggle('disabled', isRunning);
    }
}

// Targeted DOM updates to prevent flickering
function updateProgress(state) {
    const mode = state?.currentMode || 'count';
    const subMode = state?.subMode || 'scanning';
    const progress = state?.status?.progress || 0;
    const statusText = state?.status?.text || 'Starting...';

    const isScanning = subMode === 'scanning';
    const isWithdrawing = subMode === 'withdrawing';

    // Update Text Content
    const statusEls = ['status-text', 'msg-scan-status', 'msg-withdraw-status', 'scroll-status'];
    statusEls.forEach(id => {
        const el = document.getElementById(id);
        if (el && el.textContent !== statusText) el.textContent = statusText;
    });

    // Update Progress Bars (Scanning)
    const scanBar = document.getElementById('msg-scan-fill') || document.getElementById('scroll-progress-fill');
    if (scanBar) {
        // If scanning, use progress. If withdrawing, scan bar should be 100%
        const width = isScanning ? progress : 100;
        if (scanBar.style.width !== `${width}%`) scanBar.style.width = `${width}%`;
    }

    // Update Progress Bars (Withdrawing)
    const withdrawBar = document.getElementById('msg-withdraw-fill') || document.getElementById('progress-fill');
    if (withdrawBar) {
        const width = isWithdrawing ? progress : 0;
        if (withdrawBar.style.width !== `${width}%`) withdrawBar.style.width = `${width}%`;
    }

    // Update Phase Classes (Scanning Step)
    const scanStep = document.getElementById('msg-step-scan');
    if (scanStep) {
        scanStep.className = 'progress-step'; // Reset
        const label = scanStep.querySelector('.step-label');
        if (isScanning) {
            scanStep.classList.add('active');
            if (label) label.classList.add('wave-text');
        } else {
            scanStep.classList.add('inactive');
            scanStep.classList.add('phase-fade-out-back');
            if (label) label.classList.remove('wave-text');
        }
    }

    // Update Phase Classes (Withdraw Step)
    const withdrawStep = document.getElementById('msg-step-withdraw');
    if (withdrawStep) {
        withdrawStep.className = 'progress-step'; // Reset
        const label = withdrawStep.querySelector('.step-label');
        if (isWithdrawing) {
            withdrawStep.classList.add('active');
            withdrawStep.classList.add('phase-shift-up');
            if (label) label.classList.add('wave-text');
        } else {
            withdrawStep.classList.add('inactive');
            if (label) label.classList.remove('wave-text');
        }

        // Update label with active person name if withdrawing
        if (isWithdrawing) {
            const foundPeople = state?.foundMatchingPeople || [];
            const currentIndex = state?.stats?.processed || 0;
            const activePerson = foundPeople[currentIndex];
            if (activePerson?.name) {
                if (label) label.textContent = `Withdrawing from ${activePerson.name}...`;
            }
        }
    }

    // Update Standard Mode Steps (count/age)
    const stdScrollStep = document.getElementById('step-scroll');
    if (stdScrollStep) {
        if (isScanning) {
            stdScrollStep.className = 'progress-step active';
            stdScrollStep.style.display = '';
            const lbl = stdScrollStep.querySelector('.step-label');
            if (lbl && !lbl.classList.contains('wave-text')) lbl.classList.add('wave-text');
        } else if (isWithdrawing) {
            // Hide scroll step entirely during withdrawal so only withdraw bar + people list show
            stdScrollStep.style.display = 'none';
        }
    }

    const stdWithdrawStep = document.getElementById('step-withdraw');
    if (stdWithdrawStep) {
        if (isWithdrawing) {
            stdWithdrawStep.className = 'progress-step active';
            const lbl = stdWithdrawStep.querySelector('.step-label');
            if (lbl && !lbl.classList.contains('wave-text')) lbl.classList.add('wave-text');
        } else {
            stdWithdrawStep.className = 'progress-step';
            const lbl = stdWithdrawStep.querySelector('.step-label');
            if (lbl) lbl.classList.remove('wave-text');
        }
    }

    // Update People List
    updatePeopleList(state);

    // Update Action Buttons
    const pauseBtn = document.getElementById('btn-pause') || document.querySelector('[data-action="toggle-pause"]');
    if (pauseBtn) {
        pauseBtn.style.display = isWithdrawing ? '' : 'none';
        const btnText = pauseBtn.querySelector('.btn-text');
        if (btnText) btnText.textContent = state?.isPaused ? 'Resume' : 'Pause';
    }
}

function updatePeopleList(state) {
    const listContainer = document.getElementById('people-list-container');
    const isWithdrawing = state?.subMode === 'withdrawing';

    // Queue Visibility & Collapsible Logic
    const fullList = state?.foundMatchingPeople || [];
    // Filter for current batch only
    // Since content.js resets foundMatchingPeople on each run (startProcess), 
    // we can simply show the full list here as it represents the "Current Run".
    const foundPeople = fullList;

    // Use fullList for total count badge, but foundPeople (batch) for the list items?
    // User asked: "only show the currently being cleared list" -> foundPeople
    // But "still showing all cleared connections on the status page" -> That's the history list (handled elsewhere)

    const hasPeople = foundPeople.length > 0;
    const itemsWrapper = document.getElementById('people-list-wrapper');
    const queueCount = document.getElementById('queue-count');

    if (listContainer && itemsWrapper) {
        // Strict Hide on Idle/Success (Fixes "not hidden" bug)
        if (state.subMode === 'idle' || state.uiNavigation?.currentTab === 'completed') {
            listContainer.classList.add('phase-hidden');
            listContainer.style.display = 'none'; // Force hide
            return; // Stop processing
        } else {
            listContainer.style.display = ''; // Ensure visible if not idle
        }

        if (isWithdrawing && hasPeople) {
            listContainer.classList.remove('phase-hidden');
            // Ensure wrapper is open by default when running
            // Fix: Increase max-height to avoid "one line" bug
            // User requested ~5 items. Each item is ~40px. 5 * 40 = 200px.
            itemsWrapper.style.maxHeight = '220px';
        } else {
            listContainer.classList.add('phase-hidden');
        }
    }

    if (queueCount) queueCount.textContent = foundPeople.length;

    // Item Generation (Incremental Append)
    const listItems = document.getElementById('people-list-items');

    if (listItems && foundPeople.length > listItems.children.length) {
        const currentCount = listItems.children.length;
        const newPeople = foundPeople.slice(currentCount);

        const newHtml = newPeople.map((person, idx) => `
            <li class="person-item pending" data-index="${currentCount + idx}">
                <span class="person-name">${escapeHTML(person.name)}</span>
                <span class="person-age">${person.age || ''}</span>
            </li>
        `).join('');

        listItems.insertAdjacentHTML('beforeend', newHtml);
    }

    // Item Updates & Scoped Scrolling
    const currentIndex = state?.stats?.processed || 0;
    const items = listItems ? listItems.querySelectorAll('.person-item') : [];

    items.forEach((item, idx) => {
        const isCleared = idx < currentIndex;
        const isActive = idx === currentIndex && isWithdrawing;

        if (isCleared && !item.classList.contains('cleared')) {
            item.classList.remove('active', 'pending');
            item.classList.add('cleared');
            if (!item.querySelector('.person-check')) {
                item.innerHTML += '<span class="person-check">&#10003;</span>';
            }
        } else if (isActive && !item.classList.contains('active')) {
            item.classList.remove('pending');
            item.classList.add('active');

            // SCOPED SCROLL: Scroll wrapper to this item
            // Using scrollIntoView with 'nearest' keeps it in wrapper without moving page
            // But 'block: center' inside a small container is safest manually calculated
            if (activeTabId && itemsWrapper) { // Check if valid
                // Simple scrollintoview on the item inside the overflow container
                item.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
            }
        }
    });

}

// Helper: Update Theme Toggle Cursor
function updateThemeView() {
    const theme = localSettings.theme || 'light';
    const cursor = document.querySelector('.theme-cursor');
    const container = document.querySelector('.slide-toggle--2'); // Identify by modifier or context

    if (container) {
        container.dataset.selectedIndex = theme === 'light' ? 0 : 1;
    }

    const themeBtns = document.querySelectorAll('[data-theme]');
    themeBtns.forEach(btn => {
        const isActive = btn.dataset.theme === theme;
        btn.classList.toggle('active', isActive);

        if (isActive && cursor) {
            cursor.style.width = `${btn.offsetWidth}px`;
            cursor.style.transform = `translateX(${btn.offsetLeft}px)`;
        }
    });
}

// Helper: Update Home View without re-rendering (prevents flicker)
function updateHomeView(state) {
    const mode = state?.currentMode || 'count';
    const settings = state?.settings || localSettings;
    const safeThreshold = settings.safeThreshold || 1;
    const safeUnit = settings.safeUnit || 'month';
    const safeMode = settings.safeMode !== undefined ? settings.safeMode : (localSettings.safeMode !== false);

    // Update Safe Badge
    const safeBadge = document.getElementById('safe-badge');
    if (safeBadge) {
        safeBadge.style.display = safeMode ? 'block' : 'none';
        const badgeText = document.getElementById('safe-badge-text');
        if (badgeText) {
            badgeText.textContent = `${safeThreshold} ${safeUnit}${safeThreshold > 1 ? 's' : ''}`;
        }
    }

    // Update Mode Buttons & Cursor
    // Update Mode Buttons & Cursor
    // Mode is tri-state (0, 1, 2)
    const container = document.querySelector('.slide-toggle--3');

    if (container) {
        const index = mode === 'count' ? 0 : mode === 'age' ? 1 : 2;
        container.dataset.selectedIndex = index;
    }

    const modeBtns = document.querySelectorAll('[data-mode]');
    modeBtns.forEach(btn => {
        const isActive = btn.dataset.mode === mode;
        btn.classList.toggle('active', isActive);
    });

    // Update Input Sections
    const countInput = document.getElementById('count-input');
    if (countInput) countInput.style.display = mode === 'count' ? 'block' : 'none';

    const ageInput = document.getElementById('age-input');
    if (ageInput) ageInput.style.display = mode === 'age' ? 'block' : 'none';

    const messageInput = document.getElementById('message-input');
    if (messageInput) messageInput.style.display = mode === 'message' ? 'block' : 'none';

    // Update Description
    const modeDesc = document.getElementById('mode-desc');
    if (modeDesc) modeDesc.textContent = getModeDescription(mode, settings);

    // Update Start Button
    const startBtn = document.querySelector('button[data-action="start-clearing"]');
    if (startBtn) startBtn.style.display = mode === 'message' ? 'none' : 'block';
}

/* ==========================================================================
   UI RENDERING & TRANSITIONS (Non-Destructive)
   ========================================================================== */



async function renderUI(state) {
    // 0. Shell & Footer Updates (Always safe)
    // 0. Shell & Footer Updates (Always safe)
    renderShell(state);

    // NORMALIZE STATE: If in a view that Popup cannot show (side panel views), force Home context for Popup render
    // This ensures footer status is shown correctly (it hides if tab is 'completed', but Popup mimics Home)
    if (state.uiNavigation?.currentTab === 'completed' || state.uiNavigation?.currentTab === 'scanResults') {
        // Create a shallow copy to avoid mutating original state object reference if passed elsewhere
        state = { ...state, uiNavigation: { ...state.uiNavigation, currentTab: 'home' } };
    }

    const footerStatus = document.getElementById('footer-status');
    if (footerStatus) footerStatus.innerHTML = getFooterStatusHTML(state);

    // 1. DOM References
    const resultsSection = document.getElementById('results-section');
    const homeSection = document.getElementById('home-section');

    // 2. Transient State Checks (Blocking / Errors)
    // Checks standard vars: pageStatus is passed in or derived? 
    // In original code, pageStatus was a scoped variable in renderUI or global? 
    // It was global or passed. Let's assume global/outer scope or we need to re-check.
    // Original code: checkPage() set a local variable or we used chrome.tabs query.
    // Let's rely on state.pageStatus if it exists, or re-implement the check helper if needed.
    // For now, let's assume we handle normal flow. If we need error views, we inject into homeSection.

    // 3. State-Based View Toggling
    const isRunning = state.isRunning;
    const currentTab = state.uiNavigation?.currentTab || 'home';
    const subMode = state.subMode;

    const processSection = document.getElementById('process-section');
    const errorSection = document.getElementById('error-section');

    const hideAll = () => {
        [processSection, resultsSection, homeSection, errorSection].forEach(el => {
            if (el) {
                el.classList.add('hidden');
                el.classList.remove('fade-out', 'slide-up', 'fade-in'); // Clean slate
            }
        });
    };

    // 2. Blocking Page Status Check (Transient)
    if (pageStatus !== 'ok') {
        hideAll();
        if (errorSection) {
            errorSection.classList.remove('hidden');
            switch (pageStatus) {
                case 'offPlatform':
                    errorSection.innerHTML = getOffPlatformHTML(state);
                    break;
                case 'wrongPage':
                    errorSection.innerHTML = getWrongPageHTML(state);
                    break;
                case 'connectionError':
                    errorSection.innerHTML = getConnectionErrorHTML(state);
                    break;
            }
        }
        return;
    }

    if (isRunning) {
        // --- RUNNING STATE ---
        hideAll();
        if (processSection) {
            processSection.classList.remove('hidden');
            // Only inject HTML on first render; subsequent ticks use differential updates
            const alreadyRendered = processSection.querySelector('#progress-layout-standard, #progress-layout-message');
            if (!alreadyRendered) {
                processSection.innerHTML = getProgressHTML(state);
            }
            // Run incremental updates (progress bars, people list, buttons)
            updateProgress(state);
        }
    }
    else {
        // --- IDLE STATE ---
        if (currentTab === 'completed' || currentTab === 'scanResults') {
            // FORBIDDEN VIEWS IN POPUP: Redirect to home
            // We do not save this state change to storage to avoid messing up the side panel,
            // but we render the home view instead.
            hideAll();
            if (homeSection) {
                homeSection.classList.remove('hidden');
                homeSection.innerHTML = getHomeHTML(state);
            }
        }
        else {
            document.body.classList.remove('results-active');
            // --- Standard Views (Home, Settings, Scan Results, etc) ---
            hideAll();
            if (homeSection) {
                homeSection.classList.remove('hidden');

                // Inject content
                if (currentTab === 'settings') {
                    homeSection.innerHTML = getSettingsHTML(state);
                    requestAnimationFrame(updateThemeView);
                } else if (currentTab === 'history') {
                    // Async History
                    chrome.storage.local.get('withdrawalHistory').then(({ withdrawalHistory }) => {
                        homeSection.innerHTML = getHistoryHTML(state, withdrawalHistory || []);
                    });
                } else if (currentTab === 'stats') {
                    // Async Stats
                    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
                        if (tab?.id) {
                            chrome.tabs.sendMessage(tab.id, { action: 'GET_PENDING_COUNT' })
                                .then(response => {
                                    homeSection.innerHTML = getStatsHTML(state, response?.count);
                                })
                                .catch(async () => {
                                    // Fallback: Content script might not be loaded yet or crashed. Scrape live.
                                    try {
                                        const results = await chrome.scripting.executeScript({
                                            target: { tabId: tab.id },
                                            func: () => {
                                                const navBtn = document.querySelector('nav button[aria-current="true"]');
                                                let text = navBtn ? navBtn.textContent : '';
                                                let match = text.match(/People\s*\(([0-9,]+)\)/i);
                                                if (match) return parseInt(match[1].replace(/,/g, ''), 10);

                                                const spans = document.querySelectorAll('nav span');
                                                for (const span of spans) {
                                                    text = span.textContent || '';
                                                    match = text.match(/People\s*\(([0-9,]+)\)/i);
                                                    if (match) return parseInt(match[1].replace(/,/g, ''), 10);
                                                }
                                                return null;
                                            }
                                        });
                                        const count = results?.[0]?.result;
                                        homeSection.innerHTML = getStatsHTML(state, count);
                                    } catch (e) {
                                        homeSection.innerHTML = getStatsHTML(state, null);
                                    }
                                });
                        } else {
                            homeSection.innerHTML = getStatsHTML(state, null);
                        }
                    });
                } else {
                    // Default Home
                    // Check if we can do a smart update to avoid flicker
                    if (homeSection.querySelector('#safe-badge') && homeSection.querySelector('.slide-toggle')) {
                        updateHomeView(state);
                    } else {
                        // Full render if empty
                        homeSection.innerHTML = getHomeHTML(state);
                        // Initialize cursor position immediately to prevent jump
                        // We use setTimeout 0 to wait for DOM paint/layout so offsetWidth is correct
                        requestAnimationFrame(() => updateHomeView(state));
                    }
                }
            }
        }
    }

    // Auto-Scroll helper (if list exists)
    const activePerson = document.querySelector('.person-item.active');
    if (activePerson) {
        activePerson.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}


// Navigate by updating storage (triggers re-render via onChanged)
async function navigateTo(tab, passedState = null) {
    let state;
    if (passedState) {
        state = passedState;
    } else {
        const { extension_state } = await chrome.storage.local.get('extension_state');
        state = extension_state || { ...DEFAULT_STATE };
    }

    // Block navigation if running (except to progress)
    if (state.isRunning && tab !== 'progress' && tab !== 'home') {
        return;
    }

    state.uiNavigation = { currentTab: tab };
    await chrome.storage.local.set({ extension_state: state });
}

// ============ TEMPLATE FUNCTIONS ============

function getHomeHTML(state) {
    const mode = state?.currentMode || 'count';
    const safeThreshold = state?.settings?.safeThreshold || localSettings.safeThreshold || 1;
    const safeUnit = state?.settings?.safeUnit || localSettings.safeUnit || 'month';
    const safeMode = state?.settings?.safeMode !== undefined ? state.settings.safeMode : (localSettings.safeMode !== false);
    const stats = state?.stats || {};
    const alltimeCleared = stats.alltimeCleared || 0;

    const countActive = mode === 'count' ? 'active' : '';
    const ageActive = mode === 'age' ? 'active' : '';
    const messageActive = mode === 'message' ? 'active' : '';

    const safeBadgeDisplay = safeMode ? 'block' : 'none';

    return `
        <div class="view">
            <!-- Safe Mode Notice -->
            <div id="safe-badge" class="safe-notice" style="display: ${safeBadgeDisplay}">
                Preserves connections sent within the last 
                <a href="#" data-action="open-settings"><span id="safe-badge-text">${safeThreshold} ${safeUnit}${safeThreshold > 1 ? 's' : ''}</span></a>
            </div>

            <!-- Mode Toggle (Generic Slide Toggle) -->
            <div class="slide-toggle slide-toggle--3 slide-toggle--mb" data-selected-index="${mode === 'count' ? 0 : mode === 'age' ? 1 : 2}">
                <div class="slide-cursor"></div>
                <button data-action="set-mode" data-mode="count" class="slide-btn ${countActive}">By Count</button>
                <button data-action="set-mode" data-mode="age" class="slide-btn ${ageActive}">By Age</button>
                <button data-action="set-mode" data-mode="message" class="slide-btn ${messageActive}">By Message</button>
            </div>

            <!-- By Count Input -->
            <div id="count-input" class="input-section" style="display: ${mode === 'count' ? 'block' : 'none'}">
                <label>Connections to withdraw</label>
                <div class="input-row full-width">
                    <input type="number" id="withdraw-count" value="${localSettings.withdrawCount || 10}" min="1" max="5000">
                    <span class="suffix">people</span>
                </div>
            </div>

            <!-- By Age Input -->
            <div id="age-input" class="input-section" style="display: ${mode === 'age' ? 'block' : 'none'}">
                <div class="input-row full-width">
                    <input type="number" id="age-value" value="${localSettings.ageValue || 3}" min="1" max="365">
                    <select id="age-unit">
                        <option value="day" ${localSettings.ageUnit === 'day' ? 'selected' : ''}>days</option>
                        <option value="week" ${localSettings.ageUnit === 'week' ? 'selected' : ''}>weeks</option>
                        <option value="month" ${localSettings.ageUnit === 'month' ? 'selected' : ''}>months</option>
                        <option value="year" ${localSettings.ageUnit === 'year' ? 'selected' : ''}>years</option>
                    </select>
                    <span class="suffix">ago +</span>
                </div>
            </div>

            <!-- By Message Input -->
            <div id="message-input" class="input-section" style="display: ${mode === 'message' ? 'block' : 'none'}">
                <p class="mode-desc-small">
                    Scans all connections to auto-discover message groups. You can select which groups to withdraw.
                </p>
                <button data-action="start-scan" class="primary-btn scan-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                    Start Scan
                </button>
            </div>

            <!-- Mode Description -->
            <p id="mode-desc" class="mode-desc">${getModeDescription(mode, localSettings)}</p>

            <!-- Start Button (hidden for message mode) -->
            <button data-action="start-clearing" class="primary-btn" style="display: ${mode === 'message' ? 'none' : 'block'}">Start Clearing</button>

            <!-- Lifetime Stats -->
                <div class="home-alltime">
                    <span id="home-alltime-count">${alltimeCleared}</span> connections cleared all-time
                </div>
        </div>
    `;
}

function getProgressHTML(state) {
    const mode = state?.currentMode || 'count';
    const subMode = state?.subMode || 'scanning';
    const isPaused = state?.isPaused || false;
    const progress = state?.status?.progress || 0;
    const statusText = state?.status?.text || 'Starting...';
    const processed = state?.stats?.processed || 0;
    const total = state?.stats?.total || 0;

    const isMessageMode = mode === 'message';
    const isScanning = subMode === 'scanning';
    const isWithdrawing = subMode === 'withdrawing';

    // Standard layout (count/age modes)
    const standardLayoutHTML = `
        <div id="progress-layout-standard">
            <!-- Scroll / Discovery Step -->
            <div id="step-scroll" class="progress-step ${isScanning ? 'active' : 'completed'}">
                <div class="step-header">
                    ${isWithdrawing ? '<svg class="step-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>' : '<span class="step-num">1</span>'}
                    <span class="step-label ${isScanning ? 'wave-text' : ''}">Discovery Progress</span>
                </div>
                <div class="step-content">
                    <div class="progress-bar-bg">
                        <div id="scroll-progress-fill" class="progress-bar-fill" style="width: ${isScanning ? progress : 100}%"></div>
                    </div>
                    <p id="scroll-status" class="status-text">${isScanning ? statusText : 'Complete'}</p>
                </div>
            </div>

            <!-- Withdraw Step -->
            <div id="step-withdraw" class="progress-step ${isWithdrawing ? 'active' : ''}">
                <div class="step-header">
                    <span class="step-num">2</span>
                    <span class="step-label">Withdrawal Progress</span>
                </div>
                <div class="step-content">
                    <div class="progress-bar-bg">
                        <div id="progress-fill" class="progress-bar-fill" style="width: ${isWithdrawing ? progress : 0}%"></div>
                    </div>
                    <p id="status-text" class="status-text">${isWithdrawing ? statusText : 'Waiting...'}</p>
                </div>
            </div>
        </div>
    `;

    // Live People List data - declare before use in messageLayoutHTML
    const foundPeople = state?.foundMatchingPeople || [];
    const currentIndex = state?.stats?.processed || 0;

    // Message mode layout with transition choreography
    const activePerson = foundPeople[currentIndex];
    const activePersonName = activePerson?.name || '';

    const messageLayoutHTML = `
        <div id="progress-layout-message">
            <!-- Scanning Step (fades out when withdrawing) -->
            <div id="msg-step-scan" class="progress-step phase-transition ${isScanning ? 'active phase-visible' : 'phase-hidden'}">
                <div class="step-header">
                    <span class="step-num">1</span>
                    <span class="step-label wave-text">Scanning...</span>
                </div>
                <div class="step-content">
                    <div class="progress-bar-bg">
                        <div id="msg-scan-fill" class="progress-bar-fill" style="width: ${progress}%"></div>
                    </div>
                    <p id="msg-scan-status" class="status-text">${statusText}</p>
                </div>
            </div>

            <!-- Withdrawing Step (slides in and fades in when active) -->
            <div id="msg-step-withdraw" class="progress-step phase-transition ${isWithdrawing ? 'active phase-visible phase-slide-up' : 'phase-hidden'}">
                <div class="step-header">
                    <svg class="step-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="3"><path d="M20 6L9 17l-5-5" /></svg>
                    <span class="step-label">Withdrawing...</span>
                </div>
                <div class="step-content">
                    <div class="progress-bar-bg">
                        <div id="msg-withdraw-fill" class="progress-bar-fill" style="width: ${progress}%"></div>
                    </div>
                    <p id="msg-withdraw-status" class="status-text">${statusText}</p>
                </div>
            </div>
        </div>
    `;

    const peopleListHTML = foundPeople.length > 0 ? `
        <div id="people-list-container" class="people-list ${isWithdrawing ? 'visible' : 'hidden'}">
            <h4 class="list-title">Connections to Clear</h4>
            <ul class="people-list-items">
                ${foundPeople.map((person, idx) => {
        const isCleared = person.cleared || idx < currentIndex;
        const isActive = !isCleared && idx === currentIndex && isWithdrawing;
        const statusClass = isCleared ? 'cleared' : (isActive ? 'active' : 'pending');
        return `
                        <li class="person-item ${statusClass}" data-index="${idx}">
                            <span class="person-name">${escapeHTML(person.name)}</span>
                            <span class="person-age">${person.age || ''}</span>
                            ${isCleared ? '<span class="person-check">&#10003;</span>' : ''}
                        </li>
                    `;
    }).join('')}
            </ul>
        </div>
    ` : '';

    return `
        <div class="view">
            <h2 id="active-operation-title" class="section-title">Clearing connections...</h2>
            
            ${isMessageMode ? messageLayoutHTML : standardLayoutHTML}
            
            ${peopleListHTML}
            
            <!--Action Buttons-->
                <div class="progress-actions" style="display: flex; gap: 8px; margin-top: 12px;">
                    ${isWithdrawing ? `
                    <button data-action="toggle-pause" class="secondary-btn" style="flex: 1;">
                        <span class="btn-text">${isPaused ? 'Resume' : 'Pause'}</span>
                    </button>
                ` : ''}
                    <button data-action="stop-operation" class="secondary-btn" style="flex: 1;">
                        <span class="btn-text">Stop</span>
                    </button>
                </div>
        </div>
    `;
}




// HTML Generator: Settings View
function getSettingsHTML(state) {
    // PREFER the passed state.settings over localSettings to ensure we render what was just loaded/saved
    const settings = state?.settings || localSettings;

    // Fallback to defaults
    const safeMode = settings.safeMode !== false;
    const safeThreshold = settings.safeThreshold || 6;
    const safeUnit = settings.safeUnit || 'month';
    const debugMode = settings.debugMode || false;
    const theme = settings.theme || 'light';

    return `
        <div class="view">
            <div class="section-title">Settings</div>
            
            <div class="setting-group">
                <!-- Appearance (No Label, just toggle) -->
                <div class="slide-toggle slide-toggle--2" data-selected-index="${theme === 'light' ? 0 : 1}">
                    <div class="slide-cursor"></div>
                    <button data-action="set-theme" data-theme="light" class="slide-btn ${theme === 'light' ? 'active' : ''}" title="Light">
                        <!-- Sun Icon -->
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="5"/>
                            <line x1="12" y1="1" x2="12" y2="3"/>
                            <line x1="12" y1="21" x2="12" y2="23"/>
                            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                            <line x1="1" y1="12" x2="3" y2="12"/>
                            <line x1="21" y1="12" x2="23" y2="12"/>
                            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                        </svg>
                    </button>
                    <button data-action="set-theme" data-theme="dark" class="slide-btn ${theme === 'dark' ? 'active' : ''}" title="Dark">
                        <!-- Moon Icon -->
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                        </svg>
                    </button>
                </div>
            </div>

            <div class="setting-group">
                <div class="setting-option">
                    <label class="checkbox-label">
                        <input type="checkbox" id="safe-mode-toggle" ${safeMode ? 'checked' : ''}>
                        <span class="option-text">
                            <strong>Enable Safe Mode</strong>
                            <small>Prevent withdrawing invitations sent recently.</small>
                        </span>
                    </label>
                    
                    <div id="safe-threshold-group" class="inline-threshold" style="display: ${safeMode ? 'flex' : 'none'}">
                        <input type="number" id="safe-threshold" value="${safeThreshold}" min="1" max="60" class="input-sm">
                        <select id="safe-unit" class="select-sm">
                            <option value="day" ${safeUnit === 'day' ? 'selected' : ''}>Days</option>
                            <option value="week" ${safeUnit === 'week' ? 'selected' : ''}>Weeks</option>
                            <option value="month" ${safeUnit === 'month' ? 'selected' : ''}>Months</option>
                        </select>
                    </div>
                </div>
            </div>

            <div class="setting-group">
                <div class="setting-option">
                    <label class="checkbox-label">
                        <input type="checkbox" id="debug-mode-toggle" ${debugMode ? 'checked' : ''}>
                        <span class="option-text">
                            <strong>Enable Debug Mode</strong>
                            <small>Show detailed logs and keep window open.</small>
                        </span>
                    </label>
                </div>
            </div>

            <div class="btn-row">
                <button data-action="go-home" class="primary-btn">Done</button>
            </div>
        </div>
    `;
}

// Auto-Save Helper
const isAutoSaving = { current: false };

async function autoSaveSettings() {
    isAutoSaving.current = true;
    console.log('Auto-saving settings...');

    const safeModeEl = document.getElementById('safe-mode-toggle');
    const safeThresholdEl = document.getElementById('safe-threshold');
    const safeUnitEl = document.getElementById('safe-unit');
    const debugModeEl = document.getElementById('debug-mode-toggle');

    // Guard: Ensure elements exist before reading
    if (!safeModeEl || !safeThresholdEl || !safeUnitEl || !debugModeEl) {
        isAutoSaving.current = false;
        return;
    }

    const safeMode = safeModeEl.checked;
    const safeThreshold = parseInt(safeThresholdEl.value, 10);
    const safeUnit = safeUnitEl.value;
    const debugMode = debugModeEl.checked;

    // Toggle visibility of threshold group immediately
    const thresholdGroup = document.getElementById('safe-threshold-group');
    if (thresholdGroup) {
        thresholdGroup.style.display = safeMode ? 'flex' : 'none';
    }

    // Update runtime localSettings
    localSettings.safeMode = safeMode;
    localSettings.safeThreshold = safeThreshold;
    localSettings.safeUnit = safeUnit;
    localSettings.debugMode = debugMode;

    // Save flat keys to storage to notify Side Panel listeners immediately
    await chrome.storage.local.set({
        safeMode,
        safeThreshold,
        safeUnit,
        debugMode
    });

    // Persist to storage (extension_state)
    const { extension_state } = await chrome.storage.local.get('extension_state');
    const newState = extension_state || { ...DEFAULT_STATE };

    // Ensure nested object exists
    newState.settings = newState.settings || { ...DEFAULTS };

    // Update settings in state
    newState.settings.safeMode = safeMode;
    newState.settings.safeThreshold = safeThreshold;
    newState.settings.safeUnit = safeUnit;
    newState.settings.debugMode = debugMode;
    newState.settings.withdrawCount = parseInt(document.getElementById('withdraw-count')?.value, 10) || DEFAULTS.withdrawCount;
    newState.settings.ageValue = parseInt(document.getElementById('age-value')?.value, 10) || DEFAULTS.ageValue;
    newState.settings.ageUnit = document.getElementById('age-unit')?.value || DEFAULTS.ageUnit;

    if (localSettings.theme) {
        newState.settings.theme = localSettings.theme;
    }

    await chrome.storage.local.set({ extension_state: newState });
    console.log('Settings saved:', newState.settings);

    // Reset flag after a short delay to allow storage event to fire and be ignored
    setTimeout(() => { isAutoSaving.current = false; }, 100);
}

function getStatsHTML(state, livePendingCount = null) {
    const stats = state?.stats || {};
    const lastRunResult = state?.lastRunResult || null;

    // Per spec: ~1,250 capacity limit
    const maxCapacity = 1250;

    // All-Time cumulative total
    const alltimeCleared = stats.alltimeCleared || 0;

    // Current Connections: live page query > stored value
    let currentConnections = livePendingCount;
    let dataSource = 'Live';

    if (currentConnections === null && stats.pendingInvitations != null) {
        currentConnections = stats.pendingInvitations;
        dataSource = 'Stored';
    }

    const hasData = currentConnections !== null;
    const displayCurrent = hasData ? currentConnections : '---';
    const availableCapacity = hasData ? Math.max(0, maxCapacity - currentConnections) : '---';
    const capacityPercent = hasData ? Math.min(100, Math.round((currentConnections / maxCapacity) * 100)) : 0;

    // Health bar color per spec: green <25%, yellow 25-50%, orange 50-75%, red >75%
    let healthColor = 'green';
    if (capacityPercent > 75) healthColor = 'red';
    else if (capacityPercent > 50) healthColor = 'orange';
    else if (capacityPercent > 25) healthColor = 'yellow';

    // Last Run: elapsed time since last operation
    let lastRunText = 'Never';
    if (lastRunResult?.timestamp) {
        const elapsed = Date.now() - lastRunResult.timestamp;
        const mins = Math.floor(elapsed / 60000);
        const hours = Math.floor(mins / 60);
        const days = Math.floor(hours / 24);
        if (days > 0) lastRunText = `${days} day${days > 1 ? 's' : ''} ago`;
        else if (hours > 0) lastRunText = `${hours} hour${hours > 1 ? 's' : ''} ago`;
        else if (mins > 1) lastRunText = `${mins} minutes ago`;
        else lastRunText = 'Just now';
    }

    // Last Cleared: number removed in last session
    const lastCleared = lastRunResult?.processed || 0;

    // Source status text
    let statusText = 'Open LinkedIn Sent Invitations to see live count';
    if (hasData) {
        if (dataSource === 'Live') {
            statusText = 'Live count from LinkedIn page';
        } else if (stats.pendingUpdatedAt) {
            const ago = Math.round((Date.now() - stats.pendingUpdatedAt) / 60000);
            statusText = ago < 1 ? 'Updated just now' : `Updated ${ago}m ago`;
        } else {
            statusText = 'Last known count';
        }
    }

    return `
        <div class="view">
            <h3>Statistics</h3>
            
            <div class="stats-section">
                <div class="stat-row">
                    <span>Current Connections</span>
                    <strong>${displayCurrent}</strong>
                </div>
                <div class="stat-row">
                    <span>Available Capacity</span>
                    <strong>${availableCapacity}</strong>
                </div>
                <div class="stat-row">
                    <span>Last Run</span>
                    <strong>${lastRunText}</strong>
                </div>
                <div class="stat-row">
                    <span>Last Cleared</span>
                    <strong>${lastCleared}</strong>
                </div>
                <div class="stat-row">
                    <span>All-Time Cleared</span>
                    <strong>${alltimeCleared}</strong>
                </div>
                
                <!-- Capacity Health Bar -->
                <div class="health-section">
                    <div class="health-label-row">
                        <span>Capacity Health</span>
                        <span>${displayCurrent} / ~${maxCapacity}</span>
                    </div>
                    <div class="health-bar-bg">
                        <div class="health-bar-fill ${healthColor}" style="width: ${capacityPercent}%"></div>
                    </div>
                    <p class="health-text">${statusText}</p>
                </div>
            </div>

            <button data-action="go-home" class="secondary-btn" style="margin-top: 12px;">Back</button>
        </div>
    `;
}

function getHistoryHTML(state, withdrawalHistory = []) {
    let historyContent = '';

    if (withdrawalHistory.length === 0) {
        historyContent = '<p class="empty-history">No withdrawals recorded yet.</p>';
    } else {
        // Render sessions in reverse chronological order
        const sessions = [...withdrawalHistory].reverse();
        historyContent = sessions.map((session, index) => {
            const withdrawals = session.withdrawals || [];
            const isExpanded = index === 0; // First session expanded by default
            const withdrawalItems = [...withdrawals].reverse().map(w => {
                const profileLink = w.profileUrl
                    ? `<a href="${w.profileUrl}" target="_blank" class="history-link">${w.name || 'Unknown'}</a>`
                    : `<span>${w.name || 'Unknown'}</span>`;
                return `
        <div class="history-entry">
            ${profileLink}
            <span class="history-age">${w.age || ''}</span>
        </div>
        `;
            }).join('');

            return `
                <div class="history-session ${isExpanded ? 'expanded' : 'collapsed'}">
                    <div class="history-session-header" data-action="toggle-session">
                        <div class="session-header-left">
                            <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="6 9 12 15 18 9"></polyline>
                            </svg>
                            <span class="session-date">${session.sessionDate || session.sessionId}</span>
                        </div>
                        <span class="session-count">${withdrawals.length} withdrawn</span>
                    </div>
                    <div class="history-session-items">
                        ${withdrawalItems}
                    </div>
                </div>
        `;
        }).join('');
    }

    return `
        <div class="view">
            <h2 class="section-title">Withdrawal History</h2>
            <div id="history-content" class="history-content">
                ${historyContent}
            </div>
            <button data-action="go-home" class="secondary-btn">Back</button>
        </div>
    `;
}

function extractTopicFromMessage(msg) {
    if (!msg) return null;
    const patterns = [
        /(?:interested in|about|regarding|re:|for)\s+["']?([A-Z][^.!?"'\n]{5,60})/i,
        /(?:position|role|opportunity|project|job)\s*(?:at|for|with)?\s+["']?([A-Z][^.!?"'\n]{3,40})/i,
        /(?:reaching out|connect).*?(?:about|regarding)\s+([A-Z][^.!?"'\n]{5,50})/i,
    ];
    for (const pat of patterns) {
        const m = msg.match(pat);
        if (m) return m[1].trim();
    }
    return null;
}



function updateWithdrawButton() {
    const btn = document.getElementById('withdraw-selected-btn');
    const countSpan = document.getElementById('selected-count');
    if (btn) btn.disabled = selectedScanHashes.size === 0;
    if (countSpan) countSpan.textContent = selectedScanHashes.size;
}

function getWrongPageHTML(state) {
    return `
        <div class="view">
            <div class="message-box">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ff9800" stroke-width="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <h2 id="wrong-page-title">Wrong Page</h2>
                <p id="wrong-page-msg">Please navigate to the Sent Invitations page.</p>
                <button data-action="open-sent-page" class="primary-btn">Open Sent Invitations</button>
            </div>
        </div>
    `;
}

function getOffPlatformHTML(state) {
    return `
        <div class="view">
            <div class="message-box">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#2196f3" stroke-width="2">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                <h2>Off Platform</h2>
                <p>ClearConnect works on LinkedIn. Open the Sent Invitations page to get started.</p>
                <button data-action="open-sent-page" class="primary-btn">Open LinkedIn</button>
            </div>
        </div>
    `;
}

function getConnectionErrorHTML(state) {
    return `
        <div class="view">
            <div class="message-box">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#f44336" stroke-width="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="15" y1="9" x2="9" y2="15" />
                    <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
                <h2>Connection Error</h2>
                <p>Could not verify page status. Please refresh LinkedIn.</p>
                <button data-action="open-sent-page" class="secondary-btn">Reload Extension</button>
            </div>
        </div>
    `;
}

// ============ HELPER FUNCTIONS ============

function getModeDescription(mode, settings) {
    const count = settings.withdrawCount || 10;
    const ageValue = settings.ageValue || 3;
    const ageUnit = settings.ageUnit || 'month';

    switch (mode) {
        case 'count':
            return `Withdraws the ${count} oldest pending connections.`;
        case 'age':
            return `Withdraws all connections sent more than ${ageValue} ${ageUnit}${ageValue > 1 ? 's' : ''} ago.`;
        case 'message':
            return 'Scan to find connections by message pattern.';
        default:
            return '';
    }
}

// ============ EVENT DELEGATION ============

function setupEventDelegation() {
    const appRoot = document.getElementById('app-root');
    if (!appRoot) {
        console.error('CRITICAL: app-root not found in DOM');
        return;
    }

    // Global Event Delegation
    appRoot.addEventListener('click', async (e) => {
        const target = e.target.closest('[data-action]') || e.target.closest('#settings-btn, #stats-btn, #history-btn, #logo-btn');
        if (!target) return;

        // Header Navigation
        if (target.id === 'settings-btn') { navigateTo('settings'); return; }
        if (target.id === 'stats-btn') { navigateTo('stats'); return; }
        if (target.id === 'history-btn') { navigateTo('history'); return; }
        if (target.id === 'logo-btn') {
            e.preventDefault();
            navigateTo('home');
            return;
        }

        // Data-action based routing
        // Event Delegation: Global Link Handler
        if (e.target.id === 'view-results-link') {
            // Fetch fresh state to avoid scope issues
            const { extension_state } = await chrome.storage.local.get('extension_state');
            const state = extension_state || DEFAULT_STATE;

            state.uiNavigation = state.uiNavigation || {};
            state.uiNavigation.currentTab = 'completed';

            await chrome.storage.local.set({ extension_state: state });
            // Force Popup to always start on Home
            if (state.uiNavigation.currentTab !== 'home') {
                state.uiNavigation.currentTab = 'home';
                // We don't necessarily need to save this back to storage immediately unless we want to persist the reset,
                // but for display purposes we just mutate the local state object before rendering.
            }

            renderUI(state);
            return;
        }

        const action = target.dataset.action;
        if (!action) return;

        // Allow default input behavior for form elements
        if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
        }

        handleAction(action, target);
    });

    // Settings Auto-Save Delegation
    appRoot.addEventListener('change', (e) => {
        if (e.target.matches('#safe-mode-toggle, #safe-threshold, #safe-unit, #debug-mode-toggle')) {
            console.log('Setting changed:', e.target.id);
            autoSaveSettings();
        }
    });
}

async function handleAction(action, target) {
    switch (action) {
        // Navigation
        case 'go-home':
            navigateTo('home');
            break;
        case 'open-settings':
            navigateTo('settings');
            break;
        case 'open-stats':
            navigateTo('stats');
            break;
        case 'resume-scan-results':
            navigateTo('scanResults');
            break;

        // Mode switching
        case 'set-mode':
            const mode = target.dataset.mode;
            if (mode) setMode(mode);
            break;

        // Theme Toggle
        case 'set-theme': {
            const themeBtn = target.closest('[data-theme]');
            if (!themeBtn) return;
            const theme = themeBtn.dataset.theme;

            // 1. Suppress global re-render to preserve animation
            if (typeof isAutoSaving !== 'undefined') {
                isAutoSaving.current = true;
            }

            // 2. Immediate visual update (Animation)
            const wrapper = themeBtn.closest('.slide-toggle');
            if (wrapper) {
                // Update index for slide effect
                wrapper.dataset.selectedIndex = theme === 'light' ? 0 : 1;
                // Update active buttons
                wrapper.querySelectorAll('.slide-btn').forEach(btn => {
                    btn.classList.toggle('active', btn === themeBtn);
                });
            }

            // 3. Apply theme to document (Instant)
            document.documentElement.setAttribute('data-theme', theme);
            localSettings.theme = theme;

            // 4. Persist
            const { extension_state } = await chrome.storage.local.get('extension_state');
            const newState = extension_state || DEFAULT_STATE;
            newState.settings = newState.settings || {};
            newState.settings.theme = theme;

            await chrome.storage.local.set({
                extension_state: newState,
                theme: theme
            });

            // 5. Release lock after animation finishes + storage event fires
            setTimeout(() => {
                if (typeof isAutoSaving !== 'undefined') isAutoSaving.current = false;
            }, 300); // 300ms matches CSS transition
            break;
        }

        // Operations
        case 'start-clearing':
            startOperation();
            break;
        case 'start-scan':
            startScan();
            break;
        case 'toggle-pause':
            togglePause();
            break;
        case 'stop-operation':
            stopOperation();
            break;
        case 'continue-clearing':
            continueOperation();
            break;

        // Settings
        case 'save-settings':
            saveSettings();
            break;

        // Other
        case 'open-sent-page':
            openSentPage();
            break;

        case 'close-footer': {
            // 1. Suppress global re-render
            if (typeof isAutoSaving !== 'undefined') {
                isAutoSaving.current = true;
            }

            // 2. Immediate visual update (Manual DOM)
            const footer = document.querySelector('.footer');
            if (footer) {
                footer.style.display = 'none';
                // Also hide specific children if needed, but hiding container is usually enough
                const footerContent = document.getElementById('footer-content');
                if (footerContent) footerContent.innerHTML = '';
            }

            // 3. Update State & Persist
            const { extension_state } = await chrome.storage.local.get('extension_state');

            if (extension_state?.lastRunResult) {
                extension_state.lastRunResult = null;
                await chrome.storage.local.set({ extension_state });
            } else {
                // Otherwise it's the idle "Ready" message - hide for this session
                localSettings.hideReadyStatus = true;
                // We don't save localSettings.hideReadyStatus to storage usually, 
                // but if we did, we'd do it here. 
                // For now, just suppressing the re-render is enough if it WAS triggering one.
                // If it wasn't triggering one, we wouldn't see a flicker. 
                // The flickering implies storage WAS changing.
            }

            // 4. Release lock
            setTimeout(() => {
                if (typeof isAutoSaving !== 'undefined') isAutoSaving.current = false;
            }, 300);
            break;
        }

        case 'withdraw-selected':
            if (!activeTabId || selectedScanHashes.size === 0) break;
            try {
                await chrome.tabs.sendMessage(activeTabId, {
                    action: 'WITHDRAW_SELECTED',
                    selectedHashes: Array.from(selectedScanHashes),
                    debugMode: localSettings.debugMode === true,
                    safeMode: localSettings.safeMode !== false,
                    safeThreshold: localSettings.safeThreshold || 1,
                    safeUnit: localSettings.safeUnit || 'month'
                });

                // FILTER & SAVE REMAINING RESULTS for "Clear More" workflow
                // We keep the groups that were NOT selected
                const remainingResults = foundScanResults.filter(item => !selectedScanHashes.has(item.id));
                chrome.storage.local.set({ savedScanResults: remainingResults });

                // Clear local selection state
                selectedScanHashes.clear();

                // Open side panel and close popup

                // Open side panel and close popup
                chrome.runtime.sendMessage({ action: 'OPEN_SIDEPANEL', tabId: activeTabId }).catch(() => { });
                window.close();
            } catch (e) {
                console.log('Content script not ready:', e);
            }
            break;

        // History session toggle
        case 'toggle-session':
            const session = target.closest('.history-session');
            if (session) {
                session.classList.toggle('expanded');
                // Ensure collapsed class is toggled opposite
                if (session.classList.contains('expanded')) {
                    session.classList.remove('collapsed');
                } else {
                    session.classList.add('collapsed');
                }
            }
            break;

        // Select Continue Mode
        case 'select-continue-mode':
            const modeVal = target.dataset.value;
            const radio = document.querySelector(`input[name = 'continue-mode'][value = '${modeVal}']`);
            if (radio) radio.checked = true;
            break;

        // Refresh connection (stale popup/content script)
        case 'refresh-connection':
            if (activeTabId) {
                chrome.tabs.reload(activeTabId);
            }
            window.close();
            break;
    }
}

// ============ ACTIONS ============

async function setMode(mode) {
    const { extension_state } = await chrome.storage.local.get('extension_state');
    const state = extension_state || { ...DEFAULT_STATE };
    state.currentMode = mode;
    await chrome.storage.local.set({ extension_state: state });
}

async function setTheme(theme) {
    localSettings.theme = theme;
    await chrome.storage.local.set({ theme });
    // Re-render immediately to apply
    const { extension_state } = await chrome.storage.local.get('extension_state');
    renderUI(extension_state || DEFAULT_STATE);
}

async function saveSettings() {
    const safeMode = document.getElementById('safe-mode-toggle')?.checked !== false;
    const safeThreshold = parseInt(document.getElementById('safe-threshold')?.value, 10) || 1;
    const safeUnit = document.getElementById('safe-unit')?.value || 'month';
    const debugMode = document.getElementById('debug-mode-toggle')?.checked === true;

    localSettings.safeMode = safeMode;
    localSettings.safeThreshold = safeThreshold;
    localSettings.safeUnit = safeUnit;
    localSettings.debugMode = debugMode;

    // Save flat keys
    await chrome.storage.local.set({
        safeMode,
        safeThreshold,
        safeUnit,
        debugMode
    });

    // Also sync into extension_state.settings so getHomeHTML reads correct value immediately
    const { extension_state } = await chrome.storage.local.get('extension_state');
    if (extension_state) {
        extension_state.settings = extension_state.settings || {};
        extension_state.settings.safeMode = safeMode;
        extension_state.settings.safeThreshold = safeThreshold;
        extension_state.settings.safeUnit = safeUnit;
        extension_state.settings.debugMode = debugMode;
        await chrome.storage.local.set({ extension_state });
    }

    navigateTo('home');
}

async function startOperation(options = {}) {
    if (!activeTabId) {
        showFooterError('No active tab found. Open LinkedIn Sent Invitations first.');
        return;
    }

    const { extension_state } = await chrome.storage.local.get('extension_state');
    const mode = extension_state?.currentMode || 'count';
    const count = parseInt(document.getElementById('withdraw-count')?.value, 10) || 10;
    const ageValue = parseInt(document.getElementById('age-value')?.value, 10) || 3;
    const ageUnit = document.getElementById('age-unit')?.value || 'month';

    // Save input values
    localSettings.withdrawCount = count;
    localSettings.ageValue = ageValue;
    localSettings.ageUnit = ageUnit;
    await chrome.storage.local.set({ withdrawCount: count, ageValue, ageUnit });

    // Send message to content script
    try {
        await chrome.tabs.sendMessage(activeTabId, {
            action: 'START_WITHDRAW',
            mode: options.mode || mode,
            count: options.count !== undefined ? options.count : count,
            ageValue: options.ageValue !== undefined ? options.ageValue : ageValue,
            ageUnit: options.ageUnit || ageUnit,
            safeMode: localSettings.safeMode,
            safeThreshold: localSettings.safeThreshold,
            safeUnit: localSettings.safeUnit || 'month',
            debugMode: localSettings.debugMode,
            immediate: options.immediate === true
        });

        // Reset viewOnly flag on new run
        const { extension_state } = await chrome.storage.local.get('extension_state');
        if (extension_state) {
            extension_state.viewOnly = false;
            await chrome.storage.local.set({ extension_state });
        }

        // Open side panel and close popup
        chrome.runtime.sendMessage({ action: 'OPEN_SIDEPANEL', tabId: activeTabId }).catch(() => { });
        window.close();
    } catch (e) {
        console.log('Content script not ready:', e);
        showFooterError('Page not ready. Please refresh the LinkedIn page and try again.');
    }
}

async function startScan() {
    if (!activeTabId) {
        showFooterError('No active tab found. Open LinkedIn Sent Invitations first.');
        return;
    }
    try {
        await chrome.tabs.sendMessage(activeTabId, { action: 'SCAN_CONNECTIONS' });

        // Reset viewOnly flag on new scan
        const { extension_state } = await chrome.storage.local.get('extension_state');
        if (extension_state) {
            extension_state.viewOnly = false;
            await chrome.storage.local.set({ extension_state });
        }

        // Open side panel and close popup
        chrome.runtime.sendMessage({ action: 'OPEN_SIDEPANEL', tabId: activeTabId }).catch(() => { });
        window.close();
    } catch (e) {
        console.log('Content script not ready:', e);
        showFooterError('Page not ready. Please refresh the LinkedIn page and try again.');
    }
}

async function togglePause() {
    if (!activeTabId) return;
    const { extension_state } = await chrome.storage.local.get('extension_state');
    const isPaused = extension_state?.isPaused;

    try {
        await chrome.tabs.sendMessage(activeTabId, {
            action: isPaused ? 'RESUME_WITHDRAW' : 'PAUSE_WITHDRAW'
        });
    } catch (e) {
        console.log('Content script not ready:', e);
    }
}

async function stopOperation() {
    if (!activeTabId) return;
    try {
        await chrome.tabs.sendMessage(activeTabId, { action: 'STOP_WITHDRAW' });
    } catch (e) {
        console.log('Content script not ready:', e);
    }
}

async function continueOperation() {
    // Check which continue mode is selected
    const selectedMode = document.querySelector('input[name="continue-mode"]:checked')?.value || 'count';

    if (selectedMode === 'count') {
        const count = parseInt(document.getElementById('continue-count')?.value, 10) || 10;
        localSettings.withdrawCount = count;
        await chrome.storage.local.set({ withdrawCount: count });
    } else if (selectedMode === 'age') {
        const ageThreshold = parseInt(document.getElementById('continue-age')?.value, 10) || 3;
        const ageUnit = document.getElementById('continue-age-unit')?.value || 'month';
        localSettings.ageValue = ageThreshold;
        localSettings.ageUnit = ageUnit;
        await chrome.storage.local.set({ ageValue: ageThreshold, ageUnit });
    }

    // Pick up adjusted safety threshold if present (safety stop results page)
    const safeThresholdEl = document.getElementById('continue-safe-threshold');
    const safeUnitEl = document.getElementById('continue-safe-unit');
    if (safeThresholdEl) {
        localSettings.safeThreshold = parseInt(safeThresholdEl.value, 10) || 1;
        localSettings.safeUnit = safeUnitEl?.value || 'month';
        await chrome.storage.local.set({
            safeThreshold: localSettings.safeThreshold,
            safeUnit: localSettings.safeUnit
        });
    }

    // Update current mode to match selection
    const { extension_state } = await chrome.storage.local.get('extension_state');
    if (extension_state) {
        extension_state.currentMode = selectedMode;
        await chrome.storage.local.set({ extension_state });
    }

    // Prepare overrides
    const options = {
        immediate: true,
        mode: selectedMode
    };

    if (selectedMode === 'count') {
        options.count = parseInt(document.getElementById('continue-count')?.value, 10) || 10;
    } else {
        options.ageValue = parseInt(document.getElementById('continue-age')?.value, 10) || 3;
        options.ageUnit = document.getElementById('continue-age-unit')?.value || 'month';
    }

    // Call startOperation with Overrides
    startOperation(options);
}

function openSentPage() {
    chrome.tabs.create({ url: SENT_URL });
}

// ============ INITIALIZATION ============

// Check page and set transient pageStatus variable (NEVER persists to storage)
async function checkPage() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        activeTabId = tab?.id;

        // Not on LinkedIn at all
        if (!tab?.url?.includes('linkedin.com')) {
            pageStatus = 'offPlatform';
            return;
        }

        // On LinkedIn but wrong page
        if (!tab?.url?.includes('mynetwork/invitation-manager/sent')) {
            pageStatus = 'wrongPage';
            return;
        }

        // Correct page
        pageStatus = 'ok';
    } catch (e) {
        console.error('Page check failed:', e);
        pageStatus = 'connectionError';
    }
}

// ============ STORAGE-BASED LIFECYCLE ============

// Auto-sync on popup load
document.addEventListener('DOMContentLoaded', async () => {
    // Setup event delegation first
    setupEventDelegation();

    // Load local settings - STRICTLY from extension_state
    // We removed the legacy chrome.storage.local.get(DEFAULTS) call here to prevent conflicts.

    // 1. Check page status (sets transient pageStatus variable)
    await checkPage();

    // 2. Restore State & Settings
    try {
        const { extension_state, alltimeCleared: legacyAlltime, theme: savedTheme } = await chrome.storage.local.get(['extension_state', 'alltimeCleared', 'theme']);
        const state = extension_state || { ...DEFAULT_STATE };

        // Legacy Migration for alltimeCleared
        if (legacyAlltime !== undefined && state.stats && state.stats.alltimeCleared === 0) {
            state.stats.alltimeCleared = legacyAlltime;
        }

        // HYDRATE localSettings from persisted state
        // This is the CRITICAL fix: Ensure localSettings mirrors the loaded state.settings
        if (state.settings) {
            localSettings = { ...DEFAULTS, ...state.settings };
        } else {
            // If missing in state, init with defaults
            state.settings = { ...DEFAULTS };
            localSettings = { ...DEFAULTS };
        }

        // RESTORE THEME FROM FLAT KEY (Priority Source of Truth)
        if (savedTheme) {
            localSettings.theme = savedTheme;
            if (state.settings) state.settings.theme = savedTheme;
        }

        // Apply Theme Immediately
        const theme = localSettings.theme || 'light';
        document.documentElement.setAttribute('data-theme', theme);

        // Auto-redirect to Side Panel if active operation or scan results
        // ... (logic continues)

        // Auto-redirect to Side Panel if active operation or scan results
        if (extension_state) {
            const isRunning = extension_state.isRunning;
            const currentTab = extension_state.uiNavigation?.currentTab;

            if (isRunning || currentTab === 'scanResults') {
                if (activeTabId) {
                    chrome.runtime.sendMessage({ action: 'OPEN_SIDEPANEL', tabId: activeTabId }).catch(() => { });
                    window.close();
                    return;
                }
            }
        }

        renderUI(extension_state || DEFAULT_STATE);
    } catch (e) {
        console.error('ClearConnect: Failed to load state', e);
        renderUI(DEFAULT_STATE);
    }
});

// Listen for storage changes and re-render (with focus guard)
chrome.storage.onChanged.addListener((changes, area) => {
    // Navigation guard - don't re-render while typing
    const active = document.activeElement?.tagName;
    if (active === 'INPUT' || active === 'TEXTAREA') return;

    if (area === 'local') {
        // Theme change
        if (changes.theme) {
            localSettings.theme = changes.theme.newValue;
        }
        // Debug mode change
        if (changes.debugMode) {
            localSettings.debugMode = changes.debugMode.newValue;
        }
        // State change
        if (changes.extension_state) {
            // Ignore updates if we are the ones who caused them via auto-save
            if (isAutoSaving && isAutoSaving.current) {
                console.log('Skipping render due to local auto-save');
                return;
            }
            renderUI(changes.extension_state.newValue);
        }
    }
});

// Re-check page when active tab changes (self-correcting environment sync)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    await checkPage();
    const { extension_state } = await chrome.storage.local.get('extension_state');
    // 4. Force Home Tab on Open (User Preference)
    const state = extension_state || DEFAULT_STATE;
    if (state.uiNavigation && state.uiNavigation.currentTab !== 'home') {
        state.uiNavigation.currentTab = 'home';
        // We mutate state locally so renderUI shows home.
        // We do NOT save to storage to avoid messing up background state if side panel relies on it,
        // although side panel usually manages its own view or reads from storage. 
        // If side panel is open, it might read this.
        // But for popup, we want home. 
    }

    renderUI(state);
});


// Re-check page when tab URL changes (e.g., user navigates within same tab)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // Only react to URL changes on completion
    if (changeInfo.status === 'complete' && tabId === activeTabId) {
        await checkPage();
        const { extension_state } = await chrome.storage.local.get('extension_state');
        renderUI(extension_state || DEFAULT_STATE);
    }
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'COMPLETE') {
        // Update local state with the final state from content script
        if (message.state) {
            navigateTo('completed', message.state);
        } else {
            navigateTo('completed');
        }
    }

    // Scan complete -- store results and navigate to scan results view
    if (message.action === 'SCAN_COMPLETE') {
        foundScanResults = message.results || [];
        selectedScanHashes.clear();
        chrome.storage.local.set({ savedScanResults: foundScanResults });
        navigateTo('scanResults');
    }

    // Real-time scroll progress updates during scanning
    if (message.action === 'SCROLL_PROGRESS') {
        const scrollFill = document.getElementById('scroll-progress-fill');
        const scrollStatus = document.getElementById('scroll-status');
        const msgScanFill = document.getElementById('msg-scan-fill');
        const msgScanStatus = document.getElementById('msg-scan-status');

        // Standard layout progress
        if (scrollFill) scrollFill.style.width = `${message.progress}% `;
        if (scrollStatus) scrollStatus.textContent = message.text || `Found ${message.found} of ~${message.total} `;

        // Message mode layout progress
        if (msgScanFill) msgScanFill.style.width = `${message.progress}% `;
        if (msgScanStatus) msgScanStatus.textContent = message.text || `Found ${message.found} of ~${message.total} `;
    }

    // Real-time status updates during withdrawal
    if (message.action === 'UPDATE_STATUS') {
        const progressFill = document.getElementById('progress-fill');
        const statusText = document.getElementById('status-text');
        const msgWithdrawFill = document.getElementById('msg-withdraw-fill');
        const msgWithdrawStatus = document.getElementById('msg-withdraw-status');

        // Standard layout progress
        if (progressFill) progressFill.style.width = `${message.progress}% `;
        if (statusText) statusText.textContent = message.text;

        // Message mode layout progress
        if (msgWithdrawFill) msgWithdrawFill.style.width = `${message.progress}% `;
        if (msgWithdrawStatus) msgWithdrawStatus.textContent = message.text;
    }

    // List Update (Immediate Scan Results)
    if (message.action === 'POPULATE_QUEUE') {
        chrome.storage.local.get('extension_state', (data) => {
            const state = data.extension_state || DEFAULT_STATE;

            // Merge new targets
            if (message.prepend) {
                // Avoid duplicates
                const newTargets = message.targets.filter(t => !state.foundMatchingPeople.some(p => p.name === t.name));
                state.foundMatchingPeople = [...newTargets, ...state.foundMatchingPeople];
            } else {
                const newTargets = message.targets.filter(t => !state.foundMatchingPeople.some(p => p.name === t.name));
                state.foundMatchingPeople = [...state.foundMatchingPeople, ...newTargets];
            }

            // Save and Render
            chrome.storage.local.set({ extension_state: state });
            updatePeopleList(state);

            // Also update stats if total is provided/implied
            if (state.stats) {
                // If in count mode, total is fixed. If age/message, it grows.
                // updateProgress(state) handles text updates but we might need to force a redraw?
                updateProgress(state);
            }
        });
    }
});
