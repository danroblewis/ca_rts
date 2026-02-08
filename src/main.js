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
import { ComputePipeline } from './gpu/ComputePipeline.js';
import { RenderPipeline } from './gpu/RenderPipeline.js';
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
    
    // Rollback
    checkpointInterval: 10,
    maxCheckpoints: 30,
    syncWaitTimeout: 3000,
    
    // Network
    heartbeatInterval: 1000,
    fullSyncInterval: 5000,
    tickSyncThreshold: 30,
    tickSyncHardThreshold: 300,
    tickCatchupBatch: 10,
    tpsMargin: 5,
    tickSyncDisplayThreshold: 30
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

function resize() {
    const dpr = window.devicePixelRatio || 1;
    // Fullscreen canvas - use entire window
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
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
const [simShaderSource, metaballShaderSource, debugShaderSource] = await Promise.all([
    loadShader('./src/shaders/ca/v2/mining_game.wgsl'),
    loadShader('./src/shaders/ca/render_metaballs.wgsl'),
    loadShader('./src/shaders/ca/v2/render.wgsl')
]);
console.timeEnd('  📥 Load shader sources');

// Phase 2: Create GPU pipelines
console.time('  🔨 Create simShader (ComputePipeline)');
const simShader = new ComputePipeline(simShaderSource, { label: 'Simulation' });
console.timeEnd('  🔨 Create simShader (ComputePipeline)');

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
    simShader,
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
        syncSimBatchSize: CONFIG.syncSimBatchSize,
        tpsMargin: CONFIG.tpsMargin,
        heartbeatInterval: CONFIG.heartbeatInterval,
        fullSyncInterval: CONFIG.fullSyncInterval
    }
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
window.toggleMultiplayer = () => networkManager.toggleMultiplayer();
window.networkSync = networkSync;
window.switchPlayer = (p) => game.switchPlayer(p);

console.log(`Room ID: ${networkManager.getRoomId()} - Click network indicator or call toggleMultiplayer() to connect`);
