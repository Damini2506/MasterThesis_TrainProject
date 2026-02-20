    /**
 * @file amqp-to-mqtt_V2.js
 * @brief Bridges ETCS messages between AMQP (RabbitMQ) and MQTT systems, handling secure message unwrapping and routing.
 *
 * Core responsibilities:
 * - Connect and listen to RabbitMQ queues (OBU → RBC and RBC → OBU).
 * - Connect and subscribe to MQTT topics to receive session keys.
 * - Unwrap secure messages and decode ETCS payloads.
 * - Route decoded messages from AMQP to MQTT.
 *
 * PATCH (KPI meta preservation):
 * - If an AMQP message body has a "~META" JSON trailer appended (by mqtt-to-amqp),
 *   extract it and merge back into the decoded MQTT JSON object before publishing.
 * - Also stamp t_send_ms/t_app_ms at the bridge (final JSON publisher), so Remote OBU
 *   and RBC UI can compute net delays consistently.
 */

import amqp from "amqplib";
import mqtt from "mqtt";
import { unpackMessage } from "./bitwise.js";
import { unwrapSaPdu, setSessionKeys } from "./safety.js";
import specs from "./messages.json" assert { type: "json" };

const Q_OBU = "obu_to_rbc";
const Q_RBC = "rbc_to_obu";
const RBC_ID = "DE0001";

/**
 * @brief Resolves the message specification based on NID_MESSAGE identifier.
 * @param {number} nid - Message ID to match with specification.
 * @return {Object|null} The corresponding message spec from `messages.json`, or null if not found.
 */
function specByNid(nid) {
  return (
    {
      3: specs.message3,
      8: specs.message8,
      32: specs.message32,
      38: specs.message38,
      39: specs.message39,
      41: specs.message41,
      129: specs.message129,
      132: specs.message132,
      136: specs.message136,
      146: specs.message146,
      150: specs.message150,
      156: specs.message156,
      154: specs.message154,
      155: specs.message155,
      157: specs.message157,
      159: specs.message159
    }[nid] || null
  );
}

// -------------------- META TRAILER HELPERS (NEW) --------------------
function extractMetaTrailer(buf) {
  // Trailer format: "~META" + uint32be(len) + json_bytes
  // magic bytes: 0x7E 0x4D 0x45 0x54 0x41
  if (!Buffer.isBuffer(buf) || buf.length < 9) return { base: buf, meta: null };

  const magic = Buffer.from([0x7E, 0x4D, 0x45, 0x54, 0x41]);
  const idx = buf.lastIndexOf(magic);
  if (idx === -1) return { base: buf, meta: null };

  // Need at least magic(5) + len(4)
  if (idx + 9 > buf.length) return { base: buf, meta: null };

  const len = buf.readUInt32BE(idx + 5);
  const jsonStart = idx + 9;
  const jsonEnd = jsonStart + len;

  if (jsonEnd > buf.length) return { base: buf, meta: null };

  const jsonBuf = buf.slice(jsonStart, jsonEnd);
  let meta = null;
  try {
    meta = JSON.parse(jsonBuf.toString("utf8"));
  } catch {
    meta = null;
  }

  // Base buffer excludes the trailer
  const base = buf.slice(0, idx);
  return { base, meta };
}
// -------------------------------------------------------------------

(async () => {
  try {
    // 1. RabbitMQ Setup
    const rabbit = await amqp.connect("amqp://obu:obu1234@192.168.4.4:5672");
    const ch = await rabbit.createChannel();

    await ch.assertQueue(Q_OBU, { durable: true });
    await ch.assertQueue(Q_RBC, { durable: true });
    console.log("AMQP queues ready");

    // 2. MQTT Setup
    const mqt = mqtt.connect("mqtt://192.168.4.4:1883");

    // 3. Handle key updates from OBU
    mqt.on("connect", () => {
      console.log("MQTT connected");
      mqt.subscribe(`obu/${RBC_ID}/keys`, { qos: 1 });
    });

    mqt.on("message", (topic, payload) => {
      if (topic === `obu/${RBC_ID}/keys`) {
        try {
          const keys = JSON.parse(payload.toString());
          if (keys.ks1 && keys.ks2 && keys.ks3) {
            setSessionKeys(keys);
            console.log("✅ Session keys updated from OBU");
          }
        } catch (err) {
          console.error("Failed to parse session keys:", err);
        }
      }
    });

    /**
     * @brief Handles incoming AMQP messages, attempts to unwrap them securely or fallback to raw parsing.
     *        Routes the valid decoded payload to an MQTT topic based on queue origin.
     *
     * @param {string} queueName - The name of the queue the message was received from.
     * @param {Object} msg - AMQP message object containing the payload buffer.
     * @return {Promise<void>} Resolves once the message is processed and acknowledged.
     */
    async function handleMessage(queueName, msg) {
      if (!msg) return;

      try {
        // ---- NEW: strip & parse "~META" trailer if present ----
        const { base: contentBase, meta } = extractMetaTrailer(msg.content);

        let payloadBuf;

        // Try to unwrap secured message first
        const safetyResult = unwrapSaPdu(contentBase);

        if (safetyResult.ok) {
          payloadBuf = safetyResult.payloadBuf;
        }
        // If safety check fails, try to parse as unsecured message
        else if (safetyResult.err.includes("Session keys not initialized")) {
          console.warn("Processing as unsecured message (no session keys)");
          payloadBuf = contentBase; // Use raw message (without trailer)
        } else {
          console.warn(`Safety check failed (${safetyResult.err}) - message dropped`);
          ch.ack(msg);
          return;
        }

        const nid = payloadBuf[0];
        const spec = specByNid(nid);
        if (!spec) {
          console.warn("Unknown NID_MESSAGE:", nid);
          ch.ack(msg);
          return;
        }

        const { decoded: obj } = unpackMessage(spec, payloadBuf, specs);

        // Mark as AMQP-origin to avoid loops and enforce RBC gating
        obj.origin = "amqp";

        // ---- NEW: stamp bridge send times (final JSON publisher) ----
        const now = Date.now();
        obj.t_app_ms = obj.t_app_ms ?? now;
        obj.t_send_ms = obj.t_send_ms ?? now;
        
        // add explicit bridge stamps (new, unambiguous)
        obj.t_bridge_app_ms  = obj.t_bridge_app_ms  ?? now;
        obj.t_bridge_send_ms = obj.t_bridge_send_ms ?? now;

        // ---- NEW: merge extracted meta fields back into decoded object ----
        if (meta && typeof meta === "object") {
          // Merge only if target doesn't already have the field
          for (const [k, v] of Object.entries(meta)) {
            if (obj[k] === undefined) obj[k] = v;
          }
          // Helpful flag for debugging
          obj.meta_from_trailer = true;
        } else {
          obj.meta_from_trailer = false;
        }

        // Determine target MQTT topic
        let targetTopic;
        if (queueName === Q_RBC) {
          targetTopic = `rbc/${RBC_ID}/out`; // RBC → OBU
          obj.bridge_dir = "rbc_to_obu";
        } else if (queueName === Q_OBU) {
          targetTopic = `rbc/${RBC_ID}/in`; // OBU → RBC
          obj.bridge_dir = "obu_to_rbc";
        } else {
          ch.ack(msg);
          return;
        }

        console.log(`Routing AMQP→MQTT [${nid}] to ${targetTopic}`);
        mqt.publish(targetTopic, JSON.stringify(obj), { qos: 1 });
        ch.ack(msg);
      } catch (err) {
        console.error("Message processing failed:", err);
        ch.ack(msg);
      }
    }

    // Start consumers
    ch.consume(Q_RBC, (msg) => handleMessage(Q_RBC, msg));
    ch.consume(Q_OBU, (msg) => handleMessage(Q_OBU, msg));

    // Error handlers
    mqt.on("error", (err) => console.error("MQTT Error:", err));
    ch.on("error", (err) => console.error("AMQP Error:", err));

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

