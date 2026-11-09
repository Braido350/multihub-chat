// Zip mínimo, sem dependências: cria (script de publicação) e extrai (atualizador) arquivos .zip.
// Guarda as permissões Unix (o executável do Linux e o AppImage precisam do bit de execução) e links
// simbólicos. Sem Zip64: cada arquivo e o .zip inteiro precisam ter menos de 4 GB (o app tem ~300 MB).
"use strict";
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");

const LIMIT = 0xffffffff;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Lista recursiva (ordem estável) de [caminho relativo com "/", stat]. */
async function walk(root, rel = "") {
  const out = [];
  const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    const st = await fsp.lstat(path.join(root, r));
    out.push([r, st]);
    if (st.isDirectory()) out.push(...(await walk(root, r)));
  }
  return out;
}

/**
 * Cria um .zip com o conteúdo de `source`: uma pasta (o conteúdo vai para a raiz do zip) ou um arquivo só.
 * @returns {Promise<{files: number, bytes: number}>}
 */
async function createZip(source, outFile) {
  const st0 = await fsp.lstat(source);
  const items = st0.isDirectory() ? await walk(source) : [[path.basename(source), st0]];
  const base = st0.isDirectory() ? source : path.dirname(source);
  const fh = await fsp.open(outFile, "w");
  const central = [];
  let pos = 0;
  const write = async (buf) => {
    await fh.write(buf, 0, buf.length, pos);
    pos += buf.length;
  };
  try {
    for (const [rel, st] of items) {
      const isDir = st.isDirectory();
      const isLink = st.isSymbolicLink();
      const name = Buffer.from(isDir ? rel + "/" : rel, "utf8");
      const mode = isDir ? S_IFDIR | (st.mode & 0o7777 || 0o755) : isLink ? S_IFLNK | 0o777 : S_IFREG | (st.mode & 0o7777 || 0o644);
      const { time, date } = dosTime(st.mtime);
      const method = isDir || isLink ? 0 : 8;
      const offset = pos;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0x0800, 6); // nomes em UTF-8
      lh.writeUInt16LE(method, 8);
      lh.writeUInt16LE(time, 10);
      lh.writeUInt16LE(date, 12);
      lh.writeUInt16LE(name.length, 26);
      await write(Buffer.concat([lh, name]));
      let crc = 0;
      let csize = 0;
      let usize = 0;
      if (isLink) {
        const target = Buffer.from(await fsp.readlink(path.join(base, rel)), "utf8");
        crc = zlib.crc32(target);
        csize = usize = target.length;
        await write(target);
      } else if (!isDir) {
        const deflate = zlib.createDeflateRaw({ level: 9 });
        const counter = new Transform({
          transform(chunk, _enc, cb) {
            crc = zlib.crc32(chunk, crc);
            usize += chunk.length;
            cb(null, chunk);
          },
        });
        const sink = new (require("stream").Writable)({
          write(chunk, _enc, cb) {
            csize += chunk.length;
            write(chunk).then(() => cb(), cb);
          },
        });
        await pipeline(fs.createReadStream(path.join(base, rel)), counter, deflate, sink);
      }
      if (csize > LIMIT || usize > LIMIT || pos > LIMIT) throw new Error(`Arquivo grande demais para o zip (sem Zip64): ${rel}`);
      const fix = Buffer.alloc(12);
      fix.writeUInt32LE(crc >>> 0, 0);
      fix.writeUInt32LE(csize, 4);
      fix.writeUInt32LE(usize, 8);
      await fh.write(fix, 0, 12, offset + 14);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE((3 << 8) | 20, 4); // feito em Unix: o campo de atributos externos traz o modo
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x0800, 8);
      ch.writeUInt16LE(method, 10);
      ch.writeUInt16LE(time, 12);
      ch.writeUInt16LE(date, 14);
      ch.writeUInt32LE(crc >>> 0, 16);
      ch.writeUInt32LE(csize, 20);
      ch.writeUInt32LE(usize, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(((mode << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
      ch.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([ch, name]));
    }
    const cdStart = pos;
    for (const c of central) await write(c);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(pos - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    await write(eocd);
    return { files: items.filter(([, s]) => !s.isDirectory()).length, bytes: pos };
  } finally {
    await fh.close();
  }
}

/** Lê o diretório central do zip. */
async function listZip(file) {
  const fh = await fsp.open(file, "r");
  try {
    const { size } = await fh.stat();
    const tail = Math.min(size, 65557);
    const buf = Buffer.alloc(tail);
    await fh.read(buf, 0, tail, size - tail);
    let at = -1;
    for (let i = tail - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        at = i;
        break;
      }
    }
    if (at < 0) throw new Error("Arquivo .zip inválido (fim do diretório não encontrado).");
    const count = buf.readUInt16LE(at + 10);
    const cdSize = buf.readUInt32LE(at + 12);
    const cdOffset = buf.readUInt32LE(at + 16);
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("Arquivo .zip inválido (diretório central).");
      const madeBy = cd.readUInt16LE(p + 4) >> 8;
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const ext = cd.readUInt32LE(p + 38);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      entries.push({
        name,
        method: cd.readUInt16LE(p + 10),
        crc: cd.readUInt32LE(p + 16),
        csize: cd.readUInt32LE(p + 20),
        usize: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
        mode: madeBy === 3 ? ext >>> 16 : 0,
        dir: name.endsWith("/"),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** Caminho seguro dentro de `dest` (bloqueia "../" e caminhos absolutos: zip slip). */
function safeJoin(dest, name) {
  const clean = name.replace(/\\/g, "/");
  if (clean.startsWith("/") || /^[a-z]:/i.test(clean) || clean.split("/").includes("..")) throw new Error(`Caminho inválido no .zip: ${name}`);
  const out = path.join(dest, clean);
  if (out !== dest && !out.startsWith(dest + path.sep)) throw new Error(`Caminho inválido no .zip: ${name}`);
  return out;
}

/** Extrai o zip em `dest` (criada se preciso), conferindo o CRC de cada arquivo. */
async function extractZip(file, dest) {
  const entries = await listZip(file);
  await fsp.mkdir(dest, { recursive: true });
  const fh = await fsp.open(file, "r");
  try {
    for (const e of entries) {
      const out = safeJoin(dest, e.name);
      const kind = e.mode & S_IFMT;
      if (e.dir || kind === S_IFDIR) {
        await fsp.mkdir(out, { recursive: true });
        continue;
      }
      await fsp.mkdir(path.dirname(out), { recursive: true });
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, e.offset);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`Arquivo .zip inválido (cabeçalho de ${e.name}).`);
      const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      if (e.method !== 0 && e.method !== 8) throw new Error(`Compressão não suportada em ${e.name}.`);
      const raw = e.csize ? fs.createReadStream(file, { start, end: start + e.csize - 1 }) : require("stream").Readable.from([]);
      let crc = 0;
      let size = 0;
      const check = new Transform({
        transform(chunk, _enc, cb) {
          crc = zlib.crc32(chunk, crc);
          size += chunk.length;
          cb(null, chunk);
        },
      });
      if (kind === S_IFLNK) {
        const chunks = [];
        await pipeline(raw, ...(e.method === 8 ? [zlib.createInflateRaw()] : []), check, new (require("stream").Writable)({ write(c, _e, cb) { chunks.push(c); cb(); } }));
        if (process.platform !== "win32") {
          await fsp.rm(out, { force: true });
          await fsp.symlink(Buffer.concat(chunks).toString("utf8"), out);
        }
      } else {
        await pipeline(raw, ...(e.method === 8 ? [zlib.createInflateRaw()] : []), check, fs.createWriteStream(out));
        if (e.mode && process.platform !== "win32") await fsp.chmod(out, e.mode & 0o7777);
      }
      if ((crc >>> 0) !== e.crc || size !== e.usize) throw new Error(`Arquivo corrompido no .zip: ${e.name}`);
    }
    return entries;
  } finally {
    await fh.close();
  }
}

module.exports = { createZip, extractZip, listZip };
