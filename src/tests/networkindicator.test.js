import { runTest, assert, logSection } from './framework.js';
import { NetworkIndicator } from '../ui/NetworkIndicator.js';

export async function runNetworkIndicatorTests() {
    logSection('NetworkIndicator - Initialization');

    await runTest('NetworkIndicator initializes with default state', async () => {
        const indicator = new NetworkIndicator({
            onClick: () => {},
            disabled: true // Don't create DOM element in test
        });
        
        assert(indicator.isMultiplayer === false, 'isMultiplayer should be false initially');
        assert(indicator.isSpectator === false, 'isSpectator should be false initially');
        assert(indicator.connectedPlayers.size === 0, 'connectedPlayers should be empty');
    });

    await runTest('NetworkIndicator stores onClick callback', async () => {
        let clicked = false;
        const indicator = new NetworkIndicator({
            onClick: () => { clicked = true; },
            disabled: true
        });
        
        indicator.onClick();
        assert(clicked === true, 'onClick callback should be stored and callable');
    });

    await runTest('NetworkIndicator disabled mode does not create element', async () => {
        const indicator = new NetworkIndicator({
            onClick: () => {},
            disabled: true
        });
        
        assert(indicator.element === null, 'element should be null when disabled');
    });

    logSection('NetworkIndicator - State Updates');

    await runTest('update sets all state properties', async () => {
        const indicator = new NetworkIndicator({
            onClick: () => {},
            disabled: true
        });
        
        const players = new Set([1, 2]);
        indicator.update(true, true, players);
        
        assert(indicator.isMultiplayer === true, 'isMultiplayer should be true');
        assert(indicator.isSpectator === true, 'isSpectator should be true');
        assert(indicator.connectedPlayers.has(1), 'should have player 1');
        assert(indicator.connectedPlayers.has(2), 'should have player 2');
    });

    await runTest('setMultiplayer updates multiplayer state', async () => {
        const indicator = new NetworkIndicator({
            onClick: () => {},
            disabled: true
        });
        
        indicator.setMultiplayer(true);
        assert(indicator.isMultiplayer === true, 'isMultiplayer should be true');
        
        indicator.setMultiplayer(false);
        assert(indicator.isMultiplayer === false, 'isMultiplayer should be false');
    });

    await runTest('setSpectator updates spectator state', async () => {
        const indicator = new NetworkIndicator({
            onClick: () => {},
            disabled: true
        });
        
        indicator.setSpectator(true);
        assert(indicator.isSpectator === true, 'isSpectator should be true');
        
        indicator.setSpectator(false);
        assert(indicator.isSpectator === false, 'isSpectator should be false');
    });

    await runTest('setConnectedPlayers replaces players set', async () => {
        const indicator = new NetworkIndicator({
            onClick: () => {},
            disabled: true
        });
        
        indicator.setConnectedPlayers(new Set([1]));
        assert(indicator.connectedPlayers.has(1), 'should have player 1');
        assert(indicator.connectedPlayers.size === 1, 'should have 1 player');
        
        indicator.setConnectedPlayers(new Set([2]));
        assert(indicator.connectedPlayers.has(2), 'should have player 2');
        assert(!indicator.connectedPlayers.has(1), 'should not have player 1');
    });

    logSection('NetworkIndicator - Player Management');

    await runTest('addPlayer adds player to set', async () => {
        const indicator = new NetworkIndicator({
            onClick: () => {},
            disabled: true
        });
        
        indicator.addPlayer(1);
        assert(indicator.connectedPlayers.has(1), 'should have player 1');
        
        indicator.addPlayer(2);
        assert(indicator.connectedPlayers.has(2), 'should have player 2');
        assert(indicator.connectedPlayers.size === 2, 'should have 2 players');
    });

    await runTest('removePlayer removes player from set', async () => {
        const indicator = new NetworkIndicator({
            onClick: () => {},
            disabled: true
        });
        
        indicator.addPlayer(1);
        indicator.addPlayer(2);
        indicator.removePlayer(1);
        
        assert(!indicator.connectedPlayers.has(1), 'should not have player 1');
        assert(indicator.connectedPlayers.has(2), 'should still have player 2');
    });

    await runTest('clearPlayers removes all players', async () => {
        const indicator = new NetworkIndicator({
            onClick: () => {},
            disabled: true
        });
        
        indicator.addPlayer(1);
        indicator.addPlayer(2);
        indicator.clearPlayers();
        
        assert(indicator.connectedPlayers.size === 0, 'should have no players');
    });

    logSection('NetworkIndicator - Rendering (disabled mode)');

    await runTest('_render does nothing when element is null', async () => {
        const indicator = new NetworkIndicator({
            onClick: () => {},
            disabled: true
        });
        
        // Should not throw
        indicator._render();
        assert(true, '_render should complete without error');
    });

    await runTest('update triggers _render without error', async () => {
        const indicator = new NetworkIndicator({
            onClick: () => {},
            disabled: true
        });
        
        // Should not throw
        indicator.update(true, false, new Set([1]));
        assert(true, 'update should complete without error');
    });
}

