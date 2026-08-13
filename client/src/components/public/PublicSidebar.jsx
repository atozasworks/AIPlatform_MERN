import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePublicChat } from '../../store/publicChat.js';
import { relativeTime } from '../../lib/time.js';
import ShareLinkModal from '../ui/ShareLinkModal.jsx';

export default function PublicSidebar({ open, onClose, onCollapse }) {
  const sessions = usePublicChat((s) => s.sessions);
  const activeId = usePublicChat((s) => s.activeId);
  const searchQuery = usePublicChat((s) => s.searchQuery);
  const setSearchQuery = usePublicChat((s) => s.setSearchQuery);
  const showArchived = usePublicChat((s) => s.showArchived);
  const setShowArchived = usePublicChat((s) => s.setShowArchived);
  const loadSessions = usePublicChat((s) => s.loadSessions);
  const newSession = usePublicChat((s) => s.newSession);
  const openSession = usePublicChat((s) => s.openSession);
  const updateSession = usePublicChat((s) => s.updateSession);
  const shareSession = usePublicChat((s) => s.shareSession);
  const deleteSession = usePublicChat((s) => s.deleteSession);

  const [localQuery, setLocalQuery] = useState(searchQuery || '');
  const [menuId, setMenuId] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [shareNotice, setShareNotice] = useState(null);
  const [shareUrl, setShareUrl] = useState(null);
  const menuRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearchQuery(localQuery);
      loadSessions(localQuery);
    }, 250);
    return () => clearTimeout(t);
  }, [localQuery, setSearchQuery, loadSessions]);

  useEffect(() => {
    loadSessions(localQuery);
  }, [showArchived]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!menuId) return;
    const onDoc = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuId(null);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuId]);

  const visible = useMemo(
    () =>
      sessions.filter(
        (c) => c.id === activeId || String(c.title || '').trim() !== 'New chat',
      ),
    [sessions, activeId],
  );

  const { pinned, recent } = useMemo(() => {
    if (showArchived) return { pinned: [], recent: visible };
    return {
      pinned: visible.filter((c) => c.pinned),
      recent: visible.filter((c) => !c.pinned),
    };
  }, [visible, showArchived]);

  const closeIfMobile = () => {
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
      onClose?.();
    }
  };

  const handleNew = async () => {
    await newSession();
    closeIfMobile();
  };

  const handleOpen = async (id) => {
    await openSession(id);
    closeIfMobile();
  };

  const startRename = (c) => {
    setMenuId(null);
    setRenamingId(c.id);
    setRenameValue(c.title || '');
  };

  const commitRename = async (id) => {
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title) return;
    try {
      await updateSession(id, { title });
    } catch {
      /* keep existing title on failure */
    }
  };

  const handlePin = async (c) => {
    setMenuId(null);
    await updateSession(c.id, { pinned: !c.pinned });
  };

  const handleArchive = async (c) => {
    setMenuId(null);
    await updateSession(c.id, { archived: !showArchived });
  };

  const handleShare = async (c) => {
    setMenuId(null);
    try {
      const { url } = await shareSession(c.id);
      setShareUrl(url);
    } catch (err) {
      setShareNotice(err.message || 'Could not create share link');
      setTimeout(() => setShareNotice(null), 4000);
    }
  };

  const handleDelete = async (c) => {
    setMenuId(null);
    if (!window.confirm('Delete this chat?')) return;
    await deleteSession(c.id);
  };

  const renderSessionRow = (c, { pinnedSection = false } = {}) => (
    <li key={c.id} className="relative">
      <div
        className={`group flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-sm transition ${
          activeId === c.id
            ? pinnedSection
              ? 'bg-amber-500/15 text-slate-900 ring-1 ring-amber-500/30 dark:text-white'
              : 'bg-gradient-to-r from-blue-50 to-violet-50 text-slate-900 dark:from-blue-900/30 dark:to-violet-900/30 dark:text-white'
            : pinnedSection
              ? 'bg-amber-500/5 hover:bg-amber-500/10 dark:bg-amber-500/10 dark:hover:bg-amber-500/15'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
        }`}
      >
        {pinnedSection && (
          <span className="flex-none text-amber-500" title="Pinned" aria-hidden>
            <PinIcon className="h-3.5 w-3.5" filled />
          </span>
        )}

        {renamingId === c.id ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => commitRename(c.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename(c.id);
              if (e.key === 'Escape') setRenamingId(null);
            }}
            className="min-w-0 flex-1 rounded-md border border-violet-300 bg-white px-2 py-1 text-sm outline-none dark:border-violet-700 dark:bg-slate-900"
          />
        ) : (
          <button
            type="button"
            onClick={() => handleOpen(c.id)}
            className={`flex min-w-0 flex-1 items-center gap-2 text-left ${
              pinnedSection ? 'font-medium' : ''
            }`}
            title={c.title}
          >
            <span className="truncate">{c.title || 'New chat'}</span>
          </button>
        )}

        <span className="flex-none text-[11px] text-slate-400 group-hover:hidden">
          {relativeTime(c.lastMessageAt || c.updatedAt || c.createdAt)}
        </span>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuId(menuId === c.id ? null : c.id);
          }}
          className="hidden flex-none rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 group-hover:block dark:hover:bg-slate-700 dark:hover:text-slate-200"
          title="Chat options"
          aria-label="Chat options"
        >
          <MoreIcon />
        </button>
      </div>

      {menuId === c.id && (
        <div
          ref={menuRef}
          className="absolute right-2 top-10 z-40 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {!showArchived && (
            <MenuItem onClick={() => handlePin(c)}>
              <PinIcon className="h-4 w-4" />
              {c.pinned ? 'Unpin' : 'Pin chat'}
            </MenuItem>
          )}
          <MenuItem onClick={() => startRename(c)}>
            <RenameIcon />
            Rename
          </MenuItem>
          <MenuItem onClick={() => handleArchive(c)}>
            <ArchiveIcon />
            {showArchived ? 'Unarchive' : 'Archive'}
          </MenuItem>
          <MenuItem onClick={() => handleShare(c)}>
            <ShareIcon />
            Share
          </MenuItem>
          <MenuItem danger onClick={() => handleDelete(c)}>
            <TrashIcon />
            Delete
          </MenuItem>
        </div>
      )}
    </li>
  );

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-30 flex w-72 flex-col border-r border-slate-200 bg-white/95 backdrop-blur transition-transform dark:border-slate-800 dark:bg-slate-900/95 ${
        open ? 'translate-x-0' : '-translate-x-full'
      } ${open ? 'md:static md:translate-x-0' : 'md:hidden'}`}
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <img
            src="/logo.png"
            alt="AtozAS AI"
            className="h-9 w-9 rounded-full object-cover ring-1 ring-slate-200 dark:ring-slate-700"
          />
          <span className="text-lg font-bold tracking-tight">
            AtozAS
            <span className="bg-gradient-to-r from-blue-600 to-violet-600 bg-clip-text text-transparent">
              AI
            </span>
          </span>
        </div>
        <button
          type="button"
          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          onClick={() => (onCollapse ? onCollapse() : onClose?.())}
          aria-label="Close sidebar"
          title="Close sidebar"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16" />
          </svg>
        </button>
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={handleNew}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-3 py-2.5 text-sm font-semibold text-white shadow-md shadow-violet-500/20 transition hover:from-blue-700 hover:to-violet-700"
        >
          <span className="text-lg leading-none">+</span> New chat
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            value={localQuery}
            onChange={(e) => setLocalQuery(e.target.value)}
            placeholder="Search chat history..."
            className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm outline-none transition focus:border-violet-400 focus:bg-white dark:border-slate-700 dark:bg-slate-800 dark:focus:bg-slate-800"
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-2">
        <span className="text-xs font-semibold text-violet-600 dark:text-violet-400">
          {showArchived ? 'Archived chats' : 'Chats'}
        </span>
        <button
          type="button"
          onClick={() => setShowArchived(!showArchived)}
          className="text-[11px] font-medium text-slate-500 hover:text-violet-600 dark:hover:text-violet-400"
        >
          {showArchived ? 'Active' : 'Archived'}
        </button>
      </div>

      {shareNotice && (
        <div className="mx-3 mb-2 rounded-lg bg-red-50 px-2.5 py-2 text-[11px] text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {shareNotice}
        </div>
      )}

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-slate-400">
            {localQuery.trim()
              ? 'No matching chats.'
              : showArchived
                ? 'No archived chats.'
                : 'No chats yet. Send a message to start.'}
          </p>
        ) : (
          <>
            {pinned.length > 0 && (
              <SessionGroup
                label="Pinned"
                icon={<PinIcon className="h-3.5 w-3.5" filled />}
                items={pinned}
                renderItem={(c) => renderSessionRow(c, { pinnedSection: true })}
                accent
              />
            )}
            {(recent.length > 0 || pinned.length === 0) && (
              <SessionGroup
                label={showArchived ? 'Archived' : 'Recent'}
                items={recent}
                renderItem={(c) => renderSessionRow(c)}
                className={pinned.length > 0 ? 'mt-3' : undefined}
              />
            )}
          </>
        )}
      </nav>

      <div className="border-t border-slate-200 p-3 dark:border-slate-800">
        <Link
          to="/login"
          className="flex w-full items-center justify-center rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
        >
          Sign in to save forever
        </Link>
      </div>

      <ShareLinkModal
        open={Boolean(shareUrl)}
        url={shareUrl}
        onClose={() => setShareUrl(null)}
      />
    </aside>
  );
}

function SessionGroup({ label, icon, items, renderItem, className = '', accent = false }) {
  if (!items.length) return null;
  return (
    <div
      className={`${className} ${
        accent
          ? 'rounded-xl border border-amber-500/20 bg-amber-500/[0.04] px-1 py-1.5 dark:border-amber-500/25 dark:bg-amber-500/[0.06]'
          : ''
      }`}
    >
      <div
        className={`mb-1 flex items-center gap-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wide ${
          accent ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'
        }`}
      >
        {icon ? <span className="text-amber-500">{icon}</span> : null}
        {label}
      </div>
      <ul className="space-y-0.5">{items.map(renderItem)}</ul>
    </div>
  );
}

function MenuItem({ children, onClick, danger }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition ${
        danger
          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40'
          : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'
      }`}
    >
      {children}
    </button>
  );
}

function MoreIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

function PinIcon({ className = 'h-4 w-4', filled }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M12 17v5M9 3h6l-1 7h3l-5 6-5-6h3L9 3z" />
    </svg>
  );
}

function RenameIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  );
}
