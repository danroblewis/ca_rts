/**
 * Camera Unit Tests
 * Tests for game/Camera.js
 */

import { runTest, assert, assertApprox, logSection } from './framework.js';
import { Camera, initCamera, getCamera } from '../game/Camera.js';

export async function runCameraTests() {
    logSection('Camera - Initialization');
    
    await runTest('Camera initializes with default values', async () => {
        const camera = new Camera({
            gridSize: 512,
            defaultZoom: 2.0,
            minZoom: 1.5,
            maxZoom: 8.0
        });
        
        assertApprox(camera.x, 256, 0.1, 'Default x should be center');
        assertApprox(camera.y, 256, 0.1, 'Default y should be center');
        assertApprox(camera.zoom, 2.0, 0.01, 'Default zoom should be 2.0');
        assert(camera.isPanning === false, 'Should not be panning initially');
    });
    
    await runTest('initCamera creates singleton', async () => {
        const camera1 = initCamera({
            gridSize: 512,
            defaultZoom: 2.0,
            minZoom: 1.5,
            maxZoom: 8.0
        });
        
        const camera2 = getCamera();
        assert(camera1 === camera2, 'getCamera should return same instance');
    });
    
    logSection('Camera - Zoom');
    
    await runTest('setZoom clamps to min/max', async () => {
        const camera = new Camera({
            gridSize: 512,
            defaultZoom: 2.0,
            minZoom: 1.5,
            maxZoom: 8.0
        });
        
        camera.setZoom(0.5);
        assertApprox(camera.zoom, 1.5, 0.01, 'Zoom below min should clamp to 1.5');
        
        camera.setZoom(20.0);
        assertApprox(camera.zoom, 8.0, 0.01, 'Zoom above max should clamp to 8.0');
        
        camera.setZoom(4.0);
        assertApprox(camera.zoom, 4.0, 0.01, 'Zoom in range should be set directly');
    });
    
    await runTest('adjustZoom modifies zoom by delta', async () => {
        const camera = new Camera({
            gridSize: 512,
            defaultZoom: 2.0,
            minZoom: 1.5,
            maxZoom: 8.0
        });
        
        camera.setZoom(4.0);
        camera.adjustZoom(1.0);
        assertApprox(camera.zoom, 5.0, 0.01, 'Zoom should increase by delta');
        
        camera.adjustZoom(-2.0);
        assertApprox(camera.zoom, 3.0, 0.01, 'Zoom should decrease by delta');
    });
    
    logSection('Camera - Panning');
    
    await runTest('startPan initializes panning state', async () => {
        const camera = new Camera({
            gridSize: 512,
            defaultZoom: 2.0,
            minZoom: 1.5,
            maxZoom: 8.0
        });
        
        camera.startPan(100, 200);
        assert(camera.isPanning === true, 'Should be panning after startPan');
    });
    
    await runTest('endPan stops panning', async () => {
        const camera = new Camera({
            gridSize: 512,
            defaultZoom: 2.0,
            minZoom: 1.5,
            maxZoom: 8.0
        });
        
        camera.startPan(100, 200);
        camera.endPan();
        assert(camera.isPanning === false, 'Should not be panning after endPan');
    });
    
    logSection('Camera - Visible Size');
    
    await runTest('getVisibleGridSize returns correct size based on zoom', async () => {
        const camera = new Camera({
            gridSize: 512,
            defaultZoom: 2.0,
            minZoom: 1.5,
            maxZoom: 8.0
        });
        
        camera.setZoom(1.0);
        assertApprox(camera.getVisibleGridSize(), 512, 1, 'At zoom 1, visible size should be full grid');
        
        camera.setZoom(2.0);
        assertApprox(camera.getVisibleGridSize(), 256, 1, 'At zoom 2, visible size should be half grid');
        
        camera.setZoom(4.0);
        assertApprox(camera.getVisibleGridSize(), 128, 1, 'At zoom 4, visible size should be quarter grid');
    });
    
    logSection('Camera - Clamping');
    
    await runTest('clamp keeps camera within grid bounds', async () => {
        const camera = new Camera({
            gridSize: 512,
            defaultZoom: 2.0,
            minZoom: 1.5,
            maxZoom: 8.0
        });
        
        camera.setZoom(4.0); // Visible size = 128
        
        // Try to move camera out of bounds
        camera.x = -100;
        camera.y = 600;
        camera.clamp();
        
        // Camera should be clamped so visible area stays in grid
        const halfVisible = camera.getVisibleGridSize() / 2;
        assert(camera.x >= halfVisible, 'Camera x should be clamped to keep view in bounds');
        assert(camera.y <= 512 - halfVisible, 'Camera y should be clamped to keep view in bounds');
    });
    
    logSection('Camera - Coordinate Conversion');
    
    await runTest('screenToGrid converts screen coords to grid coords', async () => {
        const camera = new Camera({
            gridSize: 512,
            defaultZoom: 2.0,
            minZoom: 1.5,
            maxZoom: 8.0
        });
        
        // Mock canvas
        const mockCanvas = {
            getBoundingClientRect: () => ({
                left: 0,
                top: 0,
                width: 512,
                height: 512
            })
        };
        camera.setCanvas(mockCanvas);
        
        // At zoom 2 centered at (256, 256), screen center should map to grid center
        camera.x = 256;
        camera.y = 256;
        camera.setZoom(2.0);
        
        const gridPos = camera.screenToGrid(256, 256);
        assertApprox(gridPos.x, 256, 1, 'Screen center x should map to grid center');
        assertApprox(gridPos.y, 256, 1, 'Screen center y should map to grid center');
    });
    
    await runTest('gridToScreen converts grid coords to screen coords', async () => {
        const camera = new Camera({
            gridSize: 512,
            defaultZoom: 2.0,
            minZoom: 1.5,
            maxZoom: 8.0
        });
        
        // Mock canvas
        const mockCanvas = {
            getBoundingClientRect: () => ({
                left: 0,
                top: 0,
                width: 512,
                height: 512
            })
        };
        camera.setCanvas(mockCanvas);
        
        camera.x = 256;
        camera.y = 256;
        camera.setZoom(2.0);
        
        const screenPos = camera.gridToScreen(256, 256);
        assertApprox(screenPos.x, 256, 1, 'Grid center x should map to screen center');
        assertApprox(screenPos.y, 256, 1, 'Grid center y should map to screen center');
    });
    
    await runTest('screenToGrid and gridToScreen are inverse operations', async () => {
        const camera = new Camera({
            gridSize: 512,
            defaultZoom: 2.0,
            minZoom: 1.5,
            maxZoom: 8.0
        });
        
        const mockCanvas = {
            getBoundingClientRect: () => ({
                left: 0,
                top: 0,
                width: 512,
                height: 512
            })
        };
        camera.setCanvas(mockCanvas);
        
        camera.x = 300;
        camera.y = 200;
        camera.setZoom(3.0);
        
        // Test multiple points
        const testPoints = [
            [100, 100],
            [256, 256],
            [400, 300],
            [50, 450]
        ];
        
        for (const [sx, sy] of testPoints) {
            const gridPos = camera.screenToGrid(sx, sy);
            const screenPos = camera.gridToScreen(gridPos.x, gridPos.y);
            assertApprox(screenPos.x, sx, 1, `Round trip x for (${sx}, ${sy})`);
            assertApprox(screenPos.y, sy, 1, `Round trip y for (${sx}, ${sy})`);
        }
    });
}

