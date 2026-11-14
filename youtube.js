// YouTube ad blocker (runs in the page's MAIN world at document_start).
//
// Two layers, mirroring how uBlock Origin / Brave handle YouTube:
//   1. Prune ad data out of YouTube's own player API responses before the
//      player ever sees them (kills most pre-roll / mid-roll ads).
//   2. A DOM fallback that skips / fast-forwards any ad that still plays.
//
// This script can't use chrome.* APIs (wrong world). The isolated content
// script sets <html data-ab-yt="off"> when the user disables blocking here.

(function () {
  if (window.__abYtPatched) return;
  window.__abYtPatched = true;

  const PLAYER_RE = /\/youtubei\/v1\/(player|next|reel_item_watch|reel_watch_sequence)/;
  const AD_KEYS = [
    "adPlacements",
    "adSlots",
    "playerAds",
    "adBreakHeartbeatParams",
  ];

  const enabled = () => document.documentElement.dataset.abYt !== "off";

  // Strip ad fields from a parsed player/next response object.
  function prune(data) {
    if (!data || typeof data !== "object") return data;
    for (const k of AD_KEYS) {
      if (k in data) delete data[k];
    }
    // Some responses nest the player payload one level down.
    if (data.playerResponse) prune(data.playerResponse);
    if (Array.isArray(data)) data.forEach(prune);
    return data;
  }

  // --- Layer 1a: patch fetch (YouTube's primary transport) -----------------
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      if (!enabled()) return res;
      const req = args[0];
      const url = typeof req === "string" ? req : req && req.url ? req.url : "";
      if (!PLAYER_RE.test(url)) return res;

      const text = await res.clone().text();
      const json = JSON.parse(text);
      prune(json);
      return new Response(JSON.stringify(json), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } catch (_) {
      return res; // anything unexpected -> hand back the untouched response
    }
  };

  // --- Layer 1b: best-effort XHR patch -------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__abUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (enabled() && PLAYER_RE.test(this.__abUrl || "")) {
      this.addEventListener("readystatechange", function () {
        if (this.readyState === 4) {
          try {
            const json = JSON.parse(this.responseText);
            prune(json);
            const str = JSON.stringify(json);
            Object.defineProperty(this, "responseText", { value: str });
            Object.defineProperty(this, "response", { value: str });
          } catch (_) {}
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  // --- Layer 2: DOM fallback -- skip whatever still plays -------------------
  function skipAds() {
    if (!enabled()) return;

    // Click any visible "Skip" button.
    const skip = document.querySelector(
      ".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button"
    );
    if (skip) skip.click();

    // Close overlay/banner ads.
    const overlayClose = document.querySelector(".ytp-ad-overlay-close-button");
    if (overlayClose) overlayClose.click();

    // If an ad is actively playing, jump to its end and mute it.
    const player = document.querySelector("#movie_player, .html5-video-player");
    const video = document.querySelector("video.html5-main-video, video");
    if (player && player.classList.contains("ad-showing") && video) {
      if (isFinite(video.duration) && video.duration > 0) {
        video.currentTime = video.duration;
      }
      video.muted = true;
      video.playbackRate = 16;
    }

    // Dismiss the "ad blockers are not allowed" enforcement popup, if shown.
    const dialog = document.querySelector("tp-yt-paper-dialog, ytd-enforcement-message-view-model");
    if (dialog) {
      dialog.remove();
      document.body && (document.body.style.overflow = "");
      if (video && video.paused) video.play().catch(() => {});
    }
  }

  // Run on a light interval plus on SPA navigations.
  setInterval(skipAds, 500);
  window.addEventListener("yt-navigate-finish", skipAds, true);
})();
