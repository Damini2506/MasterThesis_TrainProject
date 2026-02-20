/**
 * @file mqtt-to-amqp_V2.js
 * @brief Routes decoded ETCS messages from MQTT to AMQP, applying cryptographic safety encapsulation.
 *
 * This script connects to an MQTT broker, listens for ETCS messages and key updates,
 * and forwards secure messages to corresponding AMQP queues. It uses message templates
 * to validate and construct binary payloads before wrapping them in a secure envelope.
 *
 * Responsibilities:
 * - Connect to MQTT and AMQP brokers.
 * - Subscribe to topics for keys and ETCS messages.
 * - Ignore MQTT messages forwarded from AMQP (avoid loops).
 * - Wrap ETCS messages using CMAC and CRC for transmission.
 * - Route wrapped messages to the correct AMQP queue.
 */


const amqp = require("amqplib");
const mqtt = require("mqtt");
const { wrapSaPdu, setSessionKeys } = require("./safety");
const specs = require("./messages.json");

const Q_OBU = "obu_to_rbc";
const Q_RBC = "rbc_to_obu";
const RBC_ID = "DE0001"; // Fixed RBC ID

function appendMetaTrailer(buf, metaObj) {
  // Format: "~META" + uint32be(len) + json_bytes
  const magic = Buffer.from([0x7E, 0x4D, 0x45, 0x54, 0x41]); // "~META"
  const json = Buffer.from(JSON.stringify(metaObj ?? {}), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length, 0);
  return Buffer.concat([buf, magic, len, json]);
}

(async () => {
  try {
    // 1. RabbitMQ on laptop
    const rabbit = await amqp.connect("amqp://obu:obu1234@192.168.4.4:5672");
    const ch = await rabbit.createChannel();

    await ch.assertQueue(Q_OBU, { durable: true });
    await ch.assertQueue(Q_RBC, { durable: true });
    console.log("AMQP queues ready");

    // 2. MQTT Setup
    const mqt = mqtt.connect("mqtt://192.168.4.4:1883");

/**
 * @brief Handles incoming MQTT messages: processes key updates or wraps ETCS messages.
 *
 * @param {string} topic - MQTT topic the message was received on.
 * @param {Buffer} payload - Buffer containing the MQTT message.
 * @return {Promise<void>} Resolves after message processing and AMQP forwarding (if applicable).
 */

    mqt.on("connect", () => {
      console.log("MQTT connected");
      mqt.subscribe([
        `obu/${RBC_ID}/keys`,       // Key updates from OBU
        `rbc/${RBC_ID}/in`,         // Messages from OBU to RBC
        `rbc/${RBC_ID}/out`         // Messages from RBC to OBU
      ], { qos: 1 });
    });

    // 3. MQTT Message Handler
    mqt.on("message", async (topic, payload) => {
      try {
        const obj = JSON.parse(payload.toString());

        // Skip messages forwarded by AMQP bridge
        if (obj.origin === "amqp") return;

        // Handle KEY_UPDATE message
        if (topic.endsWith("/keys") && obj.type === "KEY_UPDATE") {
          if (obj.ks1 && obj.ks2 && obj.ks3) {
            setSessionKeys(obj);
            console.log("Session keys updated from OBU");
          }
          return;
        }

        // Validate ETCS message
        if (!obj.NID_MESSAGE) return;

        const spec = specs[`message${obj.NID_MESSAGE}`];
        if (!spec) {
          console.warn(`Unsupported NID_MESSAGE: ${obj.NID_MESSAGE}`);
          return;
        }

        // Determine direction
        let targetQueue;
        if (topic.includes('/in')) {
          targetQueue = Q_OBU; // OBU → RBC
        } else if (topic.includes('/out')) {
          targetQueue = Q_RBC; // RBC → OBU
        } else {
          return;
        }

        // Add safety layer and send to AMQP
const values = structuredClone(spec.values || {});
Object.assign(values, obj);

// Preserve subpacket structure
if (spec.subPackets?.length) {
  for (const sub of spec.subPackets) {
    if (obj[sub]) {
      values[sub] = obj[sub];
    }
  }
}

const securedPdu = wrapSaPdu(
  spec,
  values,
  targetQueue === Q_OBU ? 1 : 0
);


        console.log(`Routing MQTT→AMQP [${obj.NID_MESSAGE}] to ${targetQueue}`);
        const now = Date.now();

// keep your existing JSON fields (don't overwrite if already present)
obj.t_app_ms  = obj.t_app_ms  ?? now;
obj.t_send_ms = obj.t_send_ms ?? now;

// add an explicit bridge timestamp (super useful for KPI debug)
obj.t_m2a_send_ms = now;

// pick what you want preserved through the binary safety layer
const meta = {
  msg_id: obj.msg_id,
  ts_iso: obj.ts_iso,
  trainNo: obj.trainNo,
  type: obj.type,

  t_app_ms: obj.t_app_ms,
  t_send_ms: obj.t_send_ms,
  t_m2a_send_ms: obj.t_m2a_send_ms,

  origin: "mqtt",      // helps loop-prevention and debugging
  topic_in: topic,
};

const securedWithMeta = appendMetaTrailer(Buffer.from(securedPdu), meta);

console.log(`Routing MQTT?AMQP [${obj.NID_MESSAGE}] to ${targetQueue}`);
ch.sendToQueue(targetQueue, securedWithMeta, { persistent: true });

      } catch (err) {
        console.error(`MQTT processing failed [${topic}]:`, err);
      }
    });

    // Error handlers
    mqt.on("error", err => console.error("MQTT Error:", err));
    ch.on("error", err => console.error("AMQP Error:", err));

    // Clean shutdown
    process.on("SIGINT", async () => {
      console.log("Shutting down...");
      await rabbit.close();
      mqt.end();
      process.exit(0);
    });

  } catch (err) {
    console.error("Initialization failed:", err);
    process.exit(1);
  }
})();
