/**
 * Configurable Logger
 * 
 * Usage:
 *   import { Logger } from './utils/Logger.js';
 *   
 *   // Log with category
 *   Logger.log('sync', 'Received sync from Player 1');
 *   Logger.log('rollback', 'Rolling back to tick 1000');
 *   
 *   // Enable/disable categories via URL params or console:
 *   ?log=sync,rollback,action    (enable only these)
 *   ?log=all                     (enable all)
 *   ?log=none                    (disable all)
 *   
 *   // Or in console:
 *   Logger.enable('sync');
 *   Logger.disable('rollback');
 *   Logger.enableAll();
 *   Logger.disableAll();
 *   Logger.only('rollback');  // Disable all except rollback
 */

// Available log categories
const CATEGORIES = {
    sync: '🔄',        // Periodic sync, state sync
    rollback: '⏪',    // Rollback and replay operations
    action: '🎮',      // Player actions (place, select, command)
    network: '📡',     // Network messages
    speed: '⚡',       // TPS/speed sync
    checkpoint: '💾',  // Checkpoint save/restore
    audio: '🔊',       // Audio events
    input: '🖱️',       // Mouse/keyboard input
    render: '🎨',      // Rendering
    perf: '📊',        // Performance timing
};

// Parse URL params for initial config
const urlParams = new URLSearchParams(window.location.search);
const logParam = urlParams.get('log') || '';

// Initialize enabled categories
let enabledCategories = new Set();

if (logParam === 'all') {
    // Enable all
    Object.keys(CATEGORIES).forEach(cat => enabledCategories.add(cat));
} else if (logParam === 'none' || logParam === '') {
    // Default: enable important ones only
    enabledCategories.add('sync');
    enabledCategories.add('rollback');
    enabledCategories.add('action');
} else {
    // Enable specific categories
    logParam.split(',').forEach(cat => {
        const trimmed = cat.trim().toLowerCase();
        if (CATEGORIES[trimmed]) {
            enabledCategories.add(trimmed);
        }
    });
}

export const Logger = {
    /**
     * Log a message with a category
     * @param {string} category - One of the CATEGORIES keys
     * @param {...any} args - Arguments to log
     */
    log(category, ...args) {
        if (!enabledCategories.has(category)) return;
        const emoji = CATEGORIES[category] || '📝';
        console.log(`${emoji} [${category.toUpperCase()}]`, ...args);
    },

    /**
     * Log a warning with a category
     */
    warn(category, ...args) {
        if (!enabledCategories.has(category)) return;
        const emoji = CATEGORIES[category] || '⚠️';
        console.warn(`${emoji} [${category.toUpperCase()}]`, ...args);
    },

    /**
     * Log an error (always shown regardless of category)
     */
    error(category, ...args) {
        const emoji = CATEGORIES[category] || '❌';
        console.error(`${emoji} [${category.toUpperCase()}]`, ...args);
    },

    /**
     * Enable a category
     */
    enable(category) {
        if (CATEGORIES[category]) {
            enabledCategories.add(category);
            console.log(`Logger: Enabled '${category}'`);
        } else {
            console.warn(`Logger: Unknown category '${category}'. Available: ${Object.keys(CATEGORIES).join(', ')}`);
        }
    },

    /**
     * Disable a category
     */
    disable(category) {
        enabledCategories.delete(category);
        console.log(`Logger: Disabled '${category}'`);
    },

    /**
     * Enable all categories
     */
    enableAll() {
        Object.keys(CATEGORIES).forEach(cat => enabledCategories.add(cat));
        console.log('Logger: Enabled all categories');
    },

    /**
     * Disable all categories
     */
    disableAll() {
        enabledCategories.clear();
        console.log('Logger: Disabled all categories');
    },

    /**
     * Enable only specific categories (disable all others)
     */
    only(...categories) {
        enabledCategories.clear();
        categories.forEach(cat => {
            if (CATEGORIES[cat]) {
                enabledCategories.add(cat);
            }
        });
        console.log(`Logger: Enabled only: ${categories.join(', ')}`);
    },

    /**
     * Check if a category is enabled
     */
    isEnabled(category) {
        return enabledCategories.has(category);
    },

    /**
     * Get list of all available categories
     */
    getCategories() {
        return Object.keys(CATEGORIES);
    },

    /**
     * Get list of enabled categories
     */
    getEnabled() {
        return Array.from(enabledCategories);
    },

    /**
     * Print current status
     */
    status() {
        console.log('Logger Status:');
        console.log('  Available categories:', Object.keys(CATEGORIES).join(', '));
        console.log('  Enabled:', Array.from(enabledCategories).join(', ') || '(none)');
        console.log('  URL param: ?log=category1,category2 or ?log=all or ?log=none');
    }
};

// Make Logger available globally for console debugging
window.Logger = Logger;

// Log initial status
console.log(`Logger initialized. Enabled: [${Array.from(enabledCategories).join(', ')}]. Use ?log=all to see all, or Logger.status() for help.`);

