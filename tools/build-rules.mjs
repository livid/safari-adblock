#!/usr/bin/env node
// Compiles the filter lists Brave Shields uses by default into declarativeNetRequest
// rulesets and cosmetic stylesheets for the Safari extension in ../extension.
//
//   node tools/build-rules.mjs
//   swift tools/count-webkit-rules.swift   # then re-measure for Safari's rule budget
//
// The list of sources is read from Brave's own catalog, so this stays in step
// with what Brave ships. Downloads are cached in tools/.cache and reused if a
// later download fails.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS, "..", "extension"); // output goes into the bundled extension
const CACHE = path.join(TOOLS, ".cache");
const CUSTOM_FILTERS = path.join(TOOLS, "custom-filters.txt"); // our own additions

const CATALOG_URL =
  "https://raw.githubusercontent.com/brave/adblock-resources/master/filter_lists/list_catalog.json";

// Brave catalog component -> our ruleset.
const COMPONENTS = {
  "Brave Default Adblock Filters": "ads",
  "Brave First Party Adblock Filters": "ads",
  "Brave Default Privacy Filters": "privacy",
  "Cookie notice blocker": "annoyances",
  "Mobile app promo blocker": "annoyances",
};

function rulesetFor(url, fallback) {
  if (/\/(badware|resource-abuse)\.txt$/.test(url)) return "threats";
  // URLhaus is refreshed at runtime by the extension; Android list is irrelevant.
  if (/urlhaus|android-specific/.test(url)) return null;
  return fallback;
}

const PRIORITY = { BLOCK: 1, ALLOW: 2, BLOCK_IMPORTANT: 3, ALLOW_IMPORTANT: 4 };

const NON_BLOCK_ID_BASE = 1_000_000;

// Safari rejects any rule that lists "object" or "webtransport", so they're never emitted.
const ALL_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "xmlhttprequest", "ping", "media", "websocket", "other",
];
// null: a type Safari can't target. A filter limited to such types is skipped.
const TYPE_OPTIONS = {
  script: "script", image: "image", stylesheet: "stylesheet", css: "stylesheet",
  object: null, "object-subrequest": null, xmlhttprequest: "xmlhttprequest",
  xhr: "xmlhttprequest", subdocument: "sub_frame", frame: "sub_frame", ping: "ping",
  beacon: "ping", media: "media", font: "font", websocket: "websocket", other: "other",
  document: "main_frame", doc: "main_frame",
};
const HIDE_EXCEPTION_OPTIONS = new Set(["generichide", "ghide", "elemhide", "ehide"]);

const DOMAIN_RE = /^(?=.{3,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const isHost = (h) => DOMAIN_RE.test(h) || IPV4_RE.test(h);
const isAscii = (s) => /^[\x21-\x7e]*$/.test(s);

// ---------------------------------------------------------------- download

// Plain https instead of fetch(): Node's fetch crashes on some list servers.
function httpGet(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "user-agent": "shield-build", "accept-encoding": "identity" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(httpGet(new URL(res.headers.location, url).href, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error("HTTP " + res.statusCode));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.setTimeout(60_000, () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

async function fetchText(url) {
  const file = path.join(CACHE, createHash("sha1").update(url).digest("hex") + ".txt");
  try {
    const text = await httpGet(url);
    await writeFile(file, text);
    return text;
  } catch (e) {
    try {
      const text = await readFile(file, "utf8");
      console.warn(`  ! ${url}: ${e.message}; using cached copy`);
      return text;
    } catch {
      console.warn(`  ! ${url}: ${e.message}; SKIPPED`);
      return null;
    }
  }
}

// ---------------------------------------------------------------- list reading

// uBlock-style "!#if" blocks. We present ourselves as a Safari MV3 blocker.
const ENV = { ext_ublock: true, ext_ubol: true, env_safari: true, env_mv3: true, cap_user_stylesheet: true };
function evalCondition(expr) {
  const js = expr.replace(/[a-z_][a-z0-9_]*/gi, (name) => String(Boolean(ENV[name])));
  if (!/^(?:true|false|[!&|() ])+$/.test(js)) return false;
  try {
    return Boolean(Function(`"use strict";return (${js});`)());
  } catch {
    return false;
  }
}

function* filterLines(text) {
  const stack = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("!#if ")) { stack.push(evalCondition(line.slice(5))); continue; }
    if (line === "!#else") { if (stack.length) stack.push(!stack.pop()); continue; }
    if (line === "!#endif") { stack.pop(); continue; }
    if (stack.includes(false)) continue;
    if (!line || line[0] === "!" || /^\[adblock/i.test(line) || /\s/.test(line) && !line.includes("#")) continue;
    yield line;
  }
}

// ---------------------------------------------------------------- cosmetic filters

const COSMETIC_RE = /^([^#\s]*)#(@?)([?$%]{0,2})#(.+)$/;
const PROCEDURAL = [
  ":has-text(", ":contains(", ":-abp-", ":xpath(", ":matches-", ":upward(", ":remove(",
  ":remove-attr(", ":remove-class(", ":style(", ":min-text-length(", ":watch-attr(",
  ":others(", ":spath(", ":nth-ancestor(", ":shadow(",
];

function isPlainSelector(sel) {
  if (sel.startsWith("+js(") || sel.startsWith("^") || /[{}]/.test(sel) || sel.length > 400) return false;
  if (PROCEDURAL.some((p) => sel.includes(p))) return false;
  // Unbalanced quotes or brackets would swallow the rest of the stylesheet.
  const stack = [];
  let quote = null;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === "\\") { i++; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") stack.push(c);
    else if (c === ")" || c === "]") {
      if (stack.pop() !== (c === ")" ? "(" : "[")) return false;
    }
  }
  return !quote && !stack.length;
}

const cosmetic = { generic: new Set(), specific: new Map(), exceptions: new Set(), noGeneric: new Set() };

function addCosmetic(domains, isException, marker, selector) {
  if (marker || !isPlainSelector(selector)) return false;
  if (isException) { cosmetic.exceptions.add(selector); return true; }
  if (!domains) { cosmetic.generic.add(selector); return true; }
  const list = domains.toLowerCase().split(",");
  if (list.some((d) => d.startsWith("~"))) return false;
  let used = false;
  for (const d of list) {
    if (!isHost(d)) continue;
    if (!cosmetic.specific.has(d)) cosmetic.specific.set(d, new Set());
    cosmetic.specific.get(d).add(selector);
    used = true;
  }
  return used;
}

// ---------------------------------------------------------------- network filters

function parseDomainList(value) {
  const include = [], exclude = [];
  let droppedInclude = false;
  for (let d of value.toLowerCase().split("|")) {
    const neg = d.startsWith("~");
    if (neg) d = d.slice(1);
    if (!isHost(d)) { if (!neg) droppedInclude = true; continue; }
    (neg ? exclude : include).push(d);
  }
  return { include, exclude, unusable: droppedInclude && !include.length };
}

// Returns a rule description, or null if the filter can't be expressed as a DNR rule.
function parseNetworkFilter(line) {
  let text = line;
  const exception = text.startsWith("@@");
  if (exception) text = text.slice(2);
  if (text.startsWith("/") && /\/(\$[^/]*)?$/.test(text)) return null; // regex filter

  let pattern = text;
  let options = [];
  const dollar = text.lastIndexOf("$");
  if (dollar >= 0) {
    options = text.slice(dollar + 1).split(",");
    pattern = text.slice(0, dollar);
    if (!options.every((o) => /^~?[a-z0-9_-]+(=.*)?$/i.test(o))) return null;
  }

  const cond = {};
  const types = new Set(), notTypes = new Set();
  let unsupportedType = false;
  let important = false, hideException = false, all = false;

  for (const opt of options) {
    const neg = opt.startsWith("~");
    const eq = opt.indexOf("=");
    const name = (eq < 0 ? opt : opt.slice(0, eq)).slice(neg ? 1 : 0).toLowerCase();
    const value = eq < 0 ? "" : opt.slice(eq + 1);

    if (name in TYPE_OPTIONS) {
      if (TYPE_OPTIONS[name]) (neg ? notTypes : types).add(TYPE_OPTIONS[name]);
      else if (!neg) unsupportedType = true;
    }
    else if (name === "all") all = true;
    else if (name === "third-party" || name === "3p") cond.domainType = neg ? "firstParty" : "thirdParty";
    else if (name === "first-party" || name === "1p") cond.domainType = neg ? "thirdParty" : "firstParty";
    else if (name === "domain" || name === "from") {
      const d = parseDomainList(value);
      if (d.unusable) return null;
      if (d.include.length) cond.initiatorDomains = d.include;
      if (d.exclude.length) cond.excludedInitiatorDomains = d.exclude;
    } else if (name === "to") {
      const d = parseDomainList(value);
      if (d.unusable) return null;
      if (d.include.length) cond.requestDomains = d.include;
      if (d.exclude.length) cond.excludedRequestDomains = d.exclude;
    } else if (name === "denyallow") {
      const d = parseDomainList(value);
      if (d.unusable || !d.include.length) return null;
      cond.excludedRequestDomains = d.include;
    } else if (name === "match-case") cond.isUrlFilterCaseSensitive = true;
    else if (name === "important") important = true;
    else if (name === "_") continue;
    else if (exception && HIDE_EXCEPTION_OPTIONS.has(name)) hideException = true;
    else return null; // redirect, csp, removeparam, popup, ... have no safe DNR equivalent here
  }

  if (unsupportedType && !types.size && !all) return null; // only types Safari can't target
  if (!isAscii(pattern)) return null;
  pattern = pattern.replace(/^\*+/, "").replace(/\*+$/, "");
  const hostOnly = /^\|\|([a-z0-9._-]+)\^$/i.exec(pattern);
  const host = hostOnly && isHost(hostOnly[1].toLowerCase()) ? hostOnly[1].toLowerCase() : null;

  // "@@||site^$ghide" turns off generic cosmetic filtering on a site.
  if (hideException) {
    if (host && options.length === 1) cosmetic.noGeneric.add(host);
    return null;
  }

  let action = exception ? "allow" : "block";
  if (all) {
    cond.resourceTypes = ALL_TYPES;
  } else if (types.has("main_frame")) {
    if (cond.initiatorDomains || cond.excludedInitiatorDomains) return null;
    if (exception) action = "allowAllRequests"; // whitelists the whole page
    else if (types.size > 1) return null;
    cond.resourceTypes = ["main_frame"];
  } else if (types.size) {
    cond.resourceTypes = [...types];
  } else if (notTypes.size) {
    cond.excludedResourceTypes = [...new Set([...notTypes, "main_frame"])];
  }

  if (host && !cond.requestDomains) {
    return { action, important, cond, host };
  }
  if (pattern) {
    if (pattern.startsWith("||*") || pattern === "||" || pattern === "|") return null;
    const literal = pattern.replace(/[*^|]/g, "");
    if (literal.length < 3 && !cond.initiatorDomains && !cond.requestDomains) return null; // too broad
    cond.urlFilter = pattern;
  } else if (!cond.initiatorDomains && !cond.requestDomains) {
    return null;
  }
  return { action, important, cond };
}

class Ruleset {
  constructor() {
    this.groups = new Map(); // rules that differ only by hostname get merged
    this.rules = [];
  }
  add({ action, important, cond, host }, seen) {
    const priority = action === "block"
      ? (important ? PRIORITY.BLOCK_IMPORTANT : PRIORITY.BLOCK)
      : (important ? PRIORITY.ALLOW_IMPORTANT : PRIORITY.ALLOW);
    const key = JSON.stringify([action, priority, cond]);
    if (host) {
      if (seen.has(key + host)) return;
      seen.add(key + host);
      if (!this.groups.has(key)) this.groups.set(key, { action, priority, cond, hosts: [] });
      this.groups.get(key).hosts.push(host);
    } else {
      if (seen.has(key)) return;
      seen.add(key);
      this.rules.push({ priority, action: { type: action }, condition: cond });
    }
  }
  toJSON() {
    const out = [];
    for (const g of this.groups.values()) {
      out.push({ priority: g.priority, action: { type: g.action }, condition: { ...g.cond, requestDomains: g.hosts } });
    }
    out.push(...this.rules);
    // Blocking rules are numbered from 1 and everything else from NON_BLOCK_ID_BASE, so a
    // matched rule's id alone tells whether a request was stopped.
    let blocks = 0, others = 0;
    return out.map((r) => ({ id: r.action.type === "block" ? ++blocks : NON_BLOCK_ID_BASE + ++others, ...r }));
  }
}

// Tracking-parameter removal (Brave's query-filter.json / clean-urls.json) is left out:
// Safari ignores redirect rules for page loads, so it can't strip parameters this way.

// ---------------------------------------------------------------- main

async function main() {
  await mkdir(CACHE, { recursive: true });
  await mkdir(path.join(ROOT, "rules"), { recursive: true });
  await mkdir(path.join(ROOT, "cosmetic"), { recursive: true });

  console.log("Reading Brave's list catalog…");
  const catalogText = await fetchText(CATALOG_URL);
  if (!catalogText) throw new Error("Could not load Brave's list catalog");
  const sources = [];
  for (const component of JSON.parse(catalogText)) {
    const fallback = COMPONENTS[component.title];
    if (!fallback) continue;
    for (const { url } of component.sources ?? []) {
      const ruleset = rulesetFor(url, fallback);
      if (ruleset) sources.push({ url, ruleset });
    }
  }
  if (!sources.length) throw new Error("Brave's catalog format changed: no sources found");

  console.log(`Downloading ${sources.length} filter lists…`);
  const texts = [];
  for (const s of sources) texts.push(await fetchText(s.url));

  const custom = await readFile(CUSTOM_FILTERS, "utf8").catch(() => null);
  if (custom != null) {
    sources.push({ url: CUSTOM_FILTERS, ruleset: "ads" });
    texts.push(custom);
  }

  const network = [];
  const badfilters = new Set();
  const stats = { network: 0, converted: 0, cosmetic: 0, cosmeticUsed: 0 };
  sources.forEach((src, i) => {
    if (texts[i] == null) return;
    for (const line of filterLines(texts[i])) {
      const c = COSMETIC_RE.exec(line);
      if (c) {
        stats.cosmetic++;
        if (addCosmetic(c[1], c[2] === "@", c[3], c[4])) stats.cosmeticUsed++;
        continue;
      }
      if (/\s/.test(line)) continue;
      const bad = /^(.*?)(?:\$badfilter|,badfilter)$/.exec(line);
      if (bad) badfilters.add(bad[1]);
      else network.push({ line, ruleset: src.ruleset });
    }
  });

  const rulesets = { ads: new Ruleset(), privacy: new Ruleset(), threats: new Ruleset(), annoyances: new Ruleset() };
  const seen = new Set();
  for (const { line, ruleset } of network) {
    if (badfilters.has(line)) continue;
    stats.network++;
    const parsed = parseNetworkFilter(line);
    if (!parsed) continue;
    stats.converted++;
    rulesets[ruleset].add(parsed, seen);
  }

  for (const [name, rs] of Object.entries(rulesets)) {
    const rules = rs.toJSON();
    const hosts = rules.reduce((n, r) => n + (r.condition.requestDomains?.length ?? 0), 0);
    await writeFile(path.join(ROOT, "rules", `${name}.json`), JSON.stringify(rules));
    console.log(`  rules/${name}.json: ${rules.length} rules covering ${hosts} hostnames`);
  }


  // A generic selector that any list makes an exception for is dropped everywhere:
  // we can't un-hide per site, and losing a few selectors beats breaking pages.
  const generic = [...cosmetic.generic].filter((s) => !cosmetic.exceptions.has(s));
  await writeFile(
    path.join(ROOT, "cosmetic", "generic.css"),
    generic.map((s) => `${s}{display:none!important}`).join("\n") + "\n"
  );
  const specific = {};
  for (const [domain, sels] of [...cosmetic.specific].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const list = [...sels].filter((s) => !cosmetic.exceptions.has(s));
    if (list.length) specific[domain] = list;
  }
  await writeFile(path.join(ROOT, "cosmetic", "specific.json"), JSON.stringify(specific));
  await writeFile(path.join(ROOT, "cosmetic", "no-generic.json"), JSON.stringify([...cosmetic.noGeneric].sort()));

  console.log(`  cosmetic/generic.css: ${generic.length} selectors`);
  console.log(`  cosmetic/specific.json: ${Object.keys(specific).length} sites`);
  console.log(`  cosmetic/no-generic.json: ${cosmetic.noGeneric.size} sites`);
  console.log(
    `Converted ${stats.converted} of ${stats.network} network filters and ` +
      `${stats.cosmeticUsed} of ${stats.cosmetic} cosmetic filters.`
  );
  console.log("Next, measure the rulesets for Safari's rule budget: swift tools/count-webkit-rules.swift");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
