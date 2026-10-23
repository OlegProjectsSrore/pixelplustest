export interface ReferenceApproval { corpus: string; chunk_ids: string[] }
export interface ReferenceSnippet { id: string; title: string; heading: string; url: string; text: string }
export interface KnowledgeIndex {
  corpus: string;
  docs: [id: string, path: string, url: string, title: string, kind: string, section: string, length: number][];
  chunks: [id: string, doc: number, heading: string, h2: string, start: number, end: number][];
  lexical: { k1: number; b: number; avg: number; lengths: number[]; postings: Record<string, number[]> };
}
export function createKnowledgeSearch(dependencies: { index: KnowledgeIndex; readDocument(path: string): string | Promise<string> }): (query: string, approval: ReferenceApproval) => Promise<ReferenceSnippet[]>;
