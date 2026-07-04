import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface EmbeddingSettings {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeout: number;
  maxRetries: number;
  batchSize: number;
  dimension?: number;
}

export interface IndexingSettings {
  chunkSize: number;
  chunkOverlap: number;
  generateOnIndex: boolean;
  reindexOnDelete: boolean;
  followSymlinks: boolean;
  maxFileSize: number;
}

export interface SearchSettings {
  vectorWeight: number;
  textWeight: number;
  rerank: boolean;
  minScore: number;
  limit: number;
  minSimilarity?: number;
  maxResults?: number;
}

export interface CacheSettings {
  embeddingsDir: string;
  ttl: number;
  maxCacheSize: number;
}

export interface ExcludePatterns {
  enabled: boolean;
  patterns: string[];
  useGitignore: boolean;
  useDefaultPatterns: boolean;
}

export interface FileFilters {
  extensions: string[];
  excludeExtensions: string[];
  maxFileSize: number;
  includeHidden: boolean;
}

export interface ProviderPriority {
  primary?: string;
  fallback?: string[];
}

export interface RemoteSourceConfig {
  /** Disable a source without losing its options. */
  enabled: boolean;
  /** Source-specific options (token, vaultPath, jql, ...). */
  options: Record<string, unknown>;
}

/**
 * One entry in the user's "list of things I'm integrating with or
 * developing against". Designed for OpenAPI / Postman / Scalar endpoints
 * that may number in the hundreds — `docgraph apis list` walks them and
 * reports per-source status without spawning hundreds of subprocesses.
 *
 * Auth model is intentionally flexible to match how real APIs work:
 *   - `auth: 'none'` (default) — anonymous request.
 *   - `auth: 'basic'` — uses `username` + `password` (or the existing
 *     `apiKey` field if `username` is omitted), Basic auth header.
 *   - `auth: 'bearer'` — `Authorization: Bearer <token>`.
 *   - `auth: 'apiKey'` — `header` (default `x-api-key`) carrying `<token>`.
 *   - `auth: 'custom'` — send each entry of `headers[]` verbatim.
 * Multiple auth strategies can coexist via the `headers[]` array (for
 * things like `X-Tenant-Id: foo` + `Authorization: Bearer bar`).
 */
export type ApiAuthMode = 'none' | 'basic' | 'bearer' | 'apiKey' | 'custom';

export interface ApiAuthConfig {
  /** Auth mode for this spec. */
  mode: ApiAuthMode;
  /** Username for `basic` auth. */
  username?: string;
  /** Password for `basic` auth. */
  password?: string;
  /** Bearer token for `bearer` auth. */
  token?: string;
  /** API-key value for `apiKey` auth. */
  apiKey?: string;
  /** Header name for `apiKey` auth. Defaults to `x-api-key`. */
  apiKeyHeader?: string;
  /** Optional custom headers (always applied on top of `mode`). */
  headers?: Record<string, string>;
}

export interface ApiSourceItem {
  /** Stable identifier (lowercase slug is recommended). */
  name: string;
  /** Provider type (`openapi`, `postman`, `mcp`, ...). */
  type: 'openapi' | 'postman' | 'mcp' | 'swagger' | 'scalar';
  /** Display title shown in `docgraph apis list`. */
  title?: string;
  /** URL of the spec file (or collection) — required for `openapi` / `postman`. */
  url?: string;
  /** Optional local path alternative to `url` (used when offline). */
  path?: string;
  /** Auth configuration: default is `none`. */
  auth?: ApiAuthConfig;
  /** Disable without losing config. */
  enabled: boolean;
  /** Free-form tags surfaced as document tags and CLI filters. */
  tags?: string[];
  /** Hour UTC, last time the spec was pulled. */
  lastPulledAt?: number;
}

/**
 * MCP connector entry. Stored separately from {@link ApiSourceItem} so
 * the schema for "things I integrate with" stays narrow and MCP-specific
 * options (`command`, `strategy`) live next to each other.
 */
export interface McpSourceItem {
  name: string;
  description?: string;
  command: string[];
  env?: Record<string, string>;
  /** Inline strategy; kept loose here for forward-compatibility. */
  strategy: any;
  enabled: boolean;
}

export interface SourcesConfig {
  /** Per-source configuration keyed by source name (`notion`, `jira`, `obsidian`, ...). */
  sources: Record<string, RemoteSourceConfig>;
  /**
   * Free-form list of API specs the project integrates with / is
   * developing against. May contain hundreds of entries — the indexing
   * service pulls them serially with rate-limit-aware pagination.
   */
  apis: ApiSourceItem[];
  /**
   * MCP connector entries (the project talks to other MCP servers via
   * JSON-RPC and ingests everything they expose). Read-only by
   * construction — destructive MCP tool names are refused.
   */
  mcp: McpSourceItem[];
  /** Whether to include remote sources in `index_project` runs. */
  pullOnIndex: boolean;
  /** Whether to include remote sources in `reindex` runs. */
  pullOnReindex: boolean;
  /** Max pages to traverse per paginated source (default 50). */
  maxPagesPerSource: number;
  /** Max parallel source pulls. */
  maxConcurrentSources: number;
}

export interface LoggingConfig {
  /** Minimum log level emitted to `.docgraph/docgraph.log` (default `info`). */
  level: 'error' | 'warn' | 'info' | 'debug';
  /** Soft cap (bytes) before rotation. Default 5 MB. */
  maxBytes: number;
  /** Maximum number of rotated files retained. Default 3. */
  maxFiles: number;
  /** Mirror every log entry to stderr (default off — equivalent to DOCGRAPH_DEBUG=1). */
  mirrorStderr: boolean;
}

export interface WatchSettings {
  /** Auto-reindex on file changes when running as a long-lived process (`serve`/`watch`). */
  enabled: boolean;
  /** Debounce window (ms) to coalesce bursts of file events before reindexing. Default 1000. */
  debounceMs: number;
}

export interface SecuritySettings {
  /**
   * When `true`, DocGraph never writes to the index: no indexing, no
   * embedding writes, no autosync, no settings mutation — only reads
   * (search, explore, get_*, list, stats, logs). Overridable per-run by the
   * `--read-only` CLI flag or the `DOCGRAPH_READ_ONLY` env var, both of
   * which take precedence over this setting. Default `false`.
   */
  readOnly: boolean;
}

export interface DocGraphSettings {
  embedding: EmbeddingSettings;
  indexing: IndexingSettings;
  search: SearchSettings;
  cache: CacheSettings;
  exclude: ExcludePatterns;
  files: FileFilters;
  providers: ProviderPriority;
  sources: SourcesConfig;
  logging: LoggingConfig;
  watch: WatchSettings;
  security: SecuritySettings;
  debug: boolean;
}

export const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/.bzr/**',
  '**/.DS_Store/**',
  '**/Thumbs.db/**',
  '**/*.pyc',
  '**/__pycache__/**',
  '**/*.class',
  '**/*.o',
  '**/*.obj',
  '**/*.dll',
  '**/*.exe',
  '**/*.so',
  '**/*.dylib',
  '**/*.bin',
  '**/*.dat',
  '**/*.pak',
  '**/*.scc',
  '**/*.vcxproj',
  '**/*.sln',
  '**/.vs/**',
  '**/.idea/**',
  '**/*.suo',
  '**/*.user',
  '**/*.rs',
  '**/target/**',
  '**/Cargo.lock/**',
  '**/.cargo/**',
  '**/vendor/**',
  '**/.venv/**',
  '**/venv/**',
  '**/env/**',
  '**/.env/**',
  '**/.env.local/**',
  '**/.env.*.local/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.output/**',
  '**/.cache/**',
  '**/.turbo/**',
  '**/.yarn/**',
  '**/.pnpm-store/**',
  '**/coverage/**',
  '**/.nyc_output/**',
  '**/htmlcov/**',
  '**/.pytest_cache/**',
  '**/.mypy_cache/**',
  '**/.ruff_cache/**',
  '**/.tox/**',
  '**/.gradle/**',
  '**/build/**',
  '**/.gradle/**',
  '**/.android/**',
  '**/.dart_tool/**',
  '**/.pub-cache/**',
  '**/.pub/**',
  '**/bower_components/**',
  '**/jspm_packages/**',
  '**/*.egg-info/**',
  '**/.npm/**',
  '**/.yarn-integrity/**',
  '**/site-packages/**',
  '**/.composer/**',
  '**/vendor/bundle/**',
  '**/vendor/cache/**',
  '**/.sass-cache/**',
  '**/.webpack/**',
  '**/*.log',
  '**/*.tmp',
  '**/*.temp',
  '**/*.bak',
  '**/*.swp',
  '**/*.swo',
  '**/*~',
  '**/#*#',
  '**/.lock',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lockb',
  '**/composer.lock',
  '**/Gemfile.lock',
  '**/Podfile.lock',
  '**/poetry.lock',
  '**/pip-log.txt',
  '**/pip-delete-this-directory.txt',
  '**/.mvn/wrapper/maven-wrapper.jar',
  '**/.jpb/**',
  '**/.flattened-pom.xml',
  '**/win-unpacked-app/**',
  '**/*.AppImage',
  '**/*.deb',
  '**/*.rpm',
  '**/*.snap',
  '**/*.flatpak-ref',
  '**/.Spotlight-V100/**',
  '**/.Trashes/**',
  '**/.DocumentRevisions-V100/**',
  '**/.fseventsd/**',
  '**/.TemporaryItems/**',
  '**/. VolumeIcon.icns/**',
  '**/.LSOverride/**',
  '**/._*',
];

export const SUPPORTED_EXTENSIONS: Record<string, string[]> = {
  markdown: ['.md', '.markdown', '.mdown', '.mkd', '.mkdn'],
  asciidoc: ['.adoc', '.asciidoc', '.adr'],
  restructuredtext: ['.rst'],
  org: ['.org'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  python: ['.py', '.pyw', '.pyi'],
  java: ['.java', '.kt', '.kts'],
  csharp: ['.cs', '.csx'],
  cpp: ['.cpp', '.cc', '.cxx', '.c++', '.h', '.hpp', '.hh'],
  c: ['.c', '.h'],
  go: ['.go'],
  rust: ['.rs'],
  ruby: ['.rb', '.rake', '.gemspec'],
  php: ['.php'],
  swift: ['.swift'],
  objectivec: ['.m', '.mm', '.h'],
  kotlin: ['.kt', '.kts'],
  scala: ['.scala', '.sc'],
  clojure: ['.clj', '.cljs', '.cljc', '.edn'],
  haskell: ['.hs', '.lhs', '.hsig'],
  elixir: ['.ex', '.exs', '.eex', '.leex'],
  erlang: ['.erl', '.hrl', '.escript'],
  lua: ['.lua'],
  perl: ['.pl', '.pm', '.t'],
  r: ['.r', '.R', '.Rmd', '.Rnw'],
  shell: ['.sh', '.bash', '.zsh', '.fish', '.ksh'],
  powershell: ['.ps1', '.psm1', '.psd1'],
  sql: ['.sql'],
  graphql: ['.graphql', '.gql'],
  json: ['.json', '.jsonc', '.json5'],
  yaml: ['.yaml', '.yml'],
  toml: ['.toml'],
  xml: ['.xml', '.xsd', '.xsl', '.xslt'],
  html: ['.html', '.htm', '.xhtml'],
  css: ['.css', '.scss', '.sass', '.less', '.styl'],
  vue: ['.vue'],
  svelte: ['.svelte'],
  terraform: ['.tf', '.tfvars'],
  dockerfile: ['Dockerfile', '.dockerignore'],
  makefile: ['Makefile', 'makefile', '.mak'],
  cmake: ['CMakeLists.txt', '*.cmake', '*.cmake.in'],
  ini: ['.ini', '.cfg', '.conf', '.config'],
  env: ['.env', '.env.example', '.env.sample'],
  proto: ['.proto'],
  wasm: ['.wasm'],
  solidity: ['.sol'],
  move: ['.move'],
  cairo: ['.cairo'],
  uniswa: ['.sw'],
};

const DEFAULT_SETTINGS: DocGraphSettings = {
  embedding: {
    provider: 'auto',
    batchSize: 50,
    timeout: 30000,
    maxRetries: 3,
  },
  indexing: {
    chunkSize: 512,
    chunkOverlap: 50,
    generateOnIndex: true,
    reindexOnDelete: false,
    followSymlinks: false,
    maxFileSize: 10 * 1024 * 1024,
  },
  search: {
    vectorWeight: 0.7,
    textWeight: 0.3,
    rerank: true,
    minScore: 0.1,
    limit: 20,
  },
  cache: {
    embeddingsDir: '.docgraph/embeddings',
    ttl: 604800,
    maxCacheSize: 1024 * 1024 * 1024,
  },
  exclude: {
    enabled: true,
    patterns: [],
    useGitignore: true,
    useDefaultPatterns: true,
  },
  files: {
    extensions: [],
    excludeExtensions: [],
    maxFileSize: 10 * 1024 * 1024,
    includeHidden: false,
  },
  providers: {
    primary: 'auto',
    fallback: [],
  },
  sources: {
    sources: {},
    apis: [],
    mcp: [],
    pullOnIndex: true,
    pullOnReindex: true,
    maxPagesPerSource: 50,
    maxConcurrentSources: 4,
  },
  logging: {
    level: 'info',
    maxBytes: 5 * 1024 * 1024,
    maxFiles: 3,
    mirrorStderr: false,
  },
  watch: {
    enabled: true,
    debounceMs: 1000,
  },
  security: {
    readOnly: false,
  },
  debug: false,
};

export function loadSettings(projectPath: string): DocGraphSettings {
  const settingsPath = join(projectPath, '.docgraph', 'settings.json');

  if (existsSync(settingsPath)) {
    try {
      const content = readFileSync(settingsPath, 'utf-8');
      const userSettings = resolveEnvVariables(JSON.parse(content)) as Partial<DocGraphSettings>;
      return mergeSettings(DEFAULT_SETTINGS, userSettings);
    } catch (error) {
      console.error(`Error loading settings from ${settingsPath}:`, error);
      return DEFAULT_SETTINGS;
    }
  }

  const localSettingsPath = join(projectPath, 'docgraph.json');
  if (existsSync(localSettingsPath)) {
    try {
      const content = readFileSync(localSettingsPath, 'utf-8');
      const userSettings = resolveEnvVariables(JSON.parse(content)) as Partial<DocGraphSettings>;
      return mergeSettings(DEFAULT_SETTINGS, userSettings);
    } catch (error) {
      console.error(`Error loading settings from ${localSettingsPath}:`, error);
      return DEFAULT_SETTINGS;
    }
  }

  return DEFAULT_SETTINGS;
}

function mergeSettings(defaults: DocGraphSettings, overrides: Partial<DocGraphSettings>): DocGraphSettings {
  const result: DocGraphSettings = {
    embedding: { ...defaults.embedding, ...overrides.embedding },
    indexing: { ...defaults.indexing, ...overrides.indexing },
    search: { ...defaults.search, ...overrides.search },
    cache: { ...defaults.cache, ...overrides.cache },
    exclude: {
      enabled: overrides.exclude?.enabled ?? defaults.exclude.enabled,
      patterns: [...defaults.exclude.patterns, ...(overrides.exclude?.patterns || [])],
      useGitignore: overrides.exclude?.useGitignore ?? defaults.exclude.useGitignore,
      useDefaultPatterns: overrides.exclude?.useDefaultPatterns ?? defaults.exclude.useDefaultPatterns,
    },
    files: { ...defaults.files, ...overrides.files },
    providers: { ...defaults.providers, ...overrides.providers },
    sources: {
      sources: { ...defaults.sources.sources, ...(overrides.sources?.sources || {}) },
      apis: overrides.sources?.apis ?? defaults.sources.apis,
      mcp: overrides.sources?.mcp ?? defaults.sources.mcp,
      pullOnIndex: overrides.sources?.pullOnIndex ?? defaults.sources.pullOnIndex,
      pullOnReindex: overrides.sources?.pullOnReindex ?? defaults.sources.pullOnReindex,
      maxPagesPerSource: overrides.sources?.maxPagesPerSource ?? defaults.sources.maxPagesPerSource,
      maxConcurrentSources: overrides.sources?.maxConcurrentSources ?? defaults.sources.maxConcurrentSources,
    },
    logging: {
      level: overrides.logging?.level ?? defaults.logging.level,
      maxBytes: overrides.logging?.maxBytes ?? defaults.logging.maxBytes,
      maxFiles: overrides.logging?.maxFiles ?? defaults.logging.maxFiles,
      mirrorStderr: overrides.logging?.mirrorStderr ?? defaults.logging.mirrorStderr,
    },
    watch: {
      enabled: overrides.watch?.enabled ?? defaults.watch.enabled,
      debounceMs: overrides.watch?.debounceMs ?? defaults.watch.debounceMs,
    },
    security: {
      readOnly: overrides.security?.readOnly ?? defaults.security.readOnly,
    },
    debug: overrides.debug ?? defaults.debug,
  };

  return result;
}

export function resolveEnvVariables(obj: unknown): unknown {
  if (typeof obj === 'string') {
    const envMatch = obj.match(/^\$\{([^}]+)\}$/);
    if (envMatch) {
      return process.env[envMatch[1]] || obj;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVariables);
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = resolveEnvVariables(value);
    }
    return result;
  }

  return obj;
}

export function getEffectiveExcludePatterns(settings: DocGraphSettings, projectPath?: string): string[] {
  const patterns: string[] = [];

  if (settings.exclude.useDefaultPatterns) {
    patterns.push(...DEFAULT_EXCLUDE_PATTERNS);
  }

  if (settings.exclude.useGitignore) {
    patterns.push(...readGitignorePatterns(projectPath));
  }

  patterns.push(...settings.exclude.patterns);

  return [...new Set(patterns)];
}

function readGitignorePatterns(projectPath?: string): string[] {
  const patterns: string[] = [];
  const basePath = projectPath ?? process.cwd();
  const gitignorePath = join(basePath, '.gitignore');

  if (existsSync(gitignorePath)) {
    try {
      const content = readFileSync(gitignorePath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        // Skip negation (re-include) rules. These are passed to minimatch as
        // exclude patterns, and a leading `!` makes minimatch match EVERYTHING
        // except the pattern — which would exclude the entire project and index
        // zero documents. DocGraph does not support gitignore re-inclusion, so
        // dropping these is both safe and correct.
        if (trimmed.startsWith('!')) continue;
        // Normalize a leading slash (gitignore "anchored to root") to a relative
        // path so it matches how paths are compared in `shouldExclude`.
        const pattern = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
        if (!pattern) continue;
        patterns.push(pattern);
        if (!pattern.endsWith('/') && !pattern.includes('*')) {
          patterns.push(pattern + '/**');
        }
      }
    } catch {
    }
  }

  return patterns;
}

export function createDefaultSettings(projectPath: string): void {
  const settingsPath = join(projectPath, '.docgraph', 'settings.json');
  mkdirSync(join(projectPath, '.docgraph'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf-8');
}

export function getAllSupportedExtensions(): string[] {
  const extensions = new Set<string>();
  for (const exts of Object.values(SUPPORTED_EXTENSIONS)) {
    for (const ext of exts) {
      extensions.add(ext);
    }
  }
  return Array.from(extensions).sort();
}

export function getExtensionsForLanguage(language: string): string[] {
  return SUPPORTED_EXTENSIONS[language.toLowerCase()] || [];
}
