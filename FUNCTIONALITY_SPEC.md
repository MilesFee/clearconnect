# ClearConnect Functionality Specification
> **Draft Date:** February 14, 2026
> **Branch:** Main
> **Purpose:** Detailed documentation of exact functionality, UI states, text/copy, and logic flows to ensure preservation during future development.

---

## 0. General UX & Design Philosophy

- **Visual Style:** Clean, modern interface using Brand Primary (`#f63409`) for actions/highlights and clean dark mode scheme when toggled on in settings.
- **Animations:** "Smooth but not over the top".
  - **View Transitions:** All main views fade up (`animation: fadeInUp 0.2s ease`).
  - **Interactions:** Buttons and inputs have `0.2s` transitions on hover/focus.
  - **Progress:** Progress bars fill smoothly.
  - **Active States:** "Scanning..." text pulsates; Active step labels use a subtle wave effect.
- **Layout (Hybrid):** 
  - **Popup:** Fixed width (400px), responsive height. Opens by default when extension is clicked in **IDLE** state. Only view for:
    - **Home Page**
    - **Stats Page**
    - **History Page**
    - **Settings Page**
  - **Side Panel:** Automatically sized by Chrome (min-width 320px). Opens by default when extension is clicked in **ACTIVE** state. Only view for:
    - **Active Scanning**
    - **Selection**
    - **Withdrawal Monitoring**
    - **Post-Action Completion UI**

---

## 1. Core Concepts & Limits

- **Capacity Limit:** ~1,250 pending invitations. The app calculates capacity based on this limit.
- **Persistence:** Closing the Side Panel DOES NOT stop the background process. Reopening restores the exact UI state.
- **Background Logic:** `content.js` handles DOM interactions. `popup.js` handles initial setup. `sidepanel.js` handles active task monitoring.
- **State Handover:** Transitioning from Popup (Setup) to Side Panel (Active) passes all configuration parameters seamlessly. `chrome.storage.local` is the single source of truth for the *active* configuration, and both the Popup and Side Panel simply reflect that state.
- **Active State Behavior:** When an active process starts, the extension sets `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true})`. When idle/completed, it reverts to `false` (opening the Popup).

---

## 2. Home Page & Mode Selection

The entry point of the extension. **This view lives in the Popup.**

### Layout Structure
1.  **Header:**
    -   **Left:** Logo (Icon + "ClearConnect" text).
    -   **Right:** Action Icons (Stats, History, Settings).
2.  **Safety Badge (Top Banner):**
    -   Displays "Preserves connections sent within the last [X] [Unit]".
    -   Clicking the link opens/focuses the Safe Mode setting.
    -   The badge is only shown when safe mode is enabled.
3.  **Mode Toggle (Segmented Control):**
    -   Three tabs: **By Count | By Age | By Message**.
    -   Active tab is highlighted white/grey; inactive are transparent.
    -   The button cleanly slides to the new active tab with a smooth animation.
4.  **Dynamic Input Area:** Changes based on selected mode.
    -   **Count Mode:** Number Input + "people" suffix.
    -   **Age Mode:** Number Input + Unit Dropdown (Days/Weeks/Months/Years) + "ago +" suffix.
    -   **Message Mode:** Brief description text + **"Start Scan"** button (Primary action style with icon).
5.  **Contextual Description:** Small text below input explaining the action 
      - **Count Mode:** (e.g., "Withdraws the [[count entered]] oldest pending connections.").
      - **Age Mode:** (e.g., "Withdraws pending connections older than [[age entered]] [[unit entered]].").
      - **Message Mode:** (e.g., "Withdraws groups of pending connections based on message content.").
6.  **Primary Action:** **"Start Clearing"** button (Full width, Brand Color).
    -   *Note:* In Message Mode, this button is replaced by the "Start Scan" button in the input area.
7.  **Note:** Lifetime stats ("[X] connections cleared all-time 🎉").
8. **Footer:** Showing status message with multiple states
    - **Design:** a clean info bar with rounded corners, a colored border and tinted background color indicated by status.
      - **Initial State:** When extension first opened and user is on the correct page: Green check mark with text "You're on the Sent Invitations page.".
      - **Success State:** Green check mark with text "Cleared [X] connections!". Link to "view results" opens post completion UI from last action.
      - **User Stopped State:** Red stop sign with text "Stopped clearing. [X] connections cleared.". Link to "view results" opens post completion UI from last action.
      - **Safety Stop State:** Orange warning triangle with text "Safety stop triggered. [X] connections cleared.". Link to "view results" opens post completion UI from last action.
      - **Error State:** Yellow caution mark with text "Error: [Error Message]".

---

## 3. Withdrawal Modes & Flows

### A. Message Mode (The Complex One)
This mode has a unique 3-stage flow: **Scan -> Select -> Withdraw**.

#### Stage 1: Scanning
- **Trigger:** User clicks "Start Scan" on Message tab in the Popup.
- **UI State (Side Panel):** *The Popup closes and the Side Panel opens automatically upon clicking "Start Scan".*
  - **Top Bar:** "Safety Mode On" (if active) | Capacity Bar (Mini).
  - **Header:** "Scanning..." text pulsating (CSS animation).
  - **Progress Bar:** Shows progress of scroll/discovery.
  - **Live Results:** A list that populates in real-time with found message groups.
    - *Item Content:* Message snippet (short) and count of people in group.
    - *Note:* Message sample uses `item.message` fallback if full text isn't available yet.
- **Action (Content):** Scrolls page, groups invitations by normalized message content.

#### Stage 2: Selection (Intermediate Screen)
- **UI State (Side Panel):** `scanResults` view. This is a critical interactive screen.
  - **List:** All found message groups.
  - **Group Item Elements:**
    - **Topic:** Auto-generated from message content.
    - **Preview:** Short message text.
    - **Count:** Number of people in group.
  - **"Show People" Toggle:** Link text "Show X People in Group". Clicking expands a list of names/ages.
  - **Individual Person Links (Critical):**
    - Inside the expanded "Show People" list, each name is a clickable link.
    - **Behavior:** Clicking a name sends a command to the content script which **scrolls the LinkedIn page to that specific person's card** and highlights it yellow/processing color.
  - **Footer Buttons:** "Withdraw Selected" (Disabled if 0 selected) and "Cancel".
- **Action:** User selects groups and can verify individuals by clicking to scroll to them on the page.

#### Stage 3: Withdrawal (Active Processing)
- **Trigger:** User clicks "Withdraw Selected".
- **UI State (Side Panel):** `progress` view with `progress-layout-message`.
  - **Header:** "Withdrawing connections..."
  - **Progress Bar:** Top of page. Updates as people are removed.
  - **Status Text:** "[X/Y] Withdrawing [Name]..."
  - **Live Withdrawal Queue (Critical Feature):**
    - This is a scrolling list confirming exactly who is being removed in real-time.
    - **Pre-population:** Before starting, the queue is filled with **ALL** people from selected groups, initially marked as **"pending"** (dimmed).
    - **Active Item:** When processing starts for a person, their item status changes to **"active"**. It is **highlighted with the brand color** and the list **auto-scrolls** to keep this item centered.
    - **Completed Item:** When confirmed removed, item status changes to **"completed"**. It shows a **green checkmark** and fades slightly with the name crossed out.
  - **Controls:**
    - **Pause:** Pauses operation.
    - **Stop:**
      - If nothing removed: Returns to Stage 2 (Selection).
      - If connections removed: Progresses to **Post-Completion UI**.

---

### B. Count & Age Modes (Standard Flow)
These modes share a standard 2-step progress UI.

#### Flow
1. **User Input:** User enters count (e.g., 10) or Age (e.g., 3 weeks) and clicks "Start".
   - *Transition:* **Popup closes, Side Panel opens.**
2. **Step 1 (Scroll):** Extensions scrolls to end of page to find required connections or reach date threshold.
   - **Active UI:** Top half active (primary color border). Progress bar fills. 
    - **Status Text:** "Found [X/Y] connections..." or "Waiting for LinkedIn to load... [1s... 2s... 3s... Xs...]" (with a loading spinner)
   - **Inactive UI:** Top half inactive (desaturated). Progress bar filled.
    - **Inactive Status Text:** "Connections loaded" with check mark
   - **Queue:** In count mode, the queue will be empty until all items are found and then it will populate with last items who will be removed. In age mode, the queue will populate with matching items as found.
3. **Step 2 (Withdraw):** Withdraws identified connections.
   - **Active UI:** Bottom half active (primary color border). Progress bar fills.
   - **Inactive UI:** Bottom half inactive (desaturated). Progress bar empty.
    - Inactive status text: "Waiting to load all connections"
   - **Queue:** Uses the same live withdrawal queue as message mode.
    - This is a scrolling list confirming exactly who is being removed in real-time.
    - **Pre-population:** Before starting, the queue is filled with **ALL** people from the scan results (in age mode, matching the age criteria; in count mode, each of the last xx connections found), initially marked as **"pending"** (dimmed).
    - **Active Item:** When processing starts for a person, their item status changes to **"active"**. It is **highlighted with the brand color** and the list **auto-scrolls** to keep this item centered.
    - **Completed Item:** When confirmed removed, item status changes to **"completed"**. It shows a **green checkmark** and fades slightly with the name crossed out.

---

## 3. Post-Completion UI

**Crucial:** The transition must be seamless. The "progress" view transforms into the "completed" state gra

1. **Fade Out:** The active progress elements and queue fade out.
2. **Fade In (Upwards):** The Inline Stats section fades in gracefully from the bottom.

### Completion View Elements
1. **Inline Stats Section (Conditions):**
   - **Status Icon/Message:** Success (Green), Safety Stop (Orange), User Stop (Red).
   - **Message Mode Only:** Displays titles of the message groups that were just cleared.
   - **Data:**
     - **Cleared Count:** Number removed this session.
     - **Remaining:** Current pending invitations count.
2. **Capacity Bar (Below Stats):**
   - **Visual:** Progress bar indicating usage of the **~1,250** limit.
   - **Colors:** Green (<50%), Yellow (50-80%), Red (>80%).
   - **Text:** "[Remaining] / ~1,250".
3. **Withdrawn List:**
   - **Visual:** A collapsible container with a list of the names removed and connection age, follows design of the history accordion cards. The list will only expand to 6-8 items and scrolls inside rather than elongating the full Side Panel.
   - **Data:** Name, Age, and Message (if available).
   - **Action:** Clicking a name opens the LinkedIn profile in a new tab.
  

### Inline Continue Options
- **Count/Age Mode:** Radio buttons to "Clear [X] more" or "Clear older than [X]".
- **Message Mode:** Single button **"Select More Groups"**.
  - **Action:** Returns to **Stage 2 (Selection Screen)** to pick from remaining groups.

---

## 4. Stats Page (Detailed View)
Accessed via the "Stats" icon (top right).

**Data Displayed:**
- **Current Connections:** Actual count from LinkedIn page status.
- **Available Capacity:** Calculated as `1250 - Current Connections` (floor at 0).
- **Last Run:** Time elapsed since last operation (e.g., "2 hours ago").
- **Last Cleared:** Number removed in the last session.
 - **Capacity Health:**
  - Visual bar showing usage of ~1,250 limit.
  - Color Coded: Green (<25%), Yellow (25-50%), Orange (50-75%), Red (>75%).
- **All-Time:** Cumulative total of all connections removed by extension.

---

## 5. History Page
Accessed via "History" icon (top right).

- **Structure:** List of sessions ordered by date (newest first).
- **Session Header:** Date + Total Withdrawn count. (Click to toggle expand/collapse).
- **Session Items:**
  - **Name:** Link to LinkedIn profile.
  - **Age:** Connection age (e.g., "3 weeks").
  - **Project Name:** (Message Mode Only) Displayed below the name in smaller text.
  - **Time:** Timestamp of removal.

---

## 6. Settings Page
Accessed via "Settings" gear icon (top right).

- **Appearance:** Toggle between **Light** and **Dark** mode.
- **Safe Mode:**
  - **Toggle:** Enable/Disable safety features.
  - **Threshold Config:** Input number + Unit (Days/Weeks/Months).
  - **Description:** "Preserves connections sent within the last [X] [Units]".
- **Advanced Settings:**
  - **Link that toggles open further section with additional settings:**
    - **Debug Mode:**
      - **Toggle:** Enable/Disable debug mode.
      - **Description:** "Enables debug mode".

---

## 7. Navigation & Error Views

The extension intelligently detects context.
- **Popup:** Opens on any page. If not on LinkedIn Sent Invitations, prompts user to navigate there.
- **Side Panel:** Automatically opens when an **Active Process** (Scanning or Withdrawing) is started. Can also be opened manually if a process is running in the background. If opened manually while IDLE, displays a simple "Start a scan from the extension icon" message.

### A. Not on LinkedIn View
-   **Trigger:** User opens extension on a non-LinkedIn domain.
-   **UI State:**
    -   **Icon:** Warning circle (Orange).
    -   **Title:** "Not on LinkedIn".
    -   **Message:** "Whoops! Looks like you're not on LinkedIn."
    -   **Button:** "Open LinkedIn Sent Invitations".
        -   **Action:** Opens `https://www.linkedin.com/mynetwork/invitation-manager/sent/` in a **new tab**.

### B. Wrong Page View (On LinkedIn)
-   **Trigger:** User is on LinkedIn but not the "Sent Invitations" page.
-   **UI State:**
    -   **Icon:** Warning circle (Orange).
    -   **Title:** "Navigate to Sent".
    -   **Message:** "Uh oh! Looks like you're not on the Sent Invitations page."
    -   **Button:** "Open Sent Invitations".
        -   **Action:** Navigates the **current tab** to the Sent Invitations page.

### C. Clearing in progress (Contextual Side Panel View)
-   **Trigger:** The user has started the clearing process but navigates to another page that is not the Sent Invitations page currently being acted upon.
-   **UI State: (Side Panel)**
    -   **Icon:** Square with arrow pointing up right (Primary Color).
    -   **Title:** "Clearing in Progress".
    -   **Message:** "Currently clearing connections on the Background Tab. Navigating away pauses visual confirmation but the process continues unless paused." -> *Correction: Since content script relies on active tab context often, we pause automatically? Or assume background script handles it?* -> **Refined: "Clearing Paused. Please return to Sent Invitations page to continue."** (If technical limitations require active tab).
    -   **Decision:** "Clearing Paused" is safer.
      - **Title:** "Process Paused".
      - **Message:** "You navigated away from the Sent Invitations page."
      - **Button:** "Resume on Sent Page".
        -   **Action:** Navigates the current tab back to Sent Invitations and resumes the queue.
    -   **Alternative (If technically feasible to run in background tab):**
      - **Title:** "Clearing in Background".
      - **Status:** Standard progress bar.
      - **Button:** "Return to View".
        