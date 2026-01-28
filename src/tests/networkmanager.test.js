/**
 * Unit tests for NetworkManager module
 */
import { runTest, assert, logSection } from './framework.js';
import { NetworkManager } from '../network/NetworkManager.js';

// Mock dependencies
function createMockNetworkSync() {
    return {
        playerId: null,
        onConnectionChange: null,
        onSpectating: null,
        onRestart: null,
        onSpeedSync: null,
        onPlayerJoined: null,
        onPlayerLeft: null,
        onStateReceived: null,
        onActionReceived: null,
        connect: async () => {},
        disconnect: () => {},
        syncState: () => {}
    };
}

function createMockGame() {
    return {
        mapSeed: 12345,
        isMultiplayer: false,
        isSpectator: false,
        connectedPlayers: new Set(),
        currentPlayer: 1,
        simTime: 0,
        waitingForSync: false,
        waitingForSyncStartTime: null,
        targetTicksPerSecond: 30,
        playerFactoryCounts: { 1: 0, 2: 0 },
        playerTotalFactoriesPlaced: { 1: 0, 2: 0 },
        factoriesPlaced: 0,
        grid: {
            download: () => new Uint8Array(100),
            upload: () => {},
            getReadTexture: () => ({}),
            getWriteFramebuffer: () => ({ bind: () => {}, unbind: () => {} }),
            swap: () => {}
        },
        simShader: {
            use: () => {},
            setTexture: () => {},
            setVec2: () => {},
            setFloat: () => {},
            dispatch: () => {}
        },
        gameUI: {
            updatePlayerIndicator: () => {},
            setTargetTick: () => {}
        },
        rollbackManager: {
            processRemoteAction: () => {},
            clear: () => {},
            saveInitialCheckpoint: () => {}
        },
        generateMap: () => {},
        simulationStep: () => {}
    };
}

function createMockGameLoop() {
    return {
        onSpeedChange: () => {}
    };
}

function createMockNetworkIndicator() {
    return {
        update: () => {}
    };
}

function createMockSpeedToggle() {
    let visible = true;
    let syncMode = true;
    return {
        hide: () => { visible = false; },
        show: () => { visible = true; },
        forceSyncMode: () => { syncMode = true; },
        isVisible: () => visible,
        getSyncMode: () => syncMode
    };
}

export async function runNetworkManagerTests() {
    // ========================================================================
    // Initialization Tests
    // ========================================================================
    
    logSection('NetworkManager - Initialization');
    
    await runTest('NetworkManager initializes with correct defaults', async () => {
        const ns = createMockNetworkSync();
        const game = createMockGame();
        const gameLoop = createMockGameLoop();
        const networkIndicator = createMockNetworkIndicator();
        const speedToggle = createMockSpeedToggle();
        
        const nm = new NetworkManager({
            networkSync: ns,
            game,
            gameLoop,
            networkIndicator,
            speedToggle,
            config: {},
            isOnLocalhost: true
        });
        
        assert(nm.networkSync === ns, 'Should store networkSync reference');
        assert(nm.game === game, 'Should store game reference');
        assert(nm.roomId === 'game-12345', 'Should generate default roomId from mapSeed');
    });
    
    await runTest('NetworkManager accepts custom initialRoomId', async () => {
        const ns = createMockNetworkSync();
        const game = createMockGame();
        
        const nm = new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true,
            initialRoomId: 'custom-room'
        });
        
        assert(nm.roomId === 'custom-room', 'Should use custom roomId');
    });
    
    await runTest('NetworkManager binds all network event handlers', async () => {
        const ns = createMockNetworkSync();
        const game = createMockGame();
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        assert(typeof ns.onConnectionChange === 'function', 'Should bind onConnectionChange');
        assert(typeof ns.onSpectating === 'function', 'Should bind onSpectating');
        assert(typeof ns.onRestart === 'function', 'Should bind onRestart');
        assert(typeof ns.onSpeedSync === 'function', 'Should bind onSpeedSync');
        assert(typeof ns.onPlayerJoined === 'function', 'Should bind onPlayerJoined');
        assert(typeof ns.onPlayerLeft === 'function', 'Should bind onPlayerLeft');
        assert(typeof ns.onStateReceived === 'function', 'Should bind onStateReceived');
        assert(typeof ns.onActionReceived === 'function', 'Should bind onActionReceived');
    });
    
    // ========================================================================
    // Connection Event Tests
    // ========================================================================
    
    logSection('NetworkManager - Connection Events');
    
    await runTest('onConnectionChange sets multiplayer on connect', async () => {
        const ns = createMockNetworkSync();
        const game = createMockGame();
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        ns.onConnectionChange(true);
        assert(game.isMultiplayer === true, 'Should set isMultiplayer to true on connect');
    });
    
    await runTest('onConnectionChange clears players on disconnect', async () => {
        const ns = createMockNetworkSync();
        const game = createMockGame();
        game.connectedPlayers.add(1);
        game.connectedPlayers.add(2);
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        ns.onConnectionChange(false);
        assert(game.isMultiplayer === false, 'Should set isMultiplayer to false on disconnect');
        assert(game.connectedPlayers.size === 0, 'Should clear connectedPlayers on disconnect');
    });
    
    await runTest('onSpectating sets spectator state and players', async () => {
        const ns = createMockNetworkSync();
        const game = createMockGame();
        let uiUpdated = false;
        game.gameUI.updatePlayerIndicator = () => { uiUpdated = true; };
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        ns.onSpectating(101, 12345, [1, 2]);
        assert(game.isSpectator === true, 'Should set isSpectator to true');
        assert(game.connectedPlayers.has(1), 'Should add player 1 to connectedPlayers');
        assert(game.connectedPlayers.has(2), 'Should add player 2 to connectedPlayers');
        assert(uiUpdated, 'Should update player indicator');
    });
    
    await runTest('onPlayerJoined adds player and updates indicator', async () => {
        const ns = createMockNetworkSync();
        ns.playerId = 1; // We are player 1
        const game = createMockGame();
        let indicatorUpdated = false;
        const networkIndicator = createMockNetworkIndicator();
        networkIndicator.update = () => { indicatorUpdated = true; };
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator,
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        // Another player joins
        ns.onPlayerJoined(2, false, 12345, [1, 2]);
        assert(game.connectedPlayers.has(2), 'Should add new player to connectedPlayers');
        assert(indicatorUpdated, 'Should update network indicator');
    });
    
    await runTest('onPlayerLeft removes player from set', async () => {
        const ns = createMockNetworkSync();
        const game = createMockGame();
        game.connectedPlayers.add(1);
        game.connectedPlayers.add(2);
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        ns.onPlayerLeft(2);
        assert(!game.connectedPlayers.has(2), 'Should remove player from connectedPlayers');
        assert(game.connectedPlayers.has(1), 'Should keep other players');
    });
    
    await runTest('onActionReceived routes to rollbackManager', async () => {
        const ns = createMockNetworkSync();
        const game = createMockGame();
        let processedAction = null;
        let processedPlayer = null;
        let processedTick = null;
        game.rollbackManager.processRemoteAction = (action, player, tick) => {
            processedAction = action;
            processedPlayer = player;
            processedTick = tick;
        };
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        ns.onActionReceived({
            playerId: 2,
            simTime: 100,
            action: { type: 'place_factory', x: 10, y: 20 }
        });
        
        assert(processedAction.type === 'place_factory', 'Should pass action to rollbackManager');
        assert(processedPlayer === 2, 'Should pass playerId');
        assert(processedTick === 100, 'Should pass simTime');
    });
    
    // ========================================================================
    // Speed Toggle Integration Tests
    // ========================================================================
    
    logSection('NetworkManager - Speed Toggle Integration');
    
    await runTest('Hides speed toggle in multiplayer on non-localhost', async () => {
        const ns = createMockNetworkSync();
        const game = createMockGame();
        game.isMultiplayer = true;
        const speedToggle = createMockSpeedToggle();
        const networkIndicator = createMockNetworkIndicator();
        let speedChangeCalledWith = null;
        const gameLoop = createMockGameLoop();
        gameLoop.onSpeedChange = (val) => { speedChangeCalledWith = val; };
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop,
            networkIndicator,
            speedToggle,
            config: {},
            isOnLocalhost: false  // Not on localhost
        });
        
        // Trigger connection change
        ns.onConnectionChange(true);
        
        assert(!speedToggle.isVisible(), 'Speed toggle should be hidden in multiplayer');
        assert(speedChangeCalledWith === true, 'Should force sync mode');
    });
    
    await runTest('Shows speed toggle after disconnect', async () => {
        const ns = createMockNetworkSync();
        const game = createMockGame();
        game.isMultiplayer = false;
        const speedToggle = createMockSpeedToggle();
        speedToggle.hide(); // Start hidden
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle,
            config: {},
            isOnLocalhost: false
        });
        
        ns.onConnectionChange(false);
        
        assert(speedToggle.isVisible(), 'Speed toggle should show after disconnect');
    });
    
    // ========================================================================
    // State Sync Tests
    // ========================================================================
    
    logSection('NetworkManager - State Sync');
    
    await runTest('onStateReceived updates factory counts and simTime', async () => {
        const ns = createMockNetworkSync();
        const game = createMockGame();
        let uiUpdated = false;
        game.gameUI.updatePlayerIndicator = () => { uiUpdated = true; };
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        ns.onStateReceived({
            gridState: new Uint8Array(10),
            simTime: 100,
            action: {
                type: 'player_sync',
                factoryCounts: { 1: 5, 2: 3 },
                totalPlaced: { 1: 10, 2: 8 },
                factoriesPlaced: 18
            }
        });
        
        assert(game.playerFactoryCounts[1] === 5, 'Should update player 1 factory count');
        assert(game.playerFactoryCounts[2] === 3, 'Should update player 2 factory count');
        assert(game.playerTotalFactoriesPlaced[1] === 10, 'Should update player 1 total placed');
        assert(game.factoriesPlaced === 18, 'Should update total factories placed');
        assert(game.simTime === 100, 'Should update simTime');
        assert(uiUpdated, 'Should update UI');
    });
    
    await runTest('onStateReceived clears waitingForSync flag', async () => {
        const ns = createMockNetworkSync();
        const game = createMockGame();
        game.waitingForSync = true;
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        ns.onStateReceived({
            gridState: [],
            simTime: 0,
            action: {}
        });
        
        assert(game.waitingForSync === false, 'Should clear waitingForSync flag');
    });
    
    // ========================================================================
    // Room Management Tests
    // ========================================================================
    
    logSection('NetworkManager - Room Management');
    
    await runTest('getRoomId returns correct room ID', async () => {
        const nm = new NetworkManager({
            networkSync: createMockNetworkSync(),
            game: createMockGame(),
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        assert(nm.getRoomId() === 'game-12345', 'Should return current roomId');
    });
    
    await runTest('setRoomId updates room ID', async () => {
        const nm = new NetworkManager({
            networkSync: createMockNetworkSync(),
            game: createMockGame(),
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        nm.setRoomId('new-room-id');
        assert(nm.getRoomId() === 'new-room-id', 'Should update roomId');
    });
    
    await runTest('joinRoom sets waitingForSync and connects', async () => {
        const ns = createMockNetworkSync();
        let connectCalled = false;
        ns.connect = async () => { connectCalled = true; };
        const game = createMockGame();
        
        const nm = new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        await nm.joinRoom('test-room');
        assert(game.waitingForSync === true, 'Should set waitingForSync');
        assert(nm.getRoomId() === 'test-room', 'Should update roomId');
        assert(connectCalled, 'Should call networkSync.connect');
    });
    
    await runTest('watchRoom sets spectator mode and connects', async () => {
        const ns = createMockNetworkSync();
        let connectCalled = false;
        let spectatorMode = false;
        ns.connect = async (url, room, player, isSpectator) => { 
            connectCalled = true; 
            spectatorMode = isSpectator;
        };
        const game = createMockGame();
        
        const nm = new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        await nm.watchRoom('spectate-room');
        assert(game.isSpectator === true, 'Should set isSpectator');
        assert(nm.getRoomId() === 'spectate-room', 'Should update roomId');
        assert(connectCalled, 'Should call networkSync.connect');
        assert(spectatorMode === true, 'Should connect in spectator mode');
    });
    
    await runTest('toggleMultiplayer disconnects when connected', async () => {
        const ns = createMockNetworkSync();
        let disconnectCalled = false;
        ns.disconnect = () => { disconnectCalled = true; };
        const game = createMockGame();
        game.isMultiplayer = true;
        
        const nm = new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        await nm.toggleMultiplayer();
        assert(disconnectCalled, 'Should call disconnect when already multiplayer');
    });
}
