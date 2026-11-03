import { createContext, useContext, useEffect, useState } from 'react';

const PwaInstallContext = createContext(null);
const dismissedKey = 'atozas-pwa-install-dismissed';

function isInstalled() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function getUnsupportedMessage() {
  const userAgent = window.navigator.userAgent;
  if (/Firefox|FxiOS/i.test(userAgent)) {
    return 'App installation is not supported in Firefox. Please use Chrome or Edge to install the app.';
  }
  if (/iPhone|iPad|iPod/i.test(userAgent)) {
    return 'To install on iPhone: in Safari, tap Share, tap Add to Home Screen, then tap Add. iOS requires this confirmation.';
  }
  if (/Edg|Chrome|CriOS/i.test(userAgent)) {
    return 'This version is not installable yet. Make sure the latest PWA build is live over HTTPS, then reload and try again.';
  }
  return 'App installation is not available in this browser. Please use Chrome or Edge to install the app.';
}

export function PwaInstallProvider({ children }) {
  const [installPrompt, setInstallPrompt] = useState(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [message, setMessage] = useState('');
  const [manualGuidance, setManualGuidance] = useState(false);

  useEffect(() => {
    const alreadyInstalled =
      isInstalled() || window.localStorage.getItem(dismissedKey) === 'installed';
    setInstalled(alreadyInstalled);
    if (!alreadyInstalled && !window.localStorage.getItem(dismissedKey)) {
      setPromptOpen(true);
    }

    const onBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
      setMessage('');
      setManualGuidance(false);
    };
    const onAppInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
      setPromptOpen(false);
      window.localStorage.setItem(dismissedKey, 'installed');
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const dismissPrompt = () => {
    window.localStorage.setItem(dismissedKey, 'dismissed');
    setPromptOpen(false);
  };

  const installApp = async () => {
    if (installed) return;
    if (!installPrompt) {
      setMessage(getUnsupportedMessage());
      setManualGuidance(true);
      setPromptOpen(true);
      return;
    }

    const promptEvent = installPrompt;
    setInstallPrompt(null);
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice.outcome === 'accepted') {
        setInstalled(true);
        window.localStorage.setItem(dismissedKey, 'installed');
      }
      setPromptOpen(false);
      window.localStorage.setItem(dismissedKey, 'dismissed');
    } catch {
      setMessage('Chrome could not open the install prompt. Reload the page and try again.');
      setManualGuidance(true);
    }
  };

  return (
    <PwaInstallContext.Provider value={{ installApp, installed }}>
      {children}
      {!installed && promptOpen && (
        <div className="fixed inset-x-4 bottom-4 z-50 flex justify-end sm:inset-x-6 sm:bottom-6">
          <section
            role="dialog"
            aria-modal="false"
            aria-labelledby="pwa-install-title"
            className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
          >
            <h2 id="pwa-install-title" className="text-lg font-semibold">Install AtozAS AI</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              Install the app on your device for quick access.
            </p>
            {message && (
              <p role="status" className="mt-3 text-sm text-amber-700 dark:text-amber-300">
                {message}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              {!manualGuidance && (
                <button
                  type="button"
                  onClick={dismissPrompt}
                  className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Not now
                </button>
              )}
              <button
                type="button"
                onClick={manualGuidance ? dismissPrompt : installApp}
                className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
              >
                {manualGuidance ? 'Close' : 'Install'}
              </button>
            </div>
          </section>
        </div>
      )}
    </PwaInstallContext.Provider>
  );
}

export function InstallAppButton() {
  const context = useContext(PwaInstallContext);
  if (!context || context.installed) return null;

  return (
    <button
      type="button"
      onClick={context.installApp}
      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      Install app
    </button>
  );
}