// Popup logic: reads/writes settings in chrome.storage.local. The service
// worker reacts to those changes to enable/disable rulesets and allowlist rules.

const $ = (id) => document.getElementById(id);

let currentHost = "";

function hostFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return u.hostname;
  } catch (_) {}
  return "";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function render() {
  const { enabled = true, allowlist = [], blockedCount = 0 } =
    await chrome.storage.local.get({ enabled: true, allowlist: [], blockedCount: 0 });

  $("count").textContent = blockedCount.toLocaleString();

  // Global toggle
  $("global-toggle").checked = enabled;
  $("status-dot").classList.toggle("off", !enabled);
  $("global-sub").textContent = enabled ? "Enabled everywhere" : "Disabled";

  // Per-site toggle
  const tab = await getActiveTab();
  currentHost = hostFromUrl(tab?.url || "");
  const siteToggle = $("site-toggle");

  if (!currentHost) {
    $("site-host").textContent = "Not available here";
    siteToggle.disabled = true;
    siteToggle.checked = false;
    return;
  }
  $("site-host").textContent = currentHost;
  siteToggle.disabled = !enabled;
  // Checked = blocking ON for this site (i.e. NOT in allowlist).
  siteToggle.checked = !allowlist.includes(currentHost);
}

async function reloadActiveTab() {
  const tab = await getActiveTab();
  if (tab?.id) chrome.tabs.reload(tab.id);
}

// --- Events ---------------------------------------------------------------

$("global-toggle").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
  await render();
  reloadActiveTab();
});

$("site-toggle").addEventListener("change", async (e) => {
  if (!currentHost) return;
  const { allowlist = [] } = await chrome.storage.local.get({ allowlist: [] });
  const set = new Set(allowlist);
  if (e.target.checked) set.delete(currentHost); // blocking on -> remove from allowlist
  else set.add(currentHost); // blocking off -> add to allowlist
  await chrome.storage.local.set({ allowlist: [...set] });
  reloadActiveTab();
});

$("reset").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "resetCount" });
  $("count").textContent = "0";
});

render();
