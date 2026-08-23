/**
 * QualityManager - graphics quality ladder with automatic adjustment.
 *
 * The simulation always runs at full fidelity (it is cheap and must stay
 * deterministic for lockstep); only the rendering cost is scaled. Levels go
 * from "ultra" (full metaball shader at retina scale) through perf kernels,
 * flat "lite" shading and reduced resolution down to "potato" (flat debug
 * shader at half resolution). Each level is a combination of:
 *   - shader:       'metaball' (pretty) or 'debug' (flat cells)
 *   - quality:      shader-internal tier (3 full, 2 perf kernels, 1 lite)
 *   - renderScale:  canvas backing-store scale cap (x devicePixelRatio)
 *   - minimap:      whether the in-shader minimap is drawn
 *
 * Automatic mode watches the frame rate (and a GPU-time estimate) and:
 *   - steps DOWN one level when fps stays below `downFps` for `downHoldMs`,
 *   - steps UP one level when fps stays at `upFps` or better AND the GPU has
 *     headroom (`gpuMs` below `upGpuMs`) for `upHoldMs`,
 *   - never changes more often than `cooldownMs`, and
 *   - if a step up is followed by a step down within `regressionMs`, that
 *     level is blocked for `blockMs` so the quality doesn't oscillate.
 *
 * Pure bookkeeping: the caller feeds samples and applies the chosen level.
 */

// Measured render cost on an Apple M-series GPU, 1512x982 window
// (ms per frame; ultra is at 1.5x DPR, the rest at 1.0x unless noted):
//   ultra ~32, high ~16, medium ~13, lite ~7, low (0.75x) ~4, minimal ~2, potato ~2
export const QUALITY_LEVELS = [
    { name: 'ultra',   label: 'Ultra',   shader: 'metaball', quality: 3, renderScale: 1.5,  minimap: true },
    { name: 'high',    label: 'High',    shader: 'metaball', quality: 3, renderScale: 1.0,  minimap: true },
    { name: 'medium',  label: 'Medium',  shader: 'metaball', quality: 2, renderScale: 1.0,  minimap: false },
    { name: 'lite',    label: 'Lite',    shader: 'metaball', quality: 1, renderScale: 1.0,  minimap: false },
    { name: 'low',     label: 'Low',     shader: 'metaball', quality: 1, renderScale: 0.75, minimap: false },
    { name: 'minimal', label: 'Minimal', shader: 'debug',    quality: 0, renderScale: 1.0,  minimap: false },
    { name: 'potato',  label: 'Potato',  shader: 'debug',    quality: 0, renderScale: 0.5,  minimap: false },
];

export class QualityManager {
    /**
     * @param {Object} options
     * @param {Function} options.apply - (level, index, reason) => void, called on every change
     * @param {Array} [options.levels]
     * @param {number} [options.initialLevel=0]
     * @param {boolean} [options.auto=true]
     * @param {Function} [options.now] - clock (ms), defaults to performance.now
     */
    constructor(options = {}) {
        this.levels = options.levels || QUALITY_LEVELS;
        this.apply = options.apply || (() => {});
        this.now = options.now || (() => performance.now());

        // Tuning
        this.downFps = options.downFps ?? 55;
        this.downHoldMs = options.downHoldMs ?? 2000;
        this.upFps = options.upFps ?? 58;
        this.upGpuMs = options.upGpuMs ?? 10;         // GPU time per frame needed to try a step up
        this.upHoldMs = options.upHoldMs ?? 10000;
        this.cooldownMs = options.cooldownMs ?? 3000;
        this.regressionMs = options.regressionMs ?? 20000;
        this.blockMs = options.blockMs ?? 120000;

        // State
        this.index = Math.max(0, Math.min(this.levels.length - 1, options.initialLevel ?? 0));
        this.auto = options.auto ?? true;
        this.lastChangeAt = -Infinity;
        this.lastStepUpAt = -Infinity;
        this.lastStepUpTo = -1;
        this.lowSince = 0;
        this.goodSince = 0;
        this.blockedUntil = new Array(this.levels.length).fill(0);
        this.history = [];          // { t, from, to, reason }
        this.lastSample = null;

        this.apply(this.levels[this.index], this.index, 'init');
    }

    get level() { return this.levels[this.index]; }
    get name() { return this.levels[this.index].name; }

    /**
     * Select a level by index or name. `null`/'auto' returns to automatic mode.
     */
    setManual(levelOrName) {
        if (levelOrName === null || levelOrName === undefined || levelOrName === 'auto') {
            this.auto = true;
            this.lowSince = 0; this.goodSince = 0;
            return this.index;
        }
        const idx = typeof levelOrName === 'number'
            ? levelOrName
            : this.levels.findIndex(l => l.name === levelOrName);
        if (idx < 0 || idx >= this.levels.length) return this.index;
        this.auto = false;
        this._change(idx, 'manual');
        return this.index;
    }

    /**
     * Feed a measurement. Call every ~0.5 s.
     * @param {Object} sample
     * @param {number} sample.fps - measured frames per second
     * @param {number} [sample.gpuMs] - estimated GPU time per frame (ms), if known
     * @returns {number|null} new level index if it changed, else null
     */
    sample({ fps, gpuMs = null }) {
        const t = this.now();
        this.lastSample = { t, fps, gpuMs };
        if (!this.auto) return null;

        const sinceChange = t - this.lastChangeAt;

        // --- step down: sustained low fps
        if (fps < this.downFps) {
            this.goodSince = 0;
            if (this.lowSince === 0) this.lowSince = t;
            if (t - this.lowSince >= this.downHoldMs && sinceChange >= this.cooldownMs && this.index < this.levels.length - 1) {
                // Regression after a recent step up: block that level for a while
                if (this.lastStepUpTo === this.index && t - this.lastStepUpAt < this.regressionMs) {
                    this.blockedUntil[this.index] = t + this.blockMs;
                }
                this._change(this.index + 1, `fps ${fps.toFixed(0)} < ${this.downFps}`);
                this.lowSince = 0;
                return this.index;
            }
            return null;
        }
        this.lowSince = 0;

        // --- step up: sustained good fps with GPU headroom
        const headroom = gpuMs === null || gpuMs < this.upGpuMs;
        if (fps >= this.upFps && headroom) {
            if (this.goodSince === 0) this.goodSince = t;
            const target = this.index - 1;
            if (target >= 0 && t - this.goodSince >= this.upHoldMs && sinceChange >= this.cooldownMs && this.blockedUntil[target] <= t) {
                this.lastStepUpAt = t;
                this.lastStepUpTo = target;
                this._change(target, `fps ${fps.toFixed(0)}, gpu ${gpuMs === null ? '?' : gpuMs.toFixed(1)}ms`);
                this.goodSince = 0;
                return this.index;
            }
        } else {
            this.goodSince = 0;
        }
        return null;
    }

    _change(idx, reason) {
        if (idx === this.index) return;
        const from = this.index;
        this.index = idx;
        this.lastChangeAt = this.now();
        this.history.push({ t: this.lastChangeAt, from, to: idx, reason });
        if (this.history.length > 50) this.history.shift();
        this.apply(this.levels[idx], idx, reason);
    }

    getState() {
        return {
            index: this.index,
            name: this.name,
            auto: this.auto,
            lastSample: this.lastSample,
            history: this.history.slice(-10),
            blocked: this.blockedUntil.map((until, i) => until > this.now() ? this.levels[i].name : null).filter(Boolean)
        };
    }
}
