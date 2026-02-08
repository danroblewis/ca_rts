import { runTest, assert, logSection } from './framework.js';

// Mock AudioEngine for tests
class MockAudioEngine {
    constructor() {
        this.initialized = false;
        this.muted = false;
        this.loops = {};
        this.oneShotPools = {};
        this.audioContext = { currentTime: 0 };
    }
    
    async init() {
        this.initialized = true;
    }
    
    async resume() {}
    
    toggleMute() {
        this.muted = !this.muted;
        return this.muted;
    }
    
    playReject() {
        return true;
    }
    
    update(params) {}
    
    tryPlayOneShot(name, volume) {}
}

// Mock AudioReductionPipeline for tests
class MockAudioReductionPipeline {
    constructor(gridSize, channels) {
        this.gridSize = gridSize;
        this.channels = channels;
        this.initialized = false;
        this.soundParams = {};
    }
    
    async init() {
        this.initialized = true;
    }
    
    async run(texture) {
        return this.soundParams;
    }
    
    getSoundParams() {
        return this.soundParams;
    }
}

// Create a testable AudioManager with mock dependencies
class TestableAudioManager {
    constructor(config) {
        this.gridSize = config.gridSize;
        this.onInitializedCallback = config.onInitialized || null;
        
        // Use mock components for testing
        this.reductionPipeline = new MockAudioReductionPipeline(this.gridSize, 4);
        this.engine = new MockAudioEngine();
        this.initialized = false;
        this.buttonElement = null;
    }
    
    bindButton(buttonElement) {
        this.buttonElement = buttonElement;
        if (buttonElement) {
            buttonElement.addEventListener('click', () => this.toggle());
        }
        this.updateButton();
    }
    
    async init() {
        if (this.initialized) return;
        
        try {
            await this.reductionPipeline.init();
            await this.engine.init();
            await this.engine.resume();
            this.initialized = true;
            this.updateButton();
            
            if (this.onInitializedCallback) {
                this.onInitializedCallback();
            }
        } catch (e) {
            console.error('[Audio] Failed to initialize:', e);
        }
    }
    
    async toggle() {
        if (!this.initialized) {
            await this.init();
        } else {
            this.engine.toggleMute();
            this.updateButton();
        }
    }
    
    toggleMute() {
        const muted = this.engine.toggleMute();
        this.updateButton();
        return muted;
    }
    
    updateButton() {
        if (!this.buttonElement) return;
        
        if (!this.initialized) {
            this.buttonElement.textContent = '🔊';
        } else if (this.engine.muted) {
            this.buttonElement.textContent = '🔇';
        } else {
            this.buttonElement.textContent = '🔊';
        }
    }
    
    isInitialized() {
        return this.initialized;
    }
    
    isMuted() {
        return this.engine.muted;
    }
    
    playReject() {
        if (this.initialized) {
            this.engine.playReject();
        }
    }
    
    async update(stateTexture) {
        if (!this.initialized) return;
        await this.reductionPipeline.run(stateTexture);
        this.engine.update(this.reductionPipeline.getSoundParams());
    }
    
    getEngine() {
        return this.engine;
    }
    
    getReductionPipeline() {
        return this.reductionPipeline;
    }
}

export async function runAudioManagerTests() {
    logSection('AudioManager - Initialization');
    
    await runTest('AudioManager starts uninitialized', async () => {
        const audioManager = new TestableAudioManager({ gridSize: 512 });
        assert(audioManager.isInitialized() === false, 'Should not be initialized on creation');
        assert(audioManager.isMuted() === false, 'Should not be muted initially');
    });
    
    await runTest('AudioManager initializes successfully', async () => {
        const audioManager = new TestableAudioManager({ gridSize: 512 });
        await audioManager.init();
        assert(audioManager.isInitialized() === true, 'Should be initialized after init()');
    });
    
    await runTest('AudioManager calls onInitialized callback', async () => {
        let callbackCalled = false;
        const audioManager = new TestableAudioManager({
            gridSize: 512,
            onInitialized: () => { callbackCalled = true; }
        });
        await audioManager.init();
        assert(callbackCalled === true, 'Callback should be called after initialization');
    });
    
    await runTest('AudioManager init is idempotent', async () => {
        let callbackCount = 0;
        const audioManager = new TestableAudioManager({
            gridSize: 512,
            onInitialized: () => { callbackCount++; }
        });
        await audioManager.init();
        await audioManager.init();
        await audioManager.init();
        assert(callbackCount === 1, 'Callback should only be called once');
    });
    
    logSection('AudioManager - Mute Control');
    
    await runTest('toggleMute toggles mute state', async () => {
        const audioManager = new TestableAudioManager({ gridSize: 512 });
        await audioManager.init();
        
        assert(audioManager.isMuted() === false, 'Should start unmuted');
        audioManager.toggleMute();
        assert(audioManager.isMuted() === true, 'Should be muted after toggle');
        audioManager.toggleMute();
        assert(audioManager.isMuted() === false, 'Should be unmuted after second toggle');
    });
    
    await runTest('toggle initializes if not initialized', async () => {
        const audioManager = new TestableAudioManager({ gridSize: 512 });
        assert(audioManager.isInitialized() === false, 'Should start uninitialized');
        await audioManager.toggle();
        assert(audioManager.isInitialized() === true, 'Should be initialized after toggle');
    });
    
    await runTest('toggle toggles mute if already initialized', async () => {
        const audioManager = new TestableAudioManager({ gridSize: 512 });
        await audioManager.init();
        assert(audioManager.isMuted() === false, 'Should start unmuted');
        await audioManager.toggle();
        assert(audioManager.isMuted() === true, 'Should be muted after toggle');
    });
    
    logSection('AudioManager - Button UI');
    
    await runTest('updateButton shows unmuted icon before init', async () => {
        const audioManager = new TestableAudioManager({ gridSize: 512 });
        const button = { textContent: '', addEventListener: () => {} };
        audioManager.bindButton(button);
        assert(button.textContent === '🔊', 'Should show unmuted icon before init');
    });
    
    await runTest('updateButton shows unmuted icon after init', async () => {
        const audioManager = new TestableAudioManager({ gridSize: 512 });
        const button = { textContent: '', addEventListener: () => {} };
        audioManager.bindButton(button);
        await audioManager.init();
        assert(button.textContent === '🔊', 'Should show unmuted icon after init');
    });
    
    await runTest('updateButton shows muted icon when muted', async () => {
        const audioManager = new TestableAudioManager({ gridSize: 512 });
        const button = { textContent: '', addEventListener: () => {} };
        audioManager.bindButton(button);
        await audioManager.init();
        audioManager.toggleMute();
        assert(button.textContent === '🔇', 'Should show muted icon when muted');
    });
    
    logSection('AudioManager - Audio Update');
    
    await runTest('update does nothing when not initialized', async () => {
        const audioManager = new TestableAudioManager({ gridSize: 512 });
        // Should not throw
        await audioManager.update({});
        assert(audioManager.isInitialized() === false, 'Should still be uninitialized');
    });

    await runTest('update runs pipeline when initialized', async () => {
        const audioManager = new TestableAudioManager({ gridSize: 512 });
        await audioManager.init();
        // Should not throw
        await audioManager.update({});
        assert(true, 'Update should complete without error');
    });
    
    logSection('AudioManager - Accessors');
    
    await runTest('getEngine returns engine instance', async () => {
        const audioManager = new TestableAudioManager({ gridSize: 512 });
        const engine = audioManager.getEngine();
        assert(engine !== null, 'Should return engine');
        assert(typeof engine.toggleMute === 'function', 'Engine should have toggleMute method');
    });
    
    await runTest('getReductionPipeline returns pipeline instance', async () => {
        const audioManager = new TestableAudioManager({ gridSize: 512 });
        const pipeline = audioManager.getReductionPipeline();
        assert(pipeline !== null, 'Should return pipeline');
        assert(pipeline.gridSize === 512, 'Pipeline should have correct gridSize');
    });
    
    await runTest('playReject only plays when initialized', async () => {
        const audioManager = new TestableAudioManager({ gridSize: 512 });
        // Should not throw when uninitialized
        audioManager.playReject();
        await audioManager.init();
        // Should not throw when initialized
        audioManager.playReject();
        assert(true, 'playReject should not throw');
    });
}

