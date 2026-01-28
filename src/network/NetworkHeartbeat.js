/**
 * NetworkHeartbeat - Manages multiplayer heartbeat and periodic sync
 * 
 * Handles:
 * - Periodic heartbeat messages to sync TPS across clients
 * - Periodic full state sync from host to clients
 */

import { Logger } from '../utils/Logger.js';

export class NetworkHeartbeat {
    /**
     * @param {Object} options
     * @param {number} [options.heartbeatInterval=1000] - How often to send heartbeat (ms)
     * @param {number} [options.fullSyncInterval=5000] - How often to send full state sync (ms)
     * @param {Object} options.networkSync - NetworkSync instance
     * @param {Function} options.getGridData - () => Float32Array
     * @param {Function} options.getSimTime - () => number
     * @param {Function} options.getFactoryState - () => { factoryCounts, totalPlaced, factoriesPlaced }
     * @param {Function} options.getPotentialTps - () => number
     */
    constructor(options) {
        this.heartbeatInterval = options.heartbeatInterval ?? 1000;
        this.fullSyncInterval = options.fullSyncInterval ?? 5000;
        this.networkSync = options.networkSync;
        this.getGridData = options.getGridData;
        this.getSimTime = options.getSimTime;
        this.getFactoryState = options.getFactoryState;
        this.getPotentialTps = options.getPotentialTps;
        
        this.lastHeartbeatTime = 0;
        this.lastFullSyncTime = 0;
    }
    
    /**
     * Check and send heartbeat/sync if needed
     * @param {boolean} isMultiplayer
     * @param {boolean} isSpectator
     * @returns {{ heartbeatSent: boolean, syncSent: boolean }}
     */
    update(isMultiplayer, isSpectator) {
        const result = { heartbeatSent: false, syncSent: false };
        
        if (!isMultiplayer || !this.networkSync.isConnected || isSpectator) {
            return result;
        }
        
        const now = performance.now();
        
        // Send heartbeat periodically
        if (now - this.lastHeartbeatTime >= this.heartbeatInterval) {
            const potentialTps = this.getPotentialTps();
            if (potentialTps > 1) {
                this.networkSync.sendHeartbeat(potentialTps, Math.floor(this.getSimTime()));
            }
            this.lastHeartbeatTime = now;
            result.heartbeatSent = true;
        }
        
        // Host sends periodic full state sync
        if (this.networkSync.playerId === 1 && now - this.lastFullSyncTime >= this.fullSyncInterval) {
            const gridData = this.getGridData();
            const factoryState = this.getFactoryState();
            
            this.networkSync.syncState(gridData, {
                type: 'periodic_sync',
                factoryCounts: { ...factoryState.factoryCounts },
                totalPlaced: { ...factoryState.totalPlaced },
                factoriesPlaced: factoryState.factoriesPlaced
            }, this.getSimTime());
            
            this.lastFullSyncTime = now;
            Logger.log('sync', `Sent periodic sync at tick ${Math.floor(this.getSimTime())}`);
            result.syncSent = true;
        }
        
        return result;
    }
    
    /**
     * Reset timing (e.g., after reconnection)
     */
    reset() {
        this.lastHeartbeatTime = 0;
        this.lastFullSyncTime = 0;
    }
}

