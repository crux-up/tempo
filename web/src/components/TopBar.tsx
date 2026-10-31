/** The product mark: a metronome, the instrument that keeps tempo. */
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
      <path d="M10 28h12L18 5h-4z" fill="none" stroke="var(--chart-3)" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M16 22 23 9" stroke="var(--text)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function TopBar({ scope }: { scope: string }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="/" aria-label="Tempo, back to the default view">
          <Mark />
          <span className="brand-name">Tempo</span>
        </a>
        <span className="topbar-scope" aria-label="Current scope">
          {scope}
        </span>
        <nav className="topbar-links" aria-label="Resources">
          <a href="/api/v1/openapi.json">API reference</a>
        </nav>
      </div>
    </header>
  );
}
