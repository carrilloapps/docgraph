#!/usr/bin/env node
/**
 * Reproducible benchmarks for the DocGraph MCP server.
 *
 * Each scenario clones (or reuses) a real-world documentation repository,
 * builds the DocGraph index, and runs a fixed set of natural-language
 * queries against it. The very same queries are then answered by a naive
 * baseline search over the same checkout — `git grep` when the checkout is
 * a git repository (always true here, since we clone with git), falling
 * back to a manual recursive file scan otherwise (e.g. if `git` becomes
 * unavailable mid-run, or the directory is reused without a `.git` folder).
 * This keeps the "with DocGraph" vs "without DocGraph" comparison
 * apples-to-apples: both arms measure real latency and real hit counts
 * against the identical checkout.
 *
 * The full report is written to `benchmarks/results.json` and a readable
 * summary table is printed to stdout.
 *
 * Methodology:
 *   - N=4 runs per scenario by default, median is reported (a single run is
 *     too noisy for meaningful wall-clock comparisons).
 *   - "withTool" = one `docgraph search` CLI invocation per query.
 *   - "baseline" = one naive-search invocation (git grep, or a manual file
 *     scan fallback) per query, measured the same way (latency + hits).
 *
 * Requirements:
 *   - The project must already be built: `npm run build` (this script shells
 *     out to `dist/presentation/cli/cli.js`; it will refuse to run otherwise).
 *   - `git` must be available on PATH (used to clone scenario repos and,
 *     when possible, to run the baseline search).
 *
 * Usage:
 *   npm run benchmark                        # default: 4 runs, all scenarios
 *   node scripts/benchmark.js --runs=8
 *   node scripts/benchmark.js --scenario=astro --runs=4
 *   node scripts/benchmark.js --help
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import process from 'process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const BENCH_DIR = join(REPO_ROOT, 'benchmarks');
const CLI_PATH = join(REPO_ROOT, 'dist', 'presentation', 'cli', 'cli.js');
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * @typedef {Object} Scenario
 * @property {string} name - Short identifier, also used as the checkout dir name.
 * @property {string} description - Human-readable summary shown in logs.
 * @property {string} repo - Git URL to clone.
 * @property {string} docsSubdir - Subdirectory inside the repo the scenario is themed around
 *   (informational only; both arms search the full checkout for a fair comparison).
 * @property {string[]} queries - Natural-language questions to benchmark.
 */

/** @type {Scenario[]} */
const SCENARIOS = [
  {
    name: 'react-native',
    description: 'facebook/react-native — README + docs + contributing guide',
    repo: 'https://github.com/facebook/react-native.git',
    docsSubdir: 'docs',
    queries: [
      'How do you create a native module in the new architecture?',
      'What is the Hermes engine and how does it improve startup?',
      'How does the bridge work between JavaScript and native code?',
      'How do you set up TurboModules in a fresh project?',
    ],
  },
  {
    name: 'supabase-js',
    description: 'supabase/supabase-js — README + examples',
    repo: 'https://github.com/supabase/supabase-js.git',
    docsSubdir: 'examples',
    queries: [
      'How do you authenticate users with email and password?',
      'What realtime subscription patterns are supported?',
      'How do you run a complex query against the Postgrest API?',
    ],
  },
  {
    name: 'astro',
    description: 'withastro/docs — the docs site itself',
    repo: 'https://github.com/withastro/docs.git',
    docsSubdir: 'src/content/docs',
    queries: [
      'How do you build a custom integration with Astro hooks?',
      'What is the difference between server-side and client-side rendering?',
      'How do you migrate from Astro v3 to v4?',
    ],
  },
];

/**
 * @typedef {Object} ArmResult
 * @property {number} latencyMs
 * @property {number} hits
 * @property {string} [method] - Only set on the baseline arm ("git grep" | "file scan").
 */

/**
 * @typedef {Object} RunMetrics
 * @property {string} scenario
 * @property {string} query
 * @property {ArmResult} withTool
 * @property {ArmResult} baseline
 * @property {{withTool: number, baseline: number}} toolCalls
 */

const HELP_TEXT = `DocGraph benchmark harness

Compares DocGraph's search against a naive baseline (git grep, or a manual
file scan if git is unavailable) over the same cloned repository checkout.

Usage:
  node scripts/benchmark.js [options]
  npm run benchmark -- [options]

Options:
  --runs=<n>          Number of runs per query, median is reported (default: 4)
  --scenario=<name>   Only run the named scenario (default: all)
                       Available: ${SCENARIOS.map((s) => s.name).join(', ')}
  --help, -h          Show this help message

Output:
  Writes benchmarks/results.json and prints a summary table to stdout.

Requirements:
  - The project must be built first: npm run build
  - git must be available on PATH
`;

function printHelp() {
  console.log(HELP_TEXT);
}

function parseRunsFlag(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  const parsed = arg ? parseInt(arg.split('=')[1], 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseScenarioFlag() {
  const arg = process.argv.find((a) => a.startsWith('--scenario='));
  return arg ? arg.split('=')[1] : undefined;
}

/**
 * Verify the environment can actually run the benchmark: the project must be
 * built (dist/ present) and git must be on PATH. Fail fast with a clear
 * message instead of letting spawnSync blow up cryptically mid-run.
 */
function checkPrerequisites() {
  const problems = [];

  if (!existsSync(CLI_PATH)) {
    problems.push(
      `DocGraph has not been built: expected to find "${CLI_PATH}".\n` +
        '  Run "npm run build" first, then re-run the benchmark.',
    );
  }

  const gitCheck = spawnSync('git', ['--version'], { encoding: 'utf-8' });
  if (gitCheck.error || gitCheck.status !== 0) {
    problems.push(
      'git was not found on PATH. git is required to clone benchmark repositories\n' +
        '  and to run the baseline "git grep" search. Install git and ensure it is on PATH.',
    );
  }

  if (problems.length > 0) {
    console.error('Cannot run benchmark:\n');
    for (const p of problems) console.error(`- ${p}\n`);
    process.exit(1);
  }
}

/**
 * Clone `repoUrl` into `target`, replacing any existing checkout.
 * Uses spawnSync with an args array (no shell string interpolation) so
 * paths containing spaces (common on Windows, e.g. "C:\Users\John Doe")
 * are handled safely.
 */
function cloneRepo(repoUrl, target) {
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(dirname(target), { recursive: true });
  console.log(`Cloning ${repoUrl}...`);
  // `-c core.longpaths=true` lets deeply-nested paths (e.g. react-native's C++
  // tree) check out on Windows, where the default 260-char MAX_PATH otherwise
  // aborts the clone with "Filename too long". Scoped to this command so the
  // user's global git config is untouched. `--single-branch` trims the fetch.
  const res = spawnSync(
    'git',
    ['-c', 'core.longpaths=true', 'clone', '--depth', '1', '--single-branch', repoUrl, target],
    { stdio: 'inherit' },
  );
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git clone failed (exit code ${res.status}) for ${repoUrl}`);
  }
}

function runIndex(checkoutDir) {
  const res = spawnSync('node', [CLI_PATH, 'index', `--path=${checkoutDir}`], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: MAX_BUFFER,
  });
  if (res.error) throw res.error;
  if (res.stdout) console.log(res.stdout);
  if (res.status !== 0) {
    console.error(res.stderr || '(no stderr output)');
    throw new Error(`DocGraph indexing failed (exit code ${res.status}) for ${checkoutDir}`);
  }
}

/**
 * Run the DocGraph search CLI for a single query and measure latency + hits.
 * @returns {ArmResult}
 */
function runDocgraphSearch(checkoutDir, query) {
  const start = Date.now();
  const res = spawnSync(
    'node',
    [CLI_PATH, 'search', query, '--limit=5', '--format=json', `--path=${checkoutDir}`],
    { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: MAX_BUFFER },
  );
  const latencyMs = Date.now() - start;
  if (res.error || res.status !== 0) {
    return { latencyMs, hits: 0 };
  }
  try {
    const parsed = JSON.parse(res.stdout);
    const hits = Array.isArray(parsed) ? parsed.length : Array.isArray(parsed?.results) ? parsed.results.length : 0;
    return { latencyMs, hits };
  } catch {
    return { latencyMs, hits: 0 };
  }
}

const STOPWORDS = new Set([
  'how', 'do', 'you', 'the', 'a', 'an', 'is', 'are', 'and', 'or', 'to', 'of', 'in', 'on',
  'for', 'with', 'what', 'does', 'it', 'this', 'that', 'between', 'from', 'set', 'up',
  'new', 'your', 'can', 'when', 'will', 'be', 'run', 'via', 'into',
]);

/** Extract meaningful search terms from a natural-language query. */
function extractKeywords(query) {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return words.length > 0 ? words : [query.toLowerCase()];
}

/**
 * Real baseline search via `git grep -n -i` with one `-e <keyword>` per
 * extracted keyword (git grep ORs multiple -e patterns by default). Exit
 * code 1 means "no matches" (not an error); anything else is a real failure.
 * @returns {number} number of matching lines
 */
function runGitGrep(checkoutDir, keywords) {
  const args = ['grep', '-n', '-i'];
  for (const kw of keywords) args.push('-e', kw);
  const res = spawnSync('git', args, { cwd: checkoutDir, encoding: 'utf-8', maxBuffer: MAX_BUFFER });
  if (res.error) throw res.error;
  if (res.status !== 0 && res.status !== 1) {
    throw new Error(`git grep failed (exit code ${res.status}): ${res.stderr}`);
  }
  if (!res.stdout) return 0;
  return res.stdout.split(/\r?\n/).filter(Boolean).length;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.docgraph']);

/** Recursively list files under `dir`, skipping VCS/build/index directories. */
function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Fallback "no DocGraph, no git" baseline: manually scan every file under
 * the checkout for lines containing any keyword, case-insensitively.
 * @returns {number} number of matching lines
 */
function naiveFileScan(checkoutDir, keywords) {
  const lowerKeywords = keywords.map((k) => k.toLowerCase());
  let hits = 0;
  for (const file of walkFiles(checkoutDir)) {
    let content;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue; // binary or unreadable file
    }
    for (const line of content.split(/\r?\n/)) {
      const lower = line.toLowerCase();
      if (lowerKeywords.some((kw) => lower.includes(kw))) hits++;
    }
  }
  return hits;
}

/**
 * Run the real "without DocGraph" baseline for a single query: git grep
 * when the checkout is a git repo, otherwise (or if git grep itself fails
 * unexpectedly) a manual recursive file scan. Measured the same way as the
 * DocGraph arm: wall-clock latency + hit count.
 * @returns {ArmResult}
 */
function runBaselineSearch(checkoutDir, query) {
  const keywords = extractKeywords(query);
  const isGitRepo = existsSync(join(checkoutDir, '.git'));
  const start = Date.now();
  let hits = 0;
  let method = 'git grep';
  try {
    if (isGitRepo) {
      hits = runGitGrep(checkoutDir, keywords);
    } else {
      method = 'file scan';
      hits = naiveFileScan(checkoutDir, keywords);
    }
  } catch (err) {
    console.error(`  (baseline git grep failed, falling back to file scan: ${err.message})`);
    method = 'file scan (fallback)';
    hits = naiveFileScan(checkoutDir, keywords);
  }
  const latencyMs = Date.now() - start;
  return { latencyMs, hits, method };
}

/**
 * @param {Scenario} scenario
 * @param {number} runs
 * @returns {RunMetrics[]}
 */
function runScenario(scenario, runs) {
  const checkoutDir = join(BENCH_DIR, 'checkouts', scenario.name);
  cloneRepo(scenario.repo, checkoutDir);

  console.log('Building DocGraph index...');
  runIndex(checkoutDir);

  /** @type {RunMetrics[]} */
  const results = [];
  for (let run = 0; run < runs; run++) {
    for (const query of scenario.queries) {
      const withTool = runDocgraphSearch(checkoutDir, query);
      const baseline = runBaselineSearch(checkoutDir, query);

      results.push({
        scenario: scenario.name,
        query,
        withTool,
        baseline,
        toolCalls: { withTool: 1, baseline: 1 },
      });
    }
  }
  return results;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function aggregateSummary(results) {
  const groups = new Map();
  for (const r of results) {
    const key = `${r.scenario}::${r.query}`;
    if (!groups.has(key)) {
      groups.set(key, { latencyDeltaMs: [], hitsWith: [], hitsBaseline: [], methods: new Set() });
    }
    const g = groups.get(key);
    g.latencyDeltaMs.push(r.withTool.latencyMs - r.baseline.latencyMs);
    g.hitsWith.push(r.withTool.hits);
    g.hitsBaseline.push(r.baseline.hits);
    g.methods.add(r.baseline.method);
  }

  const out = [];
  for (const [key, g] of groups) {
    const [scenario, ...rest] = key.split('::');
    const query = rest.join('::');
    const medianHitsWith = median(g.hitsWith);
    const medianHitsBaseline = median(g.hitsBaseline);
    out.push({
      scenario,
      query,
      medianLatencyDeltaMs: median(g.latencyDeltaMs),
      medianHitsWith,
      medianHitsBaseline,
      hitDelta: medianHitsWith - medianHitsBaseline,
      baselineMethod: [...g.methods].join(', '),
    });
  }
  return out;
}

function printSummaryTable(summary) {
  const allGitGrep = summary.every((r) => r.baselineMethod === 'git grep');
  const label = allGitGrep ? 'vs git grep' : 'vs naive search';

  console.log(`\nDocGraph benchmark summary (median over N runs, ${label}):\n`);
  console.log('  Scenario       | Latency delta (ms) | Hits WITH | Hits baseline | Hit delta | Baseline method');
  console.log('  ---------------+---------------------+-----------+---------------+-----------+-----------------');
  for (const row of summary) {
    console.log(
      `  ${row.scenario.padEnd(14)} | ${String(row.medianLatencyDeltaMs).padStart(19)} | ${String(row.medianHitsWith).padStart(9)} | ${String(row.medianHitsBaseline).padStart(13)} | ${String(row.hitDelta).padStart(9)} | ${row.baselineMethod}`,
    );
  }
  console.log(
    '\nNote: a negative latency delta means DocGraph was faster than the baseline; ' +
      'a positive hit delta means DocGraph returned more results.',
  );
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  checkPrerequisites();

  const runs = parseRunsFlag('runs', 4);
  const onlyScenario = parseScenarioFlag();

  mkdirSync(BENCH_DIR, { recursive: true });

  const scenarios = onlyScenario ? SCENARIOS.filter((s) => s.name === onlyScenario) : SCENARIOS;
  if (scenarios.length === 0) {
    console.error(`Unknown scenario: ${onlyScenario}. Available: ${SCENARIOS.map((s) => s.name).join(', ')}`);
    process.exit(1);
  }

  const allResults = [];
  const failures = [];
  for (const scenario of scenarios) {
    console.log(`\n=== ${scenario.name} (${scenario.description}) ===`);
    // One scenario failing (network, a repo that won't check out, etc.) must
    // not abort the whole run — record it and keep going so the report is as
    // complete as the environment allows.
    try {
      const results = runScenario(scenario, runs);
      allResults.push(...results);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.error(`  ! scenario "${scenario.name}" failed, skipping: ${message}`);
      failures.push({ scenario: scenario.name, error: message });
    }
  }

  const summary = aggregateSummary(allResults);
  const outPath = join(BENCH_DIR, 'results.json');
  writeFileSync(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), runs: allResults, summary, failures }, null, 2),
  );
  console.log(`\nWrote ${outPath}`);

  printSummaryTable(summary);
  if (failures.length > 0) {
    console.log(`\n${failures.length} scenario(s) failed: ${failures.map((f) => f.scenario).join(', ')}`);
  }
}

try {
  main();
} catch (err) {
  console.error('Benchmark failed:', err && err.stack ? err.stack : err);
  process.exit(1);
}
