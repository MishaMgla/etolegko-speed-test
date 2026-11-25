import * as zlib from 'node:zlib';

if (typeof zlib.crc32 !== 'function') {
  throw new Error('PNG validation requires Node.js 22.2 or later');
}

const { default: sharp } = await import('sharp').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') throw new Error('PNG validation requires npm ci');
  throw error;
});

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

function validateChunks(buffer) {
  if (!buffer.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error('missing PNG signature');
  }

  let offset = pngSignature.length;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > buffer.length) throw new Error('truncated chunk');

    const type = buffer.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('invalid chunk type');
    const crc = zlib.crc32(buffer.subarray(offset + 4, end - 4));
    if (crc !== buffer.readUInt32BE(end - 4)) throw new Error(`CRC mismatch in ${type}`);
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new Error('animated PNG is unsupported');
    if (type === 'IEND') {
      if (length !== 0 || end !== buffer.length) throw new Error('invalid IEND');
      return;
    }
    offset = end;
  }
  throw new Error('missing IEND');
}

export async function validatePng(buffer) {
  try {
    validateChunks(buffer);
    await sharp(buffer, { failOn: 'warning', limitInputPixels: 16_000_000 }).raw().toBuffer();
  } catch (error) {
    throw new Error(`invalid PNG: ${error.message}`);
  }
}
