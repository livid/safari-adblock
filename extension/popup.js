// t() comes from i18n.js.
const DEFAULT_SETTINGS = { ads: true, threats: true, cosmetic: true };
const $ = (id) => document.getElementById(id);

let tab = null;
let host = null;

async function getState() {
  const state = await chrome.storage.local.get({ settings: DEFAULT_SETTINGS, allowlist: [], feeds: {}, skipped: 0 });
  state.settings = { ...DEFAULT_SETTINGS, ...state.settings };
  return state;
}

function ago(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return t("justNow");
  if (min < 60) return t("minutesAgo", min);
  const h = Math.round(min / 60);
  return h < 48 ? t("hoursAgo", h) : t("daysAgo", Math.round(h / 24));
}

function renderLists(feeds, skipped) {
  const list = Object.values(feeds);
  const total = list.reduce((n, f) => n + (f.domains?.length || 0), 0);
  const newest = Math.max(0, ...list.map((f) => f.updated || 0));
  const failed = list.some((f) => f.error);
  const el = $("lists");
  if (!newest) {
    el.textContent = failed ? t("listsFailed") : t("listsDownloading");
  } else {
    el.textContent = t("listsSummary", total.toLocaleString(), ago(newest));
    if (failed) el.textContent += " · " + t("listsSomeFailed");
    // Safari caps an extension's rules; the bundled lists come first.
    if (skipped > 0) el.textContent += " · " + t("listsSkipped", skipped.toLocaleString());
  }
  el.classList.toggle("error", failed);
}

function formatBytes(n) {
  if (n < 1e6) return `${Math.round(n / 1e3)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e8 ? 1 : 0)} MB`;
  return `${(n / 1e9).toFixed(n < 1e11 ? 2 : 0)} GB`;
}

function renderTotals(stats) {
  $("totalBlocked").textContent = (stats?.blocked || 0).toLocaleString();
  $("totalSaved").textContent = "≈ " + formatBytes(stats?.bytes || 0);
}

async function render() {
  const { settings, allowlist, feeds, skipped } = await getState();

  for (const input of document.querySelectorAll("[data-setting]")) {
    input.checked = settings[input.dataset.setting];
  }

  const siteToggle = $("siteToggle");
  if (host) {
    const paused = allowlist.includes(host);
    $("host").textContent = host;
    siteToggle.checked = !paused;
    $("status").textContent = paused ? t("sitePaused") : t("protectionOn");
    $("status").classList.toggle("paused", paused);
  } else {
    $("host").textContent = t("thisPage");
    $("status").textContent = t("browserPage");
    siteToggle.checked = false;
    siteToggle.disabled = true;
  }

  renderLists(feeds, skipped);
}

// The toolbar badge carries the count; otherwise ask for the tab's matched rules, which in
// Safari are all blocked requests. Returns null when neither works, so no false "0" is shown.
async function blockedOnPage(tabId) {
  const text = await chrome.action.getBadgeText({ tabId }).catch(() => "");
  if (/^\d+$/.test(text)) return Number(text);
  try {
    return (await chrome.declarativeNetRequest.getMatchedRules({ tabId })).rulesMatchedInfo.length;
  } catch {
    return null;
  }
}

// Resolves when the background next finishes applying rules, or after `ms` regardless.
function rulesApplied(ms) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.storage.onChanged.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (changes) => changes.appliedAt && done();
    const timer = setTimeout(done, ms);
    chrome.storage.onChanged.addListener(listener);
  });
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab.url);
    if (/^https?:$/.test(url.protocol)) host = url.hostname.replace(/^www\./, "");
  } catch {}

  await render();

  // Totals are added up by the background from Safari's list of recently blocked requests;
  // ask it to catch up so they're current while the popup is open.
  if (chrome.declarativeNetRequest.getMatchedRules) {
    renderTotals((await chrome.storage.local.get("stats")).stats);
    chrome.runtime.sendMessage({ type: "collect-totals" }).catch(() => {});
  } else {
    $("totals").hidden = true;
  }

  if (tab && host) {
    const count = await blockedOnPage(tab.id);
    if (count == null) $("countBox").hidden = true;
    else $("count").textContent = count.toLocaleString();
  }

  $("siteToggle").addEventListener("change", async (e) => {
    const { allowlist } = await getState();
    const next = allowlist.filter((d) => d !== host);
    if (!e.target.checked) next.push(host);
    const applied = rulesApplied(60_000);
    await chrome.storage.local.set({ allowlist: next });
    await render();
    // Safari recompiles every rule for this, which can take it up to a minute; reload once
    // it's done so the change shows.
    $("siteToggle").disabled = true;
    $("status").textContent = t("applying");
    await applied;
    $("siteToggle").disabled = false;
    await render();
    chrome.tabs.reload(tab.id);
  });

  for (const input of document.querySelectorAll("[data-setting]")) {
    input.addEventListener("change", async () => {
      const { settings } = await getState();
      settings[input.dataset.setting] = input.checked;
      await chrome.storage.local.set({ settings });
    });
  }

  $("update").addEventListener("click", async () => {
    const btn = $("update");
    btn.disabled = true;
    btn.textContent = t("updating");
    await chrome.runtime.sendMessage({ type: "update-feeds" }).catch(() => {});
    btn.disabled = false;
    btn.textContent = t("updateLists");
    await render();
  });

  chrome.storage.onChanged.addListener(async (changes) => {
    if (changes.feeds || changes.skipped) {
      const { feeds, skipped } = await getState();
      renderLists(feeds, skipped);
    }
    if (changes.stats) renderTotals(changes.stats.newValue);
  });
}

init();
