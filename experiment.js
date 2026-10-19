/*
 * Psych 251 replication: Yin, Jia & Wakslak (2024, PNAS), "AI can help people feel heard, but
 * an AI label diminishes this impact". Chatbot-interface version: AI-generated replies only, and
 * the label (AI vs. human) is the manipulation.
 *
 * Two sessions, like the original's Parts 1 and 3 (Part 2, the human responders, is dropped):
 *
 *   ?part=describe   SESSION 1
 *       consent -> Prolific ID -> instructions -> describe a situation in a chat box -> six
 *       emotions -> thanks
 *   (between sessions you run `npm run generate-replies`: an LLM replies to each description and
 *    the AI/human label is assigned, balanced)
 *   ?part=rate       SESSION 2
 *       consent -> Prolific ID (the page looks up that participant's description and reply) ->
 *       label page -> the reply under its label -> ratings (feeling heard, accuracy, understood,
 *       connection) -> loneliness/emotions -> mind perception -> AI attitudes -> suspicion ->
 *       demographics -> feedback -> debrief
 *
 * Testing IDs (EXPERIMENT.test_ids) skip the lookup and show a built-in sample, so a TA can try
 * Session 2 without any Session 1 data. See docs/study-design.md for the mapping to the paper.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
window.TEMPLATE_VERSION = "0.1.0";

const EXPERIMENT = {
  // Firestore path. Session 2 (rate) saves under experiments/<base_id>/..., Session 1 (describe)
  // under experiments/<base_id>-describe/.... base_id must match `experiment_id` in
  // writeup/replication-report.qmd (the report analyses Session 2). Change it when you move from
  // Pilot A to real data collection.
  base_id: "yin2024-label-pilot-a",

  // Trials per Firestore write. 1 = save every trial the moment it finishes.
  chunk_size: 1,

  // Also store the complete jsPsych dataset on the participant document at the end.
  save_full_data_at_end: true,

  // Prolific completion codes, one per session (from each Prolific study page). If set,
  // participants are redirected to Prolific when they finish. Leave empty for testing.
  completion_codes: { describe: "", rate: "" },

  // Contact shown in consent and debrief.
  contact_email: "stanfordpsych251@gmail.com",

  // The study is typed on a keyboard, so phones and tablets are turned away before consent.
  requires_keyboard: true,

  // Minimum length of the participant's description (no maximum). The original reports no length
  // rule, only that it excluded descriptions of one sentence or less; here a message shorter than
  // this cannot be sent. (The AI reply's length target, 57 words, lives in scripts/lib/reply.js.)
  min_description_words: 30,

  // Rough length shown to participants, in minutes. Update both from the Pilot A medians.
  minutes: { describe: 5, rate: 10 },

  // Testing IDs (compared without regard to case). In Session 2 they skip the lookup and show the
  // built-in sample description and reply below, with the label given here ("random" picks one).
  // Their participant records are flagged is_test = true, and scripts/generate-replies.js and the
  // report's analysis both ignore them. Give these to TAs; real Prolific IDs never look like this.
  test_ids: {
    "TA-TEST-AI": { label: "ai" },
    "TA-TEST-HUMAN": { label: "human" },
    "TA-TEST-RANDOM": { label: "random" },
  },
};

// Shown to testing IDs in Session 2 instead of a stored reply (not real participant data).
const SAMPLE_DESCRIPTION =
  "I have been going back and forth about whether to leave my current job for an offer in another city. " +
  "My manager has been supportive, but I feel stuck, and my partner would have to move with me, which worries me a lot.";
const SAMPLE_REPLY =
  "That sounds like a really hard situation to be in, and it makes sense that you feel the way you do. " +
  "There is a lot going on, and you are clearly trying to weigh several things at once. Thank you for " +
  "sharing something so personal. Whatever you decide, your feelings about it are valid, and you do not " +
  "have to figure everything out right now.";

// True on anything with a mouse, trackpad, or stylus, including laptops with touchscreens.
// False on phones and tablets without a pointing device, which are also the devices with no
// physical keyboard. See docs/student-guide.md "Devices".
function hasFinePointer() {
  return !!(
    window.matchMedia && window.matchMedia("(any-pointer: fine)").matches
  );
}

// `?emulator=1` in the URL sends data to the local emulator instead of the real project.
// Used by `npm test`; handy for development too (start it with `npm run emulators`).
const URL_PARAMS = new URLSearchParams(window.location.search);
const USE_EMULATOR = URL_PARAMS.get("emulator") === "1";
// `?chunk_size=N` overrides the setting above; used by the test suite to exercise chunked writes.
const CHUNK_SIZE =
  Number(URL_PARAMS.get("chunk_size")) || EXPERIMENT.chunk_size;
// `?part=describe` (or 1) is Session 1, `?part=rate` (or 2) is Session 2. Without it a small page
// links to both, so a participant can never land in the wrong session by accident.
const PART =
  { 1: "describe", describe: "describe", 2: "rate", rate: "rate" }[URL_PARAMS.get("part")] || null;
if (PART) {
  EXPERIMENT.id = PART === "describe" ? EXPERIMENT.base_id + "-describe" : EXPERIMENT.base_id;
  EXPERIMENT.prolific_completion_code = EXPERIMENT.completion_codes[PART] || "";
}
// Test-only: `?cc=CODE` sets a Prolific completion code during emulator runs, so the test
// suite can check the screen a participant sees once you have set yours. Ignored in live runs.
if (USE_EMULATOR && URL_PARAMS.get("cc"))
  EXPERIMENT.prolific_completion_code = URL_PARAMS.get("cc");

function showLanding() {
  const link = (part) => {
    const q = new URLSearchParams(window.location.search);
    q.set("part", part);
    return "?" + q.toString();
  };
  document.body.innerHTML =
    '<div id="landing" class="jspsych-content" style="max-width:640px;margin:12vh auto;font:16px/1.6 system-ui,sans-serif;">' +
    "<h2>Which session?</h2>" +
    "<p>Please use the exact link you were given. If you are testing, choose a session:</p>" +
    '<ul><li><a href="' + link("describe") + '">Session 1: describe a situation</a></li>' +
    '<li><a href="' + link("rate") + '">Session 2: rate a response</a> (enter a testing ID: ' +
    Object.keys(EXPERIMENT.test_ids).join(", ") + ")</li></ul>" +
    '<p>Questions: <a href="mailto:' + EXPERIMENT.contact_email + '">' + EXPERIMENT.contact_email + "</a></p></div>";
}

// ---------------------------------------------------------------------------
// Boot: connect the saver first so even a crash in the first trial gets logged.
// ---------------------------------------------------------------------------
(async function main() {
  if (!PART) {
    showLanding();
    return;
  }
  const deviceSupported = !EXPERIMENT.requires_keyboard || hasFinePointer();

  const saver = await DataSaver.init({
    experiment_id: EXPERIMENT.id,
    chunk_size: CHUNK_SIZE,
    save_full_data_at_end: EXPERIMENT.save_full_data_at_end,
    use_emulator: USE_EMULATOR,
    contact_email: EXPERIMENT.contact_email,
  });
  window.__saver = saver; // for debugging and the automated test

  // Record the device verdict on the participant document before anything else, so a
  // participant turned away below is still visible in the data rather than simply absent.
  saver.updateParticipant({
    device_supported: deviceSupported,
    requires_keyboard: EXPERIMENT.requires_keyboard,
  });

  if (!deviceSupported) {
    document.body.innerHTML =
      '<div id="device-unsupported" class="jspsych-content" style="max-width:640px;margin:15vh auto;font:16px/1.6 system-ui,sans-serif;">' +
      "<h2>Please use a computer</h2>" +
      "<p>This study needs a computer with a physical keyboard, because you will type your " +
      "answers. Phones and tablets cannot be used.</p>" +
      "<p>Please reopen this link on a laptop or desktop computer. If you were sent here from " +
      "Prolific, you can return the study and take it later on a computer; nothing has been recorded " +
      "against you.</p>" +
      '<p>Questions: <a href="mailto:' +
      EXPERIMENT.contact_email +
      '">' +
      EXPERIMENT.contact_email +
      "</a></p></div>";
    return;
  }

  const jsPsych = initJsPsych({
    show_progress_bar: true,
    auto_update_progress_bar: true,
    on_data_update: (trial) => saver.onTrial(trial),
    on_finish: async () => {
      const el = jsPsych.getDisplayElement();
      el.innerHTML =
        '<div id="finish-message"><p class="thanks">Saving your responses…</p></div>';
      // finish() flushes remaining trials, marks the participant complete, and (only if
      // saving failed) appends a download-fallback box to the display element.
      const result = await saver.finish(jsPsych);
      const consentRow = jsPsych.data
        .get()
        .filter({ task: "consent" })
        .values()[0];
      const consented = !consentRow || consentRow.consented !== false;
      const msg = document.getElementById("finish-message");

      if (!consented) {
        msg.innerHTML =
          "<h2 class='thanks'>Thank you</h2><p class='thanks'>You chose not to participate. " +
          "You may close this window" +
          (EXPERIMENT.prolific_completion_code
            ? " and return the study on Prolific"
            : "") +
          ".</p>";
        return;
      }
      if (result.ok && EXPERIMENT.prolific_completion_code && !USE_EMULATOR) {
        msg.innerHTML =
          "<p class='thanks'>Saved. Returning you to Prolific…</p>";
        window.location.href =
          "https://app.prolific.com/submissions/complete?cc=" +
          EXPERIMENT.prolific_completion_code;
        return;
      }
      // In emulator/test runs we stay on the page instead of navigating to Prolific, so that
      // setting a completion code can never turn `npm test` or CI red. Live runs redirect above.
      msg.innerHTML =
        "<h2 class='thanks'>All done</h2>" +
        (result.ok
          ? "<p class='thanks'>Your responses were saved. Thank you for participating!</p>"
          : "") +
        (EXPERIMENT.prolific_completion_code
          ? "<p class='thanks'>Your completion code is <strong>" +
            EXPERIMENT.prolific_completion_code +
            "</strong>.</p>"
          : "");
    },
  });

  // Record the participant id and URL parameters on every trial row.
  jsPsych.data.addProperties({
    // Must be the run-scoped document id, so trial rows join to participants.csv on export.
    participant_id: saver.docId,
    prolific_pid: saver.params.PROLIFIC_PID || null,
    experiment_id: EXPERIMENT.id,
  });

  jsPsych.data.addProperties({ session: PART });

  // Shared state. In Session 2 the lookup fills `reply` with the participant's stored description,
  // reply and label ("ai" or "human"); everything that depends on the label reads it from here at
  // run time, because the label is not known when the page loads.
  const state = { pid: null, reply: null };
  const isAI = () => !!state.reply && state.reply.condition === "ai";

  // Prolific IDs are compared without regard to case or surrounding spaces. The reply document is
  // named by a hash of the ID, so the browser can fetch exactly its own (same formula as
  // scripts/lib/reply.js).
  const normalizePid = (s) => String(s || "").trim().toLowerCase();
  async function replyDocId(pid) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizePid(pid)));
    return "p-" + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const findTestFixture = (pid) => {
    const key = Object.keys(EXPERIMENT.test_ids).find((k) => normalizePid(k) === normalizePid(pid));
    return key ? EXPERIMENT.test_ids[key] : null;
  };

  // -------------------------------------------------------------------------
  // Helpers: label wording, SurveyJS matrix questions, scale scoring
  // -------------------------------------------------------------------------
  // The only thing the label changes in the materials: who the responder is called.
  const responder = () => (isAI() ? "the AI chatbot" : "the other participant"); // mid-sentence
  const Responder = () => (isAI() ? "The AI chatbot" : "The other participant"); // sentence start

  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  // Scale columns: the number, with its anchor label (if the SI gives one) on a second line under it.
  const scaleCols = (a, b, anchors = {}) =>
    range(a, b).map((v) => ({ value: v, text: anchors[v] ? `${v}\n${anchors[v]}` : String(v) }));
  const COLS_NOT_VERY = scaleCols(1, 7, { 1: "Not at all", 7: "Very much" });
  const COLS_AGREE = scaleCols(1, 7, {
    1: "Strongly disagree", 2: "Disagree", 3: "Somewhat disagree", 4: "Neither disagree nor agree",
    5: "Somewhat agree", 6: "Agree", 7: "Strongly agree",
  });
  const COLS_FREQ = scaleCols(1, 6, { 1: "Never", 2: "Very rarely", 3: "Rarely", 4: "Occasionally", 5: "Often", 6: "Most of the time" });
  const COLS_USE = scaleCols(1, 7, { 1: "Never", 7: "All the time" });
  const COLS_ATTITUDE = scaleCols(-3, 3, { "-3": "Very negative", 0: "Neutral", 3: "Very positive" });

  // One SurveyJS matrix question: `rows` is [[name, text], ...]. Nothing is required, because the
  // consent text promises participants may decline any question.
  const matrix = (name, title, rows, columns) => ({
    type: "matrix",
    name,
    title,
    columns,
    rows: rows.map(([value, text]) => ({ value, text })),
    alternateRows: true,
  });
  const html = (name, content) => ({ type: "html", name, html: content });
  const surveyOf = (pages) => ({
    showQuestionNumbers: "off",
    completeText: "Continue",
    pages,
  });

  // Mean of the named items, or null unless every one was answered (a scale score needs them all).
  const scaleMean = (obj, names) => {
    const v = names.map((n) => (obj && obj[n] != null ? Number(obj[n]) : NaN));
    return v.every(Number.isFinite)
      ? v.reduce((a, b) => a + b, 0) / v.length
      : null;
  };
  const lastData = (task) =>
    jsPsych.data.get().filter({ task }).last(1).values()[0];

  // -------------------------------------------------------------------------
  // 1. Consent (course-wide IRB text; edit only the contact address)
  // -------------------------------------------------------------------------
  const consent = {
    type: jsPsychHtmlButtonResponse,
    stimulus: `
      <div class="consent">
        <h2>Consent</h2>
        <p>By answering the following questions, you are participating in a study being performed by
        cognitive scientists in the Stanford Department of Psychology. If you have questions about
        this research, please contact us at <a href="mailto:${EXPERIMENT.contact_email}">${EXPERIMENT.contact_email}</a>.
        You must be at least 18 years old to participate. Your participation in this research is
        voluntary. You may decline to answer any or all of the following questions. You may decline
        further participation, at any time, without adverse consequences. Your anonymity is assured;
        the researchers who have requested your participation will not receive any personal
        information about you.</p>
      </div>`,
    choices: ["I agree to participate", "I do not agree"],
    data: { task: "consent" },
    on_finish: (data) => {
      data.consented = data.response === 0;
      if (!data.consented) {
        // No end message here: jsPsych would paint it over the screen that on_finish renders.
        jsPsych.abortExperiment();
      }
    },
  };

  // -------------------------------------------------------------------------
  // 1b. Prolific ID, asked right after consent (needed to approve and pay)
  // -------------------------------------------------------------------------
  // A Prolific ID is an identifier: it must never reach trials.csv, which is committed. So the
  // answer is written only to the participant document's `prolific_pid`, which scripts/export.js
  // moves to the gitignored identifiers.csv, and is removed from the trial row. When Prolific
  // already supplied the ID in the URL, that value stays authoritative and the typed one is only
  // compared with it (prolific_id_matches_url).
  const prolificId = {
    type: jsPsychSurvey,
    survey_json: {
      showQuestionNumbers: "off",
      completeText: "Continue",
      pages: [
        {
          elements: [
            {
              type: "text",
              name: "prolific_id",
              title:
                "Please enter your Prolific ID. We need it only to approve your submission and pay you; " +
                "it is stored separately from your answers.",
              // Prefilled when Prolific put the ID in the URL. Required: it is how a submission is
              // matched to a payment and reported in the final study's identifiers file.
              isRequired: true,
              requiredErrorText: "Please enter your Prolific ID to continue.",
              defaultValue: saver.params.PROLIFIC_PID || undefined,
              placeholder: "Your Prolific ID",
            },
          ],
        },
      ],
    },
    data: { task: "prolific_id" },
    on_finish: (data) => {
      const typed = String((data.response && data.response.prolific_id) || "").trim();
      const fromUrl = saver.params.PROLIFIC_PID || null;
      // The URL value is authoritative when Prolific supplied one; otherwise what was typed.
      state.pid = fromUrl || typed;
      data.prolific_id_given = typed.length > 0;
      if (fromUrl) data.prolific_id_matches_url = typed === fromUrl;
      if (typed && !fromUrl) saver.updateParticipant({ prolific_pid: typed });
      if (findTestFixture(state.pid)) {
        saver.updateParticipant({ is_test: true });
        jsPsych.data.addProperties({ is_test: true });
      }
      // The ID is required, so prolific_id_given is true for everyone who got past this page.
      delete data.response; // keep the ID itself out of the trial data
    },
  };

  // -------------------------------------------------------------------------
  // 2. Instructions (Part 1 text from the SI, adapted from audio to typing)
  // -------------------------------------------------------------------------
  const instructions = {
    type: jsPsychInstructions,
    pages: [
      `<h2>Welcome</h2>
       <p>In this study you will describe a situation from your own life in a chat window and answer
       some questions about how you felt. We are interested in how people understand each other. It
       takes about ${EXPERIMENT.minutes.describe} minutes. Later you may be invited to a second short study.</p>
       <p>Please complete the study in one sitting, in a quiet place, on a laptop or desktop computer.
       Use the buttons or the arrow keys to move between pages.</p>`,
      `<p>Please take a moment to think about a complex situation that you are grappling with. This
       might involve a challenging decision or issue in either your personal or professional life,
       characterized by numerous interwoven factors. You might be dealing with an interpersonal
       conflict involving colleagues, family members, or friends, and are uncertain about the best
       course of action. You might be wrestling with a profound question or thought.</p>
       <p>On the next page, you will be asked to type a message to tell us about the situation. Provide
       as many details as possible; for example, tell us what happened, what you think and feel, and
       any other details that are relevant to the situation.</p>
       <p>Before moving to the next page, please take a moment to identify in your mind the situation
       you would like to discuss.</p>`,
    ],
    show_clickable_nav: true,
    data: { task: "instructions" },
  };

  // -------------------------------------------------------------------------
  // 3. Describe the situation (chat), then 4. rate own emotions
  // -------------------------------------------------------------------------
  const describe = {
    type: jsPsychChatDescribe,
    header: "Study chat",
    assistant_name: "Study",
    intro: [
      "Now please tell us about the complex situation you are currently grappling with. Please describe the " +
        "situation the way you would as if you are discussing the situation with someone. Provide as many " +
        "details as possible.",
      "Don't worry about sounding perfect or smooth. Just imagine you're discussing your circumstances with " +
        "someone you are confiding in. All data shared will be kept anonymous.",
    ],
    placeholder: "Type your message here...",
    send_label: "Send",
    min_words: EXPERIMENT.min_description_words,
    data: { task: "describe" },
  };

  const EMOTIONS_6 = [
    "Happiness",
    "Sadness",
    "Fear",
    "Anger",
    "Surprise",
    "Disgust",
  ];
  const emotionsSelf = {
    type: jsPsychSurvey,
    survey_json: surveyOf([
      {
        elements: [
          matrix(
            "emotion",
            "In the situation you just described, how much did you feel the following emotions?",
            EMOTIONS_6.map((e) => [e.toLowerCase(), e]),
            COLS_NOT_VERY,
          ),
        ],
      },
    ]),
    data: { task: "emotions_self" },
  };

  // Session 1 ends here: no reply, no label, no debrief yet (the reveal comes at the end of Session 2).
  const thanksDescribe = {
    type: jsPsychHtmlButtonResponse,
    stimulus: `<h2>Thank you</h2>
      <p>You have finished this part. Press the button to save your responses. We may invite you to a
      second short study through Prolific.</p>`,
    choices: ["Finish"],
    data: { task: "thanks" },
  };

  // -------------------------------------------------------------------------
  // 5. Session 2: find the participant's stored reply, then the label manipulation
  // -------------------------------------------------------------------------
  // Looks up the description, reply and label stored for state.pid. Testing IDs use the built-in
  // sample instead. Never throws: a failure just means "not found" and the participant can retry.
  async function lookupReply() {
    let found = null, source = null, error = null;
    try {
      const fixture = findTestFixture(state.pid);
      if (fixture) {
        const label = fixture.label === "random"
          ? jsPsych.randomization.sampleWithoutReplacement(["ai", "human"], 1)[0] : fixture.label;
        found = { condition: label, description: SAMPLE_DESCRIPTION, reply_text: SAMPLE_REPLY, model: null, describe_participant_id: null };
        source = "test_fixture";
      } else {
        if (saver.mode === "offline") throw new Error("no connection to the database");
        const ref = saver.fb.doc(saver.db, "experiments", EXPERIMENT.id, "replies", await replyDocId(state.pid));
        const snap = await saver.fb.getDoc(ref);
        if (snap.exists()) {
          const d = snap.data();
          if ((d.label === "ai" || d.label === "human") && d.description && d.reply_text) {
            found = { condition: d.label, description: d.description, reply_text: d.reply_text, model: d.model || null, describe_participant_id: d.describe_participant_id || null };
            source = "pregenerated";
          } else error = "reply document incomplete";
        }
      }
    } catch (e) {
      error = String((e && e.message) || e);
    }
    state.reply = found ? { ...found, source } : null;
    if (found) {
      // From here on every row carries the label, and the participant document records it.
      jsPsych.data.addProperties({ condition: found.condition, describe_participant_id: found.describe_participant_id });
      saver.updateParticipant({
        condition: found.condition, reply_source: source, reply_model: found.model,
        describe_participant_id: found.describe_participant_id,
      });
    }
    return { found: !!found, reply_source: source, error };
  }

  const lookupStep = {
    type: jsPsychAsyncStep,
    message: "Looking up your earlier response...",
    run: lookupReply,
    data: { task: "reply_lookup" },
  };
  const notFound = {
    type: jsPsychHtmlButtonResponse,
    stimulus: `<p>We could not find your earlier response for this Prolific ID. Please check that it is
      exactly the ID you used in the first study and try again. If it still does not work, contact
      <a href="mailto:${EXPERIMENT.contact_email}">${EXPERIMENT.contact_email}</a>.</p>`,
    choices: ["Try again"],
    data: { task: "reply_not_found" },
  };
  // Ask for the ID, look the reply up, and repeat until it is found.
  const findReply = {
    timeline: [prolificId, lookupStep, { timeline: [notFound], conditional_function: () => !state.reply }],
    loop_function: () => !state.reply,
  };

  // The wording follows the SI's Part 3 text ("In an earlier study, we asked you to ...").
  const labelIntro = {
    type: jsPsychHtmlButtonResponse,
    stimulus: () =>
      isAI()
        ? `<p>In an earlier study, we asked you to describe a complex situation that you are grappling
           with. What you wrote was presented to an AI chatbot (a large language model). We asked the
           chatbot to respond to what you said.</p>
           <p>On the next page, we will show you what you said, along with the AI chatbot's response
           to what you said. We are interested in your impressions of the response.</p>`
        : `<p>In an earlier study, we asked you to describe a complex situation that you are grappling
           with. What you wrote was presented to another participant on Prolific. We asked the
           participant to respond to what you said.</p>
           <p>On the next page, we will show you what you said, along with another Prolific
           participant's response to what you said. We are interested in your impressions of the response.</p>`,
    choices: ["Continue"],
    data: { task: "label_intro" },
  };

  // The stored reply, shown as a chat transcript under the assigned label. Nothing is "typed" live:
  // the reply was written before this session, and is identical in kind for both labels.
  const replyView = {
    type: jsPsychHtmlButtonResponse,
    stimulus: () => ChatUI.transcriptHtml(state.reply.description, state.reply.reply_text, state.reply.condition),
    choices: ["Continue to questions"],
    // Do not save the page HTML: it contains the participant's description, which already lives in
    // Session 1 (reply_text below is the reply, saved on purpose).
    save_trial_parameters: { stimulus: false },
    data: { task: "reply" },
    on_finish: (data) => {
      data.responder_kind = state.reply.condition;
      data.reply_text = state.reply.reply_text;
      data.reply_n_words = ChatUI.countWords(state.reply.reply_text);
      data.reply_source = state.reply.source;
      data.reply_model = state.reply.model;
    },
  };

  // -------------------------------------------------------------------------
  // 7. Main dependent variables (SI "Part 3 Survey Questions"), response shown above
  // -------------------------------------------------------------------------
  const HEARD_ITEMS = [
    "understood",
    "validated",
    "affirmed",
    "seen",
    "accepted",
    "cared_for",
  ];
  const agreeRows = () => [
    ...HEARD_ITEMS.map((k) => [
      "heard_" + k,
      `Reading this response makes me feel ${k.replace("_", " ")}.`,
    ]),
    ["accuracy_captures", "The response accurately captures what I mean."],
    ["accuracy_summarizes", "The response correctly summarizes what I said."],
    ["understood_knew", `${Responder()} knew exactly what I meant.`],
    [
      "understood_thinking",
      `${Responder()} understood what I was thinking and feeling.`,
    ],
  ];
  const connectRows = () => [
    ["close", `How close do you feel to ${responder()}?`],
    ["connected", `How connected do you feel to ${responder()}?`],
    ["trust", `How much do you feel you trust ${responder()}?`],
  ];
  const ratings = {
    type: jsPsychSurvey,
    survey_json: () => {
      return surveyOf([
        {
          elements: [
            html(
              "exchange",
              ChatUI.exchangeHtml(state.reply.description, state.reply.reply_text, state.reply.condition),
            ),
            matrix(
              "agree",
              "We are interested in how you think of the response above. Please indicate the extent to which you agree with the following statements.",
              agreeRows(),
              COLS_AGREE,
            ),
            matrix(
              "connect",
              "How do you feel about " + responder() + "?",
              connectRows(),
              COLS_NOT_VERY,
            ),
          ],
        },
      ]);
    },
    data: { task: "ratings" },
    on_finish: (data) => {
      const a = data.response.agree || {},
        c = data.response.connect || {};
      // Composites as in the original: feeling heard (6 items), accuracy (2), understood (2), connection (3).
      data.feeling_heard = scaleMean(
        a,
        HEARD_ITEMS.map((k) => "heard_" + k),
      );
      data.response_accuracy = scaleMean(a, [
        "accuracy_captures",
        "accuracy_summarizes",
      ]);
      data.responder_understood = scaleMean(a, [
        "understood_knew",
        "understood_thinking",
      ]);
      data.connection = scaleMean(c, ["close", "connected", "trust"]);
    },
  };

  // -------------------------------------------------------------------------
  // 8. Exploratory: loneliness and emotions
  // -------------------------------------------------------------------------
  const EMOTIONS_19 = [
    "distressed",
    "excited",
    "upset",
    "guilty",
    "scared",
    "enthusiastic",
    "ashamed",
    "nervous",
    "happy",
    "sad",
    "surprised",
    "hopeful",
    "optimistic",
    "ambivalent",
    "uneasy",
    "unnerved",
    "creeped out",
    "uncomfortable",
    "bothered",
  ];
  const feelings = {
    type: jsPsychSurvey,
    survey_json: surveyOf([
      {
        elements: [
          matrix(
            "state_loneliness",
            "Please answer for how you feel right now.",
            [
              ["lonely", "How lonely do you feel right now?"],
              [
                "connected_others",
                "How connected do you feel to others right now?",
              ],
            ],
            COLS_NOT_VERY,
          ),
          matrix(
            "emotion_now",
            "To what extent do you feel the following right now?",
            EMOTIONS_19.map((e) => [e.replace(" ", "_"), e]),
            COLS_NOT_VERY,
          ),
          matrix(
            "trait_loneliness",
            "The next set of questions is about how often you have certain feelings generally in life.",
            [
              [
                "companionship",
                "How often do you feel that you lack companionship?",
              ],
              ["left_out", "How often do you feel left out?"],
              ["isolated", "How often do you feel isolated from others?"],
            ],
            COLS_FREQ,
          ),
        ],
      },
    ]),
    data: { task: "feelings" },
  };

  // -------------------------------------------------------------------------
  // 9. Mind perception of the responder (moderator), 10. attitudes to AI (moderator)
  // -------------------------------------------------------------------------
  // The 18 mental capacities from the SI. Agency / experience grouping follows Gray, Gray &
  // Wegner (2007), the scale the paper cites (ref. 45); the paper does not list the mapping.
  const MIND_ITEMS = [
    ["conveying", "capable of conveying thoughts or feelings", "agency"],
    [
      "experiences",
      "capable of having experiences and being aware of things",
      "experience",
    ],
    ["longing", "capable of longing or hoping for things", "experience"],
    ["embarrassment", "capable of experiencing embarrassment", "experience"],
    [
      "understanding_others",
      "capable of understanding how others are feeling",
      "agency",
    ],
    ["fear", "capable of feeling afraid or fearful", "experience"],
    ["hunger", "capable of feeling hungry", "experience"],
    ["joy", "capable of experiencing joy", "experience"],
    ["memory", "capable of remembering things", "agency"],
    [
      "morality",
      "capable of telling right from wrong and trying to do the right thing",
      "agency",
    ],
    [
      "pain",
      "capable of experiencing physical or emotional pain",
      "experience",
    ],
    [
      "personality",
      "capable of having personality traits that make it unique from others",
      "experience",
    ],
    ["planning", "capable of making plans and working toward goal", "agency"],
    [
      "pleasure",
      "capable of experiencing physical or emotional pleasure",
      "experience",
    ],
    ["pride", "capable of experiencing pride", "experience"],
    [
      "anger",
      "capable of experiencing violent or uncontrolled anger",
      "experience",
    ],
    [
      "self_restraint",
      "capable of exercising self-restraint over desires, emotions, or impulses",
      "agency",
    ],
    ["thinking", "capable of thinking", "agency"],
  ];
  const mindPerception = {
    type: jsPsychSurvey,
    survey_json: surveyOf([
      {
        elements: [
          matrix(
            "mind",
            "We are interested in how you think of AI chatbots, chatbots that generate their responses using a large language model (LLM), such as ChatGPT. Please indicate your level of agreement with the following statements. There are no right or wrong answers; we are just interested in what you think. Please indicate the extent to which you agree or disagree that an AI chatbot has the following mental capacities.",
            MIND_ITEMS.map(([k, t]) => [k, t]),
            COLS_AGREE,
          ),
        ],
      },
    ]),
    data: { task: "mind_perception" },
    on_finish: (data) => {
      const m = data.response.mind || {};
      const of = (dim) =>
        scaleMean(
          m,
          MIND_ITEMS.filter((i) => i[2] === dim).map((i) => i[0]),
        );
      data.mind_agency = of("agency");
      data.mind_experience = of("experience");
    },
  };

  // Bing Chat and Bard in the original are replaced by their current names.
  const AI_NAMES = [
    ["chatgpt", "ChatGPT"],
    ["copilot", "Microsoft Copilot (formerly Bing Chat)"],
    ["gemini", "Google Gemini (formerly Bard)"],
  ];
  const aiAttitudes = {
    type: jsPsychSurvey,
    survey_json: surveyOf([
      {
        elements: [
          matrix(
            "familiar",
            "To what extent are you familiar with the following generative AI?",
            AI_NAMES,
            COLS_NOT_VERY,
          ),
          matrix(
            "use",
            "How often do you use the following generative AI in your personal and professional life?",
            AI_NAMES,
            COLS_USE,
          ),
          matrix(
            "attitude",
            "What is your general attitude towards the following generative AI?",
            AI_NAMES,
            COLS_ATTITUDE,
          ),
        ],
      },
    ]),
    data: { task: "ai_attitudes" },
  };

  // -------------------------------------------------------------------------
  // 11. Suspicion (manipulation check), asked about the impressions given earlier
  // -------------------------------------------------------------------------
  const suspicion = {
    type: jsPsychSurvey,
    survey_json: () => surveyOf([
      {
        elements: [
          html(
            "intro",
            "<p>We are interested in your thoughts on the response when you were reporting your impressions of the response, before you saw the last sets of questions about generative AI.</p>",
          ),
          {
            type: "rating",
            name: "suspicion",
            rateValues: range(1, 7),
            minRateDescription: "Not at all",
            maxRateDescription: "Very much",
            title: isAI()
              ? "When reporting your impressions of the response, how much did you suspect that the response you received was actually from another human participant rather than from an AI chatbot?"
              : "When reporting your impressions of the response, how much did you suspect that the response you received was actually from an AI chatbot rather than from another human participant?",
          },
        ],
      },
    ]),
    data: { task: "suspicion" },
    on_finish: (data) => {
      data.suspicion =
        data.response.suspicion == null
          ? null
          : Number(data.response.suspicion);
    },
  };

  // -------------------------------------------------------------------------
  // 12. Demographics, feedback, debrief
  // -------------------------------------------------------------------------
  const demographics = {
    type: jsPsychSurvey,
    survey_json: {
      showQuestionNumbers: "off",
      completeText: "Continue",
      pages: [
        {
          elements: [
            // The consent text promises participants may decline any question, so nothing here is required.
            {
              type: "text",
              name: "age",
              title: "How old are you?",
              inputType: "number",
              min: 18,
              max: 120,
            },
            {
              type: "radiogroup",
              name: "gender",
              title: "What is your gender?",
              choices: ["Woman", "Man", "Non-binary"],
              showOtherItem: true,
              showNoneItem: true,
              noneText: "Prefer not to say",
            },
            {
              type: "radiogroup",
              name: "race",
              title: "What is your race or ethnicity?",
              choices: [
                "White",
                "Black",
                "Asian",
                "Hispanic",
                "Native American",
                "Mixed race",
              ],
              showOtherItem: true,
              showNoneItem: true,
              noneText: "Prefer not to say",
            },
          ],
        },
      ],
    },
    data: { task: "demographics" },
  };

  const feedback = {
    type: jsPsychSurveyLikert,
    questions: [
      {
        prompt: "How clear were the instructions?",
        name: "instructions_clear",
        required: false,
        labels: ["Very unclear", "Unclear", "Neutral", "Clear", "Very clear"],
      },
    ],
    data: { task: "feedback_likert" },
  };
  const comments = {
    type: jsPsychSurveyText,
    questions: [
      {
        prompt: "Any comments about the study? (optional)",
        name: "comments",
        rows: 4,
      },
    ],
    data: { task: "feedback_text" },
  };

  // The debrief discloses the deception: every response was written by an AI chatbot, whatever
  // the label said. Replace/extend with the class debrief text from the Prolific guidelines page.
  const debrief = {
    type: jsPsychHtmlButtonResponse,
    stimulus: `
      <div class="debrief">
      <h2>Debrief</h2>
      <p>Thank you. In this study we tested whether people feel less heard when they are told that a
      response comes from an AI than when they are told it comes from a human, even when the response is
      the same. <strong>Every response you saw was written by an AI chatbot, whichever source you were
      told.</strong> Some participants were told the response came from another Prolific participant and
      others that it came from an AI chatbot, assigned at random. No other participant read what you wrote.
      We are sorry that we could not tell you this beforehand: knowing the true source would have defeated
      the purpose of the study.</p>
      <p>What you wrote was sent to an AI service only to generate the response, and is stored without
      your name. If thinking about the situation you described was upsetting, please consider talking to
      someone you trust or a counselor; in the US you can call or text 988. If you have questions about
      this research, contact <a href="mailto:${EXPERIMENT.contact_email}">${EXPERIMENT.contact_email}</a>.
      Press the button to save your responses and finish.</p>
      </div>`,
    choices: ["Finish"],
    data: { task: "debrief" },
  };

  if (PART === "describe") {
    await jsPsych.run([consent, prolificId, instructions, describe, emotionsSelf, thanksDescribe]);
  } else {
    await jsPsych.run([
      consent,
      findReply,
      labelIntro,
      replyView,
      ratings,
      feelings,
      mindPerception,
      aiAttitudes,
      suspicion,
      demographics,
      feedback,
      comments,
      debrief,
    ]);
  }
})();
