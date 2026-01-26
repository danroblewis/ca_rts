#!/usr/bin/env python3
"""
FastAPI WebSocket server for CA RTS multiplayer.

Handles:
- Static file serving
- WebSocket connections for game rooms
- State synchronization between players
"""

import os
import json
import asyncio
from pathlib import Path
from typing import Dict, Set, Optional
from dataclasses import dataclass, field

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import uvicorn

app = FastAPI(title="CA RTS Server")

# ============================================================================
# Game Room Management
# ============================================================================

@dataclass
class Player:
    """Represents a connected player."""
    websocket: WebSocket
    player_id: int
    room_id: str
    is_host: bool = False


@dataclass
class GameRoom:
    """Represents a game room with connected players."""
    room_id: str
    players: Dict[int, Player] = field(default_factory=dict)
    next_player_id: int = 1
    host_id: Optional[int] = None
    
    async def add_player(self, websocket: WebSocket, requested_player_id: Optional[int] = None) -> Player:
        """Add a new player to the room.
        
        If requested_player_id is provided, use that ID (kicking any existing player with that ID).
        Otherwise, assign the next available ID.
        """
        # Try to use requested ID
        if requested_player_id is not None:
            player_id = requested_player_id
            # If this player ID is already taken, kick the old connection (handles refresh)
            if player_id in self.players:
                old_player = self.players[player_id]
                try:
                    await old_player.websocket.close()
                except Exception:
                    pass
                del self.players[player_id]
                print(f"Kicked old player {player_id} to allow rejoin")
            # Update next_player_id if needed to avoid conflicts
            if player_id >= self.next_player_id:
                self.next_player_id = player_id + 1
        else:
            player_id = self.next_player_id
            self.next_player_id += 1
        
        is_host = len(self.players) == 0
        if is_host:
            self.host_id = player_id
            
        player = Player(
            websocket=websocket,
            player_id=player_id,
            room_id=self.room_id,
            is_host=is_host
        )
        self.players[player_id] = player
        return player
    
    def remove_player(self, player_id: int):
        """Remove a player from the room."""
        if player_id in self.players:
            del self.players[player_id]
            
            # If host left, assign new host
            if player_id == self.host_id and self.players:
                self.host_id = next(iter(self.players.keys()))
                self.players[self.host_id].is_host = True
    
    async def broadcast(self, message: dict, exclude_player_id: Optional[int] = None):
        """Broadcast a message to all players in the room."""
        disconnected = []
        for player_id, player in self.players.items():
            if player_id != exclude_player_id:
                try:
                    await player.websocket.send_json(message)
                except Exception:
                    disconnected.append(player_id)
        
        # Clean up disconnected players
        for player_id in disconnected:
            self.remove_player(player_id)


# Global room registry
rooms: Dict[str, GameRoom] = {}


def get_or_create_room(room_id: str) -> GameRoom:
    """Get an existing room or create a new one."""
    if room_id not in rooms:
        rooms[room_id] = GameRoom(room_id=room_id)
    return rooms[room_id]


# ============================================================================
# WebSocket Endpoint
# ============================================================================

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """Handle WebSocket connections for multiplayer sync."""
    await websocket.accept()
    
    player: Optional[Player] = None
    room: Optional[GameRoom] = None
    
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            
            if msg_type == "join":
                # Player joining a room
                room_id = data.get("roomId", "default")
                requested_player_id = data.get("requestedPlayerId")
                print(f"Join request: room={room_id}, requestedPlayerId={requested_player_id} (type: {type(requested_player_id)})")
                room = get_or_create_room(room_id)
                player = await room.add_player(websocket, requested_player_id)
                print(f"Assigned player_id={player.player_id}")
                
                # Send join confirmation
                await websocket.send_json({
                    "type": "joined",
                    "playerId": player.player_id,
                    "isHost": player.is_host,
                    "roomId": room_id,
                    "playerCount": len(room.players)
                })
                
                # Notify other players
                await room.broadcast({
                    "type": "player_joined",
                    "playerId": player.player_id,
                    "playerCount": len(room.players)
                }, exclude_player_id=player.player_id)
                
                print(f"Player {player.player_id} joined room '{room_id}' (total: {len(room.players)})")
                
            elif msg_type == "sync":
                # Player syncing their state
                if room and player:
                    # Forward sync message to all other players
                    await room.broadcast(data, exclude_player_id=player.player_id)
                    
            elif msg_type == "request_state":
                # Late joiner requesting state from host
                if room and room.host_id and room.host_id in room.players:
                    host = room.players[room.host_id]
                    await host.websocket.send_json({
                        "type": "state_requested",
                        "requestingPlayerId": player.player_id if player else 0
                    })
                    
            elif msg_type == "chat":
                # Chat message (optional feature)
                if room and player:
                    await room.broadcast({
                        "type": "chat",
                        "playerId": player.player_id,
                        "message": data.get("message", "")
                    })
                    
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        # Clean up when player disconnects
        if player and room:
            player_id = player.player_id
            room.remove_player(player_id)
            
            await room.broadcast({
                "type": "player_left",
                "playerId": player_id,
                "playerCount": len(room.players)
            })
            
            print(f"Player {player_id} left room '{room.room_id}' (remaining: {len(room.players)})")
            
            # Clean up empty rooms
            if not room.players:
                del rooms[room.room_id]
                print(f"Room '{room.room_id}' removed (empty)")


# ============================================================================
# Static File Serving
# ============================================================================

# Get the directory where this script is located
BASE_DIR = Path(__file__).parent

# Mount static files
app.mount("/src", StaticFiles(directory=BASE_DIR / "src"), name="src")

# Serve index.html at root
@app.get("/")
async def serve_index():
    return FileResponse(BASE_DIR / "index.html")

# Serve test.html
@app.get("/test.html")
async def serve_test():
    return FileResponse(BASE_DIR / "test.html")

# Serve any other HTML files in root
@app.get("/{filename}.html")
async def serve_html(filename: str):
    file_path = BASE_DIR / f"{filename}.html"
    if file_path.exists():
        return FileResponse(file_path)
    return {"error": "Not found"}, 404


# ============================================================================
# API Endpoints
# ============================================================================

@app.get("/api/rooms")
async def list_rooms():
    """List all active game rooms."""
    return {
        "rooms": [
            {
                "roomId": room.room_id,
                "playerCount": len(room.players),
                "hostId": room.host_id
            }
            for room in rooms.values()
        ]
    }


@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "rooms": len(rooms)}


# ============================================================================
# Main Entry Point
# ============================================================================

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="CA RTS Server")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8080, help="Port to bind to")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload")
    
    args = parser.parse_args()
    
    print(f"Starting CA RTS Server at http://{args.host}:{args.port}")
    print(f"WebSocket endpoint: ws://{args.host}:{args.port}/ws")
    
    uvicorn.run(
        "server:app",
        host=args.host,
        port=args.port,
        reload=args.reload
    )
