import { DataTexture } from './DataTexture.js';
import { Framebuffer } from './Framebuffer.js';
import { GPU } from './GPU.js';

/**
 * CheckpointBuffer - Stores periodic game state snapshots for rollback netcode.
 * 
 * Unlike RingBuffer which stores recent frames for temporal AA (8 frames = ~130ms),
 * CheckpointBuffer stores less frequent snapshots (every ~500ms) for network rollback.
 * 
 * When a network message arrives with a past tick, we can:
 *   1. Find the closest checkpoint before that tick
 *   2. Restore to that checkpoint
 *   3. Replay (fast-forward) from there, applying the network action at the right tick
 */
export class CheckpointBuffer {
    /**
     * @param {number} width - Width in pixels/cells
     * @param {number} height - Height in pixels/cells
     * @param {Object} options - Options passed to DataTexture constructor
     * @param {number} [maxCheckpoints=10] - Number of checkpoints to keep (~5 seconds at 500ms intervals)
     * @param {number} [checkpointInterval=30] - Ticks between checkpoints (~500ms at 60fps)
     */
    constructor(width, height, options = {}, maxCheckpoints = 10, checkpointInterval = 30) {
        this.width = width;
        this.height = height;
        this.maxCheckpoints = maxCheckpoints;
        this.checkpointInterval = checkpointInterval;
        
        // Each checkpoint has: { texture, framebuffer, tick, cpuData }
        // We store both GPU texture and CPU data for flexibility
        this.checkpoints = [];
        
        // Options for creating textures
        this.textureOptions = options;
        
        // Last tick we saved a checkpoint for
        this.lastCheckpointTick = -Infinity;
    }
    
    /**
     * Check if we should save a checkpoint at this tick.
     * @param {number} tick - Current simulation tick
     * @returns {boolean}
     */
    shouldSaveCheckpoint(tick) {
        return tick - this.lastCheckpointTick >= this.checkpointInterval;
    }
    
    /**
     * Save a checkpoint from the current game state.
     * @param {number} tick - Current simulation tick
     * @param {Float32Array|Uint8Array} data - Grid data to save
     */
    saveCheckpoint(tick, data) {
        // Create new checkpoint
        const texture = new DataTexture(this.width, this.height, this.textureOptions);
        texture.upload(data);
        const framebuffer = new Framebuffer(texture);
        
        // Store CPU copy for fast network sync (avoid GPU readback)
        const cpuData = new Float32Array(data);
        
        const checkpoint = {
            texture,
            framebuffer,
            tick,
            cpuData
        };
        
        // Add to end of array
        this.checkpoints.push(checkpoint);
        this.lastCheckpointTick = tick;
        
        // Remove oldest if we exceed max
        while (this.checkpoints.length > this.maxCheckpoints) {
            const oldest = this.checkpoints.shift();
            oldest.texture.destroy();
            oldest.framebuffer.destroy();
        }
        
        // console.log(`[Checkpoint] Saved at tick ${tick}, total: ${this.checkpoints.length}`);
    }
    
    /**
     * Find the best checkpoint to restore for a given target tick.
     * Returns the checkpoint with the highest tick that's STRICTLY LESS THAN targetTick.
     * This is important for rollback - we need to restore to a state BEFORE the action,
     * then replay the simulation up to the action's tick.
     * @param {number} targetTick - The tick we need to restore to (strictly before)
     * @returns {Object|null} - Checkpoint object or null if none found
     */
    findCheckpointBefore(targetTick) {
        let best = null;
        for (const cp of this.checkpoints) {
            if (cp.tick < targetTick) {  // Strictly less than!
                if (!best || cp.tick > best.tick) {
                    best = cp;
                }
            }
        }
        return best;
    }
    
    /**
     * Get the oldest checkpoint tick we have.
     * @returns {number} - Oldest tick, or Infinity if no checkpoints
     */
    getOldestTick() {
        if (this.checkpoints.length === 0) return Infinity;
        return this.checkpoints[0].tick;
    }
    
    /**
     * Get the newest checkpoint tick we have.
     * @returns {number} - Newest tick, or -Infinity if no checkpoints
     */
    getNewestTick() {
        if (this.checkpoints.length === 0) return -Infinity;
        return this.checkpoints[this.checkpoints.length - 1].tick;
    }
    
    /**
     * Get all checkpoints (for debugging).
     * @returns {Array}
     */
    getCheckpoints() {
        return this.checkpoints;
    }
    
    /**
     * Clear all checkpoints older than a given tick.
     * @param {number} tick - Clear checkpoints older than this
     */
    clearOlderThan(tick) {
        while (this.checkpoints.length > 0 && this.checkpoints[0].tick < tick) {
            const oldest = this.checkpoints.shift();
            oldest.texture.destroy();
            oldest.framebuffer.destroy();
        }
    }
    
    /**
     * Clear all checkpoints.
     */
    clear() {
        for (const cp of this.checkpoints) {
            cp.texture.destroy();
            cp.framebuffer.destroy();
        }
        this.checkpoints = [];
        this.lastCheckpointTick = -Infinity;
    }
    
    /**
     * Clean up GPU resources.
     */
    destroy() {
        this.clear();
    }
}

