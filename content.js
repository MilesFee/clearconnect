let isRunning = false;
let processedCount = 0;
let targetCount = 0;
let currentMode = 'count';
let ageValue = 3;
let ageUnit = 'month';
let safeMode = true;
let safeThreshold = 1;
let safeUnit = 'month';
let currentStatusText = "Ready";
let currentProgress = 0;
let oldestCleared = '-';
let actionDelay = 600;
let totalToWithdraw = 0;
let messagePatterns = []; // For message mode filtering

// Dynamic timing
let baseWait = 300;
let retryCount = 0;
let scrollContainer = null;
let isPaused = false;

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'START_WITHDRAW') {
        if (isRunning) return;
        targetCount = message.count || 999999;
        currentMode = message.mode || 'count';
        ageValue = message.ageValue || 3;
        ageUnit = message.ageUnit || 'month';
        safeMode = message.safeMode !== false;
        safeThreshold = message.safeThreshold || 1;
        safeUnit = message.safeUnit || 'month';
        messagePatterns = message.messages || [];
        processedCount = 0;
        oldestCleared = '-';
        totalToWithdraw = 0;
        isRunning = true;
        retryCount = 0;
        baseWait = 300;
        scrollContainer = null;
        startProcess();
    } else if (message.action === 'STOP_WITHDRAW') {
        // Trigger completion with specific message
        const msg = processedCount > 0 ? `Stopped by user, ${processedCount} withdrawn.` : 'Stopped by user.';
        complete(msg);
    } else if (message.action === 'GET_STATUS') {
        sendResponse({
            isRunning: isRunning,
            statusText: currentStatusText,
            progress: currentProgress,
            target: targetCount
        });
    } else if (message.action === 'GET_COUNT') {
        // Quick count retrieval
        const countEl = document.querySelector('.mn-invitations-preview__header .t-black--light');
        const count = countEl ? parseInt(countEl.innerText.replace(/[^0-9]/g, '')) : 0;
        sendResponse({ count });
    } else if (message.action === 'PAUSE_WITHDRAW') {
        isPaused = true;
        updateStatus('Paused', currentProgress);
    } else if (message.action === 'RESUME_WITHDRAW') {
        isPaused = false;
        updateStatus('Resuming...', currentProgress);
    } else if (message.action === 'UPDATE_MESSAGES') {
        messagePatterns = message.messages || [];
        foundMatchingPeople = []; // Reset found list
        isPaused = false;
        updateStatus('Resuming with updated patterns...', currentProgress);
    } else if (message.action === 'SCAN_CONNECTIONS') {
        if (isRunning) return;
        isRunning = true;
        scanConnections();
    } else if (message.action === 'WITHDRAW_SELECTED') {
        if (isRunning) return;
        isRunning = true;
        withdrawSelected(message.selectedHashes);
    } else if (message.action === 'SHOW_CONNECTION') {
        showConnection(message.hash);
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
let foundMatchingPeople = [];

// Strip common greeting patterns like "Hi John," or "Hello Sarah,"
function normalizeMessage(text) {
    if (!text) return '';
    // Remove greeting patterns: Hi/Hello/Hey [Name],
    // Matches: "Hi John," "Hello Sarah," "Hey Mike," etc.
    return text.replace(/^(Hi|Hello|Hey)\s+[A-Za-z]+[,!]?\s*/i, '').trim();
}

// Check if connection matches any message pattern
function matchesMessagePattern(btn) {
    if (messagePatterns.length === 0) return false;
    const msg = getConnectionMessage(btn);
    if (!msg) return false;

    // Normalize both the message and patterns for comparison
    const normalizedMsg = normalizeMessage(msg);

    return messagePatterns.some(pattern => {
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

async function startProcess() {
    scrollContainer = findScrollContainer();
    console.log('ClearConnect: Scroll container', scrollContainer ? 'found' : 'using window');

    updateStatus('Scrolling to bottom...', 0);
    await scrollToBottom();
    if (isRunning) processNext();
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

    while (isRunning && noChange < maxRetries) {
        const buttons = findWithdrawButtons();
        const currentCount = buttons.length;
        const currentLastCard = buttons.length > 0 ? buttons[buttons.length - 1] : null;

        // Calculate matching count for Age mode
        let matchCount = 0;
        if (currentMode === 'age') {
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
                    if (ageUnit === 'year') thresholdDays = ageValue * 365;
                    else if (ageUnit === 'month') thresholdDays = ageValue * 30;
                    else if (ageUnit === 'week') thresholdDays = ageValue * 7;
                    else if (ageUnit === 'day') thresholdDays = ageValue;

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
            totalToWithdraw = matchCount;
        } else if (currentMode === 'message') {
            // Count matching messages and track found people with age data
            foundMatchingPeople = [];
            for (const btn of buttons) {
                if (matchesMessagePattern(btn)) {
                    matchCount++;
                    const name = getPersonName(btn);
                    const age = getAge(btn);
                    const ageText = age ? `${age.value} ${age.unit}${age.value > 1 ? 's' : ''}` : '-';

                    // Track matching person with full data (avoid duplicates by name)
                    if (name && !foundMatchingPeople.some(p => p.name === name)) {
                        foundMatchingPeople.push({ name, age: ageText, cleared: false });
                    }
                }
            }
            totalToWithdraw = matchCount;
        } else {
            totalToWithdraw = targetCount;
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
            if (currentMode === 'age') {
                const unitLabel = ageValue === 1 ? ageUnit : ageUnit + 's';
                msg = `Found ${matchCount} sent ${ageValue} ${unitLabel} ago and older`;
            } else if (currentMode === 'message') {
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
        const nearLinkedInCount = currentCount >= linkedInTotal - 30;

        // If at scroll bottom AND same card for 3+ tries → definitely at bottom
        if (atBottom && sameLastCard && noChange >= 3) {
            console.log('ClearConnect: At scroll bottom, card unchanged, proceeding');
            break;
        }

        // If near LinkedIn count AND no change for 3+ tries → likely at bottom
        if (nearLinkedInCount && noChange >= 3) {
            console.log('ClearConnect: Near LinkedIn total, proceeding');
            break;
        }

        // If no new items for 5+ tries AND at scroll bottom → definitely done
        if (noChange >= 5 && atBottom) {
            console.log('ClearConnect: Stuck at bottom, proceeding');
            break;
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
        foundMatches: currentMode === 'message' ? foundMatchingPeople.slice(0, 50) : [] // Limit to 50
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

    return buttons;
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
    if (!safeMode) return true;

    const age = getAge(button);
    if (!age) return false;

    let ageInMonths = 0;
    if (age.unit === 'year') ageInMonths = age.value * 12;
    else if (age.unit === 'month') ageInMonths = age.value;
    else if (age.unit === 'week') ageInMonths = age.value / 4;
    else return false;

    const thresholdMonths = safeUnit === 'month' ? safeThreshold : safeThreshold / 4;
    return ageInMonths >= thresholdMonths;
}

function shouldStop(button) {
    if (currentMode === 'count') {
        return processedCount >= targetCount;
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
        if (ageUnit === 'year') thresholdDays = ageValue * 365;
        else if (ageUnit === 'month') thresholdDays = ageValue * 30;
        else if (ageUnit === 'week') thresholdDays = ageValue * 7;
        else if (ageUnit === 'day') thresholdDays = ageValue;

        // Stop if connection is newer than threshold (fewer days old)
        return connectionAgeDays < thresholdDays;
    }
}

async function processNext() {
    if (!isRunning) return;

    const buttons = findWithdrawButtons();

    if (buttons.length === 0) {
        complete('No withdraw buttons found.');
        return;
    }

    // For message mode, find a matching button from bottom (oldest)
    let btn;
    if (currentMode === 'message') {
        // Scan from bottom to find first matching message
        for (let i = buttons.length - 1; i >= 0; i--) {
            if (matchesMessagePattern(buttons[i])) {
                btn = buttons[i];
                break;
            }
        }
        if (!btn) {
            if (processedCount === 0) {
                complete('No connections found matching your message patterns.');
            } else {
                complete(`Done! Cleared all ${processedCount} matching connections.`);
            }
            return;
        }
    } else {
        btn = buttons[buttons.length - 1];
    }

    const personName = getPersonName(btn);
    const age = getAge(btn);
    const ageText = age ? (age.text || `Sent ${age.value} ${age.unit}${age.value > 1 ? 's' : ''} ago`) : 'unknown';

    if (currentMode === 'count' && processedCount >= targetCount) {
        complete();
        return;
    }

    if (!isSafe(btn)) {
        complete(`Safety stop: ${personName} (${ageText}) is too recent.`);
        return;
    }

    // Wait if paused
    while (isPaused && isRunning) {
        await wait(500);
    }
    if (!isRunning) return;

    if (currentMode === 'age' && shouldStop(btn)) {
        if (processedCount === 0) {
            const unitLabel = ageValue === 1 ? ageUnit : ageUnit + 's';
            complete(`No connections sent ${ageValue} ${unitLabel} ago and older. Oldest is ${ageText}.`, { oldestRemaining: age });
        } else {
            complete(`Age limit reached at ${personName} (${ageText}).`, { oldestRemaining: age });
        }
        return;
    }

    const total = totalToWithdraw > 0 ? totalToWithdraw : 0;
    const progressPct = total > 0 ? Math.round((processedCount / total) * 100) : 0;

    updateStatus(`[${processedCount + 1}/${total || '?'}] ${personName}`, progressPct);

    btn.scrollIntoView({ behavior: 'auto', block: 'center' });
    await wait(150);
    btn.click();

    const confirmed = await waitAndClickDialogConfirm();

    if (confirmed) {
        processedCount++;
        oldestCleared = ageText;
        retryCount = 0;

        // Get profile URL for history
        const profileUrl = getProfileUrl(btn);

        // Record to history storage
        await recordWithdrawal(personName, profileUrl, ageText);

        // Send status with full cleared data for UI update
        const progressPctAfter = totalToWithdraw > 0 ? Math.round((processedCount / totalToWithdraw) * 100) : 0;
        updateStatus(`[${processedCount}/${totalToWithdraw || '?'}] Cleared ${personName}`, progressPctAfter, {
            name: personName,
            age: ageText,
            profileUrl: profileUrl
        });

        await wait(actionDelay);
        processNext();
    } else {
        retryCount++;
        if (retryCount >= 5) {
            complete('Error: Could not confirm withdrawal. Selectors may need updating.');
            return;
        }
        updateStatus(`Retrying ${personName}...`, currentProgress);
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

function complete(message, extraStats = {}) {
    isRunning = false;

    // Use official LinkedIn count if available, otherwise fallback to loaded buttons
    const linkedInCount = getLinkedInTotalCount();
    const remaining = linkedInCount !== null ? linkedInCount : findWithdrawButtons().length;

    chrome.runtime.sendMessage({
        action: 'COMPLETED',
        stats: {
            cleared: processedCount,
            oldest: oldestCleared,
            remaining: remaining,
            ...extraStats
        },
        message: message
    }).catch(() => { });

    updateStatus(message || `Done! Cleared ${processedCount}.`, 100);
}

function updateStatus(text, progress, clearedData = null, partialResults = null) {
    currentStatusText = text;
    currentProgress = progress;
    const msg = { action: 'UPDATE_STATUS', text, progress };
    if (clearedData) {
        // Send full clearedData object for queue rendering
        msg.clearedData = {
            name: clearedData.name,
            age: clearedData.age,
            profileUrl: clearedData.profileUrl,
            status: clearedData.status || 'completed'
        };
        // Legacy fields for backwards compatibility
        msg.clearedName = clearedData.name;
        msg.clearedAge = clearedData.age;
    }
    if (partialResults) {
        msg.partialResults = partialResults;
    }
    chrome.runtime.sendMessage(msg).catch(() => { });
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
                mode: currentMode,
                withdrawals: []
            });
        }

        // Find current session
        let session = history.find(s => s.sessionId === sessionId);
        if (!session) {
            session = {
                sessionId: sessionId,
                sessionDate: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
                mode: currentMode,
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
        if (!isRunning) break;

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

        updateStatus(
            `Found ${projectCount} distinct message groups (${buttons.length} connections)...`,
            Math.min(90, 5 + (i * 2)),
            null,
            partialResults
        );

        if (currentHeight <= previousHeight + 50) { // Tolerance
            noChangeCount++;
            if (noChangeCount >= 2) break; // Stop if no growth
        } else {
            noChangeCount = 0;
        }
        previousHeight = currentHeight;
    }

    if (!isRunning) return;

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

    isRunning = false;
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
    const targetHashes = new Set(selectedHashes);
    const buttons = findWithdrawButtons(); // Working from existing list (assuming page hasn't changed much, but will verify)
    totalToWithdraw = buttons.length; // Approximate, effective total is matching count

    // Recalculate exact total for selected
    let matchingTotal = 0;
    for (const btn of buttons) {
        const msg = normalizeMessage(getConnectionMessage(btn));
        if (targetHashes.has(hashMessage(msg))) matchingTotal++;
    }
    totalToWithdraw = matchingTotal;

    // Work from BOTTOM UP
    let processed = 0;

    for (let i = buttons.length - 1; i >= 0; i--) {
        if (!isRunning) break;

        const btn = buttons[i];
        const msg = normalizeMessage(getConnectionMessage(btn));
        const hash = hashMessage(msg);

        if (targetHashes.has(hash)) {
            // MATCH - Process
            const personName = getPersonName(btn);
            const age = getAge(btn);
            const ageText = age ? age.text : '';

            // Wait if paused
            while (isPaused && isRunning) {
                await wait(500);
            }
            if (!isRunning) break;

            highlightConnection(btn, 'processing');

            // Highlight Withdraw Button
            const withdrawSpan = btn.querySelector('span');
            if (withdrawSpan) withdrawSpan.classList.add('cc-highlight-withdraw');

            // Send 'active' status for queue update
            updateStatus(`[${processed + 1}/${totalToWithdraw}] ${personName}`, Math.round((processed / totalToWithdraw) * 100), {
                name: personName,
                age: ageText,
                status: 'active'
            });

            await wait(300); // Visual delay

            btn.click();
            const confirmed = await waitAndClickDialogConfirm();

            if (confirmed) {
                processed++;
                // Record to history with project/topic
                const profileUrl = getProfileUrl(btn);
                const projectName = msg.length > 60 ? msg.substring(0, 60) + '...' : msg;
                await recordWithdrawal(personName, profileUrl, ageText, projectName);

                // Send 'completed' status for queue update
                updateStatus(`[${processed}/${totalToWithdraw}] Cleared ${personName}`, Math.round((processed / totalToWithdraw) * 100), {
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

    complete(`Done! Cleared ${processed} selected connections.`);
}
