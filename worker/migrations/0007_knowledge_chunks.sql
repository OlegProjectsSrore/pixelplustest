-- Texts of the services knowledge base chunks for hybrid search. The BM25 index and Vectorize hold only chunk IDs;
-- the texts do not fit the Workers Free bundle. knowledge-base/search/load-d1.mjs fills both tables.
CREATE TABLE kb_chunks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  heading TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
-- corpus: hash of the knowledge base the rows were loaded from; search runs only when it matches the bundled index.
CREATE TABLE kb_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
