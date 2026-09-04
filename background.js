// ClearConnect Background Service Worker
importScripts('utils.js');
// Manages side panel lifecycle, panel behavior, and message relay

// Open side panel when requested by popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'OPEN_SIDEPANEL') {
        const tabId = message.tabId;
        if (tabId) {
            // Per spec: set panel behavior so clicking icon opens side panel during active ops
            chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => { });
            chrome.sidePanel.open({ tabId }).catch(e => {
                Logger.log('ClearConnect: Could not open side panel:', e);
            });
        }
        sendResponse({ ok: true });
        return true;
    }

    if (message.action === 'OPEN_RESULTS_ACCESS') {
        const tabId = message.tabId;
        if (tabId) {
            // Open immediately to preserve user gesture
            chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => { });
            chrome.sidePanel.open({ tabId }).catch(e => {
                Logger.log('ClearConnect: Could not open side panel:', e);
            });

            // Then update state
            chrome.storage.local.get('extension_state').then(({ extension_state }) => {
                if (extension_state) {
                    extension_state.uiNavigation = { currentTab: 'completed' };
                    chrome.storage.local.set({ extension_state });
                }
            });
        }
        sendResponse({ ok: true });
        return true;
    }



    if (message.action === 'CLOSE_SIDEPANEL') {
        // Revert: clicking icon opens popup again when idle
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => { });
        sendResponse({ ok: true });
        return true;
    }

    // Forward a diagnostic event to the reporting Worker.
    // The destination is fixed below -- deliberately NOT taken from the message,
    // so a compromised page context cannot aim the extension at another host.
    if (message.action === 'REPORT_EVENT') {
        postDiagnosticReport(message.event);
        return; // Fire-and-forget, no response needed
    }

    if (message.action === 'COMPLETE') {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => { });
    }

    if (message.action === 'SYNC_SELECTORS') {
        syncCloudSelectors().then((result) => sendResponse(result));
        return true;
    }
});

// Enable side panel only on LinkedIn sent invitations page
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        const isLinkedIn = tab.url.includes('linkedin.com/mynetwork/invitation-manager/sent');
        await chrome.sidePanel.setOptions({
            tabId,
            path: 'sidepanel.html',
            enabled: isLinkedIn
        });
    }
});

// ============ DIAGNOSTIC REPORTING ============
// Endpoint for the ClearConnect Worker's /report route (see worker/README.md).
// Leave empty to disable reporting entirely -- nothing is sent when unset.
const REPORT_ENDPOINT = 'https://clearconnect-selectors.milesfee.workers.dev/report';

// Never email more than one report of the same type per interval. Without this a
// stuck page could fire a report per retry and flood the alert inbox.
const REPORT_MIN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_REPORT_BYTES = 8 * 1024;
const lastReportAt = new Map();

function postDiagnosticReport(event) {
    if (!REPORT_ENDPOINT) return;
    if (!event || typeof event.type !== 'string') return;

    const now = Date.now();
    const previous = lastReportAt.get(event.type) || 0;
    if (now - previous < REPORT_MIN_INTERVAL_MS) return;
    lastReportAt.set(event.type, now);

    let body;
    try {
        body = JSON.stringify({
            type: String(event.type).slice(0, 64),
            version: String(event.version || 'unknown').slice(0, 32),
            data: event.data && typeof event.data === 'object' ? event.data : {}
        });
    } catch (e) {
        return; // Unserialisable payload -- drop it.
    }
    if (body.length > MAX_REPORT_BYTES) return;

    fetch(REPORT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
    }).catch(() => { }); // Delivery failures must never surface to the user.
}

// ============ CLOUD SELECTOR SYNC ============
// The Worker's schema route. Note this is /selectors, not / -- the root is a
// health probe that returns a small JSON object, and storing that as a schema
// would look like a successful sync while silently discarding the real one.
// Whoever deploys the Worker should point this at their own deployment.
const SELECTORS_ENDPOINT = 'https://clearconnect-selectors.milesfee.workers.dev/selectors';

/**
 * A schema is an object of selector entries: each value is either a CSS string
 * or a learned-selector descriptor object. Anything else -- a health payload, an
 * error body, a captive-portal interstitial -- is rejected rather than stored.
 */
function isValidSelectorSchema(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    const keys = Object.keys(data);
    if (keys.length === 0 || keys.length > 64) return false;
    return keys.every(k => {
        if (!/^[\w.-]{1,64}$/.test(k)) return false;
        const v = data[k];
        if (typeof v === 'string') return v.length > 0 && v.length <= 512;
        return !!v && typeof v === 'object' && !Array.isArray(v);
    });
}

async function syncCloudSelectors() {
    try {
        const response = await fetch(SELECTORS_ENDPOINT, { cache: 'no-store' });
        if (!response.ok) {
            return { success: false, error: `HTTP ${response.status}` };
        }
        const data = await response.json();
        if (!isValidSelectorSchema(data)) {
            // Do not overwrite a good stored schema with a bad response.
            Logger.warn('ClearConnect: Ignoring malformed selector schema');
            return { success: false, error: 'Malformed schema' };
        }
        await chrome.storage.local.set({ cloud_selectors: data, last_sync_time: Date.now() });
        Logger.log('ClearConnect: Synced cloud selectors successfully.');
        return { success: true };
    } catch (e) {
        Logger.error('ClearConnect: Failed to sync cloud selectors', e);
        return { success: false, error: e.message };
    }
}

// Sync on startup / install
chrome.runtime.onStartup.addListener(syncCloudSelectors);
chrome.runtime.onInstalled.addListener(syncCloudSelectors);

// Set alarm to sync periodically (every 12 hours)
chrome.alarms.create('sync_selectors', { periodInMinutes: 720 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'sync_selectors') {
        syncCloudSelectors();
    }
});
