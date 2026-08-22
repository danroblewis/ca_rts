/**
 * Unit tests for NetworkManager module
 */
import { runTest, assert, logSection } from './framework.js';
import { NetworkManager } from '../network/NetworkManager.js';
import { LockstepSync } from '../network/LockstepSync.js';

// Mock dependencies
function createMockNetworkSync() {
    const ns = {
        playerId: null,
        hostId: null,
        isConnected: true,
        rttMs: 0,
        rttPeakMs: 0,
        peerRttMs: {},
        onConnectionChange: null,
        onSpectating: null,
        onRestart: null,
        onSpeedSync: null,
        onPlayerJoined: null,
        onPlayerLeft: null,
        onStateReceived: null,
        onActionReceived: null,
        onInputsReceived: null,
        onHashReceived: null,
        onInputsRequested: null,
        onStateRequested: null,
        onPong: null,
        sent: { inputs: [], hashes: [], snapshots: [], pings: 0, stateRequests: 0, inputRequests: [] },
        connect: async () => {},
        disconnect: () => {},
        syncState: (gridData, action, simTime, extra) => { ns.sent.snapshots.push({ gridData, action, simTime, extra }); },
        sendInputs: (frames) => { ns.sent.inputs.push(frames); },
        sendHash: (tick, hash) => { ns.sent.hashes.push({ tick, hash }); },
        sendPing: () => { ns.sent.pings++; },
        requestState: () => { ns.sent.stateRequests++; },
        requestInputs: (player, fromTick) => { ns.sent.inputRequests.push({ player, fromTick }); }
    };
    return ns;
}

function createMockGame() {
    const game = {
        mapSeed: 12345,
        isMultiplayer: false,
        isSpectator: false,
        connectedPlayers: new Set(),
        currentPlayer: 1,
        simTime: 0,
        waitingForSync: false,
        waitingForSyncStartTime: null,
        targetTicksPerSecond: 60,
        multiplayerInputDelay: 6,
        desyncDetected: false,
        playerFactoryCounts: { 1: 0, 2: 0 },
        playerTotalFactoriesPlaced: { 1: 0, 2: 0 },
        factoriesPlaced: 0,
        lockstep: new LockstepSync({ inputDelay: 6 }),
        grid: {
            download: async () => new Float32Array(16),
            upload: () => {},
            getReadTexture: () => ({}),
            swap: () => {}
        },
        gameUI: {
            updatePlayerIndicator: () => {},
            setTargetTick: () => {}
        },
        generateMap: () => {},
        simulationStep: () => {},
        enterMultiplayer(playerId) {
            game.isMultiplayer = true;
            game.currentPlayer = playerId === 2 ? 2 : 1;
            game.lockstep.inputDelay = game.multiplayerInputDelay;
            game.lockstep.start(game.simTime, game.currentPlayer);
        },
        leaveMultiplayer() {
            game.isMultiplayer = false;
            game.connectedPlayers.clear();
            game.lockstep.peers.clear();
        },
        async createSnapshot() {
            return { tick: game.simTime, gridData: new Float32Array(16), counters: { factoryCounts: { ...game.playerFactoryCounts }, totalPlaced: { ...game.playerTotalFactoriesPlaced }, factoriesPlaced: game.factoriesPlaced }, frames: game.lockstep.allFramesSince(game.simTime) };
        },
        applySnapshot(snapshot) {
            game.simTime = snapshot.tick;
            if (snapshot.counters?.factoryCounts) Object.assign(game.playerFactoryCounts, snapshot.counters.factoryCounts);
            if (snapshot.counters?.totalPlaced) Object.assign(game.playerTotalFactoriesPlaced, snapshot.counters.totalPlaced);
            if (snapshot.counters?.factoriesPlaced !== undefined) game.factoriesPlaced = snapshot.counters.factoriesPlaced;
            game.lockstep.start(snapshot.tick, game.currentPlayer);
            if (snapshot.frames?.length) game.lockstep.importFrames(snapshot.frames);
            game.waitingForSync = false;
            game.desyncDetected = false;
            game.gameUI.updatePlayerIndicator();
        },
        receivedHashes: [],
        receivePeerHash(playerId, tick, hash) { game.receivedHashes.push({ playerId, tick, hash }); }
    };
    return game;
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
        assert(typeof ns.onInputsReceived === 'function', 'Should bind onInputsReceived');
        assert(typeof ns.onHashReceived === 'function', 'Should bind onHashReceived');
        assert(typeof ns.onInputsRequested === 'function', 'Should bind onInputsRequested');
        assert(typeof ns.onStateRequested === 'function', 'Should bind onStateRequested');
    });
    
    // ========================================================================
    // Connection Event Tests
    // ========================================================================
    
    logSection('NetworkManager - Connection Events');
    
    await runTest('onPlayerJoined (self, first in room) enters multiplayer without waiting', async () => {
        const ns = createMockNetworkSync();
        const game = createMockGame();
        ns.playerId = 1; ns.hostId = 1;
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        ns.onPlayerJoined(1, true, 12345, [1]);
        assert(game.isMultiplayer === true, 'Should enter multiplayer');
        assert(game.waitingForSync === false, 'Alone in the room: nothing to wait for');
        assert(game.lockstep.peers.size === 0, 'No peers yet');
    });

    await runTest('onPlayerJoined (self, others present) waits for the host snapshot and gates on peers', async () => {
        const ns = createMockNetworkSync();
        const game = createMockGame();
        ns.playerId = 2; ns.hostId = 1;
        game.simTime = 50;
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        ns.onPlayerJoined(2, false, 12345, [1, 2]);
        assert(game.isMultiplayer === true, 'Should enter multiplayer');
        assert(game.waitingForSync === true, 'Must wait for the snapshot');
        assert(game.lockstep.hasPeer(1), 'Player 1 is a peer');
        assert(!game.lockstep.canSimulate(50), 'Cannot simulate without peer frames');
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
    
    await runTest('onPlayerJoined (remote) adds peer, stalls host at current tick, host sends snapshot', async () => {
        const ns = createMockNetworkSync();
        ns.playerId = 1; ns.hostId = 1;
        const game = createMockGame();
        game.enterMultiplayer(1);
        game.simTime = 120;
        game.lockstep.emitFramesThrough(125);
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
        
        ns.onPlayerJoined(2, false);
        assert(game.connectedPlayers.has(2), 'Should add new player to connectedPlayers');
        assert(game.lockstep.hasPeer(2), 'Should gate on the new peer');
        assert(!game.lockstep.canSimulate(120), 'Host stalls at its current tick until peer frames arrive');
        assert(indicatorUpdated, 'Should update network indicator');
        await new Promise(r => setTimeout(r, 0));
        assert(ns.sent.snapshots.length === 1, 'Host sent one snapshot');
        const snap = ns.sent.snapshots[0];
        assert(snap.simTime === 120, `Snapshot at the stalled tick (got ${snap.simTime})`);
        assert(snap.extra.frames.length === 6, `Snapshot carries the host's future frames 120..125 (got ${snap.extra.frames.length})`);
    });

    await runTest('onPlayerJoined (remote) on a non-host does not send a snapshot', async () => {
        const ns = createMockNetworkSync();
        ns.playerId = 2; ns.hostId = 1;
        const game = createMockGame();
        game.enterMultiplayer(2);
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        ns.onPlayerJoined(3, false);
        await new Promise(r => setTimeout(r, 0));
        assert(ns.sent.snapshots.length === 0, 'Only the host snapshots');
        assert(game.lockstep.hasPeer(3), 'But it still gates on the new peer');
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
    
    await runTest('onInputsReceived stores peer frames for lockstep', async () => {
        const ns = createMockNetworkSync();
        ns.playerId = 1; ns.hostId = 1;
        const game = createMockGame();
        game.enterMultiplayer(1);
        game.lockstep.addPeer(2, 0);
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        ns.onInputsReceived(2, [{ tick: 0, actions: [{ type: 'place_factory', x: 1, y: 2 }] }, { tick: 1, actions: [] }]);
        assert(game.lockstep.canSimulate(1), 'Frames 0 and 1 present');
        assert(game.lockstep.actionsForTick(0)[0].action.type === 'place_factory', 'Action stored at its tick');
        assert(game.connectedPlayers.has(2), 'Player remembered');
    });

    await runTest('Game frames are sent to peers; hashes are forwarded both ways', async () => {
        const ns = createMockNetworkSync();
        ns.playerId = 1; ns.hostId = 1;
        const game = createMockGame();
        game.enterMultiplayer(1);
        game.lockstep.addPeer(2, 0);
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        game.onFramesEmitted([{ tick: 0, actions: [] }]);
        assert(ns.sent.inputs.length === 1, 'Frames sent');
        game.onLocalHash(60, 1234);
        assert(ns.sent.hashes.length === 1 && ns.sent.hashes[0].hash === 1234, 'Hash sent');
        ns.onHashReceived(2, 60, 1234);
        assert(game.receivedHashes.length === 1, 'Peer hash delivered to the game');
    });

    await runTest('onInputsRequested re-sends own frames from the requested tick', async () => {
        const ns = createMockNetworkSync();
        ns.playerId = 1; ns.hostId = 1;
        const game = createMockGame();
        game.enterMultiplayer(1);
        game.lockstep.emitFramesThrough(20);
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        ns.onInputsRequested(2, 15);
        assert(ns.sent.inputs.length === 1, 'Re-sent');
        assert(ns.sent.inputs[0].length === 6 && ns.sent.inputs[0][0].tick === 15, 'Frames 15..20');
    });

    await runTest('onDesync on a non-host requests a snapshot from the host (rate limited)', async () => {
        const ns = createMockNetworkSync();
        ns.playerId = 2; ns.hostId = 1;
        const game = createMockGame();
        game.enterMultiplayer(2);
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        game.onDesync(600);
        game.onDesync(660);
        assert(ns.sent.stateRequests === 1, 'One request (rate limited)');
    });

    await runTest('onPong adapts the input delay to the round-trip time', async () => {
        const ns = createMockNetworkSync();
        ns.playerId = 1; ns.hostId = 1;
        const game = createMockGame();
        game.enterMultiplayer(1);
        
        new NetworkManager({
            networkSync: ns,
            game,
            gameLoop: createMockGameLoop(),
            networkIndicator: createMockNetworkIndicator(),
            speedToggle: createMockSpeedToggle(),
            config: {},
            isOnLocalhost: true
        });
        
        ns.rttMs = 2; ns.rttPeakMs = 2; ns.onPong(2);
        assert(game.multiplayerInputDelay === 6, `LAN rtt keeps the minimum delay (got ${game.multiplayerInputDelay})`);
        ns.rttMs = 600; ns.rttPeakMs = 600; ns.onPong(600);
        assert(game.multiplayerInputDelay > 20 && game.multiplayerInputDelay <= 90, `600ms rtt raises the delay (got ${game.multiplayerInputDelay})`);
        assert(game.lockstep.inputDelay === game.multiplayerInputDelay, 'Lockstep delay updated');
        // A far-away peer raises it further (client->server->client path)
        const before = game.multiplayerInputDelay;
        game.lockstep.addPeer(2, 0);
        ns.peerRttMs[2] = 1200;
        ns.onHashReceived(2, 60, 1, 1200);
        assert(game.multiplayerInputDelay > before, `peer rtt raises the delay (${before} -> ${game.multiplayerInputDelay})`);
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
    
    await runTest('onStateReceived applies a host snapshot (counters, tick, frames)', async () => {
        const ns = createMockNetworkSync();
        ns.playerId = 2; ns.hostId = 1;
        const game = createMockGame();
        game.enterMultiplayer(2);
        game.lockstep.addPeer(1, 0);
        game.waitingForSync = true;
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
            playerId: 1,
            gridState: new Float32Array(16),
            simTime: 100,
            action: { type: 'snapshot' },
            counters: { factoryCounts: { 1: 5, 2: 3 }, totalPlaced: { 1: 10, 2: 8 }, factoriesPlaced: 18 },
            frames: [{ playerId: 1, tick: 100, actions: [] }, { playerId: 1, tick: 101, actions: [] }]
        });
        
        assert(game.playerFactoryCounts[1] === 5, 'Should update player 1 factory count');
        assert(game.playerFactoryCounts[2] === 3, 'Should update player 2 factory count');
        assert(game.playerTotalFactoriesPlaced[1] === 10, 'Should update player 1 total placed');
        assert(game.factoriesPlaced === 18, 'Should update total factories placed');
        assert(game.simTime === 100, 'Should update simTime');
        assert(game.waitingForSync === false, 'No longer waiting');
        assert(game.lockstep.canSimulate(101), 'Host frames from the snapshot are usable');
        assert(uiUpdated, 'Should update UI');
    });

    await runTest('onStateReceived ignores snapshots from non-hosts', async () => {
        const ns = createMockNetworkSync();
        ns.playerId = 2; ns.hostId = 1;
        const game = createMockGame();
        game.enterMultiplayer(2);
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
        
        ns.onStateReceived({ playerId: 3, gridState: new Float32Array(16), simTime: 100, action: { type: 'snapshot' } });
        assert(game.waitingForSync === true, 'Still waiting: snapshot was not from the host');
        assert(game.simTime === 0, 'Tick unchanged');
    });
    
    await runTest('onStateReceived clears waitingForSync flag', async () => {
        const ns = createMockNetworkSync();
        ns.playerId = 2; ns.hostId = 1;
        const game = createMockGame();
        game.enterMultiplayer(2);
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
            playerId: 1,
            gridState: new Float32Array(16),
            simTime: 0,
            action: { type: 'snapshot' }
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
