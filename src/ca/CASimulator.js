import { GPU } from '../gpu/GPU.js';
import { ComputePipeline } from '../gpu/ComputePipeline.js';
import { loadShader } from '../shaders/load.js';

/**
 * CASimulator - Runs the CA simulation.
 *
 * Loads a WGSL compute shader and executes it on a CAGrid each step.
 */
export class CASimulator {
    /**
     * @param {CAGrid} grid - The grid to simulate
     */
    constructor(grid) {
        this.grid = grid;
        this.shader = null;
        this.uniformBuffer = null;
        this.simTime = 0;
    }

    /**
     * Load the CA rule shader.
     * @param {string} shaderPath - Path to the WGSL compute shader
     */
    async loadShader(shaderPath) {
        const source = await loadShader(shaderPath);
        this.shader = new ComputePipeline(source, { label: 'CA Simulation' });

        // Create uniform buffer for SimParams: resolution(vec2f) + time(f32) + _pad(f32) = 16 bytes
        const gpu = GPU.get();
        this.uniformBuffer = gpu.createUniformBuffer(16, 'SimParams');
    }

    /**
     * Run a single simulation step.
     */
    step() {
        if (!this.shader) {
            throw new Error('No shader loaded');
        }

        const gpu = GPU.get();
        const readTex = this.grid.getReadTexture();
        const writeTex = this.grid.getWriteTexture();

        // Update uniform buffer: [resX, resY, time, pad]
        const params = new Float32Array([this.grid.width, this.grid.height, this.simTime, 0]);
        gpu.writeBuffer(this.uniformBuffer, params);

        // Create bind group matching mining_game.wgsl bindings:
        //   @binding(0) var u_state: texture_2d<f32>
        //   @binding(1) var u_output: texture_storage_2d<rgba32float, write>
        //   @binding(2) var<uniform> params: SimParams
        const bindGroup = this.shader.createBindGroup([
            { binding: 0, resource: readTex.view },
            { binding: 1, resource: writeTex.view },
            { binding: 2, resource: { buffer: this.uniformBuffer } }
        ]);

        // Dispatch with 8x8 workgroups
        const workgroupsX = Math.ceil(this.grid.width / 8);
        const workgroupsY = Math.ceil(this.grid.height / 8);
        this.shader.dispatch(bindGroup, workgroupsX, workgroupsY);

        this.grid.swap();
        this.simTime += 1.0;
    }

    /** Clean up */
    destroy() {
        if (this.shader) {
            this.shader.destroy();
        }
        if (this.uniformBuffer) {
            this.uniformBuffer.destroy();
        }
    }
}
