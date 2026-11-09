// Lê o índice (central directory) de um .zip sem descompactar: nomes dos arquivos e se há senha.
// Golpes usam zip com senha (a senha vai no corpo do e-mail) para o antivírus não enxergar o conteúdo.
function inspectZip(buf) {
  const out = { entries: [], encrypted: false, error: null };
  if (!buf || buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) {
    out.error = "não é um zip";
    return out;
  }
  // End of central directory: procura de trás para frente (pode haver comentário de até 64 KB)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    out.error = "índice não encontrado";
    return out;
  }
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && n < 2000 && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    if (flags & 0x1) out.encrypted = true;
    out.entries.push(name);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

module.exports = { inspectZip };
