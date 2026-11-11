// Shield background worker (Safari): keeps blocking rules in sync with settings and remote
// blocklists, shows the warning page for dangerous sites, and keeps the lifetime totals.

const FEEDS = {
  ads: {
    kind: "ads",
    url: "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&showintro=0&mimetype=plaintext",
  },
  malware: {
    kind: "threats",
    url: "https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-domains-online.txt",
  },
  phishing: {
    kind: "threats",
    url: "https://malware-filter.gitlab.io/malware-filter/phishing-filter-domains.txt",
  },
};

const MAX_DOMAINS_PER_FEED = 30000;
const UPDATE_ALARM = "update-feeds";
const UPDATE_PERIOD_MIN = 12 * 60;

// Built-in threats (browser cryptominers) so protection works before the first feed download.
const THREAT_SEED = [
  "coinhive.com", "coin-hive.com", "authedmine.com", "crypto-loot.com", "cryptoloot.pro",
  "coinimp.com", "jsecoin.com", "webminepool.com", "minero.cc", "monerominer.rocks",
  "coinerra.com", "ppoi.org", "minr.pw", "webmine.cz", "cryptonoter.com", "mineralt.io",
];

// Never block these via a threat feed, even if a feed lists them: a bad entry here
// would take out a large part of the web. Subdomains of the first group are protected too.
const NEVER_BLOCK_TREE = [
  "google.com", "googleapis.com", "gstatic.com", "googleusercontent.com", "youtube.com",
  "microsoft.com", "live.com", "office.com", "windows.net", "apple.com", "icloud.com",
  "amazon.com", "amazonaws.com", "cloudfront.net", "github.com", "githubusercontent.com",
  "gitlab.com", "dropbox.com", "dropboxusercontent.com", "discord.com", "discordapp.com",
  "cloudflare.com", "wikipedia.org", "abuse.ch",
];
const NEVER_BLOCK_EXACT = [
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "web.app", "firebaseapp.com",
  "vercel.app", "netlify.app", "weebly.com", "wixsite.com", "blogspot.com", "wordpress.com",
  "translate.goog", "herokuapp.com", "azurewebsites.net", "r2.dev",
];

const RULE = { THREAT: 1, AD_FEED: 3, ALLOWLIST: 4 };
// Static ad rules use priority 1-4. A paused site beats ad rules but never threat rules.
const PRIORITY = { ADS: 1, ALLOWLIST: 20, THREAT: 30 }; // blocked.js allows a site at 40
// Safari rejects a rule that lists "object" or "webtransport", so they're left out.
const ALL_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "xmlhttprequest", "ping", "media", "websocket", "other",
];

const DEFAULT_SETTINGS = { ads: true, threats: true, cosmetic: true };
// Sites left alone out of the box. They appear as "paused" in the popup and can be switched back on.
const DEFAULT_PAUSED_SITES = ["youtube.com", "youtube-nocookie.com"]; // the second serves embedded players
const GENERIC_COSMETIC_ID = "generic-cosmetic";
const WEB_PAGES = ["http://*/*", "https://*/*"];
const WARNING_PAGE = chrome.runtime.getURL("blocked.html");

const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

async function getState() {
  const state = await chrome.storage.local.get({ settings: DEFAULT_SETTINGS, allowlist: [], feeds: {} });
  state.settings = { ...DEFAULT_SETTINGS, ...state.settings };
  return state;
}

function parseDomains(text) {
  const out = new Set();
  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0].trim().toLowerCase();
    if (!line || line.startsWith("!")) continue;
    const host = line.split(/\s+/).pop(); // handles "0.0.0.0 example.com" hosts format too
    if (DOMAIN_RE.test(host) || IPV4_RE.test(host)) out.add(host);
    if (out.size >= MAX_DOMAINS_PER_FEED) break;
  }
  return [...out];
}

function isProtected(domain) {
  return (
    NEVER_BLOCK_EXACT.includes(domain) ||
    NEVER_BLOCK_TREE.some((d) => domain === d || domain.endsWith("." + d))
  );
}

function threatDomains(feeds) {
  const all = new Set(THREAT_SEED);
  for (const [name, feed] of Object.entries(FEEDS)) {
    if (feed.kind !== "threats") continue;
    for (const d of feeds[name]?.domains ?? []) if (!isProtected(d)) all.add(d);
  }
  return [...all];
}

const loadJson = (file) => fetch(chrome.runtime.getURL(file)).then((r) => r.json());
const isPaused = (host, allowlist) => allowlist.some((d) => host === d || host.endsWith("." + d));
// True if host or one of its parent domains is in the set (requestDomains match subdomains too).
function listedIn(host, set) {
  for (let h = host; ; h = h.slice(h.indexOf(".") + 1)) {
    if (set.has(h)) return true;
    if (!h.includes(".")) return false;
  }
}

// ---- Safari's rule budget
//
// Safari compiles every enabled rule (bundled, dynamic and session) into one WebKit content
// blocker that holds at most 150,000 rules, and each requestDomains entry becomes a rule of
// its own. The bundled lists take most of that, so the downloaded lists get what's left, most
// important first. tools/count-webkit-rules.swift measures the bundled rulesets.
const WEBKIT_RULE_LIMIT = 150_000;
const BUDGET_MARGIN = 300; // the bundled counts are measured exactly; this covers small surprises
// Bump when the dynamic rules change shape, so existing installs rebuild them on next start.
const RULES_VERSION = 3;

let measuredCounts;
async function bundledRuleCost(rulesetIds) {
  measuredCounts ??= loadJson("rules/webkit-rule-counts.json").catch(() => ({}));
  const counts = await measuredCounts;
  let total = 0;
  for (const id of rulesetIds) {
    if (Number.isInteger(counts[id])) {
      total += counts[id];
    } else {
      // Not measured: estimate generously from the domain counts.
      const rules = await loadJson(`rules/${id}.json`).catch(() => []);
      total += Math.ceil(1.05 * rules.reduce((n, r) => n + Math.max(1, r.condition.requestDomains?.length ?? 0), 0));
    }
  }
  return total;
}

// Hosts the bundled ad and privacy lists block outright: listing them again in the
// downloaded ad feed would only spend budget.
let bundledBlocked;
function hostsBlockedByBundledLists() {
  bundledBlocked ??= Promise.all(["ads", "privacy"].map((id) => loadJson(`rules/${id}.json`).catch(() => []))).then(
    (lists) => {
      const hosts = new Set();
      for (const rules of lists) {
        for (const { action, condition } of rules) {
          const only = Object.keys(condition);
          if (action.type === "block" && only.length === 1 && only[0] === "requestDomains") {
            for (const d of condition.requestDomains) hosts.add(d);
          }
        }
      }
      return hosts;
    }
  );
  return bundledBlocked;
}

// Builds the dynamic rules within `budget` WebKit rules: paused sites first, then dangerous
// sites, then the downloaded ad list. `skipped` counts listed domains that didn't fit.
function buildRules({ settings, allowlist, feeds }, { budget = Infinity, bundledHosts = null } = {}) {
  let left = budget;
  let skipped = 0;
  const take = (list) => {
    const out = list.slice(0, Math.max(0, left));
    left -= out.length;
    skipped += list.length - out.length;
    return out;
  };
  const rules = [];
  const add = (id, priority, action, domains, extra = {}) => {
    if (domains.length) rules.push({ id, priority, action, condition: { requestDomains: domains, ...extra } });
  };

  // sub_frame: a paused site is also left alone when embedded in another page (e.g. video players).
  add(RULE.ALLOWLIST, PRIORITY.ALLOWLIST, { type: "allowAllRequests" }, take(allowlist), {
    resourceTypes: ["main_frame", "sub_frame"],
  });

  // Everything from a dangerous host is blocked, page loads included. Safari ignores redirect
  // rules for page loads, so the warning page is opened by the navigation listener below.
  if (settings.threats) {
    add(RULE.THREAT, PRIORITY.THREAT, { type: "block" }, take(threatDomains(feeds)), { resourceTypes: ALL_TYPES });
  }

  if (settings.ads) {
    const feed = feeds.ads?.domains ?? [];
    add(RULE.AD_FEED, PRIORITY.ADS, { type: "block" }, take(bundledHosts ? feed.filter((d) => !listedIn(d, bundledHosts)) : feed));
  }
  return { rules, skipped };
}

// Rule updates are serialized so overlapping triggers can't interleave.
let queue = Promise.resolve();
function applyRules() {
  queue = queue.then(doApplyRules).catch((e) => console.error("Shield: applying rules failed", e));
  return queue;
}

// Same rules, ignoring fields Safari may fill in with defaults when it hands them back.
const signature = (rules) =>
  JSON.stringify(
    [...rules].sort((a, b) => a.id - b.id).map((r) => [r.id, r.priority, r.action.type, r.condition.requestDomains ?? null])
  );

// Every rule change makes Safari recompile all ~145k rules, which takes it 20-40 seconds,
// and it stops this worker 30 seconds after the last event even mid-call. So an apply does at
// most one compile per kind of change, skips any whose result is already in place, and marks
// completion last: a run that was cut off is finished cheaply on the next wake.
async function doApplyRules() {
  await chrome.storage.local.set({ rulesApplied: 0 });
  const state = await getState();
  const dnr = chrome.declarativeNetRequest;
  await syncGenericCosmetics(state); // cheap, so before the slow part

  // Static rulesets are compiled from Brave's default filter lists by tools/build-rules.mjs.
  const { ads, threats } = state.settings;
  const wanted = { ads, privacy: ads, annoyances: ads, threats };
  const current = new Set(await dnr.getEnabledRulesets());
  const target = Object.keys(wanted).filter((id) => wanted[id]);
  const enable = target.filter((id) => !current.has(id));
  const disable = Object.keys(wanted).filter((id) => !wanted[id] && current.has(id));

  // The dynamic rules go in first, sized to fit beside both the current and the wanted
  // rulesets, so neither step can push the total over Safari's limit.
  const both = [...new Set([...current, ...target])].filter((id) => id in wanted);
  const sessionCost = (await dnr.getSessionRules()).reduce((n, r) => n + Math.max(1, r.condition.requestDomains?.length ?? 0), 0);
  const budget = WEBKIT_RULE_LIMIT - BUDGET_MARGIN - sessionCost - (await bundledRuleCost(both));
  const bundledHosts = ads ? await hostsBlockedByBundledLists() : null;
  const existing = await dnr.getDynamicRules();

  // If the estimate was off and Safari still refuses, shrink rather than lose everything.
  let lastError;
  for (const size of [budget, budget - 2_000, budget / 2, 0]) {
    const { rules, skipped } = buildRules(state, { budget: Math.max(0, Math.floor(size)), bundledHosts });
    try {
      // Removing every existing id, not just ours, so a stray rule can't hold budget.
      if (signature(rules) !== signature(existing)) {
        await dnr.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: rules });
      }
      threatHosts = null;
      await chrome.storage.local.set({ skipped });
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      console.warn(`Shield: Safari rejected the rules with a budget of ${Math.floor(size)}:`, e.message);
    }
  }
  if (lastError) throw lastError;

  if (enable.length || disable.length) await dnr.updateEnabledRulesets({ enableRulesetIds: enable, disableRulesetIds: disable });
  await chrome.storage.local.set({ rulesApplied: RULES_VERSION, appliedAt: Date.now() });
}

// Generic element hiding is a registered stylesheet, so it applies before the page
// paints and without waking this worker. Paused sites and sites the lists exempt are excluded.
async function syncGenericCosmetics({ settings, allowlist }) {
  // Safari logs every rejected call, so only unregister what is there.
  if ((await chrome.scripting.getRegisteredContentScripts({ ids: [GENERIC_COSMETIC_ID] })).length) {
    await chrome.scripting.unregisterContentScripts({ ids: [GENERIC_COSMETIC_ID] }).catch(() => {});
  }
  if (!settings.ads || !settings.cosmetic) return;

  const patterns = (hosts) =>
    hosts.flatMap((h) => (IPV4_RE.test(h) ? [`*://${h}/*`] : [`*://${h}/*`, `*://*.${h}/*`]));
  const script = { id: GENERIC_COSMETIC_ID, css: ["cosmetic/generic.css"], matches: WEB_PAGES, runAt: "document_start" };
  const exempt = await loadJson("cosmetic/no-generic.json").catch(() => []);
  try {
    await chrome.scripting.registerContentScripts([{ ...script, excludeMatches: patterns([...allowlist, ...exempt]) }]);
  } catch (e) {
    console.warn("Shield: registering without list exemptions:", e.message);
    await chrome.scripting.registerContentScripts([{ ...script, excludeMatches: patterns(allowlist) }]);
  }
}

// Site-specific element hiding is looked up per navigation.
let specificCosmetics;
chrome.webNavigation.onCommitted.addListener(
  async ({ tabId, frameId, url }) => {
    if (frameId !== 0) return;
    const host = new URL(url).hostname;
    const { settings, allowlist } = await chrome.storage.local.get({ settings: DEFAULT_SETTINGS, allowlist: [] });
    if (settings.ads === false || settings.cosmetic === false || isPaused(host, allowlist)) return;

    specificCosmetics ??= loadJson("cosmetic/specific.json").catch(() => ({}));
    const table = await specificCosmetics;
    const selectors = [];
    // Check the hostname and each parent domain: a.b.example.com, b.example.com, example.com.
    for (let h = host; h.includes("."); h = h.slice(h.indexOf(".") + 1)) {
      if (Object.hasOwn(table, h)) selectors.push(...table[h]);
    }
    if (!selectors.length) return;
    const css = selectors.map((s) => `${s}{display:none!important}`).join("\n");
    // Not every Safari release accepts `origin`; fall back to an author stylesheet.
    chrome.scripting
      .insertCSS({ target: { tabId }, css, origin: "USER" })
      .catch(() => chrome.scripting.insertCSS({ target: { tabId }, css }))
      .catch(() => {});
  },
  { url: [{ schemes: ["http", "https"] }] }
);


// ---- warning page

// Each tab's latest top-level address, for sizing the totals.
const lastNavigation = new Map();

// Hosts on the threat rule, loaded once per worker run and dropped when the rules change.
let threatHosts = null;
async function isListedThreat(host) {
  threatHosts ??= chrome.declarativeNetRequest
    .getDynamicRules()
    .then((rules) => new Set(rules.find((r) => r.id === RULE.THREAT)?.condition.requestDomains ?? []));
  return listedIn(host, await threatHosts);
}

async function allowedThisSession(host) {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  return rules.some((r) => (r.condition.requestDomains ?? []).some((d) => host === d || host.endsWith("." + d)));
}

// The threat rule stops the page from loading; this swaps Safari's error page for ours. The
// address rides in the fragment: Safari gives the tab a new id once it shows an extension page,
// so it can't be looked up by tab later. Only this extension can open the page (it isn't web
// accessible), and the page has its address re-checked before offering to go on.
chrome.webNavigation.onBeforeNavigate.addListener(
  async ({ tabId, frameId, url }) => {
    if (frameId !== 0) return;
    lastNavigation.set(tabId, url);
    const host = new URL(url).hostname;
    if ((await isListedThreat(host)) && !(await allowedThisSession(host))) {
      chrome.tabs.update(tabId, { url: `${WARNING_PAGE}#${encodeURIComponent(url)}` }).catch(() => {});
    }
  },
  { url: [{ schemes: ["http", "https"] }] }
);

// The address itself if it's an http(s) address on the threat list, else null.
async function listedThreatUrl(text) {
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return (await isListedThreat(url.hostname)) ? url.href : null;
  } catch {
    return null;
  }
}

const fromWarningPage = (sender) => sender.url?.startsWith(WARNING_PAGE) && sender.frameId === 0 && sender.tab;

// ---- lifetime totals shown in the popup header
//
// Safari has no per-request match events, but getMatchedRules lists recently blocked requests
// (address, tab and time only). They're added up from a stored watermark whenever a page
// finishes loading or the popup opens, and once more a minute after the last page load.

const TOTALS_ALARM = "collect-totals";
// A blocked request never loads, so "data saved" is an estimate: a typical transfer size for
// the kind of file the address points at. Safari doesn't say what kind of request it was.
const TYPICAL_BYTES = { page: 0, script: 30_000, frame: 15_000, image: 8_000, stylesheet: 10_000, font: 25_000, media: 300_000, other: 2_000 };
const KIND_BY_EXTENSION = {
  js: "script", mjs: "script", css: "stylesheet", html: "frame", htm: "frame",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", svg: "image", ico: "image",
  woff: "font", woff2: "font", ttf: "font", otf: "font",
  mp4: "media", webm: "media", m3u8: "media", mp3: "media", m4a: "media", ts: "media",
};

function typicalBytes({ request, tabId }) {
  if (lastNavigation.get(tabId) === request.url) return TYPICAL_BYTES.page; // a dangerous site, stopped
  try {
    const ext = /\.([a-z0-9]+)$/i.exec(new URL(request.url).pathname)?.[1].toLowerCase();
    return TYPICAL_BYTES[KIND_BY_EXTENSION[ext] ?? "other"];
  } catch {
    return TYPICAL_BYTES.other;
  }
}

let collecting = Promise.resolve();
function collectTotals() {
  collecting = collecting.then(doCollectTotals).catch((e) => console.error("Shield: collecting totals failed", e));
  return collecting;
}

async function doCollectTotals() {
  const { stats, statsCursor } = await chrome.storage.local.get({
    stats: { blocked: 0, bytes: 0 },
    statsCursor: { at: 0, seen: [] }, // newest timestamp counted, and the entries counted at it
  });
  const filter = statsCursor.at ? { minTimeStamp: statsCursor.at } : {};
  const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules(filter);
  const key = (m) => `${m.tabId} ${m.timeStamp} ${m.request.url}`;
  const seen = new Set(statsCursor.seen);
  const fresh = rulesMatchedInfo.filter((m) => m.timeStamp > statsCursor.at || (m.timeStamp === statsCursor.at && !seen.has(key(m))));
  if (!fresh.length) return 0;

  let { blocked, bytes } = stats;
  let newest = statsCursor.at;
  for (const m of fresh) {
    blocked++;
    bytes += typicalBytes(m);
    if (m.timeStamp > newest) newest = m.timeStamp;
  }
  const atNewest = fresh.filter((m) => m.timeStamp === newest).map(key);
  await chrome.storage.local.set({
    stats: { blocked, bytes },
    statsCursor: { at: newest, seen: newest === statsCursor.at ? [...seen, ...atNewest] : atNewest },
  });
  return fresh.length;
}

chrome.webNavigation.onCompleted.addListener(
  ({ frameId }) => {
    if (frameId !== 0) return;
    collectTotals();
    // Pages keep blocking after they load (lazy ads, refreshes): look again in a minute.
    chrome.alarms.create(TOTALS_ALARM, { delayInMinutes: 1 });
  },
  { url: [{ schemes: ["http", "https"] }] }
);
chrome.tabs.onRemoved.addListener(() => collectTotals());

// ---- feeds and lifecycle

async function updateFeeds() {
  const { feeds } = await getState();
  await Promise.all(
    Object.entries(FEEDS).map(async ([name, feed]) => {
      const prev = feeds[name] ?? { domains: [], updated: 0 };
      try {
        const res = await fetch(feed.url, { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const domains = parseDomains(await res.text());
        if (!domains.length) throw new Error("list was empty");
        feeds[name] = { domains, updated: Date.now(), error: null };
      } catch (e) {
        feeds[name] = { ...prev, error: String(e.message || e) }; // keep the last good copy
      }
    })
  );
  await chrome.storage.local.set({ feeds });
  await applyRules();
}

// Adds each default paused site once, so switching one back on in the popup sticks.
async function seedPausedSites() {
  const { allowlist, seededPaused } = await chrome.storage.local.get({ allowlist: [], seededPaused: [] });
  const fresh = DEFAULT_PAUSED_SITES.filter((d) => !seededPaused.includes(d));
  if (!fresh.length) return;
  await chrome.storage.local.set({
    allowlist: [...new Set([...allowlist, ...fresh])],
    seededPaused: [...seededPaused, ...fresh],
  });
}

async function ensureAlarm() {
  if (!(await chrome.alarms.get(UPDATE_ALARM))) {
    chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: UPDATE_PERIOD_MIN });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
    await chrome.action.setBadgeBackgroundColor({ color: "#2f6fed" });
  } catch (e) {
    console.warn("Shield: badge count unavailable:", e.message);
  }
  installing = true;
  await ensureAlarm();
  await seedPausedSites();
  await updateFeeds(); // applies the rules once, with whatever lists could be downloaded
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  const { feeds } = await getState();
  const newest = Math.max(0, ...Object.values(feeds).map((f) => f.updated || 0));
  if (Date.now() - newest > UPDATE_PERIOD_MIN * 60_000) await updateFeeds();
});

// Safari stops this worker 30 seconds after its last event, even mid-task, and doesn't always
// fire onStartup. So each time the worker starts, finish anything a previous run left undone.
// This worker wakes on every navigation, so the checks are cheap when nothing is wrong.
let installing = false; // onInstalled applies the rules itself
(async () => {
  const { rulesApplied } = await chrome.storage.local.get("rulesApplied");
  if (installing) return;
  if (rulesApplied !== RULES_VERSION) return void (await applyRules());
  const state = await getState();
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [GENERIC_COSMETIC_ID] });
  if (state.settings.ads && state.settings.cosmetic && !registered.length) await syncGenericCosmetics(state);
})().catch((e) => console.error("Shield: startup check failed", e));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) updateFeeds();
  if (alarm.name === TOTALS_ALARM) collectTotals();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.settings || changes.allowlist)) applyRules();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "update-feeds") {
    updateFeeds().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === "collect-totals") {
    collectTotals().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.type === "check-blocked") {
    if (!fromWarningPage(sender)) return void sendResponse({ url: null });
    listedThreatUrl(msg.url).then((url) => sendResponse({ url }), () => sendResponse({ url: null }));
    return true;
  }
});
