/** Shown while a page's data loads: keeps the layout steady instead of a blank screen. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="navbar-progress" />
      <div className="skel" style={{ height: 34, width: 260, marginBottom: 10 }} />
      <div className="skel" style={{ height: 16, width: 380, maxWidth: '80%', marginBottom: 28 }} />
      <div className="stats">{[0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 86, borderRadius: 16 }} />)}</div>
      <div className="skel" style={{ height: 280, borderRadius: 16 }} />
    </div>
  );
}
