// build-filters.mjs
// Downloads Adblock-Plus-syntax filter lists (EasyList, EasyPrivacy) and
// converts them into:
//   - Chrome declarativeNetRequest rulesets  -> rules/*.json
//   - Cosmetic (element-hiding) selectors     -> data/cosmetic.json
//
// Run with:  node tools/build-filters.mjs
//
// This is intentionally conservative: any filter we can't represent FAITHFULLY
// in Manifest V3 is skipped (and counted) rather than guessed, because a single
// invalid rule makes Chrome reject the whole ruleset.

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Which lists to fetch. `cap` bounds how many network rules each may emit so we
// stay under Chrome's enabled-static-rule limit (~30,000 total).
const LISTS = [
  {
    name: "easylist",
    url: "https://easylist.to/easylist/easylist.txt",
    cap: 20000,
  },
  {
    name: "easyprivacy",
    url: "https://easylist.to/easylist/easyprivacy.txt",
    cap: 9000,
  },
];

// ABP resource-type option  ->  declarativeNetRequest resourceType
const TYPE_MAP = {
  script: "script",
  image: "image",
  stylesheet: "stylesheet",
  object: "object",
  "object-subrequest": "object",
  xmlhttprequest: "xmlhttprequest",
  xhr: "xmlhttprequest",
  subdocument: "sub_frame",
  document: "main_frame",
  font: "font",
  media: "media",
  websocket: "websocket",
  ping: "ping",
  beacon: "ping",
  other: "other",
};

// Options whose presence means we CANNOT faithfully translate the rule.
// We skip those filters rather than risk wrong behavior / over-blocking.
const UNSUPPORTED_OPTIONS = new Set([
  "redirect", "redirect-rule", "rewrite", "csp", "removeparam", "removeheader",
  "replace", "cookie", "popup", "popunder", "genericblock", "generichide",
  "elemhide", "ghide", "ehide", "specifichide", "inline-script", "inline-font",
  "empty", "mp4", "webrtc", "app", "header", "permissions", "to", "from",
  "method", "strict1p", "strict3p",
]);

const isAscii = (s) => /^[\x00-\x7F]*$/.test(s);

async function fetchList(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// --- Network filter -> DNR rule -------------------------------------------

function parseNetworkFilter(line) {
  let isAllow = false;
  let text = line;

  if (text.startsWith("@@")) {
    isAllow = true;
    text = text.slice(2);
  }

  // Regex filters (/.../) -> skip; ABP regex isn't guaranteed RE2-compatible.
  if (text.startsWith("/") && text.lastIndexOf("/") > 0) return null;

  // Split pattern from options on the last unescaped '$'.
  let pattern = text;
  let optionStr = "";
  const dollar = text.lastIndexOf("$");
  if (dollar !== -1) {
    pattern = text.slice(0, dollar);
    optionStr = text.slice(dollar + 1);
  }

  pattern = pattern.trim();
  if (!pattern || pattern === "*" || pattern === "||" || pattern === "^") {
    return null; // too broad / empty
  }
  if (!isAscii(pattern)) return null;
  if (pattern.startsWith("||*")) return null; // invalid urlFilter

  const condition = { urlFilter: pattern };
  const resourceTypes = [];
  const excludedResourceTypes = [];
  let important = false;

  if (optionStr) {
    for (let opt of optionStr.split(",")) {
      opt = opt.trim();
      if (!opt) continue;
      const negated = opt.startsWith("~");
      const key = negated ? opt.slice(1) : opt;

      if (key === "third-party" || key === "3p") {
        condition.domainType = negated ? "firstParty" : "thirdParty";
      } else if (key === "first-party" || key === "1p") {
        condition.domainType = negated ? "thirdParty" : "firstParty";
      } else if (key === "match-case") {
        condition.isUrlFilterCaseSensitive = true;
      } else if (key === "important") {
        important = true;
      } else if (key === "all") {
        // applies to everything; no extra constraint
      } else if (key.startsWith("domain=")) {
        const inc = [], exc = [];
        let droppedInclude = false;
        for (const d of key.slice(7).split("|")) {
          if (!d) continue;
          const neg = d.startsWith("~");
          const host = (neg ? d.slice(1) : d).toLowerCase();
          // Chrome requires plain hosts: no wildcards (e.g. "wayfair.*"), paths, etc.
          if (!/^[a-z0-9.-]+$/.test(host)) {
            if (!neg) droppedInclude = true;
            continue;
          }
          (neg ? exc : inc).push(host);
        }
        // If the rule was scoped to specific sites but all of them were invalid,
        // skip it rather than letting it apply everywhere.
        if (droppedInclude && inc.length === 0) return null;
        if (inc.length) condition.initiatorDomains = inc;
        if (exc.length) condition.excludedInitiatorDomains = exc;
      } else if (TYPE_MAP[key]) {
        (negated ? excludedResourceTypes : resourceTypes).push(TYPE_MAP[key]);
      } else if (UNSUPPORTED_OPTIONS.has(key)) {
        return null; // can't represent faithfully
      } else {
        return null; // unknown option -> be safe, skip
      }
    }
  }

  if (resourceTypes.length) {
    condition.resourceTypes = [...new Set(resourceTypes)];
  } else if (excludedResourceTypes.length) {
    condition.excludedResourceTypes = [...new Set(excludedResourceTypes)];
  }

  return {
    action: { type: isAllow ? "allow" : "block" },
    condition,
    // allow > block; important block beats normal allow.
    priority: isAllow ? 2 : important ? 3 : 1,
  };
}

// --- Cosmetic filter ------------------------------------------------------

// Reject anything that isn't a plain CSS selector (procedural / extended CSS).
function isPlainSelector(sel) {
  if (!sel) return false;
  if (!isAscii(sel)) return false;
  // CSS-injection rules ("selector {style}"), scriptlets, and HTML filtering
  // are not plain element-hiding -> reject (would corrupt the injected CSS).
  if (/[{}]/.test(sel)) return false;
  if (sel.startsWith("+js(") || sel.startsWith("^")) return false;
  // Procedural / extended-CSS pseudos we can't express as plain CSS.
  if (/:style\(|:-abp-|:has-text\(|:matches-css|:xpath\(|:upward\(|:remove\(|:watch-attr\(|:min-text-length|:contains\(/.test(sel)) {
    return false;
  }
  return true;
}

function parseCosmeticFilter(line, generic, specific) {
  // Find the cosmetic separator: ## (hide), and skip exceptions/extended forms.
  const m = line.match(/^([^#]*)#(@?)(\$?\??)#(.*)$/);
  if (!m) return false;
  const [, domainPart, exception, extended, selector] = m;
  if (exception || extended) return true; // recognized but unsupported -> consume
  if (!isPlainSelector(selector)) return true;

  const domains = domainPart
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d && !d.startsWith("~"));

  if (domains.length === 0) {
    generic.add(selector);
  } else {
    for (const d of domains) {
      const host = d.toLowerCase();
      (specific[host] ??= new Set()).add(selector);
    }
  }
  return true;
}

// --- Driver ---------------------------------------------------------------

async function build() {
  await mkdir(join(ROOT, "rules"), { recursive: true });
  await mkdir(join(ROOT, "data"), { recursive: true });

  const generic = new Set();
  const specific = {}; // host -> Set<selector>
  const stats = [];

  for (const list of LISTS) {
    process.stdout.write(`Fetching ${list.name} ... `);
    const text = await fetchList(list.url);
    const lines = text.split(/\r?\n/);
    console.log(`${lines.length} lines`);

    const rules = [];
    const seen = new Set();
    let net = 0, cosmetic = 0, skipped = 0, id = 1;

    for (let raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("!") || line.startsWith("[")) continue;

      // Cosmetic? (contains a '#' separator with no scheme before it)
      if (/#@?\$?\??#/.test(line) && !line.includes("##.*")) {
        if (parseCosmeticFilter(line, generic, specific)) { cosmetic++; continue; }
      }

      const rule = parseNetworkFilter(line);
      if (!rule) { skipped++; continue; }

      const key = JSON.stringify(rule.condition) + rule.action.type;
      if (seen.has(key)) continue;
      seen.add(key);

      if (rules.length >= list.cap) { skipped++; continue; }
      rule.id = id++;
      rules.push(rule);
      net++;
    }

    await writeFile(
      join(ROOT, "rules", `${list.name}.json`),
      JSON.stringify(rules, null, 0)
    );
    stats.push({ list: list.name, net, cosmetic, skipped, emitted: rules.length });
  }

  // Cosmetic output: cap generic selectors to keep page CSS reasonable.
  const genericArr = [...generic];
  const specificObj = {};
  for (const [host, set] of Object.entries(specific)) {
    specificObj[host] = [...set];
  }
  await writeFile(
    join(ROOT, "data", "cosmetic.json"),
    JSON.stringify({ generic: genericArr, specific: specificObj }, null, 0)
  );

  console.log("\n=== Build summary ===");
  for (const s of stats) {
    console.log(
      `${s.list.padEnd(12)} emitted ${String(s.emitted).padStart(6)} network rules ` +
      `(skipped ${s.skipped})`
    );
  }
  console.log(
    `cosmetic     ${String(genericArr.length).padStart(6)} generic selectors, ` +
    `${Object.keys(specificObj).length} domains with specific rules`
  );
  const total = stats.reduce((a, s) => a + s.emitted, 0);
  console.log(`\nTotal enabled static rules: ${total} (Chrome limit ~30000)`);
  if (total > 30000) console.log("WARNING: over Chrome's static rule limit!");
}

build().catch((e) => {
  console.error("Build failed:", e);
  process.exit(1);
});
