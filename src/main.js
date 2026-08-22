/**
 * main.js - Bootstrap and wire up the game
 * 
 * This file:
 * - Parses configuration from URL and constants
 * - Initializes GPU and shaders
 * - Creates the Game instance
 * - Sets up network via NetworkManager
 * - Starts the game loop
 */

import { GPU } from './gpu/GPU.js';
import { RenderPipeline } from './gpu/RenderPipeline.js';
import { SimulationPipeline } from './ca/SimulationPipeline.js';
import { ActionPipeline } from './game/ActionPipeline.js';
import { loadShader } from './shaders/load.js';
import { getNetworkSync } from './network/NetworkSync.js';
import { PLAYER_1 } from './utils/GameUtils.js';

import { Game } from './game/Game.js';
import { GameLoop } from './game/GameLoop.js';
import { Renderer } from './rendering/Renderer.js';
import { SettingsUI } from './ui/SettingsUI.js';
import { NetworkIndicator } from './ui/NetworkIndicator.js';
import { SpeedToggle } from './ui/SpeedToggle.js';
import { NetworkManager } from './network/NetworkManager.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    // Grid
    gridSize: 512,
    defaultMapSeed: 12345,
    
    // Rendering
    metaballScale: 1.0,
    temporalBlend: 1.0,
    
    // Simulation
    logInterval: 1000,
    simBatchSize: 10,
    syncSimBatchSize: 1,
    defaultSyncMode: true,
    
    // Map generation
    numBlobs: 600,
    blobMinRadius: 3,
    blobMaxRadius: 8,
    blobDensity: 0.6,
    numWallLines: 176,
    wallMinLength: 5,
    wallMaxLength: 20,
    numWallBlobs: 20,
    wallBlobRadius: 3,
    
    // Camera
    defaultZoom: 2.0,
    minZoom: 1.5,
    maxZoom: 8.0,
    zoomSpeed: 0.1,
    panSpeed: 1.0,
    
    // Gameplay
    firstFactoryResources: 50,
    deleteRadius: 5,
    maxFactoriesPerPlayer: 7,
    
    // Lockstep
    inputDelay: 6,            // ticks between issuing and applying an action (adaptive)
    adaptiveInputDelay: true,
    hashInterval: 60,         // ticks between state-hash exchanges
    inputHistoryTicks: 1800,
    syncWaitTimeout: 3000,
    maxStepsPerFrame: 4,
    
    // Network
    heartbeatInterval: 1000,
    tickSyncDisplayThreshold: 30,

    // Rendering resolution: cap the backing-store scale so retina displays
    // don't quadruple the per-pixel render cost (the CA is 512x512 anyway).
    maxDevicePixelRatio: 1.5
};

// ============================================================================
// Parse URL parameters
// ============================================================================

const urlParams = new URLSearchParams(window.location.search);
const mapSeed = parseInt(urlParams.get('seed')) || CONFIG.defaultMapSeed;
const roomParam = urlParams.get('room');
const playerParam = urlParams.get('player');
const spectatorParam = urlParams.get('spectator');
const performanceMode = urlParams.get('perf') === '1';

const isOnGitHub = window.location.hostname.includes('github');
const isOnLocalhost = window.location.hostname.includes('localhost');
const isSpectator = spectatorParam === 'true' || spectatorParam === '1';

console.log(`Map seed: ${mapSeed}`);

// ============================================================================
// Initialize GPU
// ============================================================================

const canvas = document.getElementById('canvas');
const gpu = await GPU.init(canvas);

// Render scale: the canvas backing store is window size x min(devicePixelRatio, renderScale).
// The GameLoop lowers renderScale on slow GPUs to keep the frame rate up.
let renderScale = CONFIG.maxDevicePixelRatio;
function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, renderScale);
    // Fullscreen canvas - use entire window
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
}
function setRenderScale(scale) {
    renderScale = scale;
    resize();
}
window.addEventListener('resize', resize);
resize();

console.log('GPU compute framework initialized');

// ============================================================================
// Load Shaders
// ============================================================================

console.time('⏱️ Total shader initialization');

// Phase 1: Load shader source files
console.time('  📥 Load shader sources');
const [metaballShaderSource, debugShaderSource, simPipeline, actionPipeline] = await Promise.all([
    loadShader('./src/shaders/ca/render_metaballs.wgsl'),
    loadShader('./src/shaders/ca/v2/render.wgsl'),
    SimulationPipeline.create(CONFIG.gridSize, CONFIG.gridSize),
    ActionPipeline.create(CONFIG.gridSize, CONFIG.gridSize, {
        deleteRadius: CONFIG.deleteRadius,
        firstFactoryResources: CONFIG.firstFactoryResources
    })
]);
console.timeEnd('  📥 Load shader sources');

// Phase 2: Create GPU pipelines

console.time('  🔨 Create metaballRenderShader (RenderPipeline)');
const metaballRenderShader = new RenderPipeline(metaballShaderSource, { label: 'Metaball Render' });
console.timeEnd('  🔨 Create metaballRenderShader (RenderPipeline)');

console.time('  🔨 Create debugRenderShader (RenderPipeline)');
const debugRenderShader = new RenderPipeline(debugShaderSource, { label: 'Debug Render' });
console.timeEnd('  🔨 Create debugRenderShader (RenderPipeline)');

console.timeEnd('⏱️ Total shader initialization');

// ============================================================================
// Create Game instance
// ============================================================================

console.time('🎮 Create Game instance');
const game = new Game({
    ...CONFIG,
    canvas,
    simPipeline,
    actionPipeline,
    renderShader: metaballRenderShader,
    mapSeed,
    currentPlayer: PLAYER_1,
    isSpectator,
    performanceMode,
    isOnGitHub
});
console.timeEnd('🎮 Create Game instance');

// ============================================================================
// Create Renderer
// ============================================================================

const renderer = new Renderer({
    game,
    shaders: {
        metaball: metaballRenderShader,
        debug: debugRenderShader
    },
    config: {
        metaballScale: CONFIG.metaballScale,
        temporalBlend: CONFIG.temporalBlend,
        deleteRadius: CONFIG.deleteRadius
    }
});

// ============================================================================
// Create GameLoop
// ============================================================================

const gameLoop = new GameLoop({
    game,
    renderer,
    config: {
        simBatchSize: CONFIG.simBatchSize,
        maxStepsPerFrame: CONFIG.maxStepsPerFrame,
        heartbeatInterval: CONFIG.heartbeatInterval,
        renderScales: [CONFIG.maxDevicePixelRatio, 1.0, 0.75, 0.5]
    },
    setRenderScale
});

// ============================================================================
// Settings UI
// ============================================================================

const settingsUI = new SettingsUI({
    shaders: {
        metaball: metaballRenderShader,
        debug: debugRenderShader
    },
    onShaderChange: (shader, mode) => {
        renderer.setShaderMode(mode);
    },
    onPerformanceChange: (enabled, minimap) => {
        game.performanceMode = enabled;
        game.showMinimap = minimap;
    }
});

// ============================================================================
// Network Setup
// ============================================================================

const networkSync = getNetworkSync(CONFIG.gridSize);
game.setNetworkSync(networkSync);

// Network indicator
const networkIndicator = new NetworkIndicator({
    onClick: () => networkManager.toggleMultiplayer(),
    disabled: isOnGitHub
});

// Speed toggle
const speedToggle = new SpeedToggle({
    defaultSyncMode: CONFIG.defaultSyncMode,
    isOnLocalhost,
    onSpeedChange: (syncWithRender) => {
        gameLoop.onSpeedChange(syncWithRender);
    },
    onFastModeStart: () => {}
});

// Network manager - encapsulates all network event handling
const networkManager = new NetworkManager({
    networkSync,
    game,
    gameLoop,
    networkIndicator,
    speedToggle,
    config: CONFIG,
    isOnLocalhost,
    initialRoomId: roomParam || `game-${mapSeed}`
});
gameLoop.networkManager = networkManager;

// ============================================================================
// Audio setup
// ============================================================================

game.audioManager.bindButton(document.getElementById('audioToggle'));
game.audioManager.setupDebugUtils();

// ============================================================================
// Start the game
// ============================================================================

game.start();
networkManager._updateIndicator();
gameLoop.start();

// Auto-connect if room URL param is present
if (roomParam && !isOnGitHub) {
    networkManager.autoConnect(roomParam, playerParam, spectatorParam);
}

// Expose for debugging
window.game = game;
window.gameLoop = gameLoop;
window.networkManager = networkManager;
window.toggleMultiplayer = () => networkManager.toggleMultiplayer();
window.networkSync = networkSync;
window.switchPlayer = (p) => game.switchPlayer(p);
window.getSyncStats = () => ({ ...game.getSyncStats(), net: networkManager.getStats(), frame: gameLoop.getFrameStats(), renderScale: gameLoop.renderScale });

console.log(`Room ID: ${networkManager.getRoomId()} - Click network indicator or call toggleMultiplayer() to connect`);
