/**
 * InputHandler.js - Mouse and keyboard input handling
 * 
 * This module handles all user input events (mouse, keyboard, wheel)
 * and delegates actions to the provided context/callbacks.
 */

import { Logger } from '../utils/Logger.js';

export class InputHandler {
    constructor(options = {}) {
        // Required options
        this.canvas = options.canvas;
        this.camera = options.camera;
        this.gridSize = options.gridSize || 512;
        
        // Callbacks
        this.onPlaceFactory = options.onPlaceFactory || (() => {});
        this.onDemolish = options.onDemolish || (() => {});
        this.onUnitSelection = options.onUnitSelection || (() => {});
        this.onUnitCommand = options.onUnitCommand || (() => {});
        this.onClearSelection = options.onClearSelection || (() => {});
        this.onInitAudio = options.onInitAudio || (() => {});
        this.isSpectator = options.isSpectator || (() => false);
        this.hasActiveSelection = options.hasActiveSelection || (() => false);
        this.getSelectedRegion = options.getSelectedRegion || (() => null);
        this.markUnitsInRegion = options.markUnitsInRegion || (() => 0);
        this.clearAllSelections = options.clearAllSelections || (() => {});
        this.screenToGrid = options.screenToGrid || ((x, y) => ({ x: 0, y: 0 }));
        
        // Config
        this.zoomSpeed = options.zoomSpeed || 0.1;
        this.deleteRadius = options.deleteRadius || 5;
        
        // State
        this.mouseX = 0;
        this.mouseY = 0;
        this.shiftHeld = false;
        this.isSelecting = false;
        this.selectionStart = null;
        this.selectionEnd = null;
        this._hasActiveSelection = false;
        this.selectedRegion = null;
        this.suppressNextClick = false;
        
        // Detect platform for scroll behavior
        this.isMacOS = navigator.platform.toUpperCase().indexOf('MAC') >= 0 || 
                       navigator.userAgent.toUpperCase().indexOf('MAC') >= 0;
        
        // Add command-ping animation style
        this._addPingStyle();
        
        // Bind event handlers
        this._bindEvents();
    }
    
    /**
     * Add CSS for command ping animation.
     */
    _addPingStyle() {
        if (document.getElementById('input-handler-ping-style')) return;
        
        const style = document.createElement('style');
        style.id = 'input-handler-ping-style';
        style.textContent = `
            @keyframes command-ping {
                0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
                100% { transform: translate(-50%, -50%) scale(3); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
    }
    
    /**
     * Show a ping animation at the given screen position.
     */
    showCommandPing(screenX, screenY) {
        const ping = document.createElement('div');
        ping.style.cssText = `
            position: fixed;
            left: ${screenX}px;
            top: ${screenY}px;
            width: 20px;
            height: 20px;
            border: 3px solid #ffcc00;
            border-radius: 50%;
            pointer-events: none;
            z-index: 101;
            animation: command-ping 0.5s ease-out forwards;
        `;
        document.body.appendChild(ping);
        setTimeout(() => ping.remove(), 500);
    }
    
    /**
     * Clear current selection state.
     */
    clearSelection() {
        this.isSelecting = false;
        this._hasActiveSelection = false;
        this.selectedRegion = null;
        this.selectionStart = null;
        this.selectionEnd = null;
        
        // Clear selection bits in all units via callback
        this.clearAllSelections();
    }
    
    /**
     * Check if there's an active selection.
     */
    hasSelection() {
        return this._hasActiveSelection;
    }
    
    /**
     * Get the currently selected region.
     */
    getSelection() {
        return this.selectedRegion;
    }
    
    /**
     * Get current mouse position.
     */
    getMousePosition() {
        return { x: this.mouseX, y: this.mouseY };
    }
    
    /**
     * Check if shift is held.
     */
    isShiftHeld() {
        return this.shiftHeld;
    }
    
    /**
     * Check if we're currently selecting.
     */
    isInSelectionMode() {
        return this.isSelecting;
    }
    
    /**
     * Bind all event handlers to the canvas and window.
     */
    _bindEvents() {
        // Mouse move
        this.canvas.addEventListener('mousemove', this._onMouseMove.bind(this));
        
        // Wheel (zoom/pan)
        this.canvas.addEventListener('wheel', this._onWheel.bind(this));
        
        // Keyboard
        window.addEventListener('keydown', this._onKeyDown.bind(this));
        window.addEventListener('keyup', this._onKeyUp.bind(this));
        
        // Mouse buttons
        this.canvas.addEventListener('mousedown', this._onMouseDown.bind(this));
        this.canvas.addEventListener('mouseup', this._onMouseUp.bind(this));
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        this.canvas.addEventListener('click', this._onClick.bind(this));
    }
    
    /**
     * Handle mouse movement.
     */
    _onMouseMove(event) {
        this.mouseX = event.clientX;
        this.mouseY = event.clientY;
        
        // Handle panning with middle mouse button
        if (this.camera.isPanning) {
            this.camera.updatePan(event.clientX, event.clientY);
        }
    }
    
    /**
     * Handle scroll wheel (zoom/pan).
     */
    _onWheel(event) {
        event.preventDefault();
        
        // On macOS: default to pan (trackpad behavior), Alt+scroll = zoom
        // On other OS: default to zoom (mouse wheel behavior), scroll with horizontal = pan
        if (this.isMacOS) {
            if (event.altKey) {
                // Zoom mode
                this._handleZoom(event);
            } else {
                // Pan mode (default on macOS)
                this._handlePan(event);
            }
        } else {
            // Windows/Linux: Scroll = zoom, scroll with significant horizontal = pan
            const hasHorizontal = Math.abs(event.deltaX) > 2;
            
            if (hasHorizontal) {
                this._handlePan(event);
            } else {
                this._handleZoom(event);
            }
        }
    }
    
    /**
     * Handle zoom via scroll.
     */
    _handleZoom(event) {
        const mouseGridBefore = this.screenToGrid(event.clientX, event.clientY);
        let zoomAmount = event.deltaY;
        if (event.deltaMode === 1) zoomAmount *= 16;
        if (event.deltaMode === 2) zoomAmount *= 100;
        const zoomDelta = -zoomAmount * this.zoomSpeed * 0.01;
        this.camera.setZoom(this.camera.zoom * (1 + zoomDelta));
        const mouseGridAfter = this.screenToGrid(event.clientX, event.clientY);
        this.camera.x += mouseGridBefore.x - mouseGridAfter.x;
        this.camera.y += mouseGridBefore.y - mouseGridAfter.y;
        this.camera.clamp();
    }
    
    /**
     * Handle pan via scroll.
     */
    _handlePan(event) {
        const visibleSize = this.camera.getVisibleGridSize();
        const panScale = visibleSize / 500;
        this.camera.x += event.deltaX * panScale;
        this.camera.y -= event.deltaY * panScale;
        this.camera.clamp();
    }
    
    /**
     * Handle key down.
     */
    _onKeyDown(event) {
        if (event.key === 'Shift') {
            this.shiftHeld = true;
        }
        
        if (event.key === 'Escape') {
            if (this._hasActiveSelection) {
                this.onClearSelection();
            }
            this.clearSelection();
        }
    }
    
    /**
     * Handle key up.
     */
    _onKeyUp(event) {
        if (event.key === 'Shift') {
            this.shiftHeld = false;
        }
    }
    
    /**
     * Handle mouse down.
     */
    _onMouseDown(event) {
        // Middle mouse button - start panning
        if (event.button === 1) {
            event.preventDefault();
            this.camera.startPan(event.clientX, event.clientY);
            this.canvas.style.cursor = 'grabbing';
            return;
        }
        
        // Spectators cannot interact (but can still pan)
        if (this.isSpectator()) return;
        
        // Left click with active selection = clear selection (like pressing Escape)
        if (event.button === 0 && this._hasActiveSelection && !this.shiftHeld) {
            event.preventDefault();
            this.onClearSelection();
            this.clearSelection();
            this.suppressNextClick = true;
            return;
        }
        
        // Right click or ctrl+click with active selection = set command destination
        if ((event.button === 2 || event.ctrlKey) && this._hasActiveSelection && this.selectedRegion && !this.shiftHeld) {
            event.preventDefault();
            const destPos = this.screenToGrid(event.clientX, event.clientY);
            
            // Create command for the selected units
            const command = {
                sourceX1: this.selectedRegion.x1,
                sourceY1: this.selectedRegion.y1,
                sourceX2: this.selectedRegion.x2,
                sourceY2: this.selectedRegion.y2,
                destX: destPos.x,
                destY: destPos.y
            };
            
            Logger.log('input', `[Command] Sending units from ${JSON.stringify(this.selectedRegion)} to ${JSON.stringify(destPos)}`);
            
            // Show visual feedback
            this.showCommandPing(event.clientX, event.clientY);
            
            // Delegate to callback
            this.onUnitCommand(command);
            return;
        }
        
        // Right click or ctrl+click without selection - start new selection
        if ((event.button === 2 || event.ctrlKey) && !this._hasActiveSelection) {
            event.preventDefault();
            
            // Start new selection
            this.isSelecting = true;
            this.selectionStart = { x: event.clientX, y: event.clientY };
            this.selectionEnd = null;
            this._hasActiveSelection = false;
            this.selectedRegion = null;
        }
    }
    
    /**
     * Handle mouse up.
     */
    _onMouseUp(event) {
        // Stop panning on middle mouse release
        if (event.button === 1 && this.camera.isPanning) {
            this.camera.endPan();
            this.canvas.style.cursor = 'default';
            return;
        }
        
        if (this.isSelecting && (event.button === 2 || event.ctrlKey)) {
            this.selectionEnd = { x: event.clientX, y: event.clientY };
            
            // Convert to grid coordinates
            const start = this.screenToGrid(this.selectionStart.x, this.selectionStart.y);
            const end = this.screenToGrid(this.selectionEnd.x, this.selectionEnd.y);
            
            this.selectedRegion = {
                x1: Math.min(start.x, end.x),
                y1: Math.min(start.y, end.y),
                x2: Math.max(start.x, end.x),
                y2: Math.max(start.y, end.y)
            };
            
            // Check if selection is large enough (at least 2x2)
            if (this.selectedRegion.x2 - this.selectedRegion.x1 >= 1 && 
                this.selectedRegion.y2 - this.selectedRegion.y1 >= 1) {
                
                // Mark units in the selection region (async GPU readback)
                Promise.resolve(this.markUnitsInRegion(this.selectedRegion)).then(unitsMarked => {
                    if (unitsMarked > 0) {
                        this._hasActiveSelection = true;
                        Logger.log('input', `[Selection] Selected region: ${JSON.stringify(this.selectedRegion)} with ${unitsMarked} units`);

                        // Notify via callback
                        this.onUnitSelection(this.selectedRegion);
                    } else {
                        Logger.log('input', '[Selection] No units in region');
                        this.clearSelection();
                    }
                });
            } else {
                this.clearSelection();
            }
            
            this.isSelecting = false;
        }
    }
    
    /**
     * Handle click (factory placement / demolition).
     */
    _onClick(event) {
        // Spectators cannot interact
        if (this.isSpectator()) {
            Logger.log('input', '[Spectator] Cannot interact - spectator mode');
            return;
        }
        
        // If we just cleared a selection via mousedown, don't place a base
        if (this.suppressNextClick) {
            this.suppressNextClick = false;
            return;
        }
        
        // If we're in selection mode or have active selection, don't do normal click
        if (this.isSelecting || this._hasActiveSelection) {
            return;
        }
        
        // Initialize audio on first interaction
        this.onInitAudio();
        
        const gridPos = this.screenToGrid(event.clientX, event.clientY);
        
        if (event.shiftKey) {
            // SHIFT+CLICK: Demolish
            this.onDemolish(gridPos.x, gridPos.y);
        } else {
            // NORMAL CLICK: Place factory
            this.onPlaceFactory(gridPos.x, gridPos.y);
        }
    }
    
    /**
     * Clean up event handlers.
     */
    destroy() {
        this.canvas.removeEventListener('mousemove', this._onMouseMove);
        this.canvas.removeEventListener('wheel', this._onWheel);
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
        this.canvas.removeEventListener('mousedown', this._onMouseDown);
        this.canvas.removeEventListener('mouseup', this._onMouseUp);
        this.canvas.removeEventListener('click', this._onClick);
    }
}

