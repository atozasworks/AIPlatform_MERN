import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, qs } from '../api.js';

/**
 * Data browser for a single collection: searchable, paginated table with a
 * JSON detail drawer. Columns are derived from the keys present in the current
 * page of documents, so any model renders without per-model configuration.
 */
export default function CollectionPage() {
  const { model } = useParams();

  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);

  // Reset paging/search when switching collections.
  useEffect(() => {
    setPage(1);
    setSearch('');
    setSearchInput('');
  }, [model]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .get(`/admin/db/collections/${model}${qs({ page, limit: 25, search })}`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [model, page, search]);

  const columns = useMemo(() => {
    const docs = data?.documents || [];
    const keys = new Set();
    docs.forEach((d) => Object.keys(d).forEach((k) => keys.add(k)));
    // Show identity/time columns first when present.
    const preferred = ['_id', 'email', 'name', 'role', 'roles', 'title', 'createdAt', 'updatedAt'];
    const ordered = preferred.filter((k) => keys.has(k));
    const rest = [...keys].filter((k) => !ordered.includes(k)).sort();
    return [...ordered, ...rest];
  }, [data]);

  function submitSearch(e) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{model}</h1>
        {data && (
          <span className="muted">
            {data.total.toLocaleString()} documents · page {data.page}/{data.totalPages}
          </span>
        )}
      </div>

      <form className="toolbar" onSubmit={submitSearch}>
        <input
          className="search"
          type="search"
          placeholder="Search text fields…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <button className="btn" type="submit">
          Search
        </button>
        {search && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setSearch('');
              setSearchInput('');
              setPage(1);
            }}
          >
            Clear
          </button>
        )}
      </form>

      {error && <div className="alert">{error}</div>}
      {loading && <div className="muted">Loading…</div>}

      {!loading && data && data.documents.length === 0 && (
        <div className="muted empty">No documents.</div>
      )}

      {!loading && data && data.documents.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {data.documents.map((doc) => (
                <tr key={doc._id}>
                  {columns.map((c) => (
                    <td key={c} title={cellText(doc[c])}>
                      {cellText(doc[c])}
                    </td>
                  ))}
                  <td>
                    <button className="btn btn-sm" onClick={() => setSelected(doc)}>
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.totalPages > 1 && (
        <div className="pager">
          <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span className="muted">
            {page} / {data.totalPages}
          </span>
          <button
            className="btn"
            disabled={page >= data.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}

      {selected && (
        <div className="drawer-backdrop" onClick={() => setSelected(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <h3>{model} document</h3>
              <button className="btn btn-ghost" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
            <pre className="json">{JSON.stringify(selected, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

/** Renders any value as a compact, single-line cell string. */
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const s = JSON.stringify(value);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  }
  const s = String(value);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}
