// ClearConnect Background Service Worker
// Manages side panel lifecycle, panel behavior, and message relay

// Open side panel when requested by popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'OPEN_SIDEPANEL') {
        const tabId = message.tabId;
        if (tabId) {
            // Per spec: set panel behavior so clicking icon opens side panel during active ops
            chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => { });
            chrome.sidePanel.open({ tabId }).catch(e => {
                console.log('ClearConnect: Could not open side panel:', e);
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
                console.log('ClearConnect: Could not open side panel:', e);
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

    // On completion, revert panel behavior
    if (message.action === 'COMPLETE') {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => { });
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
