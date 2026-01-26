#!/usr/bin/env python3
"""
FastAPI WebSocket server for CA RTS multiplayer.

Handles:
- Static file serving
- WebSocket connections for game rooms
- State synchronization between players
- LRU cache for game state storage
- Minimap generation from cached game state
"""

import os
import io
import json
import base64
import struct
import asyncio
import random
from pathlib import Path
from typing import Dict, Set, Optional, Any
from dataclasses import dataclass, field
from collections import OrderedDict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
import uvicorn

app = FastAPI(title="CA RTS Server")

# ============================================================================
# LRU Cache for Game State
# ============================================================================

class GameStateCache:
    """LRU cache for storing game states per room."""
    
    def __init__(self, max_size: int = 100):
        self.max_size = max_size
        self.cache: OrderedDict[str, Dict[str, Any]] = OrderedDict()
    
    def get(self, room_id: str) -> Optional[Dict[str, Any]]:
        """Get cached state for a room, moving it to end (most recently used)."""
        if room_id in self.cache:
            self.cache.move_to_end(room_id)
            return self.cache[room_id]
        return None
    
    def set(self, room_id: str, state: Dict[str, Any]):
        """Store state for a room, evicting oldest if at capacity."""
        if room_id in self.cache:
            self.cache.move_to_end(room_id)
        else:
            if len(self.cache) >= self.max_size:
                # Evict oldest (first) item
                evicted_room, _ = self.cache.popitem(last=False)
                print(f"[Cache] Evicted old game state for room: {evicted_room}")
        self.cache[room_id] = state
    
    def delete(self, room_id: str):
        """Remove a room's state from cache."""
        if room_id in self.cache:
            del self.cache[room_id]
    
    def __len__(self):
        return len(self.cache)

# Global game state cache (stores up to 100 room states)
game_state_cache = GameStateCache(max_size=100)

# ============================================================================
# Minimap Generation
# ============================================================================

# Cell type constants (must match GLSL)
CELL_EMPTY = 0
CELL_RESOURCE = 1
CELL_MINING_UNIT = 2      # Player 1 unit
CELL_FACTORY = 3          # Player 1 factory
CELL_WALL = 4
CELL_MINING_UNIT_P2 = 5   # Player 2 unit
CELL_DEMOLISH = 6
CELL_FACTORY_P2 = 7       # Player 2 factory

# Colors for minimap (RGB)
MINIMAP_COLORS = {
    CELL_EMPTY: (20, 20, 30),           # Dark background
    CELL_RESOURCE: (255, 200, 50),      # Yellow-gold resources
    CELL_MINING_UNIT: (160, 80, 220),   # Purple player 1 units
    CELL_FACTORY: (120, 50, 180),       # Darker purple player 1 factories
    CELL_WALL: (80, 80, 100),           # Gray walls
    CELL_MINING_UNIT_P2: (80, 200, 120),# Green player 2 units
    CELL_DEMOLISH: (200, 50, 50),       # Red demolish
    CELL_FACTORY_P2: (50, 150, 90),     # Darker green player 2 factories
}

def generate_minimap_png(grid_state_b64: str, grid_size: int = 256, minimap_size: int = 48) -> bytes:
    """
    Generate a minimap PNG from base64-encoded grid state.
    
    Uses weighted block averaging where units and factories are emphasized
    so they "show through" more strongly in the visualization.
    
    Args:
        grid_state_b64: Base64 encoded Float32Array (RGBA per cell)
        grid_size: Original grid size (256x256)
        minimap_size: Output minimap size (48x48)
    
    Returns:
        PNG image as bytes
    """
    # Weights for different cell types (higher = more visible in the minimap)
    CELL_WEIGHTS = {
        CELL_EMPTY: 1,
        CELL_RESOURCE: 2,
        CELL_MINING_UNIT: 15,      # Units really stand out
        CELL_FACTORY: 20,          # Factories stand out the most
        CELL_WALL: 3,
        CELL_MINING_UNIT_P2: 15,   # Player 2 units
        CELL_DEMOLISH: 8,
        CELL_FACTORY_P2: 20,       # Player 2 factories
    }
    
    try:
        # Decode base64 to bytes
        raw_bytes = base64.b64decode(grid_state_b64)
        
        # Convert to floats (4 bytes per float, 4 floats per cell = 16 bytes per cell)
        num_floats = len(raw_bytes) // 4
        floats = struct.unpack(f'{num_floats}f', raw_bytes)
        
        # Create minimap by weighted averaging of blocks
        scale = grid_size // minimap_size
        
        # Build pixel data (RGB, 3 bytes per pixel)
        pixels = []
        
        for y in range(minimap_size):
            row = []
            for x in range(minimap_size):
                # Weighted average of all cells in this block
                r_sum, g_sum, b_sum = 0.0, 0.0, 0.0
                weight_sum = 0.0
                
                for dy in range(scale):
                    for dx in range(scale):
                        gx = x * scale + dx
                        gy = y * scale + dy
                        
                        # Get cell type from R channel (4 floats per cell: R, G, B, A)
                        cell_idx = (gy * grid_size + gx) * 4
                        if cell_idx < len(floats):
                            cell_type = int(floats[cell_idx])
                            color = MINIMAP_COLORS.get(cell_type, MINIMAP_COLORS[CELL_EMPTY])
                            weight = CELL_WEIGHTS.get(cell_type, 1)
                        else:
                            color = MINIMAP_COLORS[CELL_EMPTY]
                            weight = 1
                        
                        r_sum += color[0] * weight
                        g_sum += color[1] * weight
                        b_sum += color[2] * weight
                        weight_sum += weight
                
                # Weighted average
                if weight_sum > 0:
                    avg_color = (
                        min(255, int(r_sum / weight_sum)),
                        min(255, int(g_sum / weight_sum)),
                        min(255, int(b_sum / weight_sum))
                    )
                else:
                    avg_color = MINIMAP_COLORS[CELL_EMPTY]
                row.append(avg_color)
            pixels.append(row)
        
        # Generate PNG manually (minimal implementation)
        return create_png(pixels, minimap_size, minimap_size)
        
    except Exception as e:
        print(f"[Minimap] Error generating minimap: {e}")
        # Return a placeholder 1x1 transparent PNG
        return b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82'


def create_png(pixels, width, height):
    """Create a minimal PNG from RGB pixel data."""
    import zlib
    
    def crc32(data):
        return zlib.crc32(data) & 0xffffffff
    
    def make_chunk(chunk_type, data):
        chunk = chunk_type + data
        return struct.pack('>I', len(data)) + chunk + struct.pack('>I', crc32(chunk))
    
    # PNG signature
    png = b'\x89PNG\r\n\x1a\n'
    
    # IHDR chunk
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    png += make_chunk(b'IHDR', ihdr_data)
    
    # IDAT chunk (image data)
    raw_data = b''
    for row in pixels:
        raw_data += b'\x00'  # Filter type: None
        for r, g, b in row:
            raw_data += bytes([r, g, b])
    
    compressed = zlib.compress(raw_data, 9)
    png += make_chunk(b'IDAT', compressed)
    
    # IEND chunk
    png += make_chunk(b'IEND', b'')
    
    return png


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
class Spectator:
    """Represents a spectator watching a game."""
    websocket: WebSocket
    room_id: str
    spectator_id: int  # Unique ID for this spectator connection


import time

# Fun name generator words
ADJECTIVES = [
    "Swift", "Cosmic", "Blazing", "Shadow", "Crystal", "Thunder", "Iron", "Golden",
    "Mystic", "Frozen", "Electric", "Phantom", "Crimson", "Emerald", "Atomic", "Stellar",
    "Raging", "Silent", "Ancient", "Cyber", "Neon", "Turbo", "Ultra", "Mega",
    "Vortex", "Plasma", "Quantum", "Feral", "Savage", "Noble", "Dark", "Bright"
]

NOUNS = [
    "Dragons", "Warriors", "Knights", "Wolves", "Phoenix", "Titans", "Storm", "Fortress",
    "Legion", "Empire", "Realm", "Crusade", "Dynasty", "Alliance", "Hunters", "Raiders",
    "Guardians", "Sentinels", "Champions", "Vikings", "Spartans", "Ninjas", "Pirates", "Robots",
    "Comets", "Nebula", "Galaxy", "Thunder", "Inferno", "Blizzard", "Cyclone", "Avalanche"
]

def generate_room_name() -> str:
    """Generate a fun memorable room name."""
    adj = random.choice(ADJECTIVES)
    noun = random.choice(NOUNS)
    return f"{adj} {noun}"


@dataclass
class GameRoom:
    """Represents a game room with connected players and spectators."""
    room_id: str
    players: Dict[int, Player] = field(default_factory=dict)
    spectators: Dict[int, Spectator] = field(default_factory=dict)
    next_player_id: int = 1
    next_spectator_id: int = 1
    host_id: Optional[int] = None
    map_seed: int = field(default_factory=lambda: random.randint(1, 999999))
    created_at: float = field(default_factory=time.time)
    display_name: str = field(default_factory=generate_room_name)
    
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
    
    def add_spectator(self, websocket: WebSocket) -> Spectator:
        """Add a spectator to the room."""
        spectator_id = self.next_spectator_id
        self.next_spectator_id += 1
        spectator = Spectator(
            websocket=websocket,
            room_id=self.room_id,
            spectator_id=spectator_id
        )
        self.spectators[spectator_id] = spectator
        return spectator
    
    def remove_spectator(self, spectator_id: int):
        """Remove a spectator from the room."""
        if spectator_id in self.spectators:
            del self.spectators[spectator_id]
    
    def reset_game(self):
        """Reset the game with a new map seed (for Play Again)."""
        self.map_seed = random.randint(1, 999999)
        self.created_at = time.time()
        # Clear cached state
        game_state_cache.delete(self.room_id)
        print(f"[Room {self.room_id}] Reset with new seed: {self.map_seed}")
    
    async def broadcast(self, message: dict, exclude_player_id: Optional[int] = None, include_spectators: bool = True):
        """Broadcast a message to all players (and optionally spectators) in the room."""
        disconnected_players = []
        for player_id, player in self.players.items():
            if player_id != exclude_player_id:
                try:
                    await player.websocket.send_json(message)
                except Exception:
                    disconnected_players.append(player_id)
        
        # Also send to spectators if requested
        disconnected_spectators = []
        if include_spectators:
            for spectator_id, spectator in self.spectators.items():
                try:
                    await spectator.websocket.send_json(message)
                except Exception:
                    disconnected_spectators.append(spectator_id)
        
        # Clean up disconnected players
        for player_id in disconnected_players:
            self.remove_player(player_id)
        
        # Clean up disconnected spectators
        for spectator_id in disconnected_spectators:
            self.remove_spectator(spectator_id)


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
    spectator: Optional[Spectator] = None
    room: Optional[GameRoom] = None
    
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            
            if msg_type == "spectate":
                # Spectator joining a room
                room_id = data.get("roomId", "default")
                print(f"Spectator join request: room={room_id}")
                room = get_or_create_room(room_id)
                spectator = room.add_spectator(websocket)
                
                # Get list of connected players
                connected_player_ids = list(room.players.keys())
                
                # Send spectator confirmation
                await websocket.send_json({
                    "type": "spectating",
                    "spectatorId": spectator.spectator_id,
                    "roomId": room_id,
                    "displayName": room.display_name,
                    "playerCount": len(room.players),
                    "spectatorCount": len(room.spectators),
                    "mapSeed": room.map_seed,
                    "connectedPlayers": connected_player_ids
                })
                
                print(f"Spectator {spectator.spectator_id} joined room '{room_id}' (spectators: {len(room.spectators)})")
                
                # Send cached game state to spectator (if available)
                cached_state = game_state_cache.get(room_id)
                if cached_state:
                    await websocket.send_json({
                        "type": "sync",
                        **cached_state
                    })
                    print(f"Sent cached game state to Spectator {spectator.spectator_id}")
            
            elif msg_type == "join":
                # Player joining a room
                room_id = data.get("roomId", "default")
                requested_player_id = data.get("requestedPlayerId")
                print(f"Join request: room={room_id}, requestedPlayerId={requested_player_id} (type: {type(requested_player_id)})")
                room = get_or_create_room(room_id)
                player = await room.add_player(websocket, requested_player_id)
                print(f"Assigned player_id={player.player_id}")
                
                # Get list of all connected players (including the new one)
                connected_player_ids = list(room.players.keys())
                
                # Send join confirmation with list of existing players
                await websocket.send_json({
                    "type": "joined",
                    "playerId": player.player_id,
                    "isHost": player.is_host,
                    "roomId": room_id,
                    "displayName": room.display_name,
                    "playerCount": len(room.players),
                    "mapSeed": room.map_seed,
                    "connectedPlayers": connected_player_ids
                })
                
                # Notify other players
                await room.broadcast({
                    "type": "player_joined",
                    "playerId": player.player_id,
                    "playerCount": len(room.players)
                }, exclude_player_id=player.player_id)
                
                print(f"Player {player.player_id} joined room '{room_id}' (total: {len(room.players)})")
                
                # Send cached game state to late joiner (if available)
                cached_state = game_state_cache.get(room_id)
                if cached_state and not player.is_host:
                    await websocket.send_json({
                        "type": "sync",
                        **cached_state
                    })
                    print(f"Sent cached game state to Player {player.player_id}")
                
            elif msg_type == "sync":
                # Player syncing their state
                if room and player:
                    # Store state in cache for late joiners
                    game_state_cache.set(room.room_id, {
                        "gridState": data.get("gridState"),
                        "simTime": data.get("simTime"),
                        "action": data.get("action"),
                        "playerId": player.player_id
                    })
                    
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
            
            elif msg_type == "restart":
                # Player requesting game restart (Play Again)
                if room and player:
                    room.reset_game()
                    
                    # Broadcast restart with new seed to all players and spectators
                    await room.broadcast({
                        "type": "restart",
                        "mapSeed": room.map_seed,
                        "initiatedBy": player.player_id
                    })
                    print(f"[Room {room.room_id}] Restart initiated by Player {player.player_id}")
                    
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
        
        # Clean up when spectator disconnects
        if spectator and room:
            spectator_id = spectator.spectator_id
            room.remove_spectator(spectator_id)
            print(f"Spectator {spectator_id} left room '{room.room_id}'")
            
            print(f"Player {player_id} left room '{room.room_id}' (remaining: {len(room.players)})")
            
            # Clean up empty rooms
            if not room.players:
                del rooms[room.room_id]
                game_state_cache.delete(room.room_id)
                print(f"Room '{room.room_id}' removed (empty, cache cleared)")


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
    current_time = time.time()
    return {
        "rooms": [
            {
                "roomId": room.room_id,
                "displayName": room.display_name,
                "playerCount": len(room.players),
                "spectatorCount": len(room.spectators),
                "maxPlayers": 2,
                "hostId": room.host_id,
                "mapSeed": room.map_seed,
                "createdAt": room.created_at,
                "ageSeconds": int(current_time - room.created_at),
                "hasState": game_state_cache.get(room.room_id) is not None
            }
            for room in rooms.values()
        ]
    }


@app.post("/api/rooms/create")
async def create_room():
    """Create a new game room and return its details."""
    # Generate the display name first, then use it as room ID (URL-safe)
    display_name = generate_room_name()
    room_id = display_name.lower().replace(" ", "-")
    
    # If this room already exists, add a number
    if room_id in rooms:
        suffix = 2
        while f"{room_id}-{suffix}" in rooms:
            suffix += 1
        room_id = f"{room_id}-{suffix}"
        display_name = f"{display_name} {suffix}"
    
    room = get_or_create_room(room_id)
    room.display_name = display_name  # Override with our generated name
    
    return {
        "roomId": room.room_id,
        "displayName": room.display_name,
        "mapSeed": room.map_seed
    }


@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "rooms": len(rooms)}


@app.get("/api/rooms/{room_id}/minimap")
async def get_room_minimap(room_id: str):
    """Get a minimap image for a room's current game state."""
    cached_state = game_state_cache.get(room_id)
    
    if not cached_state or not cached_state.get("gridState"):
        # Return a placeholder "no state" image (dark with question mark pattern)
        # For now, return 404
        return Response(
            content=b'',
            status_code=404,
            media_type="image/png"
        )
    
    grid_state_b64 = cached_state["gridState"]
    png_data = generate_minimap_png(grid_state_b64)
    
    return Response(
        content=png_data,
        media_type="image/png",
        headers={"Cache-Control": "no-cache"}
    )


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
