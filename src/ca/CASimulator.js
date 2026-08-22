import { SimulationPipeline } from './SimulationPipeline.js';

/**
 * CASimulator - Runs the CA simulation on a CAGrid.
 *
 * Thin convenience wrapper around SimulationPipeline (prepass + main pass).
 */
export class CASimulator {
    /**
     * @param {CAGrid} grid - The grid to simulate
     */
    constructor(grid) {
        this.grid = grid;
        this.pipeline = null;
        this.simTime = 0;
    }

    /**
     * Load the simulation shaders.
     * @param {Object} [paths] - optional {prepass, main} shader paths
     */
    async loadShader(paths = {}) {
        this.pipeline = await SimulationPipeline.create(this.grid.width, this.grid.height, { paths });
    }

    /**
     * Run a single simulation step.
     */
    step() {
        if (!this.pipeline) {
            throw new Error('No shader loaded');
        }
        this.pipeline.step(this.grid.getReadTexture(), this.grid.getWriteTexture(), this.simTime);
        this.grid.swap();
        this.simTime += 1;
    }

    /** Clean up */
    destroy() {
        if (this.pipeline) {
            this.pipeline.destroy();
            this.pipeline = null;
        }
    }
}
