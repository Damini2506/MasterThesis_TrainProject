/**
 * @file bitwise.js
 * @brief Provides binary packing and unpacking utilities for ETCS messages using bit-level precision.
 *
 * This module contains two main functions:
 * - `packMessage`: Converts a JSON-based ETCS message object into a packed binary buffer.
 * - `unpackMessage`: Extracts structured fields from binary data according to message specifications.
 *
 * It also supports repeated sections (`N_ITER`) and optional sub-packets when specified.
 */

import { BitView } from 'bit-buffer';


/**
 * @brief Packs a structured ETCS message into a binary buffer using field definitions.
 * 
 * @param {Object} messageSpec - The specification object containing fields and default values.
 * @param {Object} allSpecs - Lookup table for sub-packets and nested message types.
 * @param {Object} parentValues - Optional parent field values to merge with defaults.
 * @return {Buffer} Binary buffer representing the encoded message.
 */
function packMessage(messageSpec, allSpecs = {}, parentValues = {}) {
  const fields = messageSpec.fields || [];
  const values = { ...messageSpec.values, ...parentValues };
  let buffers = [];

  console.log('--- Packing Message ---');

  const nonRepeatedFields = fields.filter(f => !f.repeat);
  let bitOffset = 0;
  const nonRepeatedBuffer = Buffer.alloc(Math.ceil(
    nonRepeatedFields.reduce((sum, f) => sum + f.bits, 0) / 8
  ));
  const nonRepeatedView = new BitView(nonRepeatedBuffer.buffer);

  for (const field of nonRepeatedFields) {
    const name = field.name;
    const bits = field.bits;
    const value = Number(values[name]);

    if (isNaN(value)) throw new Error(`Invalid value for ${name}: must be a number`);
    if (value > (2 ** bits) - 1) throw new Error(`Value ${value} exceeds max for ${name}`);

    console.log(`Field: ${name}, Bits: ${bits}, Value: ${value}, Offset: ${bitOffset}`);
    nonRepeatedView.setBits(bitOffset, value, bits);
    bitOffset += bits;
  }
  buffers.push(nonRepeatedBuffer);

  const nIterField = fields.find(f => f.name === 'N_ITER');
  if (nIterField && values.N_ITER > 0) {
    const repeatFields = fields.filter(f => f.repeat);
    const sections = values.sections || [];

    console.log(`Processing ${values.N_ITER} repeated sections`);
const totalBits = values.N_ITER * repeatFields.reduce((sum, f) => sum + f.bits, 0);
const sectionBuffer = Buffer.alloc(Math.ceil(totalBits / 8));
const sectionView = new BitView(sectionBuffer.buffer);
let sectionBitOffset = 0;

for (let i = 0; i < values.N_ITER && i < sections.length; i++) {
  for (const field of repeatFields) {
    const baseName = field.name.replace(/_k$/, "");
    const value = Number(sections[i][baseName]);
    
    if (isNaN(value)) throw new Error(`Invalid value for ${baseName} in section ${i}`);
    if (value > (2 ** field.bits) - 1) throw new Error(`Value ${value} too large for ${baseName}`);

    console.log(`Section ${i} Field: ${field.name}, Bits: ${field.bits}, Value: ${value}, Offset: ${sectionBitOffset}`);
    sectionView.setBits(sectionBitOffset, value, field.bits);
    sectionBitOffset += field.bits;
  }
}
buffers.push(sectionBuffer);

  }

  if (messageSpec.subPackets?.length && Object.keys(allSpecs).length > 0) {
    for (const subName of messageSpec.subPackets) {
      const subSpec = allSpecs[subName];
      const subValues = values[subName];
      if (!subSpec || !subValues) continue;

      console.log(`Packing subPacket: ${subName}`);
      const subBuf = packMessage(subSpec, allSpecs, subValues);
      buffers.push(subBuf);
    }
  }

  console.log('--- Packing Successful ---');
  return Buffer.concat(buffers);
}


/**
 * @brief Decodes a binary buffer into structured ETCS message fields using a message specification.
 * 
 * @param {Object} messageSpec - Specification object describing expected fields and sub-packets.
 * @param {Buffer} buffer - Raw binary buffer to decode.
 * @param {Object} allSpecs - Optional specification set used for decoding nested structures.
 * @param {number} parentOffset - Bit offset to start decoding from (used for sub-packets).
 * @return {Object} Contains decoded field data and final bit offset.
 */
function unpackMessage(messageSpec, buffer, allSpecs = {}, parentOffset = 0) {
  console.log('[DEBUG] unpackMessage started');
  console.log(`Buffer length: ${buffer.length} bytes`);

  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  const bitView = new BitView(arrayBuffer);
  bitView.bigEndian = false;

  let bitOffset = parentOffset;
  const decoded = {};
  const totalBitsAvailable = bitView.byteLength * 8;

  console.log('--- Unpacking Base Message ---');

  const nonRepeatedFields = (messageSpec.fields || []).filter(f => !f.repeat);
  for (const field of nonRepeatedFields) {
    if (bitOffset + field.bits > totalBitsAvailable) {
      console.warn(`⚠️ Not enough bits for field ${field.name}`);
      break;
    }

    const value = bitView.getBits(bitOffset, field.bits);
    decoded[field.name] = value;
    console.log(`Field: ${field.name}, Bits: ${field.bits}, Value: ${value}, Offset: ${bitOffset}`);
    bitOffset += field.bits;
  }

// In the repeated sections handling part, replace with:
if (decoded.N_ITER > 0) {
  const repeatFields = (messageSpec.fields || []).filter(f => f.repeat);
  if (repeatFields.length > 0) {
    decoded.sections = [];
    
    // Ensure byte alignment
    if (bitOffset % 8 !== 0) {
      const padding = 8 - (bitOffset % 8);
      bitOffset += padding;
      console.log(`Added ${padding} bits padding before sections`);
    }

    const bitsPerSection = repeatFields.reduce((sum, f) => sum + f.bits, 0);
    const totalSectionBits = decoded.N_ITER * bitsPerSection;
    
    if (bitOffset + totalSectionBits > totalBitsAvailable) {
      throw new Error(`Not enough bits for ${decoded.N_ITER} sections`);
    }

    for (let i = 0; i < decoded.N_ITER; i++) {
      const section = {};
      for (const field of repeatFields) {
        const val = bitView.getBits(bitOffset, field.bits);
        section[field.name.replace(/_k$/, "")] = val;
        console.log(`Section ${i} Field: ${field.name}, Bits: ${field.bits}, Value: ${val}, Offset: ${bitOffset}`);
        bitOffset += field.bits;
      }
      decoded.sections.push(section);
    }
  }
}
// Peek and unpack subpackets
if (messageSpec.subPackets?.length && Object.keys(allSpecs).length > 0) {
  for (const subName of messageSpec.subPackets) {
    const subSpec = allSpecs[subName];
    if (!subSpec) continue;

    // Align to next byte before peeking
    if (bitOffset % 8 !== 0) {
      console.warn(`⚠️ Misaligned offset before subpacket: ${bitOffset}, rounding up`);
      bitOffset += 8 - (bitOffset % 8);
    }

    // Ensure at least 8 bits left
    if (bitOffset + 8 > totalBitsAvailable) break;

    const nid_packet = bitView.getBits(bitOffset, 8);
    const expected_nid = subSpec.values?.NID_PACKET;

    console.log(`Peeking for subpacket '${subName}': got NID_PACKET=${nid_packet}, expected=${expected_nid}`);

// Change this part in the subpacket handling:
if (nid_packet === expected_nid) {
  console.log(`--- Unpacking Subpacket: ${subName} (NID_PACKET=${nid_packet}) ---`);
  // Remove the +8 offset since we want to include the NID_PACKET in the unpacking
  const result = unpackMessage(subSpec, buffer, allSpecs, bitOffset);
  
  decoded[subName] = result.decoded;
  bitOffset = result.bitOffset;
} else {
      console.warn(`❌ Skipped subpacket '${subName}': NID_PACKET mismatch at offset ${bitOffset}`);
    }
  }
}




  console.log('--- Unpacking Successful ---');
  console.log(`Final bit offset: ${bitOffset}/${totalBitsAvailable}`);
  console.log('Final decoded object:', JSON.stringify(decoded, null, 2));
  return { decoded, bitOffset };
}

export { packMessage, unpackMessage };
