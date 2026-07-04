export interface ChunkOptions {
  chunkSize: number;
  chunkOverlap: number;
}

/**
 * Split text into overlapping, character-based chunks suitable for embedding.
 *
 * Pure domain service: `chunkSize` and `chunkOverlap` are measured in
 * characters. Overlap is clamped so the window always advances, guaranteeing
 * termination.
 */
export function chunkText(text: string, options: ChunkOptions): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) {
    return [];
  }

  const chunkSize = Math.max(1, Math.floor(options.chunkSize));
  const overlap = Math.min(Math.max(0, Math.floor(options.chunkOverlap)), chunkSize - 1);

  if (normalized.length <= chunkSize) {
    return [normalized];
  }

  const step = chunkSize - overlap;
  const chunks: string[] = [];

  for (let start = 0; start < normalized.length; start += step) {
    const chunk = normalized.slice(start, start + chunkSize).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    if (start + chunkSize >= normalized.length) {
      break;
    }
  }

  return chunks;
}
