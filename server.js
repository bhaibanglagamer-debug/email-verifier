const express = require("express");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const { verifyBulk } = require("./verifier");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── Verify emails from JSON body ────────────────────────
app.post("/api/verify", async (req, res) => {
  try {
    const { emails, concurrency = 5 } = req.body;

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: "Please provide an array of emails" });
    }

    if (emails.length > 10000) {
      return res.status(400).json({ error: "Maximum 10,000 emails per request" });
    }

    // De-duplicate
    const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const results = await verifyBulk(unique, Math.min(concurrency, 10));
    
    const summary = {
      total: results.length,
      valid: results.filter((r) => r.status === "valid").length,
      invalid: results.filter((r) => r.status === "invalid").length,
      risky: results.filter((r) => r.status === "risky").length,
      unknown: results.filter((r) => r.status === "unknown").length,
    };

    res.json({ summary, results });
  } catch (err) {
    console.error("Verification error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Verify emails from CSV upload ──────────────────────
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const content = req.file.buffer.toString("utf-8");
    let rowsWithEmails = []; // { email, originalData }
    let originalColumns = [];

    // Try CSV parsing first
    try {
      const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
      if (records.length > 0) {
        originalColumns = Object.keys(records[0]);
      }

      for (const record of records) {
        // Find the email column
        const emailCol = Object.keys(record).find((k) =>
          k.toLowerCase().includes("email") || k.toLowerCase().includes("mail")
        );
        let email = null;
        if (emailCol && record[emailCol]) {
          email = record[emailCol].trim();
        } else {
          // Take the first column value that looks like an email
          const val = Object.values(record).find((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()));
          if (val) email = String(val).trim();
        }

        if (email) {
          rowsWithEmails.push({ email: email.toLowerCase(), originalData: record });
        }
      }
    } catch {
      // Fallback: treat as one email per line (no original columns)
      const lines = content.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
      rowsWithEmails = lines.map((email) => ({ email: email.toLowerCase(), originalData: {} }));
    }

    if (rowsWithEmails.length === 0) {
      return res.status(400).json({ error: "No email addresses found in the file" });
    }

    if (rowsWithEmails.length > 10000) {
      return res.status(400).json({ error: "Maximum 10,000 emails per file" });
    }

    // Verify (deduplicate by email but keep mapping to original rows)
    const emailSet = new Set();
    const uniqueRows = [];
    for (const row of rowsWithEmails) {
      if (!emailSet.has(row.email)) {
        emailSet.add(row.email);
        uniqueRows.push(row);
      }
    }

    const emails = uniqueRows.map((r) => r.email);
    const verificationResults = await verifyBulk(emails, 3);

    // Merge verification results back with original data
    const resultMap = new Map();
    for (const vr of verificationResults) {
      resultMap.set(vr.email, vr);
    }

    const results = uniqueRows.map((row) => {
      const vr = resultMap.get(row.email) || {};
      return { ...vr, originalData: row.originalData };
    });

    const summary = {
      total: results.length,
      valid: results.filter((r) => r.status === "valid").length,
      invalid: results.filter((r) => r.status === "invalid").length,
      risky: results.filter((r) => r.status === "risky").length,
      unknown: results.filter((r) => r.status === "unknown").length,
    };

    res.json({ summary, results, originalColumns });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`\n  ✉️  Email Verifier running at http://localhost:${PORT}\n`);
});
