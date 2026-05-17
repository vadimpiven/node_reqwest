const report = await window.electronAPI
  .runScenarios()
  .catch((err) => ({ ok: false, results: [{ name: "ipc", pass: false, detail: err.message }] }));

document.getElementById("status").textContent = report.ok ? "ALL PASS" : "FAIL";

const detailEl = document.getElementById("detail");
detailEl.textContent = report.results
  .map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`)
  .join("\n");
