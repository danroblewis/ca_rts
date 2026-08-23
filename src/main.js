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
import { QualityManager, QUALITY_LEVELS } from './rendering/QualityManager.js';
import { GpuLoad } from './gpu/GpuLoad.js';
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

    // Graphics quality ladder (see rendering/QualityManager.js). The CA is
    // 512x512, so even "ultra" caps the backing-store scale at 1.5x DPR.
    initialQuality: 0,          // index into QUALITY_LEVELS
    autoQuality: true
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
// Quality: ?quality=auto|ultra|high|medium|low|minimal|potato|0-5
// Legacy: ?perf=1 -> medium, ?shader=debug -> minimal (both manual).
const qualityParam = urlParams.get('quality');
const gpuLoadParam = parseInt(urlParams.get('gpuload')) || 0;
const cpuLoadParam = parseFloat(urlParams.get('cpuload')) || 0;

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
// The QualityManager lowers renderScale on slow GPUs to keep the frame rate up.
let renderScale = QUALITY_LEVELS[CONFIG.initialQuality].renderScale;
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
const [metaballShaderSource, debugShaderSource, simPipeline, actionPipeline, gpuLoad] = await Promise.all([
    loadShader('./src/shaders/ca/render_metaballs.wgsl'),
    loadShader('./src/shaders/ca/v2/render.wgsl'),
    SimulationPipeline.create(CONFIG.gridSize, CONFIG.gridSize),
    ActionPipeline.create(CONFIG.gridSize, CONFIG.gridSize, {
        deleteRadius: CONFIG.deleteRadius,
        firstFactoryResources: CONFIG.firstFactoryResources
    }),
    GpuLoad.create()
]);
gpuLoad.setIterations(gpuLoadParam);
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
// Graphics quality
// ============================================================================

let settingsUI = null;   // created below; the quality callback updates it

const qualityManager = new QualityManager({
    initialLevel: CONFIG.initialQuality,
    auto: CONFIG.autoQuality,
    apply: (level, index, reason) => {
        renderer.setShaderMode(level.shader);
        renderer.setQuality(level.quality);
        game.performanceMode = level.quality <= 2;
        game.showMinimap = level.minimap;
        setRenderScale(level.renderScale);
        settingsUI?.showQuality(index, qualityManager.auto);
        console.log(`Quality: ${level.name} (${reason})`);
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
        heartbeatInterval: CONFIG.heartbeatInterval
    },
    qualityManager,
    gpuLoad
});
gameLoop.setCpuLoad(cpuLoadParam);

// ============================================================================
// Settings UI
// ============================================================================

settingsUI = new SettingsUI({
    levels: QUALITY_LEVELS,
    onQualityChange: (selection) => {
        // selection: 'auto' or a level index
        qualityManager.setManual(selection === 'auto' ? 'auto' : selection);
        settingsUI.showQuality(qualityManager.index, qualityManager.auto);
    }
});

// Initial selection from the URL (legacy ?perf=1 / ?shader=debug still work)
{
    let initial = null;
    if (qualityParam !== null && qualityParam !== 'auto') {
        const idx = parseInt(qualityParam);
        initial = Number.isNaN(idx) ? qualityParam : idx;
    } else if (urlParams.get('shader') === 'debug') {
        initial = 'minimal';
    } else if (performanceMode) {
        initial = 'medium';
    }
    if (initial !== null) qualityManager.setManual(initial);
    settingsUI.showQuality(qualityManager.index, qualityManager.auto);
}

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
window.getSyncStats = () => ({ ...game.getSyncStats(), net: networkManager.getStats(), frame: gameLoop.getFrameStats(), quality: qualityManager.getState(), gpuFrameMs: renderer.gpuFrameMs });
window.qualityManager = qualityManager;
window.setQuality = (q) => qualityManager.setManual(q);
window.setGpuLoad = (n) => gpuLoad.setIterations(n);
window.setCpuLoad = (ms) => gameLoop.setCpuLoad(ms);

console.log(`Room ID: ${networkManager.getRoomId()} - Click network indicator or call toggleMultiplayer() to connect`);
