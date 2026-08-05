/**
 * Passage reranking for live web retrieval.
 *
 * A fetched article is far too long to quote whole, so something has to choose
 * which paragraphs go in front of the model. The obvious answer is the embedding
 * model already deployed for document RAG. It was measured, and it is not viable
 * here.
 *
 * Measured on the ATOZAS CPU box against `llama-server` serving
 * Qwen3-Embedding-0.6B, with distinct text per passage (an earlier measurement
 * using repeated text was meaningless — llama.cpp's prompt cache made it look
 * 15x faster than it is):
 *
 *   |  1 passage  |   5.3 s  |
 *   |  8 passages |  44.7 s  |
 *   | 16 passages |  timeout at 60 s |
 *
 * That is roughly 5.5 seconds per passage. Reranking even four would cost more
 * than the entire 20-second retrieval budget, before the model generates a single
 * token. Document ingest can absorb that cost because it runs asynchronously;
 * query-time reranking cannot.
 *
 * So the default is lexical: BM25-style scoring, which runs in microseconds. The
 * loss is real but narrower than it first appears, because the semantic matching
 * has already happened — the search engine did it when it ranked the page for the
 * query. What is left is a within-document choice between paragraphs of one
 * article, which term overlap handles well.
 *
 * `WEB_RERANK_MODE=embedding` switches to the embedding path for deployments with
 * a GPU or a dedicated embedding host, where the measurement above does not
 * apply. It is not the default because the default has to work on the hardware
 * ATOZAS actually runs.
 */

/**
 * Terms carrying no retrieval signal. Removing them matters more than usual
 * here: with only a few dozen passages, collection IDF is too noisy to push a
 * term like "the" down on its own.
 */
const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'can', 'did', 'do', 'does', 'for', 'from', 'get', 'had', 'has', 'have', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on',
  'or', 'our', 'out', 'so', 'than', 'that', 'the', 'their', 'them', 'then',
  'there', 'these', 'they', 'this', 'to', 'up', 'us', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

/** BM25 term-frequency saturation and length-normalization constants. */
const K1 = 1.2;
const B = 0.75;

/**
 * Splits text into scoring terms.
 *
 * Digits are kept because version numbers, years and prices are exactly the
 * tokens that make a time-sensitive answer correct — dropping them would blind
 * the scorer to "26.5.1" and "2026".
 */
export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .map((term) => term.replace(/^\.+|\.+$/g, ''))
    .filter((term) => term.length >= 2 && term.length <= 40 && !STOPWORDS.has(term));
}

/**
 * Scores passages against a query, returning values in [0, 1).
 *
 * The score is **query coverage**: the share of the query's information content,
 * weighted by term rarity, that a passage actually contains. That is deliberately
 * chosen over a raw BM25 sum, which is unbounded and therefore impossible to put
 * a meaningful threshold on — `WEB_MIN_SCORE=0.45` reads as "covers at least 45%
 * of the query's distinctive terms", which an operator can reason about.
 *
 * Order is preserved for equal scores, so the search engine's own ranking acts as
 * the tie-breaker without needing to be mixed into the score.
 *
 * @param {string} query
 * @param {Array<{ text: string }>} passages
 * @returns {number[]} One score per passage, in input order.
 */
export function scoreByLexicalOverlap(query, passages) {
  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length || !passages.length) return passages.map(() => 0);

  const tokenized = passages.map((p) => tokenize(p.text));
  const lengths = tokenized.map((terms) => terms.length);
  const avgLength = lengths.reduce((sum, n) => sum + n, 0) / lengths.length || 1;

  const counts = tokenized.map((terms) => {
    const map = new Map();
    for (const term of terms) map.set(term, (map.get(term) || 0) + 1);
    return map;
  });

  // Document frequency across the fetched set, for IDF.
  const df = new Map();
  for (const term of queryTerms) {
    df.set(term, counts.reduce((n, map) => n + (map.has(term) ? 1 : 0), 0));
  }

  const n = passages.length;
  const idf = new Map(
    queryTerms.map((term) => {
      const docFreq = df.get(term);
      // Standard BM25 IDF, floored at zero. A term present in every passage
      // discriminates nothing, and a negative weight would reward passages for
      // omitting a query term.
      return [term, Math.max(0, Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5)))];
    }),
  );

  const totalIdf = queryTerms.reduce((sum, term) => sum + idf.get(term), 0);
  // Every query term appears in every passage, so nothing distinguishes them.
  if (totalIdf === 0) return passages.map(() => 0);

  return passages.map((_, i) => {
    // Length normalization: a long passage that mentions a term once is a weaker
    // match than a short one that does, which is what stops a page's whole body
    // outranking the paragraph that answers the question.
    const norm = K1 * (1 - B + (B * lengths[i]) / avgLength);

    let matched = 0;
    for (const term of queryTerms) {
      const tf = counts[i].get(term) || 0;
      if (!tf) continue;
      // tf/(tf+norm) stays within [0,1), unlike BM25's (k1+1) numerator, which
      // is what keeps the final ratio a true coverage fraction.
      matched += idf.get(term) * (tf / (tf + norm));
    }

    return matched / totalIdf;
  });
}

export default scoreByLexicalOverlap;
