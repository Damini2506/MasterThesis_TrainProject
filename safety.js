/**
 * @file safety.js
 * @brief Implements secure message wrapping and unwrapping using CMAC authentication and CRC integrity for ETCS.
 *
 * This module provides encryption-like safety encapsulation for ETCS messages via:
 * - Session key initialization and expansion
 * - CMAC-based MAC computation (AES-128)
 * - CRC-16 for end-to-end integrity
 * - Message wrapping/unwrapping with structured payloads
 *
 * It supports different key usage based on message type (KS1/KS2/KS3).
 */

const crypto = require('crypto');
const { Buffer } = require('buffer');
const { packMessage } = require("./bitwise");
const messageTemplates = require("./messages.json"); // assuming available

let sessionKeys = null;

const CRC16_POLY = 0x1021;
const AES_IV = Buffer.alloc(16, 0);
const MAC_LENGTH = 4;

/**
 * @brief Initializes session keys required for secure PDU wrapping/unwrapping.
 * 
 * @param {Object} keys - An object with hexadecimal string keys: { ks1, ks2, ks3 }.
 */
exports.setSessionKeys = (keys) => {
  sessionKeys = {
    ks1: Buffer.from(keys.ks1, 'hex'),
    ks2: Buffer.from(keys.ks2, 'hex'),
    ks3: Buffer.from(keys.ks3, 'hex')
  };
  console.log("\u2705 Session Keys Initialized in safety.js:", keys);
};

/**
 * @brief Clears previously set session keys.
 */
exports.clearSessionKeys = () => {
  sessionKeys = null;
  console.log("Session keys cleared");
};

/**
 * @brief Expands a 64-bit session key to 128 bits by repeating it.
 * 
 * @param {Buffer} shortKey - A 64-bit key buffer.
 * @return {Buffer} A 128-bit buffer formed by duplicating the short key.
 */
function expandKey(shortKey) {
  return Buffer.concat([shortKey, shortKey]);
}

/**
 * @brief Computes CRC-16 checksum for a given buffer using polynomial 0x1021.
 * 
 * @param {Buffer} buf - Input buffer to compute the checksum for.
 * @return {Buffer} A 2-byte buffer representing the CRC-16 result.
 */
function crc16(buf) {
  let crc = 0xFFFF;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ CRC16_POLY : crc << 1;
    }
  }
  return Buffer.from([(crc >> 8) & 0xFF, crc & 0xFF]);
}

/**
 * @brief Calculates a 4-byte CMAC (AES-based MAC) for message authentication.
 * 
 * @param {Buffer} message - Message payload to authenticate.
 * @param {Buffer} key - 128-bit key used for CMAC generation.
 * @return {Buffer} The last 4 bytes of the AES-CMAC result.
 */
function calculateCMAC(message, key) {
  const blockSize = 16;
  const paddingLength = blockSize - (message.length % blockSize);
  const padded = Buffer.concat([message, Buffer.alloc(paddingLength, 0)]);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, AES_IV);
  cipher.setAutoPadding(false);
  const result = Buffer.concat([cipher.update(padded), cipher.final()]);
  return result.slice(-MAC_LENGTH);
}

/**
 * @brief Constructs a 1-byte safety protocol header.
 * 
 * @param {number} dir - Direction bit (0 = downlink, 1 = uplink).
 * @param {number} mti - Message Type Identifier (default 0b101).
 * @param {number} ety - Entity type (default 0b000).
 * @return {Buffer} A single-byte header buffer.
 */
function header(dir = 1, mti = 0b101, ety = 0b000) {
  return Buffer.from([(ety << 5) | (mti << 1) | (dir & 1)]);
}

/**
 * @brief Selects the appropriate session key based on NID_MESSAGE type.
 * 
 * @param {number} nid_message - The ETCS message ID (e.g., 132, 136).
 * @return {Buffer} A 128-bit key buffer suitable for CMAC use.
 * @throws If session keys are not initialized.
 */
function getKeyForMessageType(nid_message) {
  if (!sessionKeys) throw new Error("Session keys not initialized.");
  switch(nid_message) {
    case 132: return expandKey(sessionKeys.ks2);
    case 136: return expandKey(sessionKeys.ks3);
    default: return expandKey(sessionKeys.ks1);
  }
}

/**
 * @brief Returns a human-readable key type label based on NID_MESSAGE.
 * 
 * @param {number} nid - ETCS message ID.
 * @return {string} Description of key purpose (e.g., "KS2 (MA Request)").
 */
function keyType(nid) {
  switch(nid) {
    case 132: return "KS2 (MA Request)";
    case 136: return "KS3 (Emergency)";
    default: return "KS1 (Default)";
  }
}

/**
 * @brief Encodes sub-packets attached to a message using field specs.
 * 
 * @param {Object} values - Message values containing sub-packet structures.
 * @param {string[]} subPacketNames - List of sub-packet spec keys to encode.
 * @return {Buffer} Concatenated binary buffer of encoded sub-packets.
 */
function packSubPackets(values, subPacketNames) {
  const buffers = [];
  for (const name of subPacketNames) {
    const def = messageTemplates[name];
    const pktValues = values[name];
    if (!def || !pktValues) continue;

    const baseFields = def.fields.filter(f => !f.repeat);
    const repeatFields = def.fields.filter(f => f.repeat);

    const baseBuf = packMessage({ fields: baseFields, values: pktValues });
    buffers.push(baseBuf);

    const nIterField = repeatFields[0]?.repeat;
    const sections = pktValues.sections || [];
    for (let i = 0; i < sections.length; i++) {
      const sectionValues = {};
      for (const rf of repeatFields) {
        const base = rf.name.replace(/_k$/, "");
        sectionValues[rf.name] = sections[i][base];
      }
      buffers.push(packMessage({ fields: repeatFields, values: sectionValues }));
    }
  }
  return Buffer.concat(buffers);
}

/**
 * @brief Wraps a binary ETCS payload into a secure PDU using CMAC and CRC.
 * 
 * @param {Object} template - The message template spec.
 * @param {Object} values - Field values used to populate the message.
 * @param {number} dir - Direction bit (1 = uplink, 0 = downlink).
 * @return {Buffer} Fully wrapped PDU buffer.
 */
exports.wrapSaPdu = (template, values, dir = 1) => {
  if (!template || !values) throw new Error("Invalid template or values");

  console.log("\n--- Building Secure PDU ---");
  const hdr = header(dir);
  console.log("1) Safety Header:", hdr.toString('hex'), `(Direction: ${dir}, MTI: 5, ETY: 0)`);

  let pay = packMessage({ ...template, values }, messageTemplates);
/*
  if (template.subPackets?.length) {
    const extra = packSubPackets(values, template.subPackets);
    if (extra) pay = Buffer.concat([pay, extra]);
  }
*/
  console.log("2) Payload:", pay.toString('hex'));
  console.log("   NID_MESSAGE:", pay[0].toString(16).padStart(2, '0'), `(${values.NID_MESSAGE})`);

  let mac;
  try {
    const key = getKeyForMessageType(values.NID_MESSAGE);
    mac = calculateCMAC(pay, key);
    console.log("3) MAC:", mac.toString('hex'), `(Using ${keyType(values.NID_MESSAGE)})`);
  } catch (err) {
    console.error("MAC calculation failed:", err.message);
    mac = Buffer.alloc(MAC_LENGTH, 0);
  }

  const msg = Buffer.concat([hdr, pay, mac]);
  const crc = crc16(msg);
  const pdu = Buffer.concat([msg, crc]);

  console.log("4) CRC-16:", crc.toString('hex'), "(Calculated over Header + Payload + MAC)");
  console.log("\nFinal PDU Structure:");
  console.log("| Header |       Payload        |    MAC   |  CRC-16 |");
  console.log(`|   ${hdr.toString('hex')}   | ${pay.toString('hex')} | ${mac.toString('hex')} | ${crc.toString('hex')} |`);
  console.log(`Total Length: ${pdu.length} bytes\n`);

  return pdu;
};

/**
 * @brief Validates and extracts payload from a secure PDU, verifying CRC and MAC.
 * 
 * @param {Buffer} pduBuf - Received secure message buffer.
 * @return {Object} Object indicating success or failure, and the unwrapped payload if successful.
 */
exports.unwrapSaPdu = (pduBuf) => {
  try {
    const HEADER_LEN = 1;
    const MAC_LEN = 4;
    const CRC_LEN = 2;

    if (pduBuf.length < HEADER_LEN + MAC_LEN + CRC_LEN) {
      return { ok: false, err: "Too short" };
    }

    const hdr = pduBuf.slice(0, HEADER_LEN);
    const payload = pduBuf.slice(HEADER_LEN, -MAC_LEN - CRC_LEN);
    const mac = pduBuf.slice(-MAC_LEN - CRC_LEN, -CRC_LEN);
    const crc = pduBuf.slice(-CRC_LEN);

    const reconstructed = Buffer.concat([hdr, payload, mac]);
    const computedCrc = crc16(reconstructed);
    if (!computedCrc.equals(crc)) return { ok: false, err: "CRC mismatch" };

    const nid = payload[0];
    const key = getKeyForMessageType(nid);
    const computedMac = calculateCMAC(payload, key);
    if (!computedMac.equals(mac)) return { ok: false, err: "MAC mismatch" };

    return { ok: true, payloadBuf: payload };
  } catch (err) {
    return { ok: false, err: "Exception: " + err.message };
  }
};