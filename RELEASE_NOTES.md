# ClearConnect Release Notes

## Version 2.1.0 - The "Smart Control" Update 🧠

This release brings a major overhaul to the User Interface and introduces powerful new ways to manage your connection withdrawals.

### ✨ New Features

#### 1. Message Mode (Pattern Matching)
*   **Scan & Select:** You can now scan your sent folder for specific message patterns (e.g., people you sent "sales pitches" to vs. "friendly greetings").
*   **Bulk Withdraw Groups:** Detected messages are grouped by pattern. You can check specific groups to withdraw while keeping others safe.
*   **Search Customization:** Configure up to 3 different message patterns to scan for simultaneously.

#### 2. Enhanced Safety Logic 🛡️
*   **Universal Safety Stop:** The safety threshold (e.g., "Don't withdraw anything sent in the last 1 month") is now strictly enforced across ALL modes, including manual selection.
*   **Visual Warnings:** If a safety stop is triggered, the interface turns orange to clearly warn you.
*   **Non-Destructive Filtering:** If a safety stop occurs during a list cleaning, the remaining items are preserved so you can review them.

#### 3. Debug Mode 🐞
*   **Simulation:** A new Toggle in settings allows you to "simulate" runs. It highlights the buttons it *would* have clicked in Yellow, without actually withdrawing anyone. Perfect for testing your new settings or message filters.

### 🎨 UI/UX Improvements

*   **Unified Interface:** A cleaner, more consistent look across all modes.
*   **Smart Footer:** Status messages now cleanly reset when returning to the home screen.
*   **Progress Visualization:** Improved scrolling and withdrawing progress bars with detailed status feedback.
*   **Visual Polish:** Better color coding for Success (Green), Warning (Orange), and Error (Red) states.

### 🐛 Bug Fixes

*   Fixed "Frankenstein UI" issues where elements from different modes overlapped.
*   Fixed an issue where "See Results" footer persisted incorrectly after clearing.
*   Fixed safety settings not propagating correctly to the content script after reloads.
*   Fixed various state persistence issues when closing/reopening the popup.
