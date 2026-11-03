import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../store/auth.js';

/**
 * App shell: a sidebar listing every collection plus the current admin's
 * identity and a logout control. The collection list drives the data browser.
 */
export default function Layout() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();

  const [collections, setCollections] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/admin/db/collections')
      .then((data) => setCollections(data.collections || []))
      .catch((e) => setError(e.message));
  }, []);

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" /> ATOZAS Admin
        </div>

        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
            Dashboard
          </NavLink>
        </nav>

        <div className="nav-section-title">Collections</div>
        <nav className="nav">
          {collections.map((c) => (
            <NavLink
              key={c.model}
              to={`/collections/${c.model}`}
              className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
            >
              <span>{c.model}</span>
              {typeof c.count === 'number' && <span className="badge">{c.count}</span>}
            </NavLink>
          ))}
          {error && <div className="nav-error">{error}</div>}
        </nav>

        <div className="sidebar-footer">
          <div className="user-email" title={user?.email}>
            {user?.email}
          </div>
          <button className="btn btn-ghost" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </aside>

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
