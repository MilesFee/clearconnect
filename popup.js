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
    alltimeCleared: 0,
    debugMode: false
};

// Default state structure
const DEFAULT_STATE = {
    isRunning: false,
    isPaused: false,
    currentMode: 'count',
    subMode: 'idle',
    lastError: null,
    stats: { processed: 0, total: 0, oldestCleared: '-', startTime: null },
    settings: { ...DEFAULTS },
    status: { text: 'Ready', progress: 0 },
    sessionLog: [],
    uiNavigation: { currentTab: 'home' },
    lastRunResult: null // { processed, oldestCleared, timestamp } - persists until new run starts
};

// Runtime state (not persisted)
let activeTabId = null;
let localSettings = { ...DEFAULTS };
let pageStatus = 'ok'; // 'ok' | 'offPlatform' | 'wrongPage' | 'connectionError' - transient, not saved

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

        // Link to completed/results view
        const viewResultsLink = showViewResults
            ? `<a href="#" id="view-results-link" data-action="navigate" data-tab="completed" class="status-link">View Results</a>`
            : '';

        return `
            <div class="status-box ${cssClass}">
                <div class="status-icon">${icon}</div>
                <div class="status-content">
                    <strong>${displayMessage}</strong>
                    ${oldestCleared !== '-' ? `<span class="status-detail">Oldest: ${oldestCleared}</span>` : ''}
                    ${viewResultsLink}
                </div>
            </div>
        `;
    }

    // P4: Active Run - no footer status (progress view handles it)
    if (state?.isRunning) return '';

    // P5: Idle + Correct Page - green confirmation
    return `
        <div class="status-box status-confirm">
            <div class="status-icon">&#10003;</div>
            <div class="status-content">
                <span>You are on the correct page.</span>
            </div>
        </div>
    `;
}

// ============ CORE RENDER SYSTEM ============

// Shell render - applies global state to body (theme, debug mode indicator)
function renderShell(state) {
    // Apply theme on every render
    const theme = localSettings.theme || 'light';
    document.body.setAttribute('data-theme', theme);

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

/* ==========================================================================
   UI RENDERING & TRANSITIONS (Non-Destructive)
   ========================================================================== */



async function renderUI(state) {
    // 0. Shell & Footer Updates (Always safe)
    renderShell(state);
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
        if (currentTab === 'completed') {
            // Results View (Strict SPA)
            hideAll();

            // Show Results Section
            if (resultsSection) {
                resultsSection.classList.remove('hidden');
                resultsSection.classList.add('fade-in');

                // Always re-render to ensure state consistency
                resultsSection.innerHTML = getCompletedHTML(state);
            }

            document.body.classList.add('results-active');
        }
        else {
            document.body.classList.remove('results-active');
            // --- Standard Views (Home, Settings, etc) ---
            hideAll();
            if (homeSection) {
                homeSection.classList.remove('hidden');

                // Inject content
                if (currentTab === 'settings') {
                    homeSection.innerHTML = getSettingsHTML(state);
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
                                .catch(() => {
                                    homeSection.innerHTML = getStatsHTML(state, null);
                                });
                        } else {
                            homeSection.innerHTML = getStatsHTML(state, null);
                        }
                    });
                } else {
                    // Default Home
                    homeSection.innerHTML = getHomeHTML(state);
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
async function navigateTo(tab) {
    const { extension_state } = await chrome.storage.local.get('extension_state');
    const state = extension_state || { ...DEFAULT_STATE };

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
    const alltimeCleared = localSettings.alltimeCleared || 0;
    const stats = state?.stats || {};

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

            <!-- Mode Toggle -->
            <div class="mode-toggle">
                <button data-action="set-mode" data-mode="count" class="mode-btn ${countActive}">By Count</button>
                <button data-action="set-mode" data-mode="age" class="mode-btn ${ageActive}">By Age</button>
                <button data-action="set-mode" data-mode="message" class="mode-btn ${messageActive}">By Message</button>
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

function getCompletedHTML(state) {
    const processed = state?.stats?.processed || 0;
    const pendingInvitations = state?.stats?.pendingInvitations || 0;

    // Fallback if pendingInvitations is null/undefined (e.g. if script couldn't read it yet)
    // If we just cleared 'processed', the live count properly *should* be the new count.
    // However, if we haven't refreshed the page, 'pendingInvitations' might be the OLD count.
    // For now, we trust the state, or subtract if needed. 
    // User requested: "derived from linkedin's 'People (1,244)' item"
    const currentConnections = pendingInvitations !== null ? pendingInvitations : '-';

    const lastRunResult = state?.lastRunResult || {};
    const stopType = lastRunResult.stopType || 'success';
    const message = lastRunResult.message || '';

    // Capacity Logic
    const capacityLimit = 1250;
    // Capacity Used = Current Connections
    const capacityUsed = typeof currentConnections === 'number' ? currentConnections : 0;
    const capacityLeft = Math.max(0, capacityLimit - capacityUsed);

    // Percent for bar (inverted logic? No, percent of LIMIT used)
    const capacityPercent = Math.min(100, Math.round((capacityUsed / capacityLimit) * 100));

    // Health Color
    let healthColor = 'green';
    if (capacityPercent > 90) healthColor = 'red';
    else if (capacityPercent > 75) healthColor = 'orange';

    // Average Age Calculation
    const foundPeople = state?.foundMatchingPeople || [];
    const clearedPeople = state.sessionCleared || foundPeople.slice(0, processed);

    let ageDisplay = "N/A";
    if (clearedPeople.length > 0) {
        const ages = clearedPeople.map(p => p.age || '').filter(a => a);
        if (ages.length > 0) {
            const first = ages[0];
            const last = ages[ages.length - 1];
            if (first === last) ageDisplay = first;
            else ageDisplay = `${first} - ${last}`;
        }
    }

    // Status Message
    let statusIcon = '&#10003;';
    let statusTitle = 'Session Complete';
    let statusMsg = `Successfully cleared ${clearedPeople.length} connections.`;
    let statusClass = 'success';

    if (stopType === 'safety') {
        statusTitle = 'Safety Stop';
        statusIcon = '&#9888;';
        statusMsg = message || `Safety stop triggered. ${clearedPeople.length} cleared.`;
        statusClass = 'warning';
    } else if (stopType === 'manual') {
        statusTitle = 'Stopped';
        statusIcon = '&#10006;';
        statusMsg = `Stopped by user. Cleared ${clearedPeople.length}.`;
        statusClass = 'error';
    } else if (stopType === 'error') {
        statusTitle = 'Error';
        statusIcon = '&#9888;';
        statusMsg = message;
        statusClass = 'error';
    }

    // Cleared List
    const clearedListItems = clearedPeople.map(person => `
        <div class="history-entry">
            <span class="history-link">${escapeHTML(person.name)}</span>
            <span class="history-age">${person.age || '-'}</span>
        </div>
    `).join('') || '<div class="empty-history">No connections cleared.</div>';

    return `
        <div id="completed-view" class="view">
            <!-- Summary Card -->
            <div class="summary-card" style="background:var(--bg-card); border:1px solid var(--border-default); border-radius:12px; padding:20px; text-align:center; margin-bottom:20px; box-shadow:var(--shadow-sm);">
                <div class="summary-icon ${statusClass}" style="width:48px; height:48px; border-radius:50%; background:var(--${statusClass === 'success' ? 'success' : statusClass === 'warning' ? 'warning' : 'danger'}-bg); color:var(--${statusClass === 'success' ? 'success' : statusClass === 'warning' ? 'warning' : 'danger'}); display:flex; align-items:center; justify-content:center; font-size:24px; margin:0 auto 12px auto;">
                    ${statusIcon}
                </div>
                <h2 style="margin:0 0 8px 0; font-size:18px; color:var(--text-primary);">${statusTitle}</h2>
                <p style="margin:0; color:var(--text-secondary); font-size:14px;">${statusMsg}</p>
                
                <div class="summary-stats-grid" style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; margin-top:20px; padding-top:20px; border-top:1px solid var(--border-default);">
                    <div class="stat-item">
                        <span style="display:block; font-size:12px; color:var(--text-secondary); margin-bottom:4px;">Cleared</span>
                        <strong style="font-size:16px; color:var(--text-primary);">${clearedPeople.length}</strong>
                    </div>
                     <div class="stat-item">
                        <span style="display:block; font-size:12px; color:var(--text-secondary); margin-bottom:4px;">Est. Left</span>
                        <strong style="font-size:16px; color:var(--text-primary);">${capacityLeft}</strong>
                    </div>
                    <div class="stat-item">
                        <span style="display:block; font-size:12px; color:var(--text-secondary); margin-bottom:4px;">Avg Age</span>
                        <strong style="font-size:14px; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${ageDisplay}</strong>
                    </div>
                </div>
            </div>

            <!-- Capacity Section -->
            <div class="stats-section">
                <!-- Capacity Bar -->
                <div class="health-section">
                    <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                        <label>Connection Capacity</label>
                        <span style="font-size:12px; color:var(--text-secondary);">${capacityUsed} / ~${capacityLimit} used</span>
                    </div>
                    <div class="health-bar-bg">
                        <div id="health-fill" class="health-bar-fill ${healthColor}" style="width: ${capacityPercent}%"></div>
                    </div>
                    <p style="margin-top:6px; font-size:12px; color:var(--text-secondary);">You have approx. <strong>${capacityLeft}</strong> slots remaining.</p>
                </div>
            </div>

            <!-- Continue Clearing -->
            ${state?.currentMode === 'message' ? `
                <div style="margin-top:16px; padding:12px; background:var(--bg-surface); border:1px solid var(--border-default); border-radius:var(--radius-md);">
                    <h4 style="margin:0 0 8px; font-size:13px; color:var(--text-primary);">Continue Clearing</h4>
                    <p style="margin:0 0 10px; font-size:12px; color:var(--text-secondary);">Return home to select more message groups to clear.</p>
                    <button data-action="go-home" class="secondary-btn" style="width:100%;">
                        <span class="btn-text">Back to Message Selection</span>
                    </button>
                </div>
            ` : `
                <div style="margin-top:16px; padding:12px; background:var(--bg-surface); border:1px solid var(--border-default); border-radius:var(--radius-md);">
                    <h4 style="margin:0 0 8px; font-size:13px; color:var(--text-primary);">Continue Clearing</h4>
                    ${stopType === 'safety' ? `
                    <div style="margin-bottom:10px; padding:8px; background:var(--warning-bg); border:1px solid var(--warning); border-radius:6px;">
                        <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-primary); cursor:pointer;">
                            <span>Adjust safety threshold:</span>
                            <input type="number" id="continue-safe-threshold" value="${state?.settings?.safeThreshold || localSettings.safeThreshold || 1}" min="1" max="24" class="inline-input" style="width:40px;">
                            <select id="continue-safe-unit" class="inline-select">
                                <option value="day" ${(state?.settings?.safeUnit || localSettings.safeUnit) === 'day' ? 'selected' : ''}>days</option>
                                <option value="week" ${(state?.settings?.safeUnit || localSettings.safeUnit) === 'week' ? 'selected' : ''}>weeks</option>
                                <option value="month" ${(state?.settings?.safeUnit || localSettings.safeUnit) === 'month' ? 'selected' : ''}>months</option>
                                <option value="year" ${(state?.settings?.safeUnit || localSettings.safeUnit) === 'year' ? 'selected' : ''}>years</option>
                            </select>
                        </label>
                    </div>
                    ` : ''}
                    <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:10px;">
                        <label class="continue-option">
                            <input type="radio" name="continue-mode" value="count" checked>
                            <span>Clear next</span>
                            <input type="number" id="continue-count" value="${localSettings.withdrawCount || 10}" min="1" max="5000" class="inline-input">
                            <span>connections</span>
                        </label>
                        <label class="continue-option">
                            <input type="radio" name="continue-mode" value="age">
                            <span>Clear older than</span>
                            <input type="number" id="continue-age" value="${localSettings.ageValue || 3}" min="1" max="365" class="inline-input">
                            <select id="continue-age-unit" class="inline-select">
                                <option value="day" ${localSettings.ageUnit === 'day' ? 'selected' : ''}>days</option>
                                <option value="week" ${localSettings.ageUnit === 'week' ? 'selected' : ''}>weeks</option>
                                <option value="month" ${localSettings.ageUnit === 'month' ? 'selected' : ''}>months</option>
                                <option value="year" ${localSettings.ageUnit === 'year' ? 'selected' : ''}>years</option>
                            </select>
                        </label>
                    </div>
                    <button data-action="continue-clearing" class="primary-btn" style="width:100%;">
                        <span class="btn-text">Continue Clearing</span>
                    </button>
                </div>
            `}

            <!-- Just Cleared (Collapsible) -->
            <div class="history-session collapsed">
                <div class="history-session-header" data-action="toggle-session">
                    <div class="session-header-left">
                        <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                        <span class="session-date">Just Cleared</span>
                    </div>
                    <span class="session-count">${processed}</span>
                </div>
                <div class="history-session-items">
                    ${clearedListItems}
                </div>
            </div>

            <button data-action="go-home" class="secondary-btn" style="margin-top:12px; width:100%;">Back to Home</button>
        </div>
    `;
}

function getSettingsHTML(state) {
    const safeMode = localSettings.safeMode !== false;
    const safeThreshold = localSettings.safeThreshold || 1;
    const safeUnit = localSettings.safeUnit || 'month';
    const debugMode = localSettings.debugMode === true;
    const theme = localSettings.theme || 'light';

    return `
        <div class="view">
            <h3>Settings</h3>

            <!-- Theme Toggle -->
            <div class="setting-group">
                <label>Appearance</label>
                <div class="theme-toggle">
                    <button data-action="set-theme" data-theme="light" class="theme-btn ${theme === 'light' ? 'active' : ''}" title="Light">
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
                    <button data-action="set-theme" data-theme="dark" class="theme-btn ${theme === 'dark' ? 'active' : ''}" title="Dark">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                        </svg>
                    </button>
                </div>
            </div>

            <!-- Safe Mode -->
            <div class="setting-option" id="safe-mode-option">
                <label>
                    <input type="checkbox" id="safe-mode-toggle" ${safeMode ? 'checked' : ''}>
                    <span class="option-text">
                        <strong>Safe Mode</strong>
                        <small>Preserves connections sent within the last:</small>
                    </span>
                </label>
                <div id="safe-threshold-group" class="inline-threshold">
                    <input type="number" id="safe-threshold" value="${safeThreshold}" min="1" max="12" class="inline-input">
                    <select id="safe-unit" class="inline-select">
                        <option value="month" ${safeUnit === 'month' ? 'selected' : ''}>months</option>
                        <option value="week" ${safeUnit === 'week' ? 'selected' : ''}>weeks</option>
                    </select>
                </div>
            </div>

            <!-- Debug Mode -->
            <div class="setting-option">
                <label>
                    <input type="checkbox" id="debug-mode-toggle" ${debugMode ? 'checked' : ''}>
                    <span class="option-text">
                        <strong>Debug Mode</strong>
                        <small>Simulates withdrawals without actually removing connections</small>
                    </span>
                </label>
            </div>



            <div class="btn-row">
                <button data-action="save-settings" class="primary-btn">Save</button>
                <button data-action="go-home" class="secondary-btn">Back</button>
            </div>
        </div>
    `;
}

function getStatsHTML(state, livePendingCount = null) {
    const stats = state?.stats || {};

    // Read alltimeCleared from state (stored in extension_state.stats)
    const alltimeCleared = stats.alltimeCleared || 0;
    const oldestCleared = stats.oldestCleared || '-';
    const lastRun = stats.processed || 0;

    // LinkedIn limits pending invitations to ~1,200
    const maxCapacity = 1200;

    // Priority: live page query > stored value from last withdrawal
    let pendingCount = livePendingCount;
    let dataSource = 'Live';

    if (pendingCount === null && stats.pendingInvitations !== null) {
        // Use stored value if no live data
        pendingCount = stats.pendingInvitations;
        dataSource = 'Last known';
    }

    const hasData = pendingCount !== null;
    const displayPending = hasData ? pendingCount : '---';
    const capacityPercent = hasData ? Math.round((pendingCount / maxCapacity) * 100) : 0;

    // Health bar color: green < 50%, yellow 50-80%, red > 80%
    let healthColor = 'green';
    if (capacityPercent >= 80) healthColor = 'red';
    else if (capacityPercent >= 50) healthColor = 'yellow';

    // Format timestamp if we have stored data
    let statusText = 'Open LinkedIn Sent Invitations to see count';
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
                    <span>All-Time Cleared</span>
                    <strong>${alltimeCleared}</strong>
                </div>
                <div class="stat-row">
                    <span>Last Run</span>
                    <strong>${lastRun}</strong>
                </div>
                <div class="stat-row">
                    <span>Last Cleared</span>
                    <strong>${oldestCleared}</strong>
                </div>
                
                <!-- Capacity Health Bar -->
                <div class="health-section">
                    <div class="health-label-row">
                        <span>Pending Invitations</span>
                        <span>${displayPending} / ${maxCapacity}</span>
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
            const withdrawalItems = withdrawals.map(w => {
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

function getScanResultsHTML(state) {
    return `
        <div class="view">
            <h2 class="section-title">Scan Results</h2>
            <p class="scan-desc">Select message groups to withdraw.</p>
            <div id="scan-results-list" class="scan-results-list"></div>
            <div class="scan-actions">
                <button data-action="withdraw-selected" class="primary-btn" disabled>Withdraw Selected (<span id="selected-count">0</span>)</button>
                <button data-action="go-home" class="secondary-btn">Cancel</button>
            </div>
        </div>
    `;
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
                <h2>Connection Lost</h2>
                <p>The connection to the page was interrupted. Please refresh to restore functionality.</p>
                <button data-action="refresh-connection" class="primary-btn">Refresh Page</button>
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
    // Header buttons (outside app-root)
    document.addEventListener('click', async (e) => {
        const target = e.target.closest('[data-action]') || e.target.closest('#settings-btn, #stats-btn, #history-btn, #logo-btn');
        if (!target) return;

        // Header nav buttons (by ID)
        if (target.id === 'settings-btn') {
            e.preventDefault();
            navigateTo('settings');
            return;
        }
        if (target.id === 'stats-btn') {
            e.preventDefault();
            navigateTo('stats');
            return;
        }
        if (target.id === 'history-btn') {
            e.preventDefault();
            navigateTo('history');
            return;
        }
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

        // Mode switching
        case 'set-mode':
            const mode = target.dataset.mode;
            if (mode) setMode(mode);
            break;

        // Theme
        case 'set-theme':
            const theme = target.dataset.theme;
            if (theme) setTheme(theme);
            break;

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
        case 'withdraw-selected':
            // TODO: implement
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
            const radio = document.querySelector(`input[name='continue-mode'][value='${modeVal}']`);
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
    if (!activeTabId) return;

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
            immediate: options.immediate === true // Pass immediate flag
        });
    } catch (e) {
        console.log('Content script not ready:', e);
    }
}

async function startScan() {
    if (!activeTabId) return;
    try {
        await chrome.tabs.sendMessage(activeTabId, { action: 'START_SCAN' });
    } catch (e) {
        console.log('Content script not ready:', e);
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

    // Load local settings
    const saved = await chrome.storage.local.get(DEFAULTS);
    localSettings = { ...DEFAULTS, ...saved };

    // Check page status (sets transient pageStatus variable)
    await checkPage();

    // ALWAYS render - pageStatus check happens inside renderUI
    try {
        const { extension_state } = await chrome.storage.local.get('extension_state');
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
            renderUI(changes.extension_state.newValue);
        }
    }
});

// Re-check page when active tab changes (self-correcting environment sync)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    await checkPage();
    const { extension_state } = await chrome.storage.local.get('extension_state');
    renderUI(extension_state || DEFAULT_STATE);
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

// Listen for messages from content script (legacy support during transition)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'COMPLETE') {
        // Update local state with the final state from content script
        // This ensures sessionCleared and other stats are 100% fresh
        if (message.state) {
            chrome.storage.local.set({ extension_state: message.state });
            renderUI(message.state);
        }
        navigateTo('completed');
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
