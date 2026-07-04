import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { VectorStore, VectorRecord, VectorSearchResult, VectorStoreStats } from '../../domain/ports.js';

/** Options that tune how the vector store opens its SQLite handle. */
export interface SqliteVectorStoreOptions {
  /**
   * Open the database read-only (`{ readonly: true, fileMustExist: true }`).
   * No schema initialisation, no `journal_mode = WAL` write pragma, and every
   * mutating method throws instead of touching the file. The database must
   * already exist — a read-only connection cannot create it.
   */
  readonly?: boolean;
}

/**
 * SQLite-backed vector store. Vectors are stored as raw little-endian float32
 * BLOBs; similarity search loads candidates and ranks them by cosine similarity.
 */
export class SqliteVectorStore implements VectorStore {
  private db: Database.Database;
  private readonly readOnly: boolean;

  constructor(dbPath: string, opts: SqliteVectorStoreOptions = {}) {
    this.readOnly = opts.readonly ?? false;

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
      try {
        this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
      } catch (err) {
        throw new Error(
          `DocGraph read-only mode: failed to open ${dbPath} read-only (${(err as Error).message}). ` +
            'Run `docgraph index` (without --read-only) first, then retry in read-only mode.',
        );
      }
      // Read-only-safe pragma only — no `journal_mode = WAL` (a write) and no
      // initSchema() (CREATE TABLE is a write the connection can't perform).
      this.db.pragma('query_only = ON');
      return;
    }

    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  /** Throw a loud, unambiguous error instead of silently no-op'ing a write. */
  private assertWritable(): void {
    if (this.readOnly) {
      throw new Error('DocGraph is in read-only mode; writes are disabled');
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        vector BLOB NOT NULL,
        metadata TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_vectors_document_id ON vectors(document_id);
      CREATE INDEX IF NOT EXISTS idx_vectors_created_at ON vectors(created_at);
    `);
  }

  async addVectors(records: VectorRecord[]): Promise<void> {
    this.assertWritable();
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO vectors (id, document_id, chunk_index, text, vector, metadata, created_at)
      VALUES (@id, @documentId, @chunkIndex, @text, @vector, @metadata, @createdAt)
    `);

    const insertMany = this.db.transaction((rows: VectorRecord[]) => {
      for (const record of rows) {
        insert.run({
          id: record.id,
          documentId: record.documentId,
          chunkIndex: record.chunkIndex,
          text: record.text,
          vector: Buffer.from(new Float32Array(record.vector).buffer),
          metadata: JSON.stringify(record.metadata || {}),
          createdAt: record.createdAt,
        });
      }
    });

    insertMany(records);
  }

  async search(query: number[], limit: number, minScore: number = 0.1): Promise<VectorSearchResult[]> {
    const rows = this.db.prepare('SELECT * FROM vectors').all() as any[];
    const results: VectorSearchResult[] = [];

    for (const row of rows) {
      const vector = this.bytesToFloat32(row.vector);
      const score = this.cosineSimilarity(query, Array.from(vector));

      if (score >= minScore) {
        results.push({
          record: {
            id: row.id,
            documentId: row.document_id,
            chunkIndex: row.chunk_index,
            text: row.text,
            vector: Array.from(vector),
            metadata: JSON.parse(row.metadata || '{}'),
            createdAt: row.created_at,
          },
          score,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async delete(documentId: string): Promise<void> {
    this.assertWritable();
    this.db.prepare('DELETE FROM vectors WHERE document_id = ?').run(documentId);
  }

  async clear(): Promise<void> {
    this.assertWritable();
    this.db.exec('DELETE FROM vectors');
  }

  getStats(): VectorStoreStats {
    const count = this.db.prepare('SELECT COUNT(*) as count FROM vectors').get() as any;
    const docCount = this.db.prepare('SELECT COUNT(DISTINCT document_id) as count FROM vectors').get() as any;
    const size = this.db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get() as any;
    const sample = this.db.prepare('SELECT vector FROM vectors LIMIT 1').get() as any;
    const dimensions = sample ? this.bytesToFloat32(sample.vector).length : 0;

    return {
      totalVectors: count?.count || 0,
      totalDocuments: docCount?.count || 0,
      dimensions,
      indexSizeBytes: size?.size || 0,
    };
  }

  close(): void {
    this.db.close();
  }

  /**
   * Reinterpret a SQLite BLOB (stored as raw little-endian float32 bytes) as a
   * Float32Array. `new Float32Array(buffer)` on a Node Buffer would copy it
   * byte-by-byte instead of reinterpreting the bytes, so we build the view
   * explicitly over the underlying ArrayBuffer.
   */
  private bytesToFloat32(buf: Buffer): Float32Array {
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }
}
