// Clicking the toolbar icon (or Alt+D) opens the Debrief side panel.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Away detection: when the computer has no mouse/keyboard activity for 10 min,
// or the screen is locked, remember when it started. When the rep comes back,
// the away period is queued for the side panel, which turns it into a break
// (screen locked) or asks the rep (just idle — they may have been on a long call).
// No network here: the panel does the saving.
// ---------------------------------------------------------------------------
const IDLE_SECS = 600;
const AWAY_KEY = "debrief.away";
const PENDING_KEY = "debrief.awayPending";
chrome.idle.setDetectionInterval(IDLE_SECS);
chrome.idle.onStateChanged.addListener(async (st) => {
  const now = Date.now();
  const away = (await chrome.storage.local.get(AWAY_KEY))[AWAY_KEY];
  if (st !== "active") {
    if (!away) {
      await chrome.storage.local.set({
        [AWAY_KEY]: { start: st === "locked" ? now : now - IDLE_SECS * 1000, locked: st === "locked" },
      });
    } else if (st === "locked" && !away.locked) {
      await chrome.storage.local.set({ [AWAY_KEY]: { ...away, locked: true } });
    }
    return;
  }
  if (!away) return;
  await chrome.storage.local.remove(AWAY_KEY);
  if (now - away.start < 5 * 60 * 1000) return;
  const list = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] || [];
  list.push({ start: away.start, end: now, locked: !!away.locked });
  await chrome.storage.local.set({ [PENDING_KEY]: list.slice(-10) });
});
