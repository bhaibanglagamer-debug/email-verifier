// ── State ──────────────────────────────────────────────────
let allResults = [];
let selectedFile = null;
let originalColumns = [];

// ── Mode Toggle ───────────────────────────────────────────
function switchMode(mode) {
  const pasteMode = document.getElementById("pasteMode");
  const uploadMode = document.getElementById("uploadMode");
  const btnPaste = document.getElementById("btnPaste");
  const btnUpload = document.getElementById("btnUpload");

  if (mode === "paste") {
    pasteMode.classList.remove("hidden");
    uploadMode.classList.add("hidden");
    btnPaste.classList.add("active");
    btnUpload.classList.remove("active");
  } else {
    pasteMode.classList.add("hidden");
    uploadMode.classList.remove("hidden");
    btnPaste.classList.remove("active");
    btnUpload.classList.add("active");
  }
}

// ── Email Counter ─────────────────────────────────────────
const emailInput = document.getElementById("emailInput");
emailInput.addEventListener("input", () => {
  const lines = emailInput.value.split(/[\n,;]+/).map((l) => l.trim()).filter(Boolean);
  document.getElementById("emailCount").textContent = `${lines.length} email${lines.length !== 1 ? "s" : ""}`;
});

// ── Drag & Drop ───────────────────────────────────────────
const dropZone = document.getElementById("dropZone");

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragover");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) setFile(file);
});

function handleFile(e) {
  const file = e.target.files[0];
  if (file) setFile(file);
}

function setFile(file) {
  selectedFile = file;
  const fileNameEl = document.getElementById("fileName");
  fileNameEl.textContent = `📎 ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
  fileNameEl.classList.remove("hidden");
  document.getElementById("uploadFooter").classList.remove("hidden");
  document.getElementById("fileEmailCount").textContent = "Ready to verify";
}

// ── Verify (Paste Mode) ──────────────────────────────────
async function verifyEmails() {
  const raw = emailInput.value.trim();
  if (!raw) return;

  const emails = raw
    .split(/[\n,;]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (emails.length === 0) return;

  showProgress(emails.length);
  disableButtons(true);

  try {
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails }),
    });

    const data = await res.json();

    if (!res.ok) {
      alert(data.error || "An error occurred.");
      hideProgress();
      disableButtons(false);
      return;
    }

    completeProgress();
    setTimeout(() => {
      hideProgress();
      displayResults(data);
    }, 600);
  } catch (err) {
    alert("Network error. Make sure the server is running.");
    hideProgress();
    disableButtons(false);
  }
}

// ── Verify (CSV Upload Mode) ─────────────────────────────
async function verifyCSV() {
  if (!selectedFile) return;

  showProgress();
  disableButtons(true);

  const formData = new FormData();
  formData.append("file", selectedFile);

  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    const data = await res.json();

    if (!res.ok) {
      alert(data.error || "An error occurred.");
      hideProgress();
      disableButtons(false);
      return;
    }

    completeProgress();
    setTimeout(() => {
      hideProgress();
      displayResults(data);
    }, 600);
  } catch (err) {
    alert("Network error. Make sure the server is running.");
    hideProgress();
    disableButtons(false);
  }
}

// ── Progress Bar ──────────────────────────────────────────
function showProgress(count) {
  const section = document.getElementById("progressSection");
  section.classList.remove("hidden");
  document.getElementById("progressBar").style.width = "0%";
  document.getElementById("progressPercent").textContent = "0%";
  document.getElementById("progressStatus").textContent = count
    ? `Verifying ${count} email${count !== 1 ? "s" : ""}...`
    : "Uploading and verifying...";

  // Simulate progress
  let pct = 0;
  const interval = setInterval(() => {
    pct += Math.random() * 12;
    if (pct > 90) pct = 90;
    document.getElementById("progressBar").style.width = pct + "%";
    document.getElementById("progressPercent").textContent = Math.round(pct) + "%";
  }, 400);
  window._progressInterval = interval;
}

function completeProgress() {
  clearInterval(window._progressInterval);
  document.getElementById("progressBar").style.width = "100%";
  document.getElementById("progressPercent").textContent = "100%";
  document.getElementById("progressStatus").textContent = "Verification complete! ✅";
}

function hideProgress() {
  document.getElementById("progressSection").classList.add("hidden");
  disableButtons(false);
}

function disableButtons(disabled) {
  document.getElementById("verifyBtn").disabled = disabled;
  document.getElementById("uploadVerifyBtn").disabled = disabled;
}

// ── Display Results ───────────────────────────────────────
function displayResults(data) {
  allResults = data.results;
  originalColumns = data.originalColumns || [];

  // Summary
  const section = document.getElementById("summarySection");
  section.classList.remove("hidden");
  animateNumber("sumTotal", data.summary.total);
  animateNumber("sumValid", data.summary.valid);
  animateNumber("sumInvalid", data.summary.invalid);
  animateNumber("sumRisky", data.summary.risky);
  animateNumber("sumUnknown", data.summary.unknown);

  // Update download checkbox counts
  document.getElementById("cbValidCount").textContent = data.summary.valid;
  document.getElementById("cbInvalidCount").textContent = data.summary.invalid;
  document.getElementById("cbRiskyCount").textContent = data.summary.risky;
  document.getElementById("cbUnknownCount").textContent = data.summary.unknown;
  updateSelectedCount();

  // Table
  document.getElementById("resultsSection").classList.remove("hidden");
  renderTable(allResults);
}

function animateNumber(id, target) {
  const el = document.getElementById(id);
  let current = 0;
  const step = Math.max(1, Math.ceil(target / 30));
  const timer = setInterval(() => {
    current += step;
    if (current >= target) {
      current = target;
      clearInterval(timer);
    }
    el.textContent = current;
  }, 25);
}

function renderTable(results) {
  const tbody = document.getElementById("resultsBody");
  tbody.innerHTML = "";

  results.forEach((r, i) => {
    const statusIcon =
      r.status === "valid" ? "✅" :
      r.status === "invalid" ? "❌" :
      r.status === "risky" ? "⚠️" : "❔";

    const tr = document.createElement("tr");
    tr.setAttribute("data-status", r.status);
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><strong>${escapeHtml(r.email)}</strong></td>
      <td><span class="badge badge-${r.status}">${statusIcon} ${r.status}</span></td>
      <td>${escapeHtml(r.reason)}</td>
      <td>${r.mxRecord || "—"}</td>
      <td>${r.isDisposable ? '<span class="bool-yes">Yes</span>' : '<span class="bool-no">No</span>'}</td>
      <td>${r.isCatchAll ? '<span class="bool-yes">Yes</span>' : '<span class="bool-no">No</span>'}</td>
      <td><span class="response-time">${r.responseTime}ms</span></td>
    `;
    tbody.appendChild(tr);
  });
}

// ── Filter ────────────────────────────────────────────────
function filterResults(status) {
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.filter === status);
  });
  const filtered = status === "all" ? allResults : allResults.filter((r) => r.status === status);
  renderTable(filtered);
}

// ── Download Panel Toggle ─────────────────────────────────
function toggleDownloadPanel() {
  const panel = document.getElementById("downloadPanel");
  panel.classList.toggle("hidden");
}

// ── Checkbox Helpers ──────────────────────────────────────
function getSelectedStatuses() {
  const statuses = [];
  if (document.getElementById("cbValid").checked) statuses.push("valid");
  if (document.getElementById("cbInvalid").checked) statuses.push("invalid");
  if (document.getElementById("cbRisky").checked) statuses.push("risky");
  if (document.getElementById("cbUnknown").checked) statuses.push("unknown");
  return statuses;
}

function getSelectedResults() {
  const statuses = getSelectedStatuses();
  return allResults.filter((r) => statuses.includes(r.status));
}

function updateSelectedCount() {
  const selected = getSelectedResults();
  const el = document.getElementById("selectedCount");
  el.textContent = `${selected.length} email${selected.length !== 1 ? "s" : ""} selected`;
}

// ── Custom CSV Export ─────────────────────────────────────
function exportCustomCSV() {
  const results = getSelectedResults();
  if (results.length === 0) {
    alert("No emails selected. Check at least one category.");
    return;
  }

  // Build headers: original columns first, then verification columns
  const verifyHeaders = ["Email", "Status", "Reason", "MX Record", "Disposable", "Catch-All", "Response Time (ms)"];
  const hasOriginalData = results.some((r) => r.originalData && Object.keys(r.originalData).length > 0);

  let headers, rows;
  if (hasOriginalData && originalColumns.length > 0) {
    // Include all original columns + verification columns (skip email in verify headers since it's in original)
    headers = [...originalColumns, "Status", "Reason", "MX Record", "Disposable", "Catch-All", "Response Time (ms)"];
    rows = results.map((r) => {
      const origValues = originalColumns.map((col) => (r.originalData && r.originalData[col]) || "");
      return [
        ...origValues,
        r.status, r.reason, r.mxRecord || "",
        r.isDisposable ? "Yes" : "No", r.isCatchAll ? "Yes" : "No", r.responseTime,
      ];
    });
  } else {
    // No original data (paste mode) — just verification columns
    headers = verifyHeaders;
    rows = results.map((r) => [
      r.email, r.status, r.reason, r.mxRecord || "",
      r.isDisposable ? "Yes" : "No", r.isCatchAll ? "Yes" : "No", r.responseTime,
    ]);
  }

  let csv = headers.join(",") + "\n";
  rows.forEach((row) => {
    csv += row.map((val) => `"${String(val).replace(/"/g, '""')}"`).join(",") + "\n";
  });

  const statuses = getSelectedStatuses().join("+");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `emails-${statuses}-${Date.now()}.csv`;
  link.click();
}

// ── Custom Emails-Only Export ─────────────────────────────
function exportCustomEmailsOnly() {
  const results = getSelectedResults();
  if (results.length === 0) {
    alert("No emails selected. Check at least one category.");
    return;
  }

  const emails = results.map((r) => r.email);
  const statuses = getSelectedStatuses().join("+");
  const blob = new Blob([emails.join("\n")], { type: "text/plain;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `emails-${statuses}-${Date.now()}.txt`;
  link.click();
}

// ── Helpers ───────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
