import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const CLIP_NAMES = ["stand", "stretch", "nod", "no", "left", "right", "hi"];
// Every shape the mouth-flap draws from. A/I/U/E/O are the VRM vowel
// visemes; Large/Surprised/Joy/Down carry noticeably bigger vertex
// deltas on this model (checked directly against the exported mesh),
// so mixing them in gives a more visible flap without pushing any
// single shape's influence past its designed 0-1 range.
const VISEME_NAMES = [
  "Fcl_MTH_A", "Fcl_MTH_I", "Fcl_MTH_U", "Fcl_MTH_E", "Fcl_MTH_O",
  "Fcl_MTH_Large", "Fcl_MTH_Surprised", "Fcl_MTH_Joy", "Fcl_MTH_Down",
];
// Every one of these has a similarly large delta on this mesh — drop
// the smaller vowels (I/U/E/A) from the "open" pool entirely so every
// single flap cycle is the big, easy-to-see version instead of
// randomly diluting half of them with a barely-visible one.
const OPEN_PRIMARY = ["Fcl_MTH_Large", "Fcl_MTH_O", "Fcl_MTH_Surprised", "Fcl_MTH_Joy"];

export class Avatar {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.mixer = null;
    this.actions = {};
    this.currentAction = null;
    this.model = null;

    this.positionX = 0;
    this.targetX = 0;

    this.mouthMesh = null;
    this.visemeIndices = {};
    // The small "FaceMouth" insert isn't the only geometry that moves
    // with these shapes — the face-skin primitive around the lips
    // carries real (if easy to miss) deltas for the same shape keys.
    // Driving both together moves the actual visible lip contour, not
    // just the small inset, which reads far more clearly as "talking".
    this.skinMesh = null;
    this.skinVisemeIndices = {};
    this.talking = false;
    this.talkTimeLeft = 0;
    this.mouthSwitchTimer = 0;
    // Continuous 0-1 "how open right now" value that eases toward
    // mouthOpennessTarget every frame (see updateMouth) instead of
    // snapping instantly — a hard on/off toggle read as an exaggerated
    // fish-mouth gape, easing it makes the motion look like an actual
    // mouth closing and opening.
    this.mouthOpenness = 0;
    this.mouthOpennessTarget = 0;
    this.mouthPrimaryName = OPEN_PRIMARY[0];

    // Real playback (see speak()) supplies the actual voice and the
    // real clip length (via 'ended') — real-time volume analysis to
    // drive the mouth from it turned out unreliable in practice, so
    // the mouth still runs on the synthetic flap above for as long as
    // the audio plays; this just supplies voice + accurate timing.
    this.audioEl = null;
    this.speakOnEnded = null;
  }

  async load(url, onProgress) {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url, onProgress);

    this.model = gltf.scene;
    this.model.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = false;
        obj.receiveShadow = false;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          if (!mat) continue;
          // This model's glTF export leaves metalness/roughness at the
          // KHR default of 1/1 with a mirror clearcoat and no env map,
          // which renders near-black with blown-out specular hotspots.
          // The baked look actually comes from the emissive map, so
          // flatten the PBR response and let that carry the shading.
          mat.metalness = 0;
          mat.roughness = 1;
          if ("clearcoat" in mat) mat.clearcoat = 0;
          if ("specularIntensity" in mat) mat.specularIntensity = 0;
          if (mat.emissiveMap) mat.emissiveIntensity = 1;
        }
        // The face is split into several primitives (mouth, eyes, brow,
        // skin, ...) that all carry the *same* 57 morph target names,
        // but eyes/brow/eyelash/eyeline are zero-effect placeholders for
        // the mouth shapes — only the mouth insert and the face-skin
        // primitive actually move vertices for them. Matching on "first
        // mesh with this dictionary key" silently grabbed a no-op
        // primitive, so the mouth never visibly moved.
        const matName = obj.material && obj.material.name ? obj.material.name : "";
        if (obj.morphTargetDictionary && obj.morphTargetDictionary[VISEME_NAMES[0]] !== undefined) {
          if (/mouth/i.test(matName)) {
            this.mouthMesh = obj;
            for (const name of VISEME_NAMES) {
              this.visemeIndices[name] = obj.morphTargetDictionary[name];
            }
          } else if (/face.*skin/i.test(matName)) {
            this.skinMesh = obj;
            for (const name of VISEME_NAMES) {
              this.skinVisemeIndices[name] = obj.morphTargetDictionary[name];
            }
          }
        }
      }
    });
    this.root.add(this.model);

    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of gltf.animations) {
      if (!CLIP_NAMES.includes(clip.name)) continue;
      const action = this.mixer.clipAction(clip);
      this.actions[clip.name] = action;
    }

    this.frameModel();
    this.play("stand", { duration: 0 });
  }

  frameModel() {
    const box = new THREE.Box3().setFromObject(this.model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    this.model.position.x -= center.x;
    this.model.position.z -= center.z;
    this.model.position.y -= box.min.y;
    this.height = size.y || 1.7;
  }

  /**
   * Crossfades into a named clip.
   * loop: true keeps repeating, false plays once and calls onFinished.
   */
  play(name, { duration = 0.35, loop = true, onFinished } = {}) {
    const next = this.actions[name];
    if (!next) return;

    if (this._finishedListener) {
      this.mixer.removeEventListener("finished", this._finishedListener);
      this._finishedListener = null;
    }

    next.reset();
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    next.clampWhenFinished = !loop;
    next.enabled = true;

    if (this.currentAction && this.currentAction !== next) {
      this.currentAction.crossFadeTo(next, duration, false);
    }
    next.play();

    if (!loop && onFinished) {
      this._finishedListener = (e) => {
        if (e.action === next) onFinished();
      };
      this.mixer.addEventListener("finished", this._finishedListener);
    }

    this.currentAction = next;
  }

  setTargetX(x) {
    this.targetX = x;
  }

  /**
   * Starts a fake lip-sync flap by randomly cycling the VRM vowel
   * blend shapes (Fcl_MTH_A/I/U/E/O). Pass a duration in seconds for a
   * timed burst (e.g. one idle phrase), or omit it to talk indefinitely
   * until stopTalking() is called (e.g. for the whole length of an
   * answer state).
   */
  startTalking(durationSeconds) {
    if (!this.mouthMesh) return;
    this.talking = true;
    this.talkTimeLeft = durationSeconds === undefined ? Infinity : durationSeconds;
    this.mouthSwitchTimer = 0;
  }

  stopTalking() {
    this.talking = false;
    this.talkTimeLeft = 0;
    this.speakOnEnded = null;
    if (this.audioEl && !this.audioEl.paused) {
      this.audioEl.pause();
      this.audioEl.currentTime = 0;
    }
    this.closeMouth();
  }

  /**
   * Plays a real audio line for voice + accurate timing, while the
   * mouth keeps running on the synthetic flap (startTalking) for as
   * long as the clip plays. onEnded fires when the clip finishes
   * naturally, or immediately if the browser blocks playback (e.g. no
   * user gesture yet).
   */
  speak(url, { onEnded } = {}) {
    if (!this.mouthMesh) return;
    this._ensureAudio();
    this.stopTalking();

    this.speakOnEnded = onEnded || null;
    this.audioEl.src = url;
    this.startTalking();

    const playPromise = this.audioEl.play();
    if (playPromise && playPromise.catch) {
      playPromise.catch((e) => {
        console.warn("Avatar.speak: playback blocked —", e.message);
        this.stopTalking();
        const cb = this.speakOnEnded;
        this.speakOnEnded = null;
        if (cb) cb();
      });
    }
  }

  _ensureAudio() {
    if (this.audioEl) return;
    this.audioEl = new Audio();
    this.audioEl.addEventListener("ended", () => {
      this.stopTalking();
      const cb = this.speakOnEnded;
      this.speakOnEnded = null;
      if (cb) cb();
    });
  }

  closeMouth() {
    this.mouthOpenness = 0;
    this.mouthOpennessTarget = 0;
    for (const name of OPEN_PRIMARY) {
      const idx = this.visemeIndices[name];
      this.mouthMesh.morphTargetInfluences[idx] = 0;
      if (this.skinMesh) this.skinMesh.morphTargetInfluences[this.skinVisemeIndices[name]] = 0;
    }
    const downIdx = this.visemeIndices["Fcl_MTH_Down"];
    this.mouthMesh.morphTargetInfluences[downIdx] = 0;
    if (this.skinMesh) this.skinMesh.morphTargetInfluences[this.skinVisemeIndices["Fcl_MTH_Down"]] = 0;
  }

  updateMouth(delta) {
    if (!this.talking || !this.mouthMesh) return;

    if (this.talkTimeLeft !== Infinity) {
      this.talkTimeLeft -= delta;
      if (this.talkTimeLeft <= 0) {
        this.stopTalking();
        return;
      }
    }

    this.mouthSwitchTimer -= delta;
    if (this.mouthSwitchTimer <= 0) {
      if (this.mouthOpennessTarget > 0) {
        // was open (or opening) — ease back to closed
        this.mouthOpennessTarget = 0;
        this.mouthSwitchTimer = 0.1 + Math.random() * 0.08;
      } else {
        // was closed — pick a shape and ease open. Zero out whichever
        // shape was previously in use first so swapping shapes never
        // leaves a faint ghost influence behind on the old one.
        for (const name of OPEN_PRIMARY) {
          const idx = this.visemeIndices[name];
          this.mouthMesh.morphTargetInfluences[idx] = 0;
          if (this.skinMesh) this.skinMesh.morphTargetInfluences[this.skinVisemeIndices[name]] = 0;
        }
        this.mouthPrimaryName = OPEN_PRIMARY[Math.floor(Math.random() * OPEN_PRIMARY.length)];
        // Moderate amplitude — driving both the mouth insert and the
        // face-skin primitive already doubles how visible any given
        // influence reads, so this stays well under the shapes' full
        // 0-1 range to avoid an exaggerated "gasping" look.
        this.mouthOpennessTarget = 0.35 + Math.random() * 0.2;
        this.mouthSwitchTimer = 0.14 + Math.random() * 0.12;
      }
    }

    // Ease current openness toward the target every frame (rather than
    // snapping) so the mouth visibly closes and opens instead of
    // flicking between two fixed states like a gaping fish.
    this.mouthOpenness += (this.mouthOpennessTarget - this.mouthOpenness) * Math.min(1, delta * 10);
    this._applyMouthOpenness(this.mouthOpenness);
  }

  _applyMouthOpenness(openness) {
    const primaryIdx = this.visemeIndices[this.mouthPrimaryName];
    const downIdx = this.visemeIndices["Fcl_MTH_Down"];
    this.mouthMesh.morphTargetInfluences[primaryIdx] = openness;
    this.mouthMesh.morphTargetInfluences[downIdx] = openness * 0.55;

    if (this.skinMesh) {
      const skinPrimaryIdx = this.skinVisemeIndices[this.mouthPrimaryName];
      const skinDownIdx = this.skinVisemeIndices["Fcl_MTH_Down"];
      this.skinMesh.morphTargetInfluences[skinPrimaryIdx] = openness;
      this.skinMesh.morphTargetInfluences[skinDownIdx] = openness * 0.55;
    }
  }

  update(delta) {
    if (this.mixer) this.mixer.update(delta);
    this.updateMouth(delta);

    this.positionX += (this.targetX - this.positionX) * Math.min(1, delta * 4);
    this.root.position.x = this.positionX;
  }
}
