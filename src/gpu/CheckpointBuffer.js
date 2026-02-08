import { DataTexture } from './DataTexture.js';

/**
 * CheckpointBuffer - Stores periodic game state snapshots for rollback netcode.
 *
 * WebGPU version: no framebuffers needed. Stores DataTexture + CPU copy.
 */
export class CheckpointBuffer {
    /**
     * @param {number} width - Width in pixels/cells
     * @param {number} height - Height in pixels/cells
     * @param {Object} options - Options passed to DataTexture constructor
     * @param {number} [maxCheckpoints=10] - Number of checkpoints to keep
     * @param {number} [checkpointInterval=30] - Ticks between checkpoints
     */
    constructor(width, height, options = {}, maxCheckpoints = 10, checkpointInterval = 30) {
        this.width = width;
        this.height = height;
        this.maxCheckpoints = maxCheckpoints;
        this.checkpointInterval = checkpointInterval;

        this.checkpoints = [];
        this.textureOptions = options;
        this.lastCheckpointTick = -Infinity;
    }

    /**
     * Check if we should save a checkpoint at this tick.
     * @param {number} tick
     * @returns {boolean}
     */
    shouldSaveCheckpoint(tick) {
        return tick - this.lastCheckpointTick >= this.checkpointInterval;
    }

    /**
     * Save a checkpoint from the current game state.
     * @param {number} tick
     * @param {Float32Array|Uint8Array} data
     */
    saveCheckpoint(tick, data) {
        const texture = new DataTexture(this.width, this.height, this.textureOptions);
        texture.upload(data);

        // Store CPU copy for fast network sync
        const cpuData = new Float32Array(data);

        const checkpoint = { texture, tick, cpuData };

        this.checkpoints.push(checkpoint);
        this.lastCheckpointTick = tick;

        while (this.checkpoints.length > this.maxCheckpoints) {
            const oldest = this.checkpoints.shift();
            oldest.texture.destroy();
        }
    }

    /**
     * Find the best checkpoint to restore for a given target tick.
     * @param {number} targetTick
     * @returns {Object|null}
     */
    findCheckpointBefore(targetTick) {
        let best = null;
        for (const cp of this.checkpoints) {
            if (cp.tick < targetTick) {
                if (!best || cp.tick > best.tick) {
                    best = cp;
                }
            }
        }
        return best;
    }

    getOldestTick() {
        if (this.checkpoints.length === 0) return Infinity;
        return this.checkpoints[0].tick;
    }

    getNewestTick() {
        if (this.checkpoints.length === 0) return -Infinity;
        return this.checkpoints[this.checkpoints.length - 1].tick;
    }

    getCheckpoints() {
        return this.checkpoints;
    }

    /**
     * Clear all checkpoints after a given tick.
     * Used after rollback to invalidate stale checkpoints from wrong timeline.
     * @param {number} tick
     */
    clearAfter(tick) {
        const toRemove = this.checkpoints.filter(cp => cp.tick > tick);
        for (const cp of toRemove) {
            cp.texture.destroy();
        }
        this.checkpoints = this.checkpoints.filter(cp => cp.tick <= tick);
        if (this.checkpoints.length > 0) {
            this.lastCheckpointTick = this.checkpoints[this.checkpoints.length - 1].tick;
        } else {
            this.lastCheckpointTick = -Infinity;
        }
    }

    clearOlderThan(tick) {
        while (this.checkpoints.length > 0 && this.checkpoints[0].tick < tick) {
            const oldest = this.checkpoints.shift();
            oldest.texture.destroy();
        }
    }

    clear() {
        for (const cp of this.checkpoints) {
            cp.texture.destroy();
        }
        this.checkpoints = [];
        this.lastCheckpointTick = -Infinity;
    }

    destroy() {
        this.clear();
    }
}
