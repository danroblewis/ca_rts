// src/ui/MatchmakingDialog.js
// Matchmaking dialog for network game room management

import { formatDuration } from '../utils/GameUtils.js';

export class MatchmakingDialog {
    constructor(networkSync, callbacks) {
        this.networkSync = networkSync;
        this.callbacks = callbacks; // { onJoinRoom, onWatchRoom, onCreateRoom }
    }

    async show() {
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
                if (this.callbacks.onCreateRoom) {
                    await this.callbacks.onCreateRoom(data.roomId);
                }
            } catch (error) {
                console.error('Failed to create room:', error);
            }
        };
        
        // Fetch and display rooms
        await this.refreshRoomsList();
    }

    async refreshRoomsList() {
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
                    border: 1px solid #3a3a5a;
                    display: flex;
                    gap: 12px;
                    align-items: center;
                ">
                    <div style="
                        width: 64px;
                        height: 64px;
                        background: #1a1a2e;
                        border-radius: 4px;
                        flex-shrink: 0;
                        overflow: hidden;
                    ">
                        ${room.hasState 
                            ? `<img src="/api/rooms/${room.roomId}/minimap" 
                                 style="width: 64px; height: 64px; image-rendering: pixelated;"
                                 onerror="this.style.display='none'"
                               />`
                            : `<div style="
                                 width: 100%; height: 100%;
                                 display: flex; align-items: center; justify-content: center;
                                 color: #444; font-size: 24px;
                               ">?</div>`
                        }
                    </div>
                    <div style="flex: 1; min-width: 0;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="color: #fff; font-weight: bold;">${room.displayName}</span>
                            <span style="color: ${room.playerCount >= room.maxPlayers ? '#e74c3c' : '#2ecc71'}; font-size: 12px;">
                                ${room.playerCount}/${room.maxPlayers} players${room.spectatorCount > 0 ? ` • 👁 ${room.spectatorCount}` : ''}
                            </span>
                        </div>
                        <div style="color: #888; font-size: 11px; margin-top: 4px;">
                            Running for ${formatDuration(room.ageSeconds)} • Seed: ${room.mapSeed}
                        </div>
                        <div style="display: flex; gap: 8px; margin-top: 8px;">
                            <button class="join-btn" data-room="${room.roomId}" style="
                                flex: 1;
                                padding: 6px 12px;
                                background: ${room.playerCount >= room.maxPlayers ? '#555' : '#4a7c59'};
                                color: white;
                                border: none;
                                border-radius: 4px;
                                cursor: ${room.playerCount >= room.maxPlayers ? 'not-allowed' : 'pointer'};
                                font-size: 12px;
                            " ${room.playerCount >= room.maxPlayers ? 'disabled' : ''}>
                                ${room.playerCount >= room.maxPlayers ? 'Full' : '🎮 Join'}
                            </button>
                            <button class="watch-btn" data-room="${room.roomId}" style="
                                padding: 6px 12px;
                                background: #4a5568;
                                color: white;
                                border: none;
                                border-radius: 4px;
                                cursor: pointer;
                                font-size: 12px;
                            ">👁 Watch</button>
                        </div>
                    </div>
                </div>
            `).join('');
            
            // Add click handlers for join buttons
            document.querySelectorAll('.join-btn:not([disabled])').forEach(btn => {
                btn.onclick = async (e) => {
                    e.stopPropagation();
                    const roomIdToJoin = btn.dataset.room;
                    document.getElementById('matchmaking-dialog')?.remove();
                    if (this.callbacks.onJoinRoom) {
                        await this.callbacks.onJoinRoom(roomIdToJoin);
                    }
                };
            });
            
            // Add click handlers for watch buttons
            document.querySelectorAll('.watch-btn').forEach(btn => {
                btn.onclick = async (e) => {
                    e.stopPropagation();
                    const roomIdToWatch = btn.dataset.room;
                    document.getElementById('matchmaking-dialog')?.remove();
                    if (this.callbacks.onWatchRoom) {
                        await this.callbacks.onWatchRoom(roomIdToWatch);
                    }
                };
            });
            
        } catch (error) {
            roomsList.innerHTML = `<p style="color: #e74c3c;">Failed to load games</p>`;
        }
    }

    close() {
        const dialog = document.getElementById('matchmaking-dialog');
        if (dialog) dialog.remove();
    }
}

