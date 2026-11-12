/**
 * Reader for the tar archives an npm registry serves.
 *
 * The build materializes dependency files itself, so that the result is a tree of
 * real files with no package manager and no external process in the loop. That
 * means reading the tarball here: only what `npm pack` emits is supported —
 * POSIX ustar headers, PAX extended headers, and the GNU long-name entries older
 * tarballs still carry.
 *
 * Link entries (`1` hard link, `2` symbolic link) are refused rather than
 * materialized or skipped. The whole point of this build is that no dependency
 * path in the tree is a link, so a silently dropped link would hide exactly the
 * failure the build exists to prevent; a loud one names the package to fix.
 *
 * @module scripts/lib/tar
 */
import { gunzipSync } from 'node:zlib';

/** Fixed-width header layout. Offset and length of every field this reader reads. */
const BLOCK = 512;
const FIELD = {
  NAME: [0, 100],
  MODE: [100, 8],
  SIZE: [124, 12],
  CHECKSUM: [148, 8],
  TYPE: [156, 1],
  PREFIX: [345, 155],
};

/** Type flags that carry no payload for this build, and the reason to refuse them. */
const LINK_TYPES = {
  '1': 'a hard link',
  '2': 'a symbolic link',
  '3': 'a character device',
  '4': 'a block device',
  '6': 'a FIFO',
  '7': 'a contiguous file',
};

/**
 * Read a NUL- or space-padded UTF-8 field.
 * @param buffer - Whole decompressed archive.
 * @param field - `[offset, length]` pair of the field.
 * @returns The field text, without padding.
 */
function text(buffer, [offset, length]) {
  const end = buffer.indexOf(0, offset);
  const stop = end === -1 || end > offset + length ? offset + length : end;
  return buffer.toString('utf8', offset, stop);
}

/**
 * Read a fixed-width octal field.
 * @param buffer - Whole decompressed archive.
 * @param field - `[offset, length]` pair of the field.
 * @returns The decoded number; `0` for an empty field.
 */
function octal(buffer, field) {
  const raw = text(buffer, field).trim();
  if (raw === '') return 0;
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`tar: unreadable numeric header field ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Unsigned header checksum, with the checksum field itself read as spaces.
 * @param block - One 512-byte header block.
 * @returns The computed checksum.
 */
function checksumOf(block) {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  return sum;
}

/**
 * Parse a PAX extended header body into its key/value records.
 * @param body - Header payload.
 * @returns Decoded records; later duplicates win, as the format specifies.
 */
function parsePax(body) {
  const records = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(body.toString('utf8', offset, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > body.length) break;
    const record = body.toString('utf8', space + 1, offset + length - 1);
    const equals = record.indexOf('=');
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/**
 * Reject an archive path that would escape the extraction root.
 *
 * The registry is trusted to serve well-formed tarballs, but the build writes
 * paths derived from this string, so traversal is refused before any write.
 *
 * @param path - Entry path as read from the archive.
 * @returns The same path, normalized.
 */
function assertContained(path) {
  const segments = path.split('/');
  if (path === '' || path.startsWith('/') || segments.includes('..') || segments.includes('.')) {
    throw new Error(`tar: refusing archive path ${JSON.stringify(path)}`);
  }
  return path;
}

/**
 * Read every entry of a gzipped tar archive into memory.
 *
 * npm registry tarballs are small enough for this to be the simplest correct
 * approach: the caller receives complete entry bodies and writes what it keeps.
 *
 * @param gzipped - Raw `.tgz` bytes.
 * @returns Entries in archive order: `{ path, type, mode, data }`, where `data` is
 * a `Buffer` for files and `undefined` for directories.
 * @throws When the archive is malformed, or carries an entry type this build will
 * not materialize.
 */
export function readTar(gzipped) {
  const buffer = gunzipSync(gzipped);
  const entries = [];
  let globalPax = {};
  let offset = 0;

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const stored = octal(header, FIELD.CHECKSUM);
    if (checksumOf(header) !== stored) throw new Error('tar: header checksum mismatch');
    const type = header.toString('latin1', FIELD.TYPE[0], FIELD.TYPE[0] + 1);

    let pendingPax;
    let pendingName;
    if (type === 'g') {
      globalPax = { ...globalPax, ...parsePax(buffer.subarray(offset + BLOCK, offset + BLOCK + octal(header, FIELD.SIZE))) };
      offset += BLOCK + Math.ceil(octal(header, FIELD.SIZE) / BLOCK) * BLOCK;
      continue;
    }
    if (type === 'x') {
      pendingPax = parsePax(buffer.subarray(offset + BLOCK, offset + BLOCK + octal(header, FIELD.SIZE)));
      offset += BLOCK + Math.ceil(octal(header, FIELD.SIZE) / BLOCK) * BLOCK;
      continue;
    }
    if (type === 'L') {
      pendingName = buffer.toString('utf8', offset + BLOCK, offset + BLOCK + octal(header, FIELD.SIZE)).replace(/\0+$/u, '');
      offset += BLOCK + Math.ceil(octal(header, FIELD.SIZE) / BLOCK) * BLOCK;
      continue;
    }
    if (LINK_TYPES[type] !== undefined) {
      throw new Error(`tar: archive contains ${LINK_TYPES[type]} at ${JSON.stringify(text(header, FIELD.NAME))}, which this build will not materialize`);
    }

    const fields = { ...globalPax, ...pendingPax };
    const size = fields.size === undefined ? octal(header, FIELD.SIZE) : Number.parseInt(fields.size, 10);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('tar: unreadable entry size');
    const body = buffer.subarray(offset + BLOCK, offset + BLOCK + size);
    const prefix = text(header, FIELD.PREFIX);
    const name = pendingName ?? fields.path ?? (prefix === '' ? text(header, FIELD.NAME) : `${prefix}/${text(header, FIELD.NAME)}`);
    const mode = octal(header, FIELD.MODE) & 0o777;

    if (type === '5') entries.push({ path: assertContained(name.replace(/\/+$/u, '')), type: 'directory', mode });
    else if (type === '0' || type === '\0' || type === '') entries.push({ path: assertContained(name), type: 'file', mode, data: Buffer.from(body) });
    else throw new Error(`tar: unsupported entry type ${JSON.stringify(type)} at ${JSON.stringify(name)}`);

    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }

  return entries;
}
