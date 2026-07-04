import { z } from 'zod';

/**
 * Domain entities and value objects.
 *
 * This module is the innermost layer: it depends on nothing else in the
 * codebase. Zod schemas double as runtime validators and as the single source
 * of truth for the inferred TypeScript types.
 */

export const HeadingSchema = z.object({
  level: z.number(),
  text: z.string(),
  anchor: z.string(),
});
export type Heading = z.infer<typeof HeadingSchema>;

export const DocumentLinkSchema = z.object({
  text: z.string(),
  url: z.string(),
  isInternal: z.boolean(),
  targetPath: z.string().optional(),
});
export type DocumentLink = z.infer<typeof DocumentLinkSchema>;

export const CodeBlockSchema = z.object({
  language: z.string(),
  content: z.string(),
  startLine: z.number(),
  endLine: z.number(),
});
export type CodeBlock = z.infer<typeof CodeBlockSchema>;

export const DocumentSchema = z.object({
  id: z.string(),
  path: z.string(),
  relativePath: z.string(),
  content: z.string(),
  rawContent: z.string(),
  extension: z.string(),
  language: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  headings: z.array(HeadingSchema).default([]),
  links: z.array(DocumentLinkSchema).default([]),
  codeBlocks: z.array(CodeBlockSchema).default([]),
  lineCount: z.number(),
  wordCount: z.number(),
  hash: z.string(),
  indexedAt: z.number(),
});
export type Document = z.infer<typeof DocumentSchema>;

export const SearchMatchSchema = z.object({
  field: z.string(),
  snippet: z.string(),
  lineNumber: z.number(),
});
export type SearchMatch = z.infer<typeof SearchMatchSchema>;

export const SearchResultSchema = z.object({
  document: DocumentSchema,
  score: z.number(),
  matches: z.array(SearchMatchSchema).default([]),
  highlights: z.array(z.string()).default([]),
  textScore: z.number().optional(),
  vectorScore: z.number().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const GraphNodeSchema = z.object({
  id: z.string(),
  type: z.enum(['document', 'heading', 'codeBlock', 'link', 'tag']),
  label: z.string(),
  path: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.enum(['contains', 'linksTo', 'references', 'imports', 'hasTag']),
  label: z.string().optional(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const IndexStatsSchema = z.object({
  totalDocuments: z.number(),
  totalNodes: z.number(),
  totalEdges: z.number(),
  byExtension: z.record(z.string(), z.number()),
  byLanguage: z.record(z.string(), z.number()),
  lastIndexedAt: z.number().optional(),
  indexSizeBytes: z.number(),
  schemaVersion: z.number().optional(),
});
export type IndexStats = z.infer<typeof IndexStatsSchema>;
