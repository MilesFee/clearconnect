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

// Dynamic timing
let baseWait = 300;
let retryCount = 0;
let scrollContainer = null;

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
        processedCount = 0;
        oldestCleared = '-';
        totalToWithdraw = 0;
        isRunning = true;
        retryCount = 0;
        baseWait = 300;
        scrollContainer = null;
        startProcess();
    } else if (message.action === 'STOP_WITHDRAW') {
        // Trigger full completion flow so stats are saved and UI updates
        complete('Stopped by user.');
    } else if (message.action === 'GET_STATUS') {
        sendResponse({
            isRunning: isRunning,
            statusText: currentStatusText,
            progress: currentProgress,
            mode: currentMode,
            count: targetCount,
            ageValue: ageValue,
            ageUnit: ageUnit
        });
    } else if (message.action === 'GET_COUNT') {
        const buttonCount = findWithdrawButtons().length;
        const linkedInCount = getLinkedInTotalCount();
        sendResponse({
            count: buttonCount,
            linkedInCount: linkedInCount
        });
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
        text: text || `Found ${found} of ~${total}`
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

    const btn = buttons[buttons.length - 1];
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

function updateStatus(text, progress) {
    currentStatusText = text;
    currentProgress = progress;
    chrome.runtime.sendMessage({ action: 'UPDATE_STATUS', text, progress }).catch(() => { });
}

function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}
