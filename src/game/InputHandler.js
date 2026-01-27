/**
 * InputHandler.js - Centralized input handling
 * 
 * Handles all mouse and keyboard events, delegating to appropriate handlers.
 * Separates input detection from game logic.
 */

import { Logger } from '../utils/Logger.js';

/**
 * Detect if running on macOS (for trackpad behavior).
 */
function isMacOS() {
    return navigator.platform.toUpperCase().indexOf('MAC') >= 0 ||
           navigator.userAgent.toUpperCase().indexOf('MAC') >= 0;
}

export class InputHandler {
    /**
     * Create an input handler.
     * 
     * @param {Object} config - Configuration
     * @param {HTMLCanvasElement} config.canvas - The canvas element
     * @param {Camera} config.camera - The camera instance
     * @param {GameState} config.gameState - The game state instance
     */
    constructor(config) {
        this.canvas = config.canvas;
        this.camera = config.camera;
        this.gameState = config.gameState;
        
        // Mouse state
        this.mouseX = 0;
        this.mouseY = 0;
        this.mouseGridX = 0;
        this.mouseGridY = 0;
        this.isMouseDown = false;
        this.mouseButton = 0;
        
        // Key state
        this.keysDown = new Set();
        this.ctrlDown = false;
        this.shiftDown = false;
        this.altDown = false;
        
        // Platform detection
        this.isMac = isMacOS();
        
        // Callbacks for game actions
        this.callbacks = {
            onPlaceFactory: null,      // (gridX, gridY, player) => void
            onDeleteFactory: null,     // (gridX, gridY, player) => void
            onSelectionStart: null,    // (gridX, gridY) => void
            onSelectionUpdate: null,   // (gridX, gridY) => void
            onSelectionEnd: null,      // (region) => void
            onUnitCommand: null,       // (destX, destY) => void
            onClearSelection: null,    // () => void
            onToggleDeleteMode: null,  // () => void
            onTogglePlayer: null,      // () => void
            onEscape: null,            // () => void
        };
        
        // Bound handlers (for removal)
        this.boundHandlers = {};
        
        // Suppress next click (for selection clearing)
        this.suppressNextClick = false;
    }
    
    /**
     * Set a callback for a game action.
     */
    on(event, callback) {
        if (this.callbacks.hasOwnProperty(event)) {
            this.callbacks[event] = callback;
        }
    }
    
    /**
     * Emit a callback if it's set.
     */
    emit(event, ...args) {
        if (this.callbacks[event]) {
            this.callbacks[event](...args);
        }
    }
    
    /**
     * Initialize event listeners.
     */
    init() {
        // Mouse events on canvas
        this.boundHandlers.mousedown = this.handleMouseDown.bind(this);
        this.boundHandlers.mouseup = this.handleMouseUp.bind(this);
        this.boundHandlers.mousemove = this.handleMouseMove.bind(this);
        this.boundHandlers.click = this.handleClick.bind(this);
        this.boundHandlers.contextmenu = this.handleContextMenu.bind(this);
        this.boundHandlers.wheel = this.handleWheel.bind(this);
        
        this.canvas.addEventListener('mousedown', this.boundHandlers.mousedown);
        this.canvas.addEventListener('mouseup', this.boundHandlers.mouseup);
        this.canvas.addEventListener('mousemove', this.boundHandlers.mousemove);
        this.canvas.addEventListener('click', this.boundHandlers.click);
        this.canvas.addEventListener('contextmenu', this.boundHandlers.contextmenu);
        this.canvas.addEventListener('wheel', this.boundHandlers.wheel, { passive: false });
        
        // Keyboard events on window
        this.boundHandlers.keydown = this.handleKeyDown.bind(this);
        this.boundHandlers.keyup = this.handleKeyUp.bind(this);
        
        window.addEventListener('keydown', this.boundHandlers.keydown);
        window.addEventListener('keyup', this.boundHandlers.keyup);
        
        Logger.log('input', 'InputHandler initialized');
    }
    
    /**
     * Remove event listeners.
     */
    destroy() {
        this.canvas.removeEventListener('mousedown', this.boundHandlers.mousedown);
        this.canvas.removeEventListener('mouseup', this.boundHandlers.mouseup);
        this.canvas.removeEventListener('mousemove', this.boundHandlers.mousemove);
        this.canvas.removeEventListener('click', this.boundHandlers.click);
        this.canvas.removeEventListener('contextmenu', this.boundHandlers.contextmenu);
        this.canvas.removeEventListener('wheel', this.boundHandlers.wheel);
        
        window.removeEventListener('keydown', this.boundHandlers.keydown);
        window.removeEventListener('keyup', this.boundHandlers.keyup);
    }
    
    /**
     * Update grid coordinates from screen coordinates.
     */
    updateGridCoords(screenX, screenY) {
        this.mouseX = screenX;
        this.mouseY = screenY;
        const grid = this.camera.screenToGrid(screenX, screenY);
        this.mouseGridX = grid.x;
        this.mouseGridY = grid.y;
    }
    
    // ========================================================================
    // Mouse Event Handlers
    // ========================================================================
    
    handleMouseDown(event) {
        this.isMouseDown = true;
        this.mouseButton = event.button;
        this.updateGridCoords(event.clientX, event.clientY);
        
        const isRightClick = event.button === 2 || (event.button === 0 && this.ctrlDown);
        const isMiddleClick = event.button === 1 || (event.button === 0 && this.altDown);
        const isLeftClick = event.button === 0 && !this.ctrlDown && !this.altDown;
        
        // Middle click or alt+click: start panning
        if (isMiddleClick) {
            this.camera.startPan(event.clientX, event.clientY);
            return;
        }
        
        // Check if we're in selection mode
        if (this.gameState.hasActiveSelection) {
            // Left click clears selection (in selection mode)
            if (isLeftClick) {
                this.emit('onClearSelection');
                this.suppressNextClick = true;
                return;
            }
            
            // Right click or ctrl+click gives command
            if (isRightClick) {
                this.emit('onUnitCommand', this.mouseGridX, this.mouseGridY);
                return;
            }
        }
        
        // Check if we're in delete mode
        if (this.gameState.deleteMode) {
            if (isLeftClick) {
                this.emit('onDeleteFactory', this.mouseGridX, this.mouseGridY, this.gameState.currentPlayer);
            }
            return;
        }
        
        // Left click starts selection
        if (isLeftClick && !this.gameState.isSpectator) {
            this.gameState.startSelection(this.mouseGridX, this.mouseGridY);
            this.emit('onSelectionStart', this.mouseGridX, this.mouseGridY);
        }
    }
    
    handleMouseUp(event) {
        this.isMouseDown = false;
        this.updateGridCoords(event.clientX, event.clientY);
        
        // End panning
        if (this.camera.isPanning) {
            this.camera.endPan();
            return;
        }
        
        // End selection
        if (this.gameState.isSelecting) {
            const region = this.gameState.endSelection();
            if (region) {
                this.emit('onSelectionEnd', region);
            }
        }
    }
    
    handleMouseMove(event) {
        this.updateGridCoords(event.clientX, event.clientY);
        
        // Update panning
        if (this.camera.isPanning) {
            this.camera.updatePan(event.clientX, event.clientY);
            return;
        }
        
        // Update selection
        if (this.gameState.isSelecting) {
            this.gameState.updateSelection(this.mouseGridX, this.mouseGridY);
            this.emit('onSelectionUpdate', this.mouseGridX, this.mouseGridY);
        }
    }
    
    handleClick(event) {
        // Suppress click if we just cleared selection
        if (this.suppressNextClick) {
            this.suppressNextClick = false;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        
        this.updateGridCoords(event.clientX, event.clientY);
        
        // Don't place factories in certain modes
        if (this.gameState.deleteMode) return;
        if (this.gameState.hasActiveSelection) return;
        if (this.gameState.isSpectator) return;
        if (event.button !== 0) return;  // Left click only
        if (this.ctrlDown || this.altDown) return;  // Not with modifiers
        
        // Check if selection was just a click (no drag)
        // A small selection region should trigger factory placement instead
        const region = this.gameState.selectedRegion;
        if (region) {
            const width = Math.abs(region.x2 - region.x1);
            const height = Math.abs(region.y2 - region.y1);
            if (width <= 2 && height <= 2) {
                // Small selection = single click = place factory
                this.emit('onPlaceFactory', this.mouseGridX, this.mouseGridY, this.gameState.currentPlayer);
            }
        } else {
            // No selection = place factory
            this.emit('onPlaceFactory', this.mouseGridX, this.mouseGridY, this.gameState.currentPlayer);
        }
    }
    
    handleContextMenu(event) {
        event.preventDefault();
        
        this.updateGridCoords(event.clientX, event.clientY);
        
        // Right click in selection mode gives command
        if (this.gameState.hasActiveSelection) {
            this.emit('onUnitCommand', this.mouseGridX, this.mouseGridY);
        }
    }
    
    handleWheel(event) {
        event.preventDefault();
        
        const hasHorizontalScroll = Math.abs(event.deltaX) > 1;
        
        if (this.isMac) {
            // Mac trackpad: two-finger scroll = pan, alt+scroll = zoom
            if (this.altDown) {
                // Alt + scroll = zoom
                if (event.deltaY < 0) {
                    this.camera.zoomIn();
                } else {
                    this.camera.zoomOut();
                }
            } else {
                // Regular scroll = pan
                const visibleSize = this.camera.getVisibleGridSize();
                const panX = (event.deltaX / this.canvas.clientWidth) * visibleSize;
                const panY = (-event.deltaY / this.canvas.clientHeight) * visibleSize;
                this.camera.pan(panX, panY);
            }
        } else {
            // Windows/Linux: scroll = zoom, alt+scroll = pan
            if (this.altDown || hasHorizontalScroll) {
                // Alt + scroll or horizontal scroll = pan
                const visibleSize = this.camera.getVisibleGridSize();
                const panX = (event.deltaX / this.canvas.clientWidth) * visibleSize;
                const panY = (-event.deltaY / this.canvas.clientHeight) * visibleSize;
                this.camera.pan(panX, panY);
            } else {
                // Scroll = zoom
                if (event.deltaY < 0) {
                    this.camera.zoomIn();
                } else {
                    this.camera.zoomOut();
                }
            }
        }
    }
    
    // ========================================================================
    // Keyboard Event Handlers
    // ========================================================================
    
    handleKeyDown(event) {
        this.keysDown.add(event.key.toLowerCase());
        this.ctrlDown = event.ctrlKey || event.metaKey;
        this.shiftDown = event.shiftKey;
        this.altDown = event.altKey;
        
        // Escape: clear selection or exit delete mode
        if (event.key === 'Escape') {
            if (this.gameState.hasActiveSelection) {
                this.emit('onClearSelection');
            } else if (this.gameState.deleteMode) {
                this.emit('onToggleDeleteMode');
            } else {
                this.emit('onEscape');
            }
            return;
        }
        
        // D: toggle delete mode
        if (event.key.toLowerCase() === 'd' && !this.ctrlDown) {
            this.emit('onToggleDeleteMode');
            return;
        }
        
        // 1/2: switch player (for testing)
        if (event.key === '1') {
            this.gameState.setCurrentPlayer(1);
            this.emit('onTogglePlayer');
            return;
        }
        if (event.key === '2') {
            this.gameState.setCurrentPlayer(2);
            this.emit('onTogglePlayer');
            return;
        }
    }
    
    handleKeyUp(event) {
        this.keysDown.delete(event.key.toLowerCase());
        this.ctrlDown = event.ctrlKey || event.metaKey;
        this.shiftDown = event.shiftKey;
        this.altDown = event.altKey;
    }
    
    // ========================================================================
    // State Getters
    // ========================================================================
    
    /**
     * Get current mouse position in grid coordinates.
     */
    getMouseGridPos() {
        return { x: this.mouseGridX, y: this.mouseGridY };
    }
    
    /**
     * Get current mouse position in screen coordinates.
     */
    getMouseScreenPos() {
        return { x: this.mouseX, y: this.mouseY };
    }
    
    /**
     * Check if a key is currently pressed.
     */
    isKeyDown(key) {
        return this.keysDown.has(key.toLowerCase());
    }
}

