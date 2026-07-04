import { Document, IndexStats } from '../domain/entities.js';
import { DocumentRepository } from '../domain/ports.js';
import { LocalLogger, noopLogger } from '../infrastructure/logging/local-logger.js';

export interface ListOptions {
  extension?: string;
  language?: string;
  limit?: number;
}

export interface DocumentGraph {
  nodes: Array<{ id: string; type: string; label: string }>;
  edges: Array<{ source: string; target: string; type: string; label?: string }>;
}

/** Read-only queries over the indexed knowledge base. */
export class QueryService {
  private readonly logger: LocalLogger;

  constructor(private readonly repository: DocumentRepository, logger?: LocalLogger) {
    this.logger = logger ?? noopLogger;
  }

  getDocument(id: string): Document | null {
    return this.repository.getDocument(id);
  }

  getDocumentByPath(path: string): Document | null {
    return this.repository.getDocumentByPath(path);
  }

  listDocuments(options: ListOptions = {}): Document[] {
    let docs = this.repository.getAllDocuments();
    if (options.extension) docs = docs.filter((d) => d.extension === options.extension);
    if (options.language) docs = docs.filter((d) => d.language === options.language);
    if (options.limit !== undefined) docs = docs.slice(0, options.limit);
    return docs;
  }

  getStats(): IndexStats {
    return this.repository.getStats();
  }

  getDocumentGraph(documentId: string): DocumentGraph | null {
    const doc = this.repository.getDocument(documentId);
    if (!doc) return null;

    const nodes: DocumentGraph['nodes'] = [
      { id: doc.id, type: 'document', label: doc.title || doc.relativePath },
      ...doc.headings.map((h, i) => ({ id: `${doc.id}#heading-${i}`, type: 'heading', label: h.text })),
      ...doc.tags.map((tag) => ({ id: `tag:${tag}`, type: 'tag', label: tag })),
    ];

    const edges: DocumentGraph['edges'] = [
      ...doc.headings.map((_, i) => ({ source: doc.id, target: `${doc.id}#heading-${i}`, type: 'contains' })),
      ...doc.tags.map((tag) => ({ source: doc.id, target: `tag:${tag}`, type: 'hasTag' })),
      ...doc.links
        .filter((l) => l.isInternal)
        .map((l) => ({ source: doc.id, target: l.targetPath || '', type: 'linksTo', label: l.text })),
    ];

    return { nodes, edges };
  }
}
