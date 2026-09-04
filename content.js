// Central State Source of Truth
const state = {
    isRunning: false,
    isPaused: false,
    currentMode: 'count', // 'count' | 'age' | 'message'
    subMode: 'idle',      // 'scanning' | 'withdrawing' | 'idle'
    lastError: null,      // For persisting error messages on stop
    stats: {
        processed: 0,
        total: 0,
        oldestCleared: '-',
        startTime: null,
        pendingInvitations: null,     // Live count from LinkedIn page
        pendingUpdatedAt: null,       // Timestamp of last update
        alltimeCleared: 0             // Total connections ever cleared
    },
    foundMatchingPeople: [], // Persisted list of found people for Queue/Results
    batchStart: 0,           // Index where the current batch starts (for queue display)
    settings: {
        targetCount: 0,
        ageValue: 3,
        ageUnit: 'month',
        safeMode: true,
        safeThreshold: 1,
        safeUnit: 'month',
        messagePatterns: [],
        debugMode: false
    },
    status: {
        text: "Ready",
        progress: 0
    },
    sessionLog: [], // Local history for UI hydration [{name, age, status, timestamp}]
    uiNavigation: {
        currentTab: 'home' // 'home' | 'progress' | 'settings' | 'history' | 'wrongPage' | 'scanResults' | 'completed'
    },
    lastRunResult: null, // { processed, oldestCleared, timestamp } - persists until new run starts
    sessionCleared: []   // Accumulates ALL cleared people across "Continue" runs in a session
};

// Runtime execution variables (reset on start, not necessary for UI persistence)
let actionDelay = 300;
let baseWait = 300;
let retryCount = 0;
let scrollContainer = null;
// foundMatchingPeople moved to state.foundMatchingPeople

// ============ SELF-HEALING SELECTOR SYSTEM ============
// Stores learned selector overrides from storage or defaults
let selectorOverrides = null; // null = not loaded yet, {} = loaded (empty or with overrides)

// Load learned selectors from storage on startup
async function loadSelectorOverrides() {
    try {
        const { learned_selectors, cloud_selectors } = await chrome.storage.local.get(['learned_selectors', 'cloud_selectors']);
        // Cloud serves as base, local learning overrides it
        selectorOverrides = { ...(cloud_selectors || {}), ...(learned_selectors || {}) };
        Logger.log('ClearConnect: Loaded selector overrides', Object.keys(selectorOverrides).length > 0 ? selectorOverrides : '(none)');
    } catch (e) {
        selectorOverrides = {};
        Logger.error('ClearConnect: Failed to load selector overrides', e);
    }
}
loadSelectorOverrides();

// Get the best selector for a given role (withdraw, card, name, age, message)
function getSelector(role, fallback) {
    if (selectorOverrides && selectorOverrides[role]) {
        return selectorOverrides[role];
    }
    return fallback;
}

// Find the card container for a given child element
// Returns the OUTERMOST matching container to handle nested listitem/componentkey
function findCard(element) {
    if (!element) return null;

    // Strategy 1: Walk all ancestors looking for known LinkedIn card attributes
    // Keep overwriting so we get the OUTERMOST match (furthest from element)
    let el = element.parentElement;
    let bestCard = null;
    while (el && el !== document.body) {
        if (el.matches('[role="listitem"], [componentkey]')) {
            bestCard = el;
        }
        el = el.parentElement;
    }
    if (bestCard) return bestCard;

    // Strategy 2: Find the smallest ancestor that contains a LinkedIn profile link.
    // The card is the deepest ancestor that wraps BOTH the button AND the person's /in/ link.
    // This is robust against LinkedIn renaming their data attributes.
    el = element.parentElement;
    while (el && el !== document.body) {
        if (el.querySelector('a[href*="/in/"]')) {
            return el;
        }
        el = el.parentElement;
    }

    // Strategy 3: Sibling/repeating-list heuristic
    return findCardByHeuristic(element);
}

// Heuristic: Walk up from the element and find the nearest ancestor
// whose parent has multiple children with the same tag/structure (repeating list pattern)
function findCardByHeuristic(element) {
    let current = element.parentElement;
    let depth = 0;
    while (current && current !== document.body && depth < 20) {
        const parent = current.parentElement;
        if (parent) {
            const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
            // If parent has 3+ same-tag children, this is likely a list, and `current` is a card
            if (siblings.length >= 3) {
                return current;
            }
        }
        current = parent;
        depth++;
    }
    return null;
}

// ============ LEARNING MODE ENGINE ============
let learningMode = {
    active: false,
    step: null,       // 'withdraw' | 'name' | 'age' | 'message' | null
    learned: {},      // { withdraw: {...}, name: {...}, age: {...}, message: {...} }
    overlay: null,    // DOM element for overlay
    tooltip: null,    // DOM element for tooltip
    highlightEl: null, // Currently highlighted element
    highlightDiv: null // Floating highlight box (single element, never stacks)
};

const LEARNING_STEPS = [
    { key: 'name', prompt: 'Click on a person\'s name (the link to their profile).' },
    { key: 'age', prompt: 'Click on the date text (e.g. "Sent 2 months ago").' },
    { key: 'message', prompt: 'Click on a message text (if present). Or press Escape or Space to skip.' },
    { key: 'withdraw', prompt: 'Click the "Withdraw" button for the SAME person.' },
    { key: 'open_modal', prompt: 'Almost done! Click "Withdraw" again to open the confirmation modal.' },
    { key: 'confirm_withdraw', prompt: 'Now click the blue <strong>Withdraw</strong> button inside the modal. <small style="opacity:0.7">(Don\'t worry — we\'ll intercept the click. Nothing will be withdrawn.)</small>' }
];

function startLearningMode() {
    // Always stop any existing session first to prevent stacked listeners
    if (learningMode.active) stopLearningMode(false);

    learningMode.active = true;
    learningMode.step = LEARNING_STEPS[0].key;
    learningMode.learned = {};

    // Create overlay to intercept all clicks
    const overlay = document.createElement('div');
    overlay.id = 'cc-learning-overlay';
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        z-index: 2147483646; cursor: crosshair;
        background: rgba(0,0,0,0.05);
        pointer-events: none;
    `;
    document.body.appendChild(overlay);
    learningMode.overlay = overlay;

    // Create tooltip
    const tooltip = document.createElement('div');
    tooltip.id = 'cc-learning-tooltip';
    tooltip.style.cssText = `
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647; padding: 12px 20px;
        background: #1a1a2e; color: #fff; border-radius: 10px;
        font: 14px/1.5 -apple-system, system-ui, sans-serif;
        box-shadow: 0 8px 32px rgba(0,0,0,0.3); text-align: center;
        max-width: 420px;
    `;
    tooltip.innerHTML = `<strong>ClearConnect Learning Mode</strong><br>${LEARNING_STEPS[0].prompt}<br><small style="opacity:0.6">Step 1 of ${LEARNING_STEPS.length} | Press Escape to cancel</small>`;
    document.body.appendChild(tooltip);
    learningMode.tooltip = tooltip;

    // Create floating highlight div (single box, zero residual outlines)
    const highlightDiv = document.createElement('div');
    highlightDiv.id = 'cc-learning-highlight';
    highlightDiv.style.cssText = `
        position: fixed; z-index: 2147483645; pointer-events: none;
        border: 3px solid #4f86f7; border-radius: 4px;
        background: rgba(79,134,247,0.08);
        box-shadow: 0 0 0 1px rgba(79,134,247,0.3);
        transition: all 60ms ease; display: none;
    `;
    document.body.appendChild(highlightDiv);
    learningMode.highlightDiv = highlightDiv;

    // Attach listeners
    document.addEventListener('click', learningClickHandler, true);
    document.addEventListener('pointermove', learningHoverHandler, true);
    document.addEventListener('keydown', learningKeyHandler, true);

    broadcastLearningState();
}

function stopLearningMode(save = false) {
    learningMode.active = false;
    learningMode.step = null;

    // Remove overlay, tooltip, and floating highlight div
    if (learningMode.overlay) { learningMode.overlay.remove(); learningMode.overlay = null; }
    if (learningMode.tooltip) { learningMode.tooltip.remove(); learningMode.tooltip = null; }
    if (learningMode.highlightDiv) { learningMode.highlightDiv.remove(); learningMode.highlightDiv = null; }
    learningMode.highlightEl = null;

    // Remove listeners
    document.removeEventListener('click', learningClickHandler, true);
    document.removeEventListener('pointermove', learningHoverHandler, true);
    document.removeEventListener('keydown', learningKeyHandler, true);

    if (save && Object.keys(learningMode.learned).length > 0) {
        saveLearned(learningMode.learned);
    }

    broadcastLearningState();
}

function learningClickHandler(e) {
    // Guard: do nothing if learning mode is no longer the active controller
    // This prevents the capture listener from interfering with normal page usage
    if (!learningMode.active || !learningMode.step) return;

    if (learningMode.step === 'open_modal') {
        // Let the click pass through to open the modal
        const currentIdx = LEARNING_STEPS.findIndex(s => s.key === learningMode.step);
        const nextIdx = currentIdx + 1;

        if (learningMode.highlightDiv) learningMode.highlightDiv.style.display = 'none';

        setTimeout(() => {
            learningMode.step = LEARNING_STEPS[nextIdx].key;
            updateLearningTooltip(nextIdx);
        }, 800);
        return;
    }

    const stepKey = learningMode.step;

    // Prevent default on all steps so we don't accidentally navigate or withdraw
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const target = e.target;

    // Synthesize selector info from the clicked element
    const selectorInfo = synthesizeSelector(target);
    learningMode.learned[stepKey] = selectorInfo;

    Logger.log(`ClearConnect Learning: Captured [${stepKey}]`, selectorInfo);

    // Advance to next step
    const currentIdx = LEARNING_STEPS.findIndex(s => s.key === stepKey);
    const nextIdx = currentIdx + 1;

    if (nextIdx < LEARNING_STEPS.length) {
        learningMode.step = LEARNING_STEPS[nextIdx].key;
        updateLearningTooltip(nextIdx);
    } else {
        // All steps done - validate
        validateAndSave();
        
        // After validation and saving begins, we can safely close the modal programmatically
        // We delay it slightly so our Escape listener doesn't intercept it
        setTimeout(() => {
            const escEvent = new KeyboardEvent('keydown', {
                key: 'Escape',
                code: 'Escape',
                bubbles: true,
                cancelable: true
            });
            document.dispatchEvent(escEvent);
        }, 1600); // validateAndSave takes 1500ms
    }
}

function learningHoverHandler(e) {
    if (!learningMode.active || !learningMode.highlightDiv) return;

    // elementFromPoint gives us exactly one element - the topmost visible under the cursor.
    // Temporarily hide our own highlight div so it doesn't block the query.
    learningMode.highlightDiv.style.display = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    learningMode.highlightDiv.style.display = '';

    if (!el || el === document.body || el === document.documentElement) return;

    // Position the floating box over the hovered element
    const rect = el.getBoundingClientRect();
    const hd = learningMode.highlightDiv;
    hd.style.top = `${rect.top}px`;
    hd.style.left = `${rect.left}px`;
    hd.style.width = `${rect.width}px`;
    hd.style.height = `${rect.height}px`;

    learningMode.highlightEl = el;
}

function learningKeyHandler(e) {
    if (e.key === 'Escape') {
        stopLearningMode(false);
    } else if (e.key === 'Enter' || e.key === ' ') {
        // Skip current step
        const currentIdx = LEARNING_STEPS.findIndex(s => s.key === learningMode.step);
        const nextIdx = currentIdx + 1;
        if (nextIdx < LEARNING_STEPS.length) {
            learningMode.step = LEARNING_STEPS[nextIdx].key;
            updateLearningTooltip(nextIdx);
        } else {
            validateAndSave();
        }
    }
}

function updateLearningTooltip(stepIdx) {
    if (!learningMode.tooltip) return;
    const step = LEARNING_STEPS[stepIdx];
    learningMode.tooltip.innerHTML = `<strong>ClearConnect Learning Mode</strong><br>${step.prompt}<br><small style="opacity:0.6">Step ${stepIdx + 1} of ${LEARNING_STEPS.length} | Press Escape to cancel | Enter/Space to skip</small>`;

    // For the confirm step the LinkedIn modal is open and centered — slide to top-left
    if (step.key === 'confirm_withdraw') {
        learningMode.tooltip.style.top = '16px';
        learningMode.tooltip.style.left = '16px';
        learningMode.tooltip.style.bottom = 'auto';
        learningMode.tooltip.style.right = 'auto';
        learningMode.tooltip.style.transform = 'none';
        learningMode.tooltip.style.textAlign = 'left';
        learningMode.tooltip.style.maxWidth = '320px';
    } else {
        // Centered-top for all other steps
        learningMode.tooltip.style.top = '16px';
        learningMode.tooltip.style.left = '50%';
        learningMode.tooltip.style.bottom = 'auto';
        learningMode.tooltip.style.right = 'auto';
        learningMode.tooltip.style.transform = 'translateX(-50%)';
        learningMode.tooltip.style.textAlign = 'center';
        learningMode.tooltip.style.maxWidth = '420px';
    }

    // Push tooltip to the very end of the DOM so it sits above any newly created modals
    if (learningMode.tooltip.parentElement) {
        document.body.appendChild(learningMode.tooltip);
    }
}

// Synthesize a robust selector from a clicked element
function synthesizeSelector(el) {
    // If the user clicked a featureless child element (e.g. an inner <span> with no
    // data attributes), walk up to find the nearest ancestor that carries useful
    // attributes so the selector targets the real interactive element.
    const USEFUL_ATTRS = ['data-testid', 'data-view-name', 'aria-label', 'role'];
    function hasUsefulAttrs(node) {
        return USEFUL_ATTRS.some(a => node.hasAttribute && node.hasAttribute(a));
    }
    let target = el;
    if (!hasUsefulAttrs(el)) {
        let ancestor = el.parentElement;
        let depth = 0;
        while (ancestor && ancestor !== document.body && depth < 6) {
            if (hasUsefulAttrs(ancestor)) { target = ancestor; break; }
            ancestor = ancestor.parentElement;
            depth++;
        }
    }

    const info = {
        tag: target.tagName.toLowerCase(),
        attributes: {}
    };

    // Capture stable attributes from the resolved target (href omitted to prevent PII exposure)
    const stableAttrs = ['data-testid', 'data-view-name', 'componentkey', 'role', 'aria-label'];
    for (const attr of stableAttrs) {
        if (target.hasAttribute(attr)) {
            info.attributes[attr] = target.getAttribute(attr);
        }
    }

    // Build a CSS selector. For aria-label values that contain a person's name
    // (e.g. "Withdraw invitation sent to Julia Mays"), use a starts-with selector
    // so the learned rule matches ALL people, not just the one chosen during learning.
    let selector = info.tag;
    if (info.attributes['data-testid']) {
        selector += `[data-testid="${info.attributes['data-testid']}"]`;
    } else if (info.attributes['data-view-name']) {
        selector += `[data-view-name="${info.attributes['data-view-name']}"]`;
    } else if (info.attributes['aria-label']) {
        const ariaLabel = info.attributes['aria-label'];
        // Strip person-specific suffix from "Withdraw invitation sent to [Name]"
        const withdrawPrefix = ariaLabel.match(/^(Withdraw invitation sent to )/i);
        if (withdrawPrefix) {
            selector += `[aria-label^="${withdrawPrefix[1]}"]`;
            // Crucial for parity: Sanitize the actual attribute stored in the JSON payload
            info.attributes['aria-label'] = withdrawPrefix[1];
        } else {
            selector += `[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
        }
    } else if (info.attributes.role) {
        selector += `[role="${info.attributes.role}"]`;
    }

    // Relative path from card container (stored for diagnostics / webhook reporting)
    const card = findCard(target);
    if (card) {
        info.relativePath = getRelativePath(card, target);
    }

    info.selector = selector;
    return info;
}

// Get a relative CSS path from ancestor to descendant
function getRelativePath(ancestor, descendant) {
    const parts = [];
    let current = descendant;
    while (current && current !== ancestor) {
        let part = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (parent) {
            const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
            if (siblings.length > 1) {
                const idx = siblings.indexOf(current) + 1;
                part += `:nth-of-type(${idx})`;
            }
        }
        parts.unshift(part);
        current = current.parentElement;
    }
    return parts.join(' > ');
}

// Validate learned selectors by trying to find multiple matches
async function validateAndSave() {
    if (!learningMode.tooltip) return;
    learningMode.tooltip.innerHTML = '<strong>Validating...</strong><br>Testing learned selectors on the page...';

    const learned = learningMode.learned;
    let validCount = 0;
    let totalChecks = 0;

    // Validate withdraw button selector
    if (learned.withdraw) {
        totalChecks++;
        const testButtons = findElementsByLearned(learned.withdraw);
        if (testButtons.length >= 2) {
            validCount++;
            Logger.log('ClearConnect Validation: withdraw selector found', testButtons.length, 'matches');
        } else {
            Logger.log('ClearConnect Validation: withdraw selector found only', testButtons.length, 'matches');
        }
    }

    if (validCount >= totalChecks && totalChecks > 0) {
        learningMode.tooltip.innerHTML = `<strong style="color:#4ade80">Validation Passed!</strong><br>Found working selectors. Saving...<br><small>The extension will use these until LinkedIn changes again. Closing modal...</small>`;
        await wait(1500);
        stopLearningMode(true);
    } else {
        // Show prompt but stop learning mode NOW so listeners are removed
        // User can click Repair Layout again to retry
        learningMode.tooltip.innerHTML = `<strong style="color:#f87171">Validation Issue</strong><br>Could not verify selectors reliably.<br><small>Press Escape to close, or click Repair Layout in settings to try again.</small>`;
        await wait(2500);
        stopLearningMode(false);
    }
}

// Find elements using a learned selector object
function findElementsByLearned(learnedInfo) {
    if (!learnedInfo) return [];

    // Try CSS selector first
    if (learnedInfo.selector && learnedInfo.selector !== learnedInfo.tag) {
        const els = Array.from(document.querySelectorAll(learnedInfo.selector));
        if (els.length > 0) return els;
    }

    // Fallback: text matching
    if (learnedInfo.text) {
        const targetText = learnedInfo.text.toLowerCase();
        return Array.from(document.querySelectorAll(learnedInfo.tag)).filter(el => {
            return (el.textContent || '').trim().toLowerCase() === targetText;
        });
    }

    return [];
}

// Save learned selectors to storage
async function saveLearned(learned) {
    // Capture previous selectors for before/after diff
    const previousOverrides = selectorOverrides ? JSON.parse(JSON.stringify(selectorOverrides)) : {};

    const overrides = {};
    for (const [key, info] of Object.entries(learned)) {
        // Sanitize: only allow known tags
        const allowedTags = ['button', 'a', 'div', 'span', 'p', 'li', 'figure', 'img'];
        if (!allowedTags.includes(info.tag)) {
            Logger.log(`ClearConnect: Skipping learned selector for [${key}] - unsafe tag: ${info.tag}`);
            continue;
        }
        overrides[key] = info;
    }

    await chrome.storage.local.set({ learned_selectors: overrides });
    selectorOverrides = overrides;
    Logger.log('ClearConnect: Saved learned selectors', overrides);

    // Send before/after config diff
    sendDiagnosticReport('selectors_learned', {
        reason: 'User completed Repair Layout',
        before: previousOverrides,
        after: overrides
    });
}

// ============ DIAGNOSTIC REPORTING ============
// Hands an event to the background service worker, which is the only place that
// knows the delivery endpoint. Rendering and delivery happen in the Cloudflare
// Worker (see worker/README.md) -- this side only assembles minimal, non-PII facts.

function sendDiagnosticReport(eventType, data = {}) {
    try {
        // Deep clone to prevent mutation of caller state.
        const safeData = JSON.parse(JSON.stringify(data));

        // Strip free text, which is the only field that can carry a person's
        // name or the body of an invitation message.
        if (safeData && typeof safeData === 'object') {
            for (const val of Object.values(safeData)) {
                if (val && val.text) val.text = '[redacted]';
            }
        }

        chrome.runtime.sendMessage({
            action: 'REPORT_EVENT',
            event: {
                type: eventType,
                version: chrome.runtime.getManifest?.()?.version || 'unknown',
                data: safeData
            }
        }).catch(() => { });
    } catch (e) {
        // Reporting must never break the extension.
    }
}

// Broadcast learning mode state to popup/sidepanel
function broadcastLearningState() {
    chrome.runtime.sendMessage({
        action: 'LEARNING_MODE_UPDATE',
        learningActive: learningMode.active,
        learningStep: learningMode.step,
        learnedKeys: Object.keys(learningMode.learned)
    }).catch(() => { });
}

// ============ DETECTION FAILURE HANDLER ============
function triggerDetectionFailure(reason) {
    Logger.log('ClearConnect: Detection failure -', reason);

    // Notify popup/sidepanel
    chrome.runtime.sendMessage({
        action: 'DETECTION_FAILURE',
        reason: reason
    }).catch(() => { });

    // Send webhook alert with full diagnostics
    sendDiagnosticReport('detection_failure', {
        reason: reason,
        path: window.location.pathname, // pathname only -- query strings can carry identifiers
        cards: document.querySelectorAll('[role="listitem"], [componentkey]').length,
        buttons: document.querySelectorAll('button').length,
        profileLinks: document.querySelectorAll('a[href*="/in/"]').length,
        withdrawTexts: Array.from(document.querySelectorAll('button, a')).filter(b => (b.textContent || '').trim().toLowerCase() === 'withdraw').length,
        dataViewButtons: document.querySelectorAll('[data-view-name="sent-invitations-withdraw-single"]').length,
        overrides: selectorOverrides ? Object.keys(selectorOverrides) : 'none',
        mode: state.subMode || 'unknown'
    });
}


// Save state to chrome.storage.local (source of truth)
// CRITICAL: We fetch and merge to avoid wiping external updates (like settings changes)
async function saveState() {
    try {
        const data = await chrome.storage.local.get('extension_state');
        const currentState = data.extension_state || {};

        // Preserve the UI navigation tab set by sidepanel/popup before merging.
        // Content.js owns runtime flags (isRunning, subMode, stats) but not UI routing.
        const preservedTab = currentState.uiNavigation?.currentTab;

        // Merge our runtime state into storage state
        // We "own" isRunning, subMode, stats.processed, stats.alltimeCleared while running
        // Helper for deep merging to avoid wiping storage
        function mergeDeep(target, source) {
            for (const key in source) {
                if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                    if (!target[key]) target[key] = {};
                    mergeDeep(target[key], source[key]);
                } else {
                    target[key] = source[key];
                }
            }
        }

        // Merge runtime state into store state
        mergeDeep(currentState, state);

        // Don't let the default 'home' in content.js overwrite a meaningful UI tab
        // (e.g. 'scanResults') set by sidepanel. Only allow explicit navigations like 'completed'.
        if (state.uiNavigation?.currentTab === 'home' && preservedTab && preservedTab !== 'home') {
            if (!currentState.uiNavigation) currentState.uiNavigation = {};
            currentState.uiNavigation.currentTab = preservedTab;
        }

        await chrome.storage.local.set({ extension_state: currentState });
    } catch (e) {
        Logger.error('ClearConnect: Failed to save state', e);
    }
}

// Broadcast state to popup (for real-time UI updates)
function broadcastState(eventType = 'STATE_UPDATE') {
    chrome.runtime.sendMessage({
        action: eventType,
        state: state
    }).catch(() => {
        // Popup might be closed, ignore error
    });
    saveState();
}

// Restore state from storage on script load (for resuming interrupted operations)
(async function initState() {
    try {
        const { extension_state, alltimeCleared: legacyCleared } = await chrome.storage.local.get(['extension_state', 'alltimeCleared']);
        if (extension_state) {
            // DEEP MERGE: Merge stored state into current state
            // Object.assign is shallow, so we manually merge deep objects

            // 1. Merge Top Level Booleans/Strings
            for (const key in extension_state) {
                if (typeof extension_state[key] !== 'object' || extension_state[key] === null) {
                    state[key] = extension_state[key];
                }
            }

            // 2. Merge Stats
            if (extension_state.stats) {
                state.stats = { ...state.stats, ...extension_state.stats };
            }

            // 3. Merge Settings
            if (extension_state.settings) {
                state.settings = { ...state.settings, ...extension_state.settings };
            }

            // 4. Merge Navigation/Result objects
            if (extension_state.uiNavigation) state.uiNavigation = { ...state.uiNavigation, ...extension_state.uiNavigation };
            if (extension_state.lastRunResult) state.lastRunResult = { ...state.lastRunResult, ...extension_state.lastRunResult };
            if (extension_state.sessionLog) state.sessionLog = extension_state.sessionLog;
            if (extension_state.sessionCleared) state.sessionCleared = extension_state.sessionCleared;
            if (extension_state.foundMatchingPeople) state.foundMatchingPeople = extension_state.foundMatchingPeople;

            // Migrate legacy alltimeCleared if it exists and state doesn't have it
            if (legacyCleared && (state.stats.alltimeCleared === 0 || state.stats.alltimeCleared === undefined)) {
                state.stats.alltimeCleared = legacyCleared;
            }

            // If we were running when page was reloaded, mark as stopped
            if (state.isRunning) {
                state.isRunning = false;
                state.subMode = 'idle';
                state.lastError = 'Page was reloaded. Operation stopped.';
            }
        }

        // Always update pending count on page load if we can read it
        const liveCount = getLinkedInTotalCount();
        if (liveCount !== null) {
            state.stats.pendingInvitations = liveCount;
            state.stats.pendingUpdatedAt = Date.now();
        }

        await saveState();
    } catch (e) {
        Logger.error('ClearConnect: Failed to restore state', e);
    }
})();


// Strip all debug-mode visual markers so a real run sees all cards fresh
function clearDebugStyling() {
    document.querySelectorAll('.cc-processed').forEach(el => {
        el.classList.remove('cc-processed');
        el.style.backgroundColor = '';
        el.style.border = '';
        el.style.opacity = '';
        el.style.transition = '';
        el.style.color = '';
        el.style.fontWeight = '';
        el.style.display = '';
        // Restore button text if it was overwritten
        if (el.tagName === 'BUTTON' && el.innerText === 'Debug Cleared') {
            el.innerText = 'Withdraw';
        }
    });
    Logger.log('Debug styling cleared from page');
}

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'START_WITHDRAW') {
        if (state.isRunning) return;

        // Batch Start Logic: Track where this new run begins relative to history
        // If continuing, we want to slice the queue from here.
        state.batchStart = state.stats.processed || 0;

        // CRITICAL FIX: clear pending items from previous run to force fresh scan
        // This ensures "Continue" finds the CORRECT people from current view
        if (state.foundMatchingPeople && state.foundMatchingPeople.length > 0) {
            state.foundMatchingPeople = state.foundMatchingPeople.filter(p => p.cleared === true);
            // After clearing pending, batchStart should align with the end of cleared list
            // Just double check:
            state.batchStart = state.foundMatchingPeople.length;
        }

        // Reset State
        state.isRunning = true;
        state.isPaused = false;
        state.currentMode = message.mode || 'count';
        // Continuation Support (User requested "Continue Clearing")
        const isContinuation = message.isContinuation === true;
        state.subMode = isContinuation ? 'withdrawing' : 'scanning';
        state.lastError = null;

        state.settings.targetCount = message.count || 999999;
        state.settings.ageValue = message.ageValue || 3;
        state.settings.ageUnit = message.ageUnit || 'month';
        state.settings.safeMode = message.safeMode !== false;
        state.settings.safeThreshold = message.safeThreshold || 1;
        state.settings.safeUnit = message.safeUnit || 'month';
        state.settings.messagePatterns = message.messages || [];
        state.settings.debugMode = message.debugMode === true;
        Logger.DEBUG = state.settings.debugMode;
        if (!state.settings.debugMode) clearDebugStyling();

        state.stats.processed = 0;
        state.stats.total = 0; // Will be determined
        state.stats.oldestCleared = '-';
        state.stats.startTime = Date.now();

        state.status.text = "Starting...";
        state.status.progress = 0;
        state.sessionLog = []; // Reset log on new run? Or keep? Reset for new run seems safer.

        if (!isContinuation) {
            state.sessionCleared = []; // New session: Clear history
        }
        // else: Keep sessionCleared to append new results

        // specific resets
        retryCount = 0;
        baseWait = 300;
        scrollContainer = null;

        // Save state and start
        saveState();
        startProcess(isContinuation);

    } else if (message.action === 'STOP_WITHDRAW') {
        const msg = state.stats.processed > 0 ?
            `Stopped by user, ${state.stats.processed} withdrawn.` :
            'Stopped by user.';
        complete(msg, {}, 'manual');

    } else if (message.action === 'GET_STATUS') {
        // Return full state for hydration
        sendResponse(state);

    } else if (message.action === 'GET_COUNT') {
        const count = getLinkedInTotalCount() ?? 0;
        sendResponse({ count });

    } else if (message.action === 'PAUSE_WITHDRAW') {
        state.isPaused = true;
        updateStatus('Paused', state.status.progress);

    } else if (message.action === 'RESUME_WITHDRAW') {
        state.isPaused = false;
        updateStatus('Resuming...', state.status.progress);

    } else if (message.action === 'UPDATE_MESSAGES') {
        state.settings.messagePatterns = message.messages || [];
        state.foundMatchingPeople = [];
        state.isPaused = false;
        updateStatus('Resuming with updated patterns...', state.status.progress);

    } else if (message.action === 'SCAN_CONNECTIONS') {
        if (state.isRunning) return;
        state.isRunning = true;
        state.currentMode = 'message';
        state.subMode = 'scanning';

        // Hydrate settings for scan duration
        state.settings.safeMode = message.safeMode !== false;
        state.settings.safeThreshold = message.safeThreshold || 1;
        state.settings.safeUnit = message.safeUnit || 'month';
        state.settings.debugMode = message.debugMode === true;
        Logger.DEBUG = state.settings.debugMode;

        state.sessionLog = []; // Reset log
        saveState();
        scanConnections();

    } else if (message.action === 'WITHDRAW_SELECTED') {
        if (state.isRunning) return;
        state.isRunning = true;
        state.currentMode = 'message';
        state.subMode = 'withdrawing';

        state.settings.debugMode = message.debugMode === true;
        Logger.DEBUG = state.settings.debugMode;
        if (!state.settings.debugMode) clearDebugStyling();
        state.settings.safeMode = message.safeMode !== false;
        state.settings.safeThreshold = message.safeThreshold !== undefined ? message.safeThreshold : 1;
        state.settings.safeUnit = message.safeUnit || 'month';

        state.sessionLog = []; // Reset log
        saveState();
        withdrawSelected(message.selectedHashes);

    } else if (message.action === 'SHOW_CONNECTION') {
        showConnection(message.hash);

    } else if (message.action === 'GET_PENDING_COUNT') {
        const count = getLinkedInTotalCount();
        sendResponse({ count: count });
        return true;

    } else if (message.action === 'START_LEARNING') {
        startLearningMode();

    } else if (message.action === 'STOP_LEARNING') {
        stopLearningMode(false);

    } else if (message.action === 'GET_LEARNED_CONFIG') {
        chrome.storage.local.get('learned_selectors').then(({ learned_selectors }) => {
            sendResponse({ config: learned_selectors || {} });
        });
        return true;

    } else if (message.action === 'RESET_LEARNED') {
        chrome.storage.local.remove('learned_selectors');
        selectorOverrides = {};
        sendResponse({ ok: true });
    }
});

function getLinkedInTotalCount() {
    // Tier 1: cloud/learned override targets the exact count element directly.
    // Supports both a CSS string override and the element-descriptor format.
    const pendingCountSel = getSelector('pending_count', null);
    if (pendingCountSel) {
        try {
            const els = Array.from(document.querySelectorAll(pendingCountSel));
            for (const el of els) {
                const count = parseInt((el.textContent || '').replace(/[^0-9]/g, ''), 10);
                if (!isNaN(count) && count > 0) {
                    if (state.stats.pendingInvitations !== count) {
                        state.stats.pendingInvitations = count;
                        state.stats.pendingUpdatedAt = Date.now();
                    }
                    return count;
                }
            }
        } catch (_) { /* invalid selector from cloud; fall through */ }
    }

    // Tier 2: Broad text-pattern search across semantic elements
    // LinkedIn puts the count in header tabs, left-rail filters, or radio groups
    const selectors = [
        '[role="tab"]',
        '[role="radio"]',
        'nav button',
        'nav a',
        'label',
        'span',
        'h1',
        'h2'
    ];

    const elements = document.querySelectorAll(selectors.join(','));

    for (const el of elements) {
        const text = (el.textContent || '').trim();
        // Regex handles "People (905)", "People 905", "People (1,100)"
        const matchPeople = text.match(/People\s*(?:\(?)\s*([0-9,]+)\s*(?:\)?)/i);
        // Regex handles "1,160 Connections"
        const matchConnections = text.match(/([0-9,]+)\s*Connections/i);
        
        let countStr = null;
        if (matchPeople) countStr = matchPeople[1];
        else if (matchConnections) countStr = matchConnections[1];

        if (countStr) {
            const count = parseInt(countStr.replace(/,/g, ''), 10);
            if (!isNaN(count)) {
                if (state.stats.pendingInvitations !== count) {
                    state.stats.pendingInvitations = count;
                    state.stats.pendingUpdatedAt = Date.now();
                }
                return count;
            }
        }
    }
    return null;
}

// Get connection message from card - extracts full message text
function getConnectionMessage(btn) {
    const card = findCard(btn);
    if (!card) return null;
    
    let msgEl = null;
    
    if (selectorOverrides && selectorOverrides.message) {
        const learnedEls = findElementsByLearned(selectorOverrides.message);
        msgEl = learnedEls.find(el => card.contains(el));
    }
    
    if (!msgEl) {
        msgEl = card.querySelector('[data-testid="expandable-text-box"]');
    }
    
    if (!msgEl) return null;

    // Clone to avoid modifying DOM, then remove "show more" button text
    const clone = msgEl.cloneNode(true);
    const showMoreBtn = clone.querySelector('button');
    if (showMoreBtn) showMoreBtn.remove();

    // Get clean text content
    let text = clone.textContent.trim();
    // Remove trailing "…" that indicates truncation
    text = text.replace(/…\s*$/, '').trim();
    return text;
}

// Track found matching people during scroll
// function normalizeMessage(text) { ... } removed in favor of more complex version below

// Check if connection matches any message pattern
function matchesMessagePattern(btn) {
    if (state.settings.messagePatterns.length === 0) return false;
    const msg = getConnectionMessage(btn);
    if (!msg) return false;

    // Normalize both the message and patterns for comparison
    const normalizedMsg = normalizeMessage(msg);

    return state.settings.messagePatterns.some(pattern => {
        const normalizedPattern = normalizeMessage(pattern);
        // Match if normalized message contains normalized pattern
        // Or if original message contains original pattern (for non-greeting patterns)
        return normalizedMsg.includes(normalizedPattern) || msg.includes(pattern);
    });
}

function findScrollContainer() {
    const firstCard = document.querySelector('[role="listitem"]') || document.querySelector('[componentkey]');
    if (!firstCard) {
        // Heuristic: find any element that contains a profile link
        const profileLink = document.querySelector('a[href*="/in/"]');
        if (profileLink) {
            const card = findCard(profileLink);
            if (card) {
                let parent = card.parentElement;
                while (parent && parent !== document.body) {
                    const style = getComputedStyle(parent);
                    const isScrollable = (
                        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                        parent.scrollHeight > parent.clientHeight
                    );
                    if (isScrollable) return parent;
                    parent = parent.parentElement;
                }
            }
        }
        return null;
    }

    let parent = firstCard.parentElement;
    while (parent && parent !== document.body) {
        const style = getComputedStyle(parent);
        const isScrollable = (
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            parent.scrollHeight > parent.clientHeight
        );
        if (isScrollable) return parent;
        parent = parent.parentElement;
    }

    const main = document.querySelector('main');
    if (main && main.scrollHeight > main.clientHeight) return main;

    return null;
}

function scrollTo(y) {
    if (scrollContainer) {
        scrollContainer.scrollTop = y;
    } else {
        window.scrollTo(0, y);
    }
}

// Scroll to the bottom in viewport-sized steps (simulates spacebar presses).
// This ensures LinkedIn's IntersectionObserver fires at every intermediate
// position, which is what actually triggers infinite scroll content loading.
async function scrollToBottomIncremental() {
    const step = Math.floor((window.innerHeight || 800) * 0.85);

    const getPos = () => scrollContainer
        ? scrollContainer.scrollTop
        : (window.scrollY || document.documentElement.scrollTop);

    const doScroll = () => {
        if (scrollContainer && scrollContainer !== document.body) {
            scrollContainer.scrollBy({ top: step, behavior: 'instant' });
        } else {
            window.scrollBy({ top: step, behavior: 'instant' });
        }
    };

    let lastPos = -1;
    while (state.isRunning) {
        const pos = getPos();
        if (pos === lastPos) break; // reached the bottom, nothing left to scroll
        lastPos = pos;
        doScroll();
        await wait(80); // let IntersectionObserver fire between each step
    }
}

async function clickLoadMoreButton() {
    // Find buttons with "Load more" text
    const buttons = Array.from(document.querySelectorAll('button'));
    const loadMore = buttons.find(b => {
        const text = (b.textContent || '').trim().toLowerCase();
        return text === 'load more' || text === 'show more results'; // Inclusion of similar variants
    });

    if (loadMore) {
        Logger.log('ClearConnect: Found Load More button, clicking...');
        loadMore.scrollIntoView({ behavior: 'auto', block: 'center' });
        await wait(50); // Minimal delay for scroll to settle
        loadMore.click();
        await wait(300); // Reduced wait for load pulse
        return true;
    }
    return false;
}

function scrollBy(dy) {
    if (scrollContainer) {
        scrollContainer.scrollTop += dy;
    } else {
        window.scrollBy(0, dy);
    }
}

function getScrollHeight() {
    return scrollContainer ? scrollContainer.scrollHeight : document.body.scrollHeight;
}

function isAtScrollBottom() {
    if (scrollContainer) {
        return scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 50;
    }
    return window.scrollY + window.innerHeight >= document.body.scrollHeight - 50;
}

async function startProcess(isContinuation = false) {
    scrollContainer = findScrollContainer();
    Logger.log('ClearConnect: Scroll container', scrollContainer ? 'found' : 'using window');

    if (!isContinuation) {
        updateStatus('Scrolling to bottom...', 0);
        await scrollToBottom();
    } else {
        Logger.log('ClearConnect: Continuation - Skipping scroll');
    }

    // Reset scan state
    scannedUrns.clear();
    lastScannedIndex = 0;
    // Reset found list for new run (Queue shows current batch only)
    state.foundMatchingPeople = [];
    state.batchStart = 0;
    // Reset Processed count for this run (Stats tracks run progress)
    state.stats.processed = 0;

    if (state.isRunning) {
        // Pre-scan for targets (Final sweep / Count Mode)
        if (state.currentMode === 'count' || state.currentMode === 'age') {
            await scanForTargets();
        }

        // STUCK DETECTION: If we scrolled but found zero buttons, trigger detection failure
        const postScrollButtons = findWithdrawButtons();
        if (postScrollButtons.length === 0 && !isContinuation) {
            triggerDetectionFailure('No withdraw buttons found after scrolling. LinkedIn may have changed its UI.');
            complete('LinkedIn\'s UI may have changed. Could not find any withdraw buttons. Try "Repair Layout" in settings.', {}, 'error');
            return;
        }

        // Transition to withdrawal phase
        state.subMode = 'withdrawing';
        broadcastState('PHASE_CHANGE');

        processNext();
    }
}

let scannedUrns = new Set();
let lastScannedIndex = 0;

async function scanVisibleAgeTargets(buttons) {
    if (state.currentMode !== 'age') return;

    const targets = [];
    // Iterate new buttons only
    for (let i = lastScannedIndex; i < buttons.length; i++) {
        const btn = buttons[i];
        const urn = getProfileUrl(btn) || getPersonName(btn);

        if (scannedUrns.has(urn)) continue;

        // Age Logic: Add if Old Enough (Status !shouldStop) and Safe
        // shouldStop returns true for "Too Young"
        if (!shouldStop(btn) && isSafe(btn)) {
            const personName = getPersonName(btn);
            const age = getAge(btn);
            targets.push({
                name: personName,
                age: age ? age.text : '',
                status: 'pending'
            });
            scannedUrns.add(urn);
        }
    }

    lastScannedIndex = buttons.length;

    // Send batch (Prepend)
    if (targets.length > 0) {
        try {
            chrome.runtime.sendMessage({
                action: 'POPULATE_QUEUE',
                targets: targets,
                prepend: true
            });
        } catch (e) { }
    }
}

async function scanForTargets() {
    // Wait for stability
    await wait(1000);

    const buttons = findWithdrawButtons();
    const targets = [];

    // Scan from bottom up (Oldest to Newest)
    for (let i = buttons.length - 1; i >= 0; i--) {
        const btn = buttons[i];
        const urn = getProfileUrl(btn) || getPersonName(btn);

        // Count Limit check
        if (state.currentMode === 'count' && targets.length >= state.settings.targetCount) break;

        // Safety check (too recent)
        if (!isSafe(btn)) break;

        // Age Limit check (too young)
        if (state.currentMode === 'age' && shouldStop(btn)) break;

        // Skip if already scanned
        if (scannedUrns.has(urn) && state.currentMode === 'age') continue;

        // Add to targets
        const personName = getPersonName(btn);
        const age = getAge(btn);

        // PERSISTENCE FIX: Add to global state instantly
        // This ensures Queue List is populated even if popup reopens
        const targetObj = {
            name: personName,
            age: age ? age.text : '',
            status: 'pending'
        };

        targets.push(targetObj);

        // Add to foundMatchingPeople - use profileUrl as primary dedup key so
        // cards whose name resolved to 'Unknown' don't collapse into a single entry
        const profileUrl = getProfileUrl(btn);
        const alreadyAdded = profileUrl
            ? state.foundMatchingPeople.some(p => p.profileUrl === profileUrl)
            : (personName !== 'Unknown' && state.foundMatchingPeople.some(p => p.name === personName));
        if (!alreadyAdded) {
            state.foundMatchingPeople.push({
                name: personName,
                profileUrl: profileUrl || null,
                age: age ? `${age.value} ${age.unit}${age.value > 1 ? 's' : ''}` : '-',
                cleared: false
            });
        }

        if (state.currentMode === 'age') scannedUrns.add(urn);
    }

    // Save state after scanning to persist the list
    // UPDATE TOTAL for immediate mode so UI knows [1/Total]
    state.stats.total = targets.length;

    // For Age mode, update targetCount setting so progress bars work
    if (state.currentMode === 'age') {
        state.settings.targetCount = targets.length;
    }

    saveState();

    // Send batch to Popup (still useful for immediate update if open)
    if (targets.length > 0) {
        try {
            chrome.runtime.sendMessage({
                action: 'POPULATE_QUEUE',
                targets: targets,
                prepend: false,
                total: targets.length // Explicitly send total
            });
        } catch (e) { }
    }
}

async function scrollToBottom() {
    let lastCount = 0;
    let noChange = 0;
    let maxRetries = 15; // Increased to allow deeper jiggles when far from goal
    let lastCardElement = null;

    const linkedInTotal = getLinkedInTotalCount() || 1000; // fallback estimate
    Logger.log('ClearConnect: LinkedIn shows', linkedInTotal, 'total');

    // Send initial scroll progress
    sendScrollProgress(0, linkedInTotal);

    while (state.isRunning && noChange < maxRetries) {
        // PROACTIVE BUTTON CHECK: Hit it immediately if it exists
        if (await clickLoadMoreButton()) {
            noChange = 0;
            // Immediate re-scroll after button click if content starts flowing
        }

        const initialHeight = getScrollHeight();
        const initialCount = findWithdrawButtons().length;

        await scrollToBottomIncremental();

        // Settle wait for any batch-loaded content after reaching the bottom
        await waitForContentChange(initialHeight, initialCount, 2000);

        const buttons = findWithdrawButtons();

        // Progressive Scan for Age Mode
        if (state.currentMode === 'age') {
            scanVisibleAgeTargets(buttons);
        }

        const currentCount = buttons.length;
        const currentLastCard = buttons.length > 0 ? buttons[buttons.length - 1] : null;

        // Calculate matching count for Age mode
        let matchCount = 0;
        if (state.currentMode === 'age') {
            // Scan backwards from end for efficiency (assuming sorting)
            for (let i = buttons.length - 1; i >= 0; i--) {
                const btn = buttons[i];

                // Independent matching logic (Pure Age Check)
                // Does NOT use shouldStop/isSafe to avoid coupling with critical safety logic
                const age = getAge(btn);
                if (age) {
                    let connectionAgeDays = 0;
                    if (age.unit === 'year') connectionAgeDays = age.value * 365;
                    else if (age.unit === 'month') connectionAgeDays = age.value * 30;
                    else if (age.unit === 'week') connectionAgeDays = age.value * 7;
                    else if (age.unit === 'day') connectionAgeDays = age.value;

                    let thresholdDays = 0;
                    let ageVal = state.settings.ageValue;
                    let ageUnt = state.settings.ageUnit;

                    if (ageUnt === 'year') thresholdDays = ageVal * 365;
                    else if (ageUnt === 'month') thresholdDays = ageVal * 30;
                    else if (ageUnt === 'week') thresholdDays = ageVal * 7;
                    else if (ageUnt === 'day') thresholdDays = ageVal;

                    if (connectionAgeDays >= thresholdDays) {
                        matchCount++;
                    } else {
                        // Strict sorted assumption: if this item is too new, all above are too new?
                        // Yes, provided LinkedIn is sorted Newest -> Oldest (Top -> Bottom).
                        // If we are scanning Bottom -> Top, we are scanning Oldest -> Newest.
                        // So if we hit a NEW item, we stop.
                        break;
                    }
                } else {
                    // If age parsing fails, assume non-match and stop?
                    // Or skip? 
                    // Safest to stop if we assume sort order.
                    break;
                }
            }
            state.stats.total = matchCount;
        } else if (state.currentMode === 'message') {
            // Count matching messages and track found people with age data
            // Count matching messages and track found people with age data
            state.foundMatchingPeople = [];
            for (const btn of buttons) {
                if (matchesMessagePattern(btn)) {
                    matchCount++;
                    const name = getPersonName(btn);
                    const age = getAge(btn);
                    const ageText = age ? `${age.value} ${age.unit}${age.value > 1 ? 's' : ''}` : '-';

                    // Track matching person with full data (avoid duplicates by name)
                    if (name && !state.foundMatchingPeople.some(p => p.name === name)) {
                        state.foundMatchingPeople.push({ name, age: ageText, cleared: false });
                    }
                }
            }
            state.stats.total = matchCount;
            saveState(); // Persist the found people!
        } else {
            state.stats.total = state.settings.targetCount;
        }

        // Re-confirm bottom position after scanning, then let content settle
        await scrollToBottomIncremental();

        // Also scroll last item into view
        if (currentCount > 0) {
            buttons[currentCount - 1].scrollIntoView({ behavior: 'auto', block: 'end' });
        }

        // Wait
        await wait(baseWait);

        // Calculate progress percentage
        const scrollPct = Math.min(95, Math.round((currentCount / linkedInTotal) * 100));

        // Check if we got new items
        if (currentCount > lastCount) {
            noChange = 0;
            lastCount = currentCount;
            lastCardElement = currentLastCard;
            baseWait = Math.max(200, baseWait - 30); // Speed up when loading

            let msg = `Loading... (${currentCount}/~${linkedInTotal})`;
            if (state.currentMode === 'age') {
                const unitLabel = state.settings.ageValue === 1 ? state.settings.ageUnit : state.settings.ageUnit + 's';
                msg = `Found ${matchCount} sent ${state.settings.ageValue} ${unitLabel} ago and older`;
            } else if (state.currentMode === 'message') {
                msg = `Found ${matchCount} matching message${matchCount !== 1 ? 's' : ''}`;
            }
            sendScrollProgress(currentCount, linkedInTotal, msg);
        } else {
            noChange++;

            // Early exit conditions to prevent unnecessary jiggling when near goal
            if (currentCount >= (linkedInTotal - 15) && noChange >= 1) {
                Logger.log('ClearConnect: Very near LinkedIn total count, proceeding early');
                break;
            }
            if (currentCount >= (linkedInTotal - 40) && noChange >= 2) {
                Logger.log('ClearConnect: Near LinkedIn total count, proceeding');
                break;
            }

            // CHECK FOR LOAD MORE PROACTIVELY IF STUCK OR NEAR BOTTOM
            if (noChange >= 2 || isAtScrollBottom()) {
                Logger.log('ClearConnect: Checking for Load More button...');
                const clicked = await clickLoadMoreButton();
                if (clicked) {
                    noChange = 0;
                    baseWait = Math.max(200, baseWait - 30);
                    continue; // Skip jiggle if we clicked
                }
            }

            // Only do jiggle when stuck (1+ attempts with no change)
            if (noChange % 2 === 1) {
                let msg = `Triggering load... (${noChange}/${maxRetries})`;
                sendScrollProgress(currentCount, linkedInTotal, msg);

                // RE-FIND CONTAINER: Layout might have shifted
                const newContainer = findScrollContainer();
                if (newContainer && newContainer !== scrollContainer) {
                    Logger.log('ClearConnect: Scroll container shifted, updating...');
                    scrollContainer = newContainer;
                }

                // Natural jiggle - smooth scroll up, pause, smooth scroll back
                // Deep jiggle if we've been stuck for a while to force intersection observer
                const jiggleAmount = noChange >= 5 ? -1200 : (noChange >= 3 ? -800 : -400);
                scrollBy(jiggleAmount);
                await wait(600);
                await scrollToBottomIncremental();
            } else {
                let msg = `Waiting for LinkedIn... (${noChange}/${maxRetries})`;
                sendScrollProgress(currentCount, linkedInTotal, msg);
            }

            baseWait = Math.min(1200, baseWait + 80); // Slow down when stuck
        }

        // BOTTOM DETECTION - Multiple checks
        const atBottom = isAtScrollBottom();
        const sameLastCard = lastCardElement === currentLastCard && currentLastCard !== null;

        // Conditions to break loop:
        // 1. We reached or exceeded the official total
        if (currentCount >= linkedInTotal) {
            Logger.log('ClearConnect: Reached LinkedIn total count, proceeding');
            break;
        }

        // 2. We are literally at scroll bottom, card unchanged, and we've waited enough (slow exit)
        // If we are far from the goal, wait longer before giving up
        const farFromGoal = currentCount < (linkedInTotal - 40);
        if (atBottom && sameLastCard) {
            if (!farFromGoal && noChange >= 5) {
                Logger.log('ClearConnect: At physical scroll bottom with no updates, proceeding');
                break;
            } else if (farFromGoal && noChange >= 12) {
                Logger.log('ClearConnect: At physical scroll bottom, far from goal, but giving up after 12 retries');
                break;
            }
        }

        // 5. Absolute timeout / stuck safety (very slow exit)
        if (noChange >= maxRetries) {
            Logger.log('ClearConnect: Stuck for too long, proceeding with what we have');
            break;
        }

        // Jiggle logic if stuck
        if (noChange >= 3) {
            // Redundant check removed to favor proactive check above
        }
    }

    // Send scroll complete
    chrome.runtime.sendMessage({ action: 'SCROLL_COMPLETE', count: lastCount });
    await wait(200);
}

function sendScrollProgress(found, total, text) {
    const pct = total > 0 ? Math.min(95, Math.round((found / total) * 100)) : 0;
    chrome.runtime.sendMessage({
        action: 'SCROLL_PROGRESS',
        progress: pct,
        found: found,
        total: total,
        text: text || `Found ${found} of ~${total}`,
        foundMatches: state.currentMode === 'message' ? state.foundMatchingPeople.slice(0, 50) : [] // Limit to 50
    });
}

function findWithdrawButtons() {
    let buttons = [];

    // Check for learned override first
    if (selectorOverrides && selectorOverrides.withdraw) {
        const learned = findElementsByLearned(selectorOverrides.withdraw);
        if (learned.length > 0) buttons = learned;
    }

    // Primary: data-view-name selector (use cloud/learned override if available)
    if (buttons.length === 0) {
        const withdrawSel = getSelector('withdraw_button', 'button[data-view-name="sent-invitations-withdraw-single"]');
        buttons = Array.from(document.querySelectorAll(withdrawSel));
    }

    // Secondary: <a> tags with the same data-view-name (LinkedIn sometimes uses links styled as buttons)
    if (buttons.length === 0) {
        const withdrawLinkSel = getSelector('withdraw_button_link', 'a[data-view-name="sent-invitations-withdraw-single"]');
        const links = Array.from(document.querySelectorAll(withdrawLinkSel));
        if (links.length > 0) buttons = links;
    }

    // Tertiary: Heuristic text-based detection
    if (buttons.length === 0) {
        buttons = Array.from(document.querySelectorAll('button, a')).filter(b => {
            const text = (b.textContent || '').trim().toLowerCase();
            return text === 'withdraw';
        });
    }

    // Quaternary: Structural heuristic - find repeating card clusters containing profile links
    if (buttons.length === 0) {
        buttons = findWithdrawByStructure();
    }

    // Filter out already processed items (Debug Mode & Loop Prevention)
    buttons = buttons.filter(b => !b.classList.contains('cc-processed') && !b.closest('.cc-processed'));

    // DEDUPLICATION: One button per unique profile URL (DOM-structure independent)
    const seenUrls = new Set();
    const seenCards = new Set();
    const finalButtons = [];

    for (const btn of buttons) {
        // Primary dedup: profile URL (most reliable, structure-independent)
        const url = getProfileUrl(btn);
        if (url) {
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);
            finalButtons.push(btn);
            continue;
        }

        // Fallback dedup: card DOM reference (for elements without a profile URL)
        const card = findCard(btn);
        if (card) {
            if (seenCards.has(card)) continue;
            seenCards.add(card);
        }
        finalButtons.push(btn);
    }

    return finalButtons;
}

// Structural heuristic: Find withdraw buttons by analyzing repeating patterns in the DOM
function findWithdrawByStructure() {
    // Look for all links that go to /in/ profiles (strong signal we're on the right page)
    const profileLinks = Array.from(document.querySelectorAll('a[href*="/in/"]'));
    if (profileLinks.length < 2) return []; // Not enough to detect a pattern

    // Walk up from profile links to find the repeating container level
    const cardCandidates = new Map(); // parent -> [children]
    for (const link of profileLinks) {
        const card = findCard(link);
        if (card && card.parentElement) {
            const parent = card.parentElement;
            if (!cardCandidates.has(parent)) cardCandidates.set(parent, []);
            if (!cardCandidates.get(parent).includes(card)) {
                cardCandidates.get(parent).push(card);
            }
        }
    }

    // Find the parent with the most card-like children (the list container)
    let bestParent = null;
    let bestCount = 0;
    for (const [parent, cards] of cardCandidates) {
        if (cards.length > bestCount) {
            bestCount = cards.length;
            bestParent = parent;
        }
    }

    if (!bestParent || bestCount < 3) return [];

    // Within these cards, find elements that look like action buttons
    const cards = cardCandidates.get(bestParent);
    const withdrawButtons = [];
    for (const card of cards) {
        // Look for buttons/links with "Withdraw" text inside the card
        const btns = Array.from(card.querySelectorAll('button, a')).filter(b => {
            const text = (b.textContent || '').trim().toLowerCase();
            return text === 'withdraw' || text.includes('withdraw');
        });
        if (btns.length > 0) withdrawButtons.push(btns[0]);
    }

    return withdrawButtons;
}


// Regex to extract name from "X's profile picture" — handles ASCII and Unicode apostrophes
// LinkedIn uses U+2019 (RIGHT SINGLE QUOTATION MARK), not plain ASCII '
const PROFILE_PIC_RE = /^(.+?)[\u0027\u2018\u2019\u02bc]s profile picture$/i;

// Find the name element nearest to `button` from a set of learned candidates.
// Works even when findCard fails: walks up from button and returns the candidate
// that shares the narrowest ancestor with the button (i.e. exactly one candidate
// is contained at that ancestor level, meaning they're in the same card).
function getNameFromLearnedSelector(button, learnedInfo) {
    const candidates = findElementsByLearned(learnedInfo);
    if (candidates.length === 0) return null;

    // Fast path: if findCard works, use it
    const card = findCard(button);
    if (card) {
        const el = candidates.find(c => card.contains(c));
        if (el) {
            const text = (el.textContent || '').trim();
            if (text.length > 1 && text.length < 120) return text;
        }
    }

    // Fallback: walk up from button and stop at the ancestor that contains
    // exactly one candidate (= the card scope, even if findCard failed)
    let ancestor = button.parentElement;
    let depth = 0;
    while (ancestor && ancestor !== document.body && depth < 20) {
        const contained = candidates.filter(c => ancestor.contains(c));
        if (contained.length === 1) {
            const text = (contained[0].textContent || '').trim();
            if (text.length > 1 && text.length < 120) return text;
            break; // found the right scope but text is empty/bad — stop climbing
        }
        if (contained.length > 1) break; // too broad, stop
        ancestor = ancestor.parentElement;
        depth++;
    }
    return null;
}

function getPersonName(button) {
    // HIGHEST PRIORITY: user-trained learned selector (explicitly taught for current layout).
    // Checked first so Repair Layout overrides everything else after a LinkedIn update.
    if (selectorOverrides && selectorOverrides.name) {
        const name = getNameFromLearnedSelector(button, selectorOverrides.name);
        if (name) return name;
    }

    // RELIABLE FALLBACK: LinkedIn embeds the name in the Withdraw button's aria-label.
    // Format: "Withdraw invitation sent to [Name]" — no card lookup needed.
    const btnAria = button.getAttribute('aria-label') || '';
    const ariaMatch = btnAria.match(/^Withdraw invitation sent to (.+)$/i);
    if (ariaMatch) return ariaMatch[1].trim();

    const card = findCard(button);
    if (!card) return 'Unknown';

    // Profile link text (empty in newer LinkedIn UI where links only contain images)
    const nameLink = card.querySelector('a.db828f0d[href*="/in/"]');
    if (nameLink) {
        const text = nameLink.textContent.trim();
        if (text && text.length > 1) return text;
    }
    const links = card.querySelectorAll('a[href*="/in/"]');
    for (const link of links) {
        const text = link.textContent.trim();
        if (text && text.length > 1 && text.length < 50 && !text.startsWith('http')) {
            return text;
        }
    }

    // img[alt] — LinkedIn's profile photos include the person's name here
    const img = card.querySelector('img[alt*="profile picture"]');
    if (img) {
        const m = (img.getAttribute('alt') || '').match(PROFILE_PIC_RE);
        if (m) return m[1];
    }

    // SVG[aria-label] — fallback avatar SVGs use aria-label the same way
    const svg = card.querySelector('svg[aria-label*="profile picture"]');
    if (svg) {
        const m = (svg.getAttribute('aria-label') || '').match(PROFILE_PIC_RE);
        if (m) return m[1];
    }

    // figure[aria-label] — older LinkedIn layout
    const figure = card.querySelector('figure[aria-label*="profile picture"]');
    if (figure) {
        const m = (figure.getAttribute('aria-label') || '').match(PROFILE_PIC_RE);
        if (m) return m[1];
    }

    return 'Unknown';
}

// Get LinkedIn profile URL from connection card
function getProfileUrl(button) {
    const card = findCard(button);
    if (!card) return null;

    const link = card.querySelector('a[href*="/in/"]');
    if (link) {
        const href = link.getAttribute('href');
        // Ensure full URL
        if (href.startsWith('/')) {
            return 'https://www.linkedin.com' + href;
        }
        return href;
    }
    return null;
}

function getAge(button) {
    const card = findCard(button);
    if (!card) return null;

    let text = (card.textContent || '').trim();

    if (selectorOverrides && selectorOverrides.age) {
        const learnedEls = findElementsByLearned(selectorOverrides.age);
        const ageEl = learnedEls.find(el => card.contains(el));
        if (ageEl && ageEl.textContent) {
            text = ageEl.textContent.trim();
        }
    }

    // Check for "Sent yesterday"
    if (text.match(/Sent[\s\u00A0]+yesterday/i)) {
        return { value: 1, unit: 'day', text: 'Sent yesterday' };
    }

    // Relaxed Regex: Optional "Sent", Optional "a/an", Mandatory "ago"
    // Matches: "Sent 3 months ago", "3 months ago", "1 year ago", "a month ago"
    const match = text.match(/(?:Sent[\s\u00A0]+)?(\d+|a|an)[\s\u00A0]+(second|minute|hour|day|week|month|year)s?[\s\u00A0]+ago/i);
    if (match) {
        let val = 1;
        const numStr = match[1].toLowerCase();
        if (numStr !== 'a' && numStr !== 'an') {
            val = parseInt(numStr);
        }

        const unit = match[2].toLowerCase();
        // Construct standard string
        const display = `Sent ${val} ${unit}${val > 1 ? 's' : ''} ago`;
        return { value: val, unit: unit, text: display };
    }

    // Debug info handling for "Unknown"
    // Logger.log('Unknown age text:', text.substring(0, 50));

    return null;
}

function isSafe(button) {
    // If safe mode is disabled, everything is safe
    if (!state.settings.safeMode) return true;

    const age = getAge(button);
    if (!age) return false;

    let ageInMonths = 0;
    if (age.unit === 'year') ageInMonths = age.value * 12;
    else if (age.unit === 'month') ageInMonths = age.value;
    else if (age.unit === 'week') ageInMonths = age.value / 4;
    else if (age.unit === 'day') ageInMonths = age.value / 30;
    else return true; // hour/minute/second = very recent, always safe (too new to withdraw)

    let thresholdMonths = 0;
    if (state.settings.safeUnit === 'year') thresholdMonths = state.settings.safeThreshold * 12;
    else if (state.settings.safeUnit === 'month') thresholdMonths = state.settings.safeThreshold;
    else if (state.settings.safeUnit === 'week') thresholdMonths = state.settings.safeThreshold / 4;
    else if (state.settings.safeUnit === 'day') thresholdMonths = state.settings.safeThreshold / 30;
    return ageInMonths > thresholdMonths;
}

function shouldStop(button) {
    if (state.currentMode === 'count') {
        return state.stats.processed >= state.settings.targetCount;
    } else {
        const age = getAge(button);
        if (!age) return true;

        // Convert connection age to days
        let connectionAgeDays = 0;
        if (age.unit === 'year') connectionAgeDays = age.value * 365;
        else if (age.unit === 'month') connectionAgeDays = age.value * 30;
        else if (age.unit === 'week') connectionAgeDays = age.value * 7;
        else if (age.unit === 'day') connectionAgeDays = age.value;
        else if (age.unit === 'hour' || age.unit === 'minute' || age.unit === 'second') connectionAgeDays = 0;
        else return true;

        // Convert threshold to days
        let thresholdDays = 0;
        let ageVal = state.settings.ageValue;
        let ageUnt = state.settings.ageUnit;

        if (ageUnt === 'year') thresholdDays = ageVal * 365;
        else if (ageUnt === 'month') thresholdDays = ageVal * 30;
        else if (ageUnt === 'week') thresholdDays = ageVal * 7;
        else if (ageUnt === 'day') thresholdDays = ageVal;

        // Stop if connection is newer than threshold (fewer days old)
        return connectionAgeDays < thresholdDays;
    }
}

async function processNext() {
    if (!state.isRunning) return;

    const buttons = findWithdrawButtons();

    if (buttons.length === 0) {
        complete('No withdraw buttons found.', {}, 'error');
        return;
    }

    // For message mode, find a matching button from bottom (oldest)
    let btn;
    if (state.currentMode === 'message') {
        // Scan from bottom to find first matching message
        for (let i = buttons.length - 1; i >= 0; i--) {
            if (matchesMessagePattern(buttons[i])) {
                btn = buttons[i];
                break;
            }
        }
        if (!btn) {
            if (state.stats.processed === 0) {
                complete('No connections found matching your message patterns.', {}, 'success');
            } else {
                complete(`Done! Cleared all ${state.stats.processed} matching connections.`);
            }
            return;
        }
    } else {
        btn = buttons[buttons.length - 1];
    }

    const personName = getPersonName(btn);
    const age = getAge(btn);
    const ageText = age ? (age.text || `Sent ${age.value} ${age.unit}${age.value > 1 ? 's' : ''} ago`) : 'unknown';

    if (state.currentMode === 'count' && state.stats.processed >= state.settings.targetCount) {
        complete();
        return;
    }

    // Wait if paused
    while (state.isPaused && state.isRunning) {
        await wait(500);
    }
    if (!state.isRunning) return;

    if (state.currentMode === 'age' && shouldStop(btn)) {
        if (state.stats.processed === 0) {
            const unitLabel = state.settings.ageValue === 1 ? state.settings.ageUnit : state.settings.ageUnit + 's';
            complete(`There were no connections older than ${state.settings.ageValue} ${unitLabel}`, { oldestRemaining: age }, 'partial');
        } else {
            complete(`Age limit reached at ${personName} (${ageText}).`, { oldestRemaining: age }, 'success');
        }
        return;
    }

    if (!isSafe(btn)) {
        complete(`Safety stop: ${personName} (${ageText}) is too recent.`, {}, 'safety');
        return;
    }

    const total = state.stats.total > 0 ? state.stats.total : 0;
    const progressPct = total > 0 ? Math.round((state.stats.processed / total) * 100) : 0;

    updateStatus(`[${state.stats.processed + 1}/${total || '?'}] ${personName}`, progressPct, {
        name: personName,
        age: ageText,
        status: 'active'
    });

    highlightConnection(btn, 'active');
    await wait(50);

    let confirmed = false;

    if (state.settings.debugMode) {
        // Debug mode: Just highlight the button, don't click
        const card = findCard(btn);

        // Highlight active processing
        if (card) {
            card.style.transition = 'background 0.3s, border 0.3s';
            card.style.backgroundColor = '#fff3cd'; // Yellow processing
            card.style.border = '2px solid #ffc107';
        }
        btn.style.transition = 'all 0.3s';
        btn.style.backgroundColor = '#ffc107';
        btn.style.color = '#000';
        btn.style.fontWeight = 'bold';

        await wait(1500); // Simulate processing time (Slower for visibility)
        confirmed = true; // Pretend it was successful

        // Mark as processed (Red) instead of hiding
        // This allows findWithdrawButtons to filter it out, moving the "cursor" up
        if (card) {
            card.classList.add('cc-processed');
            card.style.backgroundColor = '#fee2e2'; // Red/Pink processed
            card.style.border = '1px solid #e5e7eb'; // Reset border
            card.style.opacity = '0.6';
        }
        btn.classList.add('cc-processed'); // Mark button directly too
        btn.style.backgroundColor = '#ef4444'; // Red button
        btn.style.color = 'white';
        btn.innerText = 'Debug Cleared';

        // NOTE: We do NOT increment state.stats.processed here
        // We let the shared 'if (confirmed)' block handle it below
        // ensuring parity with Real Mode.

    } else {
        // Normal mode: Actually click the button
        btn.click();
        confirmed = await waitAndClickDialogConfirm();
        
        if (confirmed) {
            // Mark as processed so we don't accidentally click it again if LinkedIn is slow to remove it
            const card = findCard(btn);
            if (card) card.classList.add('cc-processed');
            btn.classList.add('cc-processed');

            // Wait for the LinkedIn modal/UI to actually clear up
            await waitForDialogToClose();
        }
    }

    if (confirmed) {
        state.stats.processed++;
        state.stats.oldestCleared = ageText;
        retryCount = 0;

        // Get profile URL for history
        const profileUrl = getProfileUrl(btn);

        // Record to history storage
        await recordWithdrawal(personName, profileUrl, ageText);

        // Send status with full cleared data for UI update
        const progressPctAfter = total > 0 ? Math.round((state.stats.processed / total) * 100) : 0;
        const statusPrefix = state.settings.debugMode ? '[DEBUG] ' : '';
        updateStatus(`${statusPrefix}[${state.stats.processed}/${total || '?'}] Cleared ${personName}`, progressPctAfter, {
            name: personName,
            age: ageText,
            profileUrl: profileUrl,
            status: 'completed'
        });

        await wait(actionDelay);
        processNext();
    } else {
        retryCount++;
        if (retryCount >= 5) {
            complete('Error: Could not confirm withdrawal. Selectors may need updating.', {}, 'error');
            return;
        }
        updateStatus(`Retrying ${personName}...`, state.status.progress);
        await wait(800);
        processNext();
    }
}

async function waitAndClickDialogConfirm() {
    const maxWait = 6000 + (retryCount * 1500);
    const checkInterval = 100;
    let waited = 0;

    // Give the modal animation time to start before we begin polling
    await wait(100);

    while (waited < maxWait) {
        // Learned selector from Repair Layout takes highest priority.
        // Verify it's inside an actual open dialog so we don't click a stale element.
        if (selectorOverrides && selectorOverrides.confirm_withdraw) {
            const learnedBtn = findElementsByLearned(selectorOverrides.confirm_withdraw)[0];
            const dialogSel = getSelector('dialog_open', 'dialog[open]');
            const legacySel = getSelector('modal_legacy', '.artdeco-modal');
            if (learnedBtn && (learnedBtn.closest(dialogSel) || learnedBtn.closest(legacySel))) {
                learnedBtn.click();
                return true;
            }
        }

        // LinkedIn's withdrawal confirmation uses a native <dialog open> element.
        // The confirm button carries aria-label="Withdraw invitation sent to [Name]".
        const dialogSel = getSelector('dialog_open', 'dialog[open]');
        const modal = document.querySelector(dialogSel);
        if (modal) {
            // Most specific: aria-label starts with "Withdraw invitation sent to"
            const confirmSel = getSelector('confirm_button_aria', 'button[aria-label^="Withdraw invitation sent to"]');
            const ariaBtn = modal.querySelector(confirmSel);
            if (ariaBtn) { ariaBtn.click(); return true; }

            // Text fallback: button whose visible text is exactly "Withdraw"
            const allBtns = Array.from(modal.querySelectorAll('button'));
            const txtBtn = allBtns.find(b => (b.textContent || '').trim().toLowerCase() === 'withdraw');
            if (txtBtn) { txtBtn.click(); return true; }

            // data-view-name fallback (older LinkedIn builds)
            const dvBtn = modal.querySelector('[data-view-name*="withdraw"] button, button[data-view-name*="withdraw"]');
            if (dvBtn) { dvBtn.click(); return true; }
        }

        // Legacy artdeco-modal fallback for older LinkedIn UI versions
        const legacyModalSel = getSelector('modal_legacy', '.artdeco-modal');
        const legacyModal = document.querySelector(legacyModalSel);
        if (legacyModal) {
            const ariaBtn = legacyModal.querySelector('button[aria-label^="Withdraw invitation sent to"]');
            if (ariaBtn) { ariaBtn.click(); return true; }
            const txtBtn = Array.from(legacyModal.querySelectorAll('button'))
                .find(b => (b.textContent || '').trim().toLowerCase() === 'withdraw');
            if (txtBtn) { txtBtn.click(); return true; }
        }

        await wait(checkInterval);
        waited += checkInterval;
    }

    return false;
}

async function waitForDialogToClose() {
    const maxWait = 5000;
    const checkInterval = 100;
    let waited = 0;

    while (waited < maxWait) {
        const dialogSel = getSelector('dialog_open', 'dialog[open]');
        const legacySel = getSelector('modal_legacy', '.artdeco-modal');
        const dialog = document.querySelector(`${dialogSel}, ${legacySel}`);
        if (!dialog) {
            // Brief pause for LinkedIn DOM to settle before next withdrawal
            await wait(100);
            return true;
        }
        await wait(checkInterval);
        waited += checkInterval;
    }
    return false;
}

function complete(message, extraStats = {}, stopType = 'success') {
    state.isRunning = false;
    state.isPaused = false;
    state.subMode = 'idle';

    // Use official LinkedIn count if available, otherwise fallback to loaded buttons
    const linkedInCount = getLinkedInTotalCount();
    const remaining = linkedInCount !== null ? linkedInCount : findWithdrawButtons().length;

    // Update final stats
    state.stats.remaining = remaining;
    if (linkedInCount !== null) {
        state.stats.pendingInvitations = linkedInCount;
        state.stats.pendingUpdatedAt = Date.now();
    }

    state.status.text = message || `Done! Cleared ${state.stats.processed}.`;

    const resultMsg = message || `Done! Cleared ${state.stats.processed} connections.`;

    // Final State to Send (Crucial for Results Page)
    // Make sure sessionCleared is up to date
    const finalState = {
        ...state,
        uiNavigation: {
            ...state.uiNavigation,
            currentTab: 'completed' // FORCE completed tab in payload
        },
        lastRunResult: {
            processed: state.stats.processed,
            oldestCleared: state.stats.oldestCleared,
            timestamp: Date.now(),
            stopType: stopType,
            message: resultMsg
        }
    };
    state.lastRunResult = finalState.lastRunResult;
    // We already set this logic below, but setting it in 'finalState' ensures
    // the UI receives the correct navigation instruction immediately.

    saveState();

    try {
        chrome.runtime.sendMessage({
            action: 'COMPLETE',
            result: finalState.lastRunResult,
            state: finalState // Send full state WITH currentTab='completed'
        });
    } catch (e) { }

    // Navigate to completed/results view
    state.uiNavigation = state.uiNavigation || {};
    state.uiNavigation.currentTab = 'completed';

    // Persist completed state to storage
    saveState();
}

function updateStatus(text, progress, clearedData = null, partialResults = null) {
    state.status.text = text;
    state.status.progress = progress;

    // Add to session log if we have cleared data
    if (clearedData) {
        // Only add if "active" or "completed" logic matches what we want to show
        // We want to keep a history of "active" -> "completed" transitions
        // For simple log, just pushing the object is fine.

        // Check if item already exists to update status?
        const existingIdx = state.sessionLog.findIndex(i => i.name === clearedData.name);
        if (existingIdx > -1) {
            state.sessionLog[existingIdx] = { ...state.sessionLog[existingIdx], ...clearedData };
        } else {
            state.sessionLog.push({ ...clearedData, timestamp: Date.now() });

            // Increment alltimeCleared for new withdrawals (ONLY IN LIVE MODE)
            if (!state.settings.debugMode) {
                state.stats.alltimeCleared = (state.stats.alltimeCleared || 0) + 1;
            }

            // Add to sessionCleared for persistent Results list
            if (!state.sessionCleared) state.sessionCleared = [];
            state.sessionCleared.push(clearedData);
        }

        // Limit log size (keep last 50)
        if (state.sessionLog.length > 50) {
            state.sessionLog.shift();
        }

        // Update pending count from live page data
        const liveCount = getLinkedInTotalCount();
        if (liveCount !== null) {
            state.stats.pendingInvitations = liveCount;
            state.stats.pendingUpdatedAt = Date.now();
        }
    }

    // Send legacy message for immediate UI updates (backwards compact)
    // BUT we also broadcast full state for anyone listening for state updates

    // Legacy support might not be needed if we fully refactor popup, 
    // but keeping specific event for granular updates is efficient.
    const msg = { action: 'UPDATE_STATUS', text, progress };
    if (clearedData) {
        msg.clearedData = clearedData;
        // Legacy
        msg.clearedName = clearedData.name;
        msg.clearedAge = clearedData.age;
    }
    if (partialResults) {
        msg.partialResults = partialResults;
    }
    chrome.runtime.sendMessage(msg).catch(() => { });

    // Persist state to storage (source of truth)
    saveState();
}

// Record withdrawal to history storage
async function recordWithdrawal(name, profileUrl, age, project = null) {
    // SECURITY: Do not record history in Debug Mode
    if (state.settings.debugMode) return;

    try {
        const result = await chrome.storage.local.get(['withdrawalHistory', 'currentSessionId']);
        let history = result.withdrawalHistory || [];
        let sessionId = result.currentSessionId;

        const now = new Date();
        const todaySessionId = now.toISOString().split('T')[0]; // YYYY-MM-DD

        // Create new session if needed
        if (sessionId !== todaySessionId) {
            sessionId = todaySessionId;
            await chrome.storage.local.set({ currentSessionId: sessionId });
            history.push({
                sessionId: sessionId,
                sessionDate: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
                mode: state.currentMode,
                withdrawals: []
            });
        }

        // Find current session
        let session = history.find(s => s.sessionId === sessionId);
        if (!session) {
            session = {
                sessionId: sessionId,
                sessionDate: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
                mode: state.currentMode,
                withdrawals: []
            };
            history.push(session);
        }

        // Add withdrawal record
        session.withdrawals.push({
            name: name,
            profileUrl: profileUrl,
            withdrawnAt: now.toISOString(),
            age: age,
            project: project
        });

        // Keep only last 100 sessions
        if (history.length > 100) {
            history = history.slice(-100);
        }

        await chrome.storage.local.set({ withdrawalHistory: history });
    } catch (e) {
        Logger.error('ClearConnect: Failed to record withdrawal', e);
    }
}

function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Reactive wait that polls for content changes (height or count)
 * Returns immediately when change is detected or timeout is reached.
 */
async function waitForContentChange(lastHeight, lastCount, maxWait = 2500) {
    const start = Date.now();
    const pollInterval = 100;

    while (Date.now() - start < maxWait) {
        if (!state.isRunning) return false;

        const currentHeight = getScrollHeight();
        const currentCount = findWithdrawButtons().length;

        if (currentHeight > lastHeight + 50 || currentCount > lastCount) {
            return true; // Content loaded!
        }

        await wait(pollInterval);
    }
    return false; // Timed out
}

// Check for "Hi [Name]," or "Hello [Name]," greeting
/**
 * Aggressive normalization for grouping messages.
 * Collapses whitespace, lowercases, strips greetings and names, and masks variable data.
 */
function normalizeMessage(text) {
    if (!text) return '';

    // 1. Lowercase and collapse whitespace
    let normalized = text.toLowerCase().trim()
        .replace(/\s+/g, ' '); // Collapse tabs, newlines, multiple spaces

    // 2. Normalize greetings and recipient names
    // Matches "hi [name],", "hello [name]!", etc. handles names up to 40 chars
    // Includes "reaching out about" as it often precedes the name or recipient context
    // Hyphens (-) are allowed in names (e.g. Ching-Wen)
    const greetingMatch = normalized.match(/^((?:hi|hello|hey|dear|good morning|good afternoon|good evening|reaching out about|use of)\s+)([^,:\!\-\u2013\u2014]{1,40}?)([,:\!\-\u2013\u2014]\s*)/i);
    if (greetingMatch) {
        // greetingMatch[1] is "hi ", [2] is name, [3] is suffix like ","
        normalized = greetingMatch[1] + '[firstname]' + greetingMatch[3] + normalized.substring(greetingMatch[0].length).trim();
    }

    // 3. Mask variable data to prevent group splitting
    // Currency: $100, $1,000.00 -> [amount]
    normalized = normalized.replace(/\$\d+(?:,\d{3})*(?:\.\d+)?/g, '[amount]');

    // Phone numbers: +1 (555) 010-1234, 555-010-5678 -> [phone]
    normalized = normalized.replace(/(?:\+?\d{1,2}\s?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '[phone]');

    // Links: https://calendar.app.google/... -> [link]
    normalized = normalized.replace(/https?:\/\/[^\s]+/g, '[link]');

    // 4. Strip punctuation for grouping (helps "Topic." vs "Topic")
    // Keep internal punctuation but strip trailing/leading
    normalized = normalized.replace(/[.!?]+$/, '').trim();

    return normalized;
}


function hashMessage(text) {
    // Simple hash for grouping
    let hash = 0, i, chr;
    if (text.length === 0) return hash;
    for (i = 0; i < text.length; i++) {
        chr = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0; // Convert to 32bit integer
    }
    return hash.toString();
}

// Visual highlighting
function highlightConnection(element, type) {
    const card = findCard(element);
    if (!card) return;

    // Remove existing
    card.classList.remove('cc-highlight-processing', 'cc-highlight-skip', 'cc-highlight-active');

    if (type === 'processing') {
        card.classList.add('cc-highlight-processing');
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Add temporary visual flash
        const originalBg = card.style.backgroundColor;
        card.style.transition = 'background 0.5s';
        card.style.backgroundColor = '#fff3cd'; // Light yellow
        setTimeout(() => {
            if (card.classList.contains('cc-highlight-processing')) {
                card.style.backgroundColor = originalBg || '';
            }
        }, 2000);
    } else if (type === 'active') {
        card.classList.add('cc-highlight-active');
        card.style.transition = 'background 0.3s, border 0.3s';
        card.style.backgroundColor = '#fee2e2'; // Light red background
        card.style.border = '2px solid #ef4444'; // Bright red border
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (type === 'skip') {
        card.classList.add('cc-highlight-skip');
    }
}

// Scan all connections and index messages
async function scanConnections() {
    state.subMode = 'scanning';
    updateStatus('Scanning: Starting...', 0);

    // Reset found list
    foundScanResults = [];

    // Scroll and Index Loop
    let previousHeight = 0;
    let noChangeCount = 0;
    const maxScrolls = 200; // Safety limit

    scrollContainer = findScrollContainer();
    Logger.log('ClearConnect: Scanning using container', scrollContainer);

    for (let i = 0; i < maxScrolls; i++) {
        if (!state.isRunning) break;

        // PROACTIVE BUTTON CHECK: Fast scan support
        if (await clickLoadMoreButton()) {
            noChangeCount = 0;
        }

        const lastHeight = getScrollHeight();
        const lastCount = findWithdrawButtons().length;

        // Scroll to bottom in viewport-sized steps so LinkedIn's IntersectionObserver
        // fires at every position — same effect as holding the spacebar.
        await scrollToBottomIncremental();

        // Brief settle wait after reaching the bottom for any batch-loaded content.
        await waitForContentChange(lastHeight, lastCount, 1500);

        // Check for growth
        const currentHeight = getScrollHeight();

        // Index current visible buttons to update status in real-time
        const buttons = findWithdrawButtons();
        const tempGroups = {}; // Temporary for status update
        let projectCount = 0;

        // We only do a "rough" pass here for status updates
        // The detailed extraction happens at the VERY END to ensure accuracy
        for (const btn of buttons) {
            const msg = normalizeMessage(getConnectionMessage(btn));
            if (!msg) continue;
            const hash = hashMessage(msg);

            if (!tempGroups[hash]) {
                tempGroups[hash] = {
                    count: 0,
                    message: msg,
                    id: hash
                };
                projectCount++;
            }
            tempGroups[hash].count++;
        }

        // Build partialResults for live display
        const partialResults = Object.values(tempGroups).map(g => ({
            id: g.id,
            message: g.message,
            count: g.count
        }));

        // Calculate progress percentage
        const linkedInTotal = getLinkedInTotalCount() || (buttons.length + 100); // Fallback if 0
        const progressPct = Math.min(95, Math.ceil((buttons.length / linkedInTotal) * 100));

        updateStatus(
            `Found ${projectCount} distinct groups (${buttons.length}/${linkedInTotal})...`,
            progressPct,
            null,
            partialResults
        );

        // Track progress strictly by button count growth, not container height
        if (buttons.length <= lastCount) { 
            noChangeCount++;

            const officialTotal = getLinkedInTotalCount();
            const loadedCount = buttons.length;
            const targetTotal = state.settings.targetCount || 999999;
            const absoluteTotal = officialTotal ? Math.min(officialTotal, targetTotal) : targetTotal;

            // 1. Did we reach the target?
            if (loadedCount >= absoluteTotal) {
                Logger.log('ClearConnect: Reached target count, stopping.');
                break;
            }

            // 2. Fuzzy stop if we know the official total (matching Count Mode logic)
            if (officialTotal) {
                if (loadedCount >= (officialTotal - 15) && noChangeCount >= 1) {
                    Logger.log('ClearConnect: Very near LinkedIn total count, proceeding early');
                    break;
                }
                if (loadedCount >= (officialTotal - 40) && noChangeCount >= 2) {
                    Logger.log('ClearConnect: Near LinkedIn total count, proceeding');
                    break;
                }
            }

            // 3. Jiggle logic (every odd noChange)
            // Skip jiggle if we are very close to the target count (within 20)
            const isNearTarget = officialTotal ? (loadedCount >= officialTotal - 20) : false;
            if (noChangeCount % 2 === 1 && !isNearTarget) {
                Logger.log('ClearConnect: Scanning stuck, checking for Load More button...');
                const clicked = await clickLoadMoreButton();
                if (clicked) {
                    noChangeCount = 0;
                    continue;
                }

                // RE-FIND CONTAINER
                const newContainer = findScrollContainer();
                if (newContainer && newContainer !== scrollContainer) {
                    scrollContainer = newContainer;
                }

                Logger.log(`ClearConnect: Jiggling scroll... (${noChangeCount}/15)`);
                const jiggleAmount = noChangeCount >= 5 ? -1200 : (noChangeCount >= 3 ? -800 : -400);

                if (scrollContainer && scrollContainer !== document.body) {
                    scrollContainer.scrollBy({ top: jiggleAmount, behavior: 'smooth' });
                } else {
                    window.scrollBy({ top: jiggleAmount, behavior: 'smooth' });
                }
                await wait(600);
                await scrollToBottomIncremental();
            }

            // 4. Ultimate give up
            if (noChangeCount >= 15) {
                Logger.log('ClearConnect: Reached max retries on stuck scan.');
                break;
            }
        } else {
            noChangeCount = 0;
        }
        previousHeight = currentHeight;
    }

    if (!state.isRunning) return;

    // Final Indexing - The Truth
    updateStatus('Finalizing index...', 95);
    const buttons = findWithdrawButtons();
    const groups = {}; // hash -> { count, fullMessage, ageRange, people: [] }

    for (const btn of buttons) {
        const fullMsg = getConnectionMessage(btn);
        // Skip empty messages
        if (!fullMsg || fullMsg.trim().length === 0) continue;

        const normMsg = normalizeMessage(fullMsg);

        // Skip messages that become empty after normalization (e.g. just "Hi John,")
        // Unless we want to show them? User said "No undefined/general list items".
        if (normMsg.length === 0) continue;

        const hash = hashMessage(normMsg);
        const age = getAge(btn);
        const ageText = age ? age.text : 'Unknown';

        // Extract person details
        const name = getPersonName(btn);
        let profileUrl = getProfileUrl(btn) || '';
        if (profileUrl) {
            try {
                const urlObj = new URL(profileUrl);
                profileUrl = urlObj.origin + urlObj.pathname;
            } catch (e) { }
        }

        // Create unique ID for this person-message instance
        const personId = hashMessage(profileUrl + name + normMsg);

        if (!groups[hash]) {
            groups[hash] = {
                id: hash,
                message: normMsg,
                fullMessage: fullMsg,
                count: 0,
                sortValue: Infinity, // Min age in seconds (for sorting newest first)
                ages: [],
                people: []
            };
        }

        // Deduplicate by personId to guard against DOM returning the same card twice
        if (groups[hash].people.some(p => p.id === personId)) continue;

        groups[hash].count++;
        groups[hash].ages.push(ageText);

        // Calculate age value for sorting
        let ageSeconds = Infinity;
        if (age) {
            let val = age.value;
            if (age.unit === 'year') val *= 31536000;
            else if (age.unit === 'month') val *= 2592000;
            else if (age.unit === 'week') val *= 604800;
            else if (age.unit === 'day') val *= 86400;
            else if (age.unit === 'hour') val *= 3600;
            else if (age.unit === 'minute') val *= 60;
            else if (age.unit === 'second') val *= 1;
            ageSeconds = val;
        }

        // Keep the smallest age (most recent) for the group
        if (ageSeconds < groups[hash].sortValue) {
            groups[hash].sortValue = ageSeconds;
        }

        groups[hash].people.push({
            name: name,
            age: ageText,
            profileUrl: profileUrl,
            id: personId
        });
    }

    // Convert to array and Sort by Age (Newest First -> Smallest sortValue)
    const results = Object.values(groups).sort((a, b) => {
        // Primary: Sort by Age (Ascending sortValue = Newest First)
        if (a.sortValue !== b.sortValue) {
            return a.sortValue - b.sortValue;
        }
        // Secondary: Count (Descending)
        return b.count - a.count;
    });

    chrome.runtime.sendMessage({
        action: 'SCAN_COMPLETE',
        results: results,
        totalScanned: buttons.length
    }).catch(() => { });

    state.isRunning = false;
    state.subMode = 'idle';
    broadcastState('STATE_UPDATE');
}

function showConnection(hash) {
    const buttons = findWithdrawButtons();
    for (const btn of buttons) {
        // Try to match Person ID first
        const name = getPersonName(btn);
        const fullMsg = getConnectionMessage(btn) || '';
        const normMsg = normalizeMessage(fullMsg);
        let profileUrl = getProfileUrl(btn) || '';
        if (profileUrl) {
            try {
                const urlObj = new URL(profileUrl);
                profileUrl = urlObj.origin + urlObj.pathname;
            } catch (e) { }
        }

        const personId = hashMessage(profileUrl + name + normMsg);

        if (personId === hash) {
            highlightConnection(btn, 'processing');
            return;
        }

        // Fallback: Message Hash Match (Legacy/Group view)
        // If the hash passed is just the message hash?
        // Unlikely to conflict as one is message-based, one is person-specific
        if (hashMessage(normMsg) === hash) {
            highlightConnection(btn, 'processing');
            // Don't return, keep looking? No, just show first? 
            // Ideally we want specific person.
            break;
        }
    }
}

// Withdraw selected groups
async function withdrawSelected(selectedHashes) {
    state.subMode = 'withdrawing';
    state.sessionCleared = []; // Reset session cleared list for new run
    const targetHashes = new Set(selectedHashes);
    const buttons = findWithdrawButtons(); // Working from existing list (assuming page hasn't changed much, but will verify)
    state.stats.total = buttons.length; // Approximate, effective total is matching count

    // Recalculate exact total for selected
    let matchingTotal = 0;

    // Valid selected people list for UI
    const validPeople = [];

    for (const btn of buttons) {
        const msg = normalizeMessage(getConnectionMessage(btn));
        if (targetHashes.has(hashMessage(msg))) {
            matchingTotal++;
            const name = getPersonName(btn);
            if (name) {
                validPeople.push({ name, age: getAge(btn)?.text || '-', message: msg, cleared: false });
            }
        }
    }
    state.stats.total = matchingTotal;

    // Reverse the list so it matches the processing order (Last button = First processed = Top of list)
    state.foundMatchingPeople = validPeople.reverse();
    saveState();

    // Work from BOTTOM UP
    state.stats.processed = 0;

    for (let i = buttons.length - 1; i >= 0; i--) {
        if (!state.isRunning) break;

        const btn = buttons[i];
        const msg = normalizeMessage(getConnectionMessage(btn));
        const hash = hashMessage(msg);

        if (targetHashes.has(hash)) {
            // MATCH - Process
            const personName = getPersonName(btn);
            const age = getAge(btn);
            const ageText = age ? age.text : '';

            // Safety check
            if (!isSafe(btn)) {
                complete(`Safety stop: ${personName} (${ageText}) was too recent... ${state.stats.processed} older connections cleared.`, {}, 'safety');
                state.isRunning = false;
                return;
            }

            // Wait if paused
            while (state.isPaused && state.isRunning) {
                await wait(500);
            }
            if (!state.isRunning) break;

            // Scroll to center for visibility
            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });

            highlightConnection(btn, 'active');

            // Highlight Withdraw Button
            const withdrawSpan = btn.querySelector('span');
            if (withdrawSpan) withdrawSpan.classList.add('cc-highlight-withdraw');

            // Send 'active' status for queue update
            updateStatus(`[${state.stats.processed + 1}/${state.stats.total}] ${personName}`, Math.round((state.stats.processed / state.stats.total) * 100), {
                name: personName,
                age: ageText,
                status: 'active'
            });

            await wait(300); // Visual delay

            let confirmed = false;

            if (state.settings.debugMode) {
                // Debug mode: highlight then mark as processed, don't click or hide
                const card = findCard(btn);
                if (card) {
                    card.style.transition = 'background 0.3s, border 0.3s';
                    card.style.backgroundColor = '#fff3cd'; // Yellow: processing
                    card.style.border = '2px solid #ffc107';
                }
                btn.style.transition = 'all 0.3s';
                btn.style.backgroundColor = '#ffc107';
                btn.style.color = '#000';
                btn.style.fontWeight = 'bold';

                await wait(1000);
                confirmed = true;

                // Mark as processed (red/pink) -- same as count/age debug mode
                if (card) {
                    card.classList.add('cc-processed');
                    card.style.backgroundColor = '#fee2e2';
                    card.style.border = '1px solid #e5e7eb';
                    card.style.opacity = '0.6';
                }
                btn.classList.add('cc-processed');
                btn.style.backgroundColor = '#ef4444';
                btn.style.color = 'white';
                btn.innerText = 'Debug Cleared';
            } else {
                // Normal mode: Actually click
                btn.click();
                confirmed = await waitAndClickDialogConfirm();
            }

            if (confirmed) {
                state.stats.processed++;
                // Record to history with project/topic
                const profileUrl = getProfileUrl(btn);
                const projectName = msg.length > 60 ? msg.substring(0, 60) + '...' : msg;
                await recordWithdrawal(personName, profileUrl, ageText, projectName);

                // Send 'completed' status for queue update
                const statusPrefix = state.settings.debugMode ? '[DEBUG] ' : '';
                updateStatus(`${statusPrefix}[${state.stats.processed}/${state.stats.total}] Cleared ${personName}`, Math.round((state.stats.processed / state.stats.total) * 100), {
                    name: personName,
                    age: ageText,
                    status: 'completed'
                });

                // Remove highlight? Element might be gone/detached
            }

            await wait(actionDelay);

        } else {
            // SKIP
            highlightConnection(btn, 'skip');
            // fast continue
        }
    }

    complete(`Done! Cleared ${state.stats.processed} selected connections.`);
}
// Listen for external storage changes (e.g. settings updated in popup)
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.extension_state) {
        const newState = changes.extension_state.newValue;
        if (!newState) return;

        // Sync settings -- but only when NOT actively running to avoid
        // overwriting runtime values (e.g. debugMode) set by a message handler
        if (newState.settings && !state.isRunning) {
            const wasDebug = state.settings.debugMode;
            state.settings = { ...state.settings, ...newState.settings };
            Logger.DEBUG = state.settings.debugMode === true;
            // If debug mode was just turned off, strip visual markers immediately
            if (wasDebug && !state.settings.debugMode) clearDebugStyling();
            Logger.log('ClearConnect: Synced settings from storage');
        }

        // Sync stats (if we aren't the ones currently running/updating them)
        if (!state.isRunning && newState.stats) {
            state.stats = { ...state.stats, ...newState.stats };
        }

        // Sync navigation (to keep track of where we are if popup moves us)
        if (newState.uiNavigation) {
            state.uiNavigation = { ...state.uiNavigation, ...newState.uiNavigation };
        }
    }
});
