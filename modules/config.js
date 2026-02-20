/**
 * @file config.js
 * @brief Contains global message rate-limiting configuration for ETCS message throttling.
 *
 * This module defines constants that control how frequently messages can be sent over MQTT
 * to prevent flooding or race conditions.
 */


export const MESSAGE_CONFIG = {
    MIN_MESSAGE_INTERVAL: 100, // Minimum 500ms between messages
    MAX_MESSAGES_PER_SECOND: 5, // Max 5 messages/sec
    THROTTLE_ENABLED: true // Toggle rate limiting
};