import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, basename, relative } from 'path';
import { RemoteDocument, RemoteSource, SourceProvider } from './types.js';
import { defineSource } from './http-remote-source.js';

/**
 * Adapter for a local Obsidian vault. Walks the vault directory, reads each
 * markdown note, and surfaces it as a {@link RemoteDocument} so the indexing
 * pipeline merges it with code/text sources — no API token needed, fully local.
 *
 * Authentication: filesystem permissions only (the vault is local).
 * Configuration: `{ vaultPath: string }` — absolute path to the vault root.
 */
export class ObsidianSource implements RemoteSource {
  readonly name = 'obsidian';
  readonly description = 'Local Obsidian vault (Markdown notes with YAML front-matter)';

  private readonly vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
  }

  async list(): Promise<RemoteDocument[]> {
    if (!existsSync(this.vaultPath)) return [];
    return this.walk(this.vaultPath);
  }

  async get(id: string): Promise<RemoteDocument | null> {
    const all = await this.list();
    return all.find((d) => d.id === id) ?? null;
  }

  private walk(dir: string, out: RemoteDocument[] = []): RemoteDocument[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const full = join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        // Skip Obsidian config, plugin caches, and daily-note templates
        if (entry === '.obsidian' || entry === '.trash') continue;
        this.walk(full, out);
      } else if (stats.isFile() && /\.(md|markdown|mdx)$/i.test(entry)) {
        try {
          const content = readFileSync(full, 'utf-8');
          const doc = this.parseNote(full, content, stats.mtime.toISOString());
          out.push(doc);
        } catch {
          // Skip unreadable files.
        }
      }
    }
    return out;
  }

  private parseNote(fullPath: string, rawContent: string, lastModified: string): RemoteDocument {
    const relPath = relative(this.vaultPath, fullPath).replace(/\\/g, '/');
    const id = `obsidian:${relPath}`;
    let body = rawContent;
    let title: string | undefined;
    let tags: string[] = [];

    // Parse optional YAML front-matter.
    const fmMatch = rawContent.match(/^---\n([\s\S]*?)\n---\n?/);
    if (fmMatch) {
      const fm = fmMatch[1];
      body = rawContent.slice(fmMatch[0].length).trim();
      const titleMatch = fm.match(/^title:\s*(.+)$/m);
      if (titleMatch) title = titleMatch[1].replace(/^['"]|['"]$/g, '');
      const tagsMatch = fm.match(/^tags:\s*(.+)$/m);
      if (tagsMatch) {
        // YAML lists look like `[mvp, skyzer, mobile]` or `mvp skyzer mobile` — strip the
        // surrounding brackets and split on commas/whitespace before filtering empties.
        const raw = tagsMatch[1].replace(/^\[/, '').replace(/\]$/, '');
        tags = raw
          .split(/[\s,]+/)
          .map((t) => t.replace(/^['"]|['"]$/g, '').trim())
          .filter((t): t is string => Boolean(t));
      }
    }

    if (!title) {
      const firstHeading = body.match(/^#\s+(.+)$/m);
      title = firstHeading ? firstHeading[1].trim() : basename(fullPath, /\.[^.]+$/.exec(fullPath)?.[0] ?? '');
    }

    // Extract inline #tags and [[wikilinks]] as additional tags.
    const inlineTags = Array.from(body.matchAll(/(?:^|\s)#([a-zA-Z0-9_\-/]+)/g)).map((m) => m[1]);
    const wikiLinks = Array.from(body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)).map((m) => m[1].trim());
    tags = Array.from(new Set([...tags, ...inlineTags, ...wikiLinks]));

    return {
      id,
      path: `obsidian://${this.vaultPath.replace(/\\/g, '/')}/${relPath}`,
      title,
      content: body,
      extension: '.md',
      tags,
      lastModified,
      metadata: {
        source: 'obsidian',
        vaultRelativePath: relPath,
      },
    };
  }
}

export const ObsidianProvider: SourceProvider = defineSource(
  'obsidian',
  'Local Obsidian vault (filesystem-based, no API token)',
  {
    vaultPath: { type: 'string', description: 'Absolute path to the Obsidian vault root', required: true },
  },
  (config) => new ObsidianSource(String(config.vaultPath)),
);
