# ClearConnect Development Guide

> Last Updated: January 19, 2026

## Project Overview

ClearConnect is a Chrome extension for managing LinkedIn connection invitations. It helps users efficiently withdraw sent connection requests that haven't been accepted, freeing up their connection request capacity (LinkedIn limits you to ~1,200 pending invitations at a time).

---

## Core Features

### Three Withdrawal Modes

| Mode | Description | Target Use Case |
|------|-------------|-----------------|
| **Count** | Withdraw N oldest connections | Quick cleanup of specific number |
| **Age** | Withdraw all connections older than X days/weeks/months | Time-based pruning |
| **Message** | Scan → Select → Withdraw by message content | Targeted campaign cleanup |

### Message Mode Flow (Scan & Select)
1. **Scanning Phase**: Scrolls through all pending invitations, groups them by normalized message content
2. **Selection Phase**: User reviews groups with expandable people lists, checkboxes, and "Show on Page" links  
3. **Withdrawal Phase**: Processes selected groups with live progress tracking

### Safety Features
- **Safety Stop**: Prevents clearing connections newer than a configurable threshold
- **Pause/Resume**: User can pause mid-operation and resume without losing progress
- **Background Persistence**: Closing the popup doesn't stop the operation; reopening restores UI state

---

## Technical Architecture

### Files
```
clearconnect/
├── manifest.json      # Chrome extension manifest (v3)
├── popup.html         # Extension popup UI structure
├── popup.css          # All styles (light/dark themes)
├── popup.js           # Popup logic, state management, message handling
├── content.js         # Injected into LinkedIn, performs actual DOM operations
├── background.js      # Service worker for message routing
└── icons/             # Extension icons
```

### Communication Flow
```
popup.js ─────► chrome.tabs.sendMessage() ─────► content.js
     ▲                                               │
     └──── chrome.runtime.onMessage ◄────────────────┘
```

### Key Message Actions
| Action | Direction | Purpose |
|--------|-----------|---------|
| `START_WITHDRAW` | popup → content | Begin count/age mode withdrawal |
| `SCAN_CONNECTIONS` | popup → content | Start message mode scanning |
| `WITHDRAW_SELECTED` | popup → content | Withdraw selected message groups |
| `UPDATE_STATUS` | content → popup | Live progress updates |
| `COMPLETED` | content → popup | Operation finished |
| `PAUSE_WITHDRAW` | popup → content | Pause current operation |
| `RESUME_WITHDRAW` | popup → content | Resume paused operation |

### State Management
- `chrome.storage.local` for persistence:
  - `savedScanResults`: Message groups found during last scan
  - `lastView`: Last UI view shown (for restoration)
  - `runningMode`: Current operation mode
  - `withdrawalHistory`: Array of session records
  - `alltimeCleared`: Total connections cleared lifetime

---

## Current Status (as of Jan 19, 2026)

### ✅ Completed
- [x] Three-mode UI (Count/Age/Message tabs)
- [x] Two-step progress display for Count/Age modes
- [x] Message mode scan with live partial results
- [x] Selection screen with expandable people lists
- [x] Pause/Resume functionality
- [x] Safety stop threshold
- [x] History page with session records
- [x] Dark/light theme support
- [x] Inline stats fade-in on completion
- [x] Withdrawal queue UI with focused styling

### 🔧 Recently Fixed (Jan 19)
- Capacity corrected from 30k to ~1,200 (pending invitations limit)
- Pause wait loops added to both Count/Age and Message mode withdrawal functions
- Withdrawal queue pre-populated with pending items, updates to active/completed as processed
- Step 1 (scrolling) fades out on completion
- Withdrawal progress bar colors based on status (green/orange/red)
- Health bar color coded by capacity usage (green/yellow/red)
- Live scan results use message as fallback for fullMessage

### 🚧 Known Issues / TODO
1. **Final testing needed**: Verify all fixes work end-to-end
2. **Error handling**: Some edge cases when LinkedIn DOM changes
3. **Rate limiting**: No adaptive slowdown when LinkedIn shows friction

---

## Roadmap

### Phase 1: MVP Stabilization (Current)
- Fix all reported bugs from testing
- Ensure all three modes work end-to-end
- Verify persistence across popup close/reopen

### Phase 2: UX Polish
- Animations and transitions
- Better error messages
- Keyboard shortcuts
- Batch selection in scan results

### Phase 3: Advanced Features
- Export history to CSV
- Scheduled runs (if possible via alarms API)
- Undo last withdrawal (if LinkedIn allows restore)
- Multi-account awareness

---

## Key Code Areas for Future Agents

### popup.js
| Function | Purpose |
|----------|---------|
| `init()` | Entry point, DOM refs, event listeners, state restoration |
| `startClearing()` | Initiates Count/Age mode |
| `startScan()` | Initiates Message mode scanning |
| `handleWithdrawSelected()` | Processes selected groups from scan |
| `handleMessage()` | Routes all messages from content.js |
| `updateWithdrawalQueue()` | Renders focused queue items with checkmarks |
| `renderScanResults()` | Builds selectable list of message groups |
| `showView()` | View switching with state persistence |

### content.js
| Function | Purpose |
|----------|---------|
| `startProcess()` | Begins scrolling + withdrawal for Count/Age |
| `processWithdrawButton()` | Handles single connection withdrawal |
| `scanConnections()` | Message mode: scrolls and indexes all messages |
| `withdrawSelected()` | Processes selected hashes from scan |
| `updateStatus()` | Sends progress to popup (with clearedData/partialResults) |
| `complete()` | Signals operation finished, sends stats |
| `normalizeMessage()` | Cleans message text for grouping (removes names, amounts, greetings) |

### popup.css
- CSS variables in `:root` for theming
- `.queue-item` classes for withdrawal queue styling
- `.pulsating-text` for scanning animation
- View-specific sections (`.progress-step`, `.scan-item`, etc.)

---

## Testing Checklist

Before any release, verify:

1. **Count Mode**: Start → Pause → Resume → Complete
2. **Age Mode**: Start → Safety stop triggers correctly
3. **Message Mode**: Scan → Select groups → Proceed → Stop → Returns to selection
4. **Persistence**: Close popup mid-operation → Reopen → Correct state restored
5. **History**: Cleared connections appear with project names (message mode)
6. **Themes**: Both light and dark work correctly

---

## Contributing Notes

- Always test on a LinkedIn account with pending invitations
- Chrome DevTools → background.js console for service worker logs
- popup.js logs to popup DevTools (right-click extension icon → Inspect popup)
- content.js logs to main page console (LinkedIn tab)
