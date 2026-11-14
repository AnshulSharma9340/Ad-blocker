// Content script (runs at document_start on every frame).
// Hides leftover ad elements that aren't blocked at the network level, using
// cosmetic selectors extracted from the filter lists.

(async function () {
  const host = location.hostname;
  if (!host) return;

  // Respect global on/off and the per-site allowlist.
  const { enabled = true, allowlist = [] } = await chrome.storage.local.get({
    enabled: true,
    allowlist: [],
  });
  const allowlisted = allowlist.some((h) => host === h || host.endsWith("." + h));
  const blocking = enabled && !allowlisted;

  // Tell the MAIN-world YouTube script (youtube.js) whether to act. It defaults
  // to ON, so we only need to flag the OFF case.
  if (!blocking) document.documentElement.dataset.abYt = "off";

  if (!blocking) return;

  // Load the cosmetic selector database (bundled with the extension).
  let db;
  try {
    const res = await fetch(chrome.runtime.getURL("data/cosmetic.json"));
    db = await res.json();
  } catch (e) {
    return; // no cosmetic data -> network blocking still works
  }

  // Collect selectors that apply to this host: all generic ones, plus any
  // keyed to this domain or one of its parent domains (a.b.example.com ->
  // also match b.example.com and example.com).
  const selectors = Array.isArray(db.generic) ? db.generic.slice() : [];
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    const specific = db.specific?.[candidate];
    if (specific) selectors.push(...specific);
  }
  if (selectors.length === 0) return;

  // Inject in chunks instead of one giant comma list: in CSS a single invalid
  // selector drops the entire rule, so chunking limits the blast radius if a
  // malformed selector ever slips through. A <style> rule also covers nodes
  // added later, so no MutationObserver is needed just to keep things hidden.
  const CHUNK = 100;
  const parts = [];
  for (let i = 0; i < selectors.length; i += CHUNK) {
    parts.push(selectors.slice(i, i + CHUNK).join(",") + "{display:none !important;}");
  }
  const style = document.createElement("style");
  style.id = "advanced-ad-blocker-cosmetic";
  style.textContent = parts.join("\n");
  (document.head || document.documentElement).appendChild(style);
})();
