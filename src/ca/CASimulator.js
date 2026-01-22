import { ComputeShader } from '../gpu/ComputeShader.js';
import { loadShader } from '../shaders/load.js';

/**
 * CASimulator - Runs the CA simulation.
 * 
 * Loads a shader and executes it on a CAGrid each step.
 */
export class CASimulator {
    /**
     * @param {CAGrid} grid - The grid to simulate
     */
    constructor(grid) {
        this.grid = grid;
        this.shader = null;
    }

    /**
     * Load the CA rule shader.
     * @param {string} shaderPath - Path to the fragment shader
     */
    async loadShader(shaderPath) {
        const source = await loadShader(shaderPath);
        this.shader = new ComputeShader(source);
    }

    /**
     * Run a single simulation step.
     */
    step() {
        if (!this.shader) {
            throw new Error('No shader loaded');
        }

        this.grid.getWriteFramebuffer().bind();
        
        this.shader.use();
        this.shader.setTexture('u_state', this.grid.getReadTexture(), 0);
        this.shader.setVec2('u_resolution', this.grid.width, this.grid.height);
        this.shader.dispatch();
        
        this.grid.getWriteFramebuffer().unbind();
        this.grid.swap();
    }

    /** Clean up */
    destroy() {
        if (this.shader) {
            this.shader.destroy();
        }
    }
}
