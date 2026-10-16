// 存档编码：JSON → LZString 压缩 → 固定密钥流混淆 → base64，最后带一段校验和。
// 风格参考增量游戏的存档串：短、不可读、防手改。
// 说明：密钥写在代码里，所以这是「混淆 + 完整性校验」，不是密码级加密。

const MAGIC = "DIN1";
const KEY = "dinning-save-v1-2026";

function keystreamByte(i) {
  return (KEY.charCodeAt(i % KEY.length) + i * 31) & 0xff;
}

function xorBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ keystreamByte(i);
  return out;
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// FNV-1a 32 位：用来发现抄漏、抄错、截断
export function checksum(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function encodeSave(data, LZ) {
  const json = JSON.stringify(data);
  const packed = xorBytes(LZ.compressToUint8Array(json));
  const body = bytesToBase64(packed);
  return `${MAGIC}:${checksum(body)}:${body}`;
}

export function decodeSave(text, LZ) {
  const raw = String(text == null ? "" : text).trim().replace(/\s+/g, "");
  const parts = raw.split(":");
  if (parts.length !== 3 || parts[0] !== MAGIC) {
    return { ok: false, reason: `这不像本应用的存档文本（开头应该是 ${MAGIC}:）` };
  }
  const sum = parts[1];
  const body = parts[2];
  if (checksum(body) !== sum) {
    return { ok: false, reason: "存档文本不完整或抄错了（校验和不匹配）" };
  }
  try {
    const bytes = xorBytes(base64ToBytes(body));
    const json = LZ.decompressFromUint8Array(bytes);
    if (!json) throw new Error("解压结果为空");
    return { ok: true, data: JSON.parse(json) };
  } catch (e) {
    return { ok: false, reason: "解压失败：" + (e && e.message ? e.message : e) };
  }
}
