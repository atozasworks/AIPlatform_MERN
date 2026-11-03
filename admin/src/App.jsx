import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './store/auth.js';
import Layout from './components/Layout.jsx';
import LoginPage from './pages/LoginPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import CollectionPage from './pages/CollectionPage.jsx';

function RequireAdmin({ children }) {
  const status = useAuth((s) => s.status);
  if (status === 'loading') {
    return <div className="center muted">Loading…</div>;
  }
  if (status !== 'authenticated') return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const bootstrap = useAuth((s) => s.bootstrap);
  const status = useAuth((s) => s.status);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  return (
    <Routes>
      <Route
        path="/login"
        element={status === 'authenticated' ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        element={
          <RequireAdmin>
            <Layout />
          </RequireAdmin>
        }
      >
        <Route path="/" element={<DashboardPage />} />
        <Route path="/collections/:model" element={<CollectionPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
