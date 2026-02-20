
/**
 * @file etcs.js
 * @brief Defines ETCSManager class to manage the lifecycle of ETCS messages, including construction, validation,
 *        throttling, and response logic based on message types and protocol state.
 *
 * Responsibilities:
 * - Maintain and build ETCS message templates.
 * - Enforce message sequencing and delivery rate limits.
 * - Handle state transitions through `StateManager`.
 * - Generate and send responses for messages like Msg 32, 38, 8, 41, 146, etc.
 * - Facilitate message decoding/encoding via templates and counters.
 */
import { MESSAGE_CONFIG } from './config.js';
import { StateManager } from './state_manager.js';
import { ETCS_STATES } from './etcs_states.js';

/**
 * @class ETCSManager
 * @description Manages ETCS message lifecycle, templates, sequencing, and validation.
 */
export class ETCSManager {
  constructor(messages) {
    /** @property {Object} templates - Loaded ETCS message templates */
    this.templates = messages || {};

    /** @property {StateManager} stateManager - Handles ETCS state transitions */
    this.stateManager = new StateManager();

    /** @property {number} sequenceCounter - Increments per message */
    this.sequenceCounter = 0;

    /** @property {Array} messageQueue - Buffered outgoing messages */
    this.messageQueue = [];

    /** @property {boolean} isSending - Message queue lock */
    this.isSending = false;

    /** @property {number} lastSentTime - Timestamp of last message sent */
    this.lastSentTime = 0;

    /** @property {Set} processedMessages - Avoid reprocessing duplicate SEQUENCEs */
    this.processedMessages = new Set();

    /** @property {boolean} sessionEstablished - Tracks session state */
    this.sessionEstablished = false;
  }

  /** 
   * @private
   * @function #processQueue
   * @description Internal queue processor with throttling.
   */
  #processQueue(mqttClient) {
    if (this.isSending || this.messageQueue.length === 0) return;

    this.isSending = true;
    const { topic, message, callback } = this.messageQueue.shift();

    if (this.processedMessages.has(message.SEQUENCE)) {
      this.isSending = false;
      this.#processQueue(mqttClient);
      return;
    }

    if (!this.stateManager.validateMessage(message.NID_MESSAGE)) {
      console.warn(`Message ${message.NID_MESSAGE} not allowed in current state`);
      this.isSending = false;
      return;
    }

    this.processedMessages.add(message.SEQUENCE);
    this.lastSentTime = Date.now();

    mqttClient.publish(topic, JSON.stringify(message), { qos: 2 }, (err) => {

      if (typeof callback === 'function') callback(err);

      setTimeout(() => {
        this.isSending = false;
        this.#processQueue(mqttClient);
      }, MESSAGE_CONFIG.MIN_MESSAGE_INTERVAL);
    });
  }

  /**
   * @private
   * @function #sendThrottled
   * @description Wraps queueing logic if enabled, otherwise publishes directly.
   */
  #sendThrottled(topic, message, mqttClient, callback) {
    if (!MESSAGE_CONFIG.ENABLED) {
      return mqttClient.publish(topic, JSON.stringify(message), { qos: 2 }, callback);

    }

    this.messageQueue.push({ topic, message, callback });
    this.#processQueue(mqttClient);
  }

  /**
   * @function buildFromTemplate
   * @param {string} name - Message template key
   * @param {Object} overrides - Custom fields to override
   * @returns {Object|null} constructed message
   */
buildFromTemplate(name, overrides = {}) {
  if (!this.templates[name]) {
    console.error(`Template ${name} not found`);
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const sequence = this.sequenceCounter++;

  const merged = {
    ...this.templates[name].values,
    ...overrides
  };

  if (!('T_TRAIN' in merged)) merged.T_TRAIN = now;
  if (!('T_TRAIN_ack' in merged)) merged.T_TRAIN_ack = now;
  if (!('SEQUENCE' in merged)) merged.SEQUENCE = sequence;
  if (!('origin' in merged)) merged.origin = 'system';

  return merged;
}



  /**
   * @function getTemplate
   * @param {string} name - Template key
   * @returns {Object|null} Raw template values
   */
  getTemplate(name) {
    return this.templates[name]?.values || null;
  }

  /**
   * @function handleETCSMessage
   * @description Delegates ETCS message handling based on NID_MESSAGE
   */
  handleETCSMessage(msg, rbcId, mqttClient) {
    try {
      if (!msg.NID_MESSAGE || !msg.origin) return;
      if (msg.origin === "rbc" || msg.origin === "obu") return;

      if (!this.stateManager.validateMessage(msg.NID_MESSAGE)) {
        console.warn(`Message ${msg.NID_MESSAGE} invalid in current state`);
        return;
      }

      switch (msg.NID_MESSAGE) {
        case 3: // MA received
          this.stateManager.transition("M3_RECEIVED");
           return;
        case 32:
          this.stateManager.transition('M32_RECEIVED');
          return this.handleSystemVersion(msg, rbcId, mqttClient);
        case 38:
          this.stateManager.transition('M38_RECEIVED');
          return this.handleSessionAck(msg, rbcId, mqttClient);
        case 8:
          this.stateManager.transition('M8_RECEIVED');
          return this.handleSessionAck(msg, rbcId, mqttClient);
        case 41:
          this.stateManager.transition('M41_RECEIVED');
          return this.handleTrainAccepted(rbcId, mqttClient);
        case 146:
          return this.handleGenericAck(msg);
        case 155:
          return this.handlePositionReport(rbcId, mqttClient);

        case 129:
  console.log("Received Message 129 (MA)");
  if (msg.packet15) {
    console.log("📦 Packet 15 received:\n", JSON.stringify(msg.packet15, null, 2));
  } else {
    console.warn("⚠️ Message 129 has no Packet 15");
  }
  break;
        default:
          console.log("Unhandled message type:", msg.NID_MESSAGE);
      }
    } catch (err) {
      console.error("Message processing failed:", err);
      console.error("Failed message content:", msg);
    }
  }

  handleSystemVersion(msg, rbcId, mqttClient) {
    try {
      if (this.stateManager.getCurrentState().id !== ETCS_STATES.VERSION_EXCHANGED.id) {
        console.warn("M32 received in wrong state");
        return;
      }

      const expected = this.getTemplate("packet2")?.M_VERSION;
      if (expected === undefined) throw new Error("Missing M_VERSION in packet2 template");

      const isMatch = msg.M_VERSION === expected;
      const responseType = isMatch ? "message146" : "message154";

      if (!this.templates[responseType]) {
        throw new Error(`Missing template for ${responseType}`);
      }

      const response = this.buildFromTemplate(responseType, {
        origin: "obu",
        NID_MESSAGE_REF: msg.NID_MESSAGE
      });

      this.#sendThrottled(`rbc/${rbcId}/in`, response, mqttClient);

      if (isMatch && !this.sessionEstablished) {
        const msg159 = this.buildFromTemplate("message159", { origin: "obu" });
        this.#sendThrottled(`rbc/${rbcId}/in`, msg159, mqttClient);
        this.sessionEstablished = true;
      }

      const msg129 = this.buildFromTemplate("message129", { origin: "obu" });
      this.#sendThrottled(`rbc/${rbcId}/in`, msg129, mqttClient);

      if (isMatch) this.stateManager.transition('M32_ACKED');

    } catch (err) {
      console.error("System Version handling failed:", err);
    }
  }

  handlePositionReport(rbcId, mqttClient) {
    if (this.stateManager.getCurrentState().id < 3) return;

    const m32 = this.buildFromTemplate("message32", {
      M_VERSION: this.getTemplate("packet2")?.M_VERSION || 1,
      origin: "rbc"
    });
    this.#sendThrottled(`rbc/${rbcId}/out`, m32, mqttClient);
  }

  handleSessionAck(msg, rbcId, mqttClient) {
    if (this.stateManager.getCurrentState().id < ETCS_STATES.HANDSHAKE_INITIATED.id) return;

    const ack = this.buildFromTemplate("message146", {
      origin: "obu",
      NID_MESSAGE_REF: msg.NID_MESSAGE
    });

    this.#sendThrottled(`rbc/${rbcId}/in`, ack, mqttClient);

    if (msg.NID_MESSAGE === 8 && !this.somSent) {
      const msg157 = this.buildFromTemplate("message157", {
  origin: "obu",
  Q_STATUSLRBG: 1,
  packet0: {
    Q_SCALE: 1,
    NID_LRBG: 16777214,
    D_LRBG: 0,
    Q_DIRLRBG: 1,
    Q_DLRBG: 0,
    L_DOUBTOVER: 50,
    L_DOUBTUNDER: 50,
    Q_INTEGRITY: 1,
    L_TRAININT: 1000,
    V_TRAIN: 30,
    Q_DIRTRAIN: 1,
    M_MODE: 3,
    M_LEVEL: 2,
    NID_NTC: 0
  }
});
;
      console.log("📤 Preparing to send Msg 157 (Train Acceptance)");

      this.#sendThrottled(`rbc/${rbcId}/in`, msg157, mqttClient);
      this.somSent = true;
      console.log("🔄 Current State After Msg 8 Ack:", this.stateManager.getCurrentState().name);

    }
  }

  handleTrainAccepted(rbcId, mqttClient) {
    if (this.stateManager.getCurrentState().id < ETCS_STATES.SESSION_ESTABLISHED.id) return;

    const ack146 = this.buildFromTemplate("message146", {
      origin: "obu",
      NID_MESSAGE_REF: 41
    });

    this.#sendThrottled(`rbc/${rbcId}/in`, ack146, mqttClient);
    this.stateManager.transition('M41_ACKED');
  }

  handleTrainDataAck(rbcId, mqttClient) {
    if (this.stateManager.getCurrentState().id < 3) return;

    const m8 = this.buildFromTemplate("message8", {
      origin: "rbc",
      SEQUENCE: this.sequenceCounter++
    });
    this.#sendThrottled(`rbc/${rbcId}/out`, m8, mqttClient);
  }

  handleGenericAck(msg) {
    console.log(`Received Ack for message 136`);
    /*
    switch (msg.NID_MESSAGE_REF) {
      case 38:
        this.stateManager.transition('M38_ACKED');
        break;
      case 8:
        this.stateManager.transition('M8_ACKED');
        break;
    }*/
   this.stateManager.transition('POSITION_UPDATE');

  }

  /**
   * @function resetSession
   * @description Clears session, counters, state.
   */
  resetSession() {
    this.stateManager.reset();
    this.processedMessages.clear();
    this.messageQueue = [];
    this.sequenceCounter = 0;
    this.sessionEstablished = false;
  }
}
