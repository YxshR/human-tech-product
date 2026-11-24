/** Shown while a page's data loads: keeps the layout steady instead of a blank screen. */
export default function Loading() {
  return (
    <div aria-busy="true" role="status">
      <span className="sr">Loading…</span>
      <div className="navbar-progress" />
      <div className="skel" style={{ height: 32, width: 240, marginBottom: 10 }} />
      <div className="skel" style={{ height: 16, width: 420, maxWidth: '80%', marginBottom: 30 }} />
      <div className="stats">{[0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 78, borderRadius: 14 }} />)}</div>
      <div className="skel" style={{ height: 300, borderRadius: 14 }} />
    </div>
  );
}
