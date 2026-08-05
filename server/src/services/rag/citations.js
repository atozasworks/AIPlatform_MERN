/**
 * Citation extraction and verification.
 *
 * The model is told to cite as [S1], [S2] using only the labels it was given,
 * but instruction-following is not a guarantee. Everything here treats the
 * generated text as untrusted: a citation is emitted to the user only when its
 * label maps to a source that was actually retrieved for this request.
 *
 * This is what makes "citations always map to real retrieved records" a
 * property of the system rather than a hope about the model's behaviour.
 */

const LABEL_RE = /\[(S\d{1,2})\]/g;

/**
 * Returns the citations the answer genuinely used, in order of first mention.
 *
 * @param {string} text     Generated answer
 * @param {Array}  sources  Sources supplied to this generation
 * @returns {{ citations: Array, invalidLabels: string[] }}
 */
export function extractCitations(text, sources = []) {
  const byLabel = new Map(sources.map((s) => [s.label, s]));
  const seen = new Set();
  const citations = [];
  const invalidLabels = [];

  for (const match of String(text || '').matchAll(LABEL_RE)) {
    const label = match[1];
    if (seen.has(label)) continue;
    seen.add(label);

    const source = byLabel.get(label);
    if (!source) {
      // The model invented a label. It is dropped, never rendered.
      invalidLabels.push(label);
      continue;
    }

    citations.push({
      label: source.label,
      documentId: source.documentId,
      chunkId: source.chunkId,
      title: source.documentTitle,
      heading: source.heading,
      sourceUri: source.sourceUri,
      sourceType: source.sourceType,
      chunkIndex: source.chunkIndex,
      score: source.score,
      // Provenance for live sources. Null on curated uploads, which are
      // versioned by re-import rather than by date.
      siteName: source.siteName || null,
      publishedAt: source.publishedAt || null,
      retrievedAt: source.retrievedAt || null,
    });
  }

  return { citations, invalidLabels };
}

/**
 * Removes citation markers that point at nothing, so the reader never sees a
 * reference they cannot follow.
 */
export function stripInvalidCitations(text, invalidLabels = []) {
  if (!invalidLabels.length) return text;
  const pattern = new RegExp(`\\[(?:${invalidLabels.join('|')})\\]`, 'g');
  return String(text).replace(pattern, '').replace(/[ \t]{2,}/g, ' ');
}

/**
 * Compact descriptor persisted on the message and sent over SSE.
 *
 * `retrievedAt` is included for web sources and is not cosmetic: an answer about
 * a fast-moving topic is only as good as the moment it was read, and a reader
 * who cannot see that moment has no way to judge whether to re-check. It is
 * stored on the message so the date shown next to an old answer stays the date
 * that answer was actually based on.
 */
export function toClientCitation(citation) {
  return {
    label: citation.label,
    title: citation.title,
    heading: citation.heading || null,
    sourceUri: citation.sourceUri || null,
    sourceType: citation.sourceType,
    documentId: citation.documentId,
    chunkIndex: citation.chunkIndex,
    siteName: citation.siteName || null,
    publishedAt: citation.publishedAt || null,
    retrievedAt: citation.retrievedAt || null,
  };
}

export default { extractCitations, stripInvalidCitations, toClientCitation };
