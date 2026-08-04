import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './store/auth.js';
import LoginPage from './pages/LoginPage.jsx';
import ChatPage from './pages/ChatPage.jsx';
import PublicChatPage from './pages/PublicChatPage.jsx';
import Spinner from './components/ui/Spinner.jsx';

function ProtectedRoute({ children }) {
  const status = useAuth((s) => s.status);
  const location = useLocation();
  if (status === 'loading') return <FullScreenLoader />;
  if (status !== 'authenticated') return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

function PublicOnlyRoute({ children }) {
  const status = useAuth((s) => s.status);
  if (status === 'loading') return <FullScreenLoader />;
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return children;
}

/**
 * `/` shows pre-login chat for anonymous visitors and the existing ChatPage
 * for signed-in users — so post-login UX stays on the same URL.
 */
function HomeRoute() {
  const status = useAuth((s) => s.status);
  if (status === 'loading') return <FullScreenLoader />;
  if (status === 'authenticated') return <ChatPage />;
  return <PublicChatPage />;
}

function FullScreenLoader() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size={28} />
    </div>
  );
}

export default function App() {
  const bootstrap = useAuth((s) => s.bootstrap);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicOnlyRoute>
            <LoginPage />
          </PublicOnlyRoute>
        }
      />
      {/* Registration is implicit (accounts are created on first OTP/Google login). */}
      <Route path="/register" element={<Navigate to="/login" replace />} />
      {/* Explicit guest chat URL (same page as anonymous `/`). */}
      <Route
        path="/chat"
        element={
          <PublicOnlyRoute>
            <PublicChatPage />
          </PublicOnlyRoute>
        }
      />
      <Route path="/" element={<HomeRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
