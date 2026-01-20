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
    alltimeCleared: 0,
    debugMode: false
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
let isCancellingOperation = false; // Flag to prevent completion UI during scan cancel
let hideScrollTimeout = null; // Track setTimeout ID for stepScroll hide animation
let operationStatus = ''; // 'scrolling', 'withdrawing', or ''

// DOM Elements
let els = {};

// ============ HELPER FUNCTIONS (defined first) ============

function updateActiveTitle(mode, ageVal, ageUnit, countVal) {
    if (!els.sectionTitle) return;
    if (mode === 'count') {
        const count = parseInt(countVal, 10) || 10;
        els.sectionTitle.textContent = `Clearing your ${count} oldest connections`;
    } else if (mode === 'age') {
        const val = parseInt(ageVal, 10) || 3;
        const unitLabel = val === 1 ? ageUnit : ageUnit + 's';
        els.sectionTitle.textContent = `Clearing connections sent ${val} ${unitLabel} ago and older`;
    } else if (mode === 'message') {
        const topic = extractTopicFromMessage();
        if (topic) {
            els.sectionTitle.textContent = `Clearing messages from the ${topic} project`;
        } else {
            els.sectionTitle.textContent = `Clearing matching messages`;
        }
    }
}

// Extract topic/project from message text
// Extract topic/project from message text
function extractTopicFromMessage(msg) {
    if (!msg) return null; // Logic in render uses 'General' if null, prevents 'undefined' string

    // Safety check if msg is object
    if (typeof msg !== 'string') return null;

    // Focus on the first sentence mostly (split by first dot that isn't part of an abbreviation/number?)
    // Simple split by first period followed by space or end of string
    const firstSentence = msg.split(/\.\s/)[0];

    // Patterns to look for "Topic"
    // We want the text AFTER these phrases:
    const patterns = [
        /consulting opportunity offering .+? to experts who can speak to (the use of )?/i,
        /consultation focused on/i,
        /consultation on (?:the use of )?/i,
        /call on/i,
        /learning more about/i,
        /experience (?:with|evaluating(?: and working with)?)/i,
        /regarding (?:the |a )?/i,
        /for (?:the |a )?(.+?) (?:role|position)/i, // Capture group inside for this specific one? No, unified logic better.
        /on the/i // "on the X space"
    ];

    let matchText = null;

    // specialized handling for "role/position" which captures the middle
    let roleMatch = firstSentence.match(/for (?:the |a )?([a-zA-Z][a-zA-Z\s\-]+?) (?:role|position)/i);
    if (roleMatch) {
        matchText = roleMatch[1];
    } else {
        // Iterate patterns
        for (const pattern of patterns) {
            const match = firstSentence.match(pattern);
            if (match) {
                // Get everything AFTER the match in the first sentence
                const matchIndex = match.index + match[0].length;
                matchText = firstSentence.substring(matchIndex).trim();
                break; // Use first valid match
            }
        }
    }

    if (!matchText) return null;

    // Clean up the result
    // 1. Truncate before "like", "such as", "including" (list starters)
    const listStop = matchText.match(/(\s(like|such as|including|specifically)\s)/i);
    if (listStop) {
        matchText = matchText.substring(0, listStop.index);
    }

    // 2. Truncate at "space" if it was "on the X space" (pattern specific cleanup)
    matchText = matchText.replace(/\s+space$/i, '');

    // 3. Truncate at punctuation if we captured too much (comma, etc)
    matchText = matchText.split(/[,!?;]/)[0];

    // 4. Remove generic words at start?
    // Not needed if regex consumes the prep phrase (e.g. "on")

    return matchText.trim();
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
        let type = 'info';

        // Determine which layout is currently active
        const isMessageLayout = els.progressLayoutMessage && els.progressLayoutMessage.style.display !== 'none';

        if (operationStatus === 'paused') {
            icon = ICONS.warning;
            text = 'Paused - Click Resume to continue';
            type = 'warning';
        } else if (operationStatus === 'scrolling') {
            if (isMessageLayout) {
                text = `Scanning: ${els.msgScanStatus?.textContent || 'Starting...'}`;
            } else {
                text = `Scrolling: ${els.scrollStatus?.textContent || 'Starting...'}`;
            }
        } else if (operationStatus === 'withdrawing') {
            if (isMessageLayout) {
                text = `Withdrawing: ${els.msgWithdrawStatus?.textContent || 'Processing...'}`;
            } else {
                text = `Withdrawing: ${els.statusText?.textContent || 'Processing...'}`;
            }
        }
        setContent(icon, text, type);

    } else if (operationStatus === 'stopped') {
        setContent(ICONS.warning, 'Stopped by user', 'warning');

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
    const historyView = document.getElementById('history-view');
    if (historyView) historyView.style.display = 'none';

    // Hide specialized lists/sections by default when switching views
    const srv = document.getElementById('scan-results-view');
    if (srv) srv.style.display = 'none';
    if (view !== 'progress') {
        if (els.liveScanResults) els.liveScanResults.style.display = 'none';
    }

    switch (view) {
        case 'wrongPage': if (els.wrongPageView) els.wrongPageView.style.display = 'block'; break;
        case 'main': if (els.mainView) els.mainView.style.display = 'block'; break;
        case 'progress':
            if (els.progressView) els.progressView.style.display = 'block';
            // Set correct layout based on current mode
            if (currentMode === 'message') {
                if (els.progressLayoutStandard) els.progressLayoutStandard.style.display = 'none';
                if (els.progressLayoutMessage) els.progressLayoutMessage.style.display = 'block';
            } else {
                if (els.progressLayoutStandard) els.progressLayoutStandard.style.display = 'block';
                if (els.progressLayoutMessage) els.progressLayoutMessage.style.display = 'none';
            }
            break;
        case 'completed': if (els.completedView) els.completedView.style.display = 'block'; break;
        case 'settings': if (els.settingsView) els.settingsView.style.display = 'block'; break;
        case 'history': if (historyView) historyView.style.display = 'block'; break;
        case 'scanResults':
            if (srv) srv.style.display = 'block';
            break;
    }

    // Update footer status to reflect current operation state
    try {
        updateFooterStatus();
    } catch (e) { console.error('Footer update error', e); }

    // Persist current view
    if (view !== 'wrongPage') {
        chrome.storage.local.set({ lastView: view }).catch(() => { });
    }
}

// ============ SCAN MODE ============
let selectedScanHashes = new Set();
let foundScanResults = [];

async function startScan() {
    if (!activeTabId) {
        alert('StartScan Error: No active tab ID found. Please reload.');
        return;
    }

    // Check page validity first
    const pageOk = await checkPage();
    if (!pageOk) return;

    // Clear any saved results when starting new
    chrome.storage.local.remove('savedScanResults');

    // Show progress view for scanning
    showView('progress');

    // Switch to message mode progress layout
    if (els.progressLayoutStandard) els.progressLayoutStandard.style.display = 'none';
    if (els.progressLayoutMessage) els.progressLayoutMessage.style.display = 'block';

    // Show scanning state, hide withdrawal state
    if (els.msgStepScan) els.msgStepScan.style.display = 'block';
    if (els.msgStepWithdraw) els.msgStepWithdraw.style.display = 'none';
    if (els.msgScanFill) els.msgScanFill.style.width = '0%';
    if (els.msgScanStatus) els.msgScanStatus.textContent = 'Found 0 unique messages.';

    if (els.sectionTitle) els.sectionTitle.textContent = 'Scanning connections...';

    // Show live scan results list
    if (els.liveScanResults) {
        els.liveScanResults.style.display = 'block';
        if (els.liveResultsList) els.liveResultsList.innerHTML = '';
    }

    // Hide withdrawal-related elements during scan
    const matchesSection = document.getElementById('matches-list-section');
    if (matchesSection) matchesSection.style.display = 'none';

    const matchesList = document.getElementById('matches-list');
    if (matchesList) matchesList.innerHTML = '';

    if (els.pauseBtn) els.pauseBtn.style.display = 'none';
    if (els.stopBtn) els.stopBtn.style.display = 'block';

    // Store running mode
    isOperationRunning = true;
    operationStatus = 'scrolling';
    chrome.storage.local.set({ runningMode: 'message' });
    updateFooterStatus();

    // Send Scan command (no callback needed - content script doesn't send response)
    chrome.tabs.sendMessage(activeTabId, { action: 'SCAN_CONNECTIONS' });
}

function handleScanComplete(message) {
    foundScanResults = message.results || [];
    selectedScanHashes.clear(); // Reset selection

    // Save results for persistence (only if user accidentally closes)
    chrome.storage.local.set({ savedScanResults: foundScanResults });

    renderScanResults(foundScanResults);
    showView('scanResults');

    // Reset progress view for next time
    if (els.sectionTitle) els.sectionTitle.textContent = 'Clearing connections...';
    if (els.stepScrollLabel) els.stepScrollLabel.textContent = 'Scrolling to bottom';
}

function renderScanResults(results) {
    const list = document.getElementById('scan-results-list');
    const empty = document.getElementById('empty-scan');
    const withdrawBtn = document.getElementById('withdraw-selected-btn');
    const countSpan = document.getElementById('selected-count');

    if (!list) return;
    list.innerHTML = '';

    if (results.length === 0) {
        if (empty) empty.style.display = 'block';
        if (withdrawBtn) withdrawBtn.disabled = true;
        return;
    }

    if (empty) empty.style.display = 'none';

    results.forEach(item => {
        // Extract topic or use message snippet
        const topic = extractTopicFromMessage(item.message) || `"${item.message.substring(0, 40)}${item.message.length > 40 ? '...' : ''}"`;
        const shortMsg = item.message.substring(0, 60) + (item.message.length > 60 ? '...' : '');
        const ageRange = item.ages && item.ages.length > 0 ?
            (item.ages.length > 1 ? `${item.ages[item.ages.length - 1]} - ${item.ages[0]}` : item.ages[0])
            : 'Unknown';

        const div = document.createElement('div');
        div.className = 'scan-result-item';

        // Header
        const header = document.createElement('div');
        header.className = 'scan-result-header';

        const checkboxWrapper = document.createElement('div');
        checkboxWrapper.className = 'scan-checkbox-wrapper';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'scan-checkbox';
        checkbox.dataset.hash = item.id;
        checkboxWrapper.appendChild(checkbox);

        const info = document.createElement('div');
        info.className = 'scan-info';
        info.title = 'Click to expand/collapse';

        const scanTopic = document.createElement('div');
        scanTopic.className = 'scan-topic';
        scanTopic.textContent = topic;

        const scanPreview = document.createElement('div');
        scanPreview.className = 'scan-preview';
        scanPreview.textContent = shortMsg;

        info.appendChild(scanTopic);
        info.appendChild(scanPreview);

        const meta = document.createElement('div');
        meta.className = 'scan-meta';
        const badge = document.createElement('span');
        badge.className = 'scan-count-badge';
        badge.textContent = item.count;
        meta.appendChild(badge);

        header.appendChild(checkboxWrapper);
        header.appendChild(info);
        header.appendChild(meta);

        // Details
        const details = document.createElement('div');
        details.className = 'scan-details';
        details.style.display = 'none';

        const detailRow = document.createElement('div');
        detailRow.className = 'scan-detail-row';
        const ageLabel = document.createElement('strong');
        ageLabel.textContent = 'Age Range: ';
        detailRow.appendChild(ageLabel);
        detailRow.appendChild(document.createTextNode(ageRange));

        const fullMessageDiv = document.createElement('div');
        fullMessageDiv.className = 'scan-full-message';
        fullMessageDiv.textContent = item.fullMessage;

        const peopleSection = document.createElement('div');
        peopleSection.className = 'scan-people-section';

        const peopleToggle = document.createElement('div');
        peopleToggle.className = 'people-toggle';
        peopleToggle.style.marginTop = '8px';
        peopleToggle.style.cursor = 'pointer';
        peopleToggle.style.color = 'var(--brand-primary)';
        peopleToggle.style.fontSize = '12px';
        peopleToggle.style.fontWeight = '600';
        peopleToggle.textContent = `Show ${item.people ? item.people.length : 0} People in Group`;

        const peopleList = document.createElement('div');
        peopleList.className = 'people-list';
        peopleList.style.display = 'none';
        peopleList.style.marginTop = '8px';
        peopleList.style.borderTop = '1px solid var(--border-default)';
        peopleList.style.paddingTop = '4px';

        if (item.people) {
            item.people.forEach(p => {
                const pRow = document.createElement('div');
                pRow.className = 'person-row';

                const pName = document.createElement('span');
                pName.className = 'person-name';
                pName.dataset.id = p.id;
                pName.textContent = p.name;

                const pAge = document.createElement('span');
                pAge.className = 'person-age';
                pAge.textContent = p.age;

                pRow.appendChild(pName);
                pRow.appendChild(pAge);
                peopleList.appendChild(pRow);
            });
        }

        peopleSection.appendChild(peopleToggle);
        peopleSection.appendChild(peopleList);

        details.appendChild(detailRow);
        details.appendChild(fullMessageDiv);
        details.appendChild(peopleSection);

        div.appendChild(header);
        div.appendChild(details);

        // Handlers


        // Checkbox click
        checkbox.addEventListener('change', (e) => {
            if (e.target.checked) selectedScanHashes.add(item.id);
            else selectedScanHashes.delete(item.id);
            updateWithdrawButton();
        });

        // Expand/Collapse Group
        info.addEventListener('click', () => {
            details.style.display = details.style.display === 'none' ? 'block' : 'none';
        });

        // Expand/Collapse People
        if (peopleToggle && peopleList) {
            peopleToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const isHidden = peopleList.style.display === 'none';
                peopleList.style.display = isHidden ? 'block' : 'none';
                peopleToggle.textContent = isHidden ? 'Hide People' : `Show ${item.people ? item.people.length : 0} People in Group`;
            });
        }

        // Show person on page
        const personLinks = div.querySelectorAll('.person-name');
        personLinks.forEach(link => {
            link.style.cursor = 'pointer';
            link.style.textDecoration = 'underline';
            link.addEventListener('click', (e) => {
                const pid = e.target.getAttribute('data-id');
                if (activeTabId && pid) {
                    chrome.tabs.sendMessage(activeTabId, {
                        action: 'SHOW_CONNECTION',
                        hash: pid
                    });
                }
            });
        });

        list.appendChild(div);
    });

    updateWithdrawButton();
}

function updateWithdrawButton() {
    const btn = document.getElementById('withdraw-selected-btn');
    const countSpan = document.getElementById('selected-count');
    if (!btn || !countSpan) return;

    const size = selectedScanHashes.size;
    countSpan.textContent = size;
    btn.disabled = size === 0;
}

// Track queue state for focused rendering
const matchesList = document.getElementById('matches-list');

// Save queue state to storage
function saveWithdrawalQueue() {
    if (!matchesList) return;

    const queueData = [];
    const rows = matchesList.querySelectorAll('tr');

    rows.forEach(row => {
        const name = row.getAttribute('data-name');
        const status = row.classList.contains('cleared') ? 'completed' :
            (row.classList.contains('active') ? 'active' : 'pending');

        // Extract Age text from innerHTML (hacky but effective given structure)
        const ageSpan = row.querySelector('.q-age') || row.querySelector('span'); // Fallback
        let age = '';
        if (ageSpan) {
            age = ageSpan.textContent.replace(/[()]/g, '');
        }

        queueData.push({ name, age, status });
    });

    chrome.storage.local.set({ savedWithdrawalQueue: queueData });
}

// Restore queue from storage
function restoreWithdrawalQueue() {
    chrome.storage.local.get(['savedWithdrawalQueue'], (result) => {
        if (!result.savedWithdrawalQueue || !matchesList) return;

        // Clear current List? Only if we are strictly restoring.
        matchesList.innerHTML = '';
        const matchesSection = document.getElementById('matches-list-section');
        if (matchesSection && result.savedWithdrawalQueue.length > 0) {
            matchesSection.style.display = 'block';
            matchesSection.classList.remove('collapsed');
        }

        result.savedWithdrawalQueue.forEach(item => {
            // Re-create row
            const row = document.createElement('tr');
            row.setAttribute('data-name', item.name);

            if (item.status === 'active') row.classList.add('active');
            if (item.status === 'completed') row.classList.add('cleared');
            // pending is default/no-class

            const cellName = document.createElement('td');
            cellName.innerHTML = `${item.name} <span class="q-age" style="font-size: 11px; color: var(--text-secondary); margin-left: 4px;">(${item.age || ''})</span>`;

            const cellIcon = document.createElement('td');
            cellIcon.className = 'icon-cell';

            if (item.status === 'completed') {
                cellIcon.innerHTML = `<svg class="check-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>`;
            }

            row.appendChild(cellName);
            row.appendChild(cellIcon);
            matchesList.appendChild(row);

            // Auto-scroll if active
            if (item.status === 'active') { // Wait for render
                setTimeout(() => row.scrollIntoView({ behavior: 'auto', block: 'center' }), 100);
            }
        });
    });
}

function updateWithdrawalQueue(clearedData) {
    if (!matchesList) return;


    // clearedData = { name, age, profileUrl, status: 'active' | 'completed' }
    const { name, age, status } = clearedData;

    // Find row - Prioritize based on status logic to handle duplicates
    let row;
    const escapedName = CSS.escape(name);

    if (status === 'active') {
        // Look for a pending row first
        row = matchesList.querySelector(`tr[data-name="${escapedName}"]:not(.cleared):not(.active)`);
    } else if (status === 'completed') {
        // Look for the currently active row
        row = matchesList.querySelector(`tr[data-name="${escapedName}"].active`);
    }

    // Fallback: Find any non-cleared row, then any row
    if (!row) row = matchesList.querySelector(`tr[data-name="${escapedName}"]:not(.cleared)`);
    if (!row) row = matchesList.querySelector(`tr[data-name="${escapedName}"]`);

    if (!row) {
        row = document.createElement('tr');
        row.setAttribute('data-name', name);

        const cellName = document.createElement('td');
        // cellName.textContent = name;
        cellName.innerHTML = `${name} <span style="font-size: 11px; color: var(--text-secondary); margin-left: 4px;">(${age || ''})</span>`;

        const cellIcon = document.createElement('td');
        cellIcon.className = 'icon-cell';

        row.appendChild(cellName);
        row.appendChild(cellIcon);
        matchesList.appendChild(row);
    }

    // Update status styles
    if (status === 'active') {
        const allRows = matchesList.querySelectorAll('tr.active');
        allRows.forEach(r => r.classList.remove('active'));

        row.classList.remove('cleared');
        row.classList.add('active');

        // Auto-scroll
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (status === 'completed') {
        row.classList.remove('active');
        row.classList.add('cleared');

        const iconCell = row.querySelector('td:last-child');
        if (iconCell) {
            iconCell.innerHTML = `<svg class="check-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>`;
        }
    }

    saveWithdrawalQueue();
}

function resetWithdrawalQueue() {
    if (matchesList) matchesList.innerHTML = '';
    chrome.storage.local.remove('savedWithdrawalQueue');
}

async function handleWithdrawSelected() {
    if (selectedScanHashes.size === 0) return;

    // Hide scan results list so user can see progress
    const srv = document.getElementById('scan-results-view');
    if (srv) srv.style.display = 'none';
    if (els.liveScanResults) els.liveScanResults.style.display = 'none';

    showView('progress');

    // Use message mode progress layout
    if (els.progressLayoutStandard) els.progressLayoutStandard.style.display = 'none';
    if (els.progressLayoutMessage) els.progressLayoutMessage.style.display = 'block';

    // Hide scanning state, show withdrawal state
    if (els.msgStepScan) els.msgStepScan.style.display = 'none';
    if (els.msgStepWithdraw) {
        els.msgStepWithdraw.style.display = 'block';
    }
    if (els.msgWithdrawFill) els.msgWithdrawFill.style.width = '0%';
    if (els.msgWithdrawStatus) els.msgWithdrawStatus.textContent = 'Preparing...';

    if (els.sectionTitle) els.sectionTitle.textContent = 'Withdrawing connections...';

    // Show withdrawal log and pause button
    if (els.liveWithdrawalLog) els.liveWithdrawalLog.style.display = 'block';
    resetWithdrawalQueue();

    // Pre-populate queue with all people to be withdrawn (marked as pending)
    const selectedGroups = foundScanResults.filter(g => selectedScanHashes.has(g.id));
    selectedGroups.forEach(group => {
        (group.people || []).forEach(person => {
            updateWithdrawalQueue({
                name: person.name,
                age: person.age,
                status: 'pending'
            });
        });
    });

    if (els.pauseBtn) {
        els.pauseBtn.style.display = 'flex';
        const pauseText = els.pauseBtn.querySelector('.btn-text');
        if (pauseText) pauseText.textContent = 'Pause';
    }
    if (els.stopBtn) els.stopBtn.style.display = 'block';

    // Set operation state
    isOperationRunning = true;
    isPaused = false;
    operationStatus = 'withdrawing';
    updateFooterStatus();

    // Get settings including debug mode
    const settings = await chrome.storage.local.get(DEFAULTS);

    // Start withdrawal via content script (no callback needed - content script doesn't send response)
    const hashes = Array.from(selectedScanHashes);
    if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, {
            action: 'WITHDRAW_SELECTED',
            selectedHashes: hashes,
            debugMode: settings.debugMode === true,
            safeMode: settings.safeMode,
            safeThreshold: settings.safeThreshold,
            safeUnit: settings.safeUnit
        });
    }
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
    if (els.modeMessage) els.modeMessage.classList.toggle('active', mode === 'message');
    if (els.countInput) els.countInput.style.display = mode === 'count' ? 'block' : 'none';
    if (els.ageInput) els.ageInput.style.display = mode === 'age' ? 'block' : 'none';
    if (els.messageInput) els.messageInput.style.display = mode === 'message' ? 'block' : 'none';

    // Hide main start button in message mode (uses Scan button instead)
    if (els.startBtn) els.startBtn.style.display = mode === 'message' ? 'none' : 'block';

    updateModeDesc();
    saveInputs();
}

function updateModeDesc() {
    if (!els.modeDesc) return;

    if (currentMode === 'count') {
        const count = parseInt(els.withdrawCount?.value, 10) || 10;
        els.modeDesc.textContent = `Withdraws the ${count} oldest pending connections.`;
    } else if (currentMode === 'age') {
        const val = parseInt(els.ageValue?.value, 10) || 3;
        const unit = els.ageUnit?.value || 'month';
        const unitLabel = val === 1 ? unit : unit + 's';
        els.modeDesc.textContent = `Withdraws connections sent ${val} ${unitLabel} ago and older.`;
    } else if (currentMode === 'message') {
        els.modeDesc.textContent = `Scans connections to find and withdraw specific message groups.`;
    }
}

function getMessagePatterns() {
    const patterns = [];
    if (els.message1?.value?.trim()) patterns.push(els.message1.value.trim());
    if (els.message2?.value?.trim()) patterns.push(els.message2.value.trim());
    if (els.message3?.value?.trim()) patterns.push(els.message3.value.trim());
    return patterns;
}

// Show message edit section (opens editor, pauses operation)
function showMessageEditSection() {
    const section = document.getElementById('message-edit-section');
    const editLink = document.getElementById('edit-messages-link');

    if (!section) return;

    // Populate with current patterns
    const edit1 = document.getElementById('edit-message-1');
    const edit2 = document.getElementById('edit-message-2');
    const edit3 = document.getElementById('edit-message-3');

    if (edit1) edit1.value = els.message1?.value || '';
    if (edit2) edit2.value = els.message2?.value || '';
    if (edit3) edit3.value = els.message3?.value || '';

    section.style.display = 'block';
    if (editLink) editLink.style.display = 'none';

    // Pause the operation
    if (activeTabId && isOperationRunning) {
        chrome.tabs.sendMessage(activeTabId, { action: 'PAUSE_WITHDRAW' }).catch(() => { });
    }
}

// Hide message edit section
function hideMessageEditSection() {
    const section = document.getElementById('message-edit-section');
    const editLink = document.getElementById('edit-messages-link');

    if (section) section.style.display = 'none';
    if (editLink && currentMode === 'message') editLink.style.display = 'block';
}

// Apply message patterns and trigger re-search
function applyMessagesAndResearch() {
    const edit1 = document.getElementById('edit-message-1');
    const edit2 = document.getElementById('edit-message-2');
    const edit3 = document.getElementById('edit-message-3');

    // Save to main inputs
    if (els.message1 && edit1) els.message1.value = edit1.value;
    if (els.message2 && edit2) els.message2.value = edit2.value;
    if (els.message3 && edit3) els.message3.value = edit3.value;

    // Hide edit section, show link
    hideMessageEditSection();

    // Update title with new topic
    updateActiveTitle(currentMode, els.ageValue?.value, els.ageUnit?.value, els.withdrawCount?.value);

    // Clear existing matches list
    const matchesList = document.getElementById('matches-list');
    if (matchesList) matchesList.innerHTML = '';

    // Send updated patterns to content script and trigger re-search
    if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, {
            action: 'UPDATE_MESSAGES',
            messages: getMessagePatterns(),
            researchMode: true
        }).catch(() => { });
    }
}

async function saveInputs() {
    await chrome.storage.local.set({
        withdrawCount: parseInt(els.withdrawCount?.value, 10) || 10,
        ageValue: parseInt(els.ageValue?.value, 10) || 3,
        ageUnit: els.ageUnit?.value || 'month',
        currentMode: currentMode,
        message1: els.message1?.value || '',
        message2: els.message2?.value || '',
        message3: els.message3?.value || ''
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
        modeMessage: document.getElementById('mode-message'),
        modeDesc: document.getElementById('mode-desc'),
        countInput: document.getElementById('count-input'),
        ageInput: document.getElementById('age-input'),
        messageInput: document.getElementById('message-input'),
        message1: document.getElementById('message-1'),
        message2: document.getElementById('message-2'),
        message3: document.getElementById('message-3'),
        message3Container: document.getElementById('message-3-container'),
        addMessageBtn: document.getElementById('add-message-btn'),
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
        debugModeToggle: document.getElementById('debug-mode-toggle'),
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
        inlineContinueModeRadios: document.querySelectorAll('input[name="inline-continue-mode"]'),

        // Live Scan Results
        liveScanResults: document.getElementById('live-scan-results'),
        liveResultsList: document.getElementById('live-results-list'),

        // Live Withdrawal Log
        liveWithdrawalLog: document.getElementById('live-withdrawal-log'),
        withdrawalLogList: document.getElementById('withdrawal-log-list'),

        // People Queue (for Count/Age mode)
        peopleQueueSection: document.getElementById('people-queue-section'),
        peopleQueueList: document.getElementById('people-queue-list'),

        // Cleared List (post-withdrawal)
        clearedListSection: document.getElementById('cleared-list-section'),
        clearedList: document.getElementById('cleared-list'),

        // Pause Button
        pauseBtn: document.getElementById('pause-btn'),

        // Message Mode Progress Elements
        progressLayoutStandard: document.getElementById('progress-layout-standard'),
        progressLayoutMessage: document.getElementById('progress-layout-message'),
        msgStepScan: document.getElementById('msg-step-scan'),
        msgScanFill: document.getElementById('msg-scan-fill'),
        msgScanStatus: document.getElementById('msg-scan-status'),
        msgStepWithdraw: document.getElementById('msg-step-withdraw'),
        msgWithdrawFill: document.getElementById('msg-withdraw-fill'),
        msgWithdrawStatus: document.getElementById('msg-withdraw-status'),

        // Post-Withdraw Mode Sections
        postWithdrawStandard: document.getElementById('post-withdraw-standard'),
        postWithdrawMessage: document.getElementById('post-withdraw-message'),
        remainingScanList: document.getElementById('remaining-scan-list')
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

    // Apply debug mode
    if (els.debugModeToggle) els.debugModeToggle.checked = saved.debugMode === true;

    // Restore input values
    if (els.withdrawCount) els.withdrawCount.value = saved.withdrawCount;
    if (els.ageValue) els.ageValue.value = saved.ageValue || 3;
    if (els.ageUnit) els.ageUnit.value = saved.ageUnit || 'month';

    // Restore message patterns
    if (els.message1) els.message1.value = saved.message1 || '';
    if (els.message2) els.message2.value = saved.message2 || '';
    if (els.message3) els.message3.value = saved.message3 || '';
    // Show third message container if it has a value
    if (saved.message3 && els.message3Container && els.addMessageBtn) {
        els.message3Container.style.display = 'block';
        els.addMessageBtn.style.display = 'none';
    }

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
    // moved to end of init to ensure listeners are attached first

    // ============ EVENT LISTENERS ============

    if (els.openSentBtn) {
        els.openSentBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: SENT_URL });
        });
    }

    if (els.modeCount) els.modeCount.addEventListener('click', () => setMode('count'));
    if (els.modeAge) els.modeAge.addEventListener('click', () => setMode('age'));
    if (els.modeMessage) els.modeMessage.addEventListener('click', () => setMode('message'));

    // Message mode listeners - update desc and persist values
    // Scan Mode listeners
    const scanBtn = document.getElementById('scan-btn');
    if (scanBtn) scanBtn.addEventListener('click', startScan);

    const withdrawSelectedBtn = document.getElementById('withdraw-selected-btn');
    if (withdrawSelectedBtn) withdrawSelectedBtn.addEventListener('click', handleWithdrawSelected);

    const scanAgainBtn = document.getElementById('scan-again-btn');
    if (scanAgainBtn) scanAgainBtn.addEventListener('click', startScan);

    const cancelScanBtn = document.getElementById('cancel-scan-btn');
    if (cancelScanBtn) cancelScanBtn.addEventListener('click', goHome);

    // Edit messages link in progress view
    const editMessagesLink = document.getElementById('edit-messages-link');
    if (editMessagesLink) {
        editMessagesLink.addEventListener('click', (e) => {
            e.preventDefault();
            showMessageEditSection();
        });
    }

    // Apply messages button in edit section
    const applyMessagesBtn = document.getElementById('apply-messages-btn');
    if (applyMessagesBtn) {
        applyMessagesBtn.addEventListener('click', applyMessagesAndResearch);
    }

    if (els.withdrawCount) {
        els.withdrawCount.addEventListener('change', saveInputs);
        els.withdrawCount.addEventListener('input', saveInputs);
    }
    if (els.ageValue) {
        els.ageValue.addEventListener('change', saveInputs);
        els.ageValue.addEventListener('input', saveInputs);
    }
    if (els.ageUnit) els.ageUnit.addEventListener('change', saveInputs);

    // Also attach to message inputs for real-time saving
    if (els.message1) els.message1.addEventListener('input', saveInputs);
    if (els.message2) els.message2.addEventListener('input', saveInputs);
    if (els.message3) els.message3.addEventListener('input', saveInputs);

    if (els.startBtn) els.startBtn.addEventListener('click', startClearing);
    if (els.stopBtn) els.stopBtn.addEventListener('click', stopClearing);
    if (els.pauseBtn) els.pauseBtn.addEventListener('click', pauseClearing);
    if (els.clearMoreBtn) els.clearMoreBtn.addEventListener('click', goToMain);

    if (els.settingsBtn) els.settingsBtn.addEventListener('click', () => showView('settings'));

    // History button
    const historyBtn = document.getElementById('history-btn');
    if (historyBtn) historyBtn.addEventListener('click', showHistoryView);

    // History back button
    const historyBackBtn = document.getElementById('history-back-btn');
    if (historyBackBtn) historyBackBtn.addEventListener('click', goToMain);

    // Matches list toggle
    const matchesToggle = document.getElementById('matches-toggle');
    if (matchesToggle) matchesToggle.addEventListener('click', toggleMatchesList);

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

    if (els.debugModeToggle) {
        els.debugModeToggle.addEventListener('change', () => {
            chrome.storage.local.set({ debugMode: els.debugModeToggle.checked });
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
    if (els.doneBtn) els.doneBtn.addEventListener('click', async () => {
        chrome.storage.local.set({ showingPostClear: false, postClearTimestamp: 0 });
        await goHome();
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

    // Delegated listener for Live Scan Results (toggle details/people)
    if (els.liveResultsList) {
        els.liveResultsList.addEventListener('click', (e) => {
            const target = e.target;

            // Toggle Group Details
            const info = target.closest('.scan-info');
            if (info) {
                const details = info.parentElement.nextElementSibling;
                if (details) details.style.display = details.style.display === 'none' ? 'block' : 'none';
                return;
            }

            // Toggle People List
            if (target.dataset.action === 'toggle-people') {
                e.stopPropagation();
                const container = target.closest('.scan-people-section');
                const list = container ? container.querySelector('.people-list') : null;
                if (list) {
                    const isHidden = list.style.display === 'none';
                    list.style.display = isHidden ? 'block' : 'none';

                    // Update text safely
                    const count = list.children.length;
                    target.textContent = isHidden ? 'Hide People' : `Show ${count} People in Group`;
                }
                return;
            }

            // Show Person on Page
            if (target.classList.contains('person-name')) {
                const pid = target.getAttribute('data-id');
                if (activeTabId && pid) {
                    chrome.tabs.sendMessage(activeTabId, {
                        action: 'SHOW_CONNECTION',
                        hash: pid
                    });
                }
            }
        });
    }

    // Initial page check (with error handling)
    try {
        // ALWAYS check for running operations FIRST
        const pageOk = await checkPage();
        if (pageOk) {
            // Try to get status from content script  
            try {
                const response = await Promise.race([
                    new Promise((resolve) => {
                        chrome.tabs.sendMessage(activeTabId, { action: 'GET_STATUS' }, (res) => {
                            if (chrome.runtime.lastError) resolve(null);
                            else resolve(res);
                        });
                    }),
                    new Promise(resolve => setTimeout(() => resolve(null), 1000))
                ]);

                if (response && response.isRunning) {
                    // Operation is running! Show progress view
                    isOperationRunning = true;
                    operationStatus = response.subMode || 'scrolling';
                    currentMode = response.mode || 'count';

                    // Store running mode
                    chrome.storage.local.set({ runningMode: currentMode });

                    showView('progress');

                    // Set correct layout based on mode
                    if (currentMode === 'message') {
                        if (els.progressLayoutStandard) els.progressLayoutStandard.style.display = 'none';
                        if (els.progressLayoutMessage) els.progressLayoutMessage.style.display = 'block';

                        // Restore queue for withdrawal phase
                        if (response.subMode === 'withdrawing') {
                            restoreWithdrawalQueue();
                            const matchesSection = document.getElementById('matches-list-section');
                            if (matchesSection) matchesSection.style.display = 'block';
                        }
                    } else {
                        if (els.progressLayoutStandard) els.progressLayoutStandard.style.display = 'block';
                        if (els.progressLayoutMessage) els.progressLayoutMessage.style.display = 'none';

                        // Restore queue
                        restoreWithdrawalQueue();
                        const matchesSection = document.getElementById('matches-list-section');
                        if (matchesSection) {
                            matchesSection.style.display = 'block';
                            matchesSection.classList.remove('collapsed');
                        }
                    }

                    updateFooterStatus();
                    return; // Don't check other states
                }
            } catch (e) {
                console.log('Status check failed:', e);
            }
        }

        // No running operation - check for saved scan results (Persistence)
        const scanData = await chrome.storage.local.get(['savedScanResults']);
        if (scanData.savedScanResults && scanData.savedScanResults.length > 0) {
            foundScanResults = scanData.savedScanResults;
            renderScanResults(foundScanResults);
            showView('scanResults');

            // Still perform a background check for page connection, but don't redirect
            checkPage().catch(e => console.warn('Background page check warning', e));
        } else {
            // Check for last persisted view
            const viewData = await chrome.storage.local.get(['lastView']);
            const lastView = viewData.lastView;

            // Only restore "safe" views
            if (lastView && ['settings', 'history', 'main', 'completed'].includes(lastView)) {
                showView(lastView);
                // Still check page validity
                checkPage().catch(() => { });
            } else {
                // Default to standard home check
                await goHome();
            }
        }
    } catch (e) {
        console.error('Init failed', e);
        // Fallback
        showView('main');
    }

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
                currentMode = response.mode || 'count'; // Ensure global mode is synced
                showView('progress');
                updateActiveTitle(response.mode, response.ageValue, response.ageUnit, response.count);
                console.log('Restoring State:', { mode: response.mode, subMode: response.subMode, status: response.statusText });

                // Handle Layout Visibility - MESSAGE MODE
                if (response.mode === 'message') {
                    // Hide standard layout completely
                    if (els.progressLayoutStandard) els.progressLayoutStandard.style.display = 'none';
                    if (els.progressLayoutMessage) els.progressLayoutMessage.style.display = 'block';

                    // Show saved queue if any
                    restoreWithdrawalQueue();

                    // Specific sub-state restoration
                    if (response.subMode === 'withdrawing') {
                        if (els.stepWithdraw) {
                            els.stepWithdraw.classList.add('active');
                            els.stepWithdraw.classList.remove('completed');
                        }
                    }
                    // 1. Scanning Phase
                    if (response.subMode === 'scanning') {
                        if (els.msgStepScan) els.msgStepScan.style.display = 'block';
                        if (els.msgStepWithdraw) els.msgStepWithdraw.style.display = 'none';
                        if (els.msgScanFill) els.msgScanFill.style.width = response.progress + '%';
                        if (els.msgScanStatus) els.msgScanStatus.textContent = response.statusText;
                    }
                    // 2. Withdrawal Phase
                    else if (response.subMode === 'withdrawing') {
                        if (els.msgStepScan) els.msgStepScan.style.display = 'none';
                        if (els.msgStepWithdraw) els.msgStepWithdraw.style.display = 'block';
                        if (els.msgWithdrawFill) els.msgWithdrawFill.style.width = response.progress + '%';
                        if (els.msgWithdrawStatus) els.msgWithdrawStatus.textContent = response.statusText;
                    }
                    // 3. Selection Phase (Implicit: isRunning=false usually, but if we catch it here)
                    else {
                        // Fallback to Scan if undefined
                        if (els.msgStepScan) els.msgStepScan.style.display = 'block';
                        if (els.msgStepWithdraw) els.msgStepWithdraw.style.display = 'none';
                        if (els.msgScanFill) els.msgScanFill.style.width = response.progress + '%';
                        if (els.msgScanStatus) els.msgScanStatus.textContent = response.statusText;
                    }

                } else {
                    if (els.progressLayoutStandard) els.progressLayoutStandard.style.display = 'block';
                    if (els.progressLayoutMessage) els.progressLayoutMessage.style.display = 'none';

                    // Force visibility and set title for Standard Mode (Count/Age)
                    // This ensures the "Removal Queue" header is visible even while scanning/scrolling
                    const matchesSection = document.getElementById('matches-list-section');
                    const matchesLabel = document.getElementById('matches-label');
                    if (matchesSection) {
                        matchesSection.style.display = 'block';
                        matchesSection.classList.remove('collapsed');
                    }
                    if (matchesLabel) {
                        matchesLabel.textContent = 'Removal Queue';
                        if (matchesLabel.parentElement) matchesLabel.parentElement.setAttribute('data-label', 'Removal Queue');
                    }

                    // Standard mode - Restore queue
                    restoreWithdrawalQueue();

                    // Specific sub-state restoration for standard mode (Count/Age)
                    if (response.subMode === 'withdrawing') {
                        // Standard mode steps already handled by updateStatus mostly, 
                        // but we can ensure steps are active
                        if (els.stepScroll) {
                            els.stepScroll.classList.remove('active');
                            els.stepScroll.classList.add('completed');
                        }
                        if (els.stepWithdraw) {
                            els.stepWithdraw.classList.add('active');
                        }
                    }

                    // Standard update
                    if (els.progressFill) els.progressFill.style.width = response.progress + '%';
                    if (els.statusText) els.statusText.textContent = response.statusText;
                }
            } else {
                // Check if we were in Selection Phase (not running, but have results)
                chrome.storage.local.get(['savedScanResults'], (data) => {
                    if (data.savedScanResults && data.savedScanResults.length > 0) {
                        // We are in selection mode
                        foundScanResults = data.savedScanResults;
                        renderScanResults(foundScanResults);
                        showView('scanResults');
                        // Ensure message layout is prepped if they hit Withdraw
                        if (els.progressLayoutStandard) els.progressLayoutStandard.style.display = 'none';
                        if (els.progressLayoutMessage) els.progressLayoutMessage.style.display = 'block';
                    }
                });
            }
        });
    } catch (e) { }
}

// ============ START / STOP ============

async function startClearing() {
    if (!activeTabId) return;

    await saveInputs();

    // If in message mode, start scan instead of immediate withdrawal
    if (currentMode === 'message') {
        startScan();
        return;
    }

    const settings = await chrome.storage.local.get(DEFAULTS);

    const message = {
        action: 'START_WITHDRAW',
        mode: currentMode,
        count: parseInt(els.withdrawCount?.value, 10) || 10,
        ageValue: parseInt(els.ageValue?.value, 10) || 3,
        ageUnit: els.ageUnit?.value || 'month',
        messages: getMessagePatterns(),
        safeThreshold: settings.safeThreshold,
        safeUnit: settings.safeUnit,
        safeMode: settings.safeMode,
        debugMode: settings.debugMode === true
    };

    // Validate message mode
    if (currentMode === 'message' && message.messages.length === 0) {
        alert('Please enter at least one message pattern to match.');
        return;
    }

    try {
        await chrome.tabs.sendMessage(activeTabId, message);
        showView('progress');

        // Set operation running state
        isOperationRunning = true;
        isPaused = false;
        chrome.storage.local.set({ showingPostClear: false, runningMode: currentMode });
        operationStatus = 'scrolling';
        updateActiveTitle(currentMode, els.ageValue.value, els.ageUnit.value, els.withdrawCount.value);
        updateFooterStatus();

        // Show correct progress layout based on mode

        // Reset inline stats (may be visible from previous completion)
        const inlineStats = document.getElementById('inline-stats');
        if (inlineStats) inlineStats.style.display = 'none';
        if (els.progressLayoutStandard) els.progressLayoutStandard.style.display = 'block';
        if (els.progressLayoutMessage) els.progressLayoutMessage.style.display = 'none';

        // Show pause button, hide initially (will show when withdrawal starts)
        if (els.pauseBtn) {
            els.pauseBtn.style.display = 'none';
            const pauseText = els.pauseBtn.querySelector('.btn-text');
            if (pauseText) pauseText.textContent = 'Pause';
        }
        if (els.stopBtn) els.stopBtn.style.display = 'block';

        // Reset people queue (legacy cleanup)
        // if (els.peopleQueueSection) els.peopleQueueSection.style.display = 'none';

        // Reset step states using helper
        resetProgressView();
        if (els.stepWithdrawLabel) els.stepWithdrawLabel.classList.remove('wave-text');

        if (els.stepWithdraw) {
            els.stepWithdraw.classList.remove('active', 'completed', 'stopped');
            // Reset colors from previous completion state
            els.stepWithdraw.style.borderColor = '';
        }
        if (els.stepWithdrawCheck) els.stepWithdrawCheck.style.display = 'none';
        if (els.stepWithdrawNum) els.stepWithdrawNum.style.display = 'flex';
        if (els.progressFill) {
            els.progressFill.style.width = '0%';
            els.progressFill.style.backgroundColor = ''; // Reset color
        }
        if (els.statusText) {
            els.statusText.textContent = 'Waiting...';
            els.statusText.style.color = ''; // Reset color
        }

        // Reset section title color
        if (els.sectionTitle) {
            els.sectionTitle.style.color = '';
        }

        // Reset scroll progress fill color
        if (els.scrollProgressFill) {
            els.scrollProgressFill.style.backgroundColor = '';
        }

        // Reset and show/hide message mode sections
        const matchesSection = document.getElementById('matches-list-section');
        const matchesList = document.getElementById('matches-list');
        const editSection = document.getElementById('message-edit-section');
        const editLink = document.getElementById('edit-messages-link');

        if (matchesList) matchesList.innerHTML = '';

        if (matchesSection) {
            matchesSection.style.display = 'block';
            matchesSection.classList.remove('collapsed'); // Ensure open
        }

        if (currentMode === 'message') {
            // Show matches section and edit link
            if (editSection) editSection.style.display = 'none';
            if (editLink) editLink.style.display = 'block';

            // Set label
            const title = document.getElementById('matches-label');
            if (title) title.textContent = 'Matching connections';
        } else {
            if (editSection) editSection.style.display = 'none';
            if (editLink) editLink.style.display = 'none';

            // Also hide live scan results
            if (els.liveScanResults) els.liveScanResults.style.display = 'none';
            if (els.liveResultsList) els.liveResultsList.innerHTML = '';

            // Set label
            const title = document.getElementById('matches-label');
            if (title) title.textContent = 'Removal Queue';
        }
    } catch (e) {
        alert('Error: Refresh the LinkedIn page and try again.');
    }
}

async function stopClearing() {
    if (!activeTabId) return;

    // Show loading state
    if (els.stopBtn) {
        els.stopBtn.classList.add('loading');
        els.stopBtn.disabled = true;
    }

    try {
        // Determine current phase
        const isScanning = operationStatus === 'scrolling' ||
            (currentMode === 'message' && els.msgStepScan && els.msgStepScan.style.display !== 'none');

        // Set cancel flag if stopping during scan (prevents COMPLETED handler from showing stats)
        if (isScanning) {
            isCancellingOperation = true;
        }

        await chrome.tabs.sendMessage(activeTabId, { action: 'STOP_WITHDRAW' });

        // Remove loading state after a brief delay
        await new Promise(r => setTimeout(r, 300));

        if (els.stopBtn) {
            els.stopBtn.classList.remove('loading');
            els.stopBtn.disabled = false;
        }

        // If stopped during scanning phase, go back to main view
        if (isScanning) {
            isCancellingOperation = false; // Reset flag
            isOperationRunning = false;
            operationStatus = '';
            chrome.storage.local.remove(['savedScanResults', 'runningMode']);
            showView('main');
            setFooterStatus('Scan cancelled', 'info');
        }
        // If stopped during withdrawal, the COMPLETE message from content.js will handle the UI transition
    } catch (e) {
        // Fallback if content script not responding
        if (els.stopBtn) {
            els.stopBtn.classList.remove('loading');
            els.stopBtn.disabled = false;
        }
        isOperationRunning = false;
        showView('main');
    }
}

let isPaused = false;

async function pauseClearing() {
    if (!activeTabId) return;

    // Show loading state
    if (els.pauseBtn) {
        els.pauseBtn.classList.add('loading');
        els.pauseBtn.disabled = true;
    }

    try {
        if (isPaused) {
            // Resume
            await chrome.tabs.sendMessage(activeTabId, { action: 'RESUME_WITHDRAW' });
            isPaused = false;
            operationStatus = 'withdrawing';

            // Update button after brief delay
            await new Promise(r => setTimeout(r, 200));
            if (els.pauseBtn) {
                els.pauseBtn.classList.remove('loading');
                els.pauseBtn.disabled = false;
                const textSpan = els.pauseBtn.querySelector('.btn-text');
                if (textSpan) textSpan.textContent = 'Pause';
            }
        } else {
            // Pause
            await chrome.tabs.sendMessage(activeTabId, { action: 'PAUSE_WITHDRAW' });
            isPaused = true;
            operationStatus = 'paused';

            // Update button after brief delay
            await new Promise(r => setTimeout(r, 200));
            if (els.pauseBtn) {
                els.pauseBtn.classList.remove('loading');
                els.pauseBtn.disabled = false;
                const textSpan = els.pauseBtn.querySelector('.btn-text');
                if (textSpan) textSpan.textContent = 'Resume';
            }
        }
        updateFooterStatus();
    } catch (e) {
        console.error('Pause error:', e);
        if (els.pauseBtn) {
            els.pauseBtn.classList.remove('loading');
            els.pauseBtn.disabled = false;
        }
    }
}

// ============ MESSAGE HANDLING ============

function handleMessage(message) {
    if (message.action === 'SCROLL_PROGRESS') {
        // Message mode uses UPDATE_STATUS instead, skip standard layout updates
        if (currentMode === 'message') return;

        const text = message.text || `Found ${message.found} of ~${message.total}`;
        const pct = message.progress || 0;

        // Route status update based on active step
        // If Scanning (Step 1 active)
        if (els.stepScroll && els.stepScroll.classList.contains('active')) {
            if (els.scrollStatus) els.scrollStatus.textContent = text;
            if (els.scrollProgressFill) els.scrollProgressFill.style.width = pct + '%';
        }
        // If Withdrawing (Step 2 active)
        else if (els.stepWithdraw && els.stepWithdraw.classList.contains('active')) {
            if (els.statusText) els.statusText.textContent = text;
            if (els.progressFill) els.progressFill.style.width = pct + '%';
        }
        // Fallback for generic/mixed states
        else {
            if (els.statusText) els.statusText.textContent = text;
        }

        updateFooterStatus();
    } else if (message.action === 'SCROLL_COMPLETE') {
        // Message Mode handles its own transition from Scan -> Selection -> Withdraw
        if (currentMode === 'message') return;

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
    } else if (message.action === 'POPULATE_QUEUE') {
        const targets = message.targets || [];

        // Ensure section is visible
        const matchesSection = document.getElementById('matches-list-section');
        if (matchesSection) {
            matchesSection.style.display = 'block';
            matchesSection.classList.remove('collapsed');
        }

        // Populate queue
        const matchesList = document.getElementById('matches-list');
        if (matchesList) {
            targets.forEach(t => {
                const row = document.createElement('tr');
                row.setAttribute('data-name', t.name);

                const cellName = document.createElement('td');
                cellName.innerHTML = `${t.name} <span class="q-age" style="font-size: 11px; color: var(--text-secondary); margin-left: 4px;">(${t.age || ''})</span>`;

                const cellIcon = document.createElement('td');
                cellIcon.className = 'icon-cell';

                row.appendChild(cellName);
                row.appendChild(cellIcon);

                if (message.prepend && matchesList.firstChild) {
                    matchesList.insertBefore(row, matchesList.firstChild);
                } else {
                    matchesList.appendChild(row);
                }
            });
            // Save state immediately
            saveWithdrawalQueue();
        }
    } else if (message.action === 'UPDATE_STATUS') {
        const text = message.text;
        const pct = message.progress;

        // Determine which layout is active
        const isMessageLayout = els.progressLayoutMessage && els.progressLayoutMessage.style.display !== 'none';
        const isScanningPhase = els.msgStepScan && els.msgStepScan.style.display !== 'none';
        const isWithdrawingPhase = els.msgStepWithdraw && els.msgStepWithdraw.style.display !== 'none';

        // Route status update based on active layout and phase
        if (isMessageLayout) {
            // Message mode routing
            if (isScanningPhase) {
                // Update scan progress
                if (els.msgScanFill) els.msgScanFill.style.width = pct + '%';
                if (els.msgScanStatus) els.msgScanStatus.textContent = text;
            } else if (isWithdrawingPhase) {
                // Update withdrawal progress
                if (els.msgWithdrawFill) els.msgWithdrawFill.style.width = pct + '%';
                if (els.msgWithdrawStatus) els.msgWithdrawStatus.textContent = text;

                // Show pause button during withdrawal
                if (els.pauseBtn) els.pauseBtn.style.display = 'flex';

                // Show unified matches list section if not visible
                const matchesSection = document.getElementById('matches-list-section');
                if (matchesSection && matchesSection.style.display === 'none') {
                    matchesSection.style.display = 'block';
                }

                // Populate Withdrawal Queue with focused list items
                if (message.clearedData) {
                    updateWithdrawalQueue(message.clearedData);
                }
            }
        }
        // Standard layout (Count/Age mode) routing
        else if (els.stepScroll && els.stepScroll.classList.contains('active')) {
            if (els.scrollStatus) els.scrollStatus.textContent = text;
            if (els.scrollProgressFill) els.scrollProgressFill.style.width = pct + '%';
        }
        else if (els.stepWithdraw && els.stepWithdraw.classList.contains('active')) {
            if (els.statusText) els.statusText.textContent = text;
            if (els.progressFill) els.progressFill.style.width = pct + '%';

            // Show pause button when withdrawing starts
            if (els.pauseBtn) els.pauseBtn.style.display = 'flex';

            // Show unified matches list section if not visible
            const matchesSection = document.getElementById('matches-list-section');
            if (matchesSection && matchesSection.style.display === 'none') {
                matchesSection.style.display = 'block';
            }

            // Populate Withdrawal Queue
            if (message.clearedData) {
                updateWithdrawalQueue(message.clearedData);
            }
        }
        // Fallback
        else {
            if (els.statusText) els.statusText.textContent = text;
            if (els.progressFill) els.progressFill.style.width = pct + '%';
        }

        // Render live partial results if available
        // Render live partial results if available
        if (message.partialResults && els.liveScanResults) {
            els.liveScanResults.style.display = 'block';
            if (els.liveResultsList) {
                // Use same structure as renderScanResults but disabled checkboxes
                els.liveResultsList.innerHTML = message.partialResults.map(item => {
                    const topic = extractTopicFromMessage(item.message) || "General / Unknown Project";
                    const shortMsg = item.message.substring(0, 60) + (item.message.length > 60 ? '...' : '');

                    // Build people list HTML for live view
                    const peopleListHtml = (item.people || []).map(p =>
                        `<div class="person-row">
                            <span class="person-name" data-id="${p.id}">${p.name}</span>
                            <span class="person-age">${p.age}</span>
                        </div>`
                    ).join('');

                    return `
                        <div class="scan-result-item">
                            <div class="scan-result-header">
                                <div class="scan-checkbox-wrapper">
                                    <input type="checkbox" class="scan-checkbox" disabled>
                                </div>
                                <div class="scan-info" data-action="toggle-details">
                                    <div class="scan-topic">${topic}</div>
                                    <div class="scan-preview">${shortMsg}</div>
                                </div>
                                <div class="scan-meta">
                                    <span class="scan-count-badge">${item.count}</span>
                                </div>
                            </div>
                            <div class="scan-details" style="display:none;">
                                <div class="scan-full-message">${item.fullMessage || item.message}</div>
                                
                                <div class="scan-people-section">
                                    <div class="people-toggle" data-action="toggle-people" style="margin-top:8px; cursor:pointer; color:var(--brand-primary); font-size:12px; font-weight:600;">
                                        Show ${item.people ? item.people.length : 0} People in Group
                                    </div>
                                    <div class="people-list" style="display:none; margin-top:8px; border-top:1px solid var(--border-default); padding-top:4px;">
                                        ${peopleListHtml}
                                    </div>
                                </div>
                            </div>
                        </div>`;
                }).join('');
            }
        }

        // Apply red styling if text contains "Stopped"
        if (text && (text.includes('Stopped') || text.includes('stopped'))) {
            if (els.statusText) els.statusText.classList.add('error-text');
            if (els.scrollStatus) els.scrollStatus.classList.add('error-text');
        } else {
            if (els.statusText) els.statusText.classList.remove('error-text');
            if (els.scrollStatus) els.scrollStatus.classList.remove('error-text');
        }

        // Mark item as cleared in matches list (for message mode)
        if (message.clearedName && currentMode === 'message') {
            const matchesList = document.getElementById('matches-list');
            const matchesSection = document.getElementById('matches-list-section');

            if (matchesList && matchesSection) {
                matchesSection.style.display = 'block';

                let row = matchesList.querySelector(`tr[data-name="${message.clearedName}"]`);

                // If row doesn't exist, add it (fixes bug where items not caught during scroll)
                if (!row) {
                    const newRow = document.createElement('tr');
                    newRow.setAttribute('data-name', message.clearedName);
                    newRow.innerHTML = `<td>${message.clearedName}</td><td>${message.clearedAge || '-'}</td><td></td>`;
                    matchesList.appendChild(newRow);
                    row = newRow;
                }

                // Mark as cleared
                row.classList.add('cleared');
                row.querySelector('td:last-child').innerHTML = '<span class="check-icon">✓</span>';

                // Smart scroll to keep cleared item in view with context
                const rowTop = row.offsetTop;
                const sectionHeight = matchesSection.clientHeight;
                const targetScroll = rowTop - (sectionHeight / 2) + (row.offsetHeight / 2);
                matchesSection.scrollTop = Math.max(0, targetScroll);
            }
        }
    } else if (message.action === 'SCAN_COMPLETE') {
        handleScanComplete(message);
    } else if (message.action === 'COMPLETED') {
        // If we're cancelling during scan phase, skip all completion UI updates
        // (stopClearing will handle the UI transition)
        if (isCancellingOperation) {
            isOperationRunning = false;
            return;
        }

        const isStopped = message.message && (message.message.includes('Stopped') || message.message.includes('stopped'));
        const wasMessageMode = currentMode === 'message';

        // Mark operation done
        isOperationRunning = false;
        isPaused = false;
        operationStatus = isStopped ? 'stopped' : 'completed';

        // Hide action buttons
        if (els.pauseBtn) els.pauseBtn.style.display = 'none';
        if (els.stopBtn) els.stopBtn.style.display = 'none';

        // Update progress bar completion state
        if (wasMessageMode) {
            if (els.msgWithdrawFill) {
                els.msgWithdrawFill.style.width = '100%';
                if (isStopped) els.msgWithdrawFill.style.backgroundColor = 'var(--danger)';
            }
            if (els.msgWithdrawStatus) {
                els.msgWithdrawStatus.textContent = message.message || 'Complete!';
            }
        } else {
            // Standard mode completion
            if (els.stepWithdraw) {
                els.stepWithdraw.classList.remove('active');
                if (isStopped) {
                    els.stepWithdraw.classList.add('stopped');
                    if (els.stepWithdrawCheck) {
                        els.stepWithdrawCheck.innerHTML = ICONS.error;
                        els.stepWithdrawCheck.style.display = 'block';
                    }
                } else {
                    els.stepWithdraw.classList.add('completed');
                    if (els.stepWithdrawCheck) {
                        els.stepWithdrawCheck.innerHTML = ICONS.check;
                        els.stepWithdrawCheck.style.display = 'block';
                    }
                }
            }
            if (els.stepWithdrawNum) els.stepWithdrawNum.style.display = 'none';
            if (els.progressFill) {
                els.progressFill.style.width = '100%';
                if (isStopped) els.progressFill.style.backgroundColor = 'var(--danger)';
            }
            if (els.statusText) els.statusText.textContent = message.message || 'Complete!';
            if (els.stepWithdrawLabel) els.stepWithdrawLabel.classList.remove('wave-text');
        }

        // Store stats
        const stats = message.stats || { cleared: 0, oldest: '-', remaining: 0 };
        stats.timestamp = Date.now();
        stats.message = message.message || '';
        stats.mode = currentMode;

        // For Message mode STOP: return to selection screen instead of completed view
        if (wasMessageMode && isStopped && foundScanResults && foundScanResults.length > 0) {
            // Remove withdrawn items from the selection list
            if (message.stats && message.stats.withdrawnHashes) {
                message.stats.withdrawnHashes.forEach(h => selectedScanHashes.delete(h));
                // Also remove from foundScanResults if fully cleared
                foundScanResults = foundScanResults.filter(r => !message.stats.withdrawnHashes.includes(r.id));
            }
            renderScanResults(foundScanResults);
            showView('scanResults');
            const srv = document.getElementById('scan-results-view');
            if (srv) srv.style.display = 'block';
            return;
        }

        // For Message mode completion (not stopped): filter out withdrawn groups for "Back to Scan Results" button
        // BUT: Do not filter if it was a safety stop or error!
        const isSafetyOrError = message.message && (
            message.message.toLowerCase().includes('safety') ||
            message.message.toLowerCase().includes('limit') ||
            message.message.toLowerCase().includes('error')
        );

        if (wasMessageMode && !isStopped && !isSafetyOrError) {
            // Remove withdrawn groups from selectedScanHashes and foundScanResults
            selectedScanHashes.forEach(hash => {
                // Remove from foundScanResults
                foundScanResults = foundScanResults.filter(r => r.id !== hash);
            });
            // Clear selection for next time
            selectedScanHashes.clear();
        }

        // Stay on progress view and show inline stats with fade-in
        // (Don't navigate to completed view)
        updateFooterStatus();

        // Fade out step 1 (scrolling progress)
        if (els.stepScroll) {
            els.stepScroll.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
            els.stepScroll.style.opacity = '0';
            els.stepScroll.style.transform = 'translateY(-20px)';
            hideScrollTimeout = setTimeout(() => {
                // Only hide if operation hasn't been restarted
                if (!isOperationRunning) {
                    els.stepScroll.style.display = 'none';
                }
                hideScrollTimeout = null;
            }, 500);
        }

        // Fetch alltime count and update storage/UI
        chrome.storage.local.get({ alltimeCleared: 0 }, (data) => {
            const alltimeTotal = (data.alltimeCleared || 0) + (stats.cleared || 0);
            const now = Date.now();

            // Save stats first
            chrome.storage.local.set({
                lastRunStats: stats,
                alltimeCleared: alltimeTotal,
                showingPostClear: true,
                postClearTimestamp: now,
                runningMode: null
            });

            // Update UI using the unified function
            showInlineCompleted(stats, message.message, alltimeTotal);
        });
    } else if (message.action === 'GET_STATUS_RESPONSE') {
        isOperationRunning = message.isRunning;
        operationStatus = message.status || 'idle';

        if (isOperationRunning) {
            showView('progress');
            updateFooterStatus();

            // Restore UI state based on status
            if (operationStatus === 'scrolling') {
                if (els.stepScroll) els.stepScroll.classList.add('active');
                if (els.stepWithdraw) els.stepWithdraw.classList.remove('active');
                if (els.scrollStatus) els.scrollStatus.textContent = message.text || 'Scanning...';
                if (els.scrollProgressFill) els.scrollProgressFill.style.width = (message.progress || 0) + '%';
            } else if (operationStatus === 'withdrawing') {
                if (els.stepScroll) {
                    els.stepScroll.classList.remove('active');
                    els.stepScroll.classList.add('completed');
                }
                if (els.stepWithdraw) els.stepWithdraw.classList.add('active');
                if (els.statusText) els.statusText.textContent = message.text || 'Withdrawing...';
                if (els.progressFill) els.progressFill.style.width = (message.progress || 0) + '%';
            }
        } else {
            // If idle, maybe we just opened popup? 
            // Do nothing, let init() show main view
        }
    }
}

function showMessageModeCompleted(stats, completionMessage) {
    // 1. Force hide global controls
    if (els.stopBtn) els.stopBtn.style.display = 'none';
    if (els.pauseBtn) els.pauseBtn.style.display = 'none';

    // 2. Hide Count/Age specific elements
    const inlineContinue = document.getElementById('inline-continue');
    if (inlineContinue) inlineContinue.style.display = 'none';

    // 3. Update Message Mode specific progress elements
    let stateType = 'success';
    if (completionMessage) {
        const msg = completionMessage.toLowerCase();
        if (msg.includes('safety') || msg.includes('too recent')) stateType = 'warning';
        else if (msg.includes('no connection') || msg.includes('limit reached')) stateType = 'caution';
        else if (msg.includes('error') || msg.includes('failed')) stateType = 'error';
    }

    // Update status text
    if (els.msgWithdrawStatus) {
        els.msgWithdrawStatus.textContent = completionMessage || 'Complete!';
        els.msgWithdrawStatus.className = 'status-text ' + (stateType === 'success' ? 'success-text' : stateType + '-text');
    }

    let colorVar = 'var(--success)';
    if (stateType === 'error') {
        colorVar = 'var(--danger)';
    } else if (stateType === 'warning') {
        colorVar = 'var(--warning)';
    }

    if (els.msgWithdrawFill) els.msgWithdrawFill.style.backgroundColor = colorVar;

    const msgStepContainer = document.getElementById('msg-step-withdraw');
    if (msgStepContainer) msgStepContainer.style.borderColor = colorVar;

    const msgStatusText = document.getElementById('msg-withdraw-status');
    if (msgStatusText) msgStatusText.style.color = colorVar;

    // 4. Show Inline Stats (Shared component, but we ensure it's visible)
    const inlineStats = document.getElementById('inline-stats');
    if (inlineStats) {
        // Populate stats
        const remaining = stats.remaining || 0;
        const capacity = Math.max(0, 1200 - remaining);
        const healthPct = Math.min(100, (remaining / 1200) * 100);

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

        inlineStats.style.display = 'block';
        inlineStats.classList.add('fade-in-up');
    }

    // 5. Render Message Mode Actions (Back / Done)
    // Clean up first
    const existingContainer = document.getElementById('message-mode-actions');
    if (existingContainer) existingContainer.remove();

    const actionContainer = document.createElement('div');
    actionContainer.id = 'message-mode-actions';
    actionContainer.style.marginTop = '16px';
    actionContainer.style.display = 'flex';
    actionContainer.style.gap = '8px';
    actionContainer.className = 'fade-in-up';
    actionContainer.innerHTML = `
        <button id="back-to-scan-btn" class="secondary-btn" style="flex: 1;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px;">
                <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
            Back to Scan Results
        </button>
        <button id="msg-done-btn" class="primary-btn" style="flex: 1;">
            Done
        </button>
    `;

    // Append after inline stats
    if (inlineStats && inlineStats.parentNode) {
        inlineStats.parentNode.insertBefore(actionContainer, inlineStats.nextSibling);
    }

    // Add handlers
    const backBtn = document.getElementById('back-to-scan-btn');
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            // CLEANUP: Aggressively remove message mode UI before switching views
            clearMessageModeUI();

            // Show scan results with remaining groups (withdrawn ones filtered out)
            renderScanResults(foundScanResults);
            showView('scanResults');
        });
    }

    const doneBtn = document.getElementById('msg-done-btn');
    if (doneBtn) {
        doneBtn.addEventListener('click', async () => {
            // CLEANUP: Aggressively remove message mode UI before going home
            clearMessageModeUI();

            chrome.storage.local.set({ showingPostClear: false, postClearTimestamp: 0 });
            await goHome();
        });
    }

    // 6. Persistence
    chrome.storage.local.set({ showingPostClear: true, postClearTimestamp: Date.now() });
}

function showInlineCompleted(stats, completionMessage, alltimeCount) {
    // Determine mode early regarding of global state
    const effectiveMode = (stats && stats.mode) ? stats.mode : currentMode;

    if (effectiveMode === 'message') {
        showMessageModeCompleted(stats, completionMessage);
        return;
    }

    // Hide stop and pause buttons
    if (els.stopBtn) els.stopBtn.style.display = 'none';
    if (els.pauseBtn) els.pauseBtn.style.display = 'none';

    // Clean up any old message mode action buttons to prevent duplication
    const existingActions = document.getElementById('message-mode-actions');
    if (existingActions) existingActions.remove();

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

        // Determine effective mode - utilize stats.mode if available, fallback to currentMode
        // This is already handled by the early return for 'message' mode.
        // So this block is for count/age modes.

        // Show continue section (different based on mode)
        const inlineContinue = document.getElementById('inline-continue');

        // Force hide stop/pause again just in case
        if (els.stopBtn) els.stopBtn.style.display = 'none';
        if (els.pauseBtn) els.pauseBtn.style.display = 'none';

        /* Message mode handled by showMessageModeCompleted */
        // For count/age modes, show standard continue options
        if (inlineContinue) {
            inlineContinue.style.display = 'block';
            inlineContinue.classList.add('fade-in-up');
        }

        // Ensure message mode buttons are also removed if we are in count mode
        const existingContainer = document.getElementById('message-mode-actions');
        if (existingContainer) existingContainer.remove();

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

    showCompleted(false); // false = don't show continue options when viewing stats
}

// ============ HISTORY ============

async function showHistoryView() {
    showView('history');
    const container = document.getElementById('history-sessions');
    if (!container) return;

    container.innerHTML = '<p class="status-text">Loading history...</p>';

    try {
        const result = await chrome.storage.local.get(['withdrawalHistory']);
        const history = result.withdrawalHistory || [];

        if (history.length === 0) {
            document.getElementById('empty-history').style.display = 'block';
            container.innerHTML = '';
        } else {
            document.getElementById('empty-history').style.display = 'none';
            container.innerHTML = renderHistory(history);

            // Add click handlers for session expansion
            const headers = container.querySelectorAll('.session-header');
            headers.forEach(header => {
                header.addEventListener('click', () => {
                    const items = header.nextElementSibling;
                    const isHidden = items.style.display === 'none';
                    items.style.display = isHidden ? 'block' : 'none';
                    // Rotate chevron if we add one, for now just toggle
                });
            });
        }
    } catch (e) {
        console.error('Failed to load history', e);
        container.innerHTML = '<p class="status-text error">Failed to load history.</p>';
    }
}

function renderHistory(history) {
    // Sort by session date descending (assuming stored chronologically, so reverse)
    const sorted = [...history].reverse();

    return sorted.map(session => {
        const count = session.withdrawals.length;
        // Default collapse: expand only the most recent session
        const isRecent = session === sorted[0];
        const displayStyle = isRecent ? 'block' : 'none';

        const itemsHtml = session.withdrawals.map(w => {
            const time = new Date(w.withdrawnAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const nameHtml = w.profileUrl
                ? `<a href="${w.profileUrl}" target="_blank" title="View Profile">${w.name}</a>`
                : w.name;

            return `
                <div class="session-item">
                    <div class="session-item-info">
                        <span class="session-item-name">
                            ${nameHtml} <span class="session-item-age">(${w.age || 'Unknown age'})</span>
                        </span>
                    </div>
                    <span class="session-item-time">${time}</span>
                </div>
            `;
        }).join('');

        return `
            <div class="history-session">
                <div class="session-header" title="Click to toggle">
                    <span class="session-date">${session.sessionDate}</span>
                    <span class="session-count">${count} withdrawn</span>
                </div>
                <div class="session-items" style="display: ${displayStyle};">
                    ${itemsHtml}
                </div>
            </div>
        `;
    }).join('');
}

// ============ MATCHES LIST TOGGLE ============

function toggleMatchesList() {
    const section = document.getElementById('matches-list-section');
    if (!section) return;

    const isCollapsed = section.classList.contains('collapsed');

    if (isCollapsed) {
        section.classList.remove('collapsed');
        chrome.storage.local.set({ matchesCollapsed: false });
    } else {
        section.classList.add('collapsed');
        chrome.storage.local.set({ matchesCollapsed: true });
    }
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
        debugMode: els.debugModeToggle?.checked === true,
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
    // Aggressive cleanup when going home
    clearMessageModeUI();

    // Clear persisted results when explicitly going home
    await chrome.storage.local.remove('savedScanResults');

    const pageOk = await checkPage();
    if (!pageOk) return;

    // Active Check: Ping content script with timeout
    try {
        const response = await Promise.race([
            new Promise((resolve) => {
                chrome.tabs.sendMessage(activeTabId, { action: 'GET_STATUS' }, (res) => {
                    if (chrome.runtime.lastError) resolve(null);
                    else resolve(res);
                });
            }),
            new Promise(resolve => setTimeout(() => resolve(null), 1000))
        ]);

        if (response && response.isRunning) {
            isOperationRunning = true;
            operationStatus = response.status;
            // Merge stats
            if (response.stats) {
                stats = { ...stats, ...response.stats };
            }
        } else {
            // Not running
            // Explicitly reset status to ensure footer goes back to default
            isOperationRunning = false;
            operationStatus = '';
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

function resetProgressView() {
    // Clear any pending hide animation
    if (typeof hideScrollTimeout !== 'undefined' && hideScrollTimeout) {
        clearTimeout(hideScrollTimeout);
        hideScrollTimeout = null;
    }

    if (els.stepScroll) {
        els.stepScroll.classList.add('active');
        els.stepScroll.classList.remove('completed', 'stopped', 'fade-out');
        els.stepScroll.style.display = 'block';
        els.stepScroll.style.opacity = '1';
        els.stepScroll.style.transform = 'none';
        els.stepScroll.style.transition = '';
    }
    if (els.stepScrollCheck) els.stepScrollCheck.style.display = 'none';
    if (els.stepScrollNum) els.stepScrollNum.style.display = 'flex';
    if (els.scrollProgressFill) els.scrollProgressFill.style.width = '0%';
    if (els.scrollStatus) els.scrollStatus.textContent = 'Starting...';
    if (els.stepScrollLabel) els.stepScrollLabel.classList.add('wave-text');

    if (els.stepWithdraw) {
        els.stepWithdraw.classList.remove('active', 'completed', 'stopped', 'error', 'warning');
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
        safeMode: settings.safeMode,
        debugMode: settings.debugMode === true
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
        safeMode: settings.safeMode,
        debugMode: settings.debugMode === true
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

function clearMessageModeUI() {
    // 1. Remove action buttons
    const existingActions = document.getElementById('message-mode-actions');
    if (existingActions) existingActions.remove();

    // 2. Reset inline stats visibility
    const inlineStats = document.getElementById('inline-stats');
    if (inlineStats) {
        inlineStats.style.display = 'none';
        inlineStats.classList.remove('fade-in-up');
    }

    // 3. Reset explicit overrides
    if (els.stopBtn) els.stopBtn.style.display = ''; // Reset to default (css ruled)
    if (els.pauseBtn) els.pauseBtn.style.display = '';

    // 4. Reset Message Mode styling (remove warning colors)
    const msgStepContainer = document.getElementById('msg-step-withdraw');
    if (msgStepContainer) msgStepContainer.style.borderColor = ''; // Reset to default

    const msgStatusText = document.getElementById('msg-withdraw-status');
    if (msgStatusText) msgStatusText.style.color = ''; // Reset to default

    if (els.msgWithdrawFill) els.msgWithdrawFill.style.backgroundColor = ''; // Reset to default

    // 5. Ensure standard "continue" section is hidden until explicitly shown
    const inlineContinue = document.getElementById('inline-continue');
    if (inlineContinue) inlineContinue.style.display = 'none';
}

function resetProgressView() {
    // Always start with a clean slate regarding message mode artifacts
    clearMessageModeUI();
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
