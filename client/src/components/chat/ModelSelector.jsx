import { useChat } from '../../store/chat.js';

/**
 * Model selector (§4). Shows an "Auto Select" option plus every model the
 * backend reports, annotated with provider, context window, and availability.
 */
export default function ModelSelector() {
  const models = useChat((s) => s.models);
  const selectedProvider = useChat((s) => s.selectedProvider);
  const selectedModel = useChat((s) => s.selectedModel);
  const setProvider = useChat((s) => s.setProvider);

  const value = selectedProvider === 'auto' ? 'auto' : `${selectedProvider}:${selectedModel}`;

  const onChange = (e) => {
    const v = e.target.value;
    if (v === 'auto') return setProvider('auto', '');
    const [provider, model] = v.split(':');
    setProvider(provider, model);
  };

  return (
    <div className="flex items-center gap-2">
      <select
        value={value}
        onChange={onChange}
        className="max-w-[16rem] truncate rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-800"
        title="Select AI model"
      >
        <option value="auto">Auto Select</option>
        {models.map((m) => (
          <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`} disabled={!m.available}>
            {m.name} · {m.provider}
            {m.available ? '' : ' (unavailable)'}
          </option>
        ))}
      </select>
    </div>
  );
}
