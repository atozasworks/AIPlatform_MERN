import { useTheme } from '../../context/ThemeContext.jsx';

const SunIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);

const MoonIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
  </svg>
);

const OPTIONS = [
  { value: 'light', label: 'Light theme', Icon: SunIcon },
  { value: 'dark', label: 'Dark theme', Icon: MoonIcon },
];

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const isDark = document.documentElement.classList.contains('dark');
  const active = theme === 'system' ? (isDark ? 'dark' : 'light') : theme;

  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-900">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => setTheme(value)}
          title={label}
          aria-label={label}
          aria-pressed={active === value}
          className={`flex h-8 w-8 items-center justify-center rounded-full transition ${
            active === value
              ? 'bg-gradient-to-br from-blue-600 to-violet-600 text-white shadow-sm'
              : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}
