import fs from "fs";
import path from "path";

const UA = "cerbi-nuget-trends/1.1";

// ---- date ----
const today = new Date();
const yyyy = today.getUTCFullYear();
const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
const dd = String(today.getUTCDate()).padStart(2, "0");
const dateStr = `${yyyy}-${mm}-${dd}`;

// ---- dirs ----
const dataDir = "data";
const dailyDir = path.join(dataDir, "daily");
fs.mkdirSync(dailyDir, { recursive: true });

// ---- optional overrides ----
const overridePath = "packages.override.json";
const blocklistPath = "packages.blocklist.json";

const overrides = fs.existsSync(overridePath)
  ? JSON.parse(fs.readFileSync(overridePath, "utf8"))
  : [];

const blocklist = new Set(
  fs.existsSync(blocklistPath)
    ? JSON.parse(fs.readFileSync(blocklistPath, "utf8"))
        .map(x => String(x).toLowerCase())
    : []
);

// ---- fetch service index ----
async function getServiceIndex() {
  const res = await fetch("https://api.nuget.org/v3/index.json", {
    headers: { "User-Agent": UA }
  });
  if (!res.ok) throw new Error(`Service index failed: ${res.status}`);
  return res.json();
}

function normalizeTypes(t) {
  if (Array.isArray(t)) return t;
  if (typeof t === "string") return [t];
  return [];
}

function findResource(resources, typePrefix) {
  const prefix = typePrefix.toLowerCase();
  for (const r of resources ?? []) {
    const types = normalizeTypes(r["@type"]).map(x => String(x).toLowerCase());
    if (types.some(t => t.startsWith(prefix))) {
      return r["@id"];
    }
  }
  return null;
}

// ---- search paging ----
async function searchPackages(searchBase, query) {
  const take = 200;
  let skip = 0;
  let all = [];

  while (true) {
    const url =
      `${searchBase}?q=${encodeURIComponent(query)}` +
      `&skip=${skip}&take=${take}` +
      `&prerelease=true&semVerLevel=2.0.0`;

    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`Search failed (${query}): ${res.status}`);

    const json = await res.json();
    const page = json.data ?? [];
    all = all.concat(page);

    if (page.length < take) break;
    skip += take;

    // Guard against runaway loops
    if (skip > 2000) break;
  }

  return all;
}

async function main() {
  const index = await getServiceIndex();

  const searchBase = findResource(index.resources, "searchqueryservice");
  if (!searchBase) throw new Error("SearchQueryService not found in index.");

  // 1) Auto-discover all Cerbi packages
  const discovered = await searchPackages(searchBase, "cerbi");

  const cerbiIds = discovered
    .map(p => p.id)
    .filter(Boolean)
    .filter(id => String(id).toLowerCase().startsWith("cerbi"))
    .map(id => String(id));

  // 2) Merge overrides, apply blocklist
  const merged = new Set(
    [...cerbiIds, ...overrides.map(String)]
      .filter(id => !blocklist.has(id.toLowerCase()))
  );

  // 3) Build per-package snapshots using search results we already have
  const byId = new Map(
    discovered
      .filter(p => p?.id)
      .map(p => [String(p.id).toLowerCase(), p])
  );

  const packages = [];
  for (const id of [...merged].sort((a, b) => a.localeCompare(b))) {
    const p = byId.get(id.toLowerCase());

    if (!p) {
      packages.push({ id, found: false, error: "Not found in search results" });
      continue;
    }

    packages.push({
      id: p.id,
      found: true,
      totalDownloads: p.totalDownloads ?? 0,
      latestVersion: p.version ?? "",
      versions: (p.versions ?? []).map(v => ({
        version: v.version,
        downloads: v.downloads ?? 0
      }))
    });
  }

  const snapshot = { dateUtc: dateStr, packages };

  const dailyPath = path.join(dailyDir, `${dateStr}.json`);
  fs.writeFileSync(dailyPath, JSON.stringify(snapshot, null, 2), "utf8");

  // Rolling CSV
  const csvPath = path.join(dataDir, "nuget_daily_totals.csv");
  const header = "date,id,totalDownloads,latestVersion\n";

  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, header, "utf8");
  }

  const rows = packages
    .filter(p => p.found)
    .map(p => `${dateStr},${p.id},${p.totalDownloads},${p.latestVersion}\n`)
    .join("");

  fs.appendFileSync(csvPath, rows, "utf8");

  console.log(`Discovered ${cerbiIds.length} Cerbi packages`);
  console.log(`Tracking ${packages.length} packages after merge/blocklist`);
  console.log(`Wrote ${dailyPath}`);
  console.log(`Appended ${csvPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
