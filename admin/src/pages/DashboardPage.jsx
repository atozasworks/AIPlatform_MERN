import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

/**
 * Overview: totals across the database plus a per-collection breakdown that
 * links into the data browser.
 */
export default function DashboardPage() {
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/admin/overview')
      .then(setOverview)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="alert">{error}</div>;
  if (!overview) return <div className="muted">Loading…</div>;

  return (
    <div>
      <h1 className="page-title">Dashboard</h1>

      <div className="stats">
        <div className="stat-card">
          <div className="stat-value">{overview.totalCollections}</div>
          <div className="stat-label">Collections</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{overview.totalDocuments.toLocaleString()}</div>
          <div className="stat-label">Total documents</div>
        </div>
      </div>

      <h2 className="section-title">Collections</h2>
      <div className="card-grid">
        {overview.collections.map((c) => (
          <Link key={c.model} to={`/collections/${c.model}`} className="collection-card">
            <div className="collection-name">{c.model}</div>
            <div className="collection-meta">{c.collection}</div>
            <div className="collection-count">
              {typeof c.count === 'number' ? c.count.toLocaleString() : '—'} docs
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
