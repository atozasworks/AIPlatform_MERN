import { useChat, PHASE } from '../../store/chat.js';

/**
 * Generation status banner.
 *
 * On CPU-only inference the wait before the first token is long enough that
 * silence reads as a broken app. This makes the wait legible: where the request
 * sits in the queue, when the model has actually picked it up, and how to stop.
 */
export default function QueueStatus() {
  const generation = useChat((s) => s.generation);
  const stopStreaming = useChat((s) => s.stopStreaming);
  const dismissNotice = useChat((s) => s.dismissNotice);

  if (generation.phase === PHASE.IDLE) {
    if (!generation.notice) return null;
    return (
      <div className="mx-auto mb-2 flex max-w-3xl items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
        <span>{generation.notice}</span>
        <button
          type="button"
          onClick={dismissNotice}
          className="flex-none rounded-md px-2 py-1 font-medium hover:bg-amber-100 dark:hover:bg-amber-900/50"
        >
          Dismiss
        </button>
      </div>
    );
  }

  const { label, detail } = describe(generation);

  return (
    <div className="mx-auto mb-2 flex max-w-3xl items-center gap-3 rounded-xl border border-slate-200 bg-white/80 px-3 py-2 text-xs text-slate-600 backdrop-blur dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-300">
      <Spinner />
      <div className="min-w-0 flex-1">
        <span className="font-medium text-slate-700 dark:text-slate-200">{label}</span>
        {detail && <span className="ml-2 text-slate-500 dark:text-slate-400">{detail}</span>}
      </div>
      <button
        type="button"
        onClick={stopStreaming}
        className="flex-none rounded-md border border-slate-300 px-2 py-1 font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        Stop
      </button>
    </div>
  );
}

function describe(generation) {
  if (generation.phase === PHASE.QUEUED) {
    if (generation.position > 1) {
      return {
        label: 'Waiting in queue',
        detail: `position ${generation.position}${generation.queueDepth ? ` of ${generation.queueDepth}` : ''}`,
      };
    }
    return { label: 'Waiting in queue', detail: 'you are next' };
  }

  if (generation.phase === PHASE.PREPARING) {
    return { label: 'Preparing answer', detail: 'reading your conversation and sources' };
  }

  return { label: 'Generating', detail: null };
}

function Spinner() {
  return (
    <span
      className="h-3.5 w-3.5 flex-none animate-spin rounded-full border-2 border-slate-300 border-t-brand-600 dark:border-slate-600 dark:border-t-brand-400"
      aria-hidden
    />
  );
}
