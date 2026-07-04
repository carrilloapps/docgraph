import { readFileSync, readdirSync, statSync, existsSync, lstatSync } from 'fs';
import { join, relative, extname } from 'path';
import { minimatch } from 'minimatch';
import { DocumentSource, SourceFile } from '../../domain/ports.js';
import { DocGraphSettings, getEffectiveExcludePatterns, SUPPORTED_EXTENSIONS } from '../config/settings.js';

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.md': 'markdown', '.markdown': 'markdown', '.mdown': 'markdown', '.mkd': 'markdown', '.mkdn': 'markdown',
  '.json': 'json', '.jsonc': 'json', '.json5': 'json',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml',
  '.adoc': 'asciidoc', '.asciidoc': 'asciidoc', '.adr': 'asciidoc',
  '.rst': 'restructuredtext',
  '.org': 'org',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.py': 'python', '.pyw': 'python', '.pyi': 'python',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.cs': 'csharp', '.csx': 'csharp',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.c++': 'cpp', '.h': 'c', '.hpp': 'cpp', '.hh': 'cpp',
  '.go': 'go', '.rs': 'rust',
  '.rb': 'ruby', '.rake': 'ruby', '.gemspec': 'ruby',
  '.php': 'php', '.swift': 'swift', '.m': 'objectivec', '.mm': 'objectivec',
  '.scala': 'scala', '.sc': 'scala',
  '.clj': 'clojure', '.cljs': 'clojure', '.cljc': 'clojure', '.edn': 'clojure',
  '.hs': 'haskell', '.lhs': 'haskell', '.hsig': 'haskell',
  '.ex': 'elixir', '.exs': 'elixir', '.eex': 'elixir', '.leex': 'elixir',
  '.erl': 'erlang', '.hrl': 'erlang', '.escript': 'erlang',
  '.lua': 'lua', '.pl': 'perl', '.pm': 'perl', '.t': 'perl',
  '.r': 'r', '.R': 'r', '.Rmd': 'r',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell', '.ksh': 'shell',
  '.ps1': 'powershell', '.psm1': 'powershell', '.psd1': 'powershell',
  '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql',
  '.xml': 'xml', '.xsd': 'xml', '.xsl': 'xml', '.xslt': 'xml',
  '.html': 'html', '.htm': 'html', '.xhtml': 'html',
  '.css': 'css', '.scss': 'sass', '.sass': 'sass', '.less': 'less', '.styl': 'css',
  '.vue': 'vue', '.svelte': 'svelte',
  '.tf': 'terraform', '.tfvars': 'terraform',
  '.proto': 'proto', '.wasm': 'wasm',
  '.sol': 'solidity', '.move': 'move', '.cairo': 'cairo', '.sw': 'uniswa',
};

/** Filesystem-backed {@link DocumentSource}. */
export class FileSystemDocumentSource implements DocumentSource {
  private readonly excludePatterns: string[];
  private readonly includeExtensions: Set<string>;

  constructor(
    private readonly projectPath: string,
    private readonly settings: DocGraphSettings,
  ) {
    this.excludePatterns = getEffectiveExcludePatterns(settings, projectPath);
    this.includeExtensions = this.buildIncludeExtensions();
  }

  list(): string[] {
    const files: string[] = [];
    this.scanDirectory(this.projectPath, files);
    return files;
  }

  read(path: string): SourceFile | null {
    if (!existsSync(path)) return null;

    let stats;
    try {
      stats = statSync(path);
    } catch {
      return null;
    }
    if (stats.isDirectory()) return null;
    if (stats.size > this.settings.indexing.maxFileSize) return null;

    const extension = extname(path).toLowerCase();
    if (!this.includeExtensions.has(extension)) return null;

    const language = EXTENSION_TO_LANGUAGE[extension];
    if (!language) return null;

    let rawContent: string;
    try {
      rawContent = readFileSync(path, 'utf-8');
    } catch {
      return null;
    }

    return {
      path,
      relativePath: relative(this.projectPath, path),
      rawContent,
      extension,
      language,
      size: stats.size,
    };
  }

  getSupportedExtensions(): string[] {
    return Array.from(this.includeExtensions).sort();
  }

  getExcludePatterns(): string[] {
    return [...this.excludePatterns];
  }

  private buildIncludeExtensions(): Set<string> {
    const extensions = new Set<string>();

    if (this.settings.files.extensions.length > 0) {
      for (const ext of this.settings.files.extensions) {
        extensions.add(ext.startsWith('.') ? ext : '.' + ext);
      }
    } else {
      for (const lang of Object.keys(SUPPORTED_EXTENSIONS)) {
        for (const ext of SUPPORTED_EXTENSIONS[lang]) {
          extensions.add(ext);
        }
      }
    }

    for (const ext of this.settings.files.excludeExtensions) {
      extensions.delete(ext.startsWith('.') ? ext : '.' + ext);
    }

    return extensions;
  }

  private scanDirectory(dir: string, files: string[]): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);

      try {
        const stats = lstatSync(fullPath);

        if (this.settings.indexing.followSymlinks && stats.isSymbolicLink()) {
          const targetStats = statSync(fullPath);
          if (targetStats.isDirectory()) {
            if (!this.shouldExclude(fullPath)) this.scanDirectory(fullPath, files);
            continue;
          }
        }

        if (stats.isDirectory()) {
          if (this.shouldExclude(fullPath)) continue;
          this.scanDirectory(fullPath, files);
        } else if (!this.shouldExclude(fullPath)) {
          files.push(fullPath);
        }
      } catch {
        continue;
      }
    }
  }

  private shouldExclude(path: string): boolean {
    const normalizedPath = relative(this.projectPath, path).replace(/\\/g, '/');

    if (!this.settings.files.includeHidden) {
      for (const part of normalizedPath.split('/')) {
        if (part.startsWith('.') && part !== '.gitignore') {
          return true;
        }
      }
    }

    for (const pattern of this.excludePatterns) {
      if (
        minimatch(normalizedPath, pattern, { dot: true }) ||
        minimatch(normalizedPath, pattern.replace(/\/\*\*$/, '/**/*'), { dot: true })
      ) {
        return true;
      }
    }

    return false;
  }
}
