"use client";

import { useState } from "react";

export function ThemeToggle() {
  const [storageError, setStorageError] = useState<string | null>(null);

  function toggleTheme() {
    const root = document.documentElement;
    const nextTheme = root.dataset.theme === "light" ? "dark" : "light";
    root.dataset.theme = nextTheme;
    setStorageError(null);

    try {
      window.localStorage.setItem("raisinfi-theme", nextTheme);
    } catch {
      setStorageError("Theme changed, but this browser could not save your preference.");
    }
  }

  return (
    <div className="theme-controls">
      <button
        className="theme-toggle"
        type="button"
        onClick={toggleTheme}
        aria-label="Toggle light and dark theme"
        title="Toggle light and dark theme"
      >
        <svg className="theme-icon theme-icon-sun" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
        </svg>
        <svg className="theme-icon theme-icon-moon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M20.2 15.4A8.6 8.6 0 0 1 8.6 3.8 8.7 8.7 0 1 0 20.2 15.4Z" />
          <path d="M16.5 3.5v3m-1.5-1.5h3" />
        </svg>
      </button>
      {storageError && <span className="theme-storage-error" role="alert">{storageError}</span>}
    </div>
  );
}
