import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The live snapshot lives on data-mirror; main intentionally contains only a
// pointer README. Prefer the network artifact, then fall back to a local file
// (when building from data-mirror) or an already-fetched local git ref.
const remoteSource =
  process.env.MXGA_LIST_URL ??
  "https://raw.githubusercontent.com/foru17/make-x-great-again/data-mirror/data/blacklist/v2-lite.json";
const localSource = path.join(root, "data/blacklist/v2-lite.json");
const snapshotPath = "data/blacklist/v2-lite.json";
const destination = path.join(root, "extension/public/blacklist-data.json");

if (process.argv.includes("--clean")) {
  fs.rmSync(destination, { force: true });
  process.exit(0);
}

const offline = process.argv.includes("--offline") || process.env.MXGA_LIST_OFFLINE === "1";
const localRefs = [
  process.env.MXGA_DATA_REF,
  "data-mirror",
  "origin/data-mirror",
  "upstream/data-mirror",
].filter((ref, index, refs) => ref && refs.indexOf(ref) === index);

function readLocalSnapshot() {
  if (fs.existsSync(localSource)) {
    return { raw: fs.readFileSync(localSource, "utf8"), source: localSource };
  }
  for (const ref of localRefs) {
    try {
      return {
        raw: execFileSync("git", ["show", `${ref}:${snapshotPath}`], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        }),
        source: `git:${ref}:${snapshotPath}`,
      };
    } catch {
      // Try the next locally available ref. No network access is attempted.
    }
  }
  throw new Error(
    `no local Safari snapshot found; fetch/check out data-mirror or set MXGA_DATA_REF ` +
      `(checked ${localSource} and refs: ${localRefs.join(", ") || "none"})`,
  );
}

let raw;
let source;
if (offline) {
  ({ raw, source } = readLocalSnapshot());
} else {
  try {
    const res = await fetch(remoteSource);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.text();
    source = remoteSource;
  } catch (err) {
    console.warn(
      `WARN: fetch ${remoteSource} failed (${err.message}); ` +
        "falling back to a locally available data-mirror snapshot",
    );
    ({ raw, source } = readLocalSnapshot());
  }
}

const artifact = JSON.parse(raw);
if (artifact?.schema !== 2 || !Array.isArray(artifact.entries) || artifact.entries.length < 1000) {
  throw new Error(`invalid Safari fallback list: ${source}`);
}

// Mirror of extension/lib/list-sync.ts row validation. The published snapshot
// can carry a few stale rows with invalid handles; drop them here so the
// packaged fallback passes the extension's validator on first load. A large
// drop count means the source artifact is broken — fail the build instead.
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const USER_ID_RE = /^\d{1,32}$/;
const ENTRY_CODE_RE = /^[ps][pcgrmo](?:[ha])?$/;
const MAX_DROPPED_ROWS = 100;
const kept = artifact.entries.filter(
  (row) =>
    Array.isArray(row) &&
    row.length === 3 &&
    typeof row[0] === "string" &&
    (row[0] === "" || USER_ID_RE.test(row[0])) &&
    typeof row[1] === "string" &&
    HANDLE_RE.test(row[1]) &&
    (row[0] !== "" || row[1] !== "") &&
    typeof row[2] === "string" &&
    ENTRY_CODE_RE.test(row[2]),
);
const dropped = artifact.entries.length - kept.length;
if (dropped > MAX_DROPPED_ROWS) {
  throw new Error(`Safari fallback list has ${dropped} invalid rows (max ${MAX_DROPPED_ROWS}): ${source}`);
}
artifact.entries = kept;
if (artifact.count !== undefined) artifact.count = kept.length;

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(artifact));
console.log(
  `Prepared Safari fallback list from ${source}: ` +
    `${artifact.entries.length} entries ` +
    `(${dropped} invalid rows dropped), ` +
    `${(fs.statSync(destination).size / 1024 / 1024).toFixed(2)} MB`,
);
