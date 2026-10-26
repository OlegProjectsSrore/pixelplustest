import type { KnowledgeIndex, ReferenceSnippet } from './knowledge.mjs';

export type VectorStatus = 'ok' | 'failed' | 'off';
export interface HybridResult { fragments: ReferenceSnippet[]; vectors: VectorStatus; ready: boolean }
export function excerpt(text: string, maxChars: number): string;
export function createHybridSearch(dependencies: { index: KnowledgeIndex; ai?: Ai; vectorize?: Vectorize; db: D1Database }):
  (query: string, options?: { limit?: number; maxChars?: number }) => Promise<HybridResult>;
