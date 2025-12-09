import fs from "fs";
import path from "path";

const packages = JSON.parse(fs.readFileSync("packages.json", "utf8"));

const today = new Date();
const yyyy = today.getUTCFullYear();
const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
const dd = String(today.getUTCDate()).padStart(2, "0");
const dateStr = `${yyyy}-${mm}-${dd}`;

const dataDir = "data";
const dailyDir = path.join(dataDir, "daily");
fs.mkdirSync(dailyDir, { recursive: true });

async function fetchPackage(id) {
  const url = `https://api.nuget.org/v3/search?q=${encodeURIComponent(id)}&take=20&prerelease=true&semVerLevel=2.0.0`;
  const res = await fetch(url, {
    headers: { "User-Agent": "cerbi-nuget-trends/1.0" }
  });
  if (!res.ok) throw new Error(`Search failed for ${id}: ${res.status}`);
  const json = await res.json();

  const exact = (json.data || []).find(p => (p.id || "").toLowerCase() === id.toLowerCase());
  if (!exact) {
    return { id, found: false };
  }

  return {
    id: exact.id,
    found: true,
    totalDownloads: exact.totalDownloads ?? 0,
    latestVersion: exact.version ?? "",
    versions: (exact.versions || []).map(v => ({
      version: v.version,
      downloads: v.downloads ?? 0
    }))
  };
}

const results = [];
for (const id of packages) {
  try {
    results.push(await fetchPackage(id));
  } catch (e) {
    results.push({ id, found: false, error: String(e) });
  }
}

const snapshot = {
  dateUtc: dateStr,
  packages: results
};

const dailyPath = path.join(dailyDir, `${dateStr}.json`);
fs.writeFileSync(dailyPath, JSON.stringify(snapshot, null, 2), "utf8");

// Update rolling CSV
const csvPath = path.join(dataDir, "nuget_daily_totals.csv");
const header = "date,id,totalDownloads,latestVersion\n";

if (!fs.existsSync(csvPath)) {
  fs.writeFileSync(csvPath, header, "utf8");
}

const rows = results
  .filter(r => r.found)
  .map(r => `${dateStr},${r.id},${r.totalDownloads},${r.latestVersion}\n`)
  .join("");

fs.appendFileSync(csvPath, rows, "utf8");

console.log(`Wrote ${dailyPath}`);
console.log(`Appended ${csvPath}`);
