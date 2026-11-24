import crypto from 'crypto';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import webp from 'node-webpmux';
import {
  proto,
  encryptedStream,
  getMediaKeys,
  generateMessageIDV2,
  jidNormalizedUser,
  normalizeMessageContent,
  getContentType
} from '@whiskeysockets/baileys';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_ENTRIES = 500;
const pendingStore = new Map();

function resolveProtobufReader() {
  try {
    const baileysEntry = require.resolve('@whiskeysockets/baileys');
    const baileysRequire = createRequire(baileysEntry);
    return baileysRequire('protobufjs/minimal.js').Reader;
  } catch {
    return null;
  }
}

export function patchAudioStickerProto() {
  const Reader = resolveProtobufReader();
  const Message = proto?.Message;
  const StickerMessage = proto?.Message?.StickerMessage;
  const FutureProofMessage = proto?.Message?.FutureProofMessage;
  const AudioMessage = proto?.Message?.AudioMessage;

  if (!Message || !StickerMessage || !FutureProofMessage || !AudioMessage || !Reader) {
    return false;
  }

  if (!StickerMessage.__audioStickerPatched) {
    StickerMessage.prototype.premium = null;
    StickerMessage.prototype.emojis = null;
    StickerMessage.prototype.audioMessage = null;

    const origStickerEncode = StickerMessage.encode.bind(StickerMessage);
    const origStickerDecode = StickerMessage.decode.bind(StickerMessage);
    const origStickerFromObject = StickerMessage.fromObject.bind(StickerMessage);
    const origStickerToObject = StickerMessage.toObject.bind(StickerMessage);

    StickerMessage.encode = function encode(m, w) {
      const writer = origStickerEncode(m, w);
      if (m?.premium != null && Object.hasOwnProperty.call(m, 'premium')) {
        writer.uint32(192).int32(m.premium);
      }
      if (m?.emojis != null && Object.hasOwnProperty.call(m, 'emojis')) {
        writer.uint32(202).string(m.emojis);
      }
      if (m?.audioMessage != null && Object.hasOwnProperty.call(m, 'audioMessage')) {
        AudioMessage.encode(m.audioMessage, writer.uint32(210).fork()).ldelim();
      }
      return writer;
    };

    StickerMessage.decode = function decode(r, l, e) {
      const reader = r instanceof Reader ? r : Reader.create(r);
      const start = reader.pos;
      const m = origStickerDecode(reader, l, e);
      const end = reader.pos;
      const sub = Reader.create(reader.buf);
      sub.pos = start;
      sub.len = end;
      while (sub.pos < end) {
        const tag = sub.uint32();
        if (tag === e) break;
        switch (tag >>> 3) {
          case 24:
            m.premium = sub.int32();
            break;
          case 25:
            m.emojis = sub.string();
            break;
          case 26:
            m.audioMessage = AudioMessage.decode(sub, sub.uint32());
            break;
          default:
            sub.skipType(tag & 7);
            break;
        }
      }
      return m;
    };

    StickerMessage.fromObject = function fromObject(d) {
      const m = origStickerFromObject(d);
      if (d?.premium != null) m.premium = Number(d.premium) | 0;
      if (d?.emojis != null) m.emojis = String(d.emojis);
      if (d?.audioMessage != null) m.audioMessage = AudioMessage.fromObject(d.audioMessage);
      return m;
    };

    StickerMessage.toObject = function toObject(m, o) {
      const d = origStickerToObject(m, o);
      if (m?.premium != null && Object.hasOwnProperty.call(m, 'premium')) d.premium = m.premium;
      if (m?.emojis != null && Object.hasOwnProperty.call(m, 'emojis')) d.emojis = m.emojis;
      if (m?.audioMessage != null && Object.hasOwnProperty.call(m, 'audioMessage')) {
        d.audioMessage = AudioMessage.toObject(m.audioMessage, o);
      }
      return d;
    };

    StickerMessage.__audioStickerPatched = true;
  }

  if (!Message.__audioStickerPatched) {
    Message.prototype.audioStickerMessage = null;

    const origMsgEncode = Message.encode.bind(Message);
    const origMsgDecode = Message.decode.bind(Message);
    const origMsgFromObject = Message.fromObject.bind(Message);
    const origMsgToObject = Message.toObject.bind(Message);

    Message.encode = function encode(m, w) {
      const writer = origMsgEncode(m, w);
      if (m?.audioStickerMessage != null && Object.hasOwnProperty.call(m, 'audioStickerMessage')) {
        FutureProofMessage.encode(m.audioStickerMessage, writer.uint32(1074).fork()).ldelim();
      }
      return writer;
    };

    Message.decode = function decode(r, l, e) {
      const reader = r instanceof Reader ? r : Reader.create(r);
      const start = reader.pos;
      const m = origMsgDecode(reader, l, e);
      const end = reader.pos;
      const sub = Reader.create(reader.buf);
      sub.pos = start;
      sub.len = end;
      while (sub.pos < end) {
        const tag = sub.uint32();
        if (tag === e) break;
        if ((tag >>> 3) === 134) {
          m.audioStickerMessage = FutureProofMessage.decode(sub, sub.uint32());
        } else {
          sub.skipType(tag & 7);
        }
      }
      return m;
    };

    Message.fromObject = function fromObject(d) {
      const m = origMsgFromObject(d);
      if (d?.audioStickerMessage != null) {
        m.audioStickerMessage = FutureProofMessage.fromObject(d.audioStickerMessage);
      }
      return m;
    };

    Message.toObject = function toObject(m, o) {
      const d = origMsgToObject(m, o);
      if (m?.audioStickerMessage != null && Object.hasOwnProperty.call(m, 'audioStickerMessage')) {
        d.audioStickerMessage = FutureProofMessage.toObject(m.audioStickerMessage, o);
      }
      return d;
    };

    Message.__audioStickerPatched = true;
  }

  return true;
}

patchAudioStickerProto();

function createTempPath(ext) {
  return path.join(os.tmpdir(), `sa_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`);
}

function detectFileExtension(buf, fallback = 'bin') {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return fallback;
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (buf.subarray(0, 3).toString('ascii') === 'ID3' || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0)) return 'mp3';
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'webm';
  return fallback;
}

export async function probeMediaFile(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,nb_frames',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath
    ], { timeout: 20000 });
    const parsed = JSON.parse(stdout || '{}');
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const hasVideo = streams.some(s => s.codec_type === 'video');
    const hasAudio = streams.some(s => s.codec_type === 'audio');
    const duration = parseFloat(parsed.format?.duration || '0') || 0;
    return { hasVideo, hasAudio, duration };
  } catch {
    return { hasVideo: false, hasAudio: false, duration: 0 };
  }
}

export async function probeMediaBuffer(buffer, extHint = 'bin') {
  const ext = detectFileExtension(buffer, extHint);
  const tmpFile = createTempPath(ext);
  await fs.writeFile(tmpFile, buffer);
  try {
    return await probeMediaFile(tmpFile);
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

async function addStickerExif(webpBuffer, { packname = '', author = '' } = {}) {
  const img = new webp.Image();
  await img.load(webpBuffer);
  const json = {
    'sticker-pack-id': crypto.randomBytes(16).toString('hex'),
    'sticker-pack-name': packname,
    'sticker-pack-publisher': author,
    'android-app-store-link': 'https://play.google.com/store/apps/details?id=com.marsvard.stickermakerforwhatsapp',
    'ios-app-store-link': 'https://itunes.apple.com/app/sticker-maker-studio/id1443326857',
    emojis: ['🔊']
  };
  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2A, 0x00,
    0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00,
    0x00, 0x00
  ]);
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const exif = Buffer.concat([exifAttr, jsonBuf]);
  exif.writeUIntLE(jsonBuf.length, 14, 4);
  img.exif = exif;
  return await img.save(null);
}

async function readWebpInfo(webpBuffer) {
  try {
    const img = new webp.Image();
    await img.load(webpBuffer);
    return {
      width: img.width || 512,
      height: img.height || 512,
      isAnimated: Boolean(img.hasAnim)
    };
  } catch {
    return {
      width: 512,
      height: 512,
      isAnimated: webpBuffer.includes(Buffer.from('ANIM'))
    };
  }
}

export async function buildStickerWebp(mediaBuffer, {
  isVideo = false,
  forceSquare = false,
  packname = '',
  author = '',
  startSeconds = 0,
  maxDuration = 5
} = {}) {
  const ext = detectFileExtension(mediaBuffer, isVideo ? 'mp4' : 'jpg');

  if (ext === 'webp') {
    const info = await readWebpInfo(mediaBuffer);
    if (info.isAnimated || mediaBuffer.length <= 490 * 1024) {
      const tagged = await addStickerExif(mediaBuffer, { packname, author }).catch(() => mediaBuffer);
      return { buffer: tagged, ...info };
    }
  }

  const tmpIn = createTempPath(ext);
  const tmpOut = createTempPath('webp');
  await fs.writeFile(tmpIn, mediaBuffer);

  try {
    const scaleFilter = forceSquare
      ? 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512,format=rgba,setsar=1'
      : 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba';

    const animated = isVideo || ext === 'gif';
    let outBuffer;

    if (!animated) {
      await execFileAsync('ffmpeg', [
        '-y', '-i', tmpIn,
        '-vf', scaleFilter,
        '-vcodec', 'libwebp',
        '-lossless', '0',
        '-compression_level', '6',
        '-q:v', '80',
        tmpOut
      ], { timeout: 45000 });
      outBuffer = await fs.readFile(tmpOut);
    } else {
      const MAX_BYTES = 480 * 1024;
      const clampedStart = Math.max(0, startSeconds || 0);
      const dur = Math.min(6, Math.max(1, maxDuration || 5));
      const steps = [
        { q: 45, fps: 15, t: dur },
        { q: 35, fps: 15, t: dur },
        { q: 25, fps: 12, t: dur },
        { q: 18, fps: 10, t: Math.min(dur, 4) },
        { q: 12, fps: 8, t: Math.min(dur, 3) }
      ];
      for (const step of steps) {
        const args = ['-y'];
        if (clampedStart > 0) args.push('-ss', String(clampedStart));
        args.push(
          '-i', tmpIn,
          '-t', String(step.t),
          '-vf', `${scaleFilter},fps=${step.fps}`,
          '-vcodec', 'libwebp',
          '-lossless', '0',
          '-compression_level', '6',
          '-loop', '0',
          '-an',
          '-vsync', '0',
          '-q:v', String(step.q),
          tmpOut
        );
        await execFileAsync('ffmpeg', args, { timeout: 60000 });
        outBuffer = await fs.readFile(tmpOut);
        if (outBuffer.length <= MAX_BYTES) break;
      }
    }

    const tagged = await addStickerExif(outBuffer, { packname, author }).catch(() => outBuffer);
    const info = await readWebpInfo(tagged);
    return { buffer: tagged, ...info };
  } finally {
    await fs.unlink(tmpIn).catch(() => {});
    await fs.unlink(tmpOut).catch(() => {});
  }
}

export async function buildStickerAudioOgg(audioBuffer, {
  startSeconds = 0,
  endSeconds = 0,
  maxSeconds = 10,
  extHint = 'bin'
} = {}) {
  const ext = detectFileExtension(audioBuffer, extHint);
  const tmpIn = createTempPath(ext);
  const tmpOut = createTempPath('ogg');
  await fs.writeFile(tmpIn, audioBuffer);

  try {
    const info = await probeMediaFile(tmpIn);
    if (!info.hasAudio) {
      throw new Error('NO_AUDIO_STREAM');
    }

    const start = Math.max(0, Number(startSeconds) || 0);
    if (info.duration > 0 && start >= info.duration) {
      throw new Error('START_AFTER_END');
    }

    const requestedDur = endSeconds > start ? (endSeconds - start) : maxSeconds;
    const clampedDur = Math.min(maxSeconds, Math.max(0.5, requestedDur));

    const args = ['-y'];
    if (start > 0) args.push('-ss', String(start));
    args.push(
      '-i', tmpIn,
      '-t', String(clampedDur),
      '-vn',
      '-c:a', 'libopus',
      '-b:a', '64k',
      '-ac', '1',
      '-ar', '48000',
      '-application', 'audio',
      '-avoid_negative_ts', 'make_zero',
      tmpOut
    );

    await execFileAsync('ffmpeg', args, { timeout: 60000 });
    const oggBuffer = await fs.readFile(tmpOut);
    if (!oggBuffer || oggBuffer.length < 32) {
      throw new Error('EMPTY_AUDIO_OUTPUT');
    }

    const outProbe = await probeMediaFile(tmpOut);
    const seconds = Math.max(1, Math.min(10, Math.round(outProbe.duration || 1)));
    return { buffer: oggBuffer, seconds };
  } finally {
    await fs.unlink(tmpIn).catch(() => {});
    await fs.unlink(tmpOut).catch(() => {});
  }
}

export function computeStreamingSidecar(iv, macKey, encBytes) {
  const chunkSize = 64 * 1024;
  const streamWithIv = Buffer.concat([iv, encBytes]);
  const parts = [];
  let offset = 0;
  while (offset < streamWithIv.length) {
    const end = Math.min(offset + chunkSize + 16, streamWithIv.length);
    const mac = crypto.createHmac('sha256', macKey).update(streamWithIv.subarray(offset, end)).digest();
    parts.push(mac.subarray(0, 10));
    if (end >= streamWithIv.length) break;
    offset += chunkSize;
  }
  return Buffer.concat(parts);
}

async function encryptAndUploadMedia(sock, buffer, mediaType, { withSidecar = false } = {}) {
  const logger = sock?.logger;
  const { mediaKey, encFilePath, fileEncSha256, fileSha256, fileLength } = await encryptedStream(buffer, mediaType, { logger });
  try {
    let streamingSidecar;
    if (withSidecar) {
      const { iv, macKey } = await getMediaKeys(mediaKey, mediaType);
      const encBytes = await fs.readFile(encFilePath);
      streamingSidecar = computeStreamingSidecar(iv, macKey, encBytes);
    }
    const uploadRes = await sock.waUploadToServer(encFilePath, {
      fileEncSha256B64: fileEncSha256.toString('base64'),
      mediaType,
      timeoutMs: 60000
    });
    return {
      url: uploadRes.mediaUrl,
      directPath: uploadRes.directPath,
      mediaKey,
      fileEncSha256,
      fileSha256,
      fileLength,
      streamingSidecar
    };
  } finally {
    if (encFilePath && fsSync.existsSync(encFilePath)) {
      await fs.unlink(encFilePath).catch(() => {});
    }
  }
}

function buildQuotedContextInfo(sock, jid, quoted) {
  if (!quoted?.key?.id || !quoted?.message) return undefined;
  try {
    const participant = quoted.key.fromMe
      ? sock.user?.id
      : quoted.participant || quoted.key.participant || quoted.key.remoteJid;
    const normalized = normalizeMessageContent(quoted.message);
    const msgType = getContentType(normalized);
    if (!msgType || !normalized?.[msgType]) return undefined;
    const cloned = proto.Message.create({ [msgType]: normalized[msgType] });
    const inner = cloned[msgType];
    if (inner && typeof inner === 'object' && 'contextInfo' in inner) {
      delete inner.contextInfo;
    }
    const contextInfo = {
      participant: jidNormalizedUser(participant),
      stanzaId: quoted.key.id,
      quotedMessage: cloned
    };
    if (jid !== quoted.key.remoteJid) {
      contextInfo.remoteJid = quoted.key.remoteJid;
    }
    return contextInfo;
  } catch {
    return undefined;
  }
}

export function buildAudioStickerWireMessage({
  stickerUpload,
  audioUpload,
  width = 512,
  height = 512,
  isAnimated = false,
  audioSeconds = 1,
  contextInfo = undefined
}) {
  patchAudioStickerProto();
  const nowSec = Math.floor(Date.now() / 1000);
  const audioMsg = proto.Message.AudioMessage.fromObject({
    url: audioUpload.url,
    mimetype: 'audio/ogg; codecs=opus',
    fileSha256: audioUpload.fileSha256,
    fileLength: audioUpload.fileLength,
    seconds: audioSeconds,
    mediaKey: audioUpload.mediaKey,
    fileEncSha256: audioUpload.fileEncSha256,
    directPath: audioUpload.directPath,
    mediaKeyTimestamp: nowSec,
    ...(audioUpload.streamingSidecar ? { streamingSidecar: audioUpload.streamingSidecar } : {})
  });

  const stickerMsg = proto.Message.StickerMessage.fromObject({
    url: stickerUpload.url,
    fileSha256: stickerUpload.fileSha256,
    fileEncSha256: stickerUpload.fileEncSha256,
    mediaKey: stickerUpload.mediaKey,
    mimetype: 'image/webp',
    height,
    width,
    directPath: stickerUpload.directPath,
    fileLength: stickerUpload.fileLength,
    mediaKeyTimestamp: nowSec,
    isAnimated: Boolean(isAnimated),
    stickerSentTs: Date.now(),
    isAvatar: false,
    isAiSticker: false,
    isLottie: false,
    accessibilityLabel: '',
    premium: 0,
    audioMessage: audioMsg,
    ...(contextInfo ? { contextInfo } : {})
  });

  // Non-own prototype getter keeps Baileys relayMessage mediatype="sticker" without writing top-level field 26
  const protoHint = Object.defineProperty({}, 'stickerMessage', {
    get() {
      return this.audioStickerMessage?.message?.stickerMessage;
    },
    enumerable: false,
    configurable: true
  });

  const message = Object.create(protoHint);
  message.audioStickerMessage = {
    message: {
      stickerMessage: stickerMsg
    }
  };
  return message;
}

export async function sendAudioSticker(sock, jid, {
  webpBuffer,
  audioBuffer,
  isVideo = false,
  forceSquare = false,
  packname = '',
  author = '',
  startSeconds = 0,
  endSeconds = 0,
  maxAudioSeconds = 10,
  preConvertedWebp = null,
  preConvertedAudio = null,
  quoted = null
} = {}) {
  patchAudioStickerProto();

  const [stickerResult, audioResult] = await Promise.all([
    preConvertedWebp || buildStickerWebp(webpBuffer, {
      isVideo,
      forceSquare,
      packname,
      author,
      startSeconds,
      maxDuration: Math.min(5, maxAudioSeconds)
    }),
    preConvertedAudio || buildStickerAudioOgg(audioBuffer, {
      startSeconds,
      endSeconds,
      maxSeconds: maxAudioSeconds
    })
  ]);

  const [stickerUpload, audioUpload] = await Promise.all([
    encryptAndUploadMedia(sock, stickerResult.buffer, 'sticker'),
    encryptAndUploadMedia(sock, audioResult.buffer, 'audio', { withSidecar: true })
  ]);

  const contextInfo = buildQuotedContextInfo(sock, jid, quoted);
  const message = buildAudioStickerWireMessage({
    stickerUpload,
    audioUpload,
    width: stickerResult.width,
    height: stickerResult.height,
    isAnimated: stickerResult.isAnimated,
    audioSeconds: audioResult.seconds,
    contextInfo
  });

  const messageId = generateMessageIDV2(sock.user?.id);
  await sock.relayMessage(jid, message, { messageId });

  return {
    key: { remoteJid: jid, fromMe: true, id: messageId },
    message,
    seconds: audioResult.seconds,
    isAnimated: stickerResult.isAnimated
  };
}

function prunePendingStore() {
  const now = Date.now();
  for (const [k, v] of pendingStore.entries()) {
    if (!v || now - v.createdAt > PENDING_TTL_MS || pendingStore.size > MAX_PENDING_ENTRIES) {
      pendingStore.delete(k);
    }
  }
}

export function setPendingAudioSticker(chatId, userId, payload) {
  prunePendingStore();
  pendingStore.set(`${chatId}:${userId}`, { ...payload, createdAt: Date.now() });
}

export function getPendingAudioSticker(chatId, userId) {
  const key = `${chatId}:${userId}`;
  const entry = pendingStore.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    pendingStore.delete(key);
    return null;
  }
  return entry;
}

export function clearPendingAudioSticker(chatId, userId) {
  return pendingStore.delete(`${chatId}:${userId}`);
}

function parseTimeToken(token) {
  if (!token || !/^\d+(?::[0-5]?\d){0,2}$/.test(token)) return null;
  const parts = token.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function parseStickerAudioArgs(rawText, defaultPack, defaultAuthor) {
  const trimmed = (rawText || '').trim();
  if (!trimmed) {
    return { action: 'run', packname: defaultPack, author: defaultAuthor, startSeconds: 0, endSeconds: 0 };
  }

  const lower = trimmed.toLowerCase();
  if (['limpar', 'clear', 'cancelar', 'cancel', 'reset'].includes(lower)) {
    return { action: 'clear' };
  }
  if (['ajuda', 'help', '?'].includes(lower)) {
    return { action: 'help' };
  }

  let packname = defaultPack;
  let author = defaultAuthor;
  let timePart = trimmed;

  if (trimmed.includes('|')) {
    const [p0, ...rest] = trimmed.split('|');
    const p1 = rest.join('|');
    if (p0.trim()) packname = p0.trim();
    if (p1.trim()) author = p1.trim();
    timePart = '';
  }

  let startSeconds = 0;
  let endSeconds = 0;

  if (timePart) {
    const tokens = timePart.split(/\s+/);
    const t1 = parseTimeToken(tokens[0]);
    if (t1 === null || tokens.length > 2) {
      return { action: 'help' };
    }
    startSeconds = t1;
    if (tokens.length === 2) {
      const t2 = parseTimeToken(tokens[1]);
      if (t2 === null || t2 <= t1) {
        return { action: 'help' };
      }
      endSeconds = t2;
    }
  }

  return { action: 'run', packname, author, startSeconds, endSeconds };
}

export function unwrapMessageContainer(msg) {
  let curr = msg;
  for (let i = 0; i < 6 && curr && typeof curr === 'object'; i++) {
    if (curr.viewOnceMessage?.message) curr = curr.viewOnceMessage.message;
    else if (curr.viewOnceMessageV2?.message) curr = curr.viewOnceMessageV2.message;
    else if (curr.viewOnceMessageV2Extension?.message) curr = curr.viewOnceMessageV2Extension.message;
    else if (curr.ephemeralMessage?.message) curr = curr.ephemeralMessage.message;
    else if (curr.documentWithCaptionMessage?.message) curr = curr.documentWithCaptionMessage.message;
    else if (curr.audioStickerMessage?.message) curr = curr.audioStickerMessage.message;
    else break;
  }
  return curr;
}

export function extractMediaTarget(rawMsg) {
  const msg = unwrapMessageContainer(rawMsg);
  if (!msg) return null;
  if (msg.stickerMessage) return { kind: 'sticker', mediaType: 'sticker', media: msg.stickerMessage };
  if (msg.imageMessage) return { kind: 'image', mediaType: 'image', media: msg.imageMessage };
  if (msg.videoMessage) return { kind: 'video', mediaType: 'video', media: msg.videoMessage };
  if (msg.audioMessage) return { kind: 'audio', mediaType: 'audio', media: msg.audioMessage };
  if (msg.pttMessage) return { kind: 'audio', mediaType: 'audio', media: msg.pttMessage };
  if (msg.documentMessage) {
    const mime = (msg.documentMessage.mimetype || '').toLowerCase();
    if (mime.startsWith('audio/')) return { kind: 'audio', mediaType: 'document', media: msg.documentMessage };
    if (mime.startsWith('image/')) return { kind: 'image', mediaType: 'document', media: msg.documentMessage };
    if (mime.startsWith('video/')) return { kind: 'video', mediaType: 'document', media: msg.documentMessage };
  }
  return null;
}

export default {
  patchAudioStickerProto,
  probeMediaFile,
  probeMediaBuffer,
  buildStickerWebp,
  buildStickerAudioOgg,
  computeStreamingSidecar,
  buildAudioStickerWireMessage,
  sendAudioSticker,
  setPendingAudioSticker,
  getPendingAudioSticker,
  clearPendingAudioSticker,
  parseStickerAudioArgs,
  unwrapMessageContainer,
  extractMediaTarget
};
