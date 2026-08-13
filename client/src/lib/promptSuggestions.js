/**
 * ChatGPT-style empty-chat greetings. `{name}` is replaced with the user's
 * first name when present. One is picked at random on each new empty chat /
 * page refresh.
 */
/** Keep these short so they stay on one line at the empty-chat heading size. */
export const GREETING_POOL = [
  'How can I help you today?',
  "What's on the agenda today?",
  'Hey, {name}. Ready to dive in?',
  'Ready when you are.',
  'Ask me anything.',
  "What's on your mind?",
  'Hey {name} — how can I help?',
  'What can I help you with?',
  'Shall we get started?',
  'Tell me what you need.',
  'Need a hand with something?',
  'What should we tackle first?',
];

/** Pick one greeting string for the given first name. */
export function pickRandomGreeting(firstName = 'there') {
  const name = String(firstName || 'there').trim() || 'there';
  const template = GREETING_POOL[Math.floor(Math.random() * GREETING_POOL.length)];
  return template.replaceAll('{name}', name);
}

export function welcomeSeenKey(userId) {
  return `atozas:seenWelcome:${userId}`;
}

export function hasSeenWelcome(userId) {
  if (!userId) return false;
  try {
    return localStorage.getItem(welcomeSeenKey(userId)) === '1';
  } catch {
    return false;
  }
}

export function markWelcomeSeen(userId) {
  if (!userId) return;
  try {
    localStorage.setItem(welcomeSeenKey(userId), '1');
  } catch {
    /* ignore quota / private mode */
  }
}

/** True until the account has sent a real chat (or has a titled conversation). */
export function isFirstTimeUser(userId, conversations = []) {
  if (!userId) return true;
  const hasRealHistory = conversations.some(
    (c) => String(c.title || '').trim() && String(c.title).trim() !== 'New chat',
  );
  if (hasRealHistory) return false;
  return !hasSeenWelcome(userId);
}
