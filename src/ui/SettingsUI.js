/**
 * SettingsUI - graphics quality selector
 *
 * One dropdown: "Auto" (the QualityManager picks a level from the frame
 * rate) or a fixed level. In auto mode the dropdown label shows the level
 * currently in use. Exposes window.switchShader / window.setQuality-style
 * helpers for debugging.
 */

export class SettingsUI {
    /**
     * @param {Object} options
     * @param {Array} options.levels - QUALITY_LEVELS
     * @param {Function} options.onQualityChange - ('auto' | levelIndex) => void
     */
    constructor(options) {
        this.levels = options.levels;
        this.onQualityChange = options.onQualityChange || (() => {});
        this.select = document.getElementById('quality-select');
        this.current = document.getElementById('quality-current');
        this._build();

        // Debug helper kept from the old UI
        window.switchShader = (mode) => this.onQualityChange(mode === 'debug' ? this.levels.findIndex(l => l.shader === 'debug') : 0);
    }

    _build() {
        if (!this.select) return;
        this.select.innerHTML = '';
        const auto = document.createElement('option');
        auto.value = 'auto';
        auto.textContent = 'Auto';
        this.select.appendChild(auto);
        this.levels.forEach((level, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = level.label;
            this.select.appendChild(opt);
        });
        this.select.addEventListener('change', (e) => {
            const v = e.target.value;
            this.onQualityChange(v === 'auto' ? 'auto' : parseInt(v));
            this._updateURL(v);
        });
    }

    _updateURL(value) {
        const url = new URL(window.location);
        if (value === 'auto') url.searchParams.delete('quality');
        else url.searchParams.set('quality', this.levels[parseInt(value)]?.name ?? value);
        url.searchParams.delete('perf');
        url.searchParams.delete('shader');
        window.history.replaceState({}, '', url);
    }

    /**
     * Reflect the active level in the UI.
     * @param {number} index - active level index
     * @param {boolean} auto - whether the manager is in auto mode
     */
    showQuality(index, auto) {
        if (this.select) {
            this.select.value = auto ? 'auto' : String(index);
        }
        if (this.current) {
            const level = this.levels[index];
            this.current.textContent = auto ? `auto: ${level.label}` : level.label;
        }
    }
}
