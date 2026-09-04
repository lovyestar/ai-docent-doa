import * as THREE from "three";
import { Avatar } from "./avatar.js";
import { classifyQuestion } from "./llmMatcher.js";
import { docentData, idlePhrases, sampleQuestions, uiText, placeholderImage } from "./data.js";
import "./style.css";

const CENTER_X = 0;
// When answering a right/left-panel question, the avatar steps toward
// that side to stand close to the photos instead of across the screen.
const NEAR_LEFT_X = 0.4;
const NEAR_RIGHT_X =-0.4;
const $ = (id) => document.getElementById(id);

const el = {
  loading: $("loadingOverlay"),
  bubbleWrap: $("bubbleWrap"),
  bubble: $("bubble"),
  bubbleText: $("bubbleText"),
  liveCaption: $("liveCaption"),
  liveCaptionText: $("liveCaptionText"),
  panelRight: $("panelRight"),
  panelRightTitle: $("panelRightTitle"),
  panelRightGallery: $("panelRightGallery"),
  panelLeft: $("panelLeft"),
  panelLeftTitle: $("panelLeftTitle"),
  panelLeftGallery: $("panelLeftGallery"),
  posterOneBtn: $("posterOneBtn"),
  posterOnePhoto: $("posterOnePhoto"),
  posterTwoBtn: $("posterTwoBtn"),
  posterTwoPhoto: $("posterTwoPhoto"),
  micButton: $("micButton"),
  micStatus: $("micStatus"),
  textForm: $("textForm"),
  textInput: $("textInput"),
  sampleChips: $("sampleChips"),
};

function placeholderShot() {
  const div = document.createElement("div");
  div.className = "gallery-shot gallery-shot-placeholder";
  div.innerHTML = `<span class="panel-photo-icon">${placeholderImage.icon}</span><span class="panel-photo-label">${placeholderImage.label}</span>`;
  return div;
}

// Real photo lives at /images/{entry.imageId || entry.id}.jpg — an
// entry can point at another entry's photo (e.g. a "recommended work"
// entry reusing that work's own image) via imageId. Falls back to the
// placeholder if that file hasn't been added yet, so the panel never
// shows a broken image.
function renderGallery(galleryEl, entry) {
  galleryEl.innerHTML = "";
  const img = document.createElement("img");
  img.className = "gallery-shot";
  img.src = `/images/${entry.imageId || entry.id}.jpg`;
  img.alt = entry.title;
  img.onerror = () => img.replaceWith(placeholderShot());
  galleryEl.appendChild(img);
}

// Same real-photo-with-fallback pattern as renderGallery, sized for
// the small poster-on-the-chalkboard card instead of the side panel.
function renderPosterPhoto(container, entry) {
  container.innerHTML = "";
  const img = document.createElement("img");
  img.className = "chalk-poster-img";
  img.src = `/images/${entry.id}.jpg`;
  img.alt = entry.title;
  img.onerror = () => {
    const placeholder = document.createElement("span");
    placeholder.className = "chalk-poster-placeholder";
    placeholder.textContent = placeholderImage.icon;
    img.replaceWith(placeholder);
  };
  container.appendChild(img);
}

/* ---------- Three.js scene ---------- */
const canvas = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1.55, 4.5);
camera.lookAt(0, 1.15, 0);

// This avatar's look mostly comes from its baked emissive texture, not
// scene lighting — the lights here just add gentle, even fill so the
// materials aren't fully flat, without creating hotspots.
const hemi = new THREE.HemisphereLight(0xffffff, 0xd8dee6, 1.4);
scene.add(hemi);

const fillFront = new THREE.DirectionalLight(0xffffff, 0.35);
fillFront.position.set(0, 2, 4);
scene.add(fillFront);

const fillSide = new THREE.DirectionalLight(0xdce8ff, 0.18);
fillSide.position.set(-3, 1.5, 1);
scene.add(fillSide);

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

const avatar = new Avatar(scene);

/* ---------- App state machine ---------- */
const STATE = { IDLE: "idle", LISTENING: "listening", THINKING: "thinking", ANSWERING: "answering" };
let state = STATE.IDLE;

let idlePhraseTimer = null;
let idleStretchTimer = null;
let answerReturnTimer = null;

function pickIdlePhrase() {
  const i = Math.floor(Math.random() * idlePhrases.length);
  return { text: idlePhrases[i], audioUrl: `/audio/idle-${i + 1}.mp3` };
}

// Rough upper bound on how long a line takes to say out loud, used
// only to size the safety-net timer in speakAndScheduleReturn — actual
// timing now comes from the real generated audio's 'ended' event.
// Rate calibrated against afinfo-measured durations of the actual
// ElevenLabs "도아" voice output (~6.3 chars/sec average); no upper
// cap since this only guards against playback getting stuck, and a
// cap shorter than the real clip would cut audio off mid-line.
function estimateTalkDuration(text) {
  const lineCount = text.split("\n").length;
  const lineAdjustment = Math.min(2, lineCount - 1) * 18;
  const effectiveLength = Math.max(10, text.length - lineAdjustment);
  return Math.max(1.4, effectiveLength * 0.16);
}

function setBubble(text) {
  el.bubbleText.textContent = text;
  el.bubble.classList.toggle("bubble-compact", text.length > 70);
  el.bubble.classList.remove("bubble-pop");
  // restart pop animation
  void el.bubble.offsetWidth;
  el.bubble.classList.add("bubble-pop");
}

function setBubbleShift(direction) {
  el.bubbleWrap.classList.remove("shift-left", "shift-right");
  if (direction === "left") el.bubbleWrap.classList.add("shift-left");
  if (direction === "right") el.bubbleWrap.classList.add("shift-right");
}

function hidePanels() {
  avatar.stopTalking();
  el.panelRight.classList.remove("panel-visible");
  el.panelLeft.classList.remove("panel-visible");
  el.panelRight.setAttribute("aria-hidden", "true");
  el.panelLeft.setAttribute("aria-hidden", "true");
  setBubbleShift(null);
}

function clearTimers() {
  clearTimeout(idlePhraseTimer);
  clearTimeout(idleStretchTimer);
  clearTimeout(answerReturnTimer);
}

/* ---------- IDLE ---------- */
function enterIdle() {
  state = STATE.IDLE;
  clearTimers();
  hidePanels();
  el.liveCaption.classList.remove("live-visible");
  avatar.setTargetX(CENTER_X);
  avatar.play("stand", { duration: 0.5 });
  el.micStatus.textContent = uiText.micIdle;
  el.micButton.classList.remove("mic-listening", "mic-thinking");

  const idle = pickIdlePhrase();
  setBubble(idle.text);
  avatar.speak(idle.audioUrl);
  scheduleIdlePhrase();
  scheduleIdleStretch();
}

function scheduleIdlePhrase() {
  idlePhraseTimer = setTimeout(() => {
    if (state !== STATE.IDLE) return;
    const idle = pickIdlePhrase();
    setBubble(idle.text);
    avatar.speak(idle.audioUrl);
    scheduleIdlePhrase();
  }, 11000 + Math.random() * 6000);
}

function scheduleIdleStretch() {
  idleStretchTimer = setTimeout(() => {
    if (state !== STATE.IDLE) return;
    avatar.stopTalking();
    avatar.play("stretch", {
      duration: 0.5,
      loop: false,
      onFinished: () => {
        if (state === STATE.IDLE) avatar.play("stand", { duration: 0.5 });
      },
    });
    scheduleIdleStretch();
  }, 14000 + Math.random() * 10000);
}

/* ---------- LISTENING ---------- */
function enterListening() {
  state = STATE.LISTENING;
  clearTimers();
  hidePanels();
  avatar.setTargetX(CENTER_X);
  avatar.play("nod", { duration: 0.35, loop: true });
  el.micStatus.textContent = uiText.micListening;
  el.micButton.classList.add("mic-listening");
  el.micButton.classList.remove("mic-thinking");

  el.liveCaption.classList.add("live-visible");
  el.liveCaptionText.textContent = "";
}

/* ---------- THINKING ---------- */
function enterThinking() {
  state = STATE.THINKING;
  clearTimers();
  hidePanels();
  avatar.setTargetX(CENTER_X);
  avatar.play("stand", { duration: 0.35 });
  el.liveCaption.classList.remove("live-visible");
  el.micStatus.textContent = uiText.micThinking;
  el.micButton.classList.remove("mic-listening");
  el.micButton.classList.add("mic-thinking");
}

/* ---------- ANSWERING ---------- */
function enterAnswering(entry) {
  state = STATE.ANSWERING;
  clearTimers();
  el.liveCaption.classList.remove("live-visible");
  el.micStatus.textContent = uiText.micIdle;
  el.micButton.classList.remove("mic-listening", "mic-thinking");

  if (!entry) {
    hidePanels();
    avatar.setTargetX(CENTER_X);
    avatar.play("no", {
      duration: 0.35,
      loop: false,
      onFinished: () => {
        if (state === STATE.ANSWERING) avatar.play("stand", { duration: 0.5 });
      },
    });
    setBubble(uiText.fallback);
    speakAndScheduleReturn("/audio/fallback.mp3", uiText.fallback);
    return;
  }

  const audioUrl = `/audio/${entry.id}.mp3`;

  if (entry.category === "self") {
    hidePanels();
    avatar.setTargetX(CENTER_X);
    avatar.play("hi", {
      duration: 0.35,
      loop: false,
      onFinished: () => {
        if (state === STATE.ANSWERING) avatar.play("stand", { duration: 0.5 });
      },
    });
    setBubble(entry.description);
  } else if (entry.category === "stand") {
    // General explanations that don't point at a specific side exhibit
    // (booth overview, tour order, tech stack) — just stay put and
    // talk, no gesture animation or panel needed.
    hidePanels();
    avatar.setTargetX(CENTER_X);
    avatar.play("stand", { duration: 0.35 });
    setBubble(entry.description);
  } else if (entry.category === "right") {
    hidePanels();
    avatar.setTargetX(NEAR_RIGHT_X);
    avatar.play("right", { duration: 0.4, loop: true });
    renderGallery(el.panelRightGallery, entry);
    el.panelRightTitle.textContent = entry.title;
    el.panelRight.classList.add("panel-visible");
    el.panelRight.setAttribute("aria-hidden", "false");
    setBubbleShift("left");
    setBubble(entry.description);
  } else if (entry.category === "no") {
    hidePanels();
    avatar.setTargetX(CENTER_X);
    avatar.play("no", {
      duration: 0.35,
      loop: false,
      onFinished: () => {
        if (state === STATE.ANSWERING) avatar.play("stand", { duration: 0.5 });
      },
    });
    setBubble(entry.description);
  }else if (entry.category === "left") {
    hidePanels();
    avatar.setTargetX(NEAR_LEFT_X);
    avatar.play("left", { duration: 0.4, loop: true });
    renderGallery(el.panelLeftGallery, entry);
    el.panelLeftTitle.textContent = entry.title;
    el.panelLeft.classList.add("panel-visible");
    el.panelLeft.setAttribute("aria-hidden", "false");
    setBubbleShift("right");
    setBubble(entry.description);
  } else {
    hidePanels();
    avatar.setTargetX(CENTER_X);
    avatar.play("nod", {
      duration: 0.35,
      loop: false,
      onFinished: () => {
        if (state === STATE.ANSWERING) avatar.play("stand", { duration: 0.5 });
      },
    });
    setBubble(entry.description);
  }

  speakAndScheduleReturn(audioUrl, entry.speech || entry.description);
}

// Plays the real audio line and returns to idle when it actually
// finishes (via Avatar's 'ended' event), instead of guessing a
// duration from the text. Also arms a generous safety-net timer in
// case playback never fires 'ended' (blocked autoplay, network hiccup)
// so the kiosk can't get stuck showing one answer forever.
function speakAndScheduleReturn(audioUrl, text) {
  clearTimeout(answerReturnTimer);
  avatar.speak(audioUrl, {
    onEnded: () => {
      if (state === STATE.ANSWERING) enterIdle();
    },
  });
  const safetyMs = estimateTalkDuration(text) * 1000 + 6000;
  answerReturnTimer = setTimeout(() => {
    if (state === STATE.ANSWERING) enterIdle();
  }, safetyMs);
}

async function askQuestion(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  enterThinking();
  const entry = await classifyQuestion(trimmed);
  // A newer question (or a state reset) may have taken over while we
  // were waiting on the classify call — don't clobber it with a stale
  // answer arriving late.
  if (state !== STATE.THINKING) return;
  enterAnswering(entry);
}

// Posters pinned to the chalkboard are a direct shortcut to a known
// entry — no need to round-trip through the classifier when the click
// itself already says exactly which one the visitor means.
function askAboutEntry(id) {
  const entry = docentData.find((e) => e.id === id);
  if (entry) enterAnswering(entry);
}

/* ---------- Speech recognition ---------- */
const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recognitionActive = false;

if (SpeechRecognitionAPI) {
  recognition = new SpeechRecognitionAPI();
  recognition.lang = "ko-KR";
  recognition.continuous = false;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let interim = "";
    let final = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += transcript;
      else interim += transcript;
    }
    el.liveCaptionText.textContent = final || interim;
    if (final) {
      askQuestion(final);
    }
  };

  recognition.onerror = () => {
    if (state === STATE.LISTENING) {
      setBubble(uiText.retryMessage);
      enterIdle();
    }
  };

  recognition.onend = () => {
    recognitionActive = false;
    if (state === STATE.LISTENING) {
      enterIdle();
    }
  };
} else {
  el.textForm.hidden = false;
  setTimeout(() => setBubble(uiText.noSpeechSupport), 500);
}

el.micButton.addEventListener("click", () => {
  if (!recognition) {
    el.textInput.focus();
    return;
  }
  if (state === STATE.LISTENING) {
    recognition.stop();
    return;
  }
  enterListening();
  try {
    recognition.start();
    recognitionActive = true;
  } catch (e) {
    recognitionActive = false;
  }
});

el.textForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const value = el.textInput.value;
  el.textInput.value = "";
  if (value.trim()) askQuestion(value);
});

/* ---------- Posters pinned to the chalkboard ---------- */
renderPosterPhoto(el.posterOnePhoto, docentData.find((e) => e.id === "poster-1"));
renderPosterPhoto(el.posterTwoPhoto, docentData.find((e) => e.id === "poster-2"));
el.posterOneBtn.addEventListener("click", () => askAboutEntry("poster-1"));
el.posterTwoBtn.addEventListener("click", () => askAboutEntry("poster-2"));

/* ---------- Sample question chips ---------- */
for (const q of sampleQuestions) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.textContent = q;
  chip.addEventListener("click", () => askQuestion(q));
  el.sampleChips.appendChild(chip);
}

/* ---------- Boot ---------- */
async function boot() {
  await avatar.load("/models/doa.glb");
  avatar.root.scale.setScalar(1.30);
  el.loading.classList.add("loading-done");
  enterIdle();

  const timer = new THREE.Timer();
  function tick() {
    timer.update();
    const delta = timer.getDelta();
    avatar.update(delta);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  tick();
}

boot();
