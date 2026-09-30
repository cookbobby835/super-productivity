#!/usr/bin/env node

// Compares the sync fuzz signature report of the working tree with a base ref
// and fails on any seed that newly shows a failure signature.
//
//   npm run sync-fuzz:compare              # against origin/master
//   npm run sync-fuzz:compare -- <ref>
//
// The pinned traces and the random sweep only report signatures no pin
// explains, so a change that makes a known failure more frequent passes them.
// This comparison caught two such regressions in #10398. It runs
// sync-fuzz-signature-report.benchmark.ts in the working tree and in a
// temporary worktree of the base ref (sharing node_modules), one after the
// other, since both use Karma's port. The base run uses the working tree's
// report benchmark and intent mixes, so both sweep the same seeds.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const FUZZ_DIR = 'src/app/op-log/testing/integration/sync-fuzz';
const REPORT_SPEC = `${FUZZ_DIR}/sync-fuzz-signature-report.benchmark.ts`;
const SHARED_FILES = [REPORT_SPEC, `${FUZZ_DIR}/sync-fuzz-profiles.ts`];
const ACTIONS_FILE = `${FUZZ_DIR}/sync-fuzz-actions.ts`;
const REPORT_PATTERN = /SYNC_FUZZ_REPORT_START(\{.*?\})SYNC_FUZZ_REPORT_END/s;

/** The seeds-by-signature map in a Karma run's output, or undefined. */
const parseReport = (output) => {
  const match = REPORT_PATTERN.exec(output);
  return match ? JSON.parse(match[1]) : undefined;
};

/** Seeds that newly show a signature, and seeds that no longer do. */
const compareReports = (base, head) => {
  const newFailures = [];
  const fixed = [];
  const signatures = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort();
  for (const signature of signatures) {
    const baseSeeds = new Set(base[signature] ?? []);
    const headSeeds = new Set(head[signature] ?? []);
    const added = [...headSeeds].filter((seed) => !baseSeeds.has(seed)).sort();
    const removed = [...baseSeeds].filter((seed) => !headSeeds.has(seed)).sort();
    if (added.length > 0) newFailures.push({ signature, seeds: added });
    if (removed.length > 0) fixed.push({ signature, seeds: removed });
  }
  return { newFailures, fixed };
};

const formatComparison = ({ newFailures, fixed }, label) => {
  const lines = [`Sync fuzz signatures: ${label}`];
  const section = (title, entries) => {
    lines.push(`${title} (${entries.length})`);
    for (const { signature, seeds } of entries) {
      lines.push(`  ${signature}: ${seeds.join(', ')}`);
    }
  };
  section('Newly failing', newFailures);
  section('No longer failing', fixed);
  return lines.join('\n');
};

const git = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const runReport = (cwd) => {
  // The build imports the git-ignored env.generated.ts; a fresh worktree lacks it.
  execFileSync('node', ['tools/load-env.js', '--ensure'], { cwd, stdio: 'ignore' });
  const result = spawnSync(
    'npx',
    ['ng', 'test', '--watch=false', '--include', REPORT_SPEC],
    {
      cwd,
      env: { ...process.env, TZ: 'Europe/Berlin' },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const report = parseReport(output);
  if (!report) {
    throw new Error(`No signature report from ${cwd}:\n${output.slice(-4000)}`);
  }
  return report;
};

const main = () => {
  const baseRef = process.argv[2] ?? 'origin/master';
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (git(root, ['diff', '--name-only', baseRef, '--', ACTIONS_FILE])) {
    console.warn(
      `Warning: ${ACTIONS_FILE} differs from ${baseRef}; the base sweeps other traces.`,
    );
  }
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-fuzz-base-'));
  let comparison;
  try {
    git(root, ['worktree', 'add', '--detach', worktree, baseRef]);
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(worktree, 'node_modules'));
    for (const file of SHARED_FILES) {
      fs.copyFileSync(path.join(root, file), path.join(worktree, file));
    }
    const head = runReport(root);
    const base = runReport(worktree);
    comparison = compareReports(base, head);
  } finally {
    git(root, ['worktree', 'remove', '--force', worktree]);
  }
  console.log(formatComparison(comparison, `working tree vs ${baseRef}`));
  process.exitCode = comparison.newFailures.length > 0 ? 1 : 0;
};

if (require.main === module) {
  main();
}

module.exports = { compareReports, formatComparison, parseReport };
