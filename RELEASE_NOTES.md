# ClearConnect Release Notes

## Version 2.6.1 - Security & Consolidation 🔒

A security-focused release. No feature removals — everything from 2.5.2 is still here.

### 🔐 Security
- **Removed a hardcoded webhook URL** from the extension source. Diagnostic reports now go to a Cloudflare Worker that emails the team; the extension holds no credential of any kind.
- **Fixed a cross-site scripting hole** in the side panel. Topics extracted from invitation messages are attacker-influenced text and are now escaped before rendering.
- **Closed an open relay** in the service worker, which previously fetched whatever URL a message handed it.
- **Added a content security policy** to extension pages.
- Diagnostic reports now send the page path rather than the full URL, since query strings can carry identifiers.

### 🔁 Cloud selector sync
- Sync now reads the Worker's `/selectors` route and **validates the response** before storing it, so a health payload or error page can no longer masquerade as a selector schema.

### 🧹 Housekeeping
- Icons regenerated from `icons/logo.svg` — real PNGs at 16/48/128 instead of 1024×1024 JPEGs, cutting the package from 1.1 MB to ~85 KB.
- `popup.css` renamed to `main.css`; it always styled the side panel too.
- Agent configuration consolidated into one `AGENTS.md` plus `.agents/`.
- CI now blocks a release outright if a webhook URL appears in the extension source.

---

## Version 2.5.2 - The Speed & Sync Update ⚡️

ClearConnect just got faster, smarter, and infinitely more reliable! We’ve rebuilt the core engine that powers our withdrawal logic to ensure you never miss a beat when LinkedIn changes its layout. 

### 🚀 Speed & Usability Improvements
- **Lightning Fast**: Under-the-hood performance tweaks ensure the extension runs smoother and uses fewer resources while scanning your connections.
- **Intuitive Settings**: We've refined the Advanced Settings menu so keeping your extension updated with the latest layout fixes is just a single click away. 

### 📡 Bulletproof Cloud Sync
LinkedIn changes its design often, which occasionally used to break the extension. Not anymore!
- **Auto-Healing Connections**: If LinkedIn updates its layout, ClearConnect can now instantly fetch the latest working configuration directly from our cloud server. No more waiting days for an app store update!
- **Smarter Relearning**: If you ever need to use the "Repair Layout" tool yourself, it now learns your screen flawlessly without saving any of your personal data, and seamlessly applies it across the entire extension.

### 📥 How to Install
1. Download the latest `clearconnect` folder.
2. Open Google Chrome and go to `chrome://extensions/` in your URL bar.
3. Turn on **Developer mode** using the toggle in the top right corner.
4. Click **Load unpacked** in the top left and select your downloaded ClearConnect folder.
5. You're ready to go!

---
## Version 2.5.1 - Stability & CI Update 🛠️

This patch resolves critical issues with the dynamic selector management system and improves our continuous integration pipeline.

### 🐛 1. Dynamic Selector Fixes
- **Message Scanner Resilience**: Fixed a bug where the "Message Mode" scanner ignored user-trained custom selectors for message extraction. The scanner will now reliably detect and group messages even when LinkedIn alters their connection card UI.
- **Improved Fail-safes**: Corrected the fallback logic so that if custom selectors are present, they are strictly prioritized over legacy `data-testid` attributes.

### ⚙️ 2. Deployment Pipeline Enhancements
- **Separated Workflows**: GitHub Actions has been updated to independently package the Chrome Extension and deploy the backend Cloudflare Worker, preventing monolithic build failures.

---

## Version 2.5.0 - The Evolution Update 🚀

This version marks a significant milestone in ClearConnect's journey, transforming from a simple MVP into a robust, high-performance tool for LinkedIn connection management.

### 🏗️ 1. Hybrid UI Architecture
We've moved beyond a basic popup to a sophisticated dual-view architecture.
- **The Dashboard (Popup)**: A central hub for navigation, quick actions, and the newly refined live statistics view.
- **The Engine Room (Side Panel)**: Long-running withdrawal processes now run completely in the background via the Side Panel, allowing you to browse LinkedIn uninterrupted while the extension works.

### 🔍 2. "Scan & Select" Engine
A breakthrough in control, allowing you to choose *exactly* who you want to withdraw.
- **Message Extraction**: Automatically scans your sent invitations for message content and dollar amounts.
- **Smart Grouping**: Similar messages are grouped together, making it easy to clear large batches of specific outreach types at once.

### 🛡️ 3. Precision & Safety
Granular controls to ensure you only withdraw what's necessary.
- **Time-Based Filtering**: Highly accurate filtering by days, weeks, or months (e.g., "Clear everyone from 3 months ago").
- **Safety Stops**: Customizable withdrawal limits and automated safety stops to stay within LinkedIn's rate limits.
- **Interactive Selectors**: Bidirectional time unit rollovers (e.g., clicking down from 1 month rolls straight into 3 weeks).

### 📊 4. Data Reliability
- **Deep-Merge Persistence**: Implemented a state management system that survives extension reloads and page refreshes. Your statistics and run results are now virtually indestructible.
- **Context-Aware Scraping**: A new, universal detection system for the "People" count that works regardless of LinkedIn's UI layout changes.

### 🎨 5. Premium Polish & Stabilization
- **UI Layout Fix**: Resolved a critical regression where the Sidepanel footer would expand incorrectly; the layout now strictly pins the action footer to the bottom.
- **Scanning Optimization**: Optimized the "Message Mode" scanning engine to handle already-loaded pages gracefully, reducing the scanning hang from 10 seconds down to ~2.5 seconds.
- **Cohesive Design**: Perfectly aligned UI elements, smooth transitions, and standard-compliant color coding (green for success, blue for info, red for errors).

---

## Version 2.3.0 - The MVP Release 🚀

This release consolidates all recent UI improvements, safety features, and the new Single Page Application (SPA) architecture into a stable MVP.

### 🌟 Key Highlights
*   **SPA Architecture:** Improved performance and smoother transitions between views.
*   **Enhanced Message Mode:** Better grouping and filtering for safe withdrawal of connection requests.
*   **Visual Polish:** Refined dark mode, consistent button styling, and better progress feedback.

## Version 2.1.0 - The "Smart Control" Update 🧠

This release brings a major overhaul to the User Interface and introduces powerful new ways to manage your connection withdrawals.

### ✨ New Features
*   **Message Mode (Pattern Matching)**: Scan and select people based on specific message patterns.
*   **Universal Safety Stop**: Strict enforcement of time-based safety limits across all modes.
*   **Debug Mode Simulation**: Highlight what would happen without actually clicking buttons.

---
*ClearConnect was built to simplify your professional network cleanup. v2.5.0 is our most stable, powerful release yet.*
