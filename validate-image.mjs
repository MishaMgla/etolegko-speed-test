import * as zlib from 'node:zlib';

if (typeof zlib.crc32 !== 'function') {
  throw new Error('Image validation requires Node.js 22.2 or later');
}

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const signatureBytes = 12;
const maxImageBytes = 64 * 1_048_576;

function detectFormat(prefix) {
  if (prefix.subarray(0, pngSignature.length).equals(pngSignature)) return 'PNG';
  if (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return 'JPEG';
  if (prefix.toString('latin1', 0, 4) === 'RIFF' && prefix.toString('latin1', 8, 12) === 'WEBP') return 'WebP';
  return null;
}

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
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') return 'animated PNG is unsupported';
    if (type === 'IEND') {
      if (length !== 0 || end !== buffer.length) throw new Error('invalid IEND');
      return;
    }
    offset = end;
  }
  throw new Error('missing IEND');
}

async function validateImage(buffer, format, requirePng) {
  try {
    let reason;
    if (format === 'PNG') {
      reason = validateChunks(buffer);
    } else if (format === 'JPEG') {
      if (buffer.readUInt16BE(buffer.length - 2) !== 0xffd9) throw new Error('missing EOI marker');
    } else {
      if (buffer.readUInt32LE(4) + 8 !== buffer.length) throw new Error('RIFF length does not match the body');
      if (buffer.toString('latin1', 12, 16) === 'VP8X' && (buffer[20] & 2) !== 0) {
        reason = 'animated WebP is unsupported';
      }
    }
    if (reason && requirePng) throw new Error(reason);
    if (reason) return { reason };
  } catch (error) {
    throw new Error(`invalid ${format}: ${error.message}`);
  }

  const { default: sharp } = await import('sharp').catch((error) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') throw new Error('Image validation requires npm ci');
    throw error;
  });

  try {
    await sharp(buffer, { failOn: 'warning', limitInputPixels: 16_000_000 }).raw().toBuffer();
  } catch (error) {
    throw new Error(`invalid ${format}: ${error.message}`);
  }
  return { format };
}

export function collectImage(requirePng, reason) {
  let chunks = reason ? null : [];
  let format = requirePng ? 'PNG' : null;
  let bytes = 0;

  return {
    add(chunk) {
      if (!chunks) return;
      bytes += chunk.length;
      if (bytes > maxImageBytes) {
        if (requirePng) throw new Error('PNG exceeds the 64 MiB validation limit');
        chunks = null;
        reason = 'body exceeds 64 MiB';
        return;
      }
      chunks.push(chunk);
      if (!format && bytes >= signatureBytes) {
        format = detectFormat(Buffer.concat(chunks, signatureBytes));
        if (!format) {
          chunks = null;
          reason = 'unsupported format';
        }
      }
    },

    async finish() {
      if (reason) return { reason };
      const buffer = Buffer.concat(chunks, bytes);
      format ??= detectFormat(buffer);
      return format ? validateImage(buffer, format, requirePng) : { reason: 'unsupported format' };
    },
  };
}
