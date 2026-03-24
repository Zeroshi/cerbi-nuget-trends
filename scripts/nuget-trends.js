import fs from "fs";
import path from "path";

const UA = "cerbi-nuget-trends/1.3";

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

    if (skip > 2000) break;
  }

  return all;
}

// ---- build trend from historical daily files ----
function buildTrend(dailyDir) {
  const trend = [];
  if (!fs.existsSync(dailyDir)) return trend;

  const files = fs.readdirSync(dailyDir)
    .filter(f => f.endsWith(".json"))
    .sort();

  const recent = files.slice(-90);
  for (let i = 0; i < recent.length; i += 7) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dailyDir, recent[i]), "utf8"));
      const total = (raw.packages ?? [])
        .filter(p => p.found && !blocklist.has(String(p.id).toLowerCase()))
        .reduce((sum, p) => sum + (p.totalDownloads ?? 0), 0);
      trend.push({ date: raw.dateUtc, totalDownloads: total });
    } catch { /* skip corrupt files */ }
  }

  if (files.length > 0) {
    const lastFile = files[files.length - 1];
    const lastDate = lastFile.replace(".json", "");
    if (!trend.some(t => t.date === lastDate)) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dailyDir, lastFile), "utf8"));
        const total = (raw.packages ?? [])
          .filter(p => p.found && !blocklist.has(String(p.id).toLowerCase()))
          .reduce((sum, p) => sum + (p.totalDownloads ?? 0), 0);
        trend.push({ date: raw.dateUtc, totalDownloads: total });
      } catch { /* skip */ }
    }
  }

  return trend;
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

  // 3) Build per-package snapshots
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

  // ---- Generate outputs for website consumption ----
  const foundPackages = packages.filter(p => p.found);
  const totalDownloads = foundPackages.reduce((sum, p) => sum + p.totalDownloads, 0);

  const topPackages = [...foundPackages]
    .sort((a, b) => b.totalDownloads - a.totalDownloads)
    .slice(0, 10)
    .map(p => ({
      id: p.id,
      totalDownloads: p.totalDownloads,
      latestVersion: p.latestVersion
    }));

  const allPackages = [...foundPackages]
    .sort((a, b) => b.totalDownloads - a.totalDownloads)
    .map(p => ({
      id: p.id,
      totalDownloads: p.totalDownloads,
      latestVersion: p.latestVersion
    }));

  const trend = buildTrend(dailyDir);

  // Full summary with breakdown
  const summary = {
    asOf: dateStr,
    totalDownloads,
    packageCount: foundPackages.length,
    topPackages,
    allPackages,
    weeklyTrend: trend
  };

  const summaryPath = path.join(dataDir, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  // Simple total for website badge/hero — just the number
  const total = {
    asOf: dateStr,
    totalDownloads,
    packageCount: foundPackages.length
  };

  const totalPath = path.join(dataDir, "total.json");
  fs.writeFileSync(totalPath, JSON.stringify(total, null, 2), "utf8");

  console.log(`Discovered ${cerbiIds.length} Cerbi packages`);
  console.log(`Tracking ${foundPackages.length} packages after merge/blocklist`);
  console.log(`Total combined downloads: ${totalDownloads.toLocaleString()}`);
  console.log(`Wrote ${dailyPath}`);
  console.log(`Wrote ${summaryPath}`);
  console.log(`Wrote ${totalPath}`);
  console.log(`Appended ${csvPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
