import { useEffect, useRef, useState } from 'react';
import Markdown from './Markdown.jsx';
import Citations from './Citations.jsx';
import { useChat } from '../../store/chat.js';

/** Grow the edit textarea with content (height only; width is layout-controlled). */
function resizeEditArea(el) {
  if (!el) return;
  el.style.height = 'auto';
  const next = Math.min(Math.max(el.scrollHeight, 72), 240);
  el.style.height = `${next}px`;
}

/**
 * Renders a single message. User bubbles include ChatGPT-style copy / edit /
 * version navigation (`< 1/2 >`). Assistant bubbles render Markdown.
 */
export default function MessageBubble({ message }) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [privacyBusy, setPrivacyBusy] = useState(false);
  const [privacyError, setPrivacyError] = useState(null);
  const editRef = useRef(null);
  const isStreaming = useChat((s) => s.isStreaming);
  const editMessage = useChat((s) => s.editMessage);
  const selectVersion = useChat((s) => s.selectVersion);
  const markMessagePrivate = useChat((s) => s.markMessagePrivate);
  // An optimistic row has no server id yet, so it can be neither edited nor
  // addressed by the private-code endpoint until the real id arrives.
  const isTemp = String(message.id).startsWith('tmp-');
  const canMarkPrivate = !isTemp && !message.isPrivate && message.status !== 'streaming';

  const copy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  useEffect(() => {
    if (editing) resizeEditArea(editRef.current);
  }, [editing, draft]);

  const startEdit = () => {
    setDraft(message.content);
    setEditing(true);
  };

  const cancelEdit = () => {
    setDraft(message.content);
    setEditing(false);
  };

  const saveEdit = async () => {
    const text = draft.trim();
    if (!text || text === message.content) {
      setEditing(false);
      return;
    }
    if (isTemp) return;
    setEditing(false);
    // editMessage stops any in-flight generation, so re-edits are never blocked.
    await editMessage(message.id, text);
  };

  const makePrivate = async () => {
    if (privacyBusy) return;
    setPrivacyBusy(true);
    setPrivacyError(null);
    try {
      await markMessagePrivate(message.id);
    } catch (err) {
      setPrivacyError(err.message || 'Could not make this message private.');
    } finally {
      setPrivacyBusy(false);
    }
  };

  const versionCount = message.versionCount || 0;
  const versionIndex = (message.versionIndex ?? 0) + 1;
  const showVersions = isUser && versionCount > 1 && !editing;

  if (isUser) {
    return (
      <div className={`flex ${editing ? 'justify-stretch' : 'justify-end'}`}>
        <div className={editing ? 'w-full max-w-none' : 'max-w-[80%]'}>
          {editing ? (
            <div className="w-full rounded-2xl rounded-br-md border border-brand-300 bg-white p-3 dark:border-brand-700 dark:bg-slate-900">
              <textarea
                ref={editRef}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  resizeEditArea(e.target);
                }}
                rows={3}
                className="min-h-[4.5rem] max-h-60 w-full resize-y rounded-lg bg-transparent px-2 py-2 text-sm leading-relaxed outline-none"
                autoFocus
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={!draft.trim()}
                  className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-40"
                >
                  Save & submit
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand-600 px-4 py-2.5 text-white">
                {message.content}
              </div>
              <div className="mt-1.5 flex items-center justify-end gap-1 text-slate-400">
                <IconButton onClick={copy} title={copied ? 'Copied' : 'Copy'} label={copied ? 'Copied' : 'Copy'}>
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </IconButton>
                {!isTemp && (
                  <IconButton onClick={startEdit} title="Edit" label="Edit">
                    <EditIcon />
                  </IconButton>
                )}
                {canMarkPrivate && (
                  <IconButton
                    onClick={makePrivate}
                    disabled={privacyBusy || isStreaming}
                    title="Make private (emails you a unique code)"
                    label="Make private"
                  >
                    <LockIcon />
                  </IconButton>
                )}
                {showVersions && (
                  <div className="ml-1 flex items-center gap-0.5 text-xs tabular-nums">
                    <IconButton
                      onClick={() => selectVersion(message.id, -1)}
                      disabled={versionIndex <= 1}
                      title="Previous version"
                      label="Previous version"
                    >
                      <ChevronLeftIcon />
                    </IconButton>
                    <span className="min-w-[2.5rem] text-center text-slate-500">
                      {versionIndex}/{versionCount}
                    </span>
                    <IconButton
                      onClick={() => selectVersion(message.id, 1)}
                      disabled={versionIndex >= versionCount}
                      title="Next version"
                      label="Next version"
                    >
                      <ChevronRightIcon />
                    </IconButton>
                  </div>
                )}
              </div>
              {(message.isPrivate || privacyError) && (
                <div className="mt-1.5 flex justify-end">
                  <PrivateBadge message={message} error={privacyError} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  const streaming = message.status === 'streaming';
  return (
    <div className="flex gap-3">
      <div className="mt-1 flex h-8 w-8 flex-none items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white dark:bg-slate-700">
        AI
      </div>
      <div className="min-w-0 flex-1">
        {message.content ? (
          <div className={streaming ? 'streaming-caret' : ''}>
            <Markdown>{message.content}</Markdown>
          </div>
        ) : (
          <div className="flex gap-1 py-2" aria-label="Assistant is typing">
            <Dot /> <Dot delay="150ms" /> <Dot delay="300ms" />
          </div>
        )}

        {message.status === 'error' && (
          <p className="mt-1 text-sm text-red-500">⚠ {message.error || 'Generation failed.'}</p>
        )}

        {!streaming && <Citations citations={message.citations} />}

        {!streaming && message.content && (
          <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-400">
            <IconButton onClick={copy} title={copied ? 'Copied' : 'Copy'} label={copied ? 'Copied' : 'Copy'}>
              {copied ? <CheckIcon /> : <CopyIcon />}
            </IconButton>
            {canMarkPrivate && (
              <IconButton
                onClick={makePrivate}
                disabled={privacyBusy}
                title="Make private (emails you a unique code)"
                label="Make private"
              >
                <LockIcon />
              </IconButton>
            )}
            {message.status === 'stopped' && <span className="italic">stopped</span>}
            {message.stats?.tokensPerSecond ? (
              <span title="Local generation speed on ATOZAS hardware">
                {message.stats.tokensPerSecond} tok/s
              </span>
            ) : null}
          </div>
        )}

        {(message.isPrivate || privacyError) && (
          <div className="mt-1.5">
            <PrivateBadge message={message} error={privacyError} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Shows the private state: the emailed unique code (or an error while marking). */
function PrivateBadge({ message, error }) {
  if (error) {
    return <span className="text-xs text-red-500">⚠ {error}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
      <LockIcon />
      <span>Private</span>
      {message.privateCode && (
        <>
          <span aria-hidden>·</span>
          <span className="font-mono tracking-wide text-slate-600 dark:text-slate-300">
            {message.privateCode}
          </span>
        </>
      )}
      <span aria-hidden>·</span>
      <span>{message.privateCodeSentAt ? 'code emailed to you' : 'code saved'}</span>
    </span>
  );
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function IconButton({ onClick, title, label, disabled, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-slate-100 hover:text-slate-700 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      {children}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function Dot({ delay = '0ms' }) {
  return (
    <span
      className="h-2 w-2 animate-bounce rounded-full bg-slate-400"
      style={{ animationDelay: delay }}
    />
  );
}
