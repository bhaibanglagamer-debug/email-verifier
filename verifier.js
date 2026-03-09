const dns = require("dns");
const net = require("net");

// ── Use public DNS servers instead of system default ──────
const resolver = new dns.Resolver();
resolver.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1"]);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "tempmail.com", "throwaway.email",
  "yopmail.com", "sharklasers.com", "guerrillamailblock.com", "grr.la",
  "dispostable.com", "trashmail.com", "fakeinbox.com", "mailnesia.com",
  "maildrop.cc", "discard.email", "temp-mail.org", "tempail.com"
]);

// ── MX record cache to avoid re-resolving the same domain ──
const mxCache = new Map();

function checkSyntax(email) {
  return EMAIL_REGEX.test(email.trim());
}

/**
 * MX record lookup with caching
 */
async function getMxRecords(domain) {
  if (mxCache.has(domain)) return mxCache.get(domain);

  return new Promise((resolve, reject) => {
    resolver.resolveMx(domain, (err, addresses) => {
      if (err) return reject(err);
      if (!addresses || addresses.length === 0) return reject(new Error("No MX records"));
      addresses.sort((a, b) => a.priority - b.priority);
      mxCache.set(domain, addresses);
      resolve(addresses);
    });
  });
}

/**
 * Wait for a complete SMTP response (handles multi-line responses).
 * Multi-line: "250-Hello\r\n250-SIZE\r\n250 OK\r\n"
 * Single:     "250 OK\r\n"
 * Complete when last line has format: "NNN " (space after 3 digits)
 */
function waitForResponse(socket, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let buffer = "";
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.removeListener("data", onData);
        resolve({ code: null, message: "Timeout waiting for response" });
      }
    }, timeoutMs);

    function onData(chunk) {
      buffer += chunk.toString();
      // Check if we have a complete response
      // Complete when last line matches: 3-digit code followed by SPACE (not dash)
      const lines = buffer.split("\r\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.length >= 4 && /^\d{3}\s/.test(line)) {
          // Found the final line
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            socket.removeListener("data", onData);
            const code = parseInt(line.substring(0, 3), 10);
            resolve({ code, message: buffer.trim() });
          }
          return;
        }
        if (line.length > 0) break; // Non-empty line that isn't final, keep waiting
      }
    }

    socket.on("data", onData);
  });
}

/**
 * SMTP verification with proper multi-line response handling
 */
function smtpVerify(mxHost, email, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let result = { valid: false, code: null, message: "" };

    const globalTimeout = setTimeout(() => {
      socket.destroy();
      resolve({ valid: false, code: null, message: "Connection timed out" });
    }, timeoutMs);

    socket.connect(25, mxHost, () => {});

    socket.once("connect", async () => {
      try {
        // Step 0: Read server greeting
        const greeting = await waitForResponse(socket, 8000);
        if (!greeting.code || greeting.code >= 400) {
          result = { valid: false, code: greeting.code, message: greeting.message };
          socket.write("QUIT\r\n");
          clearTimeout(globalTimeout);
          socket.destroy();
          resolve(result);
          return;
        }

        // Step 1: EHLO
        socket.write("EHLO mail-verifier.local\r\n");
        const ehlo = await waitForResponse(socket, 8000);
        if (!ehlo.code || ehlo.code >= 400) {
          // Try HELO as fallback
          socket.write("HELO mail-verifier.local\r\n");
          const helo = await waitForResponse(socket, 8000);
          if (!helo.code || helo.code >= 400) {
            result = { valid: false, code: helo.code, message: "EHLO/HELO rejected" };
            socket.write("QUIT\r\n");
            clearTimeout(globalTimeout);
            socket.destroy();
            resolve(result);
            return;
          }
        }

        // Step 2: MAIL FROM
        socket.write("MAIL FROM:<verify@mail-verifier.local>\r\n");
        const mailFrom = await waitForResponse(socket, 8000);
        if (!mailFrom.code || mailFrom.code >= 400) {
          result = { valid: false, code: mailFrom.code, message: mailFrom.message };
          socket.write("QUIT\r\n");
          clearTimeout(globalTimeout);
          socket.destroy();
          resolve(result);
          return;
        }

        // Step 3: RCPT TO — this is the key check
        socket.write(`RCPT TO:<${email}>\r\n`);
        const rcptTo = await waitForResponse(socket, 8000);

        result = {
          valid: rcptTo.code === 250 || rcptTo.code === 251,
          code: rcptTo.code,
          message: rcptTo.message
        };

        // Cleanup
        socket.write("QUIT\r\n");
        clearTimeout(globalTimeout);
        setTimeout(() => socket.destroy(), 500);
        resolve(result);
      } catch (err) {
        clearTimeout(globalTimeout);
        socket.destroy();
        resolve({ valid: false, code: null, message: "SMTP error: " + err.message });
      }
    });

    socket.on("error", () => {
      clearTimeout(globalTimeout);
      resolve({ valid: false, code: null, message: "SMTP connection error" });
    });
  });
}

/**
 * Catch-all detection
 */
async function isCatchAll(mxHost, domain) {
  const randomUser = `xq7probe${Math.random().toString(36).slice(2, 10)}`;
  const result = await smtpVerify(mxHost, `${randomUser}@${domain}`, 10000);
  return result.valid;
}

/**
 * Full verification pipeline for a single email (with retry)
 */
async function verifyEmail(email, retryCount = 1) {
  const trimmed = email.trim().toLowerCase();
  const startTime = Date.now();

  // 1. Syntax
  if (!checkSyntax(trimmed)) {
    return {
      email: trimmed, status: "invalid", reason: "Invalid syntax",
      mxRecord: null, isDisposable: false, isCatchAll: false,
      responseTime: Date.now() - startTime
    };
  }

  const [, domain] = trimmed.split("@");
  const disposable = DISPOSABLE_DOMAINS.has(domain);

  // 2. MX lookup
  let mxRecords;
  try {
    mxRecords = await getMxRecords(domain);
  } catch (err) {
    return {
      email: trimmed, status: "invalid",
      reason: `No MX records — domain does not accept email`,
      mxRecord: null, isDisposable: disposable, isCatchAll: false,
      responseTime: Date.now() - startTime
    };
  }

  const mxHost = mxRecords[0].exchange;

  // 3. SMTP verification
  let smtpResult;
  try {
    smtpResult = await smtpVerify(mxHost, trimmed);
  } catch {
    return {
      email: trimmed, status: "unknown",
      reason: "Could not connect to mail server",
      mxRecord: mxHost, isDisposable: disposable, isCatchAll: false,
      responseTime: Date.now() - startTime
    };
  }

  // Retry on temporary failures (421, 450, 451, 452)
  const tempCodes = [421, 450, 451, 452];
  if (tempCodes.includes(smtpResult.code) && retryCount > 0) {
    await sleep(2000); // Wait 2s before retry
    return verifyEmail(email, retryCount - 1);
  }

  // 4. Catch-all detection (only if SMTP said it's valid)
  let catchAll = false;
  if (smtpResult.valid) {
    try {
      catchAll = await isCatchAll(mxHost, domain);
    } catch {
      // ignore
    }
  }

  // Determine final status
  let status, reason;
  if (smtpResult.valid && catchAll) {
    status = "risky";
    reason = "Accepted but domain is catch-all — may not be real";
  } else if (smtpResult.valid) {
    status = "valid";
    reason = "Mailbox exists";
  } else if (smtpResult.code === 550 || smtpResult.code === 553 || smtpResult.code === 551 || smtpResult.code === 552) {
    status = "invalid";
    reason = "Mailbox does not exist";
  } else if (tempCodes.includes(smtpResult.code)) {
    status = "risky";
    reason = `Temporary rejection (${smtpResult.code}) — server busy, try later`;
  } else if (smtpResult.code === null) {
    // No SMTP response at all — port 25 blocked or timeout
    status = "risky";
    reason = `MX found (${mxHost}) but SMTP unreachable — cannot verify mailbox`;
  } else {
    status = "unknown";
    reason = `Server responded with code ${smtpResult.code}`;
  }

  if (disposable && (status === "valid" || status === "risky")) {
    status = "risky";
    reason = "Disposable email address";
  }

  return {
    email: trimmed, status, reason,
    mxRecord: mxHost, isDisposable: disposable, isCatchAll: catchAll,
    responseTime: Date.now() - startTime
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Bulk verification with domain-level throttling
 * Groups emails by domain and adds a delay between same-domain checks
 * to prevent rate limiting
 */
async function verifyBulk(emails, concurrency = 3) {
  const results = [];
  const queue = [...emails];
  const active = [];
  const domainLastUsed = new Map(); // domain -> timestamp
  const DOMAIN_DELAY = 1000; // 1s gap between same-domain checks

  async function processOne(email) {
    const domain = email.split("@")[1];
    if (domain) {
      const lastUsed = domainLastUsed.get(domain) || 0;
      const elapsed = Date.now() - lastUsed;
      if (elapsed < DOMAIN_DELAY) {
        await sleep(DOMAIN_DELAY - elapsed);
      }
      domainLastUsed.set(domain, Date.now());
    }

    const result = await verifyEmail(email);
    results.push(result);
    return result;
  }

  while (queue.length > 0 || active.length > 0) {
    while (active.length < concurrency && queue.length > 0) {
      const email = queue.shift();
      const promise = processOne(email).then(() => {
        active.splice(active.indexOf(promise), 1);
      });
      active.push(promise);
    }
    if (active.length > 0) {
      await Promise.race(active);
    }
  }

  return results;
}

module.exports = { verifyEmail, verifyBulk };
