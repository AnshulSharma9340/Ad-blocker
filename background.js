// Service worker.
// Responsibilities:
//   1. Keep a running count of blocked requests (badge on the toolbar icon).
//   2. Global on/off  -> enable/disable the static rulesets.
//   3. Per-site allowlist -> dynamic "allowAllRequests" rules that disable
//      blocking on chosen sites.

const RULESET_IDS = ["easylist", "easyprivacy"];
const STORAGE_DEFAULTS = { enabled: true, allowlist: [], blockedCount: 0 };

// --- Blocked counter -------------------------------------------------------
// onRuleMatchedDebug only fires for unpacked (developer-mode) extensions, which
// is exactly how this is loaded. It's the live counter behind the badge.

let blockedCount = 0;

chrome.storage.local.get(STORAGE_DEFAULTS, (data) => {
  blockedCount = data.blockedCount || 0;
  updateBadge();
});

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(() => {
    blockedCount++;
    // Throttle writes a little to avoid hammering storage.
    if (blockedCount % 5 === 0) chrome.storage.local.set({ blockedCount });
    updateBadge();
  });
}

function updateBadge() {
  chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
  const text =
    blockedCount > 9999 ? "9k+" : blockedCount > 0 ? String(blockedCount) : "";
  chrome.action.setBadgeText({ text });
}

// --- Global on/off ---------------------------------------------------------

async function applyGlobalState(enabled) {
  try {
    if (enabled) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: RULESET_IDS,
      });
    } else {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        disableRulesetIds: RULESET_IDS,
      });
    }
  } catch (e) {
    console.warn("Failed to update rulesets:", e);
  }
}

// --- Per-site allowlist ----------------------------------------------------
// Rebuild the full set of dynamic allow rules from the stored allowlist.

async function rebuildAllowlistRules(allowlist) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  const addRules = allowlist.map((host, i) => ({
    id: i + 1,
    priority: 10000, // beat any static block rule
    action: { type: "allowAllRequests" },
    condition: {
      urlFilter: `||${host}^`,
      resourceTypes: ["main_frame", "sub_frame"],
    },
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules,
  });
}

// --- React to settings changes & startup -----------------------------------

async function syncFromStorage() {
  const { enabled, allowlist } = await chrome.storage.local.get(STORAGE_DEFAULTS);
  await applyGlobalState(enabled);
  await rebuildAllowlistRules(allowlist || []);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(STORAGE_DEFAULTS, (data) => {
    // Persist defaults on first install.
    chrome.storage.local.set(data, syncFromStorage);
  });
});

chrome.runtime.onStartup.addListener(syncFromStorage);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled) applyGlobalState(changes.enabled.newValue);
  if (changes.allowlist) rebuildAllowlistRules(changes.allowlist.newValue || []);
});

// Simple message API for the popup (e.g. resetting the counter).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "resetCount") {
    blockedCount = 0;
    chrome.storage.local.set({ blockedCount: 0 });
    updateBadge();
    sendResponse({ ok: true });
  }
  return true;
});
