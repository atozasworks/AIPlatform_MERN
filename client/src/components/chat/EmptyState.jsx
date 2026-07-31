import { useAuth } from '../../store/auth.js';

export default function EmptyState() {
  const user = useAuth((s) => s.user);
  const firstName = user?.name?.split(' ')[0] || 'there';

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 py-8">
      <div className="w-full max-w-3xl text-center">
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
    </div>
  );
}
