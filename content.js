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
let actionDelay = 600;
let baseWait = 300;
let retryCount = 0;
let scrollContainer = null;
// foundMatchingPeople moved to state.foundMatchingPeople

// Save state to chrome.storage.local (source of truth)
async function saveState() {
    try {
        await chrome.storage.local.set({ extension_state: state });
    } catch (e) {
        console.error('ClearConnect: Failed to save state', e);
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
            // Merge stored state into current state
            Object.assign(state, extension_state);

            // Migrate legacy alltimeCleared if it exists and state doesn't have it
            if (legacyCleared && !state.stats.alltimeCleared) {
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
        console.error('ClearConnect: Failed to restore state', e);
    }
})();


// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'START_WITHDRAW') {
        if (state.isRunning) return;

        // Batch Start Logic: Track where this new run begins relative to history
        // If continuing, we want to slice the queue from here.
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
        // Immediate Mode Support (User requested "direct to withdrawing")
        const isImmediate = message.immediate === true;
        state.subMode = isImmediate ? 'withdrawing' : 'scanning';
        state.lastError = null;

        state.settings.targetCount = message.count || 999999;
        state.settings.ageValue = message.ageValue || 3;
        state.settings.ageUnit = message.ageUnit || 'month';
        state.settings.safeMode = message.safeMode !== false;
        state.settings.safeThreshold = message.safeThreshold || 1;
        state.settings.safeUnit = message.safeUnit || 'month';
        state.settings.messagePatterns = message.messages || [];
        state.settings.debugMode = message.debugMode === true;

        state.stats.processed = 0;
        state.stats.total = 0; // Will be determined
        state.stats.oldestCleared = '-';
        state.stats.startTime = Date.now();

        state.status.text = "Starting...";
        state.status.progress = 0;
        state.sessionLog = []; // Reset log on new run? Or keep? Reset for new run seems safer.
        state.lastRunResult = null; // Clear previous run result when starting new run

        if (!isImmediate) {
            state.sessionCleared = []; // New session: Clear history
        }
        // else: Keep sessionCleared to append new results

        // specific resets
        retryCount = 0;
        baseWait = 300;
        scrollContainer = null;

        // Save state and start
        saveState();
        startProcess(isImmediate);

    } else if (message.action === 'STOP_WITHDRAW') {
        const msg = state.stats.processed > 0 ?
            `Stopped by user, ${state.stats.processed} withdrawn.` :
            'Stopped by user.';
        complete(msg, {}, 'manual');

    } else if (message.action === 'GET_STATUS') {
        // Return full state for hydration
        sendResponse(state);

    } else if (message.action === 'GET_COUNT') {
        const countEl = document.querySelector('.mn-invitations-preview__header .t-black--light');
        const count = countEl ? parseInt(countEl.innerText.replace(/[^0-9]/g, '')) : 0;
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
        state.sessionLog = []; // Reset log
        saveState();
        scanConnections();

    } else if (message.action === 'WITHDRAW_SELECTED') {
        if (state.isRunning) return;
        state.isRunning = true;
        state.currentMode = 'message';
        state.subMode = 'withdrawing';

        state.settings.debugMode = message.debugMode === true;
        state.settings.safeMode = message.safeMode !== false;
        state.settings.safeThreshold = message.safeThreshold !== undefined ? message.safeThreshold : 1;
        state.settings.safeUnit = message.safeUnit || 'month';

        state.sessionLog = []; // Reset log
        saveState();
        withdrawSelected(message.selectedHashes);

    } else if (message.action === 'SHOW_CONNECTION') {
        showConnection(message.hash);

    } else if (message.action === 'GET_PENDING_COUNT') {
        // Return the current pending count from the page
        const count = getLinkedInTotalCount();
        sendResponse({ count: count });
        return true; // Keep channel open for async response
    }
});

function getLinkedInTotalCount() {
    // Parse "People (1,100)" from the nav
    const navBtn = document.querySelector('nav button[aria-current="true"]');
    if (navBtn) {
        const text = navBtn.textContent || '';
        const match = text.match(/People\s*\(([0-9,]+)\)/i);
        if (match) {
            return parseInt(match[1].replace(/,/g, ''), 10);
        }
    }
    // Also try span inside nav
    const spans = document.querySelectorAll('nav span');
    for (const span of spans) {
        const text = span.textContent || '';
        const match = text.match(/People\s*\(([0-9,]+)\)/i);
        if (match) {
            return parseInt(match[1].replace(/,/g, ''), 10);
        }
    }
    return null;
}

// Get connection message from card - extracts full message text
function getConnectionMessage(btn) {
    const card = btn.closest('[role="listitem"]');
    if (!card) return null;
    const msgEl = card.querySelector('[data-testid="expandable-text-box"]');
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
    const firstCard = document.querySelector('[role="listitem"]');
    if (!firstCard) return null;

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

async function startProcess(isImmediate = false) {
    scrollContainer = findScrollContainer();
    console.log('ClearConnect: Scroll container', scrollContainer ? 'found' : 'using window');

    if (!isImmediate) {
        updateStatus('Scrolling to bottom...', 0);
        await scrollToBottom();
    } else {
        console.log('ClearConnect: Immediate mode - Skipping scroll');
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

        // Add to foundMatchingPeople to populate UI lists
        if (!state.foundMatchingPeople.some(p => p.name === personName)) {
            state.foundMatchingPeople.push({
                name: personName,
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
    let maxRetries = 30;
    let lastCardElement = null;

    const linkedInTotal = getLinkedInTotalCount() || 1000; // fallback estimate
    console.log('ClearConnect: LinkedIn shows', linkedInTotal, 'total');

    // Send initial scroll progress
    sendScrollProgress(0, linkedInTotal);

    while (state.isRunning && noChange < maxRetries) {
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

        // Simple scroll to bottom
        scrollTo(getScrollHeight());

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

            // Only do jiggle when stuck (2+ attempts with no change)
            if (noChange >= 2 && noChange % 2 === 0) {
                let msg = `Triggering load... (${noChange}/${maxRetries})`;
                sendScrollProgress(currentCount, linkedInTotal, msg);
                // Natural jiggle - smooth scroll up, pause, smooth scroll back
                scrollBy(-400);
                await wait(400);
                scrollTo(getScrollHeight());
                await wait(300);
            } else {
                let msg = `Waiting for LinkedIn... (${noChange}/${maxRetries})`;
                sendScrollProgress(currentCount, linkedInTotal, msg);
            }

            baseWait = Math.min(1200, baseWait + 80); // Slow down when stuck
        }

        // BOTTOM DETECTION - Multiple checks
        const atBottom = isAtScrollBottom();
        const sameLastCard = lastCardElement === currentLastCard && currentLastCard !== null;

        // Stricter total check
        const tolerance = 40; // Allow some disparity (hidden items, ads, etc)
        const nearLinkedInCount = currentCount >= (linkedInTotal - tolerance);

        // Conditions to break loop:
        // 1. We are near the official total AND haven't seen changes for a bit (fast exit)
        if (nearLinkedInCount && noChange >= 2) {
            console.log('ClearConnect: Reached near LinkedIn total count, proceeding');
            break;
        }

        // 2. We are literally at scroll bottom, card unchanged, and we've waited enough (slow exit)
        if (atBottom && sameLastCard && noChange >= 5) {
            console.log('ClearConnect: At physical scroll bottom with no updates, proceeding');
            break;
        }

        // 3. Absolute timeout / stuck safety (very slow exit)
        if (noChange >= 8) {
            console.log('ClearConnect: Stuck for too long, proceeding with what we have');
            break;
        }

        // Jiggle logic if stuck
        if (noChange >= 3) {
            console.log('ClearConnect: Jiggling to trigger load...');
            scrollBy(-600);
            await wait(600);
            scrollTo(getScrollHeight());
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
    let buttons = Array.from(document.querySelectorAll('button[data-view-name="sent-invitations-withdraw-single"]'));

    if (buttons.length === 0) {
        buttons = Array.from(document.querySelectorAll('button')).filter(b => {
            const text = (b.textContent || '').trim();
            return text === 'Withdraw';
        });
    }

    // Filter out already processed items (Debug Mode & Loop Prevention)
    // Check both button and closest container
    return buttons.filter(b => !b.classList.contains('cc-processed') && !b.closest('.cc-processed'));
}

function getPersonName(button) {
    const card = button.closest('[role="listitem"]');
    if (!card) return 'Unknown';

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

    const img = card.querySelector('img[alt*="profile picture"]');
    if (img) {
        const alt = img.getAttribute('alt') || '';
        const match = alt.match(/^(.+?)['']s profile picture$/i);
        if (match) return match[1];
    }

    const figure = card.querySelector('figure[aria-label*="profile picture"]');
    if (figure) {
        const label = figure.getAttribute('aria-label') || '';
        const match = label.match(/^(.+?)['']s profile picture$/i);
        if (match) return match[1];
    }

    return 'Unknown';
}

// Get LinkedIn profile URL from connection card
function getProfileUrl(button) {
    const card = button.closest('[role="listitem"]');
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
    const card = button.closest('[role="listitem"]');
    if (!card) return null;

    const text = (card.textContent || '').trim();

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
    // console.log('Unknown age text:', text.substring(0, 50));

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
    if (state.settings.safeUnit === 'month') thresholdMonths = state.settings.safeThreshold;
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

    if (!isSafe(btn)) {
        complete(`Safety stop: ${personName} (${ageText}) is too recent.`, {}, 'safety');
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
            complete(`No connections sent ${state.settings.ageValue} ${unitLabel} ago and older. Oldest is ${ageText}.`, { oldestRemaining: age }, 'success');
        } else {
            complete(`Age limit reached at ${personName} (${ageText}).`, { oldestRemaining: age }, 'success');
        }
        return;
    }

    const total = state.stats.total > 0 ? state.stats.total : 0;
    const progressPct = total > 0 ? Math.round((state.stats.processed / total) * 100) : 0;

    updateStatus(`[${state.stats.processed + 1}/${total || '?'}] ${personName}`, progressPct, {
        name: personName,
        age: ageText,
        status: 'active'
    });

    btn.scrollIntoView({ behavior: 'auto', block: 'center' });
    await wait(150);

    let confirmed = false;

    if (state.settings.debugMode) {
        // Debug mode: Just highlight the button, don't click
        const card = btn.closest('.invitation-card__container') || btn.closest('li');

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

    while (waited < maxWait) {
        const confirmBtn = document.querySelector('dialog[open] button[aria-label^="Withdrawn invitation sent to"]');
        if (confirmBtn) {
            confirmBtn.click();
            return true;
        }

        const fallbackBtn = document.querySelector('dialog[open] [data-view-name="edge-creation-connect-action"] button');
        if (fallbackBtn) {
            fallbackBtn.click();
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
    if (extraStats.oldestRemaining) {
        state.stats.oldestRemaining = extraStats.oldestRemaining; // Add to state if needed
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

            // Increment alltimeCleared for new withdrawals
            state.stats.alltimeCleared = (state.stats.alltimeCleared || 0) + 1;

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
        console.error('ClearConnect: Failed to record withdrawal', e);
    }
}

function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Check for "Hi [Name]," or "Hello [Name]," greeting
function normalizeMessage(text) {
    if (!text) return '';
    let normalized = text.trim();
    // specific patterns to remove: Hi/Hello/Hey [Name]
    // Matches start of string, common greetings, name (up to 40 chars), and terminator
    normalized = normalized.replace(/^(Hi|Hello|Hey|Dear|Good morning|Good afternoon|Good evening)\s+[\s\S]{1,40}?[:,\!]\s*/i, '');

    // Normalize currency: Replace $100, $1,000, $50.00 with [AMOUNT]
    normalized = normalized.replace(/\$\d+(?:,\d{3})*(?:\.\d+)?/g, '[AMOUNT]');

    return normalized.trim();
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
    const card = element.closest('[role="listitem"]');
    if (!card) return;

    // Remove existing
    card.classList.remove('cc-highlight-processing', 'cc-highlight-skip');

    if (type === 'processing') {
        card.classList.add('cc-highlight-processing');
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Add temporary visual flash
        const originalBg = card.style.backgroundColor;
        card.style.transition = 'background 0.5s';
        card.style.backgroundColor = '#fff3cd'; // Light yellow
        setTimeout(() => {
            card.style.backgroundColor = originalBg || '';
        }, 2000);
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
    console.log('ClearConnect: Scanning using container', scrollContainer);

    for (let i = 0; i < maxScrolls; i++) {
        if (!state.isRunning) break;

        // Scroll to bottom using helper
        const scrollHeight = getScrollHeight();
        scrollTo(scrollHeight);

        await wait(1500); // Wait for load

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

        if (currentHeight <= previousHeight + 50) { // Tolerance
            noChangeCount++;

            // Stricter check: only stop if we're close to the total count or have tried many times
            const linkedInTotal = getLinkedInTotalCount();
            const loadedCount = buttons.length;
            const isCloseEnough = linkedInTotal && loadedCount >= (linkedInTotal - 40); // Within 40 items

            if (isCloseEnough && noChangeCount >= 2) {
                console.log('ClearConnect: Reached total count, stopping.');
                break;
            } else if (noChangeCount >= 5) { // Increased from 2 to 5 for slow connections
                if (linkedInTotal && loadedCount < (linkedInTotal - 100)) {
                    // We are stuck but far from total. Try a "jiggle" scroll?
                    window.scrollBy(0, -500);
                    await wait(800);
                    scrollTo(getScrollHeight());
                } else {
                    console.log('ClearConnect: Stuck with no growth, stopping.');
                    break;
                }
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
    broadcastState('SCAN_COMPLETE');
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
    const targetHashes = new Set(selectedHashes);
    const buttons = findWithdrawButtons(); // Working from existing list (assuming page hasn't changed much, but will verify)
    state.stats.total = buttons.length; // Approximate, effective total is matching count

    // Recalculate exact total for selected
    let matchingTotal = 0;
    for (const btn of buttons) {
        const msg = normalizeMessage(getConnectionMessage(btn));
        if (targetHashes.has(hashMessage(msg))) matchingTotal++;
    }
    state.stats.total = matchingTotal;

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

            highlightConnection(btn, 'processing');

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
                // Debug mode: Just highlight, don't click
                const card = btn.closest('[role="listitem"]');
                if (card) {
                    card.style.transition = 'background 0.3s, border 0.3s';
                    card.style.backgroundColor = '#fff3cd';
                    card.style.border = '2px solid #ffc107';
                }
                btn.style.backgroundColor = '#ffc107';
                btn.style.color = '#000';
                btn.style.fontWeight = 'bold';

                await wait(800);
                confirmed = true;

                // Hide the card after highlighting to simulate withdrawal
                if (card) {
                    setTimeout(() => {
                        card.style.display = 'none';
                    }, 1000);
                }
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
