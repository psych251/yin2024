// Shared by scripts/generate-replies.js: everything that defines how a reply is produced and keyed.
// Nothing here runs in the browser. The prompt is from Yin, Jia & Wakslak (2024), Methods,
// "Procedure" (p. 7), with the median human-response length as the word limit.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Median length of the original human responses by batch: 63, 52, 52, 62, 57, 57 words.
const REPLY_WORDS = 57;
const DEFAULT_MODEL = "claude-sonnet-5-5";
// Formatting only: the reply is shown in a chat bubble. Says nothing about identity.
const SYSTEM = "Write the response as plain text in a single message, with no markdown, headings or lists.";

// Read the key from the git-ignored .env at the repo root if it is not already in the shell.
// Accepts ANTHROPIC_API_KEY or api_key. The value is never printed or logged.
function loadDotEnv() {
  try {
    const text = fs.readFileSync(path.join(__dirname, "..", "..", ".env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch (e) { /* no .env: rely on the shell */ }
}
function getApiKey() {
  loadDotEnv();
  return process.env.ANTHROPIC_API_KEY || process.env.api_key || null;
}

function buildPrompt(description, maxWords = REPLY_WORDS) {
  return "A person you otherwise don't know described the following complex situation they have been " +
    "dealing with. Please respond to what they said in a way that makes them feel understood. " +
    `Keep your response to ${maxWords} words. "${description}"`;
}

const countWords = (s) => (String(s).trim().match(/\S+/g) || []).length;

// One independent call per description (the original cleared the chat history each time).
// Retries twice on 429 / 5xx. Returns {text, model, usage}.
async function generateReply(description, { key, model = DEFAULT_MODEL, maxWords = REPLY_WORDS }) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 500,
          system: SYSTEM,
          // Sonnet 5.5 thinks by default, and thinking tokens are billed as output and count against
          // max_tokens. "between_tools" turns thinking off (accepted at effort high or below).
          thinking: { type: "between_tools" },
          messages: [{ role: "user", content: buildPrompt(description.trim(), maxWords) }],
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        const err = new Error(`API ${r.status}: ${(j.error && j.error.message) || "error"}`);
        err.retryable = r.status === 429 || r.status >= 500;
        throw err;
      }
      const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      if (!text) throw new Error("empty reply (stop_reason: " + j.stop_reason + ")");
      return { text, model: j.model || model, usage: j.usage || null };
    } catch (e) {
      lastError = e;
      if (e.retryable === false || attempt === 2) break;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
  throw lastError;
}

// A participant's reply document is keyed by a hash of their Prolific ID, so the browser can fetch
// exactly its own document by knowing the ID, and nobody can list the collection. The browser
// computes the same value (see replyDocId in experiment.js).
function replyDocId(prolificId) {
  return "p-" + crypto.createHash("sha256").update(String(prolificId || "").trim().toLowerCase()).digest("hex");
}

module.exports = { REPLY_WORDS, DEFAULT_MODEL, SYSTEM, buildPrompt, countWords, generateReply, getApiKey, replyDocId };
