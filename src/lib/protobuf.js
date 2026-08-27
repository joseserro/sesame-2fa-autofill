// Just enough protobuf to read and write Google Authenticator migration payloads.

export function createReader(bytes) {
  let pos = 0;
  return {
    get done() {
      return pos >= bytes.length;
    },
    varint() {
      let result = 0n;
      let shift = 0n;
      for (;;) {
        if (pos >= bytes.length) throw new Error('Truncated varint');
        const b = bytes[pos++];
        result |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7n;
        if (shift > 70n) throw new Error('Varint too long');
      }
      return result;
    },
    slice(len) {
      if (pos + len > bytes.length) throw new Error('Truncated field');
      const out = bytes.subarray(pos, pos + len);
      pos += len;
      return out;
    },
    skip(wireType) {
      if (wireType === 0) this.varint();
      else if (wireType === 1) pos += 8;
      else if (wireType === 2) this.slice(Number(this.varint()));
      else if (wireType === 5) pos += 4;
      else throw new Error(`Unsupported wire type ${wireType}`);
    },
  };
}

/** Walk every field in a message, handing (fieldNumber, value) to `visit`. */
export function eachField(bytes, visit) {
  const r = createReader(bytes);
  while (!r.done) {
    const key = Number(r.varint());
    const field = key >>> 3;
    const wireType = key & 7;
    if (wireType === 2) visit(field, r.slice(Number(r.varint())), wireType);
    else if (wireType === 0) visit(field, r.varint(), wireType);
    else r.skip(wireType);
  }
}

export function createWriter() {
  let out = [];
  const api = {
    varint(value) {
      let v = BigInt(value);
      if (v < 0n) throw new Error('Negative varint');
      do {
        let byte = Number(v & 0x7fn);
        v >>= 7n;
        if (v > 0n) byte |= 0x80;
        out.push(byte);
      } while (v > 0n);
      return api;
    },
    tag(field, wireType) {
      return api.varint((field << 3) | wireType);
    },
    uint(field, value) {
      return api.tag(field, 0).varint(value);
    },
    bytes(field, value) {
      api.tag(field, 2).varint(value.length);
      out.push(...value);
      return api;
    },
    string(field, value) {
      return api.bytes(field, new TextEncoder().encode(value));
    },
    finish() {
      return new Uint8Array(out);
    },
  };
  return api;
}

export const utf8 = (bytes) => new TextDecoder().decode(bytes);
