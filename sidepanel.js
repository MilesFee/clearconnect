// ClearConnect Side Panel
// Handles active state views: progress (scanning/withdrawing), scan results, completion
// Communicates with content.js via chrome.runtime and reads state from chrome.storage

// XSS prevention
function escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const DEFAULTS = {
    safeThreshold: 1, safeUnit: 'month', withdrawCount: 10, ageValue: 3,
    ageUnit: 'month', currentMode: 'count', safeMode: true, debugMode: false,
    theme: 'light'
};

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

let activeTabId = null;
let localSettings = { ...DEFAULTS };
let selectedScanHashes = new Set();
let foundScanResults = [];

// NEW: Global Render Lock to prevent storage listener loops
let isAutoSaving = { current: false };

/**
 * Robustly saves state to storage by merging with current storage and defaults
 * @param {Object} updates - Recursive updates to apply to the state
 */
async function safeSaveState(updates = {}) {
    try {
        // Suppress storage listener re-renders
        isAutoSaving.current = true;

        // 1. Fetch latest state
        const data = await chrome.storage.local.get('extension_state');
        let state = data.extension_state || { ...DEFAULT_STATE };

        // 2. Deep Merge Stats/Settings to ensure no property loss
        const mergeDeep = (target, source) => {
            for (const key in source) {
                if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                    if (!target[key]) target[key] = {};
                    mergeDeep(target[key], source[key]);
                } else {
                    target[key] = source[key];
                }
            }
        };

        // Apply fallback defaults for missing root keys
        for (const key in DEFAULT_STATE) {
            if (state[key] === undefined) {
                state[key] = JSON.parse(JSON.stringify(DEFAULT_STATE[key]));
            }
        }

        // Apply provided updates
        mergeDeep(state, updates);

        // 3. Persist
        await chrome.storage.local.set({ extension_state: state });

        // 4. Release lock after a delay
        setTimeout(() => {
            isAutoSaving.current = false;
        }, 200);

        return state;
    } catch (e) {
        Logger.error('ClearConnect Side Panel: Safe save failed', e);
        isAutoSaving.current = false;
        throw e;
    }
}

// ============ TOPIC EXTRACTION ============
function extractTopicFromMessage(msg) {
    if (!msg) return null;

    // Remove greetings for topic extraction pass
    // Hyphens (-) are allowed in names (e.g. Ching-Wen)
    const cleanMsg = msg.replace(/^(?:Hi|Hello|Hey|Dear|Good morning|Good afternoon|Good evening|Reaching out about)\s+[^,:\!\-\u2013\u2014]{1,40}?[,:\!\-\u2013\u2014]\s*/i, '').trim();


    const patterns = [
        // Marker-based extraction (The user's failure cases)
        // High priority: survey/phone call on [Topic] -> captures topic before later markers like "working with"
        /(?:survey call on|phone call on|consulting call on|consulting opportunity (?:offering|for)|paid consultation call on|paid hour-long (?:consulting|survey) call on)\s+([A-Z][^.!?\"'\n]{3,80})/i,

        /(?:on behalf of a client about a|reaching out about a|reaching out about an)\s+(?:paid hour-long consulting call on|hour-long survey call on)\s+([A-Z][^.!?\"'\n]{3,80})/i,

        /(?:familiar with|experts in|speak to|use of|experts (?:that|who) can speak to)\s+(?:the\s+)?([A-Z][^.!?\"'\n]{3,80})/i,

        // Context markers (Interest/About) - moved up to avoid "working with a consulting client" false positives
        /(?:interested in|about|regarding|re:)\s+["']?([A-Z][^.!?\"'\n]{5,80})/i,

        /(?:evaluating and working with|experience evaluating and working with|experience working with and evaluating|working with|your experience with|your experience with evaluating and working with)\s+([A-Z][^.!?\"'\n]{3,80})/i,

        /(?:survey call on|phone call on|consulting opportunity (?:offering|for)).*?(?:working with|speak to|evaluating and working with)\s+([A-Z][^.!?\"'\n]{3,80})/i,


        // Classic patterns
        /(?:position|role|opportunity|project|job)\s*(?:at|for|with)?\s+["']?([A-Z][^.!?\"'\n]{3,60})/i,
        /(?:reaching out|connect).*?(?:about|regarding)\s+([A-Z][^.!?\"'\n]{5,70})/i,
    ];

    for (const pat of patterns) {
        const m = cleanMsg.match(pat);
        if (m) {
            let topic = m[1].trim();
            // Post-process to remove trailing noise (like "like...", "from...")
            // Softened 'for' to only strip 'for experts', 'for our', etc. instead of any 'for'
            topic = topic.replace(/\s+(?:like|from|providers like|solutions like|etc|for\s+(?:experts|our|your|the))\b.*$/i, '').trim();
            // Remove leading filler (iterative)
            let oldTopic;
            do {
                oldTopic = topic;
                topic = topic.replace(/^(?:the|using|a|an|use of|the use of|learning more about|understanding the|understanding|learning|solutions for|solutions regarding|solutions|platforms like|providers like|working with|experts that can speak to|your experience evaluating and working with|your experience with evaluating and working with|your experience with|your experience in the)\s+/i, '').trim();
            } while (topic !== oldTopic);





            if (topic.length > 3) return topic;
        }
    }

    // Advanced Fallback: Identify the most likely "Topic" sentence
    // Skip sentences that start with personal intros
    const sentences = cleanMsg.split(/[.!?]\s+/);
    for (const s of sentences) {
        const trimmed = s.trim();
        if (trimmed.length > 20 &&
            !trimmed.match(/^(?:I'm|My name is|I am|Do you have|Would you|Let me know|Hi|Hello)/i)) {
            // Cut it at 60 chars for a clean title
            return trimmed.substring(0, 60) + (trimmed.length > 60 ? '...' : '');
        }
    }

    return null;
}


// ============ THEME & SETTINGS LISTENER ============
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        const needsReRender = ['safeMode', 'safeThreshold', 'safeUnit', 'theme', 'extension_state'].some(key => key in changes);

        if (changes.theme) {
            localSettings.theme = changes.theme.newValue;
            document.documentElement.setAttribute('data-theme', changes.theme.newValue);
        }

        // Sync localSettings from extension_state.settings when it changes
        if (changes.extension_state?.newValue?.settings) {
            localSettings = { ...DEFAULTS, ...changes.extension_state.newValue.settings };
        }

        // Trigger re-render if any core UI state or safety settings changed
        if (needsReRender) {
            chrome.storage.local.get('extension_state').then(({ extension_state }) => {
                if (extension_state) renderUI(extension_state);
            });
        }
    }
});

// ============ SAFE MODE NOTICE ============
function getSafeNoticeHTML(state) {
    const settings = state?.settings || localSettings;
    const safeMode = settings.safeMode !== false;
    const safeThreshold = settings.safeThreshold || 1;
    const safeUnit = settings.safeUnit || 'month';

    if (!safeMode) return '';

    return `
        <div id="safe-badge" class="safe-notice" style="margin-bottom: 16px;">
            Preserves connections sent within the last 
            <strong>${safeThreshold} ${safeUnit}${safeThreshold > 1 ? 's' : ''}</strong>
        </div>
    `;
}

// ============ FOOTER STATUS ============
function getFooterStatusHTML(state) {
    if (!state) return '';
    const result = state.lastRunResult;
    if (!result) return '';
    const stopType = result.stopType || 'success';
    if (stopType === 'success') {
        return `<div class="footer-status success"><span>&#10003;</span> ${escapeHTML(result.message || 'Done')}</div>`;
    } else if (stopType === 'safety') {
        return `<div class="footer-status warning"><span>&#9888;</span> ${escapeHTML(result.message || 'Safety stop')}</div>`;
    } else if (stopType === 'manual') {
        return `<div class="footer-status error"><span>&#10006;</span> ${escapeHTML(result.message || 'Stopped')}</div>`;
    }
    return '';
}

// ============ PROGRESS HTML ============
function getProgressHTML(state) {
    const mode = state?.currentMode || 'count';
    const subMode = state?.subMode || 'scanning';
    const isPaused = state?.isPaused || false;
    const progress = state?.status?.progress || 0;
    const statusText = state?.status?.text || 'Starting...';

    const isMessageMode = mode === 'message';
    const isScanning = subMode === 'scanning';
    const isWithdrawing = subMode === 'withdrawing';

    // ---- PEOPLE QUEUE (Live Withdrawal Queue) ----
    const foundPeople = state?.foundMatchingPeople || [];
    const peopleListItems = foundPeople.map(person => {
        const statusClass = person.status === 'completed' ? 'cleared' : (person.status === 'active' ? 'active' : 'pending');
        return `<li class="person-item ${statusClass}" data-name="${escapeHTML(person.name)}">
            <span class="person-name">${escapeHTML(person.name)}</span>
            <span class="person-age">${person.age || ''}</span>
            ${person.status === 'completed' ? '<span class="person-check">&#10003;</span>' : ''}
        </li>`;
    }).join('');

    const peopleListContainerHTML = `
        <div id="people-list-container" class="people-list ${foundPeople.length > 0 ? 'visible' : 'hidden'}">
            <h4 class="list-title">Connections to Clear</h4>
            <ul class="people-list-items">${peopleListItems}</ul>
        </div>
    `;

    // ---- STANDARD LAYOUT (Count / Age) -- two-step: scroll + withdraw ----
    const standardLayoutHTML = `
        <div id="progress-layout-standard">
            <div id="step-scroll" class="progress-step ${isScanning ? 'active' : 'completed'}">
                <div class="step-header">
                    <span id="step-scroll-icon">${isWithdrawing ? '<svg class="step-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>' : '<span class="step-num">1</span>'}</span>
                    <span class="step-label ${isScanning ? 'wave-text' : ''}">Discovery Progress</span>
                </div>
                <div class="step-content">
                    <div class="progress-bar-bg"><div id="scroll-progress-fill" class="progress-bar-fill" style="width: ${isScanning ? progress : 100}%"></div></div>
                    <p id="scroll-status" class="status-text">${isScanning ? statusText : 'Complete'}</p>
                </div>
            </div>
            <div id="step-withdraw" class="progress-step ${isWithdrawing ? 'active' : ''}">
                <div class="step-header"><span class="step-num">2</span><span class="step-label">Withdrawal Progress</span></div>
                <div class="step-content">
                    <div class="progress-bar-bg"><div id="progress-fill" class="progress-bar-fill" style="width: ${isWithdrawing ? progress : 0}%"></div></div>
                    <p id="status-text" class="status-text">${isWithdrawing ? statusText : 'Waiting to load all connections'}</p>
                </div>
            </div>
            ${peopleListContainerHTML}
        </div>
    `;

    // ---- MESSAGE MODE: Stage 1 (Scanning) -- scan bar + live group results ----
    const messageScanHTML = `
        <div id="progress-layout-message">
            <div id="msg-step-scan" class="progress-step active">
                <div class="step-header"><span class="step-num">1</span><span class="step-label wave-text">Scanning...</span></div>
                <div class="step-content">
                    <div class="progress-bar-bg"><div id="msg-scan-fill" class="progress-bar-fill" style="width: ${progress}%"></div></div>
                    <p id="msg-scan-status" class="status-text">${statusText}</p>
                </div>
            </div>
            <div id="live-scan-results" class="live-scan-results"></div>
        </div>
    `;

    // ---- MESSAGE MODE: Stage 3 (Withdrawing) -- withdraw bar + people queue ----
    const messageWithdrawHTML = `
        <div id="progress-layout-message">
            <div id="msg-step-withdraw" class="progress-step active">
                <div class="step-header">
                    <span class="step-num">1</span>
                    <span class="step-label">Withdrawing...</span>
                </div>
                <div class="step-content">
                    <div class="progress-bar-bg"><div id="msg-withdraw-fill" class="progress-bar-fill" style="width: ${progress}%"></div></div>
                    <p id="msg-withdraw-status" class="status-text">${statusText}</p>
                </div>
            </div>
            ${peopleListContainerHTML}
        </div>
    `;

    // Choose layout
    let layoutHTML;
    if (isMessageMode) {
        layoutHTML = isWithdrawing ? messageWithdrawHTML : messageScanHTML;
    } else {
        layoutHTML = standardLayoutHTML;
    }

    return `
        <div class="view">
            ${getSafeNoticeHTML(state)}
            <h2 id="active-operation-title" class="section-title">${isScanning ? 'Scanning connections...' : 'Clearing connections...'}</h2>
            ${layoutHTML}
            <div id="progress-actions" class="progress-actions" style="display: flex; gap: 8px; margin-top: 12px;">
                <button data-action="toggle-pause" class="secondary-btn" style="flex: 1; ${isWithdrawing ? '' : 'display:none;'}"><span class="btn-text">${isPaused ? 'Resume' : 'Pause'}</span></button>
                <button data-action="stop-operation" class="secondary-btn" style="flex: 1;"><span class="btn-text">Stop</span></button>
            </div>
        </div>
    `;
}

// ============ SCAN RESULTS HTML ============
function getScanResultsHTML() {
    return `
        <div class="view">
            ${getSafeNoticeHTML()}
            <h2 class="section-title">Scan Results</h2>
            <p class="scan-desc">Select message groups to withdraw.</p>
            <div id="scan-results-list" class="scan-results-list"></div>
            <div id="empty-scan" class="empty-scan" style="display:none;">No message groups found.</div>
            <div class="scan-actions">
                <button data-action="withdraw-selected" id="withdraw-selected-btn" class="primary-btn" disabled>Withdraw Selected (<span id="selected-count">0</span>)</button>
                <button data-action="cancel-scan" class="secondary-btn">Cancel</button>
            </div>
        </div>
    `;
}

function renderScanResults(results) {
    const list = document.getElementById('scan-results-list');
    const empty = document.getElementById('empty-scan');
    const withdrawBtn = document.getElementById('withdraw-selected-btn');

    if (!list) return;
    list.innerHTML = '';

    if (!results || results.length === 0) {
        if (empty) empty.style.display = 'block';
        if (withdrawBtn) withdrawBtn.disabled = true;
        Logger.log('ClearConnect: renderScanResults called with empty results', results);
        return;
    }
    if (empty) empty.style.display = 'none';
    Logger.log('ClearConnect: renderScanResults rendering', results.length, 'items');

    results.forEach((item, idx) => {
        try {
            const topic = extractTopicFromMessage(item.message) ||
                `"${escapeHTML(item.message.substring(0, 40))}${item.message.length > 40 ? '...' : ''}"`;
            const shortMsg = escapeHTML(item.message.substring(0, 60) + (item.message.length > 60 ? '...' : ''));
            const ageRange = item.ages && item.ages.length > 0
                ? (item.ages.length > 1 ? `${item.ages[item.ages.length - 1]} - ${item.ages[0]}` : item.ages[0])
                : 'Unknown';
            const fullMsg = item.fullMessage || item.message;

            const div = document.createElement('div');
            div.className = 'scan-result-item';
            div.title = fullMsg;

            const peopleListHtml = (item.people || []).map(p =>
                `<div class="person-row">
                    <span class="person-name" data-id="${escapeHTML(p.id)}" style="cursor:pointer;text-decoration:underline;">${escapeHTML(p.name)}</span>
                    <span class="person-age">${escapeHTML(p.age)}</span>
                </div>`
            ).join('');

            div.innerHTML = `
                <div class="scan-result-header">
                    <div class="scan-checkbox-wrapper">
                        <input type="checkbox" class="scan-checkbox" data-hash="${escapeHTML(item.id)}">
                    </div>
                    <div class="scan-info" title="Click to expand/collapse">
                        <div class="scan-topic">${topic}</div>
                        <div class="scan-preview">${shortMsg}</div>
                    </div>
                    <div class="scan-meta">
                        <span class="scan-count-badge">${item.count}</span>
                    </div>
                </div>
                <div class="scan-details" style="display:none;">
                    <div class="scan-detail-row"><strong>Age Range:</strong> ${escapeHTML(ageRange)}</div>
                    <div class="scan-full-message">${escapeHTML(fullMsg)}</div>
                    <div class="scan-people-section">
                        <div class="people-toggle" style="margin-top:8px;cursor:pointer;color:var(--brand-primary);font-size:12px;font-weight:600;">
                            Show ${item.people ? item.people.length : 0} People
                        </div>
                        <div class="people-list" style="display:none;margin-top:8px;border-top:1px solid var(--border-default);padding-top:4px;">
                            ${peopleListHtml}
                        </div>
                    </div>
                </div>
            `;

            // Checkbox handler
            const checkbox = div.querySelector('.scan-checkbox');
            checkbox.addEventListener('change', (e) => {
                if (e.target.checked) selectedScanHashes.add(item.id);
                else selectedScanHashes.delete(item.id);
                updateWithdrawButton();
            });

            // Expand/collapse group details
            div.querySelector('.scan-info').addEventListener('click', () => {
                const details = div.querySelector('.scan-details');
                details.style.display = details.style.display === 'none' ? 'block' : 'none';
            });

            // People toggle
            const peopleToggle = div.querySelector('.people-toggle');
            const peopleList = div.querySelector('.people-list');
            if (peopleToggle && peopleList) {
                peopleToggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const hidden = peopleList.style.display === 'none';
                    peopleList.style.display = hidden ? 'block' : 'none';
                    peopleToggle.textContent = hidden ? 'Hide People' : `Show ${item.people ? item.people.length : 0} People`;
                });
            }

            // Person name click -> show on page
            div.querySelectorAll('.person-name').forEach(link => {
                link.addEventListener('click', (e) => {
                    const pid = e.target.getAttribute('data-id');
                    if (activeTabId && pid) {
                        chrome.tabs.sendMessage(activeTabId, { action: 'SHOW_CONNECTION', hash: pid });
                    }
                });
            });

            list.appendChild(div);
        } catch (err) {
            Logger.warn('ClearConnect: Failed to render scan result item', idx, item, err);
        }
    });

    updateWithdrawButton();
}

function updateWithdrawButton() {
    const btn = document.getElementById('withdraw-selected-btn');
    const countSpan = document.getElementById('selected-count');
    if (btn) btn.disabled = selectedScanHashes.size === 0;
    if (countSpan) countSpan.textContent = selectedScanHashes.size;
}

// ============ COMPLETED HTML ============
function getCompletedHTML(state) {
    const processed = state?.stats?.processed || 0;
    const pendingInvitations = state?.stats?.pendingInvitations || 0;
    const currentConnections = pendingInvitations !== null ? pendingInvitations : '-';

    const lastRunResult = state?.lastRunResult || {};
    const stopType = lastRunResult.stopType || 'success';
    const message = lastRunResult.message || '';

    const capacityLimit = 1250;
    // If pendingInvitations is null (not fetched yet), treat as 0 for bar visualization but show '-' in text
    const capacityUsed = typeof currentConnections === 'number' ? currentConnections : 0;
    const capacityLeft = Math.max(0, capacityLimit - capacityUsed);
    const capacityPercent = Math.min(100, Math.round((capacityUsed / capacityLimit) * 100));

    let healthColor = 'green';
    if (capacityPercent > 90) healthColor = 'red';
    else if (capacityPercent > 75) healthColor = 'orange';

    const foundPeople = state?.foundMatchingPeople || [];
    const clearedPeople = state.sessionCleared || foundPeople.slice(0, processed);

    let ageDisplay = "";
    if (clearedPeople.length > 0) {
        const ages = clearedPeople.map(p => p.age || '').filter(a => a);
        if (ages.length > 0) {
            const first = ages[0];
            const last = ages[ages.length - 1];
            // If they are the same (e.g. 1 item or all same age), just show one
            ageDisplay = first === last ? first : `${first} - ${last}`;
        }
    }

    let statusIcon = '&#10003;', statusTitle = 'Session Complete', statusClass = 'success';
    let statusMsg = `Successfully cleared ${clearedPeople.length} connections.`;

    if (stopType === 'safety') {
        statusTitle = 'Safety Stop'; statusIcon = '&#9888;'; statusClass = 'warning';
        statusMsg = message || `Safety stop. ${clearedPeople.length} cleared.`;
    } else if (stopType === 'partial') {
        statusTitle = 'Task Failed Successfully';
        statusClass = 'info';
        statusMsg = message || `No connections matched your criteria.`;
        statusIcon = `
            <div style="font-family: 'Segoe UI', Tahoma, sans-serif; font-size: 32px; font-weight: bold; line-height: 1; user-select: none; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; margin-left: 1px; margin-top: -1px;">
                :(
            </div>
        `;
    } else if (stopType === 'manual') {
        statusTitle = 'Stopped'; statusIcon = '&#10006;'; statusClass = 'error';
        statusMsg = `Stopped by user. Cleared ${clearedPeople.length}.`;
    } else if (stopType === 'error') {
        statusTitle = 'Error'; statusIcon = '&#9888;'; statusClass = 'error';
        statusMsg = message;
    }

    const clearedListItems = clearedPeople.map(person => `
        <div class="history-entry">
            <span class="history-link">${escapeHTML(person.name)}</span>
            <span class="history-age">${person.age || '-'}</span>
        </div>
    `).join('') || '<div class="empty-history">No connections cleared.</div>';

    // Aggregate cleared groups
    const clearedGroups = {};
    clearedPeople.forEach(p => {
        if (p.message) {
            const topic = extractTopicFromMessage(p.message);
            if (topic) {
                clearedGroups[topic] = (clearedGroups[topic] || 0) + 1;
            }
        }
    });

    const groupsListHTML = Object.entries(clearedGroups)
        .sort((a, b) => b[1] - a[1]) // Sort by count desc
        .map(([topic, count]) => `
            <div class="cleared-group-item">
                <span class="group-topic" title="${escapeHTML(topic)}">${escapeHTML(topic)}</span>
                <span class="group-count">${count}</span>
            </div>
        `).join('') || '<div class="empty-groups">No group data available</div>';

    return `
        <div id="completed-view" class="view">
            ${getSafeNoticeHTML(state)}
            <!-- Summary Card -->
            <div class="summary-card" style="background:var(--bg-card); border:1px solid var(--border-default); border-radius:12px; padding:20px; text-align:center; margin-bottom:20px; box-shadow:var(--shadow-sm);">
                <div class="summary-icon ${statusClass}" style="width:48px; height:48px; border-radius:50%; background:var(--${statusClass === 'success' ? 'success' : statusClass === 'warning' ? 'warning' : statusClass === 'info' ? 'info' : 'danger'}-bg); color:var(--${statusClass === 'success' ? 'success' : statusClass === 'warning' ? 'warning' : statusClass === 'info' ? 'info' : 'danger'}); display:flex; align-items:center; justify-content:center; font-size:24px; margin:0 auto 12px auto;">
                    ${statusIcon}
                </div>
                <h2 style="margin:0 0 8px 0; font-size:18px; color:var(--text-primary);">${statusTitle}</h2>
                <p style="margin:0; color:var(--text-secondary); font-size:14px;">${statusMsg}</p>
                
                ${ageDisplay ? `
                <div style="margin-top:12px; font-size:13px; color:var(--text-secondary); background:var(--bg-surface); padding:6px 10px; border-radius:16px; display:inline-block;">
                    Age Range: <strong>${ageDisplay}</strong>
                </div>` : ''}
            </div>

            <!-- CLEARED GROUPS (Message Mode Only) -->
            ${(state.currentMode === 'message' && Object.keys(clearedGroups).length > 0) ? `
            <div class="cleared-groups-section">
                <h3 class="cleared-groups-title">Cleared Groups</h3>
                <div class="cleared-groups-list">
                    ${groupsListHTML}
                </div>
            </div>` : ''}

            <!-- Stats Section (Rows + Capacity Bar) -->
            <div class="stats-section">
                <div class="stat-row">
                    <span>Cleared This Session</span>
                    <strong>${clearedPeople.length}</strong>
                </div>
                <div class="stat-row">
                    <span>Remaining Connections</span>
                    <strong>${currentConnections}</strong>
                </div>

                <div class="health-section">
                    <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                        <label>Connection Capacity</label>
                        <span style="font-size:12px; color:var(--text-secondary);">${capacityUsed} / ~${capacityLimit} used</span>
                    </div>
                    <div class="health-bar-bg"><div class="health-bar-fill ${healthColor}" style="width: ${capacityPercent}%"></div></div>
                    <p style="margin-top:6px; font-size:12px; color:var(--text-secondary);">You have approx. <strong>${capacityLeft}</strong> slots remaining.</p>
                </div>
            </div>

            <!-- History List (Collapsible) -->
            <div class="history-session collapsed">
                <div class="history-session-header" data-action="toggle-session">
                    <div class="session-header-left">
                        <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
                        <span class="session-date">View List</span>
                    </div>
                    <span class="session-count">${clearedPeople.length} items</span>
                </div>
                <div class="history-session-items">${clearedListItems}</div>
            </div>

            <!-- ACTIONS / BUTTONS -->
            <!-- ACTIONS / BUTTONS -->
            <div class="actions" style="margin-top:24px; display:flex; flex-direction:column; gap:12px;">
                ${state.currentMode === 'message' ? `
                    <div id="clear-more-container" style="width:100%;">
                        <button data-action="resume-scan-results" class="primary-btn" style="width:100%;">Select More Groups</button>
                    </div>
                ` : `
                    <div class="continue-section" id="continue-section" style="width:100%;">
                        <div class="continue-label" style="font-size:13px; font-weight:600; color:var(--text-primary); margin-bottom:12px; text-align:left;">Continue Clearing</div>
                        
                        <div class="setting-option" style="margin-bottom:8px;">
                            <label class="checkbox-label">
                                <input type="radio" name="continue-mode" value="count" ${state.currentMode === 'count' ? 'checked' : ''} style="margin-top:3px;">
                                <div class="option-text">
                                    <strong>Clear more</strong>
                                    <div class="threshold-row" style="display:flex; align-items:center; gap:8px; margin-top:8px; border-left:none; padding-left:0;">
                                        <input type="number" id="continue-count" value="${localSettings.withdrawCount || 10}" class="input-sm" style="width:60px;">
                                        <span style="color:var(--text-secondary); font-size:12px;">people</span>
                                    </div>
                                </div>
                            </label>
                        </div>

                        <div class="setting-option">
                            <label class="checkbox-label">
                                <input type="radio" name="continue-mode" value="age" ${state.currentMode === 'age' ? 'checked' : ''} style="margin-top:3px;">
                                <div class="option-text">
                                    <strong>Clear older than</strong>
                                    <div class="threshold-row" style="display:flex; align-items:center; gap:8px; margin-top:8px; border-left:none; padding-left:0;">
                                        <input type="number" id="continue-age-value" value="${localSettings.ageValue || 3}" class="input-sm" style="width:50px;">
                                        <select id="continue-age-unit" class="select-sm">
                                            <option value="day" ${localSettings.ageUnit === 'day' ? 'selected' : ''}>Days</option>
                                            <option value="week" ${localSettings.ageUnit === 'week' ? 'selected' : ''}>Weeks</option>
                                            <option value="month" ${localSettings.ageUnit === 'month' ? 'selected' : ''}>Months</option>
                                            <option value="year" ${localSettings.ageUnit === 'year' ? 'selected' : ''}>Years</option>
                                        </select>
                                        <span style="color:var(--text-secondary); font-size:12px;">ago +</span>
                                    </div>
                                </div>
                            </label>
                        </div>

                        <button data-action="start-continue" class="primary-btn" style="margin-top:16px;">Start Clearing</button>
                    </div>
                `}
                <button data-action="done" class="secondary-btn" style="width:100%;">Return to Home</button>
            </div>
        </div>
    `;
}

// ============ CORE RENDER ============
let lastRenderedTab = null;
let lastRenderedSubMode = null;

function renderUI(state) {
    const content = document.getElementById('sidepanel-content');
    const footerStatus = document.getElementById('footer-status');
    if (!content) return;

    // Apply theme
    document.body.setAttribute('data-theme', localSettings.theme || 'light');

    const isRunning = state.isRunning;
    const currentTab = state.uiNavigation?.currentTab || 'home';
    const subMode = state.subMode;

    // Side panel only shows active states. If idle and not on completion/scanResults, show waiting message.
    if (isRunning) {
        // Running -- show progress. Re-render if subMode changed (scanning -> withdrawing)
        const alreadyRendered = content.querySelector('#progress-layout-standard, #progress-layout-message');
        const subModeChanged = lastRenderedSubMode !== subMode;
        if (!alreadyRendered || subModeChanged) {
            content.innerHTML = getProgressHTML(state);
            lastRenderedSubMode = subMode;
        }
        updateProgress(state);
        lastRenderedTab = 'progress';
    } else if (currentTab === 'scanResults') {
        if (lastRenderedTab !== 'scanResults') {
            content.innerHTML = getScanResultsHTML();
            chrome.storage.local.get('savedScanResults').then(({ savedScanResults }) => {
                if (savedScanResults && savedScanResults.length > 0) foundScanResults = savedScanResults;
                renderScanResults(foundScanResults);
            });
            lastRenderedTab = 'scanResults';
            lastRenderedSubMode = null;
        }
    } else if (currentTab === 'completed') {
        content.innerHTML = getCompletedHTML(state);
        if (footerStatus) footerStatus.innerHTML = ''; // Clear it just in case, or remove this line entirely.
        // I will remove the line entirely as per plan, but since I'm replacing lines 477-479 I'll just omit it.

        lastRenderedTab = 'completed';
        lastRenderedSubMode = null;
    } else {
        // Not in an active state -- show waiting with Open Popup button
        content.innerHTML = `
            <div class="view" style="text-align:center; padding:40px 20px;">
                <p style="color:var(--text-secondary); font-size:14px;">Waiting for operation to start...</p>
                <p style="color:var(--text-disabled); font-size:12px; margin-top:8px;">Start a scan or clearing operation from the popup.</p>
                <button data-action="open-popup" class="secondary-btn" style="margin-top:16px;">Open Popup</button>
            </div>
        `;
        // Revert panel behavior so clicking icon opens popup
        chrome.runtime.sendMessage({ action: 'CLOSE_SIDEPANEL' }).catch(() => { });
        lastRenderedTab = 'idle';
        lastRenderedSubMode = null;
    }
}

// ============ DIFFERENTIAL PROGRESS UPDATES ============
function updateProgress(state) {
    const progress = state?.status?.progress || 0;
    const statusText = state?.status?.text || '';
    const isScanning = state?.subMode === 'scanning';
    const isWithdrawing = state?.subMode === 'withdrawing';

    // Update title
    const title = document.getElementById('active-operation-title');
    if (title) title.textContent = isScanning ? 'Scanning connections...' : 'Clearing connections...';

    // Standard layout - progress bars
    const scrollFill = document.getElementById('scroll-progress-fill');
    const scrollStatus = document.getElementById('scroll-status');
    const progressFill = document.getElementById('progress-fill');
    const statusTextEl = document.getElementById('status-text');

    if (isScanning) {
        if (scrollFill) scrollFill.style.width = `${progress}%`;
        if (scrollStatus) scrollStatus.textContent = statusText;
    } else if (isWithdrawing) {
        if (scrollFill) scrollFill.style.width = '100%';
        if (scrollStatus) scrollStatus.textContent = 'Connections loaded';
        if (progressFill) progressFill.style.width = `${progress}%`;
        if (statusTextEl) statusTextEl.textContent = statusText;
    }

    // Standard layout - step active/completed class switching
    const stepScroll = document.getElementById('step-scroll');
    const stepWithdraw = document.getElementById('step-withdraw');
    if (stepScroll) {
        stepScroll.className = `progress-step ${isScanning ? 'active' : 'completed'}`;
        const icon = document.getElementById('step-scroll-icon');
        if (icon && isWithdrawing) {
            icon.innerHTML = '<svg class="step-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>';
        }
    }
    if (stepWithdraw) {
        stepWithdraw.className = `progress-step ${isWithdrawing ? 'active' : ''}`;
    }

    // Message layout - update whichever elements exist (separate HTML per subMode)
    const msgScanFill = document.getElementById('msg-scan-fill');
    const msgScanStatus = document.getElementById('msg-scan-status');
    const msgWithdrawFill = document.getElementById('msg-withdraw-fill');
    const msgWithdrawStatus = document.getElementById('msg-withdraw-status');

    if (msgScanFill) msgScanFill.style.width = `${progress}%`;
    if (msgScanStatus) msgScanStatus.textContent = statusText;
    if (msgWithdrawFill) msgWithdrawFill.style.width = `${progress}%`;
    if (msgWithdrawStatus) msgWithdrawStatus.textContent = statusText;

    // Show/hide pause button based on subMode
    const pauseBtn = document.querySelector('[data-action="toggle-pause"]');
    if (pauseBtn) {
        pauseBtn.style.display = isWithdrawing ? '' : 'none';
        const btnText = pauseBtn.querySelector('.btn-text');
        if (btnText) btnText.textContent = state?.isPaused ? 'Resume' : 'Pause';
    }

    // Update people list
    updatePeopleList(state);
}

function updatePeopleList(state) {
    const container = document.getElementById('people-list-container');
    if (!container) return;

    const people = state?.foundMatchingPeople || [];

    // Show container when there are people
    if (people.length > 0) {
        container.classList.remove('hidden');
        container.classList.add('visible');
    }

    // Rebuild list items if count mismatches (POPULATE_QUEUE added new people)
    const listEl = container.querySelector('.people-list-items');
    if (!listEl) return;

    const existingItems = listEl.querySelectorAll('.person-item');
    if (existingItems.length !== people.length && people.length > 0) {
        listEl.innerHTML = people.map(person => {
            const statusClass = person.status === 'completed' ? 'cleared' : (person.status === 'active' ? 'active' : 'pending');
            return `<li class="person-item ${statusClass}" data-name="${escapeHTML(person.name)}">
                <span class="person-name">${escapeHTML(person.name)}</span>
                <span class="person-age">${person.age || ''}</span>
                ${person.status === 'completed' ? '<span class="person-check">&#10003;</span>' : ''}
            </li>`;
        }).join('');
    }
}

// Update a specific person's status in the queue by name
function updatePersonStatus(name, newStatus) {
    const container = document.getElementById('people-list-container');
    if (!container) return;

    const items = container.querySelectorAll('.person-item');
    items.forEach(item => {
        const itemName = item.getAttribute('data-name');
        if (itemName === name) {
            item.className = `person-item ${newStatus === 'completed' ? 'cleared' : (newStatus === 'active' ? 'active' : 'pending')}`;
            if (newStatus === 'completed' && !item.querySelector('.person-check')) {
                item.insertAdjacentHTML('beforeend', '<span class="person-check">&#10003;</span>');
            }
            if (newStatus === 'active') {
                item.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    });
}

// ============ SCAN RESULTS RENDERER ============
// Duplicate renderScanResults removed. The functional version is at line 257.


function updateWithdrawButton() {
    const btn = document.getElementById('withdraw-selected-btn');
    const countSpan = document.getElementById('selected-count');
    if (btn) btn.disabled = selectedScanHashes.size === 0;
    if (countSpan) countSpan.textContent = selectedScanHashes.size;
}

// ============ LIVE SCAN RESULTS ============
function updateLiveScanResults(groups) {
    const container = document.getElementById('live-scan-results');
    if (!container || !groups || groups.length === 0) return;

    // Sort by count descending so most common groups show first
    const sorted = [...groups].sort((a, b) => b.count - a.count);

    let html = '<div class="scan-results-list">';

    // Render each group as a scan-result-item card (same as selection list, sans checkbox)
    for (const g of sorted.slice(0, 30)) {
        const topic = extractTopicFromMessage(g.message) ||
            `"${escapeHTML(g.message.substring(0, 40))}${g.message.length > 40 ? '...' : ''}"`;
        const shortMsg = escapeHTML(g.message.substring(0, 60) + (g.message.length > 60 ? '...' : ''));

        html += `
            <div class="scan-result-item" title="${escapeHTML(g.message)}">
                <div class="scan-result-header" style="cursor:default;">
                    <div class="scan-info">
                        <div class="scan-topic">${topic}</div>
                        <div class="scan-preview">${shortMsg}</div>
                    </div>
                    <div class="scan-meta"><span class="scan-count-badge">${g.count}</span></div>
                </div>
            </div>
        `;
    }

    if (sorted.length > 30) {
        html += `<p style="font-size:11px;color:var(--text-disabled);text-align:center;margin-top:4px;">...and ${sorted.length - 30} more groups</p>`;
    }

    html += '</div>';
    container.innerHTML = html;
}

// ============ EVENT DELEGATION ============
function setupEventDelegation() {
    document.addEventListener('click', async (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;

        const action = target.dataset.action;
        if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
        }

        switch (action) {
            case 'toggle-pause':
                if (activeTabId) {
                    const { extension_state } = await chrome.storage.local.get('extension_state');
                    const isPaused = extension_state?.isPaused;
                    chrome.tabs.sendMessage(activeTabId, {
                        action: isPaused ? 'RESUME_WITHDRAW' : 'PAUSE_WITHDRAW'
                    }).catch(() => { });
                }
                break;

            case 'resume-scan-results':
                // Set state to scanResults and re-render safely
                await safeSaveState({ uiNavigation: { currentTab: 'scanResults' } });
                break;

            case 'open-popup':
                // Revert panel behavior and close sidebar
                chrome.runtime.sendMessage({ action: 'CLOSE_SIDEPANEL' }).catch(() => { });
                window.close();
                break;

            case 'stop-operation':
                if (activeTabId) {
                    chrome.tabs.sendMessage(activeTabId, { action: 'STOP_WITHDRAW' }).catch(() => { });
                }
                break;

            case 'withdraw-selected':
                if (!activeTabId || selectedScanHashes.size === 0) break;
                try {
                    // Fetch latest settings from storage before sending to content.js
                    chrome.storage.local.get(['safeMode', 'safeThreshold', 'safeUnit', 'debugMode']).then(async (current) => {
                        await chrome.tabs.sendMessage(activeTabId, {
                            action: 'WITHDRAW_SELECTED',
                            selectedHashes: Array.from(selectedScanHashes),
                            debugMode: current.debugMode === true,
                            safeMode: current.safeMode !== false,
                            safeThreshold: current.safeThreshold || 1,
                            safeUnit: current.safeUnit || 'month'
                        });

                        // Preserve remaining groups for "Clear More" workflow
                        const remainingResults = foundScanResults.filter(item => !selectedScanHashes.has(item.id));
                        foundScanResults = remainingResults;

                        // Only save the scan results, don't spread settings here
                        chrome.storage.local.set({ savedScanResults: remainingResults });
                        selectedScanHashes.clear();
                    });
                } catch (e) {
                    Logger.log('Content script not ready:', e);
                }
                break;

            case 'cancel-scan':
                // Navigate back to home safely
                await safeSaveState({ uiNavigation: { currentTab: 'home' } });
                window.close();
                break;

            case 'done':
                // Reset navigation to home safely
                await safeSaveState({ uiNavigation: { currentTab: 'home' } });
                window.close();
                break;

            case 'toggle-session':
                const session = target.closest('.history-session');
                if (session) {
                    session.classList.toggle('expanded');
                    session.classList.toggle('collapsed');
                }
                break;

            case 'start-continue':
                const container = document.getElementById('continue-section');
                if (!container) return;

                const selectedMode = container.querySelector('input[name="continue-mode"]:checked')?.value;
                if (!selectedMode) return;

                const countInput = document.getElementById('continue-count');
                const ageValueInput = document.getElementById('continue-age-value');
                const ageUnitSelect = document.getElementById('continue-age-unit');

                // Update settings in storage
                // PASSIVE UPDATE: Only update mode and specific run-time inputs.
                // WE NEVER OVERWRITE safeMode, safeThreshold, or safeUnit from the sidebar.
                chrome.storage.local.get(['extension_state']).then(async ({ extension_state }) => {
                    const currentSettings = extension_state?.settings || DEFAULTS;
                    const finalSettings = {
                        ...currentSettings,
                        currentMode: selectedMode,
                        withdrawCount: (selectedMode === 'count' && countInput) ? (parseInt(countInput.value, 10) || 10) : localSettings.withdrawCount,
                        ageValue: (selectedMode === 'age' && ageValueInput) ? (parseInt(ageValueInput.value, 10) || 3) : localSettings.ageValue,
                        ageUnit: (selectedMode === 'age' && ageUnitSelect) ? ageUnitSelect.value : localSettings.ageUnit
                    };

                    // Only update the non-safety keys to storage (flat keys for content.js and state for continuity)
                    const updatePayload = {
                        currentMode: finalSettings.currentMode,
                        withdrawCount: finalSettings.withdrawCount,
                        ageValue: finalSettings.ageValue,
                        ageUnit: finalSettings.ageUnit
                    };
                    await chrome.storage.local.set(updatePayload);
                    localSettings = { ...localSettings, ...finalSettings };

                    // Trigger clearing with absolute freshest settings from extension_state
                    if (activeTabId) {
                        chrome.tabs.sendMessage(activeTabId, {
                            action: 'START_WITHDRAW',
                            mode: selectedMode,
                            count: finalSettings.withdrawCount,
                            ageValue: finalSettings.ageValue,
                            ageUnit: finalSettings.ageUnit,
                            safeMode: finalSettings.safeMode !== false,
                            safeThreshold: finalSettings.safeThreshold || 1,
                            safeUnit: finalSettings.safeUnit || 'month',
                            debugMode: finalSettings.debugMode === true
                        }).catch(err => {
                            Logger.error('Failed to start continue clearing:', err);
                        });
                    }
                });
                break;
        }
    });
}

// ============ MESSAGE LISTENERS ============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'COMPLETE') {
        if (message.state) {
            // Robustly merge complete run result
            safeSaveState(message.state).then(fullState => {
                renderUI(fullState);
            });
        }
    }

    if (message.action === 'SCAN_COMPLETE' && message.results) {
        foundScanResults = message.results;
        selectedScanHashes.clear();
        chrome.storage.local.set({ savedScanResults: foundScanResults });

        // Navigate to scan results safely
        safeSaveState({ uiNavigation: { currentTab: 'scanResults' } }).then(state => {
            renderUI(state);
        });
    }

    // Real-time scroll progress
    if (message.action === 'SCROLL_PROGRESS') {
        const scrollFill = document.getElementById('scroll-progress-fill');
        const scrollStatus = document.getElementById('scroll-status');
        const msgScanFill = document.getElementById('msg-scan-fill');
        const msgScanStatus = document.getElementById('msg-scan-status');

        if (scrollFill) scrollFill.style.width = `${message.progress}%`;
        if (scrollStatus) scrollStatus.textContent = message.text || `Found ${message.found} of ~${message.total}`;
        if (msgScanFill) msgScanFill.style.width = `${message.progress}%`;
        if (msgScanStatus) msgScanStatus.textContent = message.text || `Found ${message.found} of ~${message.total}`;

        // Live scan results for message mode
        if (message.foundMatches && message.foundMatches.length > 0) {
            updateLiveScanResults(message.foundMatches);
        }
    }

    // Real-time status updates (handles both scanning and withdrawing)
    if (message.action === 'UPDATE_STATUS') {
        // Update all relevant progress elements
        const scrollFill = document.getElementById('scroll-progress-fill');
        const scrollStatus = document.getElementById('scroll-status');
        const progressFill = document.getElementById('progress-fill');
        const statusText = document.getElementById('status-text');
        const msgScanFill = document.getElementById('msg-scan-fill');
        const msgScanStatus = document.getElementById('msg-scan-status');
        const msgWithdrawFill = document.getElementById('msg-withdraw-fill');
        const msgWithdrawStatus = document.getElementById('msg-withdraw-status');

        // Check current state to know which elements to update
        chrome.storage.local.get('extension_state', (data) => {
            const state = data.extension_state || DEFAULT_STATE;
            const isScanning = state.subMode === 'scanning';
            const isWithdrawing = state.subMode === 'withdrawing';

            if (isScanning) {
                if (scrollFill) scrollFill.style.width = `${message.progress}%`;
                if (scrollStatus) scrollStatus.textContent = message.text;
                if (msgScanFill) msgScanFill.style.width = `${message.progress}%`;
                if (msgScanStatus) msgScanStatus.textContent = message.text;
            } else if (isWithdrawing) {
                if (progressFill) progressFill.style.width = `${message.progress}%`;
                if (statusText) statusText.textContent = message.text;
                if (msgWithdrawFill) msgWithdrawFill.style.width = `${message.progress}%`;
                if (msgWithdrawStatus) msgWithdrawStatus.textContent = message.text;
            }

            // Update person status in queue by name
            if (message.clearedData) {
                updatePersonStatus(message.clearedData.name, message.clearedData.status);
            }

            // Handle partial results for live scan display
            if (message.partialResults && message.partialResults.length > 0) {
                updateLiveScanResults(message.partialResults);
            }
        });
    }

    // People list updates -- DOM-only, no storage write (content.js owns state)
    if (message.action === 'POPULATE_QUEUE') {
        const container = document.getElementById('people-list-container');
        if (!container) return;
        const listEl = container.querySelector('.people-list-items');
        if (!listEl) return;

        const existingNames = new Set(
            Array.from(listEl.querySelectorAll('.person-item')).map(el => el.getAttribute('data-name'))
        );

        const newItems = (message.targets || []).filter(t => !existingNames.has(t.name));
        if (newItems.length === 0) return;

        const fragment = document.createDocumentFragment();
        newItems.forEach(person => {
            const li = document.createElement('li');
            li.className = 'person-item pending';
            li.setAttribute('data-name', person.name);
            li.innerHTML = `
                <span class="person-name">${escapeHTML(person.name)}</span>
                <span class="person-age">${person.age || ''}</span>
            `;
            fragment.appendChild(li);
        });

        if (message.prepend) {
            listEl.prepend(fragment);
        } else {
            listEl.appendChild(fragment);
        }

        // Show container
        container.classList.remove('hidden');
        container.classList.add('visible');
    }
});

// ============ INITIALIZATION ============

// Revert panel behavior when side panel is closed (user clicks X)
window.addEventListener('beforeunload', () => {
    chrome.runtime.sendMessage({ action: 'CLOSE_SIDEPANEL' }).catch(() => { });
});

document.addEventListener('DOMContentLoaded', async () => {
    setupEventDelegation();

    // Load and render state first
    let extension_state;
    try {
        const data = await chrome.storage.local.get('extension_state');
        extension_state = data.extension_state || DEFAULT_STATE;
    } catch (e) {
        extension_state = DEFAULT_STATE;
    }

    // Hydrate localSettings from the state (source of truth)
    localSettings = { ...DEFAULTS, ...extension_state.settings };

    // Apply Theme Immediately
    const theme = localSettings.theme || 'light';
    document.documentElement.setAttribute('data-theme', theme);

    // Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) activeTabId = tab.id;

    renderUI(extension_state);
});
