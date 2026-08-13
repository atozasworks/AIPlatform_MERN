import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../store/auth.js';
import { useChat } from '../../store/chat.js';
import {
  hasSeenWelcome,
  isFirstTimeUser,
  markWelcomeSeen,
  pickRandomGreeting,
} from '../../lib/promptSuggestions.js';

/**
 * Empty chat canvas.
 * - First-time: full welcome (logo + hello + subtitle). Composer is centered by ChatPage.
 * - Returning: one random ChatGPT-style greeting; changes on refresh / new empty chat.
 */
export default function EmptyState({ variant = 'auto' }) {
  const user = useAuth((s) => s.user);
  const conversations = useChat((s) => s.conversations);
  const firstName = user?.name?.split(' ')[0] || 'there';
  const userId = user?.id || user?._id;

  const [isFirstTime, setIsFirstTime] = useState(() =>
    variant === 'first' ? true : variant === 'returning' ? false : isFirstTimeUser(userId, conversations),
  );

  useEffect(() => {
    if (variant === 'first') {
      setIsFirstTime(true);
      return;
    }
    if (variant === 'returning') {
      setIsFirstTime(false);
      return;
    }
    if (!userId) return;
    const first = isFirstTimeUser(userId, conversations);
    if (!first && !hasSeenWelcome(userId)) {
      markWelcomeSeen(userId);
    }
    setIsFirstTime(first);
  }, [userId, conversations, variant]);

  const greeting = useMemo(
    () => pickRandomGreeting(firstName),
    // New greeting each time this empty view mounts (refresh / new chat).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional remount roll
    [],
  );

  if (isFirstTime) {
    return (
      <div className="w-full max-w-3xl px-4 pb-6 text-center">
        <img
          src="/logo.png"
          alt="AtozasAi"
          className="mx-auto mb-5 h-20 w-20 rounded-full object-cover shadow-sm ring-1 ring-slate-200 dark:ring-slate-700"
        />
        <h1 className="text-3xl font-bold tracking-tight">
          Hello,{' '}
          <span className="bg-gradient-to-r from-blue-600 to-violet-600 bg-clip-text text-transparent">
            {firstName}
          </span>
          ! <span className="align-middle">👋</span>
        </h1>
        <p className="mt-3 text-lg font-medium text-slate-600 dark:text-slate-300">
          How can I help you today?
        </p>
        <p className="mt-1 text-sm text-slate-400">
          Ask me anything, I&apos;m here to help you with answers, ideas, and more.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-3xl px-4 pb-5 text-center">
      <h1 className="whitespace-nowrap text-xl font-semibold tracking-tight text-slate-800 dark:text-slate-100 sm:text-2xl">
        {greeting}
      </h1>
    </div>
  );
}
