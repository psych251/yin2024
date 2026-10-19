/*
 * Two small jsPsych plugins that give the study its chatbot-style interface, plus the helpers
 * they share with experiment.js.
 *
 *   jsPsychChatDescribe  the participant types a description of a complex situation into a chat
 *                        box (replaces the original study's audio recording, Part 1).
 *   jsPsychAsyncStep     shows a message while an async function runs (the Part 2 reply lookup).
 *
 * Replies are generated beforehand by scripts/generate-replies.js; ChatUI.transcriptHtml shows one
 * under the responder identity given by the label condition.
 */
(function () {
  const PT = jsPsychModule.ParameterType;

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  const withBreaks = (s) => escapeHtml(s).replace(/\n/g, "<br>");
  const countWords = (s) => (String(s).trim().match(/\S+/g) || []).length;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The identity shown above the responder's bubble: the ONLY thing that differs between
  // label conditions.
  const RESPONDERS = {
    human: { name: "Another Prolific participant", avatar: "\u{1F464}" },
    ai: { name: "AI chatbot", avatar: "\u{1F916}" },
  };

  function bubbleHtml(side, who, avatar, bodyHtml, extraClass) {
    return `<div class="chat-row chat-${side} ${extraClass || ""}">
      <div class="chat-avatar" aria-hidden="true">${avatar}</div>
      <div class="chat-bubble-wrap"><div class="chat-name">${escapeHtml(who)}</div>
      <div class="chat-bubble">${bodyHtml}</div></div></div>`;
  }

  // The finished exchange (participant message + labelled reply), reused on the ratings page so
  // the response stays on screen while it is rated ("the response above").
  function exchangeHtml(description, reply, kind) {
    const r = RESPONDERS[kind];
    return `<div class="chat chat-exchange">
      ${bubbleHtml("user", "You said", "\u{1F5E3}️", withBreaks(description))}
      ${bubbleHtml("bot", r.name, r.avatar, withBreaks(reply))}</div>`;
  }

  // The Part 2 reply screen: a header naming the responder, then the participant's message and the
  // reply as a chat transcript. Static: the reply was written before this part.
  function transcriptHtml(description, reply, kind) {
    const r = RESPONDERS[kind];
    return `<div class="chat" id="chat-reply" data-responder="${escapeHtml(kind)}">
      <div class="chat-header"><span class="chat-avatar-sm">${r.avatar}</span> ${escapeHtml(r.name)}</div>
      <div class="chat-log">
        ${bubbleHtml("user", "You said", "\u{1F5E3}\uFE0F", withBreaks(description))}
        ${bubbleHtml("bot", r.name, r.avatar, withBreaks(reply), "chat-reply-bubble")}
      </div></div>`;
  }

  window.ChatUI = { escapeHtml, withBreaks, countWords, RESPONDERS, exchangeHtml, transcriptHtml };

  // -------------------------------------------------------------------------------------------
  // Describe: bot messages, then a composer. Finishes when a long enough message is sent.
  // -------------------------------------------------------------------------------------------
  class ChatDescribePlugin {
    constructor(jsPsych) { this.jsPsych = jsPsych; }

    trial(display_element, trial) {
      const start = performance.now();
      const intro = (trial.intro || []).map((m) => bubbleHtml("bot", trial.assistant_name, "\u{1F4AC}", m)).join("");
      display_element.innerHTML = `
        <div class="chat" id="chat-describe">
          <div class="chat-header">${escapeHtml(trial.header)}</div>
          <div class="chat-log" id="chat-log">${intro}</div>
          <div class="chat-hint" id="chat-hint" role="status"></div>
          <div class="chat-composer">
            <textarea id="chat-input" rows="5" maxlength="4000" placeholder="${escapeHtml(trial.placeholder)}"></textarea>
            <button class="jspsych-btn" id="chat-send" type="button">${escapeHtml(trial.send_label)}</button>
          </div>
        </div>`;
      const input = display_element.querySelector("#chat-input");
      const hint = display_element.querySelector("#chat-hint");
      const send = display_element.querySelector("#chat-send");
      const log = display_element.querySelector("#chat-log");
      let firstKey = null;
      let keystrokes = 0;
      let pasteAttempts = 0;
      input.addEventListener("keydown", () => { keystrokes++; if (firstKey === null) firstKey = performance.now(); });
      input.focus();

      // The description must be typed: pasting, dropping and cutting are blocked, so it cannot be
      // pasted in from another source (e.g. a generative AI). Attempts are counted in the data.
      const blockPaste = (e) => {
        e.preventDefault();
        pasteAttempts++;
        hint.textContent = "Pasting is disabled. Please type your message in your own words.";
      };
      input.addEventListener("paste", blockPaste);
      input.addEventListener("drop", blockPaste);
      input.addEventListener("cut", (e) => e.preventDefault());

      const refresh = () => {
        const n = countWords(input.value);
        hint.textContent = n >= trial.min_words ? "" : "Please describe your situation in a bit more detail: what happened, and what you think and feel.";
      };
      input.addEventListener("input", refresh);

      send.addEventListener("click", () => {
        const text = input.value.trim();
        const n = countWords(text);
        if (n < trial.min_words) { hint.textContent = "Please describe your situation in more detail before sending: what happened, and what you think and feel."; return; }
        send.disabled = true; input.disabled = true;
        log.insertAdjacentHTML("beforeend", bubbleHtml("user", "You", "\u{1F5E3}️", withBreaks(text)));
        const data = {
          description: text,
          n_words: n,
          n_keystrokes: keystrokes,
          n_paste_attempts: pasteAttempts,
          rt: Math.round(performance.now() - start),
          typing_ms: firstKey === null ? null : Math.round(performance.now() - firstKey),
        };
        setTimeout(() => { display_element.innerHTML = ""; this.jsPsych.finishTrial(data); }, 600);
      });
    }
  }
  ChatDescribePlugin.info = {
    name: "chat-describe",
    version: "0.1.0",
    parameters: {
      header: { type: PT.STRING, default: "Study chat" },
      assistant_name: { type: PT.STRING, default: "Study" },
      intro: { type: PT.HTML_STRING, default: [], array: true },
      placeholder: { type: PT.STRING, default: "Type your message here..." },
      send_label: { type: PT.STRING, default: "Send" },
      min_words: { type: PT.INT, default: 20 },
    },
    data: {
      description: { type: PT.STRING },
      n_words: { type: PT.INT },
      n_keystrokes: { type: PT.INT },
      n_paste_attempts: { type: PT.INT },
      rt: { type: PT.INT },
      typing_ms: { type: PT.INT },
    },
  };

  // -------------------------------------------------------------------------------------------
  // Async step: show a message while an async function runs, then continue. Used for the Part 2
  // lookup of the participant's stored reply. `run` returns the data to record (it must not
  // contain anything private) and should not throw.
  // -------------------------------------------------------------------------------------------
  class AsyncStepPlugin {
    constructor(jsPsych) { this.jsPsych = jsPsych; }

    // Not `async`: jsPsych 8 ends a trial as soon as a Promise returned by trial() resolves.
    trial(display_element, trial) {
      this._run(display_element, trial);
    }

    async _run(display_element, trial) {
      display_element.innerHTML = `<div class="chat-wait" role="status"><p class="thanks">${escapeHtml(trial.message)}</p></div>`;
      let data;
      try {
        data = await trial.run();
      } catch (e) {
        data = { ok: false, error: String((e && e.message) || e) };
      }
      display_element.innerHTML = "";
      this.jsPsych.finishTrial(data || {});
    }
  }
  AsyncStepPlugin.info = {
    name: "async-step",
    version: "0.1.0",
    parameters: {
      message: { type: PT.STRING, default: "Please wait..." },
      run: { type: PT.FUNCTION, default: undefined },
    },
    data: {},
  };

  window.jsPsychChatDescribe = ChatDescribePlugin;
  window.jsPsychAsyncStep = AsyncStepPlugin;
})();
