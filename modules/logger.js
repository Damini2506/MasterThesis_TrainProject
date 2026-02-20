/**
 * @file logger.js
 * @brief Defines the Logger class for structured message logging and UI status updates within the ETCS system.
 *
 * The Logger class appends timestamped messages to a specified DOM element. It supports different log levels
 * (info, error, debug), maintains a counter, and provides helpers for updating UI indicators related to session
 * state and connectivity (GSM-R, RBC).
 */


export class Logger {
  constructor(logElement) {
    this.logElement = logElement;
    this.messageCount = 0;
  }

  log(txt, type = "log") {
    const now = new Date();
    const timestamp = `[${now.toISOString().substring(11, 23)}]`;
    const count = `[${++this.messageCount}]`.padStart(6, ' ');

    const div = document.createElement("div");
    div.className = `msg ${type}`;
    div.textContent = `${count} ${timestamp} ${txt}`;

    this.logElement.appendChild(div);
    this.logElement.scrollTop = this.logElement.scrollHeight;
  }

  error(message) {
    this.log(message, "error");
  }

  info(message) {
    this.log(message, "info");
  }

  debug(message) {
    this.log(message, "debug");
  }

  clear() {
    this.logElement.innerHTML = '';
    this.messageCount = 0;
  }

  /**
   * @brief Update session and message counters
   * @param {object} etcsManager - ETCS manager with state machine
   * @param {HTMLElement} sessionEl - DOM element for session state
   * @param {HTMLElement} msgCountEl - DOM element for message count
   */
  updateStatus(etcsManager, sessionEl, msgCountEl) {
    if (!etcsManager?.stateManager) return;
    sessionEl.textContent = etcsManager.stateManager.getCurrentState()?.name || "DISCONNECTED";
    msgCountEl.textContent = this.messageCount;
  }

  /**
   * @brief Set GSM-R broker connection UI status
   * @param {string} state - "connected" | "connecting" | "disconnected"
   * @param {HTMLElement} circleEl - DOM indicator element
   * @param {HTMLElement} textEl - DOM text element
   */
  setBrokerStatus(state, circleEl, textEl) {
    if (!circleEl || !textEl) return;
    const colorMap = { connected: "limegreen", connecting: "orange", disconnected: "red" };
    const textMap = {
      connected: "Connected to GSM-R",
      connecting: "Connecting...",
      disconnected: "Not connected"
    };
    circleEl.style.backgroundColor = colorMap[state] || "red";
    textEl.textContent = textMap[state] || "Not connected";
  }

  /**
   * @brief Set RBC connection UI status
   * @param {string} state - "connected" | "disconnected"
   * @param {HTMLElement} circleEl - DOM indicator element
   * @param {HTMLElement} textEl - DOM text element
   */
  setRBCStatus(state, circleEl, textEl) {
    if (!circleEl || !textEl) return;
    circleEl.style.backgroundColor = state === "connected" ? "limegreen" : "red";
    textEl.textContent = state === "connected" ? "Connected to RBC" : "Not connected to RBC";
  }
}
