import { runTest, assert, logSection } from './framework.js';
import { SpeedToggle } from '../ui/SpeedToggle.js';

export async function runSpeedToggleTests() {
    logSection('SpeedToggle - Initialization');

    await runTest('SpeedToggle initializes with default sync mode true', async () => {
        const toggle = new SpeedToggle({
            defaultSyncMode: true,
            isOnLocalhost: true,
            onSpeedChange: () => {},
            onFastModeStart: () => {}
        });
        
        assert(toggle.syncWithRender === true, 'syncWithRender should be true');
        assert(toggle.isSyncMode() === true, 'isSyncMode() should return true');
    });

    await runTest('SpeedToggle initializes with default sync mode false', async () => {
        const toggle = new SpeedToggle({
            defaultSyncMode: false,
            isOnLocalhost: true,
            onSpeedChange: () => {},
            onFastModeStart: () => {}
        });
        
        assert(toggle.syncWithRender === false, 'syncWithRender should be false');
        assert(toggle.isSyncMode() === false, 'isSyncMode() should return false');
    });

    await runTest('SpeedToggle stores callbacks', async () => {
        let speedChanged = false;
        let fastStarted = false;
        
        const toggle = new SpeedToggle({
            defaultSyncMode: true,
            isOnLocalhost: true,
            onSpeedChange: () => { speedChanged = true; },
            onFastModeStart: () => { fastStarted = true; }
        });
        
        toggle.setSuperSpeed(true);
        assert(speedChanged === true, 'onSpeedChange should be called');
        assert(fastStarted === true, 'onFastModeStart should be called when switching to fast');
    });

    logSection('SpeedToggle - Speed Control');

    await runTest('setSuperSpeed enables fast mode', async () => {
        let syncState = true;
        
        const toggle = new SpeedToggle({
            defaultSyncMode: true,
            isOnLocalhost: true,
            onSpeedChange: (sync) => { syncState = sync; },
            onFastModeStart: () => {}
        });
        
        toggle.setSuperSpeed(true);
        assert(toggle.syncWithRender === false, 'syncWithRender should be false');
        assert(syncState === false, 'callback should receive false');
    });

    await runTest('setSuperSpeed disables fast mode', async () => {
        let syncState = false;
        
        const toggle = new SpeedToggle({
            defaultSyncMode: false,
            isOnLocalhost: true,
            onSpeedChange: (sync) => { syncState = sync; },
            onFastModeStart: () => {}
        });
        
        toggle.setSuperSpeed(false);
        assert(toggle.syncWithRender === true, 'syncWithRender should be true');
        assert(syncState === true, 'callback should receive true');
    });

    await runTest('setSuperSpeed only calls onFastModeStart when newly enabling fast', async () => {
        let fastStartCount = 0;
        
        const toggle = new SpeedToggle({
            defaultSyncMode: false, // Already in fast mode
            isOnLocalhost: true,
            onSpeedChange: () => {},
            onFastModeStart: () => { fastStartCount++; }
        });
        
        toggle.setSuperSpeed(true); // Already fast, should not trigger
        assert(fastStartCount === 0, 'onFastModeStart should not be called when already fast');
        
        toggle.setSuperSpeed(false); // Switch to sync
        toggle.setSuperSpeed(true); // Now switch back to fast
        assert(fastStartCount === 1, 'onFastModeStart should be called once');
    });

    await runTest('toggle switches between modes', async () => {
        const toggle = new SpeedToggle({
            defaultSyncMode: true,
            isOnLocalhost: true,
            onSpeedChange: () => {},
            onFastModeStart: () => {}
        });
        
        assert(toggle.isSyncMode() === true, 'should start in sync mode');
        
        toggle.toggle();
        assert(toggle.isSyncMode() === false, 'should be in fast mode after toggle');
        
        toggle.toggle();
        assert(toggle.isSyncMode() === true, 'should be back in sync mode after second toggle');
    });

    logSection('SpeedToggle - Force Sync');

    await runTest('forceSyncMode switches to sync when in fast mode', async () => {
        let syncState = false;
        
        const toggle = new SpeedToggle({
            defaultSyncMode: false, // Start in fast mode
            isOnLocalhost: true,
            onSpeedChange: (sync) => { syncState = sync; },
            onFastModeStart: () => {}
        });
        
        toggle.forceSyncMode();
        assert(toggle.syncWithRender === true, 'syncWithRender should be true');
        assert(syncState === true, 'callback should receive true');
    });

    await runTest('forceSyncMode does nothing when already in sync mode', async () => {
        let callCount = 0;
        
        const toggle = new SpeedToggle({
            defaultSyncMode: true, // Already in sync mode
            isOnLocalhost: true,
            onSpeedChange: () => { callCount++; },
            onFastModeStart: () => {}
        });
        
        toggle.forceSyncMode();
        assert(callCount === 0, 'callback should not be called when already synced');
    });

    logSection('SpeedToggle - Accessors');

    await runTest('getSyncWithRender returns current state', async () => {
        const toggle = new SpeedToggle({
            defaultSyncMode: true,
            isOnLocalhost: true,
            onSpeedChange: () => {},
            onFastModeStart: () => {}
        });
        
        assert(toggle.getSyncWithRender() === true, 'should return true');
        
        toggle.setSuperSpeed(true);
        assert(toggle.getSyncWithRender() === false, 'should return false after enabling super speed');
    });

    await runTest('isSyncMode returns correct boolean', async () => {
        const toggle = new SpeedToggle({
            defaultSyncMode: true,
            isOnLocalhost: true,
            onSpeedChange: () => {},
            onFastModeStart: () => {}
        });
        
        assert(toggle.isSyncMode() === true, 'should be true initially');
        toggle.setSuperSpeed(true);
        assert(toggle.isSyncMode() === false, 'should be false after enabling super speed');
    });

    logSection('SpeedToggle - Show/Hide');

    await runTest('show and hide do not throw without DOM', async () => {
        const toggle = new SpeedToggle({
            defaultSyncMode: true,
            isOnLocalhost: true,
            onSpeedChange: () => {},
            onFastModeStart: () => {}
        });
        
        // Should not throw even without DOM elements
        toggle.show();
        toggle.hide();
        assert(true, 'show/hide should complete without error');
    });

    await runTest('isOnLocalhost false does not throw', async () => {
        // Should not throw even when containerElement doesn't exist
        const toggle = new SpeedToggle({
            defaultSyncMode: true,
            isOnLocalhost: false,
            onSpeedChange: () => {},
            onFastModeStart: () => {}
        });
        
        assert(toggle.isOnLocalhost === false, 'isOnLocalhost should be false');
    });
}

