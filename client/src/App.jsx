import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './store/auth.js';
import LoginPage from './pages/LoginPage.jsx';
import ChatPage from './pages/ChatPage.jsx';
import PublicChatPage from './pages/PublicChatPage.jsx';
import SharedChatPage from './pages/SharedChatPage.jsx';
import Spinner from './components/ui/Spinner.jsx';
import { clearSsoAttempt, clearManualLogin } from './lib/sso.js';

function PublicOnlyRoute({ children }) {
  const status = useAuth((s) => s.status);
  if (status === 'loading') return <FullScreenLoader />;
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return children;
}

/**
 * `/` is this app. Anonymous visitors see public chat. Signed-in visitors see
 * the private chat. Opening atozasai.com never bounces to atozasindia.in —
 * that happens only from the login page "Continue with ATOZAS" button
 * (`/auth/atozas`) or an IdP callback.
 */
function HomeRoute() {
  const status = useAuth((s) => s.status);

  useEffect(() => {
    if (status === 'authenticated') {
      clearSsoAttempt();
      clearManualLogin();
    }
  }, [status]);

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
      <Route path="/share/:token" element={<SharedChatPage />} />
      <Route path="/" element={<HomeRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
