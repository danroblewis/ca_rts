/**
 * Renderer - Handles WebGL rendering
 * 
 * Receives a Game reference and renders the current state.
 * Owns the render loop and shader uniform setup.
 */

export class Renderer {
    /**
     * @param {Object} options
     * @param {Game} options.game - The game instance
     * @param {Object} options.shaders - { metaball, debug } shader objects
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
        this.gl = this.game.gl;
        this.canvas = this.game.canvas;
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
        const gl = this.gl;
        const canvas = this.canvas;
        const shader = this.currentShader;
        
        // Setup framebuffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        
        shader.use();
        
        // Bind frame textures for temporal anti-aliasing
        const frameCount = game.grid.getFrameCount();
        for (let i = 0; i < frameCount; i++) {
            shader.setTexture('u_state' + i, game.grid.getTextureByAge(i), i);
        }
        
        // Grid uniforms
        shader.setVec2('u_resolution', game.config.gridSize, game.config.gridSize);
        shader.setVec2('u_canvasResolution', canvas.width, canvas.height);
        shader.setFloat('u_time', game.simTime);
        shader.setFloat('u_metaballScale', this.metaballScale);
        shader.setInt('u_frameCount', frameCount);
        shader.setFloat('u_temporalBlend', this.temporalBlend);
        
        // Camera uniforms
        shader.setVec2('u_cameraPos', game.camera.x, game.camera.y);
        shader.setFloat('u_cameraZoom', game.camera.zoom);
        shader.setFloat('u_aspectRatio', game.camera.getAspectRatio());
        
        // Performance mode uniforms
        shader.setFloat('u_showMinimap', game.showMinimap ? 1.0 : 0.0);
        shader.setFloat('u_performanceMode', game.performanceMode ? 1.0 : 0.0);
        
        // Player uniform
        shader.setFloat('u_currentPlayer', game.currentPlayer);
        
        // Input state uniforms
        const inputHandler = game.inputHandler;
        const isSelecting = inputHandler.isInSelectionMode();
        const hasActiveSelection = inputHandler.hasSelection();
        const mousePos = inputHandler.getMousePosition();
        
        shader.setFloat('u_isSelecting', isSelecting ? 1.0 : 0.0);
        shader.setFloat('u_hasActiveSelection', hasActiveSelection ? 1.0 : 0.0);
        shader.setFloat('u_shiftHeld', inputHandler.isShiftHeld() ? 1.0 : 0.0);
        shader.setFloat('u_deleteRadius', this.deleteRadius);
        
        // Convert screen coordinates to UV
        const rect = canvas.getBoundingClientRect();
        const screenToUV = (x, y) => ({
            x: (x - rect.left) / rect.width,
            y: 1.0 - (y - rect.top) / rect.height
        });
        
        // Mouse position
        const mouseUV = screenToUV(mousePos.x, mousePos.y);
        shader.setVec2('u_mousePos', mouseUV.x, mouseUV.y);
        
        // Selection box
        if (isSelecting && inputHandler.selectionStart) {
            const startUV = screenToUV(inputHandler.selectionStart.x, inputHandler.selectionStart.y);
            const endUV = screenToUV(mousePos.x, mousePos.y);
            shader.setVec2('u_selectionStart', startUV.x, startUV.y);
            shader.setVec2('u_selectionEnd', endUV.x, endUV.y);
        } else {
            shader.setVec2('u_selectionStart', 0.0, 0.0);
            shader.setVec2('u_selectionEnd', 0.0, 0.0);
        }
        
        shader.dispatch();
    }
}

