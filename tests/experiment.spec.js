// End-to-end test: a robot participant plays both sessions.
//
// Session 1 ("describe", ?part=describe) and Session 2 ("rate", ?part=rate) save under two
// experiment ids. Between them, scripts/generate-replies.js writes each participant's reply; the
// full-pipeline test below runs that script in its --mock mode (no model call, no cost).
//
// These tests need the Firestore emulator: run them with `npm test`. A plain `npx playwright test`
// is skipped on purpose, because the page would otherwise connect to your REAL Firebase project and
// write test participants into your data.
//
// If you change the timeline in experiment.js, update the `run*` helpers below so the robot still
// knows which buttons to press. That is a feature: the test documents the flow.

const { test, expect, devices } = require("@playwright/test");
const { execFileSync } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { replyDocId } = require("../scripts/lib/reply");

const EMULATOR = process.env.EMULATOR === "1" || !!process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-psych251";
const BASE_ID = "yin2024-label-pilot-a";
const DESCRIBE_ID = BASE_ID + "-describe"; // Session 1
const RATE_ID = BASE_ID; // Session 2
const FS = `http://localhost:8080/v1/projects/${PROJECT}/databases/(default)/documents`;

const DESCRIBE_URL = "/?emulator=1&part=describe";
const RATE_URL = "/?emulator=1&part=rate";

const DESCRIPTION =
  "I have been going back and forth about whether to leave my current job for a new offer in another city. " +
  "My manager has been supportive, but I feel stuck, and my partner would have to move with me, which worries me a lot.";
const REPLY = "Moving for a job is a big decision, and it makes sense that you feel pulled in two directions.";

const stamp = Date.now().toString(36); // keeps Prolific IDs unique within one emulator session
let counter = 0;
const uniquePid = (prefix) => `${prefix}${stamp}${counter++}`;

// ---- small helpers ---------------------------------------------------------------------------

async function continueSurvey(page) {
  await page.locator('input[value="Continue"]').click();
}
// Tick the same answer in every row of the matrix questions on the current survey page.
async function answerMatrices(page, value) {
  const radios = page.locator(`input[type="radio"][value="${value}"]`);
  await radios.first().waitFor({ state: "attached" });
  const n = await radios.count();
  for (let i = 0; i < n; i++) await radios.nth(i).check({ force: true });
  return n;
}
// The Prolific ID page: type one unless the URL already prefilled it.
async function enterProlificId(page, pid) {
  const box = page.locator('input[type="text"]');
  await expect(box).toBeVisible();
  if (pid || !(await box.inputValue())) await box.fill(pid || "robotpid");
  await continueSurvey(page);
}

// Session 1: consent, ID, instructions, the chat message (paste blocked), six emotions, thanks.
async function runDescribe(page, { pid = null, finish = true } = {}) {
  await page.getByRole("button", { name: "I agree to participate" }).click();
  await enterProlificId(page, pid);
  await page.locator("#jspsych-instructions-next").click();
  await page.locator("#jspsych-instructions-next").click();
  // a too-short message is refused, and pasting is blocked and counted
  await page.locator("#chat-input").fill("Too short.");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-hint")).toContainText("in more detail");
  await page.locator("#chat-input").evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "pasted text");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator("#chat-input")).toHaveValue("Too short.");
  await expect(page.locator("#chat-hint")).toContainText("Pasting is disabled");
  await page.locator("#chat-input").fill(DESCRIPTION);
  await page.locator("#chat-send").click();
  expect(await answerMatrices(page, 3)).toBe(6);
  await continueSurvey(page);
  await expect(page.getByText("You have finished this part")).toBeVisible();
  if (!finish) return;
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByText("All done")).toBeVisible({ timeout: 30000 });
}

// Session 2: consent, ID (the page looks up the reply), label page, the reply, the ratings and the
// rest. Returns the text of pages the tests want to check.
async function runRate(page, { pid = null, stopBeforeFinish = false } = {}) {
  const seen = {};
  await page.getByRole("button", { name: "I agree to participate" }).click();
  await enterProlificId(page, pid);
  // label page
  const labelStim = page.locator("#jspsych-html-button-response-stimulus");
  await expect(labelStim).toContainText("In an earlier study, we asked you to describe");
  seen.labelIntro = (await labelStim.textContent()).toLowerCase();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // the reply, already written: no typing indicator, shown under the responder's name
  await expect(page.locator(".chat-reply-bubble")).toBeVisible();
  await expect(page.locator("#chat-typing")).toHaveCount(0);
  seen.responder = await page.locator("#chat-reply").getAttribute("data-responder");
  seen.header = await page.locator("#chat-reply .chat-header").textContent();
  await page.getByRole("button", { name: "Continue to questions" }).click();
  // ratings: the reply stays on screen above the 10 + 3 rows
  await expect(page.locator(".chat-exchange")).toBeVisible();
  expect(await answerMatrices(page, 3)).toBe(13);
  await continueSurvey(page);
  // loneliness + emotions (2 + 19 + 3), mind perception (18), AI attitudes (9)
  expect(await answerMatrices(page, 3)).toBe(24);
  await continueSurvey(page);
  expect(await answerMatrices(page, 3)).toBe(18);
  await continueSurvey(page);
  expect(await answerMatrices(page, 3)).toBe(9);
  await continueSurvey(page);
  // suspicion (SurveyJS rating) and demographics
  await page.locator(".sd-rating__item").first().waitFor();
  seen.suspicion = await page.locator("body").innerText();
  await page.locator(".sd-rating__item").nth(3).click();
  await continueSurvey(page);
  await page.locator('input[type="number"]').fill("34");
  await page.getByText("Woman", { exact: true }).click();
  await page.getByText("Asian", { exact: true }).click();
  await continueSurvey(page);
  await page.locator('input[name="Q0"][value="4"]').check();
  await page.locator("#jspsych-survey-likert-next").click();
  await page.locator("textarea").fill("Robot participant says hi.");
  await page.locator("#jspsych-survey-text-next").click();
  await expect(page.getByText("Every response you saw was written by an AI chatbot")).toBeVisible();
  if (stopBeforeFinish) return seen;
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByText("All done")).toBeVisible({ timeout: 30000 });
  return seen;
}

async function fsGet(path) {
  // "Bearer owner" is the emulator's admin token: it bypasses security rules, like the Admin SDK.
  const r = await fetch(`${FS}/${path}`, { headers: { Authorization: "Bearer owner" } });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
}

// Write a reply document as the Admin SDK would (scripts/generate-replies.js does this for real).
async function seedReply(pid, label) {
  const fields = {
    label: { stringValue: label },
    description: { stringValue: DESCRIPTION },
    reply_text: { stringValue: REPLY },
    model: { stringValue: "mock-model" },
    describe_participant_id: { stringValue: "seeded-describe-doc" },
    source: { stringValue: "mock" },
  };
  const r = await fetch(`${FS}/experiments/${RATE_ID}/replies/${replyDocId(pid)}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  expect(r.status).toBe(200);
}

// Unwrap Firestore REST "fields" encoding into plain JS.
function decode(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  return v;
}
function decodeFields(fields) {
  const out = {};
  for (const k of Object.keys(fields)) out[k] = decode(fields[k]);
  return out;
}
async function participantDoc(experimentId, docId) {
  const p = await fsGet(`experiments/${experimentId}/participants/${docId}`);
  expect(p.status).toBe(200);
  return decodeFields(p.body.fields);
}
async function trialRows(experimentId, docId) {
  const chunks = await fsGet(`experiments/${experimentId}/participants/${docId}/trials?pageSize=500`);
  expect(chunks.status).toBe(200);
  return (chunks.body.documents || []).map((d) => decodeFields(d.fields)).flatMap((d) => d.trials);
}
const docIdOf = (page) => page.evaluate(() => window.__saver.docId);

test.describe("experiment", () => {
  test.skip(!EMULATOR, "Run with `npm test` (needs the emulator). A plain run would write to your live Firebase project.");

  // ---- landing page ----------------------------------------------------------------------

  test("without ?part a landing page links to both sessions and no study starts", async ({ page }) => {
    await page.goto("/?emulator=1");
    await expect(page.locator("#landing")).toBeVisible();
    await expect(page.getByRole("link", { name: /Session 1/ })).toHaveAttribute("href", /part=describe/);
    await expect(page.getByRole("link", { name: /Session 2/ })).toHaveAttribute("href", /part=rate/);
    await expect(page.getByRole("button", { name: "I agree to participate" })).toHaveCount(0);
    await page.goto("/?emulator=1&part=1"); // the numeric alias
    await expect(page.getByRole("button", { name: "I agree to participate" })).toBeVisible();
  });

  // ---- Session 1 -------------------------------------------------------------------------

  test("session 1 saves the description and emotions, and keeps the typed ID out of the trial data", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const pid = uniquePid("typedpid");
    await page.goto(DESCRIBE_URL); // no PROLIFIC_PID in the URL
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    expect(await page.evaluate(() => window.__saver.mode)).toBe("emulator");
    await runDescribe(page, { pid });
    expect(errors, "uncaught page errors").toEqual([]);

    const docId = await docIdOf(page);
    expect(await page.evaluate(() => window.__saver.stats.writes_failed)).toBe(0);
    await expect(page.locator("#data-saver-fallback")).toHaveCount(0);
    const pdoc = await participantDoc(DESCRIBE_ID, docId);
    expect(pdoc.completed).toBe(true);
    expect(pdoc.prolific_pid).toBe(pid); // export.js moves this to identifiers.csv
    expect(pdoc.condition).toBeUndefined(); // the label is assigned between the sessions
    const trials = await trialRows(DESCRIBE_ID, docId);
    const idRow = trials.find((t) => t.task === "prolific_id");
    expect(idRow.prolific_id_given).toBe(true);
    expect(idRow.response).toBeUndefined(); // the ID itself is not kept in the trial row
    // As exported: the raw rows carry a prolific_pid key (from the URL, null here) which export.js moves
    // to identifiers.csv; the typed ID itself is nowhere in the trial data.
    expect(JSON.stringify(trials.map(({ prolific_pid, ...row }) => row))).not.toContain(pid);
    expect(JSON.stringify(trials)).not.toContain(pid);
    expect(pdoc.full_data).not.toContain(pid);
    const d = trials.find((t) => t.task === "describe");
    expect(d.description).toBe(DESCRIPTION);
    expect(d.n_words).toBeGreaterThanOrEqual(30);
    expect(d.n_paste_attempts).toBe(1);
    expect(trials.find((t) => t.task === "emotions_self").response.emotion.happiness).toBe(3);
    expect([...new Set(trials.map((t) => t.participant_id))]).toEqual([docId]); // joins to participants
    expect(trials.every((t) => t.session === "describe")).toBe(true);
  });

  test("the Prolific ID is required: the study cannot continue without it", async ({ page }) => {
    await page.goto(DESCRIBE_URL); // no PROLIFIC_PID in the URL
    await page.getByRole("button", { name: "I agree to participate" }).click();
    await continueSurvey(page); // try to continue with the box empty
    await expect(page.getByText("Please enter your Prolific ID to continue.")).toBeVisible();
    await expect(page.locator("#jspsych-instructions-next")).toHaveCount(0);
    await page.locator('input[type="text"]').fill("somepid");
    await continueSurvey(page);
    await expect(page.locator("#jspsych-instructions-next")).toBeVisible();
  });

  test("an ID from the Prolific URL is prefilled and stays authoritative", async ({ page }) => {
    const pid = uniquePid("urlpid");
    await page.goto(`${DESCRIBE_URL}&PROLIFIC_PID=${pid}&STUDY_ID=s1&SESSION_ID=sess1`);
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    await runDescribe(page); // the box is already filled
    const docId = await docIdOf(page);
    const pdoc = await participantDoc(DESCRIBE_ID, docId);
    expect(pdoc.prolific_pid).toBe(pid);
    expect(pdoc.url_params.STUDY_ID).toBe("s1");
    const trials = await trialRows(DESCRIBE_ID, docId);
    expect(trials.find((t) => t.task === "prolific_id").prolific_id_matches_url).toBe(true);
  });

  test("chunked writes (chunk_size > 1) save every trial", async ({ page }) => {
    await page.goto(DESCRIBE_URL + "&chunk_size=5");
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    await runDescribe(page, { pid: uniquePid("chunkpid") });
    const docId = await docIdOf(page);
    const p = await participantDoc(DESCRIBE_ID, docId);
    const chunks = await fsGet(`experiments/${DESCRIBE_ID}/participants/${docId}/trials?pageSize=500`);
    const docs = (chunks.body.documents || []).map((d) => decodeFields(d.fields));
    expect(docs.length).toBe(Math.ceil(p.n_trials / 5));
    const indices = docs.flatMap((d) => d.trials).map((t) => t.trial_index).sort((a, b) => a - b);
    expect(indices).toEqual([...Array(p.n_trials).keys()]);
  });

  test("a second run in the same browser is a new participant and saves cleanly", async ({ page }) => {
    test.setTimeout(120000);
    const ids = [];
    for (let run = 0; run < 2; run++) {
      // Same page/context both times: the anonymous auth session persists, exactly as it does for a
      // participant who reloads.
      await page.goto(DESCRIBE_URL + "&PROLIFIC_PID=" + uniquePid("rerun"));
      await page.waitForFunction(() => window.__saver && window.__saver.docId);
      await runDescribe(page);
      const info = await page.evaluate(() => ({ uid: window.__saver.uid, docId: window.__saver.docId, stats: window.__saver.stats }));
      expect(info.stats.writes_failed, "run " + run + " had failed writes").toBe(0);
      ids.push(info);
    }
    expect(ids[0].uid).toBe(ids[1].uid); // same browser, same anonymous identity
    expect(ids[0].docId).not.toBe(ids[1].docId); // but a separate participant record
    for (const info of ids) expect((await participantDoc(DESCRIBE_ID, info.docId)).completed).toBe(true);
  });

  test("declining consent ends the study without a thank-you-for-your-data message", async ({ page }) => {
    await page.goto(DESCRIBE_URL);
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    await page.getByRole("button", { name: "I do not agree" }).click();
    await expect(page.getByText("You chose not to participate")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Your responses were saved")).toHaveCount(0);
  });

  test("setting a Prolific completion code does not break the test run", async ({ page }) => {
    // Regression test: with a completion code set the live page redirects to Prolific, but a test
    // run must stay put so that `npm test` and CI keep passing.
    const navigations = [];
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });
    await page.goto(DESCRIBE_URL + "&cc=QA123CODE");
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    await runDescribe(page, { pid: uniquePid("ccpid") });
    expect(navigations.some((u) => u.includes("prolific.com")), "must not navigate to Prolific").toBe(false);
    await expect(page.getByText("QA123CODE")).toBeVisible();
  });

  // ---- Session 2 -------------------------------------------------------------------------

  for (const label of ["ai", "human"]) {
    test(`session 2 finds the stored reply and shows it under the "${label}" label`, async ({ page }) => {
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      const pid = uniquePid("seed" + label);
      await seedReply(pid, label);
      await page.goto(`${RATE_URL}&PROLIFIC_PID=${pid}`);
      await page.waitForFunction(() => window.__saver && window.__saver.docId);
      const seen = await runRate(page);
      expect(errors, "uncaught page errors").toEqual([]);

      // the label decides who the responder is, in the label page, the header, and the items
      expect(seen.responder).toBe(label);
      if (label === "ai") {
        expect(seen.labelIntro).toContain("presented to an ai chatbot");
        expect(seen.header).toContain("AI chatbot");
        expect(seen.suspicion).toContain("from another human participant rather than from an AI chatbot");
      } else {
        expect(seen.labelIntro).toContain("presented to another participant on prolific");
        expect(seen.header).toContain("Another Prolific participant");
        expect(seen.suspicion).toContain("from an AI chatbot rather than from another human participant");
      }

      const docId = await docIdOf(page);
      expect(await page.evaluate(() => window.__saver.stats.writes_failed)).toBe(0);
      const pdoc = await participantDoc(RATE_ID, docId);
      expect(pdoc.completed).toBe(true);
      expect(pdoc.condition).toBe(label);
      expect(pdoc.reply_source).toBe("pregenerated");
      expect(pdoc.reply_model).toBe("mock-model");
      expect(pdoc.describe_participant_id).toBe("seeded-describe-doc");
      expect(pdoc.prolific_pid).toBe(pid);
      expect(pdoc.is_test).toBeUndefined();
      const trials = await trialRows(RATE_ID, docId);
      const lookup = trials.find((t) => t.task === "reply_lookup");
      expect(lookup.found).toBe(true);
      const reply = trials.find((t) => t.task === "reply");
      expect(reply.reply_text).toBe(REPLY);
      expect(reply.responder_kind).toBe(label);
      const ratings = trials.find((t) => t.task === "ratings");
      expect(ratings.condition).toBe(label);
      // every item was answered 3, so every composite is 3
      expect(ratings.feeling_heard).toBe(3);
      expect(ratings.response_accuracy).toBe(3);
      expect(ratings.responder_understood).toBe(3);
      expect(ratings.connection).toBe(3);
      const mind = trials.find((t) => t.task === "mind_perception");
      expect(mind.mind_agency).toBe(3);
      expect(mind.mind_experience).toBe(3);
      expect(trials.find((t) => t.task === "suspicion").suspicion).toBe(4);
      expect(trials.find((t) => t.task === "demographics").response.race).toBe("Asian");
      // As exported (export.js moves the prolific_pid key to identifiers.csv): the ID is not in any
      // trial row, and the participant's description is not copied into Session 2.
      const exported = trials.map(({ prolific_pid, ...row }) => row);
      expect(JSON.stringify(exported)).not.toContain(pid);
      expect(JSON.stringify(exported)).not.toContain(DESCRIPTION);
      expect([...new Set(trials.map((t) => t.participant_id))]).toEqual([docId]);
    });
  }

  test("testing IDs skip the lookup, give a fixed or random label, and are flagged as tests", async ({ page }) => {
    for (const [id, expected] of [["TA-TEST-AI", "ai"], ["ta-test-human", "human"]]) { // case does not matter
      await page.goto(RATE_URL);
      await page.waitForFunction(() => window.__saver && window.__saver.docId);
      const seen = await runRate(page, { pid: id });
      expect(seen.responder).toBe(expected);
      const docId = await docIdOf(page);
      const pdoc = await participantDoc(RATE_ID, docId);
      expect(pdoc.is_test).toBe(true);
      expect(pdoc.condition).toBe(expected);
      expect(pdoc.reply_source).toBe("test_fixture");
      const trials = await trialRows(RATE_ID, docId);
      expect(trials.every((t) => t.condition === undefined || t.is_test === true)).toBe(true);
    }
    // TA-TEST-RANDOM gives one of the two labels
    await page.goto(RATE_URL);
    const seen = await runRate(page, { pid: "TA-TEST-RANDOM", stopBeforeFinish: true });
    expect(["ai", "human"]).toContain(seen.responder);
  });

  test("an unknown ID says so and can be corrected without restarting", async ({ page }) => {
    await page.goto(RATE_URL);
    await page.getByRole("button", { name: "I agree to participate" }).click();
    await enterProlificId(page, uniquePid("nobody"));
    await expect(page.getByText("We could not find your earlier response")).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await page.locator('input[type="text"]').fill("TA-TEST-HUMAN");
    await continueSurvey(page);
    await expect(page.locator("#jspsych-html-button-response-stimulus")).toContainText("In an earlier study");
  });

  test("losing the connection at the end offers the download fallback instead of hanging", async ({ page, context }) => {
    test.setTimeout(120000);
    await page.goto(RATE_URL);
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    await runRate(page, { pid: "TA-TEST-AI", stopBeforeFinish: true });
    await context.setOffline(true);
    await page.getByRole("button", { name: "Finish" }).click();
    await expect(page.locator("#data-saver-fallback")).toBeVisible({ timeout: 40000 });
    await expect(page.getByText("connection to the server was lost")).toBeVisible();
    await expect(page.getByText("Your responses were saved")).toHaveCount(0);
    await context.setOffline(false);
  });

  // ---- the whole pipeline ----------------------------------------------------------------

  test("full pipeline: describe, generate replies locally (mock), then rate", async ({ page }) => {
    test.setTimeout(180000);
    const pidA = uniquePid("pipea"), pidB = uniquePid("pipeb");
    for (const pid of [pidA, pidB]) {
      await page.goto(DESCRIBE_URL);
      await page.waitForFunction(() => window.__saver && window.__saver.docId);
      await runDescribe(page, { pid });
    }
    // a testing ID in Session 1 is flagged and must not receive a reply
    await page.goto(DESCRIBE_URL);
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    await runDescribe(page, { pid: "TA-TEST-AI" });

    const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "replies-"));
    const run = (extra) =>
      execFileSync("node", ["scripts/generate-replies.js", "--emulator", "--mock", "--private-dir", privateDir, ...extra], {
        env: { ...process.env, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
        encoding: "utf8",
      });

    // a dry run changes nothing
    const dry = run([]);
    expect(dry).toContain("DRY RUN");
    expect((await fsGet(`experiments/${RATE_ID}/replies/${replyDocId(pidA)}`)).status).toBe(404);

    // the real (mock) run writes a reply for each participant, none for the testing ID
    const out = run(["--yes"]);
    expect(out).toContain("replies written");
    for (const pid of [pidA, pidB]) {
      const r = await fsGet(`experiments/${RATE_ID}/replies/${replyDocId(pid)}`);
      expect(r.status).toBe(200);
      const doc = decodeFields(r.body.fields);
      expect(["ai", "human"]).toContain(doc.label);
      expect(doc.description).toBe(DESCRIPTION);
      expect(doc.reply_text.length).toBeGreaterThan(10);
    }
    expect((await fsGet(`experiments/${RATE_ID}/replies/${replyDocId("TA-TEST-AI")}`)).status).toBe(404);
    // the private log holds the descriptions; it went to the temp dir, not into the repo
    expect(fs.readFileSync(path.join(privateDir, `replies-${RATE_ID}.csv`), "utf8")).toContain(pidA);
    // running it again creates nothing new
    expect(run(["--yes"])).toContain("Nothing to do");

    // Session 2 for participant A: the page finds that very reply and its label
    const stored = decodeFields((await fsGet(`experiments/${RATE_ID}/replies/${replyDocId(pidA)}`)).body.fields);
    await page.goto(`${RATE_URL}&PROLIFIC_PID=${pidA}`);
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    const seen = await runRate(page);
    expect(seen.responder).toBe(stored.label);
    const docId = await docIdOf(page);
    const pdoc = await participantDoc(RATE_ID, docId);
    expect(pdoc.condition).toBe(stored.label);
    expect(pdoc.describe_participant_id).toBe(stored.describe_participant_id);
    const trials = await trialRows(RATE_ID, docId);
    expect(trials.find((t) => t.task === "reply").reply_text).toBe(stored.reply_text);
    expect(trials.find((t) => t.task === "ratings").feeling_heard).toBe(3);
  });

  // ---- device, data-saver and security checks (from the template) ------------------------

  test("phones and tablets are turned away before consent", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    await page.goto("http://localhost:8017/?emulator=1&part=describe");
    await expect(page.locator("#device-unsupported")).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole("button", { name: "I agree to participate" })).toHaveCount(0);
    // The turned-away visit is still recorded, so phone traffic is visible in the data.
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    const docId = await page.evaluate(() => window.__saver.docId);
    await page.evaluate(() => window.__saver._settle());
    const pdoc = await participantDoc(DESCRIBE_ID, docId);
    expect(pdoc.device_supported).toBe(false);
    expect(pdoc.completed).toBe(false);
    await context.close();
  });

  test("a desktop browser is not turned away", async ({ page }) => {
    await page.goto(DESCRIBE_URL);
    await expect(page.getByRole("button", { name: "I agree to participate" })).toBeVisible();
    await expect(page.locator("#device-unsupported")).toHaveCount(0);
  });

  test("a write the database refuses is announced on the page, not only in the console", async ({ page }) => {
    // Regression test for the state a student is in when they skip publishing the rules, or once
    // test-mode rules expire: sign-in succeeds, so the page used to look healthy until the last screen.
    await page.goto(DESCRIBE_URL);
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    await expect(page.locator('#data-saver-banner[data-kind="offline"]')).toHaveCount(0);
    // Force a genuine permission-denied by aiming the participant document at someone else's id.
    await page.evaluate(async () => {
      window.__saver.docId = "someone-else-deadbeef";
      await window.__saver.updateParticipant({ blocked: true });
    });
    const banner = page.locator("#data-saver-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-kind", "offline");
    await expect(banner).toContainText("NOT being saved");
    await expect(banner).toContainText("permission-denied");
    await expect(banner).toContainText("2.3");
    expect(await page.evaluate(() => window.__saver.stats.writes_failed)).toBeGreaterThan(0);
  });

  test("the download fallback tells the participant where to send the file", async ({ page }) => {
    await page.goto(DESCRIBE_URL);
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    await page.evaluate(() => window.__saver._offerDownload(null, "[]"));
    const box = page.locator("#data-saver-fallback");
    await expect(box).toBeVisible();
    await expect(box).toContainText("@");
    await expect(box).toContainText("you will be paid");
    await expect(box.getByRole("link")).toHaveAttribute("href", /^mailto:/);
  });

  test("security rules reject reads and writes to other participants, and only allow a reply to be fetched by id", async ({ page }) => {
    await page.goto(RATE_URL);
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    const pid = uniquePid("rulespid");
    await seedReply(pid, "ai");
    const replyId = replyDocId(pid);

    const results = await page.evaluate(async ({ replyId, describeId, rateId }) => {
      const s = window.__saver;
      const fb = s.fb;
      const out = {};
      const attempt = async (name, fn) => {
        try { await fn(); out[name] = "allowed"; } catch (e) { out[name] = e.code || e.message; }
      };
      await attempt("read own doc", () => fb.getDoc(fb.doc(s.db, "experiments", rateId, "participants", s.docId)));
      await attempt("write other participant", () =>
        fb.setDoc(fb.doc(s.db, "experiments", rateId, "participants", "someone-else"), { hacked: true }));
      await attempt("write other participant trials", () =>
        fb.setDoc(fb.doc(s.db, "experiments", rateId, "participants", "someone-else", "trials", "c0"), { trials: [] }));
      await attempt("write unrelated collection", () => fb.setDoc(fb.doc(s.db, "spam", "doc"), { spam: true }));
      await attempt("error doc with wrong uid", () =>
        fb.addDoc(fb.collection(s.db, "experiments", rateId, "errors"), { uid: "not-me", message: "x" }));
      await attempt("own chunk (should be allowed)", () =>
        fb.setDoc(fb.doc(s.db, "experiments", rateId, "participants", s.docId, "trials", "chunk-test"), { trials: [{ a: 1 }] }));
      await attempt("participant doc without the run suffix", () =>
        fb.setDoc(fb.doc(s.db, "experiments", rateId, "participants", s.uid), { sneaky: true }));
      await attempt("another browser's run id", () =>
        fb.setDoc(fb.doc(s.db, "experiments", rateId, "participants", "someone-else-abcd1234"), { sneaky: true }));
      // the replies collection: fetch by id is allowed; nothing else is
      await attempt("get a reply by id (should be allowed)", () => fb.getDoc(fb.doc(s.db, "experiments", rateId, "replies", replyId)));
      await attempt("write a reply", () => fb.setDoc(fb.doc(s.db, "experiments", rateId, "replies", "p-forged"), { label: "ai" }));
      await attempt("overwrite a reply", () => fb.setDoc(fb.doc(s.db, "experiments", rateId, "replies", replyId), { label: "human" }));
      out.idToken = await fb.getAuth().currentUser.getIdToken();
      return out;
    }, { replyId, describeId: DESCRIBE_ID, rateId: RATE_ID });

    expect(results["read own doc"]).toBe("permission-denied");
    expect(results["write other participant"]).toBe("permission-denied");
    expect(results["write other participant trials"]).toBe("permission-denied");
    expect(results["write unrelated collection"]).toBe("permission-denied");
    expect(results["error doc with wrong uid"]).toBe("permission-denied");
    expect(results["own chunk (should be allowed)"]).toBe("allowed");
    expect(results["participant doc without the run suffix"]).toBe("permission-denied");
    expect(results["another browser's run id"]).toBe("permission-denied");
    expect(results["get a reply by id (should be allowed)"]).toBe("allowed");
    expect(results["write a reply"]).toBe("permission-denied");
    expect(results["overwrite a reply"]).toBe("permission-denied");

    // Listing the replies collection as this participant (their own token, not the admin bypass) is refused.
    const asUser = { headers: { Authorization: `Bearer ${results.idToken}` } };
    expect((await fetch(`${FS}/experiments/${RATE_ID}/replies`, asUser)).status).toBe(403);
    expect((await fetch(`${FS}/experiments/${RATE_ID}/replies/${replyId}`, asUser)).status).toBe(200);
  });

  test("uncaught errors are logged to the errors collection", async ({ page }) => {
    await page.goto(DESCRIBE_URL);
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    const uid = await page.evaluate(() => window.__saver.uid);
    // Simulate a bug in a trial: an uncaught exception.
    await page.evaluate(() => { setTimeout(() => { throw new Error("simulated bug in trial code"); }, 0); });
    await page.waitForFunction(() => window.__saver.stats.errors_logged >= 1);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
    const errs = await fsGet(`experiments/${DESCRIBE_ID}/errors?pageSize=100`);
    const mine = (errs.body.documents || []).map((d) => decodeFields(d.fields)).filter((d) => d.uid === uid);
    expect(mine.length).toBe(1);
    expect(mine[0].message).toContain("simulated bug");
    expect(mine[0].context.kind).toBe("uncaught");
  });
});
