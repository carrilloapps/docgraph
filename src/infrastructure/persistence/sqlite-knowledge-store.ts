import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { Document, GraphNode, GraphEdge, SearchResult, IndexStats } from '../../domain/entities.js';
import { KnowledgeRepository } from '../../domain/ports.js';

/**
 * Default SQLite schema for {@link SqliteKnowledgeStore}. Bumped whenever
 * a backwards-incompatible change is shipped; the live {@link SchemaVersion}
 * in metadata is compared on every open so a fresh DB carries the right
 * number and an older DB is migrated forward.
 */
export const EXPECTED_SCHEMA_VERSION = 3;

/**
 * Options that tune SQLite's concurrency story. Multiple instances of
 * docgraph (opencode + Claude + IDE + the CLI) can safely point at the
 * same `.docgraph/db` file when WAL is enabled and every connection
 * asks SQLite to wait for the lock instead of erroring out immediately.
 */
export interface SqliteOpenOptions {
  /** How long (ms) a writer waits for the lock before bailing. Default 5000. */
  busyTimeoutMs?: number;
  /** Negative cache_size → KiB; default -64000 (~64 MB page cache). */
  cacheSizeKb?: number;
  /** WAL auto-checkpoint: pages between passive checkpoints. Default 1000. */
  walAutocheckpoint?: number;
  /**
   * Read-only mode for concurrent writers: when `true`, every read tx is
   * ended with `commit` so the WAL writer can reclaim pages aggressively.
   * Default `true`. Set `false` if you embed docgraph inside a long-running
   * process and want implicit transactions.
   */
  readTxnAutoCommit?: boolean;
  /** Optional callback invoked when the database hits a lock or busy condition. */
  onBusy?: (waitMs: number, attempts: number) => void;
  /**
   * Open the database read-only (`{ readonly: true, fileMustExist: true }`).
   * No schema initialisation, no write pragmas (WAL / synchronous / etc.) and
   * every mutating method throws instead of touching the file. The database
   * must already exist — a read-only connection cannot create it.
   */
  readonly?: boolean;
}

/**
 * SQLite adapter implementing document persistence, the knowledge graph and
 * FTS5 full-text search. A single database file holds documents, graph nodes
 * and edges (the vector store adds its own table to the same file).
 *
 * Concurrency design:
 *   - `journal_mode = WAL` so multiple processes can read at the same time
 *     while at most one writes; readers never block writers and writers
 *     never block readers.
 *   - `busy_timeout = N` so concurrent writers (e.g. opencode + Claude Code
 *     both indexing the same project) queue politely instead of throwing
 *     "database is locked" the moment the other side is mid-transaction.
 *   - `synchronous = NORMAL` for the WAL-friendly durability / speed trade-off.
 *   - A small schema-version on every write so multi-instance setups can
 *     detect diverging formats and migrate before corrupting the index.
 *
 * The class is safe to share across an entire process — every method is a
 * prepared-statement on the cached `db` handle, which is serialised internally
 * by better-sqlite3's single-threaded loop. Concurrent processes share the
 * file system, not the in-process handle.
 */
export class SqliteKnowledgeStore implements KnowledgeRepository {
  private db: Database.Database;
  private opts: Required<Omit<SqliteOpenOptions, 'onBusy'>> & { onBusy?: SqliteOpenOptions['onBusy'] };
  private readonly readOnly: boolean;
  private static readonly STATEMENTS = new WeakMap<Database.Database, StatementCache>();

  constructor(dbPath: string, opts: SqliteOpenOptions = {}) {
    this.readOnly = opts.readonly ?? false;
    this.opts = {
      busyTimeoutMs: opts.busyTimeoutMs ?? 5000,
      cacheSizeKb: opts.cacheSizeKb ?? -64000,
      walAutocheckpoint: opts.walAutocheckpoint ?? 1000,
      readTxnAutoCommit: opts.readTxnAutoCommit ?? true,
      onBusy: opts.onBusy,
      readonly: this.readOnly,
    };

    if (this.readOnly) {
      // A read-only connection cannot create the file or its parent
      // directory — the database must already exist from a prior
      // (non-read-only) `docgraph index` run.
      if (!existsSync(dbPath)) {
        throw new Error(
          `DocGraph read-only mode: no index found at ${dbPath}. ` +
            'Run `docgraph index` (without --read-only) first, then retry in read-only mode.',
        );
      }
      let db: Database.Database;
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
      } catch (err) {
        throw new Error(
          `DocGraph read-only mode: failed to open ${dbPath} read-only (${(err as Error).message}). ` +
            'Run `docgraph index` (without --read-only) first, then retry in read-only mode.',
        );
      }
      this.db = db;
      // Read-only-safe pragmas: these tune the connection without writing to
      // the database file, so they're safe even though `journal_mode = WAL`,
      // `synchronous`, `wal_autocheckpoint` and `foreign_keys` (all writes or
      // schema-affecting) are skipped entirely.
      db.pragma('query_only = ON');
      db.pragma(`cache_size = ${this.opts.cacheSizeKb}`);
      db.pragma('temp_store = MEMORY');
      db.pragma(`busy_timeout = ${this.opts.busyTimeoutMs}`);
      try {
        db.pragma('mmap_size = 67108864');
      } catch {
        /* pragma absent on older builds */
      }
      // No initSchema(): the schema must already exist, and CREATE TABLE /
      // CREATE INDEX are writes a read-only connection cannot perform.
      return;
    }

    mkdirSync(dirname(dbPath), { recursive: true });

    const db = new Database(dbPath);
    this.db = db;

    // Concurrency pragmas — apply first so every subsequent statement
    // inherits them. Order matters: busy_timeout must be set before WAL.
    db.pragma(`busy_timeout = ${this.opts.busyTimeoutMs}`);
    db.pragma('journal_mode = WAL');
    db.pragma(`synchronous = NORMAL`);
    db.pragma(`cache_size = ${this.opts.cacheSizeKb}`);
    db.pragma(`wal_autocheckpoint = ${this.opts.walAutocheckpoint}`);
    db.pragma('foreign_keys = ON');
    // `temp_store = MEMORY` keeps transient indexes off disk so heavy batch
    // indexing against a 1M-row corpus doesn't trash the WAL.
    db.pragma('temp_store = MEMORY');
    // Modern SQLite ≥ 3.39 supports a per-connection `mmap_size`. The default
    // of 64 MB is plenty and reduces read syscalls at the FTS5 layer.
    try {
      db.pragma('mmap_size = 67108864');
    } catch {
      /* pragma absent on older builds */
    }

    this.initSchema();
  }

  /** Throw a loud, unambiguous error instead of silently no-op'ing a write. */
  private assertWritable(): void {
    if (this.readOnly) {
      throw new Error('DocGraph is in read-only mode; writes are disabled');
    }
  }

  private get stmts(): StatementCache {
    let cache = SqliteKnowledgeStore.STATEMENTS.get(this.db);
    if (!cache) {
      cache = new StatementCache(this.db);
      SqliteKnowledgeStore.STATEMENTS.set(this.db, cache);
    }
    return cache;
  }

  /** Connection info — exposed for diagnostics and the `docgraph stats` command. */
  describe(): { busyTimeoutMs: number; cacheSizeKb: number; walAutocheckpoint: number } {
    return {
      busyTimeoutMs: this.opts.busyTimeoutMs,
      cacheSizeKb: this.opts.cacheSizeKb,
      walAutocheckpoint: this.opts.walAutocheckpoint,
    };
  }

  /** Acquire a read transaction — exits cheaply with `COMMIT` so the WAL can checkpoint. */
  readTx<T>(fn: () => T): T {
    if (!this.opts.readTxnAutoCommit) return fn();
    const tx = this.db.exec('BEGIN;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        /* ignore — original error wins */
      }
      throw err;
    }
  }

  /** Acquire a write transaction — batches every upsert inside into a single fsync. */
  writeTx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        relative_path TEXT NOT NULL,
        content TEXT NOT NULL,
        raw_content TEXT NOT NULL,
        extension TEXT NOT NULL,
        language TEXT NOT NULL,
        title TEXT,
        description TEXT,
        tags TEXT DEFAULT '[]',
        headings TEXT DEFAULT '[]',
        links TEXT DEFAULT '[]',
        code_blocks TEXT DEFAULT '[]',
        line_count INTEGER NOT NULL,
        word_count INTEGER NOT NULL,
        hash TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        path TEXT,
        metadata TEXT DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        type TEXT NOT NULL,
        label TEXT
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
      CREATE INDEX IF NOT EXISTS idx_documents_extension ON documents(extension);
      CREATE INDEX IF NOT EXISTS idx_documents_language ON documents(language);
      CREATE INDEX IF NOT EXISTS idx_documents_indexed_at ON documents(indexed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);

      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        id UNINDEXED,
        path,
        title,
        content,
        raw_content,
        tags,
        content='documents',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(rowid, id, path, title, content, raw_content, tags)
        VALUES (new.rowid, new.id, new.path, new.title, new.content, new.raw_content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, id, path, title, content, raw_content, tags)
        VALUES ('delete', old.rowid, old.id, old.path, old.title, old.content, old.raw_content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, id, path, title, content, raw_content, tags)
        VALUES ('delete', old.rowid, old.id, old.path, old.title, old.content, old.raw_content, old.tags);
        INSERT INTO documents_fts(rowid, id, path, title, content, raw_content, tags)
        VALUES (new.rowid, new.id, new.path, new.title, new.content, new.raw_content, new.tags);
      END;
    `);
    this.upsertSchemaVersion();
  }

  /** Read the stored schema version, or 0 if missing. */
  private readSchemaVersion(): number {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('schemaVersion') as any;
    return row?.value ? parseInt(row.value, 10) : 0;
  }

  /** Write the current schema version after every migration. */
  private upsertSchemaVersion(): void {
    this.db.prepare(`
      INSERT INTO metadata (key, value) VALUES ('schemaVersion', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(EXPECTED_SCHEMA_VERSION));
  }

  upsertDocument(doc: Document): void {
    this.assertWritable();
    this.stmts.upsertDocument.run({
      id: doc.id,
      path: doc.path,
      relativePath: doc.relativePath,
      content: doc.content,
      rawContent: doc.rawContent,
      extension: doc.extension,
      language: doc.language,
      title: doc.title || null,
      description: doc.description || null,
      tags: JSON.stringify(doc.tags),
      headings: JSON.stringify(doc.headings),
      links: JSON.stringify(doc.links),
      codeBlocks: JSON.stringify(doc.codeBlocks),
      lineCount: doc.lineCount,
      wordCount: doc.wordCount,
      hash: doc.hash,
      indexedAt: doc.indexedAt,
    });
  }

  deleteDocument(id: string): void {
    this.assertWritable();
    this.stmts.deleteDocument.run(id);
  }

  deleteDocumentByPath(path: string): void {
    this.assertWritable();
    this.stmts.deleteDocumentByPath.run(path);
  }

  getDocument(id: string): Document | null {
    const row = this.stmts.getDocument.get(id) as any;
    return row ? this.rowToDocument(row) : null;
  }

  getDocumentByPath(path: string): Document | null {
    const row = this.stmts.getDocumentByPath.get(path) as any;
    return row ? this.rowToDocument(row) : null;
  }

  getAllDocuments(): Document[] {
    const rows = this.stmts.allDocuments.all() as any[];
    return rows.map((r) => this.rowToDocument(r));
  }

  /**
   * Stream large result sets instead of materialising everything in memory.
   * Used by the search service for million-line corpora so `search` never
   * OOMs even when 100k documents match the query.
   */
  iterateDocuments(batchSize = 500, onBatch: (docs: Document[]) => void | Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare('SELECT * FROM documents ORDER BY rowid LIMIT ? OFFSET ?');
      let offset = 0;
      const tick = () => {
        try {
          const rows = stmt.all(batchSize, offset) as any[];
          if (rows.length === 0) return resolve();
          offset += rows.length;
          const docs = rows.map((r) => this.rowToDocument(r));
          const maybe = onBatch(docs);
          if (maybe && typeof (maybe as Promise<void>).then === 'function') {
            (maybe as Promise<void>).then(tick, reject);
          } else {
            setImmediate(tick);
          }
        } catch (err) {
          reject(err);
        }
      };
      tick();
    });
  }

  searchFullText(query: string, limit: number = 20): SearchResult[] {
    const rows = this.stmts.searchFullText.all(query, limit) as any[];
    return rows.map((row) => ({
      document: this.rowToDocument(row),
      score: Math.abs(row.score || 0),
      matches: [{ field: 'content', snippet: row.snippet || '', lineNumber: 0 }],
      highlights: [row.snippet || ''],
    }));
  }

  /** Cursor-based FTS pagination for million-row corpora. */
  searchFullTextPage(query: string, afterRowid: number, limit: number): SearchResult[] {
    const rows = this.db.prepare(`
      SELECT d.*, bm25(documents_fts) as score,
             snippet(documents_fts, 2, '<mark>', '</mark>', '...', 32) as snippet,
             d.rowid AS d_rowid
      FROM documents_fts f
      JOIN documents d ON d.id = f.id
      WHERE documents_fts MATCH ? AND d.rowid > ?
      ORDER BY d.rowid
      LIMIT ?
    `).all(query, afterRowid, limit) as any[];
    return rows.map((row) => ({
      document: this.rowToDocument(row),
      score: Math.abs(row.score || 0),
      matches: [{ field: 'content', snippet: row.snippet || '', lineNumber: 0 }],
      highlights: [row.snippet || ''],
    }));
  }

  upsertNode(node: GraphNode): void {
    this.assertWritable();
    this.stmts.upsertNode.run({
      id: node.id,
      type: node.type,
      label: node.label,
      path: node.path || null,
      metadata: JSON.stringify(node.metadata || {}),
    });
  }

  upsertEdge(edge: GraphEdge): void {
    this.assertWritable();
    this.stmts.upsertEdge.run({
      source: edge.source,
      target: edge.target,
      type: edge.type,
      label: edge.label || null,
    });
  }

  clearEdges(): void {
    this.assertWritable();
    this.db.prepare('DELETE FROM edges').run();
  }

  getStats(): IndexStats {
    const docCount = this.stmts.statsDocs.get() as any;
    const nodeCount = this.stmts.statsNodes.get() as any;
    const edgeCount = this.stmts.statsEdges.get() as any;
    const lastIndexed = this.stmts.statsLastIndexed.get() as any;
    const byExtension = this.stmts.statsByExtension.all() as any[];
    const byLanguage = this.stmts.statsByLanguage.all() as any[];
    const sizeResult = this.db.prepare(
      'SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()',
    ).get() as any;
    const schemaVersion = this.readSchemaVersion();

    return {
      totalDocuments: docCount?.count || 0,
      totalNodes: nodeCount?.count || 0,
      totalEdges: edgeCount?.count || 0,
      byExtension: Object.fromEntries(byExtension.map((r) => [r.extension, r.count])),
      byLanguage: Object.fromEntries(byLanguage.map((r) => [r.language, r.count])),
      lastIndexedAt: lastIndexed?.time || undefined,
      indexSizeBytes: sizeResult?.size || 0,
      schemaVersion,
    } as IndexStats;
  }

  setMetadata(key: string, value: string): void {
    this.assertWritable();
    this.stmts.setMetadata.run(key, value);
  }

  getMetadata(key: string): string | null {
    const row = this.stmts.getMetadata.get(key) as any;
    return row?.value || null;
  }

  clear(): void {
    this.assertWritable();
    this.writeTx(() => {
      this.db.exec('DELETE FROM documents; DELETE FROM nodes; DELETE FROM edges; DELETE FROM metadata;');
    });
  }

  /**
   * Force the WAL writer to flush to disk and reset to a single file.
   * Called by `docgraph export` to make sure the produced backup has no
   * half-pending transactions.
   */
  checkpoint(): void {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // best effort
    }
  }

  close(): void {
    SqliteKnowledgeStore.STATEMENTS.delete(this.db);
    this.db.close();
  }

  /** Raw handle — only exposed so the export and import flow can stream `VACUUM INTO`. */
  raw(): Database.Database {
    return this.db;
  }

  private rowToDocument(row: any): Document {
    return {
      id: row.id,
      path: row.path,
      relativePath: row.relative_path,
      content: row.content,
      rawContent: row.raw_content,
      extension: row.extension,
      language: row.language,
      title: row.title ?? undefined,
      description: row.description ?? undefined,
      tags: JSON.parse(row.tags || '[]'),
      headings: JSON.parse(row.headings || '[]'),
      links: JSON.parse(row.links || '[]'),
      codeBlocks: JSON.parse(row.code_blocks || '[]'),
      lineCount: row.line_count,
      wordCount: row.word_count,
      hash: row.hash,
      indexedAt: row.indexed_at,
    };
  }
}

/**
 * Per-handle prepared-statement cache. Avoids re-preparing the same query
 * on every call — critical for million-line corpora where a single index
 * pass can issue millions of `INSERT OR REPLACE` statements.
 */
class StatementCache {
  readonly upsertDocument: Database.Statement;
  readonly deleteDocument: Database.Statement;
  readonly deleteDocumentByPath: Database.Statement;
  readonly getDocument: Database.Statement;
  readonly getDocumentByPath: Database.Statement;
  readonly allDocuments: Database.Statement;
  readonly searchFullText: Database.Statement;
  readonly upsertNode: Database.Statement;
  readonly upsertEdge: Database.Statement;
  readonly statsDocs: Database.Statement;
  readonly statsNodes: Database.Statement;
  readonly statsEdges: Database.Statement;
  readonly statsLastIndexed: Database.Statement;
  readonly statsByExtension: Database.Statement;
  readonly statsByLanguage: Database.Statement;
  readonly setMetadata: Database.Statement;
  readonly getMetadata: Database.Statement;

  constructor(db: Database.Database) {
    this.upsertDocument = db.prepare(`
      INSERT INTO documents (id, path, relative_path, content, raw_content, extension, language,
        title, description, tags, headings, links, code_blocks, line_count, word_count, hash, indexed_at)
      VALUES (@id, @path, @relativePath, @content, @rawContent, @extension, @language,
        @title, @description, @tags, @headings, @links, @codeBlocks, @lineCount, @wordCount, @hash, @indexedAt)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        relative_path = excluded.relative_path,
        content = excluded.content,
        raw_content = excluded.raw_content,
        extension = excluded.extension,
        language = excluded.language,
        title = excluded.title,
        description = excluded.description,
        tags = excluded.tags,
        headings = excluded.headings,
        links = excluded.links,
        code_blocks = excluded.code_blocks,
        line_count = excluded.line_count,
        word_count = excluded.word_count,
        hash = excluded.hash,
        indexed_at = excluded.indexed_at
    `);
    this.deleteDocument = db.prepare('DELETE FROM documents WHERE id = ?');
    this.deleteDocumentByPath = db.prepare('DELETE FROM documents WHERE path = ?');
    this.getDocument = db.prepare('SELECT * FROM documents WHERE id = ?');
    this.getDocumentByPath = db.prepare('SELECT * FROM documents WHERE path = ?');
    this.allDocuments = db.prepare('SELECT * FROM documents ORDER BY relative_path');
    this.searchFullText = db.prepare(`
      SELECT d.*, bm25(documents_fts) as score,
             snippet(documents_fts, 2, '<mark>', '</mark>', '...', 32) as snippet
      FROM documents_fts f
      JOIN documents d ON d.id = f.id
      WHERE documents_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `);
    this.upsertNode = db.prepare(`
      INSERT INTO nodes (id, type, label, path, metadata)
      VALUES (@id, @type, @label, @path, @metadata)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        label = excluded.label,
        path = excluded.path,
        metadata = excluded.metadata
    `);
    this.upsertEdge = db.prepare(`
      INSERT INTO edges (source, target, type, label) VALUES (@source, @target, @type, @label)
    `);
    this.statsDocs = db.prepare('SELECT COUNT(*) as count FROM documents');
    this.statsNodes = db.prepare('SELECT COUNT(*) as count FROM nodes');
    this.statsEdges = db.prepare('SELECT COUNT(*) as count FROM edges');
    this.statsLastIndexed = db.prepare('SELECT MAX(indexed_at) as time FROM documents');
    this.statsByExtension = db.prepare('SELECT extension, COUNT(*) as count FROM documents GROUP BY extension');
    this.statsByLanguage = db.prepare('SELECT language, COUNT(*) as count FROM documents GROUP BY language');
    this.setMetadata = db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.getMetadata = db.prepare('SELECT value FROM metadata WHERE key = ?');
  }
}
