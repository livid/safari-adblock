// The blocked address arrives in the URL fragment. The background confirms it is on a threat
// list before the page names it or offers to go on. t() comes from i18n.js.

const ALLOW_PRIORITY = 40; // above the threat rule's 30 in background.js
// Same list as background.js. Safari rejects a rule that lists "object" or "webtransport".
const ALL_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "xmlhttprequest", "ping", "media", "websocket", "other",
];

let target = null;

const proceed = document.getElementById("proceed");
const hostEl = document.getElementById("host");
const note = document.getElementById("note");
proceed.hidden = true;
hostEl.textContent = t("unknownAddress");

// No bypass when embedded in another page (clickjacking) or without a confirmed address.
if (window.top === window) {
  const claimed = decodeURIComponent(location.hash.slice(1));
  chrome.runtime
    .sendMessage({ type: "check-blocked", url: claimed })
    .then((res) => {
      if (!res?.url) return;
      target = new URL(res.url);
      hostEl.textContent = target.hostname;
      proceed.hidden = false;
    })
    .catch(() => {});
}

document.getElementById("back").addEventListener("click", async () => {
  if (history.length > 1) {
    history.back();
  } else {
    const tab = await chrome.tabs.getCurrent();
    if (tab) chrome.tabs.remove(tab.id);
  }
});

// Allows the site until Safari quits. Done here rather than in the background: Safari
// recompiles every rule for this, which can take longer than the background is kept running.
proceed.addEventListener("click", async () => {
  proceed.disabled = true;
  note.textContent = t("opening");
  note.hidden = false;
  try {
    const dnr = chrome.declarativeNetRequest;
    const existing = await dnr.getSessionRules();
    const id = existing.reduce((max, r) => Math.max(max, r.id), 1000) + 1;
    await dnr.updateSessionRules({
      addRules: [
        {
          id,
          priority: ALLOW_PRIORITY,
          action: { type: "allow" },
          condition: { requestDomains: [target.hostname], resourceTypes: ALL_TYPES },
        },
      ],
    });
    location.replace(target.href);
  } catch {
    note.textContent = t("openFailed");
    proceed.disabled = false;
  }
});
