/**
 * ClearConnect Shared Utilities
 */

const Logger = {
    DEBUG: false, // Set to true for development/debugging

    log: (...args) => {
        if (Logger.DEBUG) {
            console.log('[ClearConnect DEBUG]:', ...args);
        }
    },

    error: (...args) => {
        // Always log errors, but maybe with a prefix
        console.error('[ClearConnect ERROR]:', ...args);
    },

    warn: (...args) => {
        if (Logger.DEBUG) {
            console.warn('[ClearConnect WARN]:', ...args);
        }
    },

    info: (...args) => {
        if (Logger.DEBUG) {
            console.info('[ClearConnect INFO]:', ...args);
        }
    }
};

// Expose to window if likely running in a non-module environment (Chrome Ext)
if (typeof window !== 'undefined') {
    window.Logger = Logger;
}
