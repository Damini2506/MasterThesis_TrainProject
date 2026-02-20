/**
 * @file mqtt.js
 * @brief Defines the MQTTManager class to abstract MQTT.js functionality in the ETCS system.
 *
 * This class wraps common MQTT client operations including connection setup, publishing, subscribing,
 * and lifecycle management. It simplifies MQTT usage in both OBU and RBC contexts with clean,
 * chainable method interfaces.
 */


/**
 * @brief MQTTManager class abstracts MQTT operations for connecting, subscribing, publishing, etc.
 */
export class MQTTManager {
  /**
   * @brief Create an MQTT client instance with automatic reconnection.
   * @param {string} brokerUrl - MQTT WebSocket endpoint.
   * @param {string} clientIdPrefix - Prefix for unique client ID.
   * @variable client - Internal MQTT.js client instance.
   */
  constructor(brokerUrl, clientIdPrefix, options = {})  {
this.client = mqtt.connect(brokerUrl, {
  clientId: `${clientIdPrefix}-${Math.random().toString(16).slice(2)}`,
  username: options?.username,
  password: options?.password,
  clean: true,
  connectTimeout: 4000,
  reconnectPeriod: 5000
});

  }

  /**
   * @brief Attach an MQTT client event listener
   * @param {string} event - MQTT event (e.g. "connect", "message", "error")
   * @param {function} callback - Callback to execute on event
   * @returns {MQTTManager} this
   */
  on(event, callback) {
    this.client.on(event, callback);
    return this; // Enables chaining
  }

  /**
   * @brief Subscribe to a single or multiple topics
   * @param {string|string[]} topic - Topic(s) to subscribe to
   * @param {Object} options - Subscription options (e.g. qos)
   * @param {function} callback - Optional callback
   * @returns {MQTTManager} this
   */
  subscribe(topic, options, callback) {
    if (Array.isArray(topic)) {
      this.client.subscribe(topic, options || {}, callback);
    } else {
      this.client.subscribe(topic, options, callback);
    }
    return this;
  }

  /**
   * @brief Publish a message to a topic
   * @param {string} topic - MQTT topic to publish to
   * @param {string|Object} message - JSON object or string to send
   * @param {Object} options - Publish options (default: { qos: 2 })
   * @param {function} callback - Optional callback after publishing
   * @returns {MQTTManager} this
   */
  publish(topic, message, options = { qos: 2 }, callback) {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    this.client.publish(topic, payload, options, callback);
    return this;
  }

  /**
   * @brief Unsubscribe from a topic
   * @param {string|string[]} topic - Topic or topics to unsubscribe from
   * @param {function} callback - Optional callback after unsubscribing
   * @returns {MQTTManager} this
   */
  unsubscribe(topic, callback) {
    this.client.unsubscribe(topic, callback);
    return this;
  }

  /**
   * @brief Gracefully disconnect from broker
   * @param {boolean} force - If true, force disconnect
   */
  end(force = false) {
    this.client.end(force);
  }

  /**
   * @brief Check if the client is currently connected
   * @returns {boolean}
   */
  get connected() {
    return this.client.connected;
  }
}
