// Minimal archive of a few folders: gzip( repeated [u16 pathLen][path utf8][u64 size][bytes] ). No dependencies.
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

/** Every file under `root/rel` for each rel, as posix paths relative to root. Missing folders are skipped. */
async function* walk(root: string, rel: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) yield* walk(root, r);
    else if (e.isFile()) yield r;
  }
}

async function* records(root: string, rels: string[]): AsyncGenerator<Buffer> {
  for (const rel of rels) {
    for await (const file of walk(root, rel)) {
      const abs = path.join(root, ...file.split("/"));
      const { size } = await stat(abs);
      const name = Buffer.from(file);
      const head = Buffer.alloc(2 + name.length + 8);
      head.writeUInt16BE(name.length, 0);
      name.copy(head, 2);
      head.writeBigUInt64BE(BigInt(size), 2 + name.length);
      yield head;
      let sent = 0;
      for await (const chunk of createReadStream(abs)) {
        // A file that grew since stat() would desync the framing; the caller archives a private copy, so it can't.
        const b = chunk as Buffer;
        const take = Math.min(b.length, size - sent);
        if (take > 0) yield take === b.length ? b : b.subarray(0, take);
        sent += take;
      }
      if (sent < size) throw new Error(`file shrank while archiving: ${file}`);
    }
  }
}

/** Gzipped chunks of the archive (stream it into the cipher). */
export function packFolders(root: string, rels: string[]): AsyncIterable<Buffer> {
  const gzip = createGzip({ level: 6 });
  // pipeline() destroys the gzip stream with the source's error, so the consumer's iteration rejects.
  pipeline(Readable.from(records(root, rels)), gzip).catch(() => undefined);
  return gzip as unknown as AsyncIterable<Buffer>;
}

/** Extract an archive made by packFolders into destDir. Rejects paths that would escape it. */
export async function unpackInto(gz: Buffer, destDir: string): Promise<number> {
  const input = Readable.from([gz]).pipe(createGunzip());
  let buf: Buffer = Buffer.alloc(0);
  const it = (input as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  const need = async (n: number) => {
    while (buf.length < n) {
      const { value, done } = await it.next();
      if (done) return false;
      buf = buf.length ? Buffer.concat([buf, value]) : value;
    }
    return true;
  };
  const base = path.resolve(destDir);
  let files = 0;
  while (await need(2)) {
    const nameLen = buf.readUInt16BE(0);
    if (!(await need(2 + nameLen + 8))) throw new Error("truncated archive");
    const name = buf.subarray(2, 2 + nameLen).toString();
    const size = Number(buf.readBigUInt64BE(2 + nameLen));
    buf = buf.subarray(2 + nameLen + 8);
    const target = path.resolve(base, ...name.split("/"));
    if (!target.startsWith(base + path.sep) || name.split("/").includes("..")) throw new Error("unsafe path in archive");
    await mkdir(path.dirname(target), { recursive: true });
    const out = createWriteStream(target);
    let left = size;
    await pipeline(
      Readable.from(
        (async function* () {
          while (left > 0) {
            if (!buf.length && !(await need(1))) throw new Error("truncated archive");
            const take = Math.min(left, buf.length);
            yield buf.subarray(0, take);
            buf = buf.subarray(take);
            left -= take;
          }
        })(),
      ),
      out,
    );
    files++;
  }
  if (buf.length) throw new Error("trailing bytes in archive");
  return files;
}
