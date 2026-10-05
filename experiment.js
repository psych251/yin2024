/*
 * Partial replication of Yin, Jia & Wakslak (2024, PNAS): "AI can help people feel heard, but
 * an AI label diminishes this impact". Only the label effect is replicated, not the 2 x 2.
 *
 * Design summary
 *   - Independent variable: response label, "ai" vs "human"; between-subjects, random 50/50
 *     assignment. Recorded as `condition` on every row and on the participant document.
 *   - Everyone reads the same standardized situation and the same fixed response. Only the
 *     sentence introducing the response differs between conditions.
 *   - Dependent measures (SI Appendix, "Part 3 Survey Questions", pp. 17-19), 7-point
 *     agreement scale, one page, items in the SI order, no randomization:
 *       feeling heard (primary): 6 items -> `feeling_heard` (mean, only if all 6 answered)
 *       response accuracy:       2 items -> `response_accuracy`
 *       responder understanding: 2 items -> `responder_understood`
 *   - Manipulation check, after all outcomes: the SI suspicion item, 1-7 -> `suspicion`.
 *   - Demographics last, with the categories the paper reports (Methods, p. 8).
 *   - One stimulus, so one rating trial per participant. Trial rows: consent, instructions,
 *     ratings, suspicion, demographics, debrief.
 *   - Exclusions: none beyond consent and a computable `feeling_heard`. The analysis (in
 *     writeup/replication-report.qmd) applies that rule; nothing is dropped here.
 *
 * Settings and the demographics page are the parts most likely to need editing. Everything
 * below the settings is wired to DataSaver (src/save.js), which writes to your Firebase project.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
window.TEMPLATE_VERSION = "0.1.0";

const EXPERIMENT = {
  // Firestore path: experiments/<id>/participants/... Change it when you start a new study
  // so pilot data and real data never mix (e.g. "smith2016-pilot-a", "smith2016-final").
  id: "yin2024-label-pilot-a",

  // Trials per Firestore write. 1 = save every trial the moment it finishes (dropouts leave
  // partial data). There are only six trials, so about 10 writes per participant.
  chunk_size: 1,

  // Also store the complete jsPsych dataset on the participant document at the end.
  // Costs one extra write and makes export robust; turn off if trials are very large.
  save_full_data_at_end: true,

  // Prolific: if set, participants are redirected to Prolific when they finish.
  // Leave empty for local testing or non-Prolific samples.
  prolific_completion_code: "",

  // Contact shown in consent and debrief.
  contact_email: "stanfordpsych251@gmail.com",

  // This study is answered entirely with buttons and clicks, so no physical keyboard is
  // needed and phones and tablets are allowed.
  requires_keyboard: false,
};

// True on anything with a mouse, trackpad, or stylus, including laptops with touchscreens.
// False on phones and tablets without a pointing device, which are also the devices with no
// physical keyboard. See docs/student-guide.md "Devices".
function hasFinePointer() {
  return !!(window.matchMedia && window.matchMedia("(any-pointer: fine)").matches);
}

// `?emulator=1` in the URL sends data to the local emulator instead of the real project.
// Used by `npm test`; handy for development too (start it with `npm run emulators`).
const URL_PARAMS = new URLSearchParams(window.location.search);
const USE_EMULATOR = URL_PARAMS.get("emulator") === "1";
// `?chunk_size=N` overrides the setting above; used by the test suite to exercise chunked writes.
const CHUNK_SIZE = Number(URL_PARAMS.get("chunk_size")) || EXPERIMENT.chunk_size;
// Test-only: `?cc=CODE` sets a Prolific completion code during emulator runs, so the test
// suite can check the screen a participant sees once you have set yours. Ignored in live runs.
if (USE_EMULATOR && URL_PARAMS.get("cc")) EXPERIMENT.prolific_completion_code = URL_PARAMS.get("cc");

// ---------------------------------------------------------------------------
// Boot: connect the saver first so even a crash in the first trial gets logged.
// ---------------------------------------------------------------------------
(async function main() {
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
  saver.updateParticipant({ device_supported: deviceSupported, requires_keyboard: EXPERIMENT.requires_keyboard });

  if (!deviceSupported) {
    document.body.innerHTML =
      '<div id="device-unsupported" class="jspsych-content" style="max-width:640px;margin:15vh auto;font:16px/1.6 system-ui,sans-serif;">' +
      "<h2>Please use a computer</h2>" +
      "<p>This study needs a computer with a physical keyboard, because part of it is answered " +
      "by pressing keys. Phones and tablets cannot be used.</p>" +
      "<p>Please reopen this link on a laptop or desktop computer. If you were sent here from " +
      "Prolific, you can return the study and take it later on a computer; nothing has been recorded " +
      "against you.</p>" +
      "<p>Questions: <a href=\"mailto:" + EXPERIMENT.contact_email + "\">" + EXPERIMENT.contact_email + "</a></p></div>";
    return;
  }

  const jsPsych = initJsPsych({
    show_progress_bar: true,
    auto_update_progress_bar: true,
    on_data_update: (trial) => saver.onTrial(trial),
    on_finish: async () => {
      const el = jsPsych.getDisplayElement();
      el.innerHTML = '<div id="finish-message"><p class="thanks">Saving your responses…</p></div>';
      // finish() flushes remaining trials, marks the participant complete, and (only if
      // saving failed) appends a download-fallback box to the display element.
      const result = await saver.finish(jsPsych);
      const consentRow = jsPsych.data.get().filter({ task: "consent" }).values()[0];
      const consented = !consentRow || consentRow.consented !== false;
      const msg = document.getElementById("finish-message");

      if (!consented) {
        msg.innerHTML = "<h2 class='thanks'>Thank you</h2><p class='thanks'>You chose not to participate. " +
          "You may close this window" + (EXPERIMENT.prolific_completion_code ? " and return the study on Prolific" : "") + ".</p>";
        return;
      }
      if (result.ok && EXPERIMENT.prolific_completion_code && !USE_EMULATOR) {
        msg.innerHTML = "<p class='thanks'>Saved. Returning you to Prolific…</p>";
        window.location.href =
          "https://app.prolific.com/submissions/complete?cc=" + EXPERIMENT.prolific_completion_code;
        return;
      }
      // In emulator/test runs we stay on the page instead of navigating to Prolific, so that
      // setting a completion code can never turn `npm test` or CI red. Live runs redirect above.
      msg.innerHTML =
        "<h2 class='thanks'>All done</h2>" +
        (result.ok ? "<p class='thanks'>Your responses were saved. Thank you for participating!</p>" : "") +
        (EXPERIMENT.prolific_completion_code
          ? "<p class='thanks'>Your completion code is <strong>" + EXPERIMENT.prolific_completion_code + "</strong>.</p>"
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

  // Random assignment to a between-subjects condition, recorded on every trial and on the
  // participant document. (For exact 50/50 balance you would need a server; random
  // assignment is fine at course sample sizes.)
  const CONDITIONS = ["ai", "human"];
  // Test-only: `?condition=ai|human` fixes the assignment during emulator runs so the test
  // suite can check both labels. Ignored in live runs, where assignment is always random.
  const forced = USE_EMULATOR && CONDITIONS.includes(URL_PARAMS.get("condition")) ? URL_PARAMS.get("condition") : null;
  const condition = forced || jsPsych.randomization.sampleWithoutReplacement(CONDITIONS, 1)[0];
  jsPsych.data.addProperties({ condition: condition });
  saver.updateParticipant({ condition: condition });

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
  // 2. Instructions (DRAFT wording: edit to taste)
  // -------------------------------------------------------------------------
  const instructions = {
    type: jsPsychInstructions,
    pages: [
      `<h2>Welcome</h2>
       <p>In this short study you will read a description of a situation and a response to it.
       You will then answer some questions about your impressions of the response. It takes
       about five minutes.</p>`,
      `<p>Please imagine yourself in the situation described, and imagine that you described
       it to the responder, who then wrote the response you will read. Please complete the study
       in one sitting. Use the buttons to move between pages.</p>`,
    ],
    show_clickable_nav: true,
    data: { task: "instructions" },
  };

  // -------------------------------------------------------------------------
  // 3. Situation, label, response and the outcome ratings (one page)
  // -------------------------------------------------------------------------
  const SITUATION =
    "Imagine that you have been working very hard on an important project at work. You spent " +
    "several weeks preparing it and believed you had done a good job. You were hoping that " +
    "doing well on the project would help you be considered for a new opportunity at work. " +
    "Today, your manager told you that although your work was appreciated, someone else had " +
    "been selected for the opportunity. You feel disappointed because you put a lot of effort " +
    "into the project and had been looking forward to taking on more responsibility. You are " +
    "also unsure what this means for your future at the organization.";
  const RESPONSE =
    "It sounds like this was really disappointing, especially after you put so much time and " +
    "effort into the project and were hoping it would lead to a new opportunity. It makes " +
    "sense that you would feel discouraged and uncertain about what this means for your " +
    "future. You clearly cared a lot about doing well, so hearing that someone else was " +
    "selected could make the outcome feel especially difficult.";
  // The label manipulation: the only thing that differs between conditions.
  const LABEL_SENTENCE = {
    ai: "The following response was generated by an AI system.",
    human: "The following response was written by another participant.",
  };
  // The two responder-understanding items name the responder, as in the original.
  const RESPONDER = { ai: "The AI system", human: "The other participant" };

  // Items from the SI Appendix, Part 3 (pp. 18-19), in the order listed there. `scale` names
  // the measure each item belongs to; the key is the data field.
  const RATING_ITEMS = [
    { value: "fh_understood", scale: "fh", text: "Reading this response makes me feel understood." },
    { value: "fh_validated", scale: "fh", text: "Reading this response makes me feel validated." },
    { value: "fh_affirmed", scale: "fh", text: "Reading this response makes me feel affirmed." },
    { value: "fh_seen", scale: "fh", text: "Reading this response makes me feel seen." },
    { value: "fh_accepted", scale: "fh", text: "Reading this response makes me feel accepted." },
    { value: "fh_cared_for", scale: "fh", text: "Reading this response makes me feel cared for." },
    { value: "acc_captures", scale: "acc", text: "The response accurately captures what I mean." },
    { value: "acc_summarizes", scale: "acc", text: "The response correctly summarizes what I said." },
    { value: "und_knew", scale: "und", text: RESPONDER[condition] + " knew exactly what I meant." },
    { value: "und_understood", scale: "und", text: RESPONDER[condition] + " understood what I was thinking and feeling." },
  ];
  const AGREE_LABELS = [
    "Strongly disagree", "Disagree", "Somewhat disagree", "Neither disagree nor agree",
    "Somewhat agree", "Agree", "Strongly agree",
  ];

  // Mean of the named items, or null unless every one was answered.
  function scaleMean(answers, scale) {
    const vals = RATING_ITEMS.filter((it) => it.scale === scale).map((it) => Number(answers[it.value]));
    const complete = vals.length > 0 && vals.every((v) => Number.isFinite(v) && v >= 1 && v <= 7);
    return complete ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  const ratings = {
    type: jsPsychSurvey,
    survey_json: {
      showQuestionNumbers: "off",
      completeText: "Continue",
      pages: [
        {
          elements: [
            {
              type: "html",
              name: "stimulus",
              html:
                `<div class="vignette"><p>${SITUATION}</p>` +
                `<p><strong>${LABEL_SENTENCE[condition]}</strong></p>` +
                `<blockquote class="fixed-response">${RESPONSE}</blockquote>` +
                `<p>We are interested in how you think of the response above. Please indicate the ` +
                `extent to which you agree with the following statements.</p></div>`,
            },
            {
              // Nothing is required: the consent says any question may be declined.
              type: "matrix",
              name: "agreement",
              titleLocation: "hidden",
              rowTitleWidth: "200px",
              columnMinWidth: "60px",
              columns: AGREE_LABELS.map((text, i) => ({ value: i + 1, text })),
              rows: RATING_ITEMS.map((it) => ({ value: it.value, text: it.text })),
            },
          ],
        },
      ],
    },
    data: {
      task: "ratings",
      stimulus_id: "work_disappointment_v1",
      label_sentence: LABEL_SENTENCE[condition],
      responder_noun: RESPONDER[condition],
      item_order: RATING_ITEMS.map((it) => it.value).join(","),
    },
    on_finish: (data) => {
      const answers = (data.response && data.response.agreement) || {};
      for (const it of RATING_ITEMS) {
        data[it.value] = answers[it.value] === undefined ? null : Number(answers[it.value]);
      }
      data.feeling_heard = scaleMean(answers, "fh");
      data.response_accuracy = scaleMean(answers, "acc");
      data.responder_understood = scaleMean(answers, "und");
    },
  };

  // -------------------------------------------------------------------------
  // 4. Manipulation check (SI Appendix, p. 22), after every outcome measure
  // -------------------------------------------------------------------------
  const SUSPICION_PROMPT = {
    ai: "When reporting your impressions of the response, how much did you suspect that the " +
        "response you received was actually from another human participant rather than from an AI system?",
    human: "When reporting your impressions of the response, how much did you suspect that the " +
        "response you received was actually from an AI chatbot rather than from another human participant?",
  };
  const suspicion = {
    type: jsPsychSurvey,
    survey_json: {
      showQuestionNumbers: "off",
      completeText: "Continue",
      pages: [
        {
          elements: [
            {
              type: "rating", name: "suspicion", title: SUSPICION_PROMPT[condition],
              rateValues: [1, 2, 3, 4, 5, 6, 7],
              minRateDescription: "Not at all", maxRateDescription: "Very much",
            },
          ],
        },
      ],
    },
    data: { task: "suspicion" },
    on_finish: (data) => {
      const v = data.response && data.response.suspicion;
      data.suspicion = v === undefined ? null : Number(v);
    },
  };

  // -------------------------------------------------------------------------
  // 5. Demographics: the categories the paper reports (Methods, "Participants", p. 8).
  //    The paper does not give the question wording or the full option lists.
  // -------------------------------------------------------------------------
  const demographics = {
    type: jsPsychSurvey,
    survey_json: {
      showQuestionNumbers: "off",
      completeText: "Continue",
      pages: [
        {
          elements: [
            // Nothing is required: the consent says any question may be declined.
            { type: "text", name: "age", title: "How old are you?", inputType: "number", min: 18, max: 120 },
            {
              type: "radiogroup", name: "gender", title: "What is your gender?",
              choices: ["Woman", "Man", "Non-binary"], showNoneItem: true, noneText: "Prefer not to say",
            },
            {
              type: "radiogroup", name: "race", title: "Which of the following best describes your race or ethnicity?",
              choices: ["Black", "Asian", "White", "Hispanic", "Native American", "Mixed race"],
              showOtherItem: true, otherText: "Other (please specify)",
              showNoneItem: true, noneText: "Prefer not to say",
            },
            // The paper recruited US residents with English as their native language
            // (prescreened on Prolific). These two items let the data confirm that.
            { type: "boolean", name: "lives_in_us", title: "Do you currently live in the United States?", labelTrue: "Yes", labelFalse: "No" },
            { type: "boolean", name: "native_english", title: "Is English your first language?", labelTrue: "Yes", labelFalse: "No" },
          ],
        },
      ],
    },
    data: { task: "demographics" },
  };

  // -------------------------------------------------------------------------
  // 6. Debrief (DRAFT wording: edit to taste; it must say both labels were untrue)
  // -------------------------------------------------------------------------
  const debrief = {
    type: jsPsychHtmlButtonResponse,
    stimulus: `
      <h2>Debrief</h2>
      <p>Thank you for taking part. In this study we asked whether people feel more or less
      heard by a response depending on whether they are told it was generated by an AI system or
      written by another person.</p>
      <p>Everyone read the same situation and the same response. The response was written by the
      researchers. It was <strong>not</strong> generated by an AI system and it was <strong>not</strong>
      written by another participant; the label you saw was the only thing that differed between
      participants, and we did not tell you this earlier because doing so would have changed how
      you responded.</p>
      <p>If you have questions about this research, contact
      <a href="mailto:${EXPERIMENT.contact_email}">${EXPERIMENT.contact_email}</a>.
      Press the button to save your responses and finish.</p>`,
    choices: ["Finish"],
    data: { task: "debrief" },
  };

  await jsPsych.run([
    consent,
    instructions,
    ratings,
    suspicion,
    demographics,
    debrief,
  ]);
})();
