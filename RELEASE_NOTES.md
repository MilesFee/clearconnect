# ClearConnect Release Notes

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
