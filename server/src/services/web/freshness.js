/**
 * Decides whether a question needs live web retrieval.
 *
 * This is a deterministic classifier, not a model call, and that is the central
 * design decision here. Asking the 4B model "does this need current
 * information?" before every message would double the number of generations on
 * a CPU-only box — the router would cost roughly as much wall-clock time as the
 * answer itself, for a judgement that keyword evidence gets right most of the
 * time. It is also non-deterministic, so an identical question could route
 * differently on consecutive turns and produce inconsistent answers.
 *
 * The trade-off accepted: recall is imperfect. A question phrased without any
 * temporal cue ("who runs the Department of Transport") will be answered from
 * training data. Two things limit the damage: the system prompt requires the
 * model to state when a fact may be out of date, and any question that does
 * carry a cue gets real sources with dates attached.
 *
 * Tuning bias: false positives are cheap and false negatives are not. Searching
 * for a question that did not need it wastes a few seconds and yields sources
 * the model can ignore; failing to search a question that needed it produces a
 * confidently stale answer, which is the failure mode this whole feature exists
 * to prevent.
 */

/** Explicit requests for up-to-date information. Strongest signal available. */
const RECENCY_TERMS = [
  'latest',
  'newest',
  'current',
  'currently',
  // Bare "now" is included knowingly. It appears as filler ("now, explain X"),
  // which costs an unnecessary search, but it is also the word people use to
  // pin a question to the present ("how does that compare to now"). Under this
  // module's stated bias, the wasted search is the cheaper error. It subsumes
  // "right now" and "as of now", which are therefore not listed separately.
  'now',
  'as of today',
  'up to date',
  'up-to-date',
  'today',
  'tonight',
  'yesterday',
  'this week',
  'this month',
  'this year',
  'last week',
  'last month',
  'recent',
  'recently',
  'just announced',
  'breaking',
  'so far',
  'nowadays',
  'these days',
  'at the moment',
];

/**
 * Domains whose correct answer changes on a timescale shorter than a model's
 * release cycle. Each of these is a category where a stale answer is not merely
 * imprecise but actively wrong.
 */
const VOLATILE_TERMS = [
  // Software state
  'latest version',
  'current version',
  'release notes',
  'changelog',
  'deprecated',
  'end of life',
  'eol',
  'security advisory',
  'cve',
  'patch',
  'vulnerability',
  // Markets and money
  'price',
  'pricing',
  'cost of',
  'how much does',
  'exchange rate',
  'stock',
  'share price',
  'market cap',
  'interest rate',
  'inflation',
  'tariff',
  'salary',
  // News and events
  'news',
  'headline',
  'election',
  'won the',
  'winner',
  'score',
  'fixture',
  'schedule',
  'weather',
  'forecast',
  'outage',
  'strike',
  'died',
  'resigned',
  'appointed',
  'acquired',
  'merger',
  'launch',
  'released',
  // Rules and law
  'law',
  'legislation',
  'regulation',
  'compliance deadline',
  'tax rate',
  'visa',
  'policy change',
  // Roles, which turn over
  'who is the',
  'who are the',
  'ceo of',
  'president of',
  'prime minister of',
];

/** Phrasings that ask about a state of affairs rather than a concept. */
const STATE_PATTERNS = [
  /\bis\s+\w+\s+(still|already|now)\b/,
  /\bhas\s+\w+\s+(been|released|launched|shipped)\b/,
  /\bwhat('s|\s+is)\s+(new|happening|going on)\b/,
  /\bany\s+(update|news)\b/,
  /\bhow\s+many\s+.*\b(now|currently|today)\b/,
];

/**
 * Questions that are explicitly about the past are the clearest case for *not*
 * searching: the answer is settled, and training data covers it as well as a
 * search would. Kept narrow so it cannot swallow genuine current-events asks.
 */
const HISTORICAL_PATTERNS = [
  /\bhistory of\b/,
  /\bwho invented\b/,
  /\bwho discovered\b/,
  /\borigin of\b/,
  /\betymology\b/,
  /\bback (then|in the day)\b/,
];

/**
 * Plausible four-digit years, 1800–2099.
 *
 * Deliberately not `\d{4}`: a bare number like 1500 is far more often a price or
 * a quantity than a year, and misreading one as a date would suppress a search
 * that should have happened.
 */
const YEAR_RE = /\b(1[89]\d{2}|20\d{2})\b/g;

/**
 * Timeless questions. Retrieval adds latency and noise without adding accuracy,
 * because the answer has not changed and will not.
 */
const CONCEPTUAL_PATTERNS = [
  /\b(what|explain)\s+(is|are)\s+(a|an|the)?\s*(difference|concept|meaning|definition|purpose)\b/,
  /\bhow\s+does\s+\w+\s+work\b/,
  /\bwhy\s+(is|are|does|do)\b/,
  /\bwrite\s+(a|an|some)?\s*(code|function|script|program|query|test)\b/,
  /\brefactor\b/,
  /\bdebug\b/,
  /\btranslate\b/,
  /\bsummari[sz]e\b/,
  /\bproofread\b/,
  /\brewrite\b/,
];

/** A four-digit year at or after this is treated as a live-information cue. */
const CURRENT_YEAR = new Date().getFullYear();

/**
 * @typedef {object} FreshnessVerdict
 * @property {boolean} needsWeb  Whether to run live retrieval.
 * @property {string}  reason    Machine-readable cause, for logs and metrics.
 * @property {number}  confidence 0..1, for observability only.
 * @property {string[]} matched  The cues that fired, for debugging a misroute.
 * @property {boolean} newsBiased Whether to include SearXNG's news category.
 */

/**
 * Classifies a question.
 *
 * @param {string} question
 * @returns {FreshnessVerdict}
 */
export function assessFreshness(question) {
  const text = String(question || '')
    .toLowerCase()
    .trim();

  if (text.length < 8) {
    return verdict(false, 'too_short', 0, []);
  }

  const matched = [];

  const years = [...text.matchAll(YEAR_RE)].map((m) => Number(m[1]));
  // A year at or beyond the current one is an unambiguous ask about now, and it
  // outranks the conceptual patterns below: "how does the 2026 tax band work"
  // is a how-does-it-work question whose answer changes yearly.
  const currentYear = years.find((y) => y >= CURRENT_YEAR);
  if (currentYear) matched.push(`year:${currentYear}`);

  for (const term of RECENCY_TERMS) {
    if (containsPhrase(text, term)) matched.push(`recency:${term}`);
  }
  for (const term of VOLATILE_TERMS) {
    if (containsPhrase(text, term)) matched.push(`volatile:${term}`);
  }
  for (const pattern of STATE_PATTERNS) {
    if (pattern.test(text)) matched.push(`state:${pattern.source}`);
  }

  // A question pinned to a past year is asking about a settled state of affairs,
  // however volatile the topic: "the 1929 stock market crash" and "Q3 2019
  // revenue" are history, not news. Suppressed only when nothing points at the
  // present — "stock prices in 2019 versus now" is a live comparison.
  const pastYear = years.find((y) => y < CURRENT_YEAR);
  const pointsAtPresent =
    Boolean(currentYear) || matched.some((m) => m.startsWith('recency:') || m.startsWith('state:'));
  const isHistorical =
    HISTORICAL_PATTERNS.some((p) => p.test(text)) || (Boolean(pastYear) && !pointsAtPresent);

  if (matched.length) {
    // A settled question can still contain a volatile keyword ("history of
    // interest rates"), so the historical check runs last and wins.
    if (!currentYear && isHistorical) {
      return verdict(false, 'historical', 0.7, matched);
    }
    const confidence = Math.min(1, 0.55 + matched.length * 0.15);
    return verdict(true, 'temporal_cue', confidence, matched, isNewsLike(matched));
  }

  if (isHistorical) {
    return verdict(false, 'historical', 0.8, matched);
  }
  if (CONCEPTUAL_PATTERNS.some((p) => p.test(text))) {
    return verdict(false, 'conceptual', 0.8, matched);
  }

  // No signal either way. Answering from the model is the cheaper default, and
  // the prompt requires it to flag anything that may have changed since
  // training rather than asserting it as current.
  return verdict(false, 'no_signal', 0.4, matched);
}

function isNewsLike(matched) {
  return matched.some((m) =>
    /news|headline|election|breaking|today|tonight|yesterday|score|died|resigned|appointed|acquired|outage/.test(
      m,
    ),
  );
}

function verdict(needsWeb, reason, confidence, matched, newsBiased = false) {
  return { needsWeb, reason, confidence, matched, newsBiased };
}

/**
 * Word-boundary containment.
 *
 * Plain `includes()` is wrong here: "patch" would match "dispatch" and "eol"
 * would match "geological", both of which would silently route unrelated
 * questions to a web search.
 */
function containsPhrase(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text);
}

/**
 * Turns a conversational question into a search query.
 *
 * Search engines match documents, not dialogue: filler words and politeness
 * dilute the term set that upstream engines rank on. The current year is
 * appended for recency-flavoured questions because most engines treat it as a
 * strong freshness hint, which is cheaper than relying on a time-range filter
 * that not every SearXNG engine supports.
 */
export function buildSearchQuery(question, verdictInfo) {
  const cleaned = String(question || '')
    .replace(/\s+/g, ' ')
    .replace(/^(hi|hey|hello|please|could you|can you|would you|i want to know|tell me)\b[\s,]*/gi, '')
    .replace(/[?!]+$/g, '')
    .trim();

  const query = cleaned.slice(0, 300);

  const mentionsYear = /\b20[2-9]\d\b/.test(query);
  const wantsNow = verdictInfo?.matched?.some((m) => m.startsWith('recency:'));

  return wantsNow && !mentionsYear ? `${query} ${CURRENT_YEAR}` : query;
}

export default assessFreshness;
