import { GPU } from './gpu/GPU.js';
import { ComputeShader } from './gpu/ComputeShader.js';
import { DataTexture } from './gpu/DataTexture.js';
import { loadShader } from './shaders/load.js';
import { CAGrid } from './ca/CAGrid.js';
import { getNetworkSync } from './network/NetworkSync.js';
import { AudioReductionPipeline } from './audio/AudioReductionPipeline.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { CheckpointBuffer } from './gpu/CheckpointBuffer.js';
import { ActionQueue } from './network/ActionQueue.js';
import { Logger } from './utils/Logger.js';

// Import refactored modules
import {
    CELL_EMPTY, CELL_RESOURCE, CELL_MINING_UNIT, CELL_MINING_FACTORY,
    CELL_WALL, CELL_MINING_UNIT_P2, CELL_DEMOLISH, CELL_MINING_FACTORY_P2,
    PLAYER_1, PLAYER_2,
    COORD_PACK_BASE, MEMORY_PACK_BASE, SELECTED_PACK_BASE, AGE_PACK_BASE, COMMAND_FRESHNESS,
    createSeededRandom, packCoords, unpackCoords,
    getUnitSelectedFromG, setUnitSelectionInG,
    getGridIndex, isInBounds, getUnitTypeForPlayer, getFactoryTypeForPlayer,
    formatDuration, clamp, distance
} from './utils/GameUtils.js';

import { initGameState, getGameState } from './game/GameState.js';
import { initCamera, getCamera } from './game/Camera.js';
import { MatchmakingDialog } from './ui/MatchmakingDialog.js';
import { MapGenerator } from './game/MapGenerator.js';
import { GridActions } from './game/GridActions.js';
import { InputHandler } from './input/InputHandler.js';
import { GameUI } from './ui/GameUI.js';
import { ActionApplier } from './game/ActionApplier.js';

// ============================================================================
// CONFIGURATION - Edit these values to customize the game
// ============================================================================

// Grid size (width and height in cells)
const GRID_SIZE = 512;

// Default map seed (can be overridden via ?seed=12345 URL param)
const DEFAULT_MAP_SEED = 12345;

// Rendering settings
const METABALL_SCALE = 1.0;           // Metaball blob scale (0.5 = tighter, 2.0 = blobbier)
const TEMPORAL_BLEND = 1.0;           // Temporal AA blend (0 = off, 1 = full). Only affects moving units.

// Performance mode (for slower devices like MacBooks)
let performanceMode = new URLSearchParams(window.location.search).get('perf') === '1';
let showMinimap = !performanceMode;   // Disable minimap in performance mode

// Simulation speed settings
const LOG_INTERVAL = 1000;            // Stats logging interval in ms
const SIM_BATCH_SIZE = 10;            // Simulation steps per batch in fast mode
const SYNC_SIM_BATCH_SIZE = 1;        // Simulation steps per batch in synced (normal) mode
const DEFAULT_SYNC_MODE = true;       // true = sync with render (normal), false = fast as possible

// Map generation - Resource blobs (scaled 4x for 512x512)
const NUM_BLOBS = 600;                // Number of resource clusters (was 150)
const BLOB_MIN_RADIUS = 3;            // Minimum blob radius
const BLOB_MAX_RADIUS = 8;            // Maximum blob radius
const BLOB_DENSITY = 0.6;             // % of cells in blob that have resources

// Map generation - Walls (scaled 4x for 512x512)
const NUM_WALL_LINES = 176;           // Number of wall lines (was 44)
const WALL_MIN_LENGTH = 5;            // Minimum wall line length
const WALL_MAX_LENGTH = 20;           // Maximum wall line length
const NUM_WALL_BLOBS = 20;            // Number of small wall clusters (was 5)
const WALL_BLOB_RADIUS = 3;           // Radius of wall clusters

// Camera/Viewport settings
const DEFAULT_ZOOM = 2.0;             // Initial zoom (2.0 = shows same area as before, 1.0 = full map)
const MIN_ZOOM = 1.5;                 // Minimum zoom (1.5 = at most 2/3 of map visible, prevents seeing entire map)
const MAX_ZOOM = 8.0;                 // Maximum zoom (zoomed in 8x)
const ZOOM_SPEED = 0.1;               // Zoom speed per wheel tick
const PAN_SPEED = 1.0;                // Pan speed multiplier

// Gameplay settings
const FIRST_FACTORY_RESOURCES = 50;   // Resources given to first factory only
const DELETE_RADIUS = 5;              // Radius in grid cells for delete operation

// Cell type and player constants are now imported from GameUtils.js

// Current player (for multiplayer - default to player 1)
// TODO: Migrate to GameState
let currentPlayer = PLAYER_1;

// Spectator mode flag (set later when URL is parsed)
// TODO: Migrate to GameState
let isSpectator = false;

// ============================================================================
// Seeded PRNG for Deterministic Map Generation
// ============================================================================

// createSeededRandom is now imported from GameUtils.js

// Map seed - can be shared between players for deterministic map generation
let mapSeed = DEFAULT_MAP_SEED;
const urlParams = new URLSearchParams(window.location.search);

// Hide multiplayer UI on GitHub Pages (no WebSocket server there)
const isOnGitHub = window.location.hostname.includes('github');
const isOnLocalhost = window.location.hostname.includes('localhost');

const seedParam = urlParams.get('seed');
if (seedParam) {
    mapSeed = parseInt(seedParam) || DEFAULT_MAP_SEED;
}

console.log(`Map seed: ${mapSeed}`);

// ============================================================================
// URL Parameter Handling for Shader Selection
// ============================================================================

function getShaderModeFromURL() {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('shader');
    return mode === 'debug' ? 'debug' : 'metaball';
}

function updateURLShaderMode(mode) {
    const url = new URL(window.location);
    if (mode === 'debug') {
        url.searchParams.set('shader', 'debug');
    } else {
        url.searchParams.delete('shader');
    }
    window.history.replaceState({}, '', url);
}

let currentShaderMode = getShaderModeFromURL();

// ============================================================================
// Initialize GPU
// ============================================================================

const canvas = document.getElementById('canvas');
const gpu = GPU.init(canvas);
const gl = gpu.gl;

// Initialize Camera (from refactored module)
const camera = initCamera({
    gridSize: GRID_SIZE,
    defaultZoom: DEFAULT_ZOOM,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    zoomSpeed: ZOOM_SPEED,
    panSpeed: PAN_SPEED
});
camera.setCanvas(canvas);

function resize() {
    const dpr = window.devicePixelRatio || 1;
    // Use the minimum of width/height to keep canvas square
    const size = Math.min(window.innerWidth, window.innerHeight);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    // Also set CSS size to match
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
}
window.addEventListener('resize', resize);
resize();

console.log('GPU compute framework initialized');

// ============================================================================
// Load Shaders (v2 architecture) - Load both render shaders
// ============================================================================

console.time('⏱️ Total shader loading');
console.time('⏱️ Shader source loading (fetch + preprocess)');

const [simShaderSource, metaballShaderSource, debugShaderSource] = await Promise.all([
    loadShader('./src/shaders/ca/v2/mining_game.frag.glsl'),
    loadShader('./src/shaders/ca/render_metaballs.frag.glsl'),
    loadShader('./src/shaders/ca/v2/render.frag.glsl')
]);

console.timeEnd('⏱️ Shader source loading (fetch + preprocess)');
console.log(`  Shader sizes: sim=${simShaderSource.length}, metaball=${metaballShaderSource.length}, debug=${debugShaderSource.length}`);

console.time('⏱️ Shader compilation (GPU)');

// Create shaders (compilation starts in parallel with KHR_parallel_shader_compile if available)
const simShader = new ComputeShader(simShaderSource);
const metaballRenderShader = new ComputeShader(metaballShaderSource);
const debugRenderShader = new ComputeShader(debugShaderSource);

// Wait for all shaders to compile in parallel
await Promise.all([
    simShader.waitReady(),
    metaballRenderShader.waitReady(),
    debugRenderShader.waitReady()
]);

console.timeEnd('⏱️ Shader compilation (GPU)');
console.timeEnd('⏱️ Total shader loading');

// Active render shader (switchable)
let renderShader = currentShaderMode === 'debug' ? debugRenderShader : metaballRenderShader;

// ============================================================================
// Shader Toggle UI Setup
// ============================================================================

const shaderToggle = document.getElementById('shader-toggle');
const labelPretty = document.getElementById('label-pretty');

function updateToggleLabels() {
    if (currentShaderMode === 'debug') {
        labelPretty.classList.remove('active');
        shaderToggle.checked = true;
    } else {
        labelPretty.classList.add('active');
        shaderToggle.checked = false;
    }
}

function switchShader(mode) {
    currentShaderMode = mode;
    renderShader = mode === 'debug' ? debugRenderShader : metaballRenderShader;
    updateURLShaderMode(mode);
    updateToggleLabels();
    console.log(`Switched to ${mode === 'debug' ? 'Debug' : 'Metaball'} shader`);
}

shaderToggle.addEventListener('change', (e) => {
    switchShader(e.target.checked ? 'debug' : 'metaball');
});

// Initialize toggle state from URL
updateToggleLabels();

// Expose to console for easy switching
window.switchShader = switchShader;
console.log(`Shader mode: ${currentShaderMode} (use switchShader('debug') or switchShader('metaball') to change)`);

// ============================================================================
// Performance Mode Toggle
// ============================================================================

const perfToggle = document.getElementById('perf-toggle');
const perfLabel = document.getElementById('perf-label');

function updatePerfLabel() {
    if (performanceMode) {
        perfLabel.style.opacity = '1';
        perfLabel.style.color = '#22c55e';
        perfToggle.checked = true;
    } else {
        perfLabel.style.opacity = '0.8';
        perfLabel.style.color = '#aaa';
        perfToggle.checked = false;
    }
}

function togglePerformanceMode(enabled) {
    performanceMode = enabled;
    showMinimap = !enabled;
    
    // Update URL
    const url = new URL(window.location);
    if (enabled) {
        url.searchParams.set('perf', '1');
    } else {
        url.searchParams.delete('perf');
    }
    window.history.replaceState({}, '', url);
    
    updatePerfLabel();
    console.log(`Performance mode: ${enabled ? 'ON' : 'OFF'} (minimap: ${showMinimap ? 'visible' : 'hidden'})`);
}

perfToggle.addEventListener('change', (e) => {
    togglePerformanceMode(e.target.checked);
});

// Initialize from URL
updatePerfLabel();
console.log(`Performance mode: ${performanceMode ? 'ON' : 'OFF'}`);

// ============================================================================
// Initialize World
// ============================================================================
const grid = new CAGrid(GRID_SIZE, GRID_SIZE);
const gridActions = new GridActions(GRID_SIZE);

// ActionApplier handles applying game actions to grid data
const actionApplier = new ActionApplier({
    gridSize: GRID_SIZE,
    deleteRadius: DELETE_RADIUS,
    firstFactoryResources: FIRST_FACTORY_RESOURCES,
    onStateChange: (changes) => {
        // Handle factory placement state changes
        if (changes.factoryPlaced) {
            const { player, isFirst } = changes.factoryPlaced;
            playerFactoryCounts[player]++;
            playerTotalFactoriesPlaced[player]++;
            factoriesPlaced++;
            updatePlayerIndicator();
        }
        // Handle factory demolition state changes
        if (changes.factoriesFreed) {
            for (const [owner, count] of Object.entries(changes.factoriesFreed)) {
                playerFactoryCounts[owner] = Math.max(0, playerFactoryCounts[owner] - count);
            }
            updatePlayerIndicator();
        }
    }
});

// ============================================================================
// Rollback Netcode - Checkpoint and Action Queue
// ============================================================================
// CheckpointBuffer stores periodic game state snapshots for rollback
// ActionQueue stores player actions for replay
const CHECKPOINT_INTERVAL = 10;  // Ticks between checkpoints (~166ms at 60fps) - more frequent for accurate rollback
const MAX_CHECKPOINTS = 30;      // Keep ~5 seconds of history (30 * 10 ticks = 300 ticks = 5 sec)
const checkpointBuffer = new CheckpointBuffer(GRID_SIZE, GRID_SIZE, {
    format: 'float'  // Use symbolic name like CAGrid
}, MAX_CHECKPOINTS, CHECKPOINT_INTERVAL);
const actionQueue = new ActionQueue();

// ============================================================================
// Selection System - Selection state is stored directly in unit data (G channel bit 5)
// ============================================================================
// No separate texture needed - selection moves with units automatically

// ============================================================================
// Initialize Audio System
// ============================================================================
const audioReductionPipeline = new AudioReductionPipeline(GRID_SIZE, 4);
const audioEngine = new AudioEngine();
let audioInitialized = false;

// Audio needs to be initialized after a user gesture
async function initAudio() {
    if (audioInitialized) return;
    
    try {
        await audioReductionPipeline.init();
        await audioEngine.init();
        await audioEngine.resume();
        audioInitialized = true;
        console.log('[Audio] System initialized');
        updateAudioButton();
    } catch (e) {
        console.error('[Audio] Failed to initialize:', e);
    }
}

// Expose audio controls and debug utilities
window.initAudio = initAudio;
window.toggleMute = () => {
    const muted = audioEngine.toggleMute();
    updateAudioButton();
    return muted;
};

// Debug: expose audio engine for console testing
window.audio = {
    engine: audioEngine,
    // Test individual sounds
    testSpawn: () => audioEngine.tryPlayOneShot('spawn', 1.0),
    testExplosion: () => audioEngine.tryPlayOneShot('explosion', 1.0),
    testDepletion: () => audioEngine.tryPlayOneShot('depletion', 1.0),
    testReject: () => audioEngine.playReject(),
    // Set loop volumes (0-1)
    setMining: (v) => audioEngine.loops.mining?.gain.gain.setValueAtTime(v * 0.15, audioEngine.audioContext.currentTime),
    setCombat: (v) => audioEngine.loops.combat?.gain.gain.setValueAtTime(v * 0.2, audioEngine.audioContext.currentTime),
    setFactory: (v) => audioEngine.loops.factory?.setActivity?.(v),
    setSwarm: (v) => audioEngine.loops.swarm?.gain.gain.setValueAtTime(v * 0.1, audioEngine.audioContext.currentTime),
    // Stop all sounds
    stopAll: () => {
        Object.values(audioEngine.loops).forEach(l => l?.gain?.gain.setValueAtTime(0, audioEngine.audioContext.currentTime));
    },
    // Show current state
    status: () => console.log('Loops:', audioEngine.loops, 'One-shots:', audioEngine.oneShotPools)
};

function updateAudioButton() {
    const btn = document.getElementById('audioToggle');
    if (btn) {
        if (!audioInitialized) {
            btn.textContent = '🔊';
        } else if (audioEngine.muted) {
            btn.textContent = '🔇';
        } else {
            btn.textContent = '🔊';
        }
    }
}

// Call once to set initial state
updateAudioButton();

const data = new Float32Array(GRID_SIZE * GRID_SIZE * 4);

// Encoding constants and helper functions are now imported from GameUtils.js
// (COORD_PACK_BASE, MEMORY_PACK_BASE, SELECTED_PACK_BASE, AGE_PACK_BASE, COMMAND_FRESHNESS)
// (getUnitSelectedFromG, setUnitSelectionInG, packCoords)

// ============================================================================
// InputHandler - Mouse and Keyboard Input (refactored module)
// ============================================================================
// InputHandler is initialized here but callbacks reference variables defined later.
// This works because JavaScript closures capture variable references, not values.
// The callbacks are only executed when events fire, after all variables are defined.

// Forward declarations for InputHandler callbacks (actual implementations are below)
let handlePlaceFactory, handleDemolish, handleUnitCommand, handleClearSelection;

// Create InputHandler instance
const inputHandler = new InputHandler({
    canvas: canvas,
    camera: camera,
    gridSize: GRID_SIZE,
    zoomSpeed: ZOOM_SPEED,
    deleteRadius: DELETE_RADIUS,
    
    // Callbacks - these use forward references to functions defined later
    onPlaceFactory: (x, y) => handlePlaceFactory?.(x, y),
    onDemolish: (x, y) => handleDemolish?.(x, y),
    onUnitCommand: (command) => handleUnitCommand?.(command),
    onClearSelection: () => handleClearSelection?.(),
    onUnitSelection: (region) => {
        // Sync selection to network if multiplayer
        if (isMultiplayer && networkSync?.isConnected) {
            syncAction({ type: 'unit_selection', player: currentPlayer, region: region });
        }
    },
    onInitAudio: () => {
        if (!audioInitialized) initAudio();
    },
    isSpectator: () => isSpectator,
    screenToGrid: (x, y) => camera.screenToGrid(x, y),
    markUnitsInRegion: (region) => markUnitsInRegion(region),
    clearAllSelections: () => clearAllSelections()
});

// ============================================================================
// Selection Management - Works directly with grid data
// ============================================================================

// Mark units in a region as selected (delegates to GridActions)
function markUnitsInRegion(region) {
    const currentData = grid.download();
    const unitsMarked = gridActions.markUnitsInRegion(currentData, region, currentPlayer);
    if (unitsMarked > 0) {
        grid.upload(currentData);
        console.log(`[Selection] Marked ${unitsMarked} units`);
    }
    return unitsMarked;
}

// Clear all selections from the grid (delegates to GridActions)
function clearAllSelections() {
    const currentData = grid.download();
    const unitsCleared = gridActions.clearAllSelections(currentData, currentPlayer);
    if (unitsCleared > 0) {
        grid.upload(currentData);
        console.log(`[Selection] Cleared ${unitsCleared} units`);
    }
    return unitsCleared;
}

// No longer needed - selection now moves with units automatically in GPU
// function updateSelectionForMovingUnits() { ... }

// Apply a unit command - modify units that are marked as selected
// Apply a unit command - delegates to GridActions
function applyUnitCommand(command) {
    const { destX, destY, player } = command;
    const currentData = grid.download();
    const unitsCommanded = gridActions.applyUnitCommand(currentData, destX, destY, player);
    
    if (unitsCommanded > 0) {
        grid.upload(currentData);
        console.log(`[Command] Commanded ${unitsCommanded} units to move to (${destX}, ${destY})`);
    } else {
        console.log('[Command] No selected units found');
    }
}

// Map generator instance
const mapGenerator = new MapGenerator(GRID_SIZE, {
    numBlobs: NUM_BLOBS,
    blobMinRadius: BLOB_MIN_RADIUS,
    blobMaxRadius: BLOB_MAX_RADIUS,
    blobDensity: BLOB_DENSITY,
    numWallLines: NUM_WALL_LINES,
    wallMinLength: WALL_MIN_LENGTH,
    wallMaxLength: WALL_MAX_LENGTH,
    numWallBlobs: NUM_WALL_BLOBS,
    wallBlobRadius: WALL_BLOB_RADIUS,
});

// Generate map with a specific seed
function generateMap(seed) {
    mapSeed = seed;
    const result = mapGenerator.generate(data, seed);
    grid.upload(data, true);  // allFrames=true for initial map generation
    return result;
}

// Generate initial map
generateMap(mapSeed);
console.log(`  Click to place a mining factory!`);

// ============================================================================
// Click to Place Factory / Shift+Click to Delete
// ============================================================================

const MAX_FACTORIES_PER_PLAYER = 7;
let factoriesPlaced = 0;

// Track factory count per player (bases marked for demolition don't count)
const playerFactoryCounts = {
    [PLAYER_1]: 0,
    [PLAYER_2]: 0
};

// Track total factories ever placed per player (for win/lose condition)
const playerTotalFactoriesPlaced = {
    [PLAYER_1]: 0,
    [PLAYER_2]: 0
};

// Game over state
let gameOver = false;
let winner = null;

// ============================================================================
// Input Handler Callbacks - Game logic for input actions
// ============================================================================
// These are called by InputHandler when user performs actions.
// Input state (mouseX, mouseY, shiftHeld, isSelecting, etc.) is now managed by InputHandler.

// Helper function for render loop to access input state
function getVisibleGridSize() { return camera.getVisibleGridSize(); }

// Helper to convert screen coords to grid coords (used by render loop for mouse position)
function screenToGrid(screenX, screenY) { return camera.screenToGrid(screenX, screenY); }

// ============================================================================
// Input Handler Callback Implementations
// ============================================================================
// These functions are called by InputHandler when user performs game actions.
// All input event handling (mouse, keyboard, wheel) is now in InputHandler.

/**
 * Handle factory placement at grid position
 */
handlePlaceFactory = (x, y) => {
    const currentData = grid.download();
    const centerX = x;
    const centerY = y;
    
    // Check if in multiplayer waiting for opponent
    if (isMultiplayer && connectedPlayers.size < 2) {
        console.log('Waiting for opponent to join before placing factories');
        audioEngine.playReject();
        return;
    }
    
    // Check bounds for 3x3
    if (centerX < 1 || centerX >= GRID_SIZE - 1 || centerY < 1 || centerY >= GRID_SIZE - 1) {
        console.log('Too close to edge for 3x3 structure');
        audioEngine.playReject();
        return;
    }
    
    // Check factory limit
    if (playerFactoryCounts[currentPlayer] >= MAX_FACTORIES_PER_PLAYER) {
        console.log(`Cannot place factory - Player ${currentPlayer} already has ${MAX_FACTORIES_PER_PLAYER} bases (delete some to place more)`);
        audioEngine.playReject();
        return;
    }
    
    // Check that all 8 cells (excluding center) are empty before placing
    let canPlace = true;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;  // Skip center
            const fx = centerX + dx;
            const fy = centerY + dy;
            const idx = (fy * GRID_SIZE + fx) * 4;
            const cellType = currentData[idx];
            if (cellType !== CELL_EMPTY) {
                canPlace = false;
                break;
            }
        }
        if (!canPlace) break;
    }
    
    if (!canPlace) {
        console.log('Cannot place factory - some cells are not empty');
        audioEngine.playReject();
        return;
    }
    
    // First factory FOR EACH PLAYER is built (has resources), subsequent are unbuilt
    const isUnbuilt = playerFactoryCounts[currentPlayer] > 0;
    const totalResources = isUnbuilt ? 0 : FIRST_FACTORY_RESOURCES;
    const resourcesPerCell = totalResources / 8.0;
    
    console.log(`[Factory Placement] currentPlayer: ${currentPlayer}, PLAYER_1: ${PLAYER_1}, PLAYER_2: ${PLAYER_2}`);
    
    // Place 3x3 grid of factory cells (center stays empty)
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            
            const fx = centerX + dx;
            const fy = centerY + dy;
            const idx = (fy * GRID_SIZE + fx) * 4;
            
            const factoryType = currentPlayer === PLAYER_2 ? CELL_MINING_FACTORY_P2 : CELL_MINING_FACTORY;
            currentData[idx + 0] = factoryType;
            currentData[idx + 1] = isUnbuilt ? 0 : resourcesPerCell;
            currentData[idx + 2] = centerX;
            currentData[idx + 3] = centerY;
        }
    }
    
    grid.upload(currentData);
    factoriesPlaced++;
    playerFactoryCounts[currentPlayer]++;
    playerTotalFactoriesPlaced[currentPlayer]++;
    updatePlayerIndicator();
    
    if (isUnbuilt) {
        console.log(`Placed 3x3 UNBUILT factory #${factoriesPlaced} for Player ${currentPlayer} (${playerFactoryCounts[currentPlayer]}/${MAX_FACTORIES_PER_PLAYER} bases) at (${centerX}, ${centerY})`);
    } else {
        console.log(`Placed 3x3 factory #${factoriesPlaced} for Player ${currentPlayer} (${playerFactoryCounts[currentPlayer]}/${MAX_FACTORIES_PER_PLAYER} bases) at (${centerX}, ${centerY}) with ${totalResources} total resources`);
    }
    
    // Sync with network
    syncAction({
        type: 'place_factory',
        x: centerX,
        y: centerY,
        player: currentPlayer,
        isUnbuilt: isUnbuilt,
        factoryNumber: factoriesPlaced
    });
};

/**
 * Handle demolish at grid position
 */
handleDemolish = (x, y) => {
    const currentData = grid.download();
    let markedCount = 0;
    let deletedCount = 0;
    const factoriesAffected = new Set();
    
    for (let dy = -DELETE_RADIUS; dy <= DELETE_RADIUS; dy++) {
        for (let dx = -DELETE_RADIUS; dx <= DELETE_RADIUS; dx++) {
            const fx = x + dx;
            const fy = y + dy;
            
            if (fx < 0 || fx >= GRID_SIZE || fy < 0 || fy >= GRID_SIZE) continue;
            
            const idx = (fy * GRID_SIZE + fx) * 4;
            const cellType = currentData[idx];
            const buildCount = currentData[idx + 1];
            
            if (cellType === CELL_MINING_FACTORY || cellType === CELL_MINING_FACTORY_P2) {
                const owner = cellType === CELL_MINING_FACTORY_P2 ? PLAYER_2 : PLAYER_1;
                
                // Only allow demolishing own factories
                if (owner !== currentPlayer) continue;
                
                const centerX = currentData[idx + 2];
                const centerY = currentData[idx + 3];
                
                factoriesAffected.add(`${owner},${centerX},${centerY}`);
                
                if (buildCount > 0) {
                    currentData[idx + 0] = CELL_DEMOLISH;
                    currentData[idx + 1] = 0;
                    currentData[idx + 2] = centerX;
                    currentData[idx + 3] = centerY;
                    markedCount++;
                } else {
                    currentData[idx + 0] = CELL_EMPTY;
                    currentData[idx + 1] = 0;
                    currentData[idx + 2] = 0;
                    currentData[idx + 3] = 0;
                    deletedCount++;
                }
            }
        }
    }
    
    for (const key of factoriesAffected) {
        const [owner] = key.split(',').map(Number);
        playerFactoryCounts[owner] = Math.max(0, playerFactoryCounts[owner] - 1);
    }
    if (factoriesAffected.size > 0) {
        updatePlayerIndicator();
    }
    
    grid.upload(currentData);
    if (markedCount > 0 || deletedCount > 0) {
        const parts = [];
        if (deletedCount > 0) parts.push(`deleted ${deletedCount} unbuilt`);
        if (markedCount > 0) parts.push(`marked ${markedCount} for demolition`);
        if (factoriesAffected.size > 0) parts.push(`${factoriesAffected.size} base(s) freed`);
        console.log(`${parts.join(', ')} around (${x}, ${y})`);
        
        const factoriesFreed = {};
        for (const key of factoriesAffected) {
            const [owner] = key.split(',').map(Number);
            factoriesFreed[owner] = (factoriesFreed[owner] || 0) + 1;
        }
        
        syncAction({
            type: 'demolish',
            x: x,
            y: y,
            deleted: deletedCount,
            marked: markedCount,
            factoriesFreed: factoriesFreed
        });
    }
};

/**
 * Handle unit command (move selected units to destination)
 */
handleUnitCommand = (command) => {
    const activeCommand = {
        ...command,
        player: currentPlayer
    };
    
    console.log('[Command] Sending units from', inputHandler.getSelection(), 'to', { x: command.destX, y: command.destY });
    
    // Apply command to units in the grid
    applyUnitCommand(activeCommand);
    
    // Sync command to other players
    if (isMultiplayer && networkSync?.isConnected) {
        syncAction({ type: 'unit_command', ...activeCommand });
    }
};

/**
 * Handle clear selection (sync to network)
 */
handleClearSelection = () => {
    if (isMultiplayer && networkSync?.isConnected) {
        syncAction({ type: 'clear_selection', player: currentPlayer });
    }
};

// ============================================================================
// Game UI (Player Indicator, FPS/Tick Display)
// ============================================================================

// Tick sync threshold for display (also defined later for network sync logic)
const TICK_SYNC_DISPLAY_THRESHOLD = 30;

// Initialize GameUI with callbacks to access game state
const gameUI = new GameUI({
    isOnGitHub: isOnGitHub,
    maxFactoriesPerPlayer: MAX_FACTORIES_PER_PLAYER,
    tickSyncThreshold: TICK_SYNC_DISPLAY_THRESHOLD,
    getCurrentPlayer: () => currentPlayer,
    getPlayerFactoryCount: (player) => playerFactoryCounts[player] || 0,
    isSpectator: () => isSpectator,
    isMultiplayer: () => isMultiplayer,
    getSimTime: () => simTime,
    onSwitchPlayer: (player) => window.switchPlayer(player)
});

// Player switch function (exposed globally for debugging)
window.switchPlayer = (player) => {
    if (player === 1 || player === PLAYER_1) {
        currentPlayer = PLAYER_1;
    } else if (player === 2 || player === PLAYER_2) {
        currentPlayer = PLAYER_2;
    } else {
        currentPlayer = currentPlayer === PLAYER_1 ? PLAYER_2 : PLAYER_1;
    }
    console.log(`Switched to Player ${currentPlayer}`);
    gameUI.updatePlayerIndicator();
};

// Convenience wrappers for UI updates (used throughout main.js)
function updatePlayerIndicator() { gameUI.updatePlayerIndicator(); }
function updateTickDisplay() { gameUI.updateTickDisplay(); }
function updateFpsDisplay(currentTps, targetTps, potentialTps = null, renderFps = 60) {
    gameUI.updateFpsDisplay(currentTps, targetTps, potentialTps, renderFps);
}

// FPS/TPS display state
let lastFrameTime = 0;
let frameTimeSmoothed = 16.67;

// Initialize player indicator
updatePlayerIndicator();

console.log('Press 1 or 2 to switch players, or click the player indicator');

// ============================================================================
// Multiplayer Network Sync
// ============================================================================

const networkSync = getNetworkSync(GRID_SIZE);
let isMultiplayer = false;
let waitingForSync = false;  // In multiplayer, wait for state sync before running simulation
let waitingForSyncStartTime = 0;  // When we started waiting
const SYNC_WAIT_TIMEOUT = 3000;  // Give up waiting after 3 seconds

// Periodic full state sync to keep clients aligned
const FULL_SYNC_INTERVAL = 5000;  // Send full state every 5 seconds
let lastFullSyncTime = 0;

// Track connected players in multiplayer
const connectedPlayers = new Set();

// Get room from URL or generate one
const roomParam = urlParams.get('room');
let roomId = roomParam || `game-${mapSeed}`;

// Get player ID from URL (for rejoining after refresh)
const playerParam = urlParams.get('player');
const requestedPlayerId = playerParam ? parseInt(playerParam) : null;
console.log(`[URL Params] playerParam: "${playerParam}", requestedPlayerId: ${requestedPlayerId}`);

// Check if spectator mode
const spectatorParam = urlParams.get('spectator');
isSpectator = spectatorParam === 'true' || spectatorParam === '1';
console.log(`[URL Params] spectatorParam: "${spectatorParam}", isSpectator: ${isSpectator}`);

// Network event handlers
networkSync.onConnectionChange = (connected) => {
    isMultiplayer = connected;
    if (!connected) {
        connectedPlayers.clear();
    }
    updateNetworkIndicator();
};

// Spectator mode handler
networkSync.onSpectating = (spectatorId, serverMapSeed, serverConnectedPlayers) => {
    console.log(`[Spectator] Joined as Spectator ${spectatorId}, mapSeed: ${serverMapSeed}`);
    isSpectator = true;
    
    // Track connected players
    if (serverConnectedPlayers && Array.isArray(serverConnectedPlayers)) {
        serverConnectedPlayers.forEach(pid => connectedPlayers.add(pid));
    }
    
    // Update to server's map seed if different
    if (serverMapSeed !== undefined && serverMapSeed !== mapSeed) {
        console.log(`[Spectator] Server has map seed ${serverMapSeed}, regenerating map...`);
        generateMap(serverMapSeed);
    }
    
    // Update URL with room and spectator flag
    const url = new URL(window.location);
    url.searchParams.set('room', roomId);
    url.searchParams.set('spectator', 'true');
    url.searchParams.delete('player');
    window.history.replaceState({}, '', url);
    
    updateNetworkIndicator();
    updatePlayerIndicator();
};

// Restart handler (for Play Again)
networkSync.onRestart = (newMapSeed, initiatedBy) => {
    console.log(`[Multiplayer] Game restarting with new seed ${newMapSeed}`);
    
    // Keep room and player params, just reload with new seed
    const url = new URL(window.location);
    url.searchParams.set('seed', newMapSeed);
    window.location.href = url.toString();
};

// Tick sync constants
const TICK_SYNC_THRESHOLD = 30;      // Start catching up if behind by this many ticks
const TICK_SYNC_HARD_THRESHOLD = 300; // Request full state sync if behind by this many
const TICK_CATCHUP_BATCH = 10;        // Max ticks to catch up per frame

// Speed sync handler - adjust simulation speed to match slowest peer and sync ticks
networkSync.onSpeedSync = (serverTargetTps, slowestPlayer, tickCounts = {}, targetTick = 0, leaderPlayer = 0) => {
    const oldTarget = targetTicksPerSecond;
    // Enforce minimum of 1 TPS to prevent stalling
    targetTicksPerSecond = Math.max(1, serverTargetTps);
    
    // Only log if target changed significantly
    if (Math.abs(oldTarget - serverTargetTps) > 1) {
        Logger.log('speed', `Target TPS: ${targetTicksPerSecond.toFixed(1)} (slowest: P${slowestPlayer}, our potential: ${effectiveTicksPerSecond.toFixed(1)})`);
    }
    
    // Tick synchronization - check if we're behind the leader
    if (targetTick > 0 && networkSync.playerId) {
        // Update tracking variables for display
        gameUI.setTargetTick(targetTick, leaderPlayer);
        
        const ourTick = Math.floor(simTime);
        const tickDifference = targetTick - ourTick;
        
        if (tickDifference > TICK_SYNC_HARD_THRESHOLD) {
            // Too far behind - request full state sync
            console.log(`[Tick Sync] Too far behind (${tickDifference} ticks), requesting full state sync`);
            // The host will send us their state on the next heartbeat cycle
            // For now, we'll just fast-forward aggressively
            const catchupTicks = Math.min(tickDifference, TICK_CATCHUP_BATCH * 5);
            console.log(`[Tick Sync] Fast-forwarding ${catchupTicks} ticks (from ${ourTick} toward ${targetTick})`);
            for (let i = 0; i < catchupTicks; i++) {
                simulationStep();
            }
        } else if (tickDifference > TICK_SYNC_THRESHOLD) {
            // Moderately behind - catch up gradually
            const catchupTicks = Math.min(tickDifference - TICK_SYNC_THRESHOLD, TICK_CATCHUP_BATCH);
            if (catchupTicks > 0) {
                console.log(`[Tick Sync] Behind by ${tickDifference} ticks, catching up ${catchupTicks} (from ${ourTick} toward ${targetTick})`);
                for (let i = 0; i < catchupTicks; i++) {
                    simulationStep();
                }
            }
        }
    }
};

networkSync.onPlayerJoined = (playerId, isHost, serverMapSeed, serverConnectedPlayers) => {
    console.log(`[Multiplayer] ${isHost ? 'You are the host' : 'Player joined'}: ${playerId}, networkSync.playerId: ${networkSync.playerId}, mapSeed: ${serverMapSeed}, connectedPlayers: ${serverConnectedPlayers}`);
    
    // Track connected players - add all from server list if provided, otherwise just this one
    if (serverConnectedPlayers && Array.isArray(serverConnectedPlayers)) {
        serverConnectedPlayers.forEach(pid => connectedPlayers.add(pid));
    } else {
        connectedPlayers.add(playerId);
    }
    
    // Only assign our player number when WE join, not when others join
    // networkSync.playerId is set before this callback, so we can check if this is our own join
    if (playerId === networkSync.playerId) {
        console.log(`[Multiplayer] This is our join! Setting currentPlayer based on playerId: ${playerId}`);
        if (playerId === 1) {
            currentPlayer = PLAYER_1;
        } else {
            currentPlayer = PLAYER_2;
        }
        console.log(`[Multiplayer] currentPlayer is now: ${currentPlayer} (PLAYER_1=${PLAYER_1}, PLAYER_2=${PLAYER_2})`);
        updatePlayerIndicator();
        
        // If we're the host (Player 1), we don't wait for sync - we ARE the source of truth
        // Non-hosts will receive state sync from host or server cache shortly after joining
        if (isHost && waitingForSync) {
            console.log(`[Multiplayer] We are the host, no need to wait for sync`);
            waitingForSync = false;
        }
        
        // If server provided a map seed different from ours, regenerate the map
        if (serverMapSeed !== undefined && serverMapSeed !== mapSeed) {
            console.log(`[Multiplayer] Server has different map seed (${serverMapSeed}), regenerating map...`);
            generateMap(serverMapSeed);
            // Reset factory counters since we have a fresh map
            playerFactoryCounts[PLAYER_1] = 0;
            playerFactoryCounts[PLAYER_2] = 0;
            playerTotalFactoriesPlaced[PLAYER_1] = 0;
            playerTotalFactoriesPlaced[PLAYER_2] = 0;
            factoriesPlaced = 0;
        }
        
        // Update URL with room, player ID, and seed (for refresh/rejoin)
        const url = new URL(window.location);
        url.searchParams.set('room', roomId);
        url.searchParams.set('player', playerId);
        if (serverMapSeed !== undefined) {
            url.searchParams.set('seed', serverMapSeed);
        }
        window.history.replaceState({}, '', url);
        console.log(`[Multiplayer] URL updated: ${url.toString()}`);
    } else {
        console.log(`[Multiplayer] Another player joined: ${playerId}`);
        
        // If we're Player 1 (the host), sync FULL state to the new player
        // This is critical - lightweight game_action messages won't include the grid!
        if (networkSync.playerId === 1) {
            console.log(`[Multiplayer] We are the host - syncing FULL game state to new player`);
            
            // Download current grid state
            const gridData = grid.download();
            
            // Send full state sync (binary) with simTime so new player starts at same tick
            networkSync.syncState(gridData, {
                type: 'player_sync',
                reason: 'new_player_joined',
                newPlayerId: playerId,
                factoryCounts: { ...playerFactoryCounts },
                totalPlaced: { ...playerTotalFactoriesPlaced },
                factoriesPlaced: factoriesPlaced
            }, simTime);
            
            console.log(`[Multiplayer] Sent full state at tick ${simTime} to new player ${playerId}`);
        }
    }
    updateNetworkIndicator();
};

networkSync.onPlayerLeft = (playerId) => {
    console.log(`[Multiplayer] Player ${playerId} left`);
    connectedPlayers.delete(playerId);
    updateNetworkIndicator();
};

networkSync.onStateReceived = (syncData) => {
    // Received state from another player - apply it
    const receiveTime = performance.now();
    const isPeriodicSync = syncData.action && syncData.action.type === 'periodic_sync';
    const tickDiff = Math.floor(syncData.simTime - simTime);
    const syncType = isPeriodicSync ? 'PERIODIC' : 'FULL';
    const behindAhead = tickDiff > 0 ? 'behind' : tickDiff < 0 ? 'ahead' : 'in-sync';
    
    Logger.log('sync', `=== ${syncType} SYNC from P${syncData.playerId} ===`);
    Logger.log('sync', `Their tick: ${Math.floor(syncData.simTime)}, Our tick: ${Math.floor(simTime)}, Delta: ${tickDiff} (we are ${behindAhead})`);
    
    // Clear waiting state - we now have valid state to work with
    if (waitingForSync) {
        Logger.log('sync', 'State sync received, simulation can now run');
        waitingForSync = false;
    }
    
    // Update local grid with received state
    const uploadStart = performance.now();
    const stateSize = syncData.gridState ? syncData.gridState.length : 0;
    
    if (syncData.gridState && stateSize > 0) {
        grid.upload(syncData.gridState);
        const uploadTime = performance.now() - uploadStart;
        Logger.log('sync', `Grid uploaded: ${(stateSize * 4 / 1024 / 1024).toFixed(2)} MB in ${uploadTime.toFixed(1)}ms`);
    } else {
        Logger.error('sync', 'No grid state to upload!');
        return;
    }
    
    // For periodic syncs: Apply grid state, set simTime to match, then fast-forward
    // For initial/player syncs: Just sync the time since we're starting fresh
    const oldSimTime = simTime;
    if (!isPeriodicSync) {
        simTime = syncData.simTime;
        Logger.log('sync', `Initial sync: tick set to ${Math.floor(simTime)}`);
    } else {
        // For periodic sync: we need to fast-forward from the received tick to our current tick
        const ticksToFastForward = Math.floor(oldSimTime - syncData.simTime);
        
        if (ticksToFastForward > 0 && ticksToFastForward < 120) {
            // We're ahead - fast-forward the received state to catch up
            Logger.log('sync', `Fast-forwarding ${ticksToFastForward} ticks (from ${Math.floor(syncData.simTime)} to ${Math.floor(oldSimTime)})`);
            simTime = syncData.simTime;
            
            const ffStart = performance.now();
            for (let i = 0; i < ticksToFastForward; i++) {
                simShader.use();
                simShader.setTexture('u_state', grid.getReadTexture(), 0);
                simShader.setVec2('u_resolution', GRID_SIZE, GRID_SIZE);
                simShader.setFloat('u_time', simTime);
                grid.getWriteFramebuffer().bind();
                simShader.dispatch();
                grid.getWriteFramebuffer().unbind();
                grid.swap();
                simTime += 1.0;
            }
            const ffTime = performance.now() - ffStart;
            Logger.log('sync', `Fast-forward complete: now at tick ${Math.floor(simTime)} (${ffTime.toFixed(1)}ms)`);
        } else if (ticksToFastForward <= 0) {
            simTime = syncData.simTime;
            Logger.log('sync', `We were behind: tick synced to ${Math.floor(simTime)}`);
        } else {
            simTime = syncData.simTime;
            Logger.log('sync', `Too far ahead (${ticksToFastForward} ticks): reset to ${Math.floor(simTime)}`);
        }
    }
    
    // For initial syncs: clear rollback state since we're starting fresh
    if (!isPeriodicSync) {
        if (checkpointBuffer) {
            checkpointBuffer.clear();
            Logger.log('checkpoint', 'Cleared checkpoint buffer');
        }
        if (actionQueue) {
            actionQueue.clear();
            Logger.log('action', 'Cleared action queue');
        }
        
        // Save a checkpoint at this new state immediately
        if (checkpointBuffer && grid) {
            const checkpointData = grid.download();
            checkpointBuffer.saveCheckpoint(simTime, checkpointData);
            console.log(`[Multiplayer] Saved initial checkpoint at tick ${simTime}`);
        }
    }
    
    // Update factory counts based on action
    const action = syncData.action;
    if (action) {
        if (action.type === 'player_sync' || action.type === 'periodic_sync') {
            // Full state sync from host - replace our factory counts entirely
            if (action.factoryCounts) {
                playerFactoryCounts[PLAYER_1] = action.factoryCounts[PLAYER_1] || 0;
                playerFactoryCounts[PLAYER_2] = action.factoryCounts[PLAYER_2] || 0;
            }
            if (action.totalPlaced) {
                playerTotalFactoriesPlaced[PLAYER_1] = action.totalPlaced[PLAYER_1] || 0;
                playerTotalFactoriesPlaced[PLAYER_2] = action.totalPlaced[PLAYER_2] || 0;
            }
            if (action.factoriesPlaced !== undefined) {
                factoriesPlaced = action.factoriesPlaced;
            }
            const syncType = action.type === 'periodic_sync' ? 'Periodic' : 'Full';
            console.log(`[Multiplayer] ${syncType} state sync received at tick ${simTime}. Factories: P1=${playerFactoryCounts[PLAYER_1]}, P2=${playerFactoryCounts[PLAYER_2]}`);
            updatePlayerIndicator();
        } else if (action.type === 'place_factory' && action.player) {
            playerFactoryCounts[action.player]++;
            playerTotalFactoriesPlaced[action.player]++;
            factoriesPlaced++;
            console.log(`[Multiplayer] Player ${action.player} placed factory (${playerFactoryCounts[action.player]}/${MAX_FACTORIES_PER_PLAYER})`);
            updatePlayerIndicator();
        } else if (action.type === 'demolish' && action.factoriesFreed) {
            // Decrement counts for freed factories
            for (const [player, count] of Object.entries(action.factoriesFreed)) {
                playerFactoryCounts[player] = Math.max(0, playerFactoryCounts[player] - count);
            }
            console.log(`[Multiplayer] Factories demolished, counts: P1=${playerFactoryCounts[PLAYER_1]}, P2=${playerFactoryCounts[PLAYER_2]}`);
            updatePlayerIndicator();
        } else if (action.type === 'unit_command') {
            // Other player issued a unit command
            console.log(`[Multiplayer] Player ${syncData.playerId} issued unit command`);
            // The grid state is already applied, no need to reapply the command
        } else if (action.type === 'clear_selection') {
            // Other player cleared their selection
            console.log(`[Multiplayer] Player ${syncData.playerId} cleared selection`);
            // No action needed - selections are local to each player
        } else if (action.type === 'unit_selection') {
            // Other player made a selection
            console.log(`[Multiplayer] Player ${syncData.playerId} selected units in region`);
            // No action needed - selections are local to each player
        }
    }
    
    // Selection is stored in unit data (G channel bit 5) and persists automatically
    // No need to re-apply selection - it's part of the grid state
    
    console.log(`[Multiplayer] State applied. Action: ${action?.type || 'unknown'}`);
};

// Network indicator UI
function updateNetworkIndicator() {
    // Don't show network indicator on GitHub Pages
    if (isOnGitHub) return;
    
    let indicator = document.getElementById('network-indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'network-indicator';
        indicator.style.cssText = `
            position: fixed;
            top: 38px;
            left: 8px;
            z-index: 200;
            padding: 4px 8px;
            border-radius: 4px;
            font-family: 'SF Mono', monospace;
            font-size: 10px;
            backdrop-filter: blur(8px);
            cursor: pointer;
        `;
        indicator.onclick = toggleMultiplayer;
        document.body.appendChild(indicator);
    }
    
    if (isMultiplayer) {
        // Show player connection status
        const p1Connected = connectedPlayers.has(1);
        const p2Connected = connectedPlayers.has(2);
        const p1Status = p1Connected ? '🟣' : '⚫';
        const p2Status = p2Connected ? '🟢' : '⚫';
        
        if (isSpectator) {
            indicator.innerHTML = `👁 Spectating <span style="opacity: ${p1Connected ? 1 : 0.4}">${p1Status}</span> <span style="opacity: ${p2Connected ? 1 : 0.4}">${p2Status}</span>`;
            indicator.style.background = 'rgba(60, 60, 80, 0.9)';
        } else {
            indicator.innerHTML = `<span style="opacity: ${p1Connected ? 1 : 0.4}">${p1Status} P1</span> <span style="opacity: ${p2Connected ? 1 : 0.4}">${p2Status} P2</span>`;
            indicator.style.background = 'rgba(40, 40, 40, 0.9)';
        }
        indicator.style.color = 'white';
        indicator.style.border = '1px solid rgba(100, 100, 100, 0.8)';
    } else {
        indicator.textContent = '⚪ Click to Connect';
        indicator.style.background = 'rgba(80, 80, 80, 0.8)';
        indicator.style.color = 'white';
        indicator.style.border = '2px solid rgba(120, 120, 120, 0.8)';
    }
    
    // Hide Super Speed toggle when in multiplayer (speed must be synced) - but allow on localhost
    const speedToggleContainer = document.getElementById('speed-toggle-container');
    if (speedToggleContainer) {
        // On localhost, always show the toggle (user can choose speed)
        // On non-localhost, hide if in multiplayer or if not on localhost at all
        const shouldHide = isMultiplayer && !isOnLocalhost;
        speedToggleContainer.style.display = shouldHide ? 'none' : 'flex';
        
        // Also force sync mode when in multiplayer
        if (isMultiplayer && !SYNC_SIM_WITH_RENDER) {
            SYNC_SIM_WITH_RENDER = true;
            const toggle = document.getElementById('speed-toggle');
            if (toggle) toggle.checked = false;
            updateSpeedToggleDisplay();
        }
    }
}

// Matchmaking dialog instance (created lazily)
let matchmakingDialog = null;

async function joinRoom(roomIdToJoin) {
    try {
        const wsUrl = `ws://${window.location.host}/ws`;
        console.log(`[Multiplayer] Joining room: ${roomIdToJoin}`);
        // Update the global roomId so URL updates correctly
        roomId = roomIdToJoin;
        // Wait for state sync before running simulation (unless we become host)
        waitingForSync = true;
        waitingForSyncStartTime = performance.now();
        await networkSync.connect(wsUrl, roomIdToJoin, null, false);
        console.log(`[Multiplayer] Connected to room: ${roomIdToJoin}`);
    } catch (error) {
        console.error('[Multiplayer] Connection failed:', error);
    }
}

async function watchRoom(roomIdToWatch) {
    try {
        const wsUrl = `ws://${window.location.host}/ws`;
        console.log(`[Spectator] Watching room: ${roomIdToWatch}`);
        // Update the global roomId
        roomId = roomIdToWatch;
        isSpectator = true;
        await networkSync.connect(wsUrl, roomIdToWatch, null, true);
        console.log(`[Spectator] Connected to room: ${roomIdToWatch}`);
    } catch (error) {
        console.error('[Spectator] Failed to watch room:', error);
    }
}

async function toggleMultiplayer() {
    if (isMultiplayer) {
        networkSync.disconnect();
    } else {
        // Create matchmaking dialog if not exists
        if (!matchmakingDialog) {
            matchmakingDialog = new MatchmakingDialog(networkSync, {
                onJoinRoom: joinRoom,
                onWatchRoom: watchRoom,
                onCreateRoom: joinRoom
            });
        }
        await matchmakingDialog.show();
    }
}

// Sync state after an action - NEW: lightweight action-only sync
function syncAction(action) {
    if (isMultiplayer && networkSync.isConnected) {
        // Store action locally for potential replay
        const storedAction = actionQueue.addAction(simTime, currentPlayer, action.type, action, true);
        console.log(`[syncAction] Stored local action: ${action.type} at tick ${simTime}, queue size: ${actionQueue.actions.length}`);
        
        // Send lightweight action message (no grid data!)
        networkSync.sendAction(action, simTime);
        console.log(`[syncAction] Sent lightweight action: ${action.type} at tick ${simTime}`);
    }
}

// ============================================================================
// Rollback Netcode - Apply and Replay
// ============================================================================

/**
 * Apply an action to the current grid state.
 * This is called both for local actions and during replay.
 * Delegates to ActionApplier for the actual grid manipulation.
 * 
 * @param {Object} action - The action to apply
 * @param {number} playerId - The player who performed the action
 * @returns {boolean} True if the grid was modified
 */
function applyAction(action, playerId) {
    const currentData = grid.download();
    const modified = actionApplier.applyAction(currentData, action, playerId);
    
    if (modified) {
        grid.uploadCurrent(currentData);
    }
    
    return modified;
}

/**
 * Rollback to a checkpoint and replay simulation with actions.
 * This is called when a remote action arrives from the past.
 * 
 * @param {number} targetTick - The tick we need to go back to
 * @param {Object} incomingAction - The new action that triggered rollback
 * @param {number} incomingPlayerId - The player who performed the incoming action
 */
function rollbackAndReplay(targetTick, incomingAction, incomingPlayerId) {
    const currentTick = Math.floor(simTime);
    const rollbackStart = performance.now();
    
    Logger.log('rollback', `=== ROLLBACK START ===`);
    Logger.log('rollback', `Trigger: ${incomingAction.type} from Player ${incomingPlayerId} at tick ${targetTick}`);
    Logger.log('rollback', `Current tick: ${currentTick}, Target tick: ${targetTick}, Delta: ${currentTick - targetTick} ticks`);
    
    // Add the incoming action to the queue FIRST
    if (!actionQueue.hasAction(targetTick, incomingPlayerId, incomingAction.type)) {
        actionQueue.addAction(targetTick, incomingPlayerId, incomingAction.type, incomingAction, false);
    }
    
    // Debug: show all actions in queue
    Logger.log('rollback', `Queue has ${actionQueue.actions.length} actions`);
    
    // Find the OLDEST UNAPPLIED action that needs replaying
    const unappliedActions = actionQueue.actions.filter(a => !a.applied);
    const oldestUnappliedTick = unappliedActions.length > 0 
        ? Math.min(...unappliedActions.map(a => a.tick)) 
        : targetTick;
    const rollbackToTick = Math.min(targetTick, oldestUnappliedTick);
    Logger.log('rollback', `Unapplied: ${unappliedActions.length}, oldest=${oldestUnappliedTick}, rollbackTo=${rollbackToTick}`);
    
    // Find the best checkpoint before ALL actions that need replaying
    const checkpoint = checkpointBuffer.findCheckpointBefore(rollbackToTick);
    if (!checkpoint) {
        Logger.error('rollback', `No checkpoint found before tick ${rollbackToTick}, oldest: ${checkpointBuffer.getOldestTick()}`);
        applyAction(incomingAction, incomingPlayerId);
        return;
    }
    
    Logger.log('checkpoint', `Using checkpoint at tick ${checkpoint.tick} (target: ${rollbackToTick})`);
    
    // Verify checkpoint is strictly BEFORE the rollback target
    if (checkpoint.tick >= rollbackToTick) {
        Logger.error('rollback', `Checkpoint at ${checkpoint.tick} is NOT before target ${rollbackToTick}!`);
        applyAction(incomingAction, incomingPlayerId);
        return;
    }
    
    // Restore from checkpoint
    const restoreStart = performance.now();
    grid.uploadCurrent(checkpoint.cpuData);
    const tickBeforeReplay = simTime;
    simTime = checkpoint.tick;
    const restoreTime = performance.now() - restoreStart;
    Logger.log('checkpoint', `Restored to tick ${checkpoint.tick} in ${restoreTime.toFixed(1)}ms`);
    
    // Reset applied status for ALL actions at or after checkpoint tick
    actionQueue.resetAppliedAfter(checkpoint.tick - 1);
    
    // Get ALL actions that need to be replayed
    const actionsToReplay = actionQueue.getActionsInRange(checkpoint.tick - 1, currentTick);
    Logger.log('rollback', `Replaying ${actionsToReplay.length} actions from tick ${checkpoint.tick} to ${currentTick}`);
    
    // Count simulation steps for debugging
    let simStepsRun = 0;
    let actionsApplied = 0;
    
    // Replay simulation from checkpoint to current tick
    const replayStart = performance.now();
    while (simTime < currentTick) {
        // Apply all actions that should happen at this tick
        const actionsAtTick = actionsToReplay.filter(a => a.tick === Math.floor(simTime));
        for (const action of actionsAtTick) {
            if (!action.applied) {
                Logger.log('action', `Replay: ${action.type} at tick ${Math.floor(simTime)} for P${action.playerId}`);
                applyAction(action.data, action.playerId);
                action.applied = true;
                actionsApplied++;
            }
        }
        
        // Run simulation step (this increments simTime)
        simulationStep();
        simStepsRun++;
    }
    
    // Apply any actions at the final tick
    const finalActions = actionsToReplay.filter(a => a.tick === currentTick);
    for (const action of finalActions) {
        if (!action.applied) {
            Logger.log('action', `Final: ${action.type} at tick ${Math.floor(simTime)} for P${action.playerId}`);
            applyAction(action.data, action.playerId);
            action.applied = true;
            actionsApplied++;
        }
    }
    
    const replayTime = performance.now() - replayStart;
    const totalTime = performance.now() - rollbackStart;
    
    Logger.log('rollback', `=== ROLLBACK COMPLETE ===`);
    Logger.log('rollback', `Sim steps: ${simStepsRun}, Actions applied: ${actionsApplied}`);
    Logger.log('rollback', `Tick: ${tickBeforeReplay} -> ${checkpoint.tick} -> ${Math.floor(simTime)}`);
    Logger.log('rollback', `Time: restore=${restoreTime.toFixed(1)}ms, replay=${replayTime.toFixed(1)}ms, total=${totalTime.toFixed(1)}ms`);
}

// Handle incoming actions from other players
networkSync.onActionReceived = (message) => {
    const { playerId, simTime: actionTick, action } = message;
    const tickDelta = Math.floor(simTime) - actionTick;
    
    Logger.log('network', `Received: ${action.type} from P${playerId} at tick ${actionTick} (we're at ${Math.floor(simTime)}, delta=${tickDelta})`);
    
    if (actionTick <= simTime) {
        // Action is in the past - need to rollback and replay
        rollbackAndReplay(actionTick, action, playerId);
    } else {
        // Action is in the future - queue it for later
        actionQueue.addAction(actionTick, playerId, action.type, action, false);
        Logger.log('network', `Queued future action for tick ${actionTick}`);
    }
};

// Initialize network indicator
updateNetworkIndicator();

// Expose to console
window.toggleMultiplayer = toggleMultiplayer;
window.networkSync = networkSync;
console.log(`Room ID: ${roomId} - Click network indicator or call toggleMultiplayer() to connect`);

// Auto-connect if room URL param is present (for rejoining after refresh or spectator mode)
if (roomParam && !isOnGitHub) {
    if (spectatorParam) {
        // Auto-connect as spectator
        console.log(`[Spectator] Auto-connecting to room ${roomId} as spectator...`);
        (async () => {
            try {
                await watchRoom(roomId);
            } catch (error) {
                console.error('[Spectator] Reconnection failed:', error);
            }
        })();
    } else if (playerParam) {
        // Auto-connect as player with saved player ID
        console.log(`[Multiplayer] Auto-connecting to room ${roomId} as player ${requestedPlayerId}...`);
        // Wait for state sync before running simulation
        waitingForSync = true;
        waitingForSyncStartTime = performance.now();
        (async () => {
            try {
                const wsUrl = `ws://${window.location.host}/ws`;
                await networkSync.connect(wsUrl, roomId, requestedPlayerId, false);
                console.log(`[Multiplayer] Reconnected to room: ${roomId}`);
            } catch (error) {
                console.error('[Multiplayer] Reconnection failed:', error);
            }
        })();
    }
}

// ============================================================================
// Simulation Loop
// ============================================================================

let simStepCount = 0;
let renderFrameCount = 0;
let lastLogTime = performance.now();
let simTime = 0;
let lastLoggedTick = -1;  // For debug logging

// Speed synchronization for multiplayer
let effectiveTicksPerSecond = 60;  // Measured actual TPS (may be throttled)
let potentialTicksPerSecond = 60;  // What we COULD run at (unthrottled)
let targetTicksPerSecond = 60;     // Target TPS from server (slowest peer)
let lastHeartbeatTime = 0;
let lastTpsCalcTime = performance.now();
let tpsCalcStepCount = 0;
let tpsFrameTimeAccumulator = 0;   // Accumulate frame times to measure potential
let tpsFrameCount = 0;             // Frame count for TPS calculation
const HEARTBEAT_INTERVAL = 1000;   // Send heartbeat every second
const TPS_MARGIN = 5;              // Add margin to target TPS to allow speedup

// Toggle: true = sync with render (normal speed), false = fast as possible (super speed)
// Default to normal speed, but allow toggle on localhost
// Force sync mode (hide toggle) when not on localhost
let SYNC_SIM_WITH_RENDER = DEFAULT_SYNC_MODE;

// Super Speed Toggle UI
const speedToggle = document.getElementById('speed-toggle');
const speedLabel = document.getElementById('speed-label');
const speedToggleContainer = document.getElementById('speed-toggle-container');

function updateSpeedToggleUI() {
    const superSpeedOn = !SYNC_SIM_WITH_RENDER;
    if (speedToggle) speedToggle.checked = superSpeedOn;
    if (speedLabel) {
        speedLabel.classList.toggle('active', superSpeedOn);
    }
}

function setSuperSpeed(enabled) {
    const wasFast = !SYNC_SIM_WITH_RENDER;
    SYNC_SIM_WITH_RENDER = !enabled;
    updateSpeedToggleUI();
    console.log(`Super Speed: ${enabled ? 'ON (fast as possible)' : 'OFF (synced with render)'}`);
    if (!SYNC_SIM_WITH_RENDER && !wasFast) {
        // Start the fast loop when switching to fast mode
        fastSimulationLoop();
    }
}

if (speedToggle) {
    speedToggle.addEventListener('change', (e) => {
        setSuperSpeed(e.target.checked);
    });
}

// Hide speed toggle on non-localhost (forced sync mode)
if (!isOnLocalhost && speedToggleContainer) {
    speedToggleContainer.style.display = 'none';
}

// Initialize UI state
updateSpeedToggleUI();

// Audio toggle button
const audioToggleBtn = document.getElementById('audioToggle');
if (audioToggleBtn) {
    audioToggleBtn.addEventListener('click', async () => {
        if (!audioInitialized) {
            await initAudio();
        } else {
            audioEngine.toggleMute();
            updateAudioButton();
        }
    });
}

// Expose toggle to console for easy switching
window.toggleSimSync = () => {
    setSuperSpeed(SYNC_SIM_WITH_RENDER); // If currently synced, enable super speed (and vice versa)
};
console.log(`Simulation sync: ${SYNC_SIM_WITH_RENDER ? 'ON (synced with render)' : 'OFF (fast as possible)'} - Call toggleSimSync() to change`);

function simulationStep() {
    // In multiplayer, don't run simulation until we've received initial state sync
    if (waitingForSync) {
        // Check for timeout - if we've waited too long, proceed anyway
        if (performance.now() - waitingForSyncStartTime > SYNC_WAIT_TIMEOUT) {
            console.warn(`[Multiplayer] Sync wait timeout after ${SYNC_WAIT_TIMEOUT}ms, proceeding with local state`);
            waitingForSync = false;
        } else {
            return;
        }
    }
    
    // Apply any queued actions that should happen at this tick (from network)
    if (isMultiplayer) {
        const actionsAtTick = actionQueue.getActionsAtTick(simTime);
        
        // If we have actions to apply, save a checkpoint BEFORE applying them
        // This ensures we can rollback to the state right before the action
        if (actionsAtTick.length > 0 && actionsAtTick.some(a => !a.applied)) {
            const checkpointData = grid.download();
            checkpointBuffer.saveCheckpoint(simTime, checkpointData);
        }
        
        for (const action of actionsAtTick) {
            if (!action.applied) {
                applyAction(action.data, action.playerId);
                action.applied = true;
            }
        }
    }
    
    grid.getWriteFramebuffer().bind();
    
    simShader.use();
    simShader.setTexture('u_state', grid.getReadTexture(), 0);
    simShader.setVec2('u_resolution', GRID_SIZE, GRID_SIZE);
    simShader.setFloat('u_time', simTime);
    
    // Debug: log every 100 ticks to verify simTime is consistent
    if (Math.floor(simTime) % 100 === 0 && Math.floor(simTime) !== lastLoggedTick) {
        lastLoggedTick = Math.floor(simTime);
        console.log(`[Sim] Running step at tick ${Math.floor(simTime)}`);
    }
    
    simShader.dispatch();
    
    grid.getWriteFramebuffer().unbind();
    grid.swap();
    
    simStepCount++;
    tpsCalcStepCount++;
    simTime += 1.0;
    
    // Save checkpoint periodically for rollback netcode
    if (isMultiplayer && checkpointBuffer.shouldSaveCheckpoint(simTime)) {
        const checkpointData = grid.download();
        checkpointBuffer.saveCheckpoint(simTime, checkpointData);
        
        // Garbage collect old applied actions that we can't rollback to anyway
        const oldestCheckpointTick = checkpointBuffer.getOldestTick();
        actionQueue.garbageCollectBeforeCheckpoint(oldestCheckpointTick);
    }
}

function logStats() {
    const now = performance.now();
    const elapsed = now - lastLogTime;
    if (elapsed >= LOG_INTERVAL) {
        const simFps = (simStepCount / elapsed) * 1000;
        const renderFps = (renderFrameCount / elapsed) * 1000;
        // console.log(`Sim: ${simFps.toFixed(0)} steps/sec | Render: ${renderFps.toFixed(0)} fps | Step: ${Math.floor(simTime)}`);
        simStepCount = 0;
        renderFrameCount = 0;
        lastLogTime = now;
    }
    
    // Calculate effective TPS and potential TPS for speed sync
    const tpsElapsed = now - lastTpsCalcTime;
    if (tpsElapsed >= 500) {  // Update TPS estimate every 500ms
        // Actual TPS - how many steps we actually ran
        const measuredTps = (tpsCalcStepCount / tpsElapsed) * 1000;
        effectiveTicksPerSecond = Math.max(1, measuredTps);
        tpsCalcStepCount = 0;
        
        // Potential TPS - based on render frame rate (how fast we COULD run)
        if (tpsFrameCount > 0) {
            const avgFrameTime = tpsFrameTimeAccumulator / tpsFrameCount;
            potentialTicksPerSecond = Math.max(1, 1000 / avgFrameTime);
        }
        tpsFrameTimeAccumulator = 0;
        tpsFrameCount = 0;
        lastTpsCalcTime = now;
        
        // Update FPS display - potentialTicksPerSecond IS the render FPS when synced
        updateFpsDisplay(effectiveTicksPerSecond, targetTicksPerSecond, potentialTicksPerSecond, potentialTicksPerSecond);
        
        // Update tick counter display
        updateTickDisplay();
    }
    
    // Send heartbeat periodically in multiplayer
    if (isMultiplayer && networkSync.isConnected && !isSpectator) {
        if (now - lastHeartbeatTime >= HEARTBEAT_INTERVAL) {
            // Send POTENTIAL TPS (what we could run at), not actual (throttled) TPS
            // This allows the system to speed up when both peers can go faster
            if (potentialTicksPerSecond > 1) {
                networkSync.sendHeartbeat(potentialTicksPerSecond, Math.floor(simTime));
            }
            lastHeartbeatTime = now;
        }
        
        // Periodic full state sync from host to keep all clients aligned
        // This compensates for any remaining determinism issues
        if (networkSync.playerId === 1 && now - lastFullSyncTime >= FULL_SYNC_INTERVAL) {
            const gridData = grid.download();
            networkSync.syncState(gridData, {
                type: 'periodic_sync',
                factoryCounts: { ...playerFactoryCounts },
                totalPlaced: { ...playerTotalFactoriesPlaced },
                factoriesPlaced: factoriesPlaced
            }, simTime);
            lastFullSyncTime = now;
            Logger.log('sync', `Sent periodic sync at tick ${Math.floor(simTime)}`);
        }
    }
}

// Fast simulation loop (runs as fast as possible via setTimeout)
function fastSimulationLoop() {
    if (SYNC_SIM_WITH_RENDER) return; // Stop if switched to sync mode
    
    for (let i = 0; i < SIM_BATCH_SIZE; i++) {
        simulationStep();
    }
    
    logStats();
    
    setTimeout(fastSimulationLoop, 0);
}

// ============================================================================
// Win/Lose Condition Check
// ============================================================================

// Scan the grid to count actual factories per player (delegates to GridActions)
function countFactoriesOnMap() {
    const data = grid.download();
    return gridActions.countFactories(data);
}

// Check for win/lose condition
function checkWinCondition() {
    if (gameOver) return;
    
    // Count actual factories on map
    const actualCounts = countFactoriesOnMap();
    
    // Update our tracked counts to match reality (GPU might have destroyed some)
    playerFactoryCounts[PLAYER_1] = actualCounts[PLAYER_1];
    playerFactoryCounts[PLAYER_2] = actualCounts[PLAYER_2];
    updatePlayerIndicator();
    
    // Check lose condition: placed at least one base AND now have none left
    // (Must have placed at least one base to lose - can't lose before placing anything)
    for (const player of [PLAYER_1, PLAYER_2]) {
        if (playerTotalFactoriesPlaced[player] >= 1 && actualCounts[player] === 0) {
            // This player loses - all their bases were destroyed
            gameOver = true;
            winner = player === PLAYER_1 ? PLAYER_2 : PLAYER_1;
            console.log(`Player ${player} lost - all bases destroyed!`);
            showGameOver();
            return;
        }
    }
}

// Display game over screen (using GameUI module)
function showGameOver() {
    gameUI.showGameOver(winner, isMultiplayer, isSpectator, () => {
        if (isMultiplayer && !isSpectator) {
            networkSync.requestRestart();
        } else {
            const url = new URL(window.location);
            url.searchParams.set('seed', Math.floor(Math.random() * 999999));
            window.location.href = url.toString();
        }
    });
}

// Check win condition every 5 seconds
setInterval(checkWinCondition, 5000);

// ============================================================================
// Render Loop (also runs synced simulation if enabled)
// ============================================================================

let lastSimStepTime = 0;  // Start at 0 so first step runs immediately
let lastRenderTime = 0;   // For measuring potential TPS

function renderLoop() {
    const now = performance.now();
    
    // Measure potential TPS based on render frame rate
    // This tells us how fast we COULD run, regardless of throttling
    if (lastRenderTime > 0) {
        const frameTime = now - lastRenderTime;
        tpsFrameTimeAccumulator += frameTime;
        tpsFrameCount++;
    }
    lastRenderTime = now;
    
    // Run simulation step if synced mode
    if (SYNC_SIM_WITH_RENDER) {
        // In multiplayer, throttle to match target TPS (with margin for speedup)
        // But always ensure at least 1 TPS minimum
        const effectiveTargetTps = isMultiplayer ? Math.max(1, targetTicksPerSecond + TPS_MARGIN) : 999;
        const targetFrameTime = 1000 / effectiveTargetTps;
        
        // Initialize lastSimStepTime on first frame
        if (lastSimStepTime === 0) {
            lastSimStepTime = now;
        }
        
        // Run simulation if enough time has passed (or if in single-player, always run)
        // Use a while loop to catch up if we're behind
        if (!isMultiplayer) {
            // Single player: run every frame
            for (let i = 0; i < SYNC_SIM_BATCH_SIZE; i++) {
                simulationStep();
            }
            lastSimStepTime = now;
        } else {
            // Multiplayer: throttle to target TPS, but run multiple steps if behind
            let stepsTaken = 0;
            const maxStepsPerFrame = 3;  // Prevent runaway if very behind
            while ((now - lastSimStepTime) >= targetFrameTime && stepsTaken < maxStepsPerFrame) {
                for (let i = 0; i < SYNC_SIM_BATCH_SIZE; i++) {
                    simulationStep();
                }
                lastSimStepTime += targetFrameTime;  // Advance by target amount, not "now"
                stepsTaken++;
            }
        }
    }
    
    // Always call logStats to update FPS display
    logStats();
    
    // Selection is now stored in unit data (G channel bit 5) and moves automatically
    
    // ========================================================================
    // Audio: Run reduction pipeline and update audio engine
    // ========================================================================
    if (audioInitialized) {
        // Run reduction pipeline on current game state
        const soundParams = audioReductionPipeline.run(grid.getReadTexture());
        
        // Update audio engine with sound parameters
        audioEngine.update(audioReductionPipeline.getSoundParams());
    }
    
    // Render
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);

    renderShader.use();
    
    // Bind all 8 frame textures for temporal anti-aliasing
    const frameCount = grid.getFrameCount();
    for (let i = 0; i < frameCount; i++) {
        renderShader.setTexture('u_state' + i, grid.getTextureByAge(i), i);
    }
    
    renderShader.setVec2('u_resolution', GRID_SIZE, GRID_SIZE);
    renderShader.setVec2('u_canvasResolution', canvas.width, canvas.height);
    renderShader.setFloat('u_time', simTime);  // For pulsing/animation effects
    renderShader.setFloat('u_metaballScale', METABALL_SCALE);  // Metaball blob scale
    renderShader.setInt('u_frameCount', frameCount);  // Number of frames to blend
    renderShader.setFloat('u_temporalBlend', TEMPORAL_BLEND);  // Temporal blend strength
    
    // Camera uniforms for pan and zoom
    renderShader.setVec2('u_cameraPos', camera.x, camera.y);
    renderShader.setFloat('u_cameraZoom', camera.zoom);
    
    // Performance mode uniforms
    renderShader.setFloat('u_showMinimap', showMinimap ? 1.0 : 0.0);
    renderShader.setFloat('u_performanceMode', performanceMode ? 1.0 : 0.0);
    
    // Selection system uniforms
    // Note: Selection is now stored in unit data (G channel bit 5), no separate texture needed
    renderShader.setFloat('u_currentPlayer', currentPlayer);  // 1.0 or 2.0
    
    // User interaction UI uniforms (rendered in shader instead of DOM)
    // Input state comes from InputHandler module
    const isSelecting = inputHandler.isInSelectionMode();
    const hasActiveSelection = inputHandler.hasSelection();
    const mousePos = inputHandler.getMousePosition();
    
    renderShader.setFloat('u_isSelecting', isSelecting ? 1.0 : 0.0);
    renderShader.setFloat('u_hasActiveSelection', hasActiveSelection ? 1.0 : 0.0);
    renderShader.setFloat('u_shiftHeld', inputHandler.isShiftHeld() ? 1.0 : 0.0);
    renderShader.setFloat('u_deleteRadius', DELETE_RADIUS);
    
    // Convert screen coordinates to UV (0-1) for shader
    const rect = canvas.getBoundingClientRect();
    const screenToUV = (x, y) => ({
        x: (x - rect.left) / rect.width,
        y: 1.0 - (y - rect.top) / rect.height  // Flip Y for shader
    });
    
    // Mouse position (used for crosshair and delete indicator)
    const mouseUV = screenToUV(mousePos.x, mousePos.y);
    renderShader.setVec2('u_mousePos', mouseUV.x, mouseUV.y);
    
    if (isSelecting && inputHandler.selectionStart) {
        const startUV = screenToUV(inputHandler.selectionStart.x, inputHandler.selectionStart.y);
        const endUV = screenToUV(mousePos.x, mousePos.y);
        renderShader.setVec2('u_selectionStart', startUV.x, startUV.y);
        renderShader.setVec2('u_selectionEnd', endUV.x, endUV.y);
    } else {
        renderShader.setVec2('u_selectionStart', 0.0, 0.0);
        renderShader.setVec2('u_selectionEnd', 0.0, 0.0);
    }
    
    renderShader.dispatch();

    renderFrameCount++;
    requestAnimationFrame(renderLoop);
}

// Start render loop (simulation runs here if synced, or separately if fast)
requestAnimationFrame(renderLoop);

// If starting in fast mode, kick off the fast loop
if (!SYNC_SIM_WITH_RENDER) {
    fastSimulationLoop();
}
