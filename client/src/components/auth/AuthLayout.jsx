import ThemeToggle from '../ui/ThemeToggle.jsx';

export default function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md animate-fade-in">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-2xl font-bold text-white">
            A
          </div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-slate-500">{subtitle}</p>}
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          {children}
        </div>
        <p className="mt-6 text-center text-xs text-slate-400">
          AiChat orchestrates official AI provider APIs. Responses may be inaccurate — verify
          important information.
        </p>
      </div>
    </div>
  );
}
