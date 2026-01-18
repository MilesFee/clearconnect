// Constants
const SENT_URL = 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';
const DEFAULTS = {
    safeThreshold: 1,
    safeUnit: 'month',
    selectorWithdraw: 'button[data-view-name="sent-invitations-withdraw-single"]',
    selectorConfirm: 'dialog[open] button[aria-label^="Withdrawn invitation sent to"]',
    withdrawCount: 10,
    ageValue: 3,
    ageUnit: 'month',
    currentMode: 'count',
    safeMode: true,
    theme: 'light',
    alltimeCleared: 0
};

const ICONS = {
    check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    warning: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`,
    caution: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`,
    error: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`,
    info: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`
};

// State
let currentMode = 'count';
let stats = { cleared: 0, oldest: '-', remaining: 0, timestamp: null };
let activeTabId = null;
let isOperationRunning = false;
let operationStatus = ''; // 'scrolling', 'withdrawing', or ''

// DOM Elements
let els = {};

// ============ HELPER FUNCTIONS (defined first) ============

function updateActiveTitle(mode, ageVal, ageUnit, countVal) {
    if (!els.sectionTitle) return;
    if (mode === 'count') {
        const count = parseInt(countVal, 10) || 10;
        els.sectionTitle.textContent = `Clearing your ${count} oldest connections`;
    } else {
        const val = parseInt(ageVal, 10) || 3;
        const unitLabel = val === 1 ? ageUnit : ageUnit + 's';
        els.sectionTitle.textContent = `Clearing connections sent ${val} ${unitLabel} ago and older`;
    }
}

function setupSmartAgeOptions(stats) {
    const oldest = stats.oldestRemaining;
    if (!oldest || !oldest.value) return;

    // Convert oldest to days
    let maxDays = 0;
    if (oldest.unit === 'year') maxDays = oldest.value * 365;
    else if (oldest.unit === 'month') maxDays = oldest.value * 30;
    else if (oldest.unit === 'week') maxDays = oldest.value * 7;
    else maxDays = oldest.value;

    const disableUnit = (selectId) => {
        const sel = document.getElementById(selectId);
        if (!sel) return;

        for (let opt of sel.options) {
            let optDays = 1;
            if (opt.value === 'year') optDays = 365;
            else if (opt.value === 'month') optDays = 30;
            else if (opt.value === 'week') optDays = 7;

            // Disable if unit is strictly larger than remaining timeframe
            // e.g. if maxDays=60 (2 months), Years(365) disabled. Months(30) enabled.
            if (optDays > maxDays) {
                opt.disabled = true;
                if (sel.value === opt.value) sel.value = 'day';
            } else {
                opt.disabled = false;
            }
        }
    };

    disableUnit('continue-age-unit');
    disableUnit('inline-continue-age-unit');
}

function applyTheme(theme) {
    document.body.setAttribute('data-theme', theme || 'light');
}

function updateSafeModeUI() {
    if (!els.safeModeToggle || !els.safeThresholdGroup || !els.safeBadge) return;

    const isEnabled = els.safeModeToggle.checked;
    const threshold = els.safeThreshold ? els.safeThreshold.value : 1;
    const unit = els.safeUnit ? els.safeUnit.value : 'month';

    // Show/hide threshold dropdown
    els.safeThresholdGroup.style.display = isEnabled ? 'block' : 'none';

    // Show/hide badge on main screen
    els.safeBadge.style.display = isEnabled ? 'block' : 'none';

    // Update badge text (just the threshold, not the full sentence)
    if (els.safeBadgeText) {
        const unitLabel = unit === 'month' ? (threshold == 1 ? 'month' : 'months') : (threshold == 1 ? 'week' : 'weeks');
        els.safeBadgeText.textContent = `${threshold} ${unitLabel}`;
    }
}

function setActiveThemeBtn(theme) {
    if (els.themeLight) els.themeLight.classList.toggle('active', theme === 'light');
    if (els.themeDark) els.themeDark.classList.toggle('active', theme === 'dark');
}

function setFooterStatus(message, type) {
    if (!els.footerHint) return;

    els.footerHint.textContent = message;

    if (els.footerContent) {
        els.footerContent.className = 'footer-msg';
        if (type === 'success') els.footerContent.classList.add('success');
        else if (type === 'error') els.footerContent.classList.add('error');
    }

    if (els.footerIconCheck) {
        els.footerIconCheck.style.display = type === 'success' ? 'block' : 'none';
    }
    if (els.footerIconError) {
        els.footerIconError.style.display = type === 'error' ? 'block' : 'none';
    }
}

function updateFooterStatus() {
    const footer = document.getElementById('footer');
    if (!els.footerHint || !footer) return;

    // Remove dead space on active/home page (progress view)
    if (els.progressView && els.progressView.style.display === 'block') {
        footer.style.display = 'none';
        return;
    }

    // Show footer on other pages
    footer.style.display = 'block';

    // Helper to determine status type from message
    const getStatusType = (msg) => {
        if (!msg) return 'success';
        const m = msg.toLowerCase();
        if (m.includes('safety') || m.includes('too recent')) return 'warning';
        if (m.includes('no connection') || m.includes('limit reached')) return 'caution';
        if (m.includes('error') || m.includes('failed')) return 'error';
        return 'success';
    };

    // Common function to set content
    const setContent = (icon, text, type) => {
        els.footerHint.innerHTML = `${icon} ${text}`;

        if (els.footerContent) {
            els.footerContent.className = `footer-msg ${type}`;
            els.footerContent.style.visibility = 'visible';
        }

        // Hide default static icons
        if (els.footerIconCheck) els.footerIconCheck.style.display = 'none';
        if (els.footerIconError) els.footerIconError.style.display = 'none';
    };

    if (isOperationRunning) {
        let icon = ICONS.info;
        let text = 'Processing...';

        if (operationStatus === 'scrolling') {
            text = `Scrolling: ${els.scrollStatus?.textContent || 'Starting...'}`;
        } else if (operationStatus === 'withdrawing') {
            text = `Withdrawing: ${els.statusText?.textContent || 'Processing...'}`;
        }
        setContent(icon, text, 'info');

    } else if (operationStatus === 'completed') {
        const type = getStatusType(stats.message);
        const icon = ICONS[type] || ICONS.check;

        let displayMsg = stats.message || 'Done';
        if (type === 'success' && (!displayMsg || displayMsg === 'Withdrawal complete')) {
            displayMsg = 'Done';
        }

        const linkHtml = ' <a href="#" id="see-results-link">See results</a>';
        els.footerHint.innerHTML = `${icon} ${displayMsg}${linkHtml}`;

        const link = document.getElementById('see-results-link');
        if (link) {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                goHome();
            });
        }

        if (els.footerContent) {
            els.footerContent.className = `footer-msg ${type}`;
            els.footerContent.style.visibility = 'visible';
        }

        if (els.footerIconCheck) els.footerIconCheck.style.display = 'none';
        if (els.footerIconError) els.footerIconError.style.display = 'none';

    } else {
        // Default state
        setContent(ICONS.check, "You're on the Sent Invitations page.", 'success');
    }
}

function showView(view) {
    if (els.wrongPageView) els.wrongPageView.style.display = 'none';
    if (els.mainView) els.mainView.style.display = 'none';
    if (els.progressView) els.progressView.style.display = 'none';
    if (els.completedView) els.completedView.style.display = 'none';
    if (els.settingsView) els.settingsView.style.display = 'none';

    switch (view) {
        case 'wrongPage': if (els.wrongPageView) els.wrongPageView.style.display = 'block'; break;
        case 'main': if (els.mainView) els.mainView.style.display = 'block'; break;
        case 'progress': if (els.progressView) els.progressView.style.display = 'block'; break;
        case 'completed': if (els.completedView) els.completedView.style.display = 'block'; break;
        case 'settings': if (els.settingsView) els.settingsView.style.display = 'block'; break;
    }

    // Update footer status to reflect current operation state
    updateFooterStatus();
}

function showWrongPage(title, msg) {
    if (els.wrongPageTitle) els.wrongPageTitle.textContent = title;
    if (els.wrongPageMsg) els.wrongPageMsg.textContent = msg;
    showView('wrongPage');
}

function setMode(mode) {
    currentMode = mode;
    if (els.modeCount) els.modeCount.classList.toggle('active', mode === 'count');
    if (els.modeAge) els.modeAge.classList.toggle('active', mode === 'age');
    if (els.countInput) els.countInput.style.display = mode === 'count' ? 'block' : 'none';
    if (els.ageInput) els.ageInput.style.display = mode === 'age' ? 'block' : 'none';
    updateModeDesc();
    saveInputs();
}

function updateModeDesc() {
    if (!els.modeDesc) return;

    if (currentMode === 'count') {
        const count = parseInt(els.withdrawCount?.value, 10) || 10;
        els.modeDesc.textContent = `Withdraws the ${count} oldest pending connections.`;
    } else {
        const val = parseInt(els.ageValue?.value, 10) || 3;
        const unit = els.ageUnit?.value || 'month';
        const unitLabel = val === 1 ? unit : unit + 's';
        els.modeDesc.textContent = `Withdraws connections sent ${val} ${unitLabel} ago and older.`;
    }
}

async function saveInputs() {
    await chrome.storage.local.set({
        withdrawCount: parseInt(els.withdrawCount?.value, 10) || 10,
        ageValue: parseInt(els.ageValue?.value, 10) || 3,
        ageUnit: els.ageUnit?.value || 'month',
        currentMode: currentMode
    });
    updateAgePlural();
    updateModeDesc();
}

function updateAgePlural() {
    if (!els.ageUnit || !els.ageValue) return;
    const val = parseInt(els.ageValue.value, 10) || 1;
    const unit = els.ageUnit.value;
    const options = els.ageUnit.options;

    // Update each option's text for singular/plural
    for (let opt of options) {
        const baseUnit = opt.value;
        const isPlural = val !== 1;
        if (baseUnit === 'day') opt.text = isPlural ? 'days' : 'day';
        else if (baseUnit === 'week') opt.text = isPlural ? 'weeks' : 'week';
        else if (baseUnit === 'month') opt.text = isPlural ? 'months' : 'month';
        else if (baseUnit === 'year') opt.text = isPlural ? 'years' : 'year';
    }
}

// ============ MAIN INIT ============

document.addEventListener('DOMContentLoaded', async () => {
    // Cache DOM elements
    els = {
        wrongPageView: document.getElementById('wrong-page-view'),
        wrongPageTitle: document.getElementById('wrong-page-title'),
        sectionTitle: document.getElementById('active-operation-title'),
        wrongPageMsg: document.getElementById('wrong-page-msg'),
        openSentBtn: document.getElementById('open-sent-btn'),
        mainView: document.getElementById('main-view'),
        progressView: document.getElementById('progress-view'),
        completedView: document.getElementById('completed-view'),
        settingsView: document.getElementById('settings-view'),
        modeCount: document.getElementById('mode-count'),
        modeAge: document.getElementById('mode-age'),
        modeDesc: document.getElementById('mode-desc'),
        countInput: document.getElementById('count-input'),
        ageInput: document.getElementById('age-input'),
        withdrawCount: document.getElementById('withdraw-count'),
        ageValue: document.getElementById('age-value'),
        ageUnit: document.getElementById('age-unit'),
        startBtn: document.getElementById('start-btn'),
        stopBtn: document.getElementById('stop-btn'),
        progressFill: document.getElementById('progress-fill'),
        statusText: document.getElementById('status-text'),
        progressTitle: document.getElementById('progress-title'),
        settingsBtn: document.getElementById('settings-btn'),
        statsBtn: document.getElementById('stats-btn'),
        backBtn: document.getElementById('back-btn'),
        saveSettings: document.getElementById('save-settings'),
        toggleAdvanced: document.getElementById('toggle-advanced'),
        advancedSettings: document.getElementById('advanced-settings'),
        resetDefaults: document.getElementById('reset-defaults'),
        safeThreshold: document.getElementById('safe-threshold'),
        safeUnit: document.getElementById('safe-unit'),
        safeThresholdGroup: document.getElementById('safe-threshold-group'),
        safeModeToggle: document.getElementById('safe-mode-toggle'),
        themeLight: document.getElementById('theme-light'),
        themeDark: document.getElementById('theme-dark'),
        safeBadge: document.getElementById('safe-badge'),
        safeBadgeText: document.getElementById('safe-badge-text'),
        safeBadgeLink: document.getElementById('safe-badge-link'),
        selectorWithdraw: document.getElementById('selector-withdraw'),
        selectorConfirm: document.getElementById('selector-confirm'),
        clearMoreBtn: document.getElementById('clear-more-btn'),
        statCleared: document.getElementById('stat-cleared'),
        statRemaining: document.getElementById('stat-remaining'),
        healthFill: document.getElementById('health-fill'),
        healthText: document.getElementById('health-text'),
        footerHint: document.getElementById('footer-hint'),
        footerContent: document.getElementById('footer-content'),
        footerIconCheck: document.getElementById('footer-icon-check'),
        footerIconError: document.getElementById('footer-icon-error'),
        alltimeCount: document.getElementById('alltime-count'),
        // Step elements
        stepScroll: document.getElementById('step-scroll'),
        stepScrollCheck: document.getElementById('step-scroll-check'),
        stepScrollNum: document.getElementById('step-scroll-num'),
        stepScrollLabel: document.querySelector('#step-scroll .step-label'),
        scrollProgressFill: document.getElementById('scroll-progress-fill'),
        scrollStatus: document.getElementById('scroll-status'),
        stepWithdraw: document.getElementById('step-withdraw'),
        stepWithdrawCheck: document.getElementById('step-withdraw-check'),
        stepWithdrawNum: document.getElementById('step-withdraw-num'),
        stepWithdrawLabel: document.querySelector('#step-withdraw .step-label'),
        // Continue section elements
        optionCount: document.getElementById('option-count'),
        optionAge: document.getElementById('option-age'),
        continueCount: document.getElementById('continue-count'),
        continueAgeValue: document.getElementById('continue-age-value'),
        continueAgeUnit: document.getElementById('continue-age-unit'),
        continueBtn: document.getElementById('continue-btn'),
        doneBtn: document.getElementById('done-btn'),
        continueModeRadios: document.querySelectorAll('input[name="continue-mode"]'),

        // Inline continue elements
        inlineOptionCount: document.getElementById('inline-option-count'),
        inlineOptionAge: document.getElementById('inline-option-age'),
        inlineContinueCount: document.getElementById('inline-continue-count'),
        inlineContinueAgeValue: document.getElementById('inline-continue-age-value'),
        inlineContinueAgeUnit: document.getElementById('inline-continue-age-unit'),
        inlineContinueModeRadios: document.querySelectorAll('input[name="inline-continue-mode"]')
    };

    // Load saved settings
    const saved = await chrome.storage.local.get(DEFAULTS);

    // Apply theme
    applyTheme(saved.theme);
    setActiveThemeBtn(saved.theme || 'light');

    // Apply safe mode
    if (els.safeModeToggle) els.safeModeToggle.checked = saved.safeMode !== false;
    if (els.safeThreshold) els.safeThreshold.value = saved.safeThreshold;
    if (els.safeUnit) els.safeUnit.value = saved.safeUnit;
    updateSafeModeUI();

    // Restore input values
    if (els.withdrawCount) els.withdrawCount.value = saved.withdrawCount;
    if (els.ageValue) els.ageValue.value = saved.ageValue || 3;
    if (els.ageUnit) els.ageUnit.value = saved.ageUnit || 'month';
    updateAgePlural();
    currentMode = saved.currentMode;
    setMode(currentMode);

    // Restore selector settings
    if (els.selectorWithdraw) els.selectorWithdraw.value = saved.selectorWithdraw;
    if (els.selectorConfirm) els.selectorConfirm.value = saved.selectorConfirm;

    // Initialize continue options state
    updateContinueOptions();

    // Load last run stats
    const lastRun = await chrome.storage.local.get(['lastRunStats']);
    if (lastRun.lastRunStats) {
        stats = lastRun.lastRunStats;
    }

    // Load and display alltime count on home page
    const alltimeData = await chrome.storage.local.get({ alltimeCleared: 0 });
    const homeAlltimeCount = document.getElementById('home-alltime-count');
    if (homeAlltimeCount) homeAlltimeCount.textContent = alltimeData.alltimeCleared || 0;

    // Check page and load correct view (Active, Completed, or Main)
    await goHome();

    // ============ EVENT LISTENERS ============

    if (els.openSentBtn) {
        els.openSentBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: SENT_URL });
        });
    }

    if (els.modeCount) els.modeCount.addEventListener('click', () => setMode('count'));
    if (els.modeAge) els.modeAge.addEventListener('click', () => setMode('age'));

    if (els.withdrawCount) els.withdrawCount.addEventListener('change', saveInputs);
    if (els.ageValue) els.ageValue.addEventListener('change', saveInputs);
    if (els.ageUnit) els.ageUnit.addEventListener('change', saveInputs);

    if (els.startBtn) els.startBtn.addEventListener('click', startClearing);
    if (els.stopBtn) els.stopBtn.addEventListener('click', stopClearing);
    if (els.clearMoreBtn) els.clearMoreBtn.addEventListener('click', goToMain);

    if (els.settingsBtn) els.settingsBtn.addEventListener('click', () => showView('settings'));
    if (els.statsBtn) els.statsBtn.addEventListener('click', showLastRunStats);
    if (els.backBtn) els.backBtn.addEventListener('click', goToMain);
    if (els.toggleAdvanced) els.toggleAdvanced.addEventListener('click', toggleAdvanced);
    if (els.saveSettings) els.saveSettings.addEventListener('click', saveSettingsAndReturn);
    if (els.resetDefaults) els.resetDefaults.addEventListener('click', resetToDefaults);

    // Stats back button
    const statsBackBtn = document.getElementById('stats-back-btn');
    if (statsBackBtn) statsBackBtn.addEventListener('click', goToMain);

    // Logo button - navigate to home/post-clear
    const logoBtn = document.getElementById('logo-btn');
    if (logoBtn) {
        logoBtn.addEventListener('click', (e) => {
            e.preventDefault();
            goHome();
        });
    }

    // Theme buttons
    if (els.themeLight) {
        els.themeLight.addEventListener('click', () => {
            applyTheme('light');
            setActiveThemeBtn('light');
            chrome.storage.local.set({ theme: 'light' });
        });
    }
    if (els.themeDark) {
        els.themeDark.addEventListener('click', () => {
            applyTheme('dark');
            setActiveThemeBtn('dark');
            chrome.storage.local.set({ theme: 'dark' });
        });
    }

    // Safe badge link -> go to settings
    if (els.safeBadgeLink) {
        els.safeBadgeLink.addEventListener('click', (e) => {
            e.preventDefault();
            showView('settings');
        });
    }

    if (els.safeModeToggle) {
        els.safeModeToggle.addEventListener('change', () => {
            chrome.storage.local.set({ safeMode: els.safeModeToggle.checked });
            updateSafeModeUI();
        });
    }

    if (els.safeThreshold) els.safeThreshold.addEventListener('change', updateSafeModeUI);
    if (els.safeUnit) els.safeUnit.addEventListener('change', updateSafeModeUI);

    // Continue section handlers
    els.continueModeRadios.forEach(radio => {
        radio.addEventListener('change', updateContinueOptions);
    });
    if (els.inlineContinueModeRadios) {
        els.inlineContinueModeRadios.forEach(radio => {
            radio.addEventListener('change', updateContinueOptions);
        });
    }

    // Clicking on inline inputs
    if (els.continueCount) {
        els.continueCount.addEventListener('focus', () => {
            document.querySelector('input[name="continue-mode"][value="count"]').checked = true;
            updateContinueOptions();
        });
    }
    if (els.continueAgeValue) {
        els.continueAgeValue.addEventListener('focus', () => {
            document.querySelector('input[name="continue-mode"][value="age"]').checked = true;
            updateContinueOptions();
        });
    }
    if (els.inlineContinueCount) {
        els.inlineContinueCount.addEventListener('focus', () => {
            document.querySelector('input[name="inline-continue-mode"][value="count"]').checked = true;
            updateContinueOptions();
        });
    }
    if (els.inlineContinueAgeValue) {
        els.inlineContinueAgeValue.addEventListener('focus', () => {
            document.querySelector('input[name="inline-continue-mode"][value="age"]').checked = true;
            updateContinueOptions();
        });
    }

    if (els.continueBtn) els.continueBtn.addEventListener('click', continueClearing);
    if (els.doneBtn) els.doneBtn.addEventListener('click', () => {
        chrome.storage.local.set({ showingPostClear: false, postClearTimestamp: 0 });
        window.close();
    });

    // Inline continue section handlers (in progress view)
    const inlineRadios = document.querySelectorAll('input[name="inline-continue-mode"]');
    inlineRadios.forEach(radio => {
        radio.addEventListener('change', updateInlineContinueOptions);
    });

    const inlineContinueCount = document.getElementById('inline-continue-count');
    if (inlineContinueCount) {
        inlineContinueCount.addEventListener('focus', () => {
            document.querySelector('input[name="inline-continue-mode"][value="count"]').checked = true;
            updateInlineContinueOptions();
        });
    }
    const inlineContinueAge = document.getElementById('inline-continue-age');
    if (inlineContinueAge) {
        inlineContinueAge.addEventListener('focus', () => {
            document.querySelector('input[name="inline-continue-mode"][value="age"]').checked = true;
            updateInlineContinueOptions();
        });
    }

    const inlineContinueBtn = document.getElementById('inline-continue-btn');
    if (inlineContinueBtn) inlineContinueBtn.addEventListener('click', inlineContinueClearing);

    const inlineDoneBtn = document.getElementById('inline-done-btn');
    if (inlineDoneBtn) inlineDoneBtn.addEventListener('click', () => {
        chrome.storage.local.set({ showingPostClear: false, postClearTimestamp: 0 });
        window.close();
    });

    // Listen for updates from content script
    chrome.runtime.onMessage.addListener(handleMessage);
});

// ============ PAGE CHECK ============

async function checkPage() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url) {
        showWrongPage('No Tab', 'Unable to detect current page.');
        setFooterStatus('Unable to detect page', 'error');
        return false;
    }

    activeTabId = tab.id;
    const url = tab.url;

    if (url.includes('invitation-manager/sent')) {
        // Do not force showView('main') here. Let caller decide.
        // Still update footer if visible/applicable
        if (isOperationRunning || operationStatus === 'completed') {
            updateFooterStatus();
        } else {
            setFooterStatus("You're on the Sent Invitations page.", 'success');
        }
        return true;
    } else if (url.includes('invitation-manager')) {
        showWrongPage('Wrong Tab', 'You are on Received invitations. Switch to Sent.');
        setFooterStatus('Wrong page - switch to Sent', 'error');
    } else if (url.includes('linkedin.com')) {
        showWrongPage('Navigate to Sent', 'Go to My Network → Manage → Sent');
        setFooterStatus('Navigate to Sent Invitations', 'error');
    } else {
        showWrongPage('Not on LinkedIn', 'Please open LinkedIn in this tab.');
        setFooterStatus('Not on LinkedIn', 'error');
    }
    return false;
}

// ============ STATE RESTORATION ============

async function restoreState() {
    if (!activeTabId) return;

    try {
        chrome.tabs.sendMessage(activeTabId, { action: 'GET_STATUS' }, (response) => {
            if (chrome.runtime.lastError || !response) return;
            if (response.isRunning) {
                isOperationRunning = true;
                showView('progress');
                updateActiveTitle(response.mode, response.ageValue, response.ageUnit, response.count);
                if (els.progressFill) els.progressFill.style.width = response.progress + '%';
                if (els.statusText) els.statusText.textContent = response.statusText;
            }
        });
    } catch (e) { }
}

// ============ START / STOP ============

async function startClearing() {
    if (!activeTabId) return;

    await saveInputs();
    const settings = await chrome.storage.local.get(DEFAULTS);

    const message = {
        action: 'START_WITHDRAW',
        mode: currentMode,
        count: parseInt(els.withdrawCount?.value, 10) || 10,
        ageValue: parseInt(els.ageValue?.value, 10) || 3,
        ageUnit: els.ageUnit?.value || 'month',
        safeThreshold: settings.safeThreshold,
        safeUnit: settings.safeUnit,
        safeMode: settings.safeMode
    };

    try {
        await chrome.tabs.sendMessage(activeTabId, message);
        showView('progress');

        // Set operation running state
        isOperationRunning = true;
        chrome.storage.local.set({ showingPostClear: false });
        operationStatus = 'scrolling';
        updateActiveTitle(currentMode, els.ageValue.value, els.ageUnit.value, els.withdrawCount.value);
        updateFooterStatus();

        // Reset step states
        if (els.stepScroll) {
            els.stepScroll.classList.add('active');
            els.stepScroll.classList.remove('completed');
        }
        if (els.stepScrollCheck) els.stepScrollCheck.style.display = 'none';
        if (els.stepScrollNum) els.stepScrollNum.style.display = 'flex';
        if (els.scrollProgressFill) els.scrollProgressFill.style.width = '0%';
        if (els.scrollStatus) els.scrollStatus.textContent = 'Starting...';
        if (els.stepScrollLabel) els.stepScrollLabel.classList.add('wave-text');
        if (els.stepWithdrawLabel) els.stepWithdrawLabel.classList.remove('wave-text');

        if (els.stepWithdraw) {
            els.stepWithdraw.classList.remove('active', 'completed');
        }
        if (els.stepWithdrawCheck) els.stepWithdrawCheck.style.display = 'none';
        if (els.stepWithdrawNum) els.stepWithdrawNum.style.display = 'flex';
        if (els.progressFill) els.progressFill.style.width = '0%';
        if (els.statusText) els.statusText.textContent = 'Waiting...';
    } catch (e) {
        alert('Error: Refresh the LinkedIn page and try again.');
    }
}

async function stopClearing() {
    if (!activeTabId) return;

    try {
        await chrome.tabs.sendMessage(activeTabId, { action: 'STOP_WITHDRAW' });
    } catch (e) {
        // Fallback if content script not responding
        isOperationRunning = false;
        showView('main');
    }
}

// ============ MESSAGE HANDLING ============

function handleMessage(message) {
    if (message.action === 'SCROLL_PROGRESS') {
        // Update scroll step progress
        const pct = message.progress || 0;
        if (els.scrollProgressFill) els.scrollProgressFill.style.width = pct + '%';
        if (els.scrollStatus) els.scrollStatus.textContent = message.text || `Found ${message.found} of ~${message.total}`;
        updateFooterStatus();
    } else if (message.action === 'SCROLL_COMPLETE') {
        // Mark scroll step as done, activate withdraw step
        if (els.stepScroll) {
            els.stepScroll.classList.remove('active');
            els.stepScroll.classList.add('completed');
        }
        if (els.stepScrollCheck) els.stepScrollCheck.style.display = 'block';
        if (els.stepScrollNum) els.stepScrollNum.style.display = 'none';
        if (els.scrollProgressFill) els.scrollProgressFill.style.width = '100%';
        if (els.scrollStatus) els.scrollStatus.textContent = 'Scrolled to bottom';

        // Remove wave animation from scroll label
        if (els.stepScrollLabel) els.stepScrollLabel.classList.remove('wave-text');

        // Activate withdraw step and add wave animation
        if (els.stepWithdraw) els.stepWithdraw.classList.add('active');
        if (els.stepWithdrawLabel) els.stepWithdrawLabel.classList.add('wave-text');

        // Update operation status
        operationStatus = 'withdrawing';
        updateFooterStatus();
    } else if (message.action === 'UPDATE_STATUS') {
        // Update withdraw step progress
        if (els.progressFill) els.progressFill.style.width = message.progress + '%';
        if (els.statusText) els.statusText.textContent = message.text;
        updateFooterStatus();
    } else if (message.action === 'COMPLETED') {
        // Mark withdraw step as done
        if (els.stepWithdraw) {
            els.stepWithdraw.classList.remove('active');
            els.stepWithdraw.classList.add('completed');
        }
        if (els.stepWithdrawCheck) els.stepWithdrawCheck.style.display = 'block';
        if (els.stepWithdrawNum) els.stepWithdrawNum.style.display = 'none';
        if (els.progressFill) els.progressFill.style.width = '100%';

        // Remove wave animation from withdraw label
        if (els.stepWithdrawLabel) els.stepWithdrawLabel.classList.remove('wave-text');

        // Mark operation as complete
        isOperationRunning = false;
        operationStatus = 'completed';
        updateFooterStatus();

        stats = message.stats || { cleared: 0, oldest: '-', remaining: 0 };
        stats.timestamp = Date.now();
        stats.message = message.message || '';
        chrome.storage.local.set({ lastRunStats: stats });

        // Increment alltime counter and trigger completion flow
        chrome.storage.local.get({ alltimeCleared: 0 }, (data) => {
            const alltimeTotal = (data.alltimeCleared || 0) + (stats.cleared || 0);
            const now = Date.now();

            // Save ALL state in one go
            chrome.storage.local.set({
                lastRunStats: stats,
                alltimeCleared: alltimeTotal,
                showingPostClear: true,
                postClearTimestamp: now
            }, () => {
                // Transition to completion UI after a brief pause
                setTimeout(() => goHome(), 1200);
            });
        });
    }
}

function showInlineCompleted(stats, completionMessage, alltimeCount) {
    // Hide stop button
    if (els.stopBtn) els.stopBtn.style.display = 'none';

    // Remove any pulsing animations
    if (els.stepScrollLabel) els.stepScrollLabel.classList.remove('wave-text');
    if (els.stepWithdrawLabel) els.stepWithdrawLabel.classList.remove('wave-text');

    // Animate scroll step out
    if (els.stepScroll) {
        els.stepScroll.classList.add('fade-out');
    }

    // After scroll fades, show completion elements
    setTimeout(() => {
        if (els.stepScroll) els.stepScroll.style.display = 'none';

        // Determine completion type
        let stateType = 'success'; // default
        let textClass = 'success-text';
        let iconPath = '<path d="M20 6L9 17l-5-5" />';

        if (completionMessage) {
            const msg = completionMessage.toLowerCase();
            if (msg.includes('safety') || msg.includes('too recent')) {
                stateType = 'warning'; // orange for safety
                textClass = 'warning-text';
                iconPath = '<path d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />';
            } else if (msg.includes('no connection') || msg.includes('limit reached')) {
                stateType = 'caution'; // yellow for age limit
                textClass = 'caution-text';
                iconPath = '<path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />';
            } else if (msg.includes('error') || msg.includes('failed')) {
                stateType = 'error'; // red for actual errors
                textClass = 'error-text';
                iconPath = '<path d="M18 6L6 18M6 6l12 12" />';
            }
        }

        if (els.statusText) {
            if (completionMessage) {
                els.statusText.textContent = completionMessage;
            } else {
                els.statusText.textContent = `Cleared ${stats.cleared || 0} connections!`;
            }
            els.statusText.classList.remove('error-text', 'warning-text', 'caution-text', 'success-text');
            els.statusText.classList.add(textClass);
        }

        // Update step styling with state class
        if (els.stepWithdraw) {
            els.stepWithdraw.classList.remove('error', 'warning', 'caution');
            if (stateType !== 'success') {
                els.stepWithdraw.classList.add(stateType);
            }
        }

        // Update icon
        if (els.stepWithdrawCheck && stateType !== 'success') {
            els.stepWithdrawCheck.innerHTML = iconPath;
        }

        // Save persistent state
        chrome.storage.local.set({ showingPostClear: true, postClearTimestamp: Date.now() });

        // Update and show inline stats with full data
        const remaining = stats.remaining || 0;
        const capacity = Math.max(0, 1200 - remaining);
        const healthPct = Math.min(100, (remaining / 1200) * 100);

        const inlineStats = document.getElementById('inline-stats');
        const inlineCleared = document.getElementById('inline-stat-cleared');
        const inlineRemaining = document.getElementById('inline-stat-remaining');
        const inlineCapacity = document.getElementById('inline-stat-capacity');
        const inlineHealthFill = document.getElementById('inline-health-fill');
        const inlineHealthText = document.getElementById('inline-health-text');

        if (inlineCleared) inlineCleared.textContent = stats.cleared || 0;
        if (inlineRemaining) inlineRemaining.textContent = remaining.toLocaleString();
        if (inlineCapacity) inlineCapacity.textContent = `~${capacity} more`;
        if (inlineHealthText) inlineHealthText.textContent = `${remaining.toLocaleString()} / ~1200`;


        if (inlineHealthFill) {
            inlineHealthFill.style.width = healthPct + '%';
            inlineHealthFill.classList.remove('green', 'yellow', 'red');
            if (healthPct < 50) inlineHealthFill.classList.add('green');
            else if (healthPct < 80) inlineHealthFill.classList.add('yellow');
            else inlineHealthFill.classList.add('red');
        }

        if (inlineStats) {
            inlineStats.style.display = 'block';
            inlineStats.classList.add('fade-in-up');
        }

        // Show continue section
        const inlineContinue = document.getElementById('inline-continue');
        if (inlineContinue) {
            inlineContinue.style.display = 'block';
            inlineContinue.classList.add('fade-in-up');
        }

        // Show alltime stats
        const inlineAlltime = document.getElementById('inline-alltime');
        const inlineAlltimeCount = document.getElementById('inline-alltime-count');
        if (inlineAlltimeCount) inlineAlltimeCount.textContent = alltimeCount;
        if (inlineAlltime) {
            inlineAlltime.style.display = 'block';
            inlineAlltime.classList.add('fade-in-up');
        }
    }, 400);
}

// ============ STATS ============

async function showLastRunStats() {
    const data = await chrome.storage.local.get(['lastRunStats']);
    if (data.lastRunStats) {
        stats = data.lastRunStats;
    }

    // Try to get fresh count from LinkedIn
    if (activeTabId) {
        try {
            chrome.tabs.sendMessage(activeTabId, { action: 'GET_COUNT' }, (response) => {
                if (chrome.runtime.lastError) {
                    showCompleted(false);
                    return;
                }
                if (response) {
                    stats.remaining = response.linkedInCount || response.count || stats.remaining || 0;
                    chrome.storage.local.set({ lastRunStats: stats });
                }
                showCompleted(false);
            });
            return;
        } catch (e) { }
    }

    showCompleted(false); // false = don't show continue options when viewing stats
}

function showCompleted(showContinueOptions = true) {
    showView('completed');

    // Show/hide continue section in completed view based on context
    const continueSection = document.querySelector('#completed-view .continue-section');
    if (continueSection) {
        continueSection.style.display = showContinueOptions ? 'block' : 'none';
    }

    // Also ensure inline-continue in progress view is hidden
    const inlineContinue = document.getElementById('inline-continue');
    if (inlineContinue) inlineContinue.style.display = 'none';

    // Show back button when continue section is hidden
    const statsBackBtn = document.getElementById('stats-back-btn');
    if (statsBackBtn) {
        statsBackBtn.style.display = showContinueOptions ? 'none' : 'block';
    }

    const remaining = stats.remaining || 0;
    const capacity = Math.max(0, 1200 - remaining);

    if (els.statRemaining) els.statRemaining.textContent = remaining.toLocaleString();

    const capacityEl = document.getElementById('stat-capacity');
    if (capacityEl) capacityEl.textContent = `~${capacity} more`;

    if (els.statCleared) {
        els.statCleared.textContent = stats.cleared ? `${stats.cleared} connections` : 'None';
    }

    const lastRunEl = document.getElementById('stat-last-run');
    if (lastRunEl) {
        if (stats.timestamp) {
            const seconds = Math.floor((Date.now() - stats.timestamp) / 1000);
            if (seconds < 60) lastRunEl.textContent = 'Just now';
            else if (seconds < 3600) lastRunEl.textContent = `${Math.floor(seconds / 60)} min ago`;
            else if (seconds < 86400) lastRunEl.textContent = `${Math.floor(seconds / 3600)} hr ago`;
            else lastRunEl.textContent = `${Math.floor(seconds / 86400)} days ago`;
        } else {
            lastRunEl.textContent = 'Never';
        }
    }

    const titleEl = document.getElementById('stats-title');
    if (titleEl) {
        if (stats.cleared && stats.timestamp && (Date.now() - stats.timestamp) < 60000) {
            titleEl.textContent = 'Completed!';
        } else {
            titleEl.textContent = 'Connection Stats';
        }
    }

    // Health bar
    let healthClass = 'green';
    let healthPct = Math.min(100, (remaining / 1200) * 100);
    if (remaining >= 800) healthClass = 'red';
    else if (remaining >= 600) healthClass = 'yellow';

    if (els.healthFill) {
        els.healthFill.className = 'health-bar-fill ' + healthClass;
        els.healthFill.style.width = healthPct + '%';
    }
    if (els.healthText) {
        els.healthText.textContent = `${remaining.toLocaleString()} / ~1,200 capacity`;
    }

    // Alltime stats
    chrome.storage.local.get({ alltimeCleared: 0 }, (data) => {
        if (els.alltimeCount) {
            els.alltimeCount.textContent = data.alltimeCleared.toLocaleString();
        }
    });

    // Setup age options disabling
    setupSmartAgeOptions(stats);
}

// ============ SETTINGS ============

function toggleAdvanced() {
    if (!els.advancedSettings) return;
    const isHidden = els.advancedSettings.style.display === 'none';
    els.advancedSettings.style.display = isHidden ? 'block' : 'none';
    if (els.toggleAdvanced) {
        els.toggleAdvanced.textContent = isHidden ? 'Hide Advanced Settings' : 'Show Advanced Settings';
    }
}

async function saveSettingsAndReturn() {
    await chrome.storage.local.set({
        safeThreshold: parseInt(els.safeThreshold?.value, 10) || 1,
        safeUnit: els.safeUnit?.value || 'month',
        safeMode: els.safeModeToggle?.checked !== false,
        selectorWithdraw: els.selectorWithdraw?.value || DEFAULTS.selectorWithdraw,
        selectorConfirm: els.selectorConfirm?.value || DEFAULTS.selectorConfirm
    });
    updateSafeModeUI();
    goToMain();
}

async function resetToDefaults() {
    if (els.safeThreshold) els.safeThreshold.value = DEFAULTS.safeThreshold;
    if (els.safeUnit) els.safeUnit.value = DEFAULTS.safeUnit;
    if (els.selectorWithdraw) els.selectorWithdraw.value = DEFAULTS.selectorWithdraw;
    if (els.selectorConfirm) els.selectorConfirm.value = DEFAULTS.selectorConfirm;
    if (els.safeModeToggle) els.safeModeToggle.checked = true;
    updateSafeModeUI();
}

async function goHome() {
    const pageOk = await checkPage();
    if (!pageOk) return;

    // Active Check: Ping content script for latest status
    try {
        const response = await new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(activeTabId, { action: 'GET_STATUS' }, (res) => {
                if (chrome.runtime.lastError) resolve(null);
                else resolve(res);
            });
        });

        if (response && response.isRunning) {
            isOperationRunning = true;
            operationStatus = response.status;
            // Merge stats
            if (response.stats) {
                stats = { ...stats, ...response.stats };
            }
        } else {
            // Not running
            // Only convert true->false if we were running? 
            // Better to trust response.
            if (isOperationRunning) {
                // Was running, now stopped?
                isOperationRunning = false;
            }
        }
    } catch (e) {
        console.log('Status ping failed:', e);
    }

    // Check if we're in post-clear state
    const stateResult = await chrome.storage.local.get({
        showingPostClear: false,
        alltimeCleared: 0,
        postClearTimestamp: 0,
        lastRunStats: null
    });

    // Ensure global stats are populated
    if (stateResult.lastRunStats) {
        stats = { ...stats, ...stateResult.lastRunStats };
    }

    // Session timeout: 30 minutes
    const SESSION_TIMEOUT = 30 * 60 * 1000;
    const now = Date.now();
    const isSessionExpired = stateResult.postClearTimestamp &&
        (now - stateResult.postClearTimestamp > SESSION_TIMEOUT);

    // Priority 1: If operation is currently running, show active progress
    if (isOperationRunning) {
        showView('progress');
        // If we are scrolling, show steps
        if (operationStatus === 'scrolling') resetProgressView();
        return;
    }

    // Priority 2: If post-clear state is active, show completion
    if (stateResult.showingPostClear && stats.timestamp && !isSessionExpired) {
        showView('progress'); // Ensure context is progress view
        showInlineCompleted(stats, stats.message || '', stateResult.alltimeCleared || 0);
    } else {
        // Clear expired state and show default home
        if (isSessionExpired) {
            chrome.storage.local.set({ showingPostClear: false, postClearTimestamp: 0 });
        }
        showView('main');
    }
}

// Alias for backward compatibility
const goToMain = goHome;

// ============ CONTINUE CLEARING ============

function updateContinueOptions() {
    // Main Continue
    const selected = document.querySelector('input[name="continue-mode"]:checked')?.value;
    if (els.optionCount) {
        els.optionCount.classList.toggle('active', selected === 'count');
        els.optionCount.classList.toggle('disabled', selected !== 'count');
    }
    if (els.optionAge) {
        els.optionAge.classList.toggle('active', selected === 'age');
        els.optionAge.classList.toggle('disabled', selected !== 'age');
    }
    if (els.continueCount) els.continueCount.disabled = selected !== 'count';
    if (els.continueAgeValue) els.continueAgeValue.disabled = selected !== 'age';
    if (els.continueAgeUnit) els.continueAgeUnit.disabled = selected !== 'age';

    // Inline Continue
    const inlineSelected = document.querySelector('input[name="inline-continue-mode"]:checked')?.value;
    if (els.inlineOptionCount) {
        els.inlineOptionCount.classList.toggle('active', inlineSelected === 'count');
        els.inlineOptionCount.classList.toggle('disabled', inlineSelected !== 'count');
    }
    if (els.inlineOptionAge) {
        els.inlineOptionAge.classList.toggle('active', inlineSelected === 'age');
        els.inlineOptionAge.classList.toggle('disabled', inlineSelected !== 'age');
    }
    if (els.inlineContinueCount) els.inlineContinueCount.disabled = inlineSelected !== 'count';
    if (els.inlineContinueAgeValue) els.inlineContinueAgeValue.disabled = inlineSelected !== 'age';
    if (els.inlineContinueAgeUnit) els.inlineContinueAgeUnit.disabled = inlineSelected !== 'age';
}

async function continueClearing() {
    if (!activeTabId) {
        const pageOk = await checkPage();
        if (!pageOk) return;
    }

    const selected = document.querySelector('input[name="continue-mode"]:checked')?.value || 'count';
    const settings = await chrome.storage.local.get(DEFAULTS);

    const message = {
        action: 'START_WITHDRAW',
        mode: selected,
        count: selected === 'count' ? (parseInt(els.continueCount?.value, 10) || 10) : 999999,
        ageValue: selected === 'age' ? (parseInt(els.continueAgeValue?.value, 10) || 3) : 12,
        ageUnit: selected === 'age' ? (els.continueAgeUnit?.value || 'month') : 'month',
        safeThreshold: settings.safeThreshold,
        safeUnit: settings.safeUnit,
        safeMode: settings.safeMode
    };

    try {
        await chrome.tabs.sendMessage(activeTabId, message);
        showView('progress');

        // Reset step states
        resetProgressView();
    } catch (e) {
        alert('Error: Refresh the LinkedIn page and try again.');
    }
}

function updateInlineContinueOptions() {
    const selected = document.querySelector('input[name="inline-continue-mode"]:checked')?.value;

    const optionCount = document.getElementById('inline-option-count');
    const optionAge = document.getElementById('inline-option-age');
    const countInput = document.getElementById('inline-continue-count');
    const ageInput = document.getElementById('inline-continue-age');

    if (optionCount) {
        optionCount.classList.toggle('active', selected === 'count');
        optionCount.classList.toggle('disabled', selected !== 'count');
    }
    if (optionAge) {
        optionAge.classList.toggle('active', selected === 'age');
        optionAge.classList.toggle('disabled', selected !== 'age');
    }

    if (countInput) countInput.disabled = selected !== 'count';
    if (ageInput) ageInput.disabled = selected !== 'age';
}

async function inlineContinueClearing() {
    if (!activeTabId) {
        const pageOk = await checkPage();
        if (!pageOk) return;
    }

    const selected = document.querySelector('input[name="inline-continue-mode"]:checked')?.value || 'count';
    const settings = await chrome.storage.local.get(DEFAULTS);

    const countInput = document.getElementById('inline-continue-count');
    const ageValInput = document.getElementById('inline-continue-age-value');
    const ageUnitInput = document.getElementById('inline-continue-age-unit');

    const message = {
        action: 'START_WITHDRAW',
        mode: selected,
        count: selected === 'count' ? (parseInt(countInput?.value, 10) || 10) : 999999,
        ageValue: selected === 'age' ? (parseInt(ageValInput?.value, 10) || 3) : 12,
        ageUnit: selected === 'age' ? (ageUnitInput?.value || 'month') : 'month',
        safeThreshold: settings.safeThreshold,
        safeUnit: settings.safeUnit,
        safeMode: settings.safeMode
    };

    try {
        await chrome.tabs.sendMessage(activeTabId, message);

        // Hide inline completion elements
        const completionEl = document.getElementById('completion-message');
        const inlineStats = document.getElementById('inline-stats');
        // Update inline stats
        if (document.getElementById('inline-stat-cleared'))
            document.getElementById('inline-stat-cleared').textContent = stats.cleared || 0;

        // Setup age options disabling
        setupSmartAgeOptions(stats);

        // Show inline continue section
        const inlineContinue = document.getElementById('inline-continue');
        const inlineAlltime = document.getElementById('inline-alltime');

        if (completionEl) { completionEl.style.display = 'none'; completionEl.classList.remove('fade-in-up'); }
        if (inlineStats) { inlineStats.style.display = 'none'; inlineStats.classList.remove('fade-in-up'); }
        if (inlineContinue) { inlineContinue.style.display = 'none'; inlineContinue.classList.remove('fade-in-up'); }
        if (inlineAlltime) { inlineAlltime.style.display = 'none'; inlineAlltime.classList.remove('fade-in-up'); }

        // Reset and show progress steps
        resetProgressView();
        if (els.stopBtn) els.stopBtn.style.display = 'block';
    } catch (e) {
        alert('Error: Refresh the LinkedIn page and try again.');
    }
}

function resetProgressView() {
    if (els.stepScroll) {
        els.stepScroll.style.display = 'block';
        els.stepScroll.classList.add('active');
        els.stepScroll.classList.remove('completed', 'fade-out');
    }
    if (els.stepScrollCheck) els.stepScrollCheck.style.display = 'none';
    if (els.stepScrollNum) els.stepScrollNum.style.display = 'flex';
    if (els.scrollProgressFill) els.scrollProgressFill.style.width = '0%';
    if (els.scrollStatus) els.scrollStatus.textContent = 'Starting...';
    if (els.stepScrollLabel) els.stepScrollLabel.classList.add('wave-text');

    if (els.stepWithdraw) {
        els.stepWithdraw.classList.remove('active', 'completed', 'error', 'warning', 'caution');
    }
    if (els.stepWithdrawCheck) {
        els.stepWithdrawCheck.style.display = 'none';
        els.stepWithdrawCheck.innerHTML = '<path d="M20 6L9 17l-5-5" />'; // Reset to checkmark
    }
    if (els.stepWithdrawNum) els.stepWithdrawNum.style.display = 'flex';
    if (els.progressFill) els.progressFill.style.width = '0%';
    if (els.statusText) {
        els.statusText.textContent = 'Waiting...';
        els.statusText.classList.remove('error-text', 'warning-text', 'caution-text', 'success-text');
    }
    if (els.stepWithdrawLabel) els.stepWithdrawLabel.classList.remove('wave-text');
}
