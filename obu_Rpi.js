//Timestamp change obuRpi.js

// obu_Rpi.js
import { webcrypto } from "crypto";
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

import CryptoJS from "crypto-js";
globalThis.CryptoJS = CryptoJS;

import mqtt from "mqtt";
import fs from "fs";

import { HandshakeManager } from "./modules/handshake.js";
import { ETCSManager } from "./modules/etcs.js";
import { StateManager } from "./modules/state_manager.js";

// ===== same config as your RPiObu.html =====
const BROKER_URL = "ws://192.168.4.4:9001";
const RBC_ID = "DE0001";
const OBU_ID = "OBU1234";

// If your Remote OBU UI uses fixed train number:
const TRAIN_FIXED = "TRAIN01";

const VIDEO_PING_TOPIC = "obu/video/ping";
const VIDEO_PONG_TOPIC = "obu/video/pong";
const TRAIN_CMD_META_TOPIC = "obu/train/meta"; // shadow cmd from Remote OBU

// ===== topics for auto stop =====
const LOCAL_AI_ALERT_TOPIC = "obu/ai/alert";              // produced by AI pipeline (Pi)
const TRAIN_CMD_TOPIC = "obu/train";                      // ESP32 subscribes here
const TRAIN_STATUS_TOPIC = `obu/${TRAIN_FIXED}/status`;   // UI subscribes after "Connect Train"

// ===== auto-stop policy =====
const AUTO_STOP_ENABLED = true;
const AUTO_STOP_COOLDOWN_MS = 1500; // prevent spamming stop to ESP32
const AUTO_STOP_MIN_CONF = 0.25;    // if conf present, stop only if >= this

// ===== load message templates =====
const messages = JSON.parse(fs.readFileSync("./messages.json", "utf-8"));
const etcsManager = new ETCSManager(messages);
etcsManager.stateManager = new StateManager();

// ===== state vars (same idea as HTML) =====
let mqttClient;
let obuRandom = null;
let K1, K2, K3;
let maRequestSent = false;

let totalSections = null;
let passedSections = 0;


// ---- ETCS RTT (generic OBU clock) ----
// Track "OBU sent message X at time t0" and when "RBC replies with Y" compute RTT = now - t0.
const etcsSentTs = new Map(); // key: sent NID_MESSAGE (Number) -> t_send_ms (epoch)

// Define which RBC response(s) close the timer for a given OBU-sent message.
// Keep it minimal and adjust later based on what you actually see in logs.
const OBU_RTT_PAIRS = new Map([
  [155, [32]],        // OBU: Session Establishment -> RBC: Session Established (typical)
  [159, [38]],        // OBU: Key exchange response -> RBC: Auth / session confirmation (typical)
  [129, [8]],         // OBU: Train data -> RBC: Acknowledgement (typical)
  [157, [40, 41]],    // OBU: (depends) -> RBC: ACK/Response (typical)
  [132, [15]],        // OBU: MA Request -> RBC: Packet 15 MA (your demo)
  [136, [146]],       // OBU: Position Report -> RBC: Acknowledge
]);

const OBU_RTT_RESP_TO_SENT = (() => {
  const m = new Map();
  for (const [sent, resps] of OBU_RTT_PAIRS.entries()) {
    for (const r of resps) m.set(Number(r), Number(sent));
  }
  return m;
})();


// ---- ETCS RTT (single-clock on OBU) ----
let lastPos136SentMs = null;     // Date.now() when we published 136
let lastPosSeq = null;           // sensor_seq for logging (optional)


// ---- auto stop state ----
let lastAutoStopTs = 0;

// simple logger replacement for browser Logger
const logger = {
  log: (...a) => console.log(new Date().toISOString(), ...a),
};

// ---- helpers to mimic your MQTTManager behavior ----
function publish(topic, msgObjOrString, options = { qos: 2 }, cb) {
  // If it's a string, publish as-is
  if (typeof msgObjOrString === "string") {
    mqttClient.publish(topic, msgObjOrString, options, cb);
    return;
  }

  // If it's an object, stamp timing BEFORE stringify
  if (msgObjOrString && typeof msgObjOrString === "object") {
    const now = Date.now();
    msgObjOrString.t_app_ms = msgObjOrString.t_app_ms ?? now;
    msgObjOrString.t_send_ms = now;
  }

    // ---- RTT tracker: remember when OBU sends ETCS messages to RBC ----
  if (
    topic === `rbc/${RBC_ID}/in` &&
    msgObjOrString &&
    typeof msgObjOrString === "object" &&
    msgObjOrString.NID_MESSAGE !== undefined
  ) {
    etcsSentTs.set(Number(msgObjOrString.NID_MESSAGE), Number(msgObjOrString.t_send_ms));
  }


  const payload = JSON.stringify(msgObjOrString);
  mqttClient.publish(topic, payload, options, cb);

  if (msgObjOrString?.NID_MESSAGE !== undefined) {
    logger.log(`Sent Message ${msgObjOrString.NID_MESSAGE} → ${topic}`);
  }
}


function subscribe(topics, options = { qos: 2 }, cb) {
  mqttClient.subscribe(topics, options, cb);
}

// ===== YOUR SAME FUNCTIONS (logic kept same) =====

const sendMARequest132 = () => {
  if (!mqttClient || !RBC_ID || !etcsManager) return;

  const msg132 = etcsManager.buildFromTemplate("message132", { origin: "obu" });
  publish(`rbc/${RBC_ID}/in`, msg132, { qos: 2 }, (err) => {
    if (!err) logger.log("Sent MA Request (132) automatically");
    else logger.log("Failed to send 132:", err?.message || err);
  });
};

const autoRequestMaIfReady = () => {
  const state = etcsManager?.stateManager?.getCurrentState()?.name;
  const ready = ["TRAIN_DATA_EXCHANGED", "M41_ACKED", "MA_REQUEST_READY"].includes(state);

  if (ready && !maRequestSent) {
    maRequestSent = true;
    sendMARequest132();
  }
};

const handleAU2 = (msg) => {
  logger.log("AU2 received by OBU:", msg);
  etcsManager.stateManager.transition("AU2_RECEIVED");

  const sessionKeys = HandshakeManager.deriveSessionKeys(
    { Random_RA_L: msg.Random_RA_L, Random_RA_R: msg.Random_RA_R },
    { Random_RB_L: obuRandom.L, Random_RB_R: obuRandom.R },
    K1, K2, K3,
    etcsManager.stateManager
  );

  publish(
    `obu/${RBC_ID}/keys`,
    {
      type: "KEY_UPDATE",
      ETCS_ID: OBU_ID,
      ...sessionKeys,
      SEQUENCE: Math.floor(Math.random() * 1000000),
    },
    { qos: 2 }
  );

  subscribe(`rbc/${RBC_ID}/out`, { qos: 2 }, () => {
    const msg155 = etcsManager.buildFromTemplate("message155", { origin: "obu" });
    publish(`rbc/${RBC_ID}/in`, msg155, { qos: 2 });
  });
};

// ===== AUTO STOP HANDLER =====
// Note: RTT will be measured on the Pi publisher (single-clock), so Node does NOT track ACKs.
const handleLocalAiAlert = (topic, payloadBuf) => {
  if (!AUTO_STOP_ENABLED) return;

  const now = Date.now();
  if (now - lastAutoStopTs < AUTO_STOP_COOLDOWN_MS) return;

  let raw = payloadBuf.toString();
  let obj = null;
  try { obj = JSON.parse(raw); } catch (_) {}

  const label = (obj?.label ?? obj?.class ?? obj?.name ?? "Obstacle").toString();
  const conf = obj?.conf ?? obj?.score;

  // Stop policy:
  // - if conf not present → stop anyway
  // - if conf present → stop if >= threshold
  const shouldStop = (conf === undefined || conf === null)
    ? true
    : (Number(conf) >= AUTO_STOP_MIN_CONF);

  if (!shouldStop) {
    logger.log(`🟡 AI alert ignored (conf too low): label=${label} conf=${conf}`);
    return;
  }

  lastAutoStopTs = now;

  // 1) Stop the train (ESP32 listens to obu/train)
  const t_auto_stop_send_ms = Date.now();

  publish(TRAIN_CMD_TOPIC, "0", { qos: 1 }, (err) => {
    if (err) logger.log("❌ AUTO STOP publish failed:", err?.message || err);
    else logger.log(`🛑 AUTO STOP sent → ${TRAIN_CMD_TOPIC} = 0 | ${label}${conf !== undefined ? ` conf=${conf}` : ""}`);
  });

  // 2) Publish a status event so the Remote OBU UI can log it
  // Keep msg_id/frame_id if present so UI can correlate with alert timeline if needed.
  publish(
    TRAIN_STATUS_TOPIC,
    {
      type: "TRAIN_EVENT",
      event: "AUTO_STOP_OBSTACLE",
      label,
      conf: conf ?? null,
      msg_id: obj?.msg_id ?? null,
      frame_id: obj?.frame_id ?? null,

      // KPI timestamp (OBU clock)
      t_auto_stop_send_ms,

      ts: now
    },
    { qos: 1 }
  );

  // (Optional) forward to RBC-facing AI alert topic if you use it:
  // publish(`obu/${RBC_ID}/ai/alert`, { type:"AI_ALERT", label, conf: conf ?? null, ts: now }, { qos: 1 });
};

const processMessage = (topic, payloadBuf) => {
  try {
    // ---- Auto-stop hook first ----
    if (topic === LOCAL_AI_ALERT_TOPIC) {
      handleLocalAiAlert(topic, payloadBuf);
      return;
    }

    const raw = payloadBuf.toString();
    const msg = JSON.parse(raw);
    
    // ===== KPI: TRAIN START/STOP meta received at OBU =====
    if (topic === TRAIN_CMD_META_TOPIC && msg?.type === "TRAIN_CMD_META" && msg?.cmd_id) {
      const t_obu_recv_ms = Date.now();

      publish(
        TRAIN_STATUS_TOPIC,
        {
          type: "TRAIN_CMD_ACK",
          cmd: msg.cmd ?? null,
          cmd_id: msg.cmd_id,
          t_cmd_send_ms: msg.t_cmd_send_ms ?? null, // remote timestamp (for correlation only)
          t_obu_recv_ms,                            // OBU timestamp (this is your real KPI point)
          ack_from: "obu_rpi"
        },
        { qos: 1 }
      );

      logger.log(`? TRAIN_CMD_META RX ? ACK sent | ${msg.cmd} | ${msg.cmd_id}`);
      return;
    }
    
    // ===== VIDEO RTT responder (Remote sends ping, OBU replies pong) =====
    if (topic === VIDEO_PING_TOPIC) {
      let ping = null;
      try { ping = JSON.parse(payload.toString()); } catch (_) {}

    publish(
      VIDEO_PONG_TOPIC,
      {
        type: "VIDEO_PONG",
        frame_id: ping?.frame_id ?? null,
        t0: ping?.t0 ?? null,             // echo remote timestamp (remote uses it)
        t_obu_pong_send_ms: Date.now()    // optional debug
      },
      { qos: 0 }
    );
      return;
    }

    // ===== KPI: AI ACK received at OBU =====
    if (msg?.type === "AI_ACK" && msg?.msg_id) {
      const t_ai_ack_recv_ms = Date.now();

      publish(
        TRAIN_STATUS_TOPIC,
        {
          type: "KPI",
          kpi: "AI_ACK_RX",
          msg_id: msg.msg_id,

          // timestamps
          t_ai_ack_recv_ms,
          t_ai_ack_send_ms: msg.t_ack_send_ms ?? null
        },
        { qos: 1 }
      );

      logger.log(`⏱️ AI ACK received at OBU | msg_id=${msg.msg_id}`);
    }

    
    const allowedHandshake = ["AU2"];
    const isHandshake = topic.endsWith("/handshake") && allowedHandshake.includes(msg.type);
    const isPiTopic =
    (topic === "obu/status" ||
     topic === TRAIN_CMD_META_TOPIC ||
     topic.startsWith("obu/ai/") ||
     topic.startsWith("obu/safety/"));

    // Keep your original filter (so random topics don't flood this OBU)
    if (msg.origin !== "amqp" && topic !== `esp32/${RBC_ID}/sensor` && !isHandshake && !isPiTopic) return;

    // --- routing: keep same decisions ---
    if (topic === `rbc/${RBC_ID}/handshake` && msg.type === "AU2") {
      handleAU2(msg);
      return;
    }

    if (topic === `rbc/${RBC_ID}/out`) {
      
            // ---- Generic ETCS RTT KPI on OBU clock ----
      if (msg?.NID_MESSAGE !== undefined) {
        const respNid = Number(msg.NID_MESSAGE);
        const sentNid = OBU_RTT_RESP_TO_SENT.get(respNid);

        if (sentNid != null) {
          const t0 = etcsSentTs.get(sentNid);
          if (t0 != null) {
            const rttMs = Date.now() - Number(t0);

            publish(
              TRAIN_STATUS_TOPIC,
              {
                type: "KPI",
                kpi: `ETCS_RTT_${sentNid}_${respNid}`,
                rtt_ms: rttMs,
                ts: Date.now()
              },
              { qos: 1 }
            );

            logger.log(`⏱️ ETCS RTT(${sentNid}→${respNid}) = ${rttMs} ms`);
            etcsSentTs.delete(sentNid);
          }
        }
      }
      
      
      etcsManager.handleETCSMessage(msg, RBC_ID, { publish });

      if (msg.NID_MESSAGE === 146) {
        

        
        if (global._awaiting146) {
          passedSections++;
          logger.log(`🚩 Passed Sections (ACKed): ${passedSections} / ${totalSections}`);
          global._awaiting146 = false;

          const expectedSections = totalSections + 1;
          if (totalSections !== null && passedSections >= expectedSections) {
            logger.log(`✅ All sections passed (${passedSections}/${expectedSections}). Ending mission.`);

            const transitioned = etcsManager.stateManager.transition("MISSION_COMPLETE");
            if (transitioned) {
              const msg150 = etcsManager.buildFromTemplate("message150", {
                origin: "obu",
                Q_DESK: 0,
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
                  V_TRAIN: 0,
                  Q_DIRTRAIN: 1,
                  M_MODE: 0,
                  M_LEVEL: 0,
                  NID_NTC: 0
                }
              });

              publish(`rbc/${RBC_ID}/in`, msg150, { qos: 2 });
              logger.log("📤 Sent Message 150 (End of Mission)");

              setTimeout(() => {
                const msg156 = etcsManager.buildFromTemplate("message156", { origin: "obu" });
                publish(`rbc/${RBC_ID}/in`, msg156, { qos: 2 });
                logger.log("📤 Sent Message 156 (Terminate Session)");
              }, 1000);
            }
          }
        }
      }

      autoRequestMaIfReady();
      return;
    }

    if (topic === `esp32/${RBC_ID}/sensor`) {
      const t_obu_recv_ms = Date.now();

      const data = msg; // already JSON

      // ✅ Support new ESP32 JSON and old legacy {"S3":1}
      let sensorId = data?.sensor_id;
      let sensorSeq = data?.sensor_seq ?? null;
      let t_sense_ms = data?.t_sense_ms ?? null;   // ESP32 millis() clock
      let t_send_ms = data?.t_send_ms ?? null; // ESP32 millis() clock

      if (!sensorId) {
        // legacy fallback
        const active = Object.entries(data).find(([k, v]) => v === 1 && k.startsWith("S"));
        if (active) sensorId = active[0];
      }

      if (!sensorId) return;

      const sensorDistances = { S1:1000,S2:2000,S3:3000,S4:4000,S5:5000,S6:6000,S7:7000,S8:8000 };
      const D_LRBG = sensorDistances[sensorId] || 0;

      const t_obu_send_ms = Date.now();

    const msg136 = etcsManager.buildFromTemplate("message136", {
  origin: "obu",
  packet0: {
    Q_SCALE: 1,
    NID_LRBG: 16777214,
    D_LRBG,
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

// Force-attach meta AFTER template build (prevents template sanitizer loss)
msg136.sensor_id = sensorId;
msg136.sensor_seq = sensorSeq ?? null;
msg136.t_esp_sense_ms = t_sense_ms ?? null;   // ESP32 millis
msg136.t_esp_send_ms  = t_send_ms ?? null;    // ESP32 millis

msg136.t_obu_recv_ms = t_obu_recv_ms;
msg136.t_obu_send_ms = t_obu_send_ms;

// store for RTT: 136 sent -> 146 received
lastPos136SentMs = t_obu_send_ms;
lastPosSeq = sensorSeq ?? null;

      publish(`rbc/${RBC_ID}/in`, msg136, { qos: 2 });
      
      // ---- KPI meta: out-of-band telemetry (bypasses AMQP) ----
const kpi = {
  type: "POS_KPI",
  rbc_id: RBC_ID,
  obu_id: OBU_ID,
  sensor_id: sensorId,
  sensor_seq: sensorSeq ?? null,

  // Epoch timestamps (same clock as OBU)
  t_obu_recv_ms,
  t_obu_send_ms,

  // Optional: ESP32 local millis if you want, but don't mix clocks in subtraction
  t_sense_ms: t_sense_ms ?? null,
  t_esp_send_ms: t_send_ms ?? null,
};

publish(`kpi/${RBC_ID}/pos`, kpi, { qos: 1 });

      
      logger.log(`Sent Message 136 | sensor=${sensorId} seq=${sensorSeq ?? "?"}`);

      etcsManager.stateManager.transition("MONITORING_STARTED");
      global._awaiting146 = true;
      return;
    }


  } catch (err) {
    logger.log("Message error:", err?.message || err);
  }
};

const startHandshake = () => {
  if (!mqttClient?.connected) return logger.log("Not connected to broker");

  etcsManager.resetSession();
  if (!etcsManager.stateManager.transition("CONNECTED")) return;

  subscribe(`rbc/${RBC_ID}/handshake`, { qos: 2 }, (err, granted) => {
    logger.log("SUBSCRIBE handshake result:", { err: err?.message || err, granted });

    if (err) {
      logger.log("❌ Failed to subscribe to handshake (err)");
      return;
    }

    if (granted && granted.some(g => g.qos === 128)) {
      logger.log("❌ Failed to subscribe to handshake (qos=128 → broker refused)");
      return;
    }

    const session = {
      keys: HandshakeManager.generateDynamicKeys(),
      random: crypto.getRandomValues(new Uint32Array(2)),
    };

    K1 = session.keys.K1;
    K2 = session.keys.K2;
    K3 = session.keys.K3;
    obuRandom = { L: session.random[0], R: session.random[1] };

    const au1 = HandshakeManager.generateAU1(
      OBU_ID, RBC_ID, session.random, session.keys, etcsManager.stateManager
    );

    publish(`obu/${RBC_ID}/handshake`, au1, { qos: 2 });
    etcsManager.stateManager.transition("AU1_SENT");
    logger.log("AU1 Sent!");
  });
};

// ===== connect mqtt (same broker url, same extra subs) =====
const clientId = `OBU_RPI_${Date.now()}`;

mqttClient = mqtt.connect(BROKER_URL, {
  clientId,
  clean: true,
  reconnectPeriod: 1000,
});

mqttClient.on("close", () => logger.log("⚠️ MQTT closed"));
mqttClient.on("offline", () => logger.log("⚠️ MQTT offline"));
mqttClient.on("disconnect", (p) => logger.log("⚠️ MQTT disconnect", p));
mqttClient.on("reconnect", () => logger.log("🔄 MQTT reconnecting"));
mqttClient.on("end", () => logger.log("🛑 MQTT end"));

mqttClient.on("connect", () => {
  logger.log("MQTT connected");

  subscribe(`esp32/${RBC_ID}/sensor`, { qos: 2 });

  // already covers obu/ai/alert too (plus any other pi topics)
  subscribe(["obu/status", "obu/ai/#", "obu/safety/#"], { qos: 1 });
  subscribe(TRAIN_CMD_META_TOPIC, { qos: 1 });
  subscribe(VIDEO_PING_TOPIC, { qos: 0 });

  startHandshake(); // auto
});

mqttClient.on("error", (err) => logger.log("MQTT error:", err?.message || err));
mqttClient.on("message", (topic, payload) => processMessage(topic, payload));

// keep the same 1s interval behavior
setInterval(autoRequestMaIfReady, 1000);
