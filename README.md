# ClearConnect - LinkedIn Connection Manager 🧹

![Version](https://img.shields.io/badge/version-2.5.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

**Clean up your pending LinkedIn connection requests safely and efficiently.**

ClearConnect is a powerful Chrome extension that helps you manage your "Sent" invitations on LinkedIn. It automates the withdrawal of old or unwanted connection requests with precision and safety, mimicking human behavior to keep your account safe.

## 🚀 Key Features

*   **Smart Message Mode:** Scan processed requests to find identifying patterns (e.g., "I'd like to join your network..." or pitch messages) and bulk-withdraw them.
*   **Safety First:** Built-in safeguards prevent accidental withdrawals. Define a "Safe Threshold" (e.g., keep requests sent in the last week).
*   **Automated Cleaning:**
    *   **By Count:** Withdraw the oldest X requests.
    *   **By Age:** Withdraw requests older than X months/weeks.
*   **Debug Mode:** Test filters and settings safely without executing withdrawals.
*   **Privacy Focused:** Runs entirely locally in your browser. No data collection.

## 📸 Screenshots

*(coming never maybe)*

## 📦 Installation

### For Users (Easy Way)
1.  **Go to the [Releases Page](../../releases)** on this repository.
2.  **Download** the latest `clearconnect-vX.X.X.zip` file.
3.  **Unzip** the downloaded file to a folder on your computer.
4.  Open Chrome and navigate to `chrome://extensions/`.
5.  Enable **Developer Mode** (toggle in the top right corner).
6.  Click **Load unpacked**.
7.  Select the folder where you unzipped the extension (it should be titled `clearconnect-extension`).
8.  The extension should now be installed and ready to use.

### For Developers (Source Code)
1.  **Clone** the repository: `git clone https://github.com/your-username/clearconnect.git`
2.  Open Chrome and go to `chrome://extensions/`.
3.  Enable **Developer Mode**.
4.  Click **Load unpacked** and select the repository folder.

## 🛠️ Usage

1.  Navigate to the [LinkedIn Sent Invitations](https://www.linkedin.com/mynetwork/invitation-manager/sent/) page.
2.  Click the **ClearConnect** extension icon.
3.  Select a specific mode:
    *   **Count:** Remove the oldest N requests.
    *   **Age:** Remove requests older than a specific time.
    *   **Message:** Group requests by message content and withdraw by group.
4.  Click **Run** (or **Scan**).

## 🤝 Contributing

Contributions are welcome! Please read our [Contributing Guidelines](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md) for details on how to submit pull requests.

## 🛡️ Safety & Rate Limits

ClearConnect uses randomized delays and "jiggling" to simulate human interaction. However, always use this tool with caution and within reasonable limits to avoid triggering LinkedIn's automated systems.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
