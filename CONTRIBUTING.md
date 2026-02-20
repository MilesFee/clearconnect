# Contributing to ClearConnect

Thank you for your interest in contributing to ClearConnect! We welcome improvements, bug fixes, and new features.

## Getting Started

1.  **Fork the repository** on GitHub.
2.  **Clone your fork** locally: `git clone https://github.com/your-username/clearconnect.git`
3.  **Create a branch** for your feature or fix: `git checkout -b feature/amazing-feature`
4.  **Install dependencies**: This project uses vanilla JS, HTML, and CSS. No Node.js build steps are required for the core extension.
5.  **Load the extension**:
    *   Open Chrome and go to `chrome://extensions/`
    *   Enable **Developer mode**
    *   Click **Load unpacked** and select the repository folder.

## Development Guidelines

*   **Code Style**: Keep code clean, readable, and commented where necessary. Follow the existing style (clean vanilla JS).
*   **Logging**: Use `Logger.log()`, `Logger.warn()`, etc. from `utils.js` instead of `console.log()` to keep production console clean.
*   **Testing**: Test your changes manually on LinkedIn's "Sent Invitations" page to ensure functionality and safety.

## Submitting a Pull Request

1.  Push your branch to your fork.
2.  Open a Pull Request against the `main` branch.
3.  Provide a clear description of your changes and why they are needed.
4.  Wait for review!
