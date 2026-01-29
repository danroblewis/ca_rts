/**
 * Camera.js - Camera and coordinate conversion system
 * 
 * Handles viewport management, zoom, pan, and coordinate conversions
 * between screen space and grid space.
 */

import { clamp } from '../utils/GameUtils.js';

export class Camera {
    /**
     * Create a camera.
     * 
     * @param {Object} config - Configuration
     * @param {number} config.gridSize - Size of the grid
     * @param {number} config.defaultZoom - Initial zoom level
     * @param {number} config.minZoom - Minimum zoom level
     * @param {number} config.maxZoom - Maximum zoom level
     * @param {number} config.zoomSpeed - Zoom speed per wheel tick
     * @param {number} config.panSpeed - Pan speed multiplier
     */
    constructor(config = {}) {
        this.gridSize = config.gridSize || 512;
        this.defaultZoom = config.defaultZoom || 2.0;
        this.minZoom = config.minZoom || 1.5;
        this.maxZoom = config.maxZoom || 8.0;
        this.zoomSpeed = config.zoomSpeed || 0.1;
        this.panSpeed = config.panSpeed || 1.0;
        
        // Current state
        this.x = this.gridSize / 2;
        this.y = this.gridSize / 2;
        this.zoom = this.defaultZoom;
        
        // Canvas reference (set via setCanvas)
        this.canvas = null;
        
        // Panning state
        this.isPanning = false;
        this.panStartX = 0;
        this.panStartY = 0;
        this.panStartCameraX = 0;
        this.panStartCameraY = 0;
        
        // Listeners
        this.listeners = [];
    }
    
    /**
     * Set the canvas element for coordinate conversions.
     */
    setCanvas(canvas) {
        this.canvas = canvas;
    }
    
    /**
     * Subscribe to camera changes.
     */
    onChange(callback) {
        this.listeners.push(callback);
    }
    
    /**
     * Emit change event.
     */
    emitChange() {
        const data = { x: this.x, y: this.y, zoom: this.zoom };
        this.listeners.forEach(cb => cb(data));
    }
    
    /**
     * Get visible grid size based on current zoom.
     * Returns the base visible size (for the shorter dimension).
     */
    getVisibleGridSize() {
        return this.gridSize / this.zoom;
    }
    
    /**
     * Get aspect ratio of the canvas (width / height).
     */
    getAspectRatio() {
        if (!this.canvas) return 1.0;
        const rect = this.canvas.getBoundingClientRect();
        return rect.width / rect.height;
    }
    
    /**
     * Get visible width and height in grid units.
     * The shorter dimension uses the base visible size,
     * the longer dimension extends to show more of the sim.
     */
    getVisibleDimensions() {
        const baseSize = this.getVisibleGridSize();
        const aspect = this.getAspectRatio();
        
        if (aspect >= 1.0) {
            // Wider than tall: height is base, width extends
            return {
                width: baseSize * aspect,
                height: baseSize
            };
        } else {
            // Taller than wide: width is base, height extends
            return {
                width: baseSize,
                height: baseSize / aspect
            };
        }
    }
    
    /**
     * Clamp camera position to keep view within map bounds.
     */
    clamp() {
        const dims = this.getVisibleDimensions();
        const halfWidth = dims.width / 2;
        const halfHeight = dims.height / 2;
        this.x = clamp(this.x, halfWidth, this.gridSize - halfWidth);
        this.y = clamp(this.y, halfHeight, this.gridSize - halfHeight);
    }
    
    /**
     * Set camera position.
     */
    setPosition(x, y) {
        this.x = x;
        this.y = y;
        this.clamp();
        this.emitChange();
    }
    
    /**
     * Pan camera by delta in grid units.
     */
    pan(dx, dy) {
        this.x += dx * this.panSpeed;
        this.y += dy * this.panSpeed;
        this.clamp();
        this.emitChange();
    }
    
    /**
     * Set zoom level.
     */
    setZoom(zoom) {
        this.zoom = clamp(zoom, this.minZoom, this.maxZoom);
        this.clamp();
        this.emitChange();
    }
    
    /**
     * Adjust zoom by a multiplier.
     */
    adjustZoom(factor) {
        this.setZoom(this.zoom * factor);
    }
    
    /**
     * Zoom in by one step.
     */
    zoomIn() {
        this.adjustZoom(1 + this.zoomSpeed);
    }
    
    /**
     * Zoom out by one step.
     */
    zoomOut() {
        this.adjustZoom(1 - this.zoomSpeed);
    }
    
    /**
     * Start panning from a screen position.
     */
    startPan(screenX, screenY) {
        this.isPanning = true;
        this.panStartX = screenX;
        this.panStartY = screenY;
        this.panStartCameraX = this.x;
        this.panStartCameraY = this.y;
    }
    
    /**
     * Update pan based on current screen position.
     */
    updatePan(screenX, screenY) {
        if (!this.isPanning || !this.canvas) return;
        
        const rect = this.canvas.getBoundingClientRect();
        const dims = this.getVisibleDimensions();
        
        // Calculate delta in grid units using aspect-correct dimensions
        const dx = (screenX - this.panStartX) / rect.width * dims.width;
        const dy = (screenY - this.panStartY) / rect.height * dims.height;
        
        // Apply delta (inverted because dragging moves the view, not the camera)
        this.x = this.panStartCameraX - dx;
        this.y = this.panStartCameraY + dy;  // Y is inverted
        this.clamp();
        this.emitChange();
    }
    
    /**
     * End panning.
     */
    endPan() {
        this.isPanning = false;
    }
    
    /**
     * Convert screen coordinates to grid coordinates.
     * 
     * @param {number} screenX - Screen X position
     * @param {number} screenY - Screen Y position
     * @returns {{x: number, y: number}} Grid coordinates
     */
    screenToGrid(screenX, screenY) {
        if (!this.canvas) {
            return { x: 0, y: 0 };
        }
        
        const rect = this.canvas.getBoundingClientRect();
        const dims = this.getVisibleDimensions();
        
        // Normalized screen position (0-1)
        const normalizedX = (screenX - rect.left) / rect.width;
        const normalizedY = (screenY - rect.top) / rect.height;
        
        // Convert to centered coordinates (-0.5 to 0.5)
        const centeredX = normalizedX - 0.5;
        const centeredY = -(normalizedY - 0.5);  // Y is inverted
        
        // Apply camera transform with aspect-correct dimensions
        const gridX = Math.floor(this.x + centeredX * dims.width);
        const gridY = Math.floor(this.y + centeredY * dims.height);
        
        return {
            x: clamp(gridX, 0, this.gridSize - 1),
            y: clamp(gridY, 0, this.gridSize - 1)
        };
    }
    
    /**
     * Convert grid coordinates to screen coordinates.
     * 
     * @param {number} gridX - Grid X position
     * @param {number} gridY - Grid Y position
     * @returns {{x: number, y: number}} Screen coordinates
     */
    gridToScreen(gridX, gridY) {
        if (!this.canvas) {
            return { x: 0, y: 0 };
        }
        
        const rect = this.canvas.getBoundingClientRect();
        const dims = this.getVisibleDimensions();
        
        // Convert grid to centered coords relative to camera (with aspect)
        const centeredX = (gridX - this.x) / dims.width;
        const centeredY = (gridY - this.y) / dims.height;
        
        // Convert to normalized screen position
        const normalizedX = centeredX + 0.5;
        const normalizedY = 0.5 - centeredY;  // Y is inverted
        
        return {
            x: rect.left + normalizedX * rect.width,
            y: rect.top + normalizedY * rect.height
        };
    }
    
    /**
     * Check if a grid position is visible on screen.
     */
    isVisible(gridX, gridY, margin = 0) {
        const dims = this.getVisibleDimensions();
        const halfWidth = dims.width / 2 + margin;
        const halfHeight = dims.height / 2 + margin;
        return Math.abs(gridX - this.x) <= halfWidth &&
               Math.abs(gridY - this.y) <= halfHeight;
    }
    
    /**
     * Get the visible region in grid coordinates.
     */
    getVisibleRegion() {
        const dims = this.getVisibleDimensions();
        const halfWidth = dims.width / 2;
        const halfHeight = dims.height / 2;
        return {
            x1: Math.max(0, Math.floor(this.x - halfWidth)),
            y1: Math.max(0, Math.floor(this.y - halfHeight)),
            x2: Math.min(this.gridSize - 1, Math.ceil(this.x + halfWidth)),
            y2: Math.min(this.gridSize - 1, Math.ceil(this.y + halfHeight))
        };
    }
    
    /**
     * Reset camera to default position and zoom.
     */
    reset() {
        this.x = this.gridSize / 2;
        this.y = this.gridSize / 2;
        this.zoom = this.defaultZoom;
        this.isPanning = false;
        this.emitChange();
    }
    
    /**
     * Get camera state for shader uniforms.
     */
    getUniforms() {
        const dims = this.getVisibleDimensions();
        return {
            cameraX: this.x,
            cameraY: this.y,
            cameraZoom: this.zoom,
            visibleSize: this.getVisibleGridSize(),
            visibleWidth: dims.width,
            visibleHeight: dims.height,
            aspectRatio: this.getAspectRatio()
        };
    }
}

// Default instance
let defaultCamera = null;

export function getCamera() {
    if (!defaultCamera) {
        defaultCamera = new Camera();
    }
    return defaultCamera;
}

export function initCamera(config) {
    defaultCamera = new Camera(config);
    return defaultCamera;
}

