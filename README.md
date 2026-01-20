# ClearConnect - LinkedIn Connection Manager 🧹

**Clean up your pending LinkedIn connection requests safely and efficiently.**

ClearConnect is a powerful Chrome extension that helps you manage your "Sent" invitations on LinkedIn. It automates the withdrawal of old or unwanted connection requests with precision and safety.

## 🚀 Key Features

*   **Smart Message Mode:** Scan your sent requests to find identifying patterns (e.g., generic "I'd like to join your network..." or specific pitch messages) and bulk-withdraw them.
*   **Safety First:** Built-in safeguards prevent you from accidentally withdrawing recently sent requests. define your own "Safe Threshold" (e.g., keep anything sent in the last 1 week).
*   **Automated Cleaning:**
    *   **By Count:** Withdraw the oldest X requests.
    *   **By Age:** Withdraw all requests older than X months/weeks.
*   **Debug Mode:** Test your filters and settings safely without actually withdrawing anything.
*   **Privacy Focused:** Runs entirely locally in your browser. No data collection.

## 📦 Installation

1.  Download the latest release (`.crx` or source code).
2.  Open Chrome and go to `chrome://extensions/`.
3.  Enable **Developer Mode** (top right).
4.  Click **Load unpacked** and select the extension folder.

## 🛠️ Usage

1.  Navigate to [LinkedIn Sent Invitations](https://www.linkedin.com/mynetwork/invitation-manager/sent/).
2.  Open the ClearConnect popup.
3.  Choose your mode:
    *   **Count:** Removes the oldest 10, 20, etc.
    *   **Age:** Removes everything older than 3 months, 6 months, etc.
    *   **Message:** Scans for specific text patterns to target specific groups of people.
4.  Click **Run** (or **Scan** for Message Mode).

## 🛡️ Safety & Rate Limits

ClearConnect is designed to mimic human behavior with randomized delays and "jiggles" to avoid triggering LinkedIn's automation detectors. However, always use with caution and logical limits.

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
