import { GPU } from './gpu/GPU.js';
import { ComputeShader } from './gpu/ComputeShader.js';
import { loadShader } from './shaders/load.js';
import { CAGrid } from './ca/CAGrid.js';
import { getNetworkSync } from './network/NetworkSync.js';
import { AudioReductionPipeline } from './audio/AudioReductionPipeline.js';
import { AudioEngine } from './audio/AudioEngine.js';

// ============================================================================
// CONFIGURATION - Edit these values to customize the game
// ============================================================================

// Grid size (width and height in cells)
const GRID_SIZE = 256;

// Default map seed (can be overridden via ?seed=12345 URL param)
const DEFAULT_MAP_SEED = 12345;

// Rendering settings
const METABALL_SCALE = 1.0;           // Metaball blob scale (0.5 = tighter, 2.0 = blobbier)
const TEMPORAL_BLEND = 1.0;           // Temporal AA blend (0 = off, 1 = full). Only affects moving units.

// Simulation speed settings
const LOG_INTERVAL = 1000;            // Stats logging interval in ms
const SIM_BATCH_SIZE = 10;            // Simulation steps per batch in fast mode
const SYNC_SIM_BATCH_SIZE = 1;        // Simulation steps per batch in synced (normal) mode
const DEFAULT_SYNC_MODE = true;       // true = sync with render (normal), false = fast as possible

// Map generation - Resource blobs
const NUM_BLOBS = 150;                // Number of resource clusters
const BLOB_MIN_RADIUS = 3;            // Minimum blob radius
const BLOB_MAX_RADIUS = 8;            // Maximum blob radius
const BLOB_DENSITY = 0.6;             // % of cells in blob that have resources

// Map generation - Walls
const NUM_WALL_LINES = 44;            // Number of wall lines
const WALL_MIN_LENGTH = 5;            // Minimum wall line length
const WALL_MAX_LENGTH = 20;           // Maximum wall line length
const NUM_WALL_BLOBS = 5;             // Number of small wall clusters
const WALL_BLOB_RADIUS = 3;           // Radius of wall clusters

// Gameplay settings
const FIRST_FACTORY_RESOURCES = 50;   // Resources given to first factory only
const DELETE_RADIUS = 5;              // Radius in grid cells for delete operation

// ============================================================================
// Cell type constants (must match GLSL)
const CELL_EMPTY = 0;
const CELL_RESOURCE = 1;
const CELL_MINING_UNIT = 2;       // Player 1 unit
const CELL_MINING_FACTORY = 3;   // Player 1 factory (built or unbuilt)
const CELL_WALL = 4;
const CELL_MINING_UNIT_P2 = 5;   // Player 2 unit
const CELL_DEMOLISH = 6;
const CELL_MINING_FACTORY_P2 = 7; // Player 2 factory (built or unbuilt)

// Player constants
const PLAYER_1 = 1;
const PLAYER_2 = 2;

// Current player (for multiplayer - default to player 1)
let currentPlayer = PLAYER_1;

// ============================================================================
// Seeded PRNG for Deterministic Map Generation
// ============================================================================

// Simple mulberry32 PRNG - deterministic given the same seed
function mulberry32(seed) {
    return function() {
        seed |= 0;
        seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

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

// Create seeded random function
let seededRandom = mulberry32(mapSeed);

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

const [simShaderSource, metaballShaderSource, debugShaderSource] = await Promise.all([
    loadShader('./src/shaders/ca/v2/mining_game.frag.glsl'),
    loadShader('./src/shaders/ca/render_metaballs.frag.glsl'),
    loadShader('./src/shaders/ca/v2/render.frag.glsl')
]);

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
// Initialize World
// ============================================================================
const grid = new CAGrid(GRID_SIZE, GRID_SIZE);

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

// Helper to set a cell
function setCell(x, y, type, dataA = 0, dataB = 0, dataC = 0) {
    const idx = (y * GRID_SIZE + x) * 4;
    data[idx + 0] = type;
    data[idx + 1] = dataA;
    data[idx + 2] = dataB;
    data[idx + 3] = dataC;
}

// Helper to check if a cell is empty (don't overwrite resources)
function isEmpty(x, y) {
    const idx = (y * GRID_SIZE + x) * 4;
    return data[idx] === CELL_EMPTY;
}

// Generate map with a specific seed
function generateMap(seed) {
    console.log(`Generating map with seed: ${seed}`);
    mapSeed = seed;
    seededRandom = mulberry32(seed);
    
    // Fill with empty
    data.fill(0);
    
    // Place resources in blobs/clusters (more realistic RTS style)
    let totalResources = 0;
    
    for (let b = 0; b < NUM_BLOBS; b++) {
        // Pick blob center randomly
        const centerX = Math.floor(seededRandom() * (GRID_SIZE - 20)) + 10;
        const centerY = Math.floor(seededRandom() * (GRID_SIZE - 20)) + 10;
        
        // Random radius for this blob
        const radius = BLOB_MIN_RADIUS + seededRandom() * (BLOB_MAX_RADIUS - BLOB_MIN_RADIUS);
        
        // Fill the blob with resources
        for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
            for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
                const x = centerX + dx;
                const y = centerY + dy;
                
                // Check bounds
                if (x < 1 || x >= GRID_SIZE - 1 || y < 1 || y >= GRID_SIZE - 1) continue;
                
                // Check if within blob radius (with some noise for organic shape)
                const dist = Math.sqrt(dx * dx + dy * dy);
                const noiseRadius = radius * (0.7 + seededRandom() * 0.6); // Irregular edges
                if (dist > noiseRadius) continue;
                
                // Density check
                if (seededRandom() > BLOB_DENSITY) continue;
                
                setCell(x, y, CELL_RESOURCE, 1.0);
                totalResources++;
            }
        }
    }
    
    // Generate Walls - random barriers and obstacles
    let totalWalls = 0;
    
    // Generate wall lines (horizontal or vertical)
    for (let i = 0; i < NUM_WALL_LINES; i++) {
        const horizontal = seededRandom() > 0.5;
        const length = Math.floor(WALL_MIN_LENGTH + seededRandom() * (WALL_MAX_LENGTH - WALL_MIN_LENGTH));
        
        // Pick starting position (leave margin from edges)
        const startX = Math.floor(seededRandom() * (GRID_SIZE - length - 10)) + 5;
        const startY = Math.floor(seededRandom() * (GRID_SIZE - length - 10)) + 5;
        
        for (let j = 0; j < length; j++) {
            const x = horizontal ? startX + j : startX;
            const y = horizontal ? startY : startY + j;
            
            // Only place if cell is empty (don't overwrite resources)
            if (x >= 1 && x < GRID_SIZE - 1 && y >= 1 && y < GRID_SIZE - 1 && isEmpty(x, y)) {
                setCell(x, y, CELL_WALL);
                totalWalls++;
            }
        }
    }
    
    // Generate small wall clusters
    for (let b = 0; b < NUM_WALL_BLOBS; b++) {
        const centerX = Math.floor(seededRandom() * (GRID_SIZE - 20)) + 10;
        const centerY = Math.floor(seededRandom() * (GRID_SIZE - 20)) + 10;
        
        for (let dy = -WALL_BLOB_RADIUS; dy <= WALL_BLOB_RADIUS; dy++) {
            for (let dx = -WALL_BLOB_RADIUS; dx <= WALL_BLOB_RADIUS; dx++) {
                const x = centerX + dx;
                const y = centerY + dy;
                
                if (x < 1 || x >= GRID_SIZE - 1 || y < 1 || y >= GRID_SIZE - 1) continue;
                
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > WALL_BLOB_RADIUS * 0.8) continue;
                
                // 70% density
                if (seededRandom() > 0.7) continue;
                
                if (isEmpty(x, y)) {
                    setCell(x, y, CELL_WALL);
                    totalWalls++;
                }
            }
        }
    }
    
    grid.upload(data);
    
    console.log(`Map generated:`);
    console.log(`  Grid: ${GRID_SIZE}x${GRID_SIZE}`);
    console.log(`  ${totalResources} resources scattered`);
    console.log(`  ${totalWalls} walls placed`);
    
    return { totalResources, totalWalls };
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

// Cursor overlay for delete mode
const cursorOverlay = document.getElementById('cursor-overlay');
let mouseX = 0;
let mouseY = 0;
let shiftHeld = false;

// Convert screen coords to grid coords
function screenToGrid(screenX, screenY) {
    const rect = canvas.getBoundingClientRect();
    const normalizedX = (screenX - rect.left) / rect.width;
    const normalizedY = (screenY - rect.top) / rect.height;
    const gridX = Math.floor(normalizedX * GRID_SIZE);
    const gridY = Math.floor((1 - normalizedY) * GRID_SIZE);
    return {
        x: Math.max(0, Math.min(GRID_SIZE - 1, gridX)),
        y: Math.max(0, Math.min(GRID_SIZE - 1, gridY))
    };
}

// Update cursor overlay position and visibility
function updateCursorOverlay() {
    if (shiftHeld) {
        const rect = canvas.getBoundingClientRect();
        // Calculate the size of the delete area in screen pixels
        const cellSizeX = rect.width / GRID_SIZE;
        const cellSizeY = rect.height / GRID_SIZE;
        const sizeX = DELETE_RADIUS * 2 * cellSizeX;
        const sizeY = DELETE_RADIUS * 2 * cellSizeY;
        
        cursorOverlay.style.display = 'block';
        cursorOverlay.style.left = `${mouseX - sizeX / 2}px`;
        cursorOverlay.style.top = `${mouseY - sizeY / 2}px`;
        cursorOverlay.style.width = `${sizeX}px`;
        cursorOverlay.style.height = `${sizeY}px`;
    } else {
        cursorOverlay.style.display = 'none';
    }
}

// Track mouse movement
canvas.addEventListener('mousemove', (event) => {
    mouseX = event.clientX;
    mouseY = event.clientY;
    updateCursorOverlay();
});

// Track shift key
window.addEventListener('keydown', (event) => {
    if (event.key === 'Shift') {
        shiftHeld = true;
        updateCursorOverlay();
    }
});

window.addEventListener('keyup', (event) => {
    if (event.key === 'Shift') {
        shiftHeld = false;
        updateCursorOverlay();
    }
});

canvas.addEventListener('click', async (event) => {
    // Auto-initialize audio on first user interaction (browser requires user gesture)
    if (!audioInitialized) {
        initAudio(); // Don't await - let it init in background
    }
    
    const gridPos = screenToGrid(event.clientX, event.clientY);
    const currentData = grid.download();
    
    if (event.shiftKey) {
        // SHIFT+CLICK: Delete or mark for demolition
        let markedCount = 0;
        let deletedCount = 0;
        
        // Track unique factory centers being demolished (key: "player,x,y")
        const factoriesAffected = new Set();
        
        for (let dy = -DELETE_RADIUS; dy <= DELETE_RADIUS; dy++) {
            for (let dx = -DELETE_RADIUS; dx <= DELETE_RADIUS; dx++) {
                const x = gridPos.x + dx;
                const y = gridPos.y + dy;
                
                if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
                
                const idx = (y * GRID_SIZE + x) * 4;
                const cellType = currentData[idx];
                const buildCount = currentData[idx + 1];
                
                if (cellType === CELL_MINING_FACTORY || cellType === CELL_MINING_FACTORY_P2) {
                    const owner = cellType === CELL_MINING_FACTORY_P2 ? PLAYER_2 : PLAYER_1;
                    const centerX = currentData[idx + 2];
                    const centerY = currentData[idx + 3];
                    
                    // Track this factory (by center position and owner)
                    factoriesAffected.add(`${owner},${centerX},${centerY}`);
                    
                    // Check if this factory cell has any build progress or resources
                    // buildCount here represents either resources (built) or build progress (unbuilt)
                    if (buildCount > 0) {
                        // Has resources or build progress: mark for demolition (units salvage)
                        currentData[idx + 0] = CELL_DEMOLISH;
                        currentData[idx + 1] = 0;
                        currentData[idx + 2] = centerX;
                        currentData[idx + 3] = centerY;
                        markedCount++;
                    } else {
                        // Unbuilt factory cell with 0 progress: delete immediately
                        currentData[idx + 0] = CELL_EMPTY;
                        currentData[idx + 1] = 0;
                        currentData[idx + 2] = 0;
                        currentData[idx + 3] = 0;
                        deletedCount++;
                    }
                }
            }
        }
        
        // Decrement factory count for each unique factory affected
        for (const key of factoriesAffected) {
            const [owner] = key.split(',').map(Number);
            playerFactoryCounts[owner] = Math.max(0, playerFactoryCounts[owner] - 1);
        }
        if (factoriesAffected.size > 0) {
            updatePlayerIndicator();  // Update base count display
        }
        
        grid.upload(currentData);
        if (markedCount > 0 || deletedCount > 0) {
            const parts = [];
            if (deletedCount > 0) parts.push(`deleted ${deletedCount} unbuilt`);
            if (markedCount > 0) parts.push(`marked ${markedCount} for demolition`);
            if (factoriesAffected.size > 0) parts.push(`${factoriesAffected.size} base(s) freed`);
            console.log(`${parts.join(', ')} around (${gridPos.x}, ${gridPos.y})`);
            
            // Calculate factories freed per player for network sync
            const factoriesFreed = {};
            for (const key of factoriesAffected) {
                const [owner] = key.split(',').map(Number);
                factoriesFreed[owner] = (factoriesFreed[owner] || 0) + 1;
            }
            
            // Sync with network
            syncAction({
                type: 'demolish',
                x: gridPos.x,
                y: gridPos.y,
                deleted: deletedCount,
                marked: markedCount,
                factoriesFreed: factoriesFreed
            });
        }
    } else {
        // NORMAL CLICK: Place 3x3 factory or blueprint
        // The click position becomes the CENTER of the structure
        const centerX = gridPos.x;
        const centerY = gridPos.y;
        
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
                const x = centerX + dx;
                const y = centerY + dy;
                const idx = (y * GRID_SIZE + x) * 4;
                const cellType = currentData[idx];
                // Only allow placement on empty cells (not resources, walls, units, or factories)
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
        
        // First factory FOR EACH PLAYER is built (has resources), subsequent are unbuilt (need construction)
        const isUnbuilt = playerFactoryCounts[currentPlayer] > 0;
        const totalResources = isUnbuilt ? 0 : FIRST_FACTORY_RESOURCES;
        const resourcesPerCell = totalResources / 8.0;  // 8 cells (center is empty)
        
        console.log(`[Factory Placement] currentPlayer: ${currentPlayer}, PLAYER_1: ${PLAYER_1}, PLAYER_2: ${PLAYER_2}`);
        
        // Place 3x3 grid of factory cells (center cell stays empty)
        // All cells store the center position
        // G channel = resources for built, or build progress (0) for unbuilt
        // Place 8 factory cells (we already verified all are empty)
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;  // Skip center
                
                const x = centerX + dx;
                const y = centerY + dy;
                const idx = (y * GRID_SIZE + x) * 4;
                
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
        updatePlayerIndicator();  // Update base count display
        
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
    }
});

// ============================================================================
// Player Toggle (for testing multiplayer locally)
// ============================================================================

window.switchPlayer = (player) => {
    if (player === 1 || player === PLAYER_1) {
        currentPlayer = PLAYER_1;
    } else if (player === 2 || player === PLAYER_2) {
        currentPlayer = PLAYER_2;
    } else {
        // Toggle
        currentPlayer = currentPlayer === PLAYER_1 ? PLAYER_2 : PLAYER_1;
    }
    console.log(`Switched to Player ${currentPlayer}`);
    updatePlayerIndicator();
};

function updatePlayerIndicator() {
    // Don't show player indicator on GitHub Pages
    if (isOnGitHub) return;
    
    let indicator = document.getElementById('player-indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'player-indicator';
        indicator.style.cssText = `
            position: fixed;
            top: 8px;
            left: 8px;
            z-index: 200;
            padding: 4px 8px;
            border-radius: 4px;
            font-family: 'SF Mono', monospace;
            font-size: 11px;
            font-weight: bold;
            backdrop-filter: blur(8px);
            cursor: pointer;
        `;
        indicator.onclick = () => window.switchPlayer();
        document.body.appendChild(indicator);
    }
    const baseCount = playerFactoryCounts[currentPlayer];
    
    if (currentPlayer === PLAYER_1) {
        indicator.textContent = `Player 1 (${baseCount}/${MAX_FACTORIES_PER_PLAYER})`;
        indicator.style.background = 'rgba(112, 51, 204, 0.8)';
        indicator.style.color = 'white';
        indicator.style.border = '2px solid rgba(160, 100, 255, 0.8)';
    } else {
        indicator.textContent = `Player 2 (${baseCount}/${MAX_FACTORIES_PER_PLAYER})`;
        indicator.style.background = 'rgba(51, 179, 102, 0.8)';
        indicator.style.color = 'white';
        indicator.style.border = '2px solid rgba(100, 220, 150, 0.8)';
    }
}

// Initialize player indicator
updatePlayerIndicator();

// Listen for 1/2 keys to switch players
document.addEventListener('keydown', (e) => {
    if (e.key === '1') {
        window.switchPlayer(1);
    } else if (e.key === '2') {
        window.switchPlayer(2);
    }
});

console.log('Press 1 or 2 to switch players, or click the player indicator');

// ============================================================================
// Multiplayer Network Sync
// ============================================================================

const networkSync = getNetworkSync(GRID_SIZE);
let isMultiplayer = false;

// Track connected players in multiplayer
const connectedPlayers = new Set();

// Get room from URL or generate one
const roomParam = urlParams.get('room');
let roomId = roomParam || `game-${mapSeed}`;

// Get player ID from URL (for rejoining after refresh)
const playerParam = urlParams.get('player');
const requestedPlayerId = playerParam ? parseInt(playerParam) : null;
console.log(`[URL Params] playerParam: "${playerParam}", requestedPlayerId: ${requestedPlayerId}`);

// Network event handlers
networkSync.onConnectionChange = (connected) => {
    isMultiplayer = connected;
    if (!connected) {
        connectedPlayers.clear();
    }
    updateNetworkIndicator();
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
        
        // If we're Player 1 (the host), sync our state to the new player
        if (networkSync.playerId === 1) {
            console.log(`[Multiplayer] We are the host - syncing game state to new player`);
            syncAction({
                type: 'player_sync',
                reason: 'new_player_joined',
                newPlayerId: playerId,
                factoryCounts: { ...playerFactoryCounts },
                totalPlaced: { ...playerTotalFactoriesPlaced },
                factoriesPlaced: factoriesPlaced
            });
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
    console.log(`[Multiplayer] Applying state from Player ${syncData.playerId} at tick ${syncData.simTime}`);
    
    // Update local grid with received state
    grid.upload(syncData.gridState);
    
    // Sync simulation time
    simTime = syncData.simTime;
    
    // Update factory counts based on action
    const action = syncData.action;
    if (action) {
        if (action.type === 'player_sync') {
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
            console.log(`[Multiplayer] Full state sync received. Factories: P1=${playerFactoryCounts[PLAYER_1]}, P2=${playerFactoryCounts[PLAYER_2]}, total placed: ${factoriesPlaced}`);
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
        } else if (action.type === 'restart') {
            // Other player clicked Play Again - reload to restart
            console.log(`[Multiplayer] Restart requested by other player`);
            const url = new URL(window.location);
            url.searchParams.delete('player');
            window.location.href = url.toString();
        }
    }
    
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
        
        indicator.innerHTML = `<span style="opacity: ${p1Connected ? 1 : 0.4}">${p1Status} P1</span> <span style="opacity: ${p2Connected ? 1 : 0.4}">${p2Status} P2</span>`;
        indicator.style.background = 'rgba(40, 40, 40, 0.9)';
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

// Format seconds to human-readable duration
function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// Create matchmaking dialog
async function showMatchmakingDialog() {
    // Remove existing dialog if any
    const existing = document.getElementById('matchmaking-dialog');
    if (existing) existing.remove();
    
    // Create dialog overlay
    const overlay = document.createElement('div');
    overlay.id = 'matchmaking-dialog';
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.85);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 10000;
    `;
    
    const dialog = document.createElement('div');
    dialog.style.cssText = `
        background: #1a1a2e;
        border-radius: 12px;
        padding: 24px;
        min-width: 400px;
        max-width: 500px;
        max-height: 70vh;
        overflow-y: auto;
        border: 2px solid #4a4a6a;
        font-family: 'SF Mono', monospace;
    `;
    
    dialog.innerHTML = `
        <h2 style="color: #fff; margin: 0 0 16px 0; font-size: 1.5rem;">🎮 Matchmaking</h2>
        <div id="rooms-list" style="color: #888; margin-bottom: 16px;">Loading games...</div>
        <div style="display: flex; gap: 12px;">
            <button id="new-game-btn" style="
                flex: 1;
                padding: 12px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                font-size: 14px;
                font-weight: bold;
            ">✨ New Game</button>
            <button id="close-matchmaking-btn" style="
                padding: 12px 20px;
                background: #333;
                color: #888;
                border: 1px solid #555;
                border-radius: 8px;
                cursor: pointer;
                font-size: 14px;
            ">Cancel</button>
        </div>
    `;
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    
    // Close button handler
    document.getElementById('close-matchmaking-btn').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    
    // New game button handler
    document.getElementById('new-game-btn').onclick = async () => {
        try {
            const resp = await fetch('/api/rooms/create', { method: 'POST' });
            const data = await resp.json();
            overlay.remove();
            await joinRoom(data.roomId);
        } catch (error) {
            console.error('Failed to create room:', error);
        }
    };
    
    // Fetch and display rooms
    await refreshRoomsList();
}

async function refreshRoomsList() {
    const roomsList = document.getElementById('rooms-list');
    if (!roomsList) return;
    
    try {
        const resp = await fetch('/api/rooms');
        const data = await resp.json();
        
        if (data.rooms.length === 0) {
            roomsList.innerHTML = `
                <p style="color: #888; text-align: center; padding: 20px;">
                    No games available.<br>Create a new one!
                </p>
            `;
            return;
        }
        
        roomsList.innerHTML = data.rooms.map(room => `
            <div class="room-card" data-room-id="${room.roomId}" style="
                background: #252540;
                border-radius: 8px;
                padding: 12px;
                margin-bottom: 8px;
                cursor: pointer;
                border: 1px solid #3a3a5a;
                transition: border-color 0.2s;
            " onmouseover="this.style.borderColor='#667eea'" onmouseout="this.style.borderColor='#3a3a5a'">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="color: #fff; font-weight: bold;">${room.displayName}</span>
                    <span style="color: ${room.playerCount >= room.maxPlayers ? '#e74c3c' : '#2ecc71'}; font-size: 12px;">
                        ${room.playerCount}/${room.maxPlayers} players
                    </span>
                </div>
                <div style="color: #888; font-size: 11px; margin-top: 4px;">
                    Running for ${formatDuration(room.ageSeconds)} • Seed: ${room.mapSeed}
                </div>
            </div>
        `).join('');
        
        // Add click handlers to room cards
        document.querySelectorAll('.room-card').forEach(card => {
            card.onclick = async () => {
                const roomIdToJoin = card.dataset.roomId;
                document.getElementById('matchmaking-dialog')?.remove();
                await joinRoom(roomIdToJoin);
            };
        });
        
    } catch (error) {
        roomsList.innerHTML = `<p style="color: #e74c3c;">Failed to load games</p>`;
    }
}

async function joinRoom(roomIdToJoin) {
    try {
        const wsUrl = `ws://${window.location.host}/ws`;
        console.log(`[Multiplayer] Joining room: ${roomIdToJoin}`);
        // Update the global roomId so URL updates correctly
        roomId = roomIdToJoin;
        await networkSync.connect(wsUrl, roomIdToJoin, null);
        console.log(`[Multiplayer] Connected to room: ${roomIdToJoin}`);
    } catch (error) {
        console.error('[Multiplayer] Connection failed:', error);
    }
}

async function toggleMultiplayer() {
    if (isMultiplayer) {
        networkSync.disconnect();
    } else {
        // Show matchmaking dialog instead of direct connect
        await showMatchmakingDialog();
    }
}

// Sync state after an action
function syncAction(action) {
    if (isMultiplayer) {
        const gridData = grid.download();
        networkSync.syncState(gridData, action, simTime);
    }
}

// Initialize network indicator
updateNetworkIndicator();

// Expose to console
window.toggleMultiplayer = toggleMultiplayer;
window.networkSync = networkSync;
console.log(`Room ID: ${roomId} - Click network indicator or call toggleMultiplayer() to connect`);

// Auto-connect if both room and player URL params are present (for rejoining after refresh)
if (roomParam && playerParam && !isOnGitHub) {
    console.log(`[Multiplayer] Auto-connecting to room ${roomId} as player ${requestedPlayerId}...`);
    // Direct connect with the saved player ID
    (async () => {
        try {
            const wsUrl = `ws://${window.location.host}/ws`;
            await networkSync.connect(wsUrl, roomId, requestedPlayerId);
            console.log(`[Multiplayer] Reconnected to room: ${roomId}`);
        } catch (error) {
            console.error('[Multiplayer] Reconnection failed:', error);
        }
    })();
}

// ============================================================================
// Simulation Loop
// ============================================================================

let simStepCount = 0;
let renderFrameCount = 0;
let lastLogTime = performance.now();
let simTime = 0;

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
    grid.getWriteFramebuffer().bind();
    
    simShader.use();
    simShader.setTexture('u_state', grid.getReadTexture(), 0);
    simShader.setVec2('u_resolution', GRID_SIZE, GRID_SIZE);
    simShader.setFloat('u_time', simTime);
    simShader.dispatch();
    
    grid.getWriteFramebuffer().unbind();
    grid.swap();
    
    simStepCount++;
    simTime += 1.0;
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

// Scan the grid to count actual factories per player
function countFactoriesOnMap() {
    const data = grid.download();
    const counts = { [PLAYER_1]: 0, [PLAYER_2]: 0 };
    const factoryCenters = { [PLAYER_1]: new Set(), [PLAYER_2]: new Set() };
    
    for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
            const idx = (y * GRID_SIZE + x) * 4;
            const cellType = data[idx];
            
            if (cellType === CELL_MINING_FACTORY || cellType === CELL_MINING_FACTORY_P2) {
                const owner = cellType === CELL_MINING_FACTORY_P2 ? PLAYER_2 : PLAYER_1;
                const centerX = data[idx + 2];
                const centerY = data[idx + 3];
                const key = `${centerX},${centerY}`;
                factoryCenters[owner].add(key);
            }
        }
    }
    
    counts[PLAYER_1] = factoryCenters[PLAYER_1].size;
    counts[PLAYER_2] = factoryCenters[PLAYER_2].size;
    
    return counts;
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
    
    // Check lose condition: placed all bases AND have none left
    for (const player of [PLAYER_1, PLAYER_2]) {
        if (playerTotalFactoriesPlaced[player] >= MAX_FACTORIES_PER_PLAYER && 
            actualCounts[player] === 0) {
            // This player loses
            gameOver = true;
            winner = player === PLAYER_1 ? PLAYER_2 : PLAYER_1;
            showGameOver();
            return;
        }
    }
}

// Display game over screen
function showGameOver() {
    const overlay = document.createElement('div');
    overlay.id = 'game-over-overlay';
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.85);
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        z-index: 10000;
    `;
    
    const winnerName = winner === PLAYER_1 ? 'Player 1 (Purple)' : 'Player 2 (Green)';
    const winnerColor = winner === PLAYER_1 ? '#a855f7' : '#22c55e';
    
    overlay.innerHTML = `
        <h1 style="color: ${winnerColor}; font-size: 4rem; margin-bottom: 1rem; font-family: sans-serif;">
            ${winnerName} Wins!
        </h1>
        <p style="color: #888; font-size: 1.5rem; font-family: sans-serif;">
            The opponent has lost all their bases.
        </p>
        <button id="play-again-btn" style="
            margin-top: 2rem;
            padding: 1rem 2rem;
            font-size: 1.2rem;
            background: ${winnerColor};
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-family: sans-serif;
        ">Play Again</button>
    `;
    
    document.body.appendChild(overlay);
    
    document.getElementById('play-again-btn').onclick = () => {
        // Send restart message to other player(s) before reloading
        if (isMultiplayer) {
            syncAction({ type: 'restart' });
        }
        // Small delay to ensure message is sent
        setTimeout(() => {
            // Reload without player param to get fresh assignment
            const url = new URL(window.location);
            url.searchParams.delete('player');
            window.location.href = url.toString();
        }, 100);
    };
    
    console.log(`[Game Over] ${winnerName} wins!`);
}

// Check win condition every 5 seconds
setInterval(checkWinCondition, 5000);

// ============================================================================
// Render Loop (also runs synced simulation if enabled)
// ============================================================================

function renderLoop() {
    // Run simulation step if synced mode
    if (SYNC_SIM_WITH_RENDER) {
        for (let i = 0; i < SYNC_SIM_BATCH_SIZE; i++) {
            simulationStep();
        }
        logStats();
    }
    
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
