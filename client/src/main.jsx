import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import App from './App.jsx';
import { ThemeProvider } from './context/ThemeContext.jsx';
import './index.css';

// Apply a newly downloaded service worker immediately. Without this, users
// keep the previous SW (which served cached index.html for `/login` and
// `/auth/*` and broke SSO) until they hard-refresh.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    updateSW(true);
  },
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
