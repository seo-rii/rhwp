const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function decodeBase64(base64: string): Uint8Array {
  const runtimeAtob = globalThis.atob;
  if (typeof runtimeAtob === 'function') {
    const binary = runtimeAtob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let idx = 0; idx < binary.length; idx += 1) {
      bytes[idx] = binary.charCodeAt(idx);
    }
    return bytes;
  }

  const normalized = base64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (normalized.length === 0) {
    return new Uint8Array();
  }
  if (normalized.length % 4 === 1) {
    throw new Error('Invalid base64 payload length');
  }
  const firstPadding = normalized.indexOf('=');
  if (firstPadding >= 0 && !/^=+$/.test(normalized.slice(firstPadding))) {
    throw new Error('Invalid base64 padding');
  }
  const bytes = new Uint8Array(Math.floor((normalized.length * 3) / 4));
  let outputLength = 0;
  let accumulator = 0;
  let bits = 0;
  for (const char of normalized) {
    if (char === '=') {
      break;
    }
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) {
      throw new Error('Invalid base64 character');
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[outputLength] = (accumulator >> bits) & 0xff;
      outputLength += 1;
    }
  }
  return bytes.subarray(0, outputLength);
}
