import { useEffect, useRef, useState } from 'react';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const GSI_SRC = 'https://accounts.google.com/gsi/client';

let gsiPromise = null;

/** Loads the Google Identity Services script once and resolves when ready. */
function loadGsi() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gsiPromise) return gsiPromise;

  gsiPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GSI_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', reject);
      return;
    }
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return gsiPromise;
}

/**
 * Renders the official "Continue with Google" button. Hidden entirely when no
 * client id is configured at build time (VITE_GOOGLE_CLIENT_ID), so a partial
 * deployment never shows a broken button.
 */
export default function GoogleButton({ onCredential, onError }) {
  const containerRef = useRef(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    let cancelled = false;

    loadGsi()
      .then(() => {
        if (cancelled || !containerRef.current || !window.google?.accounts?.id) return;
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (response) => {
            if (response?.credential) onCredential?.(response.credential);
          },
        });
        window.google.accounts.id.renderButton(containerRef.current, {
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'pill',
          width: 320,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        onError?.(new Error('Could not load Google Sign-In.'));
      });

    return () => {
      cancelled = true;
    };
  }, [onCredential, onError]);

  if (!GOOGLE_CLIENT_ID) return null;
  if (failed) {
    return (
      <p className="text-center text-xs text-slate-400">Google Sign-In is unavailable right now.</p>
    );
  }

  return <div ref={containerRef} className="flex justify-center" />;
}
