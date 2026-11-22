// Token Launch Radar entrypoint (Node 22 standard library only).
// Reads /input/snapshot.json (or --input), computes empirical peer-calibrated valuations
// and concrete farm plans, writes /output/board.json, /output/data.js, copies dashboard/
// and screenshots/, and generates canonical /output/dossier.json via vendored buildDossier.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRadarDataset,
  parseSnapshot,
  serializeDataScript,
  validateBoardGate,
} from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

process.umask(0o022);

const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const VALID_FILENAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function readCliFlag(flag: string, fallback: string): string {
  const prefix = `--${flag}=`;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]!;
    if (arg === `--${flag}` && i + 1 < process.argv.length) {
      return process.argv[i + 1]!;
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return fallback;
}

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: 0o755 });
  try {
    chmodSync(dirPath, 0o755);
  } catch {
    // Ignore on filesystems where chmod on root mount is restricted.
  }
}

function writePublicFile(filePath: string, data: string | Uint8Array): void {
  writeFileSync(filePath, data, { mode: 0o644 });
  try {
    chmodSync(filePath, 0o644);
  } catch {
    // Ignore if chmod unsupported.
  }
}

function copyTreePublic(srcDir: string, dstDir: string): string[] {
  if (!existsSync(srcDir)) return [];
  ensureDir(dstDir);
  const copied: string[] = [];
  const entries = readdirSync(srcDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      const nested = copyTreePublic(srcPath, dstPath);
      for (const rel of nested) copied.push(`${entry.name}/${rel}`);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, dstPath);
      try {
        chmodSync(dstPath, 0o644);
      } catch {
        // Ignore if chmod unsupported.
      }
      copied.push(entry.name);
    }
  }
  return copied;
}

function run(): void {
  const inputArg = readCliFlag('input', '/input');
  const snapshotPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(snapshotPath)) {
    process.stderr.write(`token-radar: missing snapshot at ${snapshotPath}\n`);
    process.exit(2);
  }

  const outDir = readCliFlag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
  const skipDossier = process.argv.includes('--no-dossier');

  const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
  const dataset = buildRadarDataset(snapshot);
  const gateError = validateBoardGate(dataset.rows, snapshot);
  if (gateError !== null) {
    process.stderr.write(`token-radar: gate validation failed: ${gateError}\n`);
    process.exit(1);
  }

  ensureDir(outDir);
  writePublicFile(
    join(outDir, 'board.json'),
    `${JSON.stringify({
      as_of: dataset.as_of,
      model_version: dataset.params.version,
      watchlist_coverage: dataset.counts.watchlist_total,
      rows: dataset.rows,
    })}\n`,
  );
  writePublicFile(join(outDir, 'data.js'), serializeDataScript(dataset));

  const dashFiles = copyTreePublic(join(ROOT_DIR, 'dashboard'), join(outDir, 'dashboard'));
  const shotFiles = copyTreePublic(join(ROOT_DIR, 'screenshots'), join(outDir, 'screenshots'));

  if (!skipDossier) {
    if (shotFiles.length < 3 || shotFiles.length > SCREENSHOT_CAPS.max) {
      process.stderr.write(`token-radar: expected 3..4 screenshots, found ${shotFiles.length}\n`);
      process.exit(1);
    }
    for (const shot of shotFiles) {
      if (!VALID_FILENAME.test(shot)) {
        process.stderr.write(`token-radar: invalid screenshot filename ${shot}\n`);
        process.exit(1);
      }
      const bytes = statSync(join(outDir, 'screenshots', shot)).size;
      if (bytes > SCREENSHOT_CAPS.max_bytes) {
        process.stderr.write(`token-radar: screenshots/${shot} is ${bytes} bytes (> ${SCREENSHOT_CAPS.max_bytes})\n`);
        process.exit(1);
      }
    }
    const dossierBytes = buildDossier(outDir, {
      text_max_bytes: TEXT_MAX_BYTES,
      screenshots: SCREENSHOT_CAPS,
      dashboard: DASHBOARD_CAPS,
    });
    writePublicFile(join(outDir, 'dossier.json'), dossierBytes);
  }

  process.stdout.write(
    `token-radar: scored ${dataset.counts.board_total} pre-token protocols ` +
      `(${dataset.counts.watchlist_total} watchlist, ${dataset.counts.early_total} early; ` +
      `${dataset.counts.live_comps_total} live comps calibrated, global median ${dataset.global_live_median}x) -> ` +
      `${dashFiles.length} dashboard files, ${shotFiles.length} screenshots\n`,
  );
}

run();
