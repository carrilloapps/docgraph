import { Document, SearchResult, SearchMatch } from '../domain/entities.js';
import { DocumentRepository, VectorStore, EmbeddingProvider } from '../domain/ports.js';
import { LocalLogger, noopLogger } from '../infrastructure/logging/local-logger.js';

export interface SearchConfig {
  vectorWeight: number;
  textWeight: number;
  minScore: number;
  limit: number;
}

export interface SearchOptions {
  query: string;
  limit?: number;
  extension?: string;
  language?: string;
  tags?: string[];
  includeContent?: boolean;
  fuzzyMatch?: boolean;
  useVector?: boolean;
  useText?: boolean;
}

export interface SearchServiceDeps {
  repository: DocumentRepository;
  vectorStore?: VectorStore | null;
  embeddingProvider?: EmbeddingProvider | null;
  config: SearchConfig;
  logger?: LocalLogger;
}

const DEFAULT_CONFIG: SearchConfig = { vectorWeight: 0.7, textWeight: 0.3, minScore: 0.1, limit: 20 };

/**
 * Hybrid search use case combining SQLite FTS5 full-text results with cosine
 * vector-similarity results, merged by configurable weights.
 */
export class SearchService {
  private readonly repository: DocumentRepository;
  private readonly vectorStore: VectorStore | null;
  private readonly embeddingProvider: EmbeddingProvider | null;
  private readonly config: SearchConfig;
  private readonly logger: LocalLogger;

  constructor(deps: SearchServiceDeps) {
    this.repository = deps.repository;
    this.vectorStore = deps.vectorStore ?? null;
    this.embeddingProvider = deps.embeddingProvider ?? null;
    this.config = deps.config ?? DEFAULT_CONFIG;
    this.logger = deps.logger ?? noopLogger;
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const {
      query,
      limit = this.config.limit,
      extension,
      language,
      tags,
      includeContent = true,
      fuzzyMatch = false,
      useVector = this.vectorStore !== null && this.embeddingProvider !== null,
      useText = true,
    } = options;

    if (!query.trim()) {
      return [];
    }

    let textResults: SearchResult[] = [];
    let vectorResults: SearchResult[] = [];

    if (useText) {
      textResults = fuzzyMatch
        ? this.fuzzySearch(query, limit * 2)
        : this.repository.searchFullText(this.buildFTSQuery(query), limit * 2);
    }

    if (useVector && this.vectorStore && this.embeddingProvider) {
      try {
        const embeddingResult = await this.embeddingProvider.embed({ text: query });
        const vectors = await this.vectorStore.search(embeddingResult.embedding, limit * 2, this.config.minScore);
        vectorResults = vectors
          .map((v) => {
            const document = this.repository.getDocument(v.record.documentId);
            if (!document) return null;
            return {
              document,
              score: v.score,
              matches: [{ field: 'chunk', snippet: v.record.text.slice(0, 200), lineNumber: 0 }],
              highlights: [v.record.text.slice(0, 200)],
            } satisfies SearchResult;
          })
          .filter((r): r is SearchResult => r !== null);
      } catch (error) {
        this.logger.logError(error, { component: 'search', operation: 'vector_search' });
      }
    }

    let combined = this.mergeResults(textResults, vectorResults);

    if (extension) combined = combined.filter((r) => r.document.extension === extension);
    if (language) combined = combined.filter((r) => r.document.language === language);
    if (tags && tags.length > 0) {
      combined = combined.filter((r) => tags.some((tag) => r.document.tags.includes(tag)));
    }

    combined = combined.slice(0, limit);

    if (includeContent) {
      for (const result of combined) {
        result.matches = this.findMatches(result.document, query);
        result.highlights = result.matches.map((m) => m.snippet);
      }
    }

    return combined;
  }

  async explore(topic: string, limit: number = 10): Promise<SearchResult[]> {
    const results = await this.search({ query: topic, limit: limit * 2, includeContent: true });
    const documentResults = results.slice(0, limit);

    for (const result of documentResults) {
      const headings = result.document.headings;
      if (headings.length > 0) {
        result.matches.push(
          ...headings.slice(0, 5).map((h) => ({ field: 'heading', snippet: h.text, lineNumber: 0 })),
        );
      }
      result.matches.push(
        ...result.document.codeBlocks.slice(0, 3).map((cb) => ({
          field: 'codeBlock',
          snippet: `\`\`\`${cb.language}\n${cb.content.slice(0, 200)}${cb.content.length > 200 ? '...' : ''}\n\`\`\``,
          lineNumber: cb.startLine,
        })),
      );
    }

    return documentResults;
  }

  async getRelated(documentId: string, limit: number = 10): Promise<SearchResult[]> {
    const doc = this.repository.getDocument(documentId);
    if (!doc) return [];

    const results: SearchResult[] = [];

    for (const tag of doc.tags) {
      results.push(...(await this.search({ query: tag, limit, tags: [tag] })));
    }

    for (const link of doc.links.slice(0, 5)) {
      if (link.targetPath) {
        const linkedDoc = this.repository.getDocumentByPath(link.targetPath);
        if (linkedDoc) {
          results.push({ document: linkedDoc, score: 0.8, matches: [], highlights: [] });
        }
      }
    }

    results.push(...(await this.search({ query: doc.title || doc.description || '', limit })));

    const unique = new Map<string, SearchResult>();
    for (const r of results) {
      if (r.document.id !== documentId && !unique.has(r.document.id)) {
        unique.set(r.document.id, r);
      }
    }

    return Array.from(unique.values()).slice(0, limit);
  }

  private mergeResults(textResults: SearchResult[], vectorResults: SearchResult[]): SearchResult[] {
    if (vectorResults.length === 0) return this.normalizeScores(textResults);
    if (textResults.length === 0) return this.normalizeScores(vectorResults);

    const { textWeight, vectorWeight } = this.config;
    const maxTextScore = Math.max(...textResults.map((r) => r.score), 1);
    const maxVectorScore = Math.max(...vectorResults.map((r) => r.score), 1);
    const scoreMap = new Map<string, SearchResult>();

    for (const result of textResults) {
      const normalizedScore = (result.score / maxTextScore) * textWeight;
      scoreMap.set(result.document.id, { ...result, score: normalizedScore, textScore: normalizedScore, vectorScore: 0 });
    }

    for (const result of vectorResults) {
      const normalizedScore = (result.score / maxVectorScore) * vectorWeight;
      const existing = scoreMap.get(result.document.id);
      if (existing) {
        existing.score += normalizedScore;
        existing.vectorScore = normalizedScore;
      } else {
        scoreMap.set(result.document.id, { ...result, score: normalizedScore, textScore: 0, vectorScore: normalizedScore });
      }
    }

    return Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);
  }

  /** Scale a single-source result set to [0, 1] so the top hit reads as 100%. */
  private normalizeScores(results: SearchResult[]): SearchResult[] {
    if (results.length === 0) return results;
    const max = Math.max(...results.map((r) => r.score), Number.EPSILON);
    return results.map((r) => ({ ...r, score: r.score / max })).sort((a, b) => b.score - a.score);
  }

  private buildFTSQuery(query: string): string {
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 1) {
      return `"${terms[0]}"*`;
    }
    return terms.map((t) => `"${t}"*`).join(' OR ');
  }

  private fuzzySearch(query: string, limit: number): SearchResult[] {
    const docs = this.repository.getAllDocuments();
    const results: SearchResult[] = [];
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);

    for (const doc of docs) {
      let score = 0;
      const matches: SearchMatch[] = [];

      if (doc.title?.toLowerCase().includes(queryLower)) {
        score += 100;
        matches.push({ field: 'title', snippet: doc.title, lineNumber: 0 });
      }
      if (doc.description?.toLowerCase().includes(queryLower)) {
        score += 50;
        matches.push({ field: 'description', snippet: doc.description, lineNumber: 0 });
      }

      const contentLower = doc.content.toLowerCase();
      for (const term of queryTerms) {
        if (contentLower.includes(term)) {
          score += 10;
          matches.push(this.snippetAround(doc, contentLower.indexOf(term), term.length));
        }
      }

      for (const tag of doc.tags) {
        if (tag.toLowerCase().includes(queryLower)) score += 30;
      }

      for (const heading of doc.headings) {
        if (heading.text.toLowerCase().includes(queryLower)) {
          score += 40;
          matches.push({ field: 'heading', snippet: heading.text, lineNumber: 0 });
        }
      }

      if (score > 0) {
        results.push({ document: doc, score, matches, highlights: matches.map((m) => m.snippet) });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Cap on snippets returned per document so a common term can't produce hundreds. */
  private static readonly MAX_MATCHES = 6;

  private findMatches(doc: Document, query: string): SearchMatch[] {
    const matches: SearchMatch[] = [];
    const contentLower = doc.content.toLowerCase();
    const queryLower = query.toLowerCase();

    for (const term of queryLower.split(/\s+/).filter(Boolean)) {
      let index = contentLower.indexOf(term);
      while (index !== -1 && matches.length < SearchService.MAX_MATCHES) {
        matches.push(this.snippetAround(doc, index, term.length));
        index = contentLower.indexOf(term, index + 1);
      }
      if (matches.length >= SearchService.MAX_MATCHES) break;
    }

    if (doc.title?.toLowerCase().includes(queryLower)) {
      matches.push({ field: 'title', snippet: doc.title, lineNumber: 0 });
    }
    if (doc.description?.toLowerCase().includes(queryLower)) {
      matches.push({ field: 'description', snippet: doc.description, lineNumber: 0 });
    }

    return matches;
  }

  private snippetAround(doc: Document, index: number, termLength: number): SearchMatch {
    const start = Math.max(0, index - 50);
    const end = Math.min(doc.content.length, index + termLength + 50);
    const snippet =
      (start > 0 ? '...' : '') + doc.content.slice(start, end) + (end < doc.content.length ? '...' : '');
    return { field: 'content', snippet, lineNumber: doc.content.slice(0, index).split('\n').length };
  }
}
