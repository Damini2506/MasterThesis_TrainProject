// modules/json_logger.js
// Browser-safe JSONL logger (no fs/path). Keeps logs in memory and allows download.

export function makeJsonlLogger({ nodeName, dir = "./logs", runId = null } = {}) {
  const rid = runId || `RUN_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const file = `${dir}/${rid}__${nodeName}.jsonl`; // virtual path (for display only)

  const rows = []; // in-memory JSONL rows

  const log = (e) => {
    const row = {
      ts_iso: new Date().toISOString(),
      run_id: rid,
      node: nodeName,
      ...e,
    };
    rows.push(row);
  };

  const close = () => {
    // no-op for browser
  };

  // Optional helper: download as .jsonl from browser
  const download = (filename = `${rid}__${nodeName}.jsonl`) => {
    const jsonl = rows.map(r => JSON.stringify(r)).join("\n") + "\n";
    const blob = new Blob([jsonl], { type: "application/jsonl" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Optional helper: access raw rows for table/report later
  const getRows = () => rows.slice();

  return { runId: rid, file, log, close, download, getRows };
}
