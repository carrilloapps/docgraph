#!/usr/bin/env node
import { join, dirname, relative } from 'path';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, statSync, realpathSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { Container } from '../../container.js';
import { resolveProjectPath, hasReadOnlyFlagOrEnv } from './args.js';
import { readLog, listLogFiles } from '../../infrastructure/logging/local-logger.js';
import { SourceRegistry } from '../../infrastructure/sources/registry.js';
import {
  loadSettings,
  createDefaultSettings,
  DEFAULT_EXCLUDE_PATTERNS,
  SUPPORTED_EXTENSIONS,
  DocGraphSettings,
  ApiAuthConfig,
  ApiAuthMode,
} from '../../infrastructure/config/settings.js';
import { EmbeddingProviderFactory, ProviderType } from '../../infrastructure/embeddings/provider-factory.js';

// Canonicalize to the real (long-form, real-case) path so filesystem walking,
// the file watcher, and stored relative paths all agree — otherwise a Windows
// 8.3 short name (C:\Users\JUNIOR~1\...) vs its long form produces ugly
// `..\..` relative paths and split cache keys. realpath resolves to the same
// physical directory, so an existing `.docgraph` index is reused, not moved.
function canonicalProjectPath(): string {
  const resolved = resolveProjectPath(process.argv, process.cwd());
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

const PROJECT_PATH = canonicalProjectPath();
const DB_PATH = join(PROJECT_PATH, '.docgraph', 'docgraph.db');
const SETTINGS_PATH = join(PROJECT_PATH, '.docgraph', 'settings.json');
// Server-wide read-only override for the CLI: `--read-only` / `DOCGRAPH_READ_ONLY`
// forbid every write command (index/reindex/watch). Read commands are
// unaffected. Falls through to `settings.security.readOnly` inside Container.
const READ_ONLY = hasReadOnlyFlagOrEnv(process.argv);
const require = createRequire(import.meta.url);
// ESM has no `__dirname`; derive it from this module's URL so `runInstall`
// can locate the sibling installer binary regardless of cwd.
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Portable MCP launch command. It uses `npx -p <package> docgraph-mcp serve`
 * so the generated agent config never contains an absolute, machine-specific
 * path: it resolves the locally installed binary when present, and downloads
 * the package on demand otherwise. Works identically on every OS.
 */
const PACKAGE_NAME = '@carrilloapps/docgraph';
const MCP_LAUNCH = { command: 'npx', args: ['-y', '-p', PACKAGE_NAME, 'docgraph-mcp', 'serve'] };

/**
 * Short aliases for the most-used subcommands. The canonical (long) name still
 * works; these are resolved to it before dispatch so both forms behave
 * identically. Keys must never collide with a real command name.
 */
const COMMAND_ALIASES: Record<string, string> = {
  i: 'index',
  ri: 'reindex',
  w: 'watch',
  s: 'search',
  q: 'search',
  ls: 'list',
  st: 'stats',
  stj: 'stats-json',
  src: 'sources',
  cfg: 'settings',
  prov: 'providers',
  ex: 'exclude',
  imp: 'import',
  exp: 'export',
};

async function main(): Promise<void> {
  const rawCommand = process.argv[2];
  const command = rawCommand ? COMMAND_ALIASES[rawCommand] ?? rawCommand : rawCommand;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  switch (command) {
    case 'init':
      await runInit();
      break;
    case 'index':
      await runIndex(false);
      break;
    case 'reindex':
      await runIndex(true);
      break;
    case 'watch':
      await runWatch();
      break;
    case 'search':
      await runSearch();
      break;
    case 'stats':
      runStats(false);
      break;
    case 'stats-json':
      runStats(true);
      break;
    case 'list':
      runList();
      break;
    case 'sources': {
      await runSources();
      break;
    }
    case 'logs': {
      await runLogs();
      break;
    }
    case 'apis': {
      await runApis();
      break;
    }
    case 'import': {
      await runImport();
      break;
    }
    case 'export': {
      await runExport();
      break;
    }
    case 'install':
    case 'uninstall': {
      await runInstall(command);
      break;
    }
    case 'exclude':
      runExclude();
      break;
    case 'files':
      runFiles();
      break;
    case 'settings':
      runSettings();
      break;
    case 'providers':
      runProviders();
      break;
    case 'serve':
      runServe();
      break;
    case 'mcp':
      await runMcpServer();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "docgraph help" for usage information.');
      process.exit(1);
  }
}

async function runIndex(reindex: boolean): Promise<void> {
  if (READ_ONLY) {
    console.error('read-only mode is active (--read-only / DOCGRAPH_READ_ONLY): indexing is disabled.');
    process.exit(1);
  }
  const container = new Container(PROJECT_PATH, {
    onProgress: (current, total, file) => {
      process.stdout.write(`\r[${current}/${total}] ${relative(PROJECT_PATH, file)}`);
    },
  });

  if (reindex) {
    console.log('Clearing existing index...\n');
    container.repository.clear();
    await container.vectorStore?.clear();
  }

  console.log(`${reindex ? 'Re-indexing' : 'Indexing'} project...\n`);
  const result = await container.indexing.indexProject({ isReindex: reindex });
  console.log('\n');
  console.log(reindex ? 'Re-indexing Complete' : 'Indexing Complete');
  console.log('====================');
  console.log(`  Documents indexed: ${result.documents}`);
  console.log(`  Documents skipped: ${result.skipped}`);
  console.log(`  Nodes created: ${result.nodes}`);
  console.log(`  Edges created: ${result.edges}`);
  console.log(`  Vectors created: ${result.vectors} (${container.resolvedProvider})`);
  container.close();
}

async function runWatch(): Promise<void> {
  if (READ_ONLY) {
    console.error('read-only mode is active (--read-only / DOCGRAPH_READ_ONLY): watch/autosync is disabled.');
    process.exit(1);
  }
  const container = new Container(PROJECT_PATH, {
    onProgress: (current, total, file) => {
      process.stdout.write(`\r[${current}/${total}] ${relative(PROJECT_PATH, file)}`);
    },
  });
  console.log(`Indexing ${PROJECT_PATH} ...\n`);
  const result = await container.indexing.indexProject();
  console.log(
    `\nIndexed ${result.documents} documents (${result.vectors} vectors). ` +
      `Watching for changes — press Ctrl-C to stop.\n`,
  );

  const { ProjectWatcher } = await import('../../infrastructure/watch/file-watcher.js');
  const watcher = new ProjectWatcher(
    PROJECT_PATH,
    {
      onChange: async (paths) => {
        const n = await container.syncChanged(paths);
        if (n > 0) {
          const shown = paths.slice(0, 3).map((p) => relative(PROJECT_PATH, p)).join(', ');
          console.log(`[sync] re-indexed ${n} file(s): ${shown}${paths.length > 3 ? ' …' : ''}`);
        }
      },
      onRemove: async (paths) => {
        const n = await container.removePaths(paths);
        if (n > 0) console.log(`[sync] removed ${n} document(s)`);
      },
    },
    { debounceMs: container.settings.watch.debounceMs, logger: container.logger },
  );
  watcher.start();

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => {
      console.log('\nStopping watcher...');
      resolve();
    });
  });
  await watcher.stop();
  container.close();
}

async function runSearch(): Promise<void> {
  const query = process.argv[3];
  if (!query || query.startsWith('-')) {
    console.error('Usage: docgraph search <query> [--limit=n] [--format=json|text] [--no-vector] [--no-text]');
    process.exit(1);
  }

  const args = process.argv.slice(4);
  const limit = parseInt(getArgValue(args, '--limit') || '', 10);
  const format = getArgValue(args, '--format') || 'text';
  const useVector = !args.includes('--no-vector');
  const useText = !args.includes('--no-text');
  const extension = getArgValue(args, '--ext');
  const language = getArgValue(args, '--lang');
  const tags = getArgValue(args, '--tags')?.split(',').filter(Boolean);

  const container = new Container(PROJECT_PATH, { disableEmbeddings: !useVector });
  const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : container.settings.search.limit;

  const results = await container.search.search({
    query,
    limit: effectiveLimit,
    extension,
    language,
    tags,
    useVector,
    useText,
  });

  if (format === 'json') {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`Found ${results.length} results:\n`);
    for (const result of results.slice(0, effectiveLimit)) {
      console.log(`[${(result.score * 100).toFixed(1)}%] ${result.document.relativePath}`);
      if (result.document.title) console.log(`    Title: ${result.document.title}`);
      if (result.highlights.length > 0) console.log(`    ${result.highlights[0].slice(0, 150)}`);
      console.log('');
    }
  }
  container.close();
}

function runStats(asJson: boolean): void {
  const container = new Container(PROJECT_PATH);
  const stats = container.query.getStats();
  const vectorInfo = container.vectorStore?.getStats();
  const vectorStats = {
    total: vectorInfo?.totalVectors ?? 0,
    dimension: vectorInfo?.dimensions ?? 0,
    provider: container.resolvedProvider,
  };

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          documents: stats.totalDocuments,
          nodes: stats.totalNodes,
          edges: stats.totalEdges,
          sizeBytes: stats.indexSizeBytes,
          lastIndexed: stats.lastIndexedAt ?? null,
          byExtension: stats.byExtension,
          byLanguage: stats.byLanguage,
          vectors: vectorStats,
        },
        null,
        2,
      ),
    );
    container.close();
    return;
  }

  console.log('Index Statistics');
  console.log('================\n');
  console.log('Documents & Graph');
  console.log('-----------------');
  console.log(`  Total Documents: ${stats.totalDocuments}`);
  console.log(`  Total Nodes: ${stats.totalNodes}`);
  console.log(`  Total Edges: ${stats.totalEdges}`);
  console.log(`  Index Size: ${formatBytes(stats.indexSizeBytes)}`);
  if (stats.lastIndexedAt) console.log(`  Last Indexed: ${new Date(stats.lastIndexedAt).toISOString()}`);
  console.log('\nVectors');
  console.log('-------');
  console.log(`  Embedded Documents: ${vectorStats.total}`);
  console.log(`  Vector Dimension: ${vectorStats.dimension}`);
  console.log(`  Embedding Provider: ${vectorStats.provider}`);
  console.log('\nBy Extension:');
  for (const [ext, count] of Object.entries(stats.byExtension).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ext}: ${count}`);
  }
  console.log('\nBy Language:');
  for (const [lang, count] of Object.entries(stats.byLanguage).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${lang}: ${count}`);
  }
  container.close();
}

function runList(): void {
  const args = process.argv.slice(3);
  const format = getArgValue(args, '--format') || 'text';
  const container = new Container(PROJECT_PATH, { disableEmbeddings: true });
  const docs = container.query.listDocuments({
    extension: getArgValue(args, '--ext'),
    language: getArgValue(args, '--lang'),
  });

  if (format === 'json') {
    console.log(
      JSON.stringify(
        docs.map((d) => ({
          id: d.id,
          path: d.relativePath,
          language: d.language,
          extension: d.extension,
          title: d.title,
          tags: d.tags,
          lineCount: d.lineCount,
          wordCount: d.wordCount,
        })),
        null,
        2,
      ),
    );
  } else {
    console.log(`All Documents (${docs.length}):\n`);
    for (const doc of docs) {
      console.log(`- ${doc.relativePath}`);
      console.log(`  Language: ${doc.language} | Extension: ${doc.extension} | Lines: ${doc.lineCount}`);
      if (doc.title) console.log(`  Title: ${doc.title}`);
      if (doc.tags.length > 0) console.log(`  Tags: ${doc.tags.join(', ')}`);
      console.log('');
    }
  }
  container.close();
}

function runExclude(): void {
  const subcommand = process.argv[3];
  const settings = loadSettings(PROJECT_PATH);

  if (subcommand === 'list') {
    const container = new Container(PROJECT_PATH, { disableEmbeddings: true });
    console.log('Current Exclude Patterns:');
    console.log('=========================\n');
    for (const pattern of container.source.getExcludePatterns()) console.log(`  ${pattern}`);
    console.log(`\nTotal: ${container.source.getExcludePatterns().length} patterns`);
    container.close();
  } else if (subcommand === 'add') {
    const pattern = process.argv[4];
    if (!pattern) return usage('docgraph exclude add <pattern>');
    if (!settings.exclude.patterns.includes(pattern)) {
      settings.exclude.patterns.push(pattern);
      saveSettings(settings);
      console.log(`Added exclude pattern: ${pattern}`);
    } else {
      console.log(`Pattern already exists: ${pattern}`);
    }
  } else if (subcommand === 'remove') {
    const pattern = process.argv[4];
    if (!pattern) return usage('docgraph exclude remove <pattern>');
    const index = settings.exclude.patterns.indexOf(pattern);
    if (index !== -1) {
      settings.exclude.patterns.splice(index, 1);
      saveSettings(settings);
      console.log(`Removed exclude pattern: ${pattern}`);
    } else {
      console.log(`Pattern not found: ${pattern}`);
    }
  } else if (subcommand === 'default') {
    console.log('Default Exclude Patterns:');
    console.log('=========================\n');
    for (const pattern of DEFAULT_EXCLUDE_PATTERNS) console.log(`  ${pattern}`);
    console.log(`\nTotal: ${DEFAULT_EXCLUDE_PATTERNS.length} patterns`);
  } else if (subcommand === 'gitignore') {
    console.log('Gitignore Patterns:');
    console.log('===================\n');
    const patterns = getGitignorePatterns(PROJECT_PATH);
    if (patterns.length === 0) console.log('  (none found)');
    for (const pattern of patterns) console.log(`  ${pattern}`);
    console.log(`\nTotal: ${patterns.length} patterns`);
  } else {
    usage('docgraph exclude [list|add|remove|default|gitignore]');
  }
}

function runFiles(): void {
  const container = new Container(PROJECT_PATH, { disableEmbeddings: true });
  const extensions = container.source.getSupportedExtensions();
  console.log('Supported File Extensions:');
  console.log('===========================\n');
  console.log(`Total: ${extensions.length} extensions\n`);
  for (const [lang, exts] of Object.entries(groupByLanguage(extensions)).sort()) {
    console.log(`  ${lang}: ${exts.join(', ')}`);
  }
  container.close();
}

function runSettings(): void {
  const subcommand = process.argv[3];
  if (subcommand === 'show') {
    console.log(JSON.stringify(loadSettings(PROJECT_PATH), null, 2));
  } else if (subcommand === 'init') {
    createDefaultSettings(PROJECT_PATH);
    console.log('Settings file created at:', SETTINGS_PATH);
  } else if (subcommand === 'path') {
    console.log(SETTINGS_PATH);
  } else {
    usage('docgraph settings [show|init|path]');
  }
}

function runProviders(): void {
  const settings = loadSettings(PROJECT_PATH);
  const active = EmbeddingProviderFactory.resolve(settings.embedding);
  console.log('Supported Embedding Providers:');
  console.log('==============================\n');

  const printProvider = (id: ProviderType) => {
    const info = EmbeddingProviderFactory.getInfo(id);
    const marker = id === active ? ' *' : '';
    const key = info.apiKeyEnv ? ` [env: ${info.apiKeyEnv}]` : '';
    console.log(`    - ${id.padEnd(12)} ${info.description}${key}${marker}`);
  };

  console.log('  Local (no API key):');
  for (const id of EmbeddingProviderFactory.getAllProviders()) {
    if (EmbeddingProviderFactory.getInfo(id).isLocal) printProvider(id);
  }
  console.log('\n  Cloud (require API key):');
  for (const id of EmbeddingProviderFactory.getAllProviders()) {
    if (!EmbeddingProviderFactory.getInfo(id).isLocal) printProvider(id);
  }
  console.log(`\n  * currently active (provider="${settings.embedding.provider}" resolves to "${active}")`);
}

async function runInit(): Promise<void> {
  console.log(`Initializing DocGraph in ${PROJECT_PATH}\n`);

  // 1. Settings file.
  if (existsSync(SETTINGS_PATH)) {
    console.log('•  .docgraph/settings.json already exists');
  } else {
    createDefaultSettings(PROJECT_PATH);
    console.log('✓  Created .docgraph/settings.json');
  }

  // 2. Build the index so search works immediately.
  const container = new Container(PROJECT_PATH, {
    onProgress: (current, total, file) => {
      process.stdout.write(`\r   Indexing [${current}/${total}] ${relative(PROJECT_PATH, file)}`);
    },
  });
  const result = await container.indexing.indexProject();
  process.stdout.write('\r\x1b[K');
  console.log(`✓  Indexed ${result.documents} documents, ${result.vectors} vectors (${container.resolvedProvider})`);
  container.close();

  // 3. Wire the MCP server into agent config files (portable, no absolute paths).
  writeMcpConfig('.mcp.json', (config) => {
    const root = (config.mcpServers ??= {});
    root.docgraph = { ...MCP_LAUNCH };
    return config;
  }, 'Claude Code (.mcp.json)');

  writeMcpConfig('opencode.json', (config) => {
    config['$schema'] ??= 'https://opencode.ai/config.json';
    const root = (config.mcp ??= {});
    root.docgraph = { type: 'local', command: [MCP_LAUNCH.command, ...MCP_LAUNCH.args], enabled: true };
    return config;
  }, 'opencode (opencode.json)');

  console.log('\nDone. DocGraph is ready to use as a local MCP server.');
  console.log('Restart your agent (Claude Code / opencode) to pick up the new MCP server,');
  console.log('or run "docgraph search <query>" from this directory.');
}

/**
 * Merge the DocGraph MCP entry into an agent config file without clobbering
 * existing content. If the file exists but is not parseable JSON, we leave it
 * untouched and print the snippet to add manually.
 */
function writeMcpConfig(fileName: string, mutate: (config: any) => any, label: string): void {
  const filePath = join(PROJECT_PATH, fileName);
  let config: Record<string, any> = {};

  if (existsSync(filePath)) {
    try {
      config = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      console.log(`!  ${label}: existing file is not valid JSON — add the docgraph entry manually.`);
      return;
    }
  }

  writeFileSync(filePath, JSON.stringify(mutate(config), null, 2) + '\n', 'utf-8');
  console.log(`✓  Configured ${label}`);
}

function runServe(): void {
  console.log('Add DocGraph to your agent as a local MCP server (portable, no absolute paths):\n');
  console.log('Claude Code — .mcp.json:');
  console.log(JSON.stringify({ mcpServers: { docgraph: { ...MCP_LAUNCH } } }, null, 2));
  console.log('\nopencode — opencode.json:');
  console.log(
    JSON.stringify(
      { mcp: { docgraph: { type: 'local', command: [MCP_LAUNCH.command, ...MCP_LAUNCH.args], enabled: true } } },
      null,
      2,
    ),
  );
  console.log('\nOr run "docgraph init" to write these files and build the index automatically.');
}

// --- helpers ---------------------------------------------------------------

function usage(message: string): void {
  console.error(`Usage: ${message}`);
  process.exit(1);
}

function getArgValue(args: string[], name: string): string | undefined {
  const arg = args.find((a) => a.startsWith(name + '='));
  return arg?.split('=')[1];
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getGitignorePatterns(projectPath: string): string[] {
  const gitignorePath = join(projectPath, '.gitignore');
  const patterns: string[] = [];
  try {
    if (existsSync(gitignorePath)) {
      for (const line of readFileSync(gitignorePath, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) patterns.push(trimmed);
      }
    }
  } catch {
    /* ignore */
  }
  return patterns;
}

function saveSettings(settings: DocGraphSettings): void {
  mkdirSync(join(PROJECT_PATH, '.docgraph'), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

function groupByLanguage(extensions: string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [lang, exts] of Object.entries(SUPPORTED_EXTENSIONS)) {
    const matching = exts.filter((e) => extensions.includes(e));
    if (matching.length > 0) result[lang] = matching.sort();
  }
  return result;
}

function printHelp(): void {
  console.log(`
DocGraph - Universal documentation knowledge graph with hybrid search

Usage: docgraph <command> [options]     (short binary alias: dg)

Commands (short alias in parentheses):
  init [path]           Set up DocGraph: settings, initial index and MCP config
  install               Wire DocGraph into every detected AI agent (Claude Code, opencode, ...)
  uninstall             Remove DocGraph from every detected AI agent
  index [path]     (i)  Index all documents in the project (local + remote sources)
  reindex [path]   (ri) Clear and re-index all documents
  watch [path]     (w)  Index, then auto-reindex on file changes (autosync)
  search <query>   (s)  Search documents using hybrid (text + vector) search
  stats [path]     (st) Show index statistics
  stats-json [path](stj) Show statistics in JSON format
  list [path]      (ls) List all indexed documents
  sources [action] (src) Manage remote sources (list|enable|disable|pull)
  logs [options]        Read .docgraph/docgraph.log (--tail, --level, --grep, --follow)
  apis [action]         Manage API specs (add|list|remove|enable|disable|pull)
  import <file>    (imp) Import a previously-exported .docgraph.db backup
  export <file>    (exp) Export the current .docgraph.db to a portable file
  exclude [action] (ex) Manage exclude patterns (list|add|remove|default|gitignore)
  files                 List supported file extensions
  settings [action](cfg) Manage settings (show|init|path)
  providers        (prov) List supported embedding providers
  serve [path]          Print MCP server configuration
  mcp [path]            Run the MCP server over stdio (same as the docgraph-mcp binary)

Search options:
  --limit=n             Maximum results (default: 20)
  --format=json|text    Output format
  --ext=<extension>     Filter by extension (e.g. .ts, .md)
  --lang=<language>     Filter by language
  --tags=a,b,c          Filter by tags
  --no-vector           Disable vector search (full-text only)
  --no-text             Disable full-text search (vector only)

Any command:
  --path=<dir>          Explicit project path
  --read-only           Forbid all writes (index/reindex/watch); reads only.
                        Also enabled by DOCGRAPH_READ_ONLY=1.

Examples:
  docgraph index ./my-project
  docgraph search "authentication" --limit=50
  docgraph search "api" --lang=typescript --format=json
  docgraph sources list
  docgraph sources enable notion
  docgraph apis add notion https://api.example.com/v1/openapi.json
  docgraph apis add petstore https://petstore.swagger.io/v2/swagger.json --auth=basic --user=foo --password=bar
  docgraph apis add stripe-api https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.yaml --auth=bearer --token=$STRIPE_KEY
  docgraph apis add my-api https://example.com/openapi.json --auth=custom --header="X-Tenant:acme"
  docgraph logs --tail=100 --level=error
  docgraph logs --follow --grep="vector"
  docgraph exclude add "**/fixtures/**"
  docgraph stats
  docgraph export /tmp/skyzer-docgraph.db.bak
  docgraph import /tmp/skyzer-docgraph.db.bak --replace
`);
}

async function runSources(): Promise<void> {
  const subcommand = process.argv[3];

  // enable/disable must NOT go through Container (which env-resolves settings):
  // writing the resolved settings back would bake `${TOKEN}` secrets into the
  // file in plaintext. Use the raw, unresolved settings reader/writer instead.
  if (subcommand === 'enable' || subcommand === 'disable') {
    const target = process.argv[4];
    if (!target) {
      console.error(`Usage: docgraph sources ${subcommand} <source-name>`);
      process.exit(1);
    }
    const settings = readSettings();
    settings.sources.sources[target] = {
      enabled: subcommand === 'enable',
      options: settings.sources.sources[target]?.options ?? {},
    };
    writeSettings(settings);
    console.log(`Source "${target}" ${subcommand}d`);
    return;
  }

  const container = new Container(PROJECT_PATH);

  try {
    if (!subcommand || subcommand === 'list') {
      const descriptions = container.sourceRegistry?.list() || [];
      console.log('Remote Sources');
      console.log('==============\n');
      if (descriptions.length === 0) {
        console.log('  (no sources registered)');
      } else {
        for (const s of descriptions) {
          const flag = s.enabled ? '✓ enabled ' : '· disabled';
          console.log(`  ${flag}  ${s.name.padEnd(16)} ${s.description}`);
        }
      }
    } else if (subcommand === 'pull') {
      const counts = await container.indexing.pullRemoteSources();
      console.log('Remote-source pull complete:\n');
      for (const [name, count] of Object.entries(counts)) {
        console.log(`  ${name.padEnd(16)} ${count} documents`);
      }
    } else {
      console.error('Usage: docgraph sources [list|enable|disable|pull]');
      process.exit(1);
    }
  } finally {
    container.close();
  }
}

async function runInstall(mode: 'install' | 'uninstall'): Promise<void> {
  const { spawn } = await import('child_process');
  const installerPath = join(__dirname, '..', 'installer', 'installer.js');
  const args = mode === 'uninstall' ? ['uninstall'] : [];
  // Pass through the project path so the installer can resolve it.
  if (PROJECT_PATH) args.push(PROJECT_PATH);
  // Forward --yes for non-interactive invocation.
  if (!process.stdin.isTTY) args.push('--yes');
  const child = spawn(process.execPath, [installerPath, ...args], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

/**
 * Run the MCP server through the main CLI so the short form
 * `npx @carrilloapps/docgraph mcp` works without `-p` or the long
 * `docgraph-mcp` binary name. Everything after `mcp` (a project path,
 * `--read-only`, `--no-watch`, ...) is forwarded verbatim, and stdio is
 * inherited so JSON-RPC flows straight through. The dedicated `docgraph-mcp`
 * binary remains available and behaves identically.
 */
async function runMcpServer(): Promise<void> {
  const { spawn } = await import('child_process');
  const serverPath = join(__dirname, '..', 'mcp', 'server.js');
  const args = process.argv.slice(3);
  const child = spawn(process.execPath, [serverPath, 'serve', ...args], { stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal);
    } catch {
      // child already gone
    }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function runLogs(): Promise<void> {
  const args = process.argv.slice(3);
  const tail = parseInt(getArgValue(args, '--tail') || '50', 10);
  const level = (getArgValue(args, '--level') || 'all') as 'error' | 'warn' | 'info' | 'debug' | 'all';
  const grep = getArgValue(args, '--grep');
  const follow = args.includes('--follow') || args.includes('-f');
  const jsonOut = args.includes('--format=json');
  const allFiles = args.includes('--all');

  if (allFiles) {
    const files = listLogFiles(PROJECT_PATH);
    console.log(`Log files in ${PROJECT_PATH}/.docgraph/:\n`);
    for (const file of files) console.log(`  ${file}`);
    return;
  }

  const result = await readLog(PROJECT_PATH, { tail, level, grep, follow });

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.entries.length === 0) {
    console.log(`(no log entries — file: ${PROJECT_PATH}/.docgraph/docgraph.log)`);
    return;
  }

  console.log(`Showing last ${result.entries.length} entries (file: .docgraph/docgraph.log):\n`);
  for (const entry of result.entries) {
    const ts = entry.ts.replace('T', ' ').replace('Z', '');
    const lvl = entry.level.toUpperCase().padEnd(5);
    const ctx = entry.ctx ? ' ' + JSON.stringify(entry.ctx) : '';
    console.log(`  ${ts}  ${lvl}  ${entry.msg}${ctx}`);
  }
  console.log(`\nLevels: error=${result.stats.byLevel.error}  warn=${result.stats.byLevel.warn}  info=${result.stats.byLevel.info}  debug=${result.stats.byLevel.debug}`);
  if (follow) {
    console.log('\n(streaming... Ctrl-C to exit)');
  }
}

/* -------------------------------------------------------------------------- */
/*                          `docgraph apis` commands                            */
/* -------------------------------------------------------------------------- */

/**
 * CLI subcommand family for managing per-project API spec sources. Unlike
 * the static `sources.sources[name]` block, this list accepts hundreds of
 * entries — projects that integrate with dozens of external APIs add each
 * one with `docgraph apis add <slug> <url> --auth=<mode>`.
 *
 * Auth modes mirror what every API gate we care about uses:
 *   - `--auth=none` (default)
 *   - `--auth=basic --user=foo --password=bar`
 *   - `--auth=bearer --token=$ENV_VAR`
 *   - `--auth=apikey --header=X-Api-Key --token=$ENV_VAR`
 *   - `--auth=custom --header=X-Foo:bar --header=X-Baz:qux`
 */
async function runApis(): Promise<void> {
  const args = process.argv.slice(3);
  const subcommand = args[0];

  switch (subcommand) {
    case 'list':
    case undefined:
      await apisList(args);
      break;
    case 'add':
      apisAdd(args);
      break;
    case 'remove':
    case 'rm':
    case 'delete':
      apisRemove(args);
      break;
    case 'enable':
    case 'disable':
      apisToggle(args, subcommand === 'enable');
      break;
    case 'pull':
      await apisPull(args);
      break;
    default:
      console.error('Usage: docgraph apis [add|list|remove|enable|disable|pull]');
      process.exit(1);
  }
}

async function apisList(args: string[]): Promise<void> {
  const settings = readSettings();
  const apis = settings.sources.apis;
  if (apis.length === 0) {
    console.log(`No API specs configured. Use 'docgraph apis add <name> <url>' to add one.\n  (Configuration file: ${SETTINGS_PATH})`);
    return;
  }

  const format = getArgValue(args, '--format') || 'table';
  if (format === 'json') {
    console.log(JSON.stringify(apis, null, 2));
    return;
  }

  console.log(`API specs (${apis.length} configured):\n`);
  for (const api of apis) {
    const state = api.enabled ? '✓ enabled ' : '· disabled';
    const auth = describeAuth(api.auth);
    const tags = api.tags?.length ? ` [${api.tags.join(', ')}]` : '';
    console.log(`  ${state}  ${api.name.padEnd(24)} ${api.type.padEnd(8)} ${api.title || api.url || api.path || ''}`);
    if (api.url || api.path) console.log(`             url/path: ${api.url ?? api.path}`);
    if (auth) console.log(`             auth: ${auth}`);
    if (tags) console.log(`             tags: ${tags}`);
    console.log('');
  }
}

function describeAuth(auth: ApiAuthConfig | undefined): string {
  if (!auth || auth.mode === 'none') return 'none';
  if (auth.mode === 'basic') return `basic (${mask(auth.username)}:***)`;
  if (auth.mode === 'bearer') return `bearer ***${mask('', auth.token)}`;
  if (auth.mode === 'apiKey') return `apiKey (${auth.apiKeyHeader || 'x-api-key'}: ***)`;
  if (auth.mode === 'custom') {
    const keys = Object.keys(auth.headers || {}).length;
    return `custom (${keys} header${keys === 1 ? '' : 's'})`;
  }
  return 'none';
}

function mask(user?: string, token?: string): string {
  if (!user && !token) return '';
  const u = user ? user.slice(0, 2) + '***' : '';
  const t = token ? '***' + token.slice(-4) : '';
  return [u, t].filter(Boolean).join(':');
}

function apisAdd(args: string[]): void {
  // `add` <name> <url> --auth=<mode> [--user --password --token --header --tag]
  // args[0] = subcommand 'add'
  // args[1] = name
  // args[2+] = positional; we re-parse because the URL is positional and
  //               `--auth` may come earlier.
  const name = args[1];
  const url = args[2];
  if (!name || !url) {
    console.error('Usage: docgraph apis add <name> <url> [--auth=basic|bearer|apiKey|custom] [--user=X --password=Y] [--token=T] [--header="X-Foo: bar"] [--tag=foo]');
    process.exit(1);
  }

  const auth = parseAuthFlags(args);
  const tags = args.filter((a) => a.startsWith('--tag=')).map((a) => a.slice('--tag='.length));
  const typeRaw = (getArgValue(args, '--type') || 'openapi').toLowerCase();
  const validTypes = new Set(['openapi', 'swagger', 'scalar', 'postman']);
  if (!validTypes.has(typeRaw)) {
    console.error(`Unsupported API type: ${typeRaw}. Allowed: ${[...validTypes].join(', ')}`);
    process.exit(1);
  }
  const type = typeRaw as 'openapi' | 'postman' | 'mcp' | 'swagger' | 'scalar';
  const title = getArgValue(args, '--title');

  const settings = readSettings();
  settings.sources.apis = settings.sources.apis.filter((a) => a.name !== name);
  settings.sources.apis.push({ name, type, title, url, auth, enabled: true, tags: tags.length > 0 ? tags : undefined });
  writeSettings(settings);

  console.log(`Added: ${name} (${type})`);
  console.log(`  url: ${url}`);
  if (auth) console.log(`  auth: ${describeAuth(auth)}`);
  if (tags.length > 0) console.log(`  tags: ${tags.join(', ')}`);
  console.log('\nRun `docgraph apis pull ' + name + '` to test, or `docgraph reindex` to refresh the index.');
}

function parseAuthFlags(args: string[]): ApiAuthConfig | undefined {
  const mode = getArgValue(args, '--auth') as ApiAuthMode | undefined;
  if (!mode || mode === 'none') return mode ? { mode: 'none' } : undefined;

  const user = getArgValue(args, '--user');
  const password = getArgValue(args, '--password');
  const token = getArgValue(args, '--token');
  const apiKeyHeader = getArgValue(args, '--header') ?? getArgValue(args, '--apikey-header');
  const headerFlags = args.filter((a) => /^--header=/.test(a)).map((a) => a.slice('--header='.length));

  // Custom headers: support `--header="X-Foo: bar"` repeated.
  const customHeaders: Record<string, string> = {};
  for (const header of headerFlags) {
    const idx = header.indexOf(':');
    if (idx === -1) {
      console.error(`Invalid --header "${header}" — expected "Name: value"`);
      process.exit(1);
    }
    customHeaders[header.slice(0, idx).trim()] = header.slice(idx + 1).trim();
  }

  switch (mode) {
    case 'basic':
      if (user === undefined || password === undefined) {
        console.error('--auth=basic requires --user and --password');
        process.exit(1);
      }
      return { mode, username: user, password };
    case 'bearer':
      if (token === undefined) {
        console.error('--auth=bearer requires --token');
        process.exit(1);
      }
      // Allow empty tokens (user might want literal `$TOKEN` placeholder).
      return { mode, token };
    case 'apiKey':
      if (token === undefined && !customHeaders[apiKeyHeader || 'x-api-key']) {
        console.error('--auth=apiKey requires --token (and optional --header)');
        process.exit(1);
      }
      return {
        mode,
        apiKey: token,
        apiKeyHeader: apiKeyHeader || 'x-api-key',
        headers: Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
      };
    case 'custom':
      if (Object.keys(customHeaders).length === 0) {
        console.error('--auth=custom requires at least one --header="Name: value"');
        process.exit(1);
      }
      return { mode, headers: customHeaders };
    default:
      console.error(`Unsupported --auth mode: ${mode}`);
      process.exit(1);
  }
}

function apisRemove(args: string[]): void {
  const name = args[1];
  if (!name) {
    console.error('Usage: docgraph apis remove <name>');
    process.exit(1);
  }
  const settings = readSettings();
  const before = settings.sources.apis.length;
  settings.sources.apis = settings.sources.apis.filter((a) => a.name !== name);
  if (settings.sources.apis.length === before) {
    console.error(`No API named "${name}" found. Run \`docgraph apis list\` to see configured APIs.`);
    process.exit(1);
  }
  writeSettings(settings);
  console.log(`Removed: ${name}`);
}

function apisToggle(args: string[], enable: boolean): void {
  const name = args[1];
  if (!name) {
    console.error(`Usage: docgraph apis ${enable ? 'enable' : 'disable'} <name>`);
    process.exit(1);
  }
  const settings = readSettings();
  const api = settings.sources.apis.find((a) => a.name === name);
  if (!api) {
    console.error(`No API named "${name}" found.`);
    process.exit(1);
  }
  api.enabled = enable;
  writeSettings(settings);
  console.log(`${enable ? 'Enabled' : 'Disabled'}: ${name}`);
}

async function apisPull(args: string[]): Promise<void> {
  const name = args[1];
  if (!name) {
    console.error('Usage: docgraph apis pull <name>');
    process.exit(1);
  }
  const settings = readSettings();
  const api = settings.sources.apis.find((a) => a.name === name);
  if (!api) {
    console.error(`No API named "${name}" found.`);
    process.exit(1);
  }

  console.log(`Pulling ${name} (${api.type})…`);
  console.log(`  url: ${api.url}`);

  const registry = new SourceRegistry({}, PROJECT_PATH);
  const sources = registry.buildForConfig({ apis: [api] });
  if (sources.length === 0) {
    console.error('Could not build a source for this API (check the type).');
    process.exit(1);
  }
  const source = sources[0];
  try {
    const docs = await source.list();
    console.log(`\nPulled ${docs.length} documents from ${name}.`);
    if (docs.length > 0) {
      console.log('\nSample (first 3):');
      for (const doc of docs.slice(0, 3)) {
        console.log(`  • ${doc.title ?? doc.id}`);
      }
    }
  } catch (err) {
    console.error(`\nPull failed: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    api.lastPulledAt = Date.now();
    const updated = readSettings();
    updated.sources.apis = updated.sources.apis.map((a) => (a.name === name ? api : a));
    writeSettings(updated);
  }
}

/* -------------------------------------------------------------------------- */
/*                       `docgraph export` / `import`                           */
/* -------------------------------------------------------------------------- */

async function runExport(): Promise<void> {
  const outPath = process.argv[3];
  if (!outPath) {
    console.error('Usage: docgraph export <output-path>');
    console.error('Example: docgraph export /tmp/skyzer-docgraph.db.bak');
    process.exit(1);
  }
  if (!existsSync(DB_PATH)) {
    console.error(`No docgraph database at ${DB_PATH} — run \`docgraph index\` first.`);
    process.exit(1);
  }

  // Make sure every pending transaction is on disk before we copy.
  const container = new Container(PROJECT_PATH);
  try {
    container.repository.checkpoint();
  } finally {
    container.close();
  }

  const absoluteOut = outPath.startsWith('/') || outPath.includes(':\\')
    ? outPath
    : join(process.cwd(), outPath);
  mkdirSync(dirname(absoluteOut), { recursive: true });
  copyFileSync(DB_PATH, absoluteOut);
  const stat = readDBStatsSync(absoluteOut);
  console.log(`Exported ${stat.documents} documents (${stat.nodes} nodes, ${stat.edges} edges, ~${stat.sizeMb.toFixed(1)} MB) to`);
  console.log(`  ${absoluteOut}`);
  console.log('\nImport on another machine with:');
  console.log(`  docgraph import ${absoluteOut.split(/[\\/]/).pop()}`);
}

async function runImport(): Promise<void> {
  const sourcePath = process.argv[3];
  if (!sourcePath) {
    console.error('Usage: docgraph import <backup-path> [--replace]');
    process.exit(1);
  }

  const args = process.argv.slice(4);
  const replace = args.includes('--replace');
  const absoluteSrc = existsSync(sourcePath) ? sourcePath : join(process.cwd(), sourcePath);
  if (!existsSync(absoluteSrc)) {
    console.error(`No such backup file: ${sourcePath}`);
    process.exit(1);
  }

  if (existsSync(DB_PATH) && !replace) {
    const stat = readDBStatsSync(DB_PATH);
    if (stat.documents > 0) {
      console.error(`Current database has ${stat.documents} documents. Pass --replace to overwrite or --merge to keep both.`);
      process.exit(1);
    }
  }

  mkdirSync(dirname(DB_PATH), { recursive: true });

  // Copy the file, then the destination DB will be reopened with WAL
  // enabled on next use (this is the same read-then-reopen pattern that
  // SqliteKnowledgeStore applies on init).
  copyFileSync(absoluteSrc, DB_PATH);

  const stat = readDBStatsSync(DB_PATH);
  console.log(`Imported ${stat.documents} documents (${stat.nodes} nodes, ${stat.edges} edges) from`);
  console.log(`  ${absoluteSrc}`);
  console.log(`  into ${DB_PATH}`);
  console.log('\nRun `docgraph stats` to verify.');
}

/* -------------------------------------------------------------------------- */
/*                            Settings helpers                                */
/* -------------------------------------------------------------------------- */

function readSettings(): DocGraphSettings {
  const settingsPath = join(PROJECT_PATH, '.docgraph', 'settings.json');
  const defaults = defaultSettings();
  if (!existsSync(settingsPath)) {
    return defaults;
  }
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Partial<DocGraphSettings>;
    // Merge so missing sections (e.g. `sources.apis` added in a newer release)
    // fall back to defaults rather than blowing up with undefined access.
    return {
      ...defaults,
      ...parsed,
      sources: { ...defaults.sources, ...(parsed.sources || {}) },
      logging: { ...defaults.logging, ...(parsed.logging || {}) },
    };
  } catch (err) {
    console.error(`Failed to parse ${settingsPath}: ${(err as Error).message}`);
    process.exit(1);
  }
}

function writeSettings(settings: DocGraphSettings): void {
  const settingsPath = join(PROJECT_PATH, '.docgraph', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

function defaultSettings(): DocGraphSettings {
  return {
    embedding: { provider: 'auto', batchSize: 50, timeout: 30000, maxRetries: 3 },
    indexing: {
      chunkSize: 512,
      chunkOverlap: 50,
      generateOnIndex: true,
      reindexOnDelete: false,
      followSymlinks: false,
      maxFileSize: 10 * 1024 * 1024,
    },
    search: { vectorWeight: 0.7, textWeight: 0.3, rerank: true, minScore: 0.1, limit: 20 },
    cache: { embeddingsDir: '.docgraph/embeddings', ttl: 604800, maxCacheSize: 1024 * 1024 * 1024 },
    exclude: { enabled: true, patterns: [], useGitignore: true, useDefaultPatterns: true },
    files: { extensions: [], excludeExtensions: [], maxFileSize: 10 * 1024 * 1024, includeHidden: false },
    providers: { primary: 'auto', fallback: [] },
    sources: { sources: {}, apis: [], mcp: [], pullOnIndex: true, pullOnReindex: true, maxPagesPerSource: 50, maxConcurrentSources: 4 },
    logging: { level: 'info', maxBytes: 5 * 1024 * 1024, maxFiles: 3, mirrorStderr: false },
    watch: { enabled: true, debounceMs: 1000 },
    security: { readOnly: false },
    debug: false,
  };
}

function readDBStatsSync(dbPath: string): {
  documents: number;
  nodes: number;
  edges: number;
  sizeMb: number;
} {
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    const documents = (db.prepare('SELECT COUNT(*) as c FROM documents').get() as { c: number }).c;
    const nodes = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    const edges = (db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c;
    const size = statSync(dbPath).size;
    return {
      documents,
      nodes,
      edges,
      sizeMb: size / (1024 * 1024),
    };
  } finally {
    db.close();
  }
}

void readDBStatsSync;
void defaultSettings;

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
