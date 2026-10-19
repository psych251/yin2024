#!/usr/bin/env node
/*
 * Generate the AI replies for Session 2, locally. Run this between the two sessions.
 *
 *   npm run generate-replies                       dry run: counts and a cost estimate, nothing is called or written
 *   npm run generate-replies -- --yes --key <service-account.json>
 *                                                  calls the model (COSTS MONEY) and writes the replies
 *
 * For each Session 1 participant who finished, is not a test ID, and has a Prolific ID and a
 * description, it:
 *   1. assigns the label ("ai" or "human") so the two groups stay balanced,
 *   2. asks the model for a reply with the original study's prompt (scripts/lib/reply.js),
 *   3. writes experiments/<rate id>/replies/<hash of the Prolific ID> (create-only: it never
 *      overwrites a reply that exists, so re-running only fills in the missing ones),
 *   4. appends a private log to data/private/replies-<rate id>.csv (gitignored: it contains the
 *      descriptions and Prolific IDs).
 * Session 2 reads its reply document using only the participant's Prolific ID.
 *
 * The Anthropic key comes from .env (ANTHROPIC_API_KEY or api_key) or the shell. The Firebase
 * service-account key path is passed with --key; this script never searches for credentials.
 *
 * --emulator [--mock]  run against the local Firestore emulator; --mock fabricates replies with no
 *                      API call (allowed only with --emulator). Used by the test suite.
 * --private-dir <dir>  where the private log goes (default data/private).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { REPLY_WORDS, DEFAULT_MODEL, countWords, generateReply, getApiKey, replyDocId } = require("./lib/reply");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes("--" + name);

const rateId = arg("rate", "yin2024-label-pilot-a");
const describeId = arg("describe", rateId + "-describe");
const keyPath = arg("key", process.env.GOOGLE_APPLICATION_CREDENTIALS);
const model = arg("model", DEFAULT_MODEL);
const limit = Number(arg("limit", "0")) || Infinity;
const go = flag("yes");
const emulator = flag("emulator");
const mock = flag("mock");
if (mock && !emulator) { console.error("--mock is only allowed together with --emulator."); process.exit(1); }

const admin = require("firebase-admin");
if (emulator) {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";
  admin.initializeApp({ projectId: "demo-psych251" });
} else {
  if (!keyPath || !fs.existsSync(keyPath)) {
    console.error("No service-account key. Pass --key <path> or set GOOGLE_APPLICATION_CREDENTIALS.");
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(keyPath, "utf8"))) });
}
const db = admin.firestore();

const randomInt = (n) => crypto.randomInt(n);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// The participant's trials, from the chunk documents (or the final full_data copy).
async function trialsOf(pDoc, p) {
  const chunks = await pDoc.ref.collection("trials").orderBy("chunk_index").get();
  let t = chunks.docs.flatMap((c) => c.data().trials || []);
  if (t.length === 0 && typeof p.full_data === "string") t = JSON.parse(p.full_data);
  return t;
}
const ts = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : 0);

(async () => {
  const pSnap = await db.collection("experiments").doc(describeId).collection("participants").get();
  if (pSnap.empty) { console.error(`No participants under experiments/${describeId}. Check --describe.`); process.exit(1); }

  // 1. Who is eligible
  const skipped = { not_completed: 0, test_id: 0, no_pid: 0, no_description: 0, declined: 0, duplicate: 0 };
  const byPid = new Map();
  for (const d of pSnap.docs) {
    const p = d.data();
    if (p.completed !== true) { skipped.not_completed++; continue; }
    if (p.is_test === true) { skipped.test_id++; continue; }
    if (!p.prolific_pid) { skipped.no_pid++; continue; }
    const t = await trialsOf(d, p);
    const consent = t.find((x) => x.task === "consent");
    if (consent && consent.consented === false) { skipped.declined++; continue; }
    const desc = t.find((x) => x.task === "describe");
    if (!desc || typeof desc.description !== "string" || !desc.description.trim()) { skipped.no_description++; continue; }
    const key = replyDocId(p.prolific_pid);
    const row = { docId: d.id, pid: p.prolific_pid, replyId: key, description: desc.description.trim(), started: ts(p.started_at) };
    const prev = byPid.get(key);
    if (prev) { skipped.duplicate++; if (row.started < prev.started) byPid.set(key, row); } else byPid.set(key, row);
  }

  // 2. Who already has a reply (create-only: never regenerate)
  const repliesRef = db.collection("experiments").doc(rateId).collection("replies");
  const existing = await repliesRef.get();
  const have = new Set(existing.docs.map((d) => d.id));
  const counts = { ai: 0, human: 0 };
  existing.docs.forEach((d) => { const l = d.data().label; if (counts[l] !== undefined) counts[l]++; });
  let todo = [...byPid.values()].filter((r) => !have.has(r.replyId));
  const already = byPid.size - todo.length;
  shuffle(todo);
  if (todo.length > limit) todo = todo.slice(0, limit);

  // 3. Balanced labels: always give the group that has fewer replies so far; a tie is a coin flip
  const sim = { ...counts };
  for (const r of todo) {
    r.label = sim.ai < sim.human ? "ai" : sim.human < sim.ai ? "human" : (randomInt(2) ? "ai" : "human");
    sim[r.label]++;
  }

  const words = todo.map((r) => countWords(r.description));
  const meanWords = words.length ? words.reduce((a, b) => a + b, 0) / words.length : 0;
  const inTok = todo.length * (130 + 1.4 * meanWords), outTok = todo.length * 100;
  console.log(`Session 1 (${describeId}): ${pSnap.size} participants`);
  console.log(`  skipped: ${Object.entries(skipped).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  console.log(`  eligible: ${byPid.size}; already have a reply: ${already}; to generate now: ${todo.length}`);
  console.log(`  labels for the new ones: ai ${sim.ai - counts.ai}, human ${sim.human - counts.human} (totals after: ai ${sim.ai}, human ${sim.human})`);
  if (!mock && todo.length) {
    const cost = (inTok * 2 + outTok * 10) / 1e6;
    console.log(`  estimate: ~${Math.round(inTok)} input + ~${Math.round(outTok)} output tokens => about $${cost.toFixed(3)} at $2/$10 per million tokens (the default model's price when this was written; check yours).`);
  }
  if (!go) {
    console.log(todo.length ? "\nDRY RUN: nothing was called or written. Add --yes to generate (this spends money)." : "\nNothing to do.");
    return;
  }
  if (!todo.length) { console.log("\nNothing to do."); return; }

  const apiKey = mock ? "mock" : getApiKey();
  if (!apiKey) { console.error("No Anthropic key. Put ANTHROPIC_API_KEY (or api_key) in .env or the shell."); process.exit(1); }

  // 4. Generate and write
  const logDir = arg("private-dir", path.join("data", "private"));
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `replies-${rateId}.csv`);
  const cols = ["reply_doc_id", "describe_participant_id", "prolific_pid", "label", "reply_n_words", "model", "generated_at", "description", "reply_text"];
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, cols.join(",") + "\n");

  let ok = 0, failed = 0, i = 0;
  async function worker() {
    while (i < todo.length) {
      const r = todo[i++];
      try {
        const out = mock
          ? { text: `MOCK reply (${r.label}) to a ${countWords(r.description)}-word description.`, model: "mock", usage: null }
          : await generateReply(r.description, { key: apiKey, model, maxWords: REPLY_WORDS });
        await repliesRef.doc(r.replyId).create({
          describe_participant_id: r.docId,
          label: r.label,
          description: r.description,
          reply_text: out.text,
          reply_n_words: countWords(out.text),
          model: out.model,
          source: mock ? "mock" : "llm",
          generated_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        fs.appendFileSync(logPath, [r.replyId, r.docId, r.pid, r.label, countWords(out.text), out.model, new Date().toISOString(), r.description, out.text].map(csvCell).join(",") + "\n");
        ok++;
        if (countWords(out.text) > 2 * REPLY_WORDS) console.warn(`  note: ${r.docId} reply is ${countWords(out.text)} words (target ${REPLY_WORDS})`);
      } catch (e) {
        failed++;
        console.error(`  FAILED ${r.docId}: ${e.message}`);
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  console.log(`\nDone: ${ok} replies written, ${failed} failed. Private log: ${logPath}`);
  if (failed) console.log("Re-run the same command to retry only the failed ones.");
})().catch((e) => { console.error(e); process.exit(1); });
