import { ETCS_STATES } from './etcs_states.js';
import { HandshakeManager } from './handshake.js';
import { generatePacket15ForRoute } from './dynamic_ui.js';
import { makeJsonlLogger } from './json_logger.js';

const kpiLog = makeJsonlLogger({ nodeName: "RBC_DE0001", dir: "./logs" });

console.log("KPI LOG:", kpiLog.file);
window.kpiLog = kpiLog;
// ---- KPI guard: first position report per sensor ----
const firstPosReportSeen = new Set();



let maRequestReceived = false;
/**
 * @file etcs_rbc.js
 * @brief Handles incoming ETCS messages and manages RBC state transitions and responses.
 *        Integrates with dynamic_ui to generate and send Movement Authorities (Packet 15).
 */

export function createRBCHandlers(etcsManager, mqttClient, mqttAi, logger, topics, updateStatus, topology) {

  // ============================================================
  // ✅ Logger wrappers (avoid "logger.warn is not a function")
  // (NO logger.warn usage anywhere)
  // ============================================================
  const logInfo  = (...a) => (logger?.info  ? logger.info(...a)  : console.log(...a));
  const logDebug = (...a) => (logger?.debug ? logger.debug(...a) : console.log(...a));
  const logError = (...a) => (logger?.error ? logger.error(...a) : console.error(...a));
  const logLog   = (...a) => (logger?.log   ? logger.log(...a)   : console.log(...a));

  // ---- RBC-side RTT storage: when we send message ref, store its t_send_ms ----
  const rbcSentTs = new Map(); // key: ref (Number) -> t_send_ms (Number)


  // ============================================================
  // ✅ De-dup cache (avoid double-processing repeated inbound msgs)
  // ============================================================
  const seen = new Map(); // key -> lastSeenMs
  const SEEN_TTL_MS = 5000;

  function dedupeKey(msg) {
    if (!msg || typeof msg !== "object") return null;
    if (msg.msg_id) return `id:${msg.msg_id}`;
    if (msg.NID_MESSAGE !== undefined && msg.SEQUENCE !== undefined) return `nidseq:${msg.NID_MESSAGE}:${msg.SEQUENCE}`;
    if (msg.NID_MESSAGE !== undefined) return `nid:${msg.NID_MESSAGE}`;
    return null;
  }

  function isDuplicate(msg) {
    const k = dedupeKey(msg);
    if (!k) return false;

    const t = Date.now();

    // cleanup old entries
    for (const [key, ts] of seen.entries()) {
      if (t - ts > SEEN_TTL_MS) seen.delete(key);
    }

    const prev = seen.get(k);
    if (prev && (t - prev) < SEEN_TTL_MS) return true;

    seen.set(k, t);
    return false;
  }

  // ============================================================
  // ✅ Session setup KPI timestamps
  // Session setup time (AU1 recv @RBC → M38 sent @RBC)
  // ============================================================
  let t_au1_recv_ms = null;

  // ============================================================
  // ✅ Stamp + publish (ALL outbound goes via this)
  // ============================================================
  function stampAndPublish(topic, msgObj, qos = 2, cb) {
    // If already string/bytes, publish as-is (no stamps possible)
    if (!msgObj || typeof msgObj !== "object") {
      return mqttClient.publish(topic, msgObj, { qos }, cb);
    }

    const now = Date.now();
    msgObj.t_app_ms  = now; // handler logic timestamp
    msgObj.t_send_ms = now; // just before publish

    kpiLog.log({
      event: "ETCS_TX",
      side: "RBC",
      topic,
      nid_message: msgObj?.NID_MESSAGE ?? null,
      sequence: msgObj?.SEQUENCE ?? null,
      origin: msgObj?.origin ?? "rbc",
      t_app_ms: msgObj.t_app_ms,
      t_send_ms: msgObj.t_send_ms
    });


    // IMPORTANT: keep your architecture expectation:
    // for ETCS-plane messages (NID_MESSAGE present) add origin if missing
    if (msgObj.NID_MESSAGE !== undefined && !msgObj.origin) {
      msgObj.origin = "amqp";
    }

    mqttClient.publish(topic, JSON.stringify(msgObj), { qos }, cb);
  }

  function logAi(msg) {
    const label = msg?.label ?? "Obstacle";
    const conf  = msg?.conf ?? msg?.score;
    logInfo(`🚨 AI ALERT @RBC | label=${label} conf=${conf ?? "?"} | msg_id=${msg?.msg_id ?? "?"}`);
  }

  let sessionAckSent = false;

  /**
   * @brief Handles AU1 handshake message and sends AU2.
   * @param {object} msg - AU1 message object
   */
  function handleAU1Message(msg) {
    logInfo("Au1 is hereeee");
    const currentState = etcsManager.stateManager.getCurrentState().id;
    if (![ETCS_STATES.DISCONNECTED.id, ETCS_STATES.READY.id].includes(currentState)) {
      logError("AU1 received in invalid state");
      return;
    }

    // ✅ Session setup start
    t_au1_recv_ms = Date.now();
    logInfo(`⏱️ Session setup start (AU1 recv @RBC) t=${t_au1_recv_ms}`);

    logInfo(`Received AU1 from ${msg.ETCS_ID}`);

    try {
      etcsManager.stateManager.transition('AU1_SENT');
      const { K1, K2, K3 } = HandshakeManager.generateDynamicKeys();
      const rbcRandom = crypto.getRandomValues(new Uint32Array(2));

      const au2 = HandshakeManager.generateAU2(
        "DE0001", 1, msg,
        { Random_RA_L: rbcRandom[0], Random_RA_R: rbcRandom[1] },
        K1, K2, K3,
        etcsManager.stateManager
      );

      // ✅ stamped publish (handshake topic)
      stampAndPublish(topics.rbcHS, au2, 2, (err) => {
        if (err) logError("AU2 publish failed:", err);
        else {
          logInfo("Sent Successfully");
          updateStatus();
        }
      });
    } catch (err) {
      logError("AU2 generation failed: " + err.message);
    }
  }

  /**
   * @brief Routes incoming ETCS messages to appropriate handlers.
   * @param {object} msg - ETCS message object
   */
  function handleETCSMessage(msg) {

    const t_rbc_recv_ms = Date.now();

    kpiLog.log({
      event: "ETCS_RX",
      side: "RBC",
      nid_message: msg?.NID_MESSAGE ?? null,
      sequence: msg?.SEQUENCE ?? null,
      origin: msg?.origin ?? null,
      t_rbc_recv_ms,
      t_app_ms: msg?.t_app_ms ?? null,
      t_send_ms: msg?.t_send_ms ?? null
    });

    const isHandshake = msg?.type === "AU1"; // extend if needed

    // IMPORTANT: you explicitly said you want this architecture gate unchanged
    if (!msg || !msg.origin || (msg.origin !== "amqp" && !isHandshake)) return;

    // ✅ Dedupe AFTER origin gate (architecture stays intact)
    if (isDuplicate(msg)) {
      return;
    }

    console.log(`Received message ${msg?.type ?? "?"} and ${msg?.NID_MESSAGE ?? "?"}`);
    updateStatus();

    if (!etcsManager.stateManager.validateMessage(msg.NID_MESSAGE)) {
      logError(`Invalid message ${msg.NID_MESSAGE} for current state`);
      return;
    }

    switch (msg.NID_MESSAGE) {
      case 146: {
        const state = etcsManager.stateManager.getCurrentState().id;
        console.log(`State is: ${state}`);
        switch (state) {
          case ETCS_STATES.VERSION_EXCHANGED.id:
            logInfo("Contextual Ack 146 → for System Version (32)");
            handleAckMessage(32);
            break;
          case ETCS_STATES.SESSION_ESTABLISHED.id:
            logInfo("Contextual Ack 146 → for Session Acknowledgment (38)");
            handleAckMessage(38);
            break;
          case ETCS_STATES.TRAIN_DATA_EXCHANGED.id:
            logInfo("Contextual Ack 146 → for Train Data (8)");
            handleAckMessage(8);
            break;
          case ETCS_STATES.MA_REQUEST_READY.id:
            logInfo("Contextual Ack 146 → for Train Accepted (41)");
            handleAckMessage(41);
            break;
          default:
            // keep quiet (no warn spam)
            break;
        }
        break;
      }

      case 155: handleMessage155(); break;
      case 159: handleMessage159(); break;
      case 129: handleMessage129(); break;
      case 157: handleMessage157(msg); console.log("157 is here!"); break;
      case 132: handleMessage132(); break;
      case 136: handleMessage136(msg); break;
      case 156: handleMessage156(); break;

      default:
        logDebug(`Unhandled message: ${msg.NID_MESSAGE}`);
    }
  }

  /**
   * @brief Handles acknowledgment messages (Msg 146).
   * @param {number} ref - Reference message ID being acknowledged
   */
  function handleAckMessage(ref) {
    logLog(`Received Ack for message ${ref}`);

        // ---- RBC-side RTT: when we sent message ref -> when we receive its ACK (146 contextual) ----
    const t0 = rbcSentTs.get(Number(ref));
    if (t0 != null) {
      const rttMs = Date.now() - Number(t0);
      logInfo(`⏱️ RBC RTT sent ${ref} → ACK recv = ${rttMs} ms`);

      // ✅ Persist RTT KPI into JSONL (so Python can fill table)
      kpiLog.log({
        event: "ETCS_RTT_RX",
        side: "RBC",
        ref_nid_message: Number(ref),
        t_rbc_sent_ms: Number(t0),
        t_rbc_ack_recv_ms: Date.now(),
        rtt_ms: rttMs
      });


      rbcSentTs.delete(Number(ref));
    } else {
      logDebug(`(RTT) No stored t_send_ms for ref=${ref} (maybe not tracked yet)`);
    }


    const transitions = {
      32: 'M32_ACKED',
      38: 'M38_ACKED',
      8:  'M8_ACKED',
      41: 'M41_ACKED'
    };

    if (transitions[ref]) {
      etcsManager.stateManager.transition(transitions[ref]);
    }
    updateStatus();
  }

  /**
   * @brief Handles system version request (Msg 155).
   */
  function handleMessage155() {
    if (etcsManager.stateManager.getCurrentState().id !== ETCS_STATES.HANDSHAKE_INITIATED.id) return;

    const m32 = etcsManager.buildFromTemplate("message32", {
      origin: "rbc",
      M_VERSION: etcsManager.getTemplate("packet2")?.M_VERSION || 1,
      SEQUENCE: etcsManager.sequenceCounter++
    });

    // ✅ stamped publish
    stampAndPublish(topics.rbcOut, m32, 2);
    rbcSentTs.set(32, Number(m32.t_send_ms));

    etcsManager.stateManager.transition('M32_SENT');
    logInfo("Sent System Version (32)");
    updateStatus();
  }

  /**
   * @brief Handles session establishment acknowledgment (Msg 159).
   */
  function handleMessage159() {
    logLog("Received message 159");
    if (sessionAckSent) return;

    const stateId = etcsManager.stateManager.getCurrentState().id;
    if (stateId < ETCS_STATES.VERSION_EXCHANGED.id || stateId > ETCS_STATES.SESSION_ESTABLISHED.id) return;

    const m38 = etcsManager.buildFromTemplate("message38", { origin: "rbc" });

    // ✅ stamped publish + KPI uses the stamped t_send_ms
    stampAndPublish(topics.rbcOut, m38, 2, (err) => {
            rbcSentTs.set(38, Number(m38.t_send_ms));
  
      if (!err) {
        // KPI: AU1 recv → M38 sent (use stamped time)
        if (t_au1_recv_ms) {
          const setup_ms = Number(m38.t_send_ms) - Number(t_au1_recv_ms);
          logInfo(`⏱️ Session setup time (AU1 recv → M38 sent) = ${setup_ms} ms`);
        }

        sessionAckSent = true;
        etcsManager.stateManager.transition('M38_SENT');
        logLog("Sent Session Acknowledgment (38)");
        updateStatus();
      }
    });
  }

  /**
   * @brief Handles Train Data message (Msg 129) and sends Msg 8.
   */
  function handleMessage129() {
    if (etcsManager.stateManager.getCurrentState().id !== ETCS_STATES.SESSION_ESTABLISHED.id) return;

    const m8 = etcsManager.buildFromTemplate("message8", { origin: "rbc" });

    // ✅ stamped publish
    stampAndPublish(topics.rbcOut, m8, 2);
    rbcSentTs.set(8, Number(m8.t_send_ms));
    etcsManager.stateManager.transition('M8_SENT');
    logLog("Sent Train Data Acknowledgment (8)");
    updateStatus();
  }

function handleMessage136(msg) {
  const t_rbc_recv_ms = Date.now();

  logInfo("📡 Received Message 136 (Train Position Report)");

  const dlrbg = msg.packet0?.D_LRBG;
  const scale = msg.packet0?.Q_SCALE;
  const scaleFactor = scale === 0 ? 1 : scale === 1 ? 10 : 100;
  const distanceMeters = dlrbg * (scaleFactor / 10);

  logInfo(`📬 D_LRBG = ${dlrbg} → ${distanceMeters.toFixed(1)} meters`);

  const dlrbgToSensorMap = {
    1000: "S1",
    2000: "S2",
    3000: "S3",
    4000: "S4",
    5000: "S5",
    6000: "S6",
    7000: "S7",
    8000: "S8"
  };

  const sensorId = dlrbgToSensorMap[dlrbg];
  const expectedSensor = (typeof window.getExpectedSensor === "function") ? window.getExpectedSensor() : undefined;

  if (!sensorId) {
    console.log(`⚠️ Unknown D_LRBG = ${dlrbg}`);
    return;
  }

  if (sensorId !== expectedSensor) {
    console.log(`❌ Incorrect sensor ${sensorId}. Expected ${expectedSensor}. Suppressing ACK 146.`);
    if (typeof window.log === "function") {
      window.log(`❌ Incorrect sensor ${sensorId}. Expected ${expectedSensor}`);
    }
    return;
  }

  logInfo("136 keys:", Object.keys(msg));
  logInfo("136 t_obu_recv_ms:", msg.t_obu_recv_ms);
  logInfo("136 t_obu_send_ms:", msg.t_obu_send_ms);
  logInfo("136 t_esp_send_ms:", msg.t_esp_send_ms ?? msg.t_send_ms);
  logInfo("136 t_esp_sense_ms:", msg.t_esp_sense_ms ?? msg.t_sense_ms);

  // ===== FIXED KPI Calculation =====
  // Use OBU-side timestamps (t_obu_*) for relay time
  const t_obu_recv_ms = Number(msg.t_obu_recv_ms) || null;
  const t_obu_send_ms = Number(msg.t_obu_send_ms) || null;
  
  // OBU relay time (MQTT recv -> publish 136) - using same clock
  const obu_relay_ms = 
    (t_obu_recv_ms !== null && t_obu_send_ms !== null) ? 
    (t_obu_send_ms - t_obu_recv_ms) : null;

  // Network latency from OBU->RBC - using same clock
  const obu_to_rbc_ms = 
    (t_obu_send_ms !== null) ? 
    (t_rbc_recv_ms - t_obu_send_ms) : null;

  // For ESP32 timestamps, we can only calculate ESP32 internal processing time
  const t_esp_sense_ms = Number(msg.t_esp_sense_ms ?? msg.t_sense_ms) || null;
  const t_esp_send_ms  = Number(msg.t_esp_send_ms  ?? msg.t_send_ms ) || null;

  // ESP32 processing time (sensing -> sending) - ESP32 clock
  const esp_processing_ms = 
    (t_esp_sense_ms !== null && t_esp_send_ms !== null) ? 
    (t_esp_send_ms - t_esp_sense_ms) : null;

  // ESP32->OBU network time can't be accurately calculated due to clock mismatch
  // We can only estimate if ESP32 and OBU clocks were synchronized
  
  // time spent in RBC UI action (simulate click)
  let rbc_ui_ms = null;

  if (typeof window.handleSensorClick === "function") {
    const t_ui_start = Date.now();
    logInfo(`🔁 Simulating sensor ${sensorId} click based on D_LRBG`);
    window.handleSensorClick(sensorId);
    rbc_ui_ms = Date.now() - t_ui_start;
  }

  // Log KPI with clear labels
  logInfo(
    `⏱️ POS sensor=${sensorId} seq=${msg?.sensor_seq ?? "?"} | ` +
    `OBU_relay=${obu_relay_ms ?? "NA"} ms | ` +
    `OBU→RBC=${obu_to_rbc_ms ?? "NA"} ms | ` +
    `ESP_process=${esp_processing_ms ?? "NA"} ms | ` +
    `RBC_UI=${rbc_ui_ms ?? "NA"} ms`
  );

  // Also log warning if ESP32 timestamps are suspicious
  if (t_esp_sense_ms !== null && t_esp_sense_ms < 1000) {
    logInfo(`⚠️ ESP32 timestamp (${t_esp_sense_ms}) appears to be millis() clock, not epoch`);
  }

  const transitioned = etcsManager.stateManager.transition('MONITORING_STARTED');
  if (transitioned) logInfo("🔄 Transitioned to MISSION_MONITORING");

 // ---- JSONL KPI log for Position Report (136) ----
// Log only FIRST valid position report per sensor (S1..S8). Ignore repeats for KPI.
if (!firstPosReportSeen.has(sensorId)) {
  firstPosReportSeen.add(sensorId);

  kpiLog.log({
    event: "POS_REPORT_136_FIRST",
    side: "RBC",
    nid_message: 136,
    sequence: msg?.SEQUENCE ?? null,
    sensor_id: sensorId ?? null,
    expected_sensor: expectedSensor ?? null,

    // RBC receive time (RBC clock)
    t_rbc_recv_ms,

    // OBU relay timestamps (OBU clock)
    t_obu_recv_ms: (msg?.t_obu_recv_ms != null ? Number(msg.t_obu_recv_ms) : null),
    t_obu_send_ms: (msg?.t_obu_send_ms != null ? Number(msg.t_obu_send_ms) : null),

    // ESP timestamps (ESP clock)
    t_esp_sense_ms: (msg?.t_esp_sense_ms != null ? Number(msg.t_esp_sense_ms)
                : (msg?.t_sense_ms != null ? Number(msg.t_sense_ms) : null)),

    t_esp_send_ms:  (msg?.t_esp_send_ms  != null ? Number(msg.t_esp_send_ms)
                : (msg?.t_send_ms  != null ? Number(msg.t_send_ms)  : null)),

    // Derived KPIs
    obu_relay_ms,
    obu_to_rbc_ms,
    esp_processing_ms,
    rbc_ui_ms
  });
}




 const ack = etcsManager.buildFromTemplate("message146", {
  origin: "rbc",
  NID_MESSAGE_REF: 136
});

// ---- RTT pairing metadata (transport-only) ----
// OBU stores send time under key "136:<SEQUENCE>"
const seq = (msg?.SEQUENCE ?? null);
ack._rtt = {
  key: (seq != null ? `136:${seq}` : null),
  ref: 136
};

// Optional but useful fallback if you ever want:
// echo sequence reference explicitly
ack.SEQUENCE_REF = (seq != null ? Number(seq) : null);

// ✅ stamped publish
stampAndPublish(topics.rbcOut, ack, 2);
rbcSentTs.set(146, Number(ack.t_send_ms));
}

  /**
   * @brief Handles Train Acceptance (Msg 157) and replies with 41 or 40.
   * @param {object} msg - Msg 157 object
   */
  function handleMessage157(msg) {
    const stateId = etcsManager.stateManager.getCurrentState().id;

    // Accept in SESSION_ESTABLISHED or TRAIN_DATA_EXCHANGED
    if (stateId < ETCS_STATES.SESSION_ESTABLISHED.id || stateId > ETCS_STATES.MA_REQUEST_READY.id) {
      console.log(`🚫 Ignoring Msg 157 because of state: ${stateId}`);
      return;
    }

    logLog("Received message 157");

    const status = parseInt(msg?.Q_STATUSLRBG, 10);
    const nid = (status === 1 ? 41 : 40);
    const reply = etcsManager.buildFromTemplate(`message${nid}`, { origin: "rbc" });

    // ✅ stamped publish (ONLY ONCE)
    stampAndPublish(topics.rbcOut, reply, 2);
        if (nid === 41) rbcSentTs.set(41, Number(reply.t_send_ms));

    if (nid === 41) {
      const transitioned = etcsManager.stateManager.transition('M41_SENT'); // moves forward

      if (transitioned) {
        logInfo("✅ Transitioned to TRAIN_DATA_EXCHANGED");
      }

      logInfo("✅ Sent Train Accepted (41)");
      updateStatus(); // reflect transition before downstream ack
    }

    updateStatus();
  }

  function handleMessage156() {
    const state = etcsManager?.stateManager?.getCurrentState();
    const validStates = [ETCS_STATES.MISSION_MONITORING.id, ETCS_STATES.MISSION_ACTIVE.id];

    if (!state || !validStates.includes(state.id)) {
      console.warn(`Ignoring Message 156 – not in a terminable state: ${state?.name}`);
      return;
    }

    logInfo("📴 Received Message 156 (Session Termination Request)");

    const transitioned = etcsManager.stateManager.transition('SESSION_TERMINATED');
    if (transitioned) {
      logInfo("🧯 Transitioned to SESSION_TERMINATED");
    }

    const ackMsg = etcsManager.buildFromTemplate("message39", {
      origin: "rbc",
      M_ACK: 0,
      NID_LRBG: 16777214
    });

    // ✅ stamped publish
    stampAndPublish(topics.rbcOut, ackMsg, 2);

    logInfo("📤 Sent Message 39 (Session Termination Acknowledged)");
  }

  /**
   * @brief Handles Movement Authority Request (Msg 132).
   */
  function handleMessage132() {
    const state = etcsManager?.stateManager?.getCurrentState();
    if (!state || state.id !== ETCS_STATES.MA_REQUEST_READY.id) {
      console.log("Ignoring MA request - not in MA_REQUEST_READY state");
      return;
    }

    logInfo("Msg 132 received: enabling Grant MA button");
    maRequestReceived = true;

    const btn = document.getElementById("grantMaBtn");
    if (btn) btn.disabled = false;
  }

  /**
   * @brief Handles AI Alerts
   */
  function handleAIAlerts(msg) {
    const t_rbc_recv_ms = Date.now();
    const t_obu_send_ms = (msg && msg.t_send_ms != null) ? Number(msg.t_send_ms) : null;

    const obu_to_rbc_ms =
      (t_obu_send_ms != null && Number.isFinite(t_obu_send_ms))
        ? (t_rbc_recv_ms - t_obu_send_ms)
        : null;

        // --------------------------------------------------
// Send AI ACK back to OBU (for RTT measurement)
// --------------------------------------------------
try {
  if (msg && msg.msg_id) {
    const ack = {
      type: "AI_ACK",
      msg_id: msg.msg_id,
      receiver: "RBC",
      ts: new Date().toISOString()
    };

    // IMPORTANT: publish to same topic OBU listens to
    //mqttClient.publish("obu/ai/ack", JSON.stringify(ack), { qos: 1, retain: false });
    (mqttAi || mqttClient).publish("obu/ai/ack", JSON.stringify(ack), { qos: 1, retain: false });

  }
} catch (_) {}


        
    logInfo("ALERT! OBSTACLE DETECTED");
    logAi(msg);

kpiLog.log({
  event: "AI_ALERT_RX",
  side: "RBC",
  topic: `obu/${(msg?.rbc_id ?? "DE0001")}/ai/alert`,
  msg_id: msg?.msg_id ?? null,
  frame_id: msg?.frame_id ?? null,
  label: msg?.label ?? null,
  conf: (msg?.conf != null ? Number(msg.conf) : null),

  // RBC clock
  t_rbc_recv_ms,

  // From sender (OBU/Pi clock depending on your pipeline)
  t_send_ms: (msg?.t_send_ms != null ? Number(msg.t_send_ms) : null),

  // Derived (only meaningful if clocks match)
  obu_to_rbc_ms
});


    logInfo(
      `⏱️ AI OBU→RBC one-way (unsynced) = ${obu_to_rbc_ms ?? "NA"} ms | ` +
      `msg_id=${msg?.msg_id ?? "?"} frame_id=${msg?.frame_id ?? "?"}`
    );
  }


  function sendMovementAuthorityManually() {
    const state = etcsManager?.stateManager?.getCurrentState();
    if (!state || state.id !== ETCS_STATES.MA_REQUEST_READY.id) {
      console.log("Cannot grant MA: Not in MA_REQUEST_READY state");
      return;
    }

    if (!topology || !topology.routeData || Object.keys(topology.routeData).length === 0) {
      console.log("No topology uploaded, cannot grant MA");
      return;
    }

    const routeData = topology.routeData;
    const selectedRoute = window.currentRoute || Object.keys(routeData)[0];
    const routeInfo = routeData[selectedRoute];

    if (!routeInfo?.tracks?.length) {
      console.log("Selected route is invalid");
      return;
    }

    logInfo(`(Manual) Generating MA for route: ${selectedRoute}`);
    movementAuthorityGranted = true;

    try {
      const packet15 = generatePacket15ForRoute(
        routeInfo.tracks,
        selectedRoute,
        null,     // fromCurrentPosition
        topology  // topology object
      );

      if (!packet15) {
        logError("Packet15 generation failed");
        return;
      }

      const m3 = etcsManager.buildFromTemplate("message3", {
        origin: "rbc",
        packet15
      });

      // ✅ stamped publish (do NOT JSON.stringify manually)
      stampAndPublish(topics.rbcOut, m3, 2, (err) => {
        if (err) logError("MA publish failed: " + err.message);
        else {
          logInfo(`(Manual) MA sent for route ${selectedRoute}`);

          const transitioned = etcsManager.stateManager.transition("M3_SENT");
          if (!transitioned) {
            console.log("⚠️ Invalid transition: M3_SENT not allowed from current state");
          }

          updateStatus();
        }
      });
    } catch (e) {
      logError("Exception in MA generation: " + e.message);
      console.error(e);
    }
  }

  //return { handleAU1Message, handleETCSMessage, sendMovementAuthorityManually, handleAIAlerts };


  return { handleAU1Message, handleETCSMessage, sendMovementAuthorityManually, handleAIAlerts };
}
