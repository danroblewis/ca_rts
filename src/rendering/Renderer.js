/**
 * Renderer - Handles WebGPU rendering
 *
 * Receives a Game reference and renders the current state.
 * Owns the render loop and shader uniform setup.
 */

import { GPU } from '../gpu/GPU.js';

export class Renderer {
    /**
     * @param {Object} options
     * @param {Game} options.game - The game instance
     * @param {Object} options.shaders - { metaball, debug } RenderPipeline objects
     * @param {Object} options.config - Rendering configuration
     */
    constructor(options) {
        this.game = options.game;
        this.shaders = options.shaders;
        this.currentShader = options.shaders.metaball;
        this.shaderMode = 'metaball';

        // Config
        this.metaballScale = options.config.metaballScale || 1.0;
        this.temporalBlend = options.config.temporalBlend || 1.0;
        this.deleteRadius = options.config.deleteRadius || 5;

        // References from game
        this.canvas = this.game.canvas;

        // Create GPU resources
        const gpu = GPU.get();
        this.sampler = gpu.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest'
        });

        // RenderParams struct size:
        // resolution(2) + canvasResolution(2) + time(1) + metaballScale(1) + frameCount(1) + temporalBlend(1)
        // + currentPlayer(1) + isSelecting(1) + pad(2) + selectionStart(2) + selectionEnd(2)
        // + hasActiveSelection(1) + pad(1) + mousePos(2) + shiftHeld(1) + deleteRadius(1) + pad(2)
        // + cameraPos(2) + cameraZoom(1) + aspectRatio(1) + showMinimap(1) + performanceMode(1) + _pad(2)
        // = 32 floats = 128 bytes
        this.uniformBuffer = gpu.createUniformBuffer(128, 'RenderParams');

        // Uniform data array (32 floats)
        this.uniformData = new Float32Array(32);
        // Int view for writing frameCount as i32
        this.uniformDataInt = new Int32Array(this.uniformData.buffer);
    }

    /**
     * Switch to a different shader mode
     * @param {'metaball'|'debug'} mode
     */
    setShaderMode(mode) {
        if (this.shaders[mode]) {
            this.currentShader = this.shaders[mode];
            this.shaderMode = mode;
            console.log(`Switched to ${mode} shader`);
        }
    }

    /**
     * Get current shader mode
     * @returns {'metaball'|'debug'}
     */
    getShaderMode() {
        return this.shaderMode;
    }

    /**
     * Get the current shader
     */
    getCurrentShader() {
        return this.currentShader;
    }

    /**
     * Render one frame
     */
    render() {
        const game = this.game;
        const canvas = this.canvas;
        const shader = this.currentShader;
        const gpu = GPU.get();

        // Build uniform data matching RenderParams struct layout in WGSL
        const d = this.uniformData;
        const di = this.uniformDataInt;

        const frameCount = game.grid.getFrameCount();

        // Input state
        const inputHandler = game.inputHandler;
        const isSelecting = inputHandler.isInSelectionMode();
        const hasActiveSelection = inputHandler.hasSelection();
        const mousePos = inputHandler.getMousePosition();

        // Convert screen coordinates to UV
        const rect = canvas.getBoundingClientRect();
        const screenToUV = (x, y) => ({
            x: (x - rect.left) / rect.width,
            y: 1.0 - (y - rect.top) / rect.height
        });
        const mouseUV = screenToUV(mousePos.x, mousePos.y);

        let startUVx = 0, startUVy = 0, endUVx = 0, endUVy = 0;
        if (isSelecting && inputHandler.selectionStart) {
            const startUV = screenToUV(inputHandler.selectionStart.x, inputHandler.selectionStart.y);
            const endUV = screenToUV(mousePos.x, mousePos.y);
            startUVx = startUV.x; startUVy = startUV.y;
            endUVx = endUV.x; endUVy = endUV.y;
        }

        // Pack into Float32Array matching WGSL struct layout:
        // struct RenderParams {
        //     resolution: vec2f,          // [0,1]
        //     canvasResolution: vec2f,    // [2,3]
        //     time: f32,                  // [4]
        //     metaballScale: f32,         // [5]
        //     frameCount: i32,            // [6]   <-- int!
        //     temporalBlend: f32,         // [7]
        //     currentPlayer: f32,         // [8]
        //     isSelecting: f32,           // [9]
        //     selectionStart: vec2f,      // [10,11]
        //     selectionEnd: vec2f,        // [12,13]
        //     hasActiveSelection: f32,    // [14]
        //     mousePos: vec2f,            // [15] -- wait, this needs vec2f alignment (8 bytes)
        // }
        //
        // WGSL alignment rules: vec2f requires 8-byte alignment.
        // After hasActiveSelection at offset 56, mousePos at offset 56+4=60 is NOT 8-byte aligned.
        // However, the shader has mousePos at the same position and WGSL will pad as needed.
        // We must match the exact struct layout the shader expects.
        //
        // Actually, let's compute exact offsets:
        // offset 0:  resolution: vec2f      (8 bytes)
        // offset 8:  canvasResolution: vec2f (8 bytes)
        // offset 16: time: f32              (4 bytes)
        // offset 20: metaballScale: f32     (4 bytes)
        // offset 24: frameCount: i32        (4 bytes)
        // offset 28: temporalBlend: f32     (4 bytes)
        // offset 32: currentPlayer: f32     (4 bytes)
        // offset 36: isSelecting: f32       (4 bytes)
        // offset 40: selectionStart: vec2f  (8 bytes) -- aligned to 8
        // offset 48: selectionEnd: vec2f    (8 bytes) -- aligned to 8
        // offset 56: hasActiveSelection: f32 (4 bytes)
        // offset 60: -- 4 bytes padding for vec2f alignment
        // offset 64: mousePos: vec2f        (8 bytes) -- aligned to 8
        // offset 72: shiftHeld: f32         (4 bytes)
        // offset 76: deleteRadius: f32      (4 bytes)
        // offset 80: cameraPos: vec2f       (8 bytes) -- aligned to 8
        // offset 88: cameraZoom: f32        (4 bytes)
        // offset 92: aspectRatio: f32       (4 bytes)
        // offset 96: showMinimap: f32       (4 bytes)
        // offset 100: performanceMode: f32  (4 bytes)
        // offset 104: _pad: vec2f           (8 bytes) -- aligned to 8
        // total: 112 bytes
        //
        // Wait — WGSL struct alignment for the whole struct must be aligned to the largest member alignment (8).
        // 112 is divisible by 8, so total is 112 bytes. But we allocated 128 — that's fine, just extra padding.

        // Using byte offsets / 4 = float array indices:
        d[0] = game.config.gridSize;            // resolution.x
        d[1] = game.config.gridSize;            // resolution.y
        d[2] = canvas.width;                    // canvasResolution.x
        d[3] = canvas.height;                   // canvasResolution.y
        d[4] = game.simTime;                    // time
        d[5] = this.metaballScale;              // metaballScale
        di[6] = frameCount;                     // frameCount (i32)
        d[7] = this.temporalBlend;              // temporalBlend
        d[8] = game.currentPlayer;              // currentPlayer
        d[9] = isSelecting ? 1.0 : 0.0;        // isSelecting
        d[10] = startUVx;                       // selectionStart.x
        d[11] = startUVy;                       // selectionStart.y
        d[12] = endUVx;                         // selectionEnd.x
        d[13] = endUVy;                         // selectionEnd.y
        d[14] = hasActiveSelection ? 1.0 : 0.0; // hasActiveSelection
        d[15] = 0;                              // padding (for mousePos vec2f alignment)
        d[16] = mouseUV.x;                      // mousePos.x
        d[17] = mouseUV.y;                      // mousePos.y
        d[18] = inputHandler.isShiftHeld() ? 1.0 : 0.0; // shiftHeld
        d[19] = this.deleteRadius;              // deleteRadius
        d[20] = game.camera.x;                  // cameraPos.x
        d[21] = game.camera.y;                  // cameraPos.y
        d[22] = game.camera.zoom;               // cameraZoom
        d[23] = game.camera.getAspectRatio();   // aspectRatio
        d[24] = game.showMinimap ? 1.0 : 0.0;  // showMinimap
        d[25] = game.performanceMode ? 1.0 : 0.0; // performanceMode
        d[26] = 0;                              // _pad.x
        d[27] = 0;                              // _pad.y

        // Write uniform data to GPU buffer
        gpu.writeBuffer(this.uniformBuffer, d);

        // Build bind group entries based on shader mode
        const entries = [];
        if (this.shaderMode === 'debug') {
            // Debug shader: @binding(0) u_state0, @binding(1) sampler, @binding(2) params
            entries.push({ binding: 0, resource: game.grid.getTextureByAge(0).view });
            entries.push({ binding: 1, resource: this.sampler });
            entries.push({ binding: 2, resource: { buffer: this.uniformBuffer } });
        } else {
            // Metaball shader: @binding(0-7) u_state0..7, @binding(8) sampler, @binding(9) params
            for (let i = 0; i < frameCount; i++) {
                entries.push({ binding: i, resource: game.grid.getTextureByAge(i).view });
            }
            entries.push({ binding: 8, resource: this.sampler });
            entries.push({ binding: 9, resource: { buffer: this.uniformBuffer } });
        }

        const bindGroup = shader.createBindGroup(entries);

        // Draw fullscreen triangle to canvas
        const targetView = gpu.getCurrentTextureView();
        shader.draw(bindGroup, targetView);
    }
}
