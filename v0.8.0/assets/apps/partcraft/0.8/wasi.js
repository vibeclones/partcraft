/* SPDX-License-Identifier: Apache-2.0 */
/**
 * wasi.js — a small WASI preview 1 host with an in-memory file system (0.5; DOM-free: the script worker and Node). It runs
 * CPython's WebAssembly build (cs-lang-python.js) with nothing but what is given to it: no network, no real files, no
 * JavaScript reachable from inside — the program sees a file tree, stdin/stdout/stderr, a clock and random numbers.
 *
 *   const fs = new MemFS();  fs.mkdirp('/lib');  fs.writeFile('/run/main.py', bytes);  fs.device('/dev/cs', { write, read })
 *   const w = new Wasi({ args: ['python', '/run/main.py'], env: { K: 'v' }, fs, stdout: (bytes) => …, stderr: (bytes) => … })
 *   const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: w.imports });
 *   const code = w.start(instance)    → the exit code (proc_exit), or throws what the program threw
 *
 * A device file calls back synchronously: write(bytes) when the program writes to it, read(max) → bytes (empty = end) when it
 * reads. That is how a program asks the host for something and gets the answer at once.
 * Not built: sockets (ENOTSUP), symbolic and hard links (ENOTSUP), file times (always 0), blocking polls (a sleep returns at
 * once), real permissions (everything is readable and writable).
 */

// errno
const E = { SUCCESS: 0, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58, SPIPE: 70 };
// filetype
const FT = { UNKNOWN: 0, CHAR: 2, DIR: 3, FILE: 4 };
const RIGHTS_ALL = 0x1fffffffn;

/** A file tree in memory: directories hold Maps; files hold growable bytes; devices call back. */
export class MemFS {
  constructor() { this.root = dirNode(); this.ino = 1; this.root.ino = this.ino++; }
  /** The node at an absolute path, or null. */
  lookup(p) { let n = this.root; for (const s of split(p)) { if (n.type !== 'dir') return null; n = n.entries.get(s); if (!n) return null; } return n; }
  mkdirp(p) {
    let n = this.root;
    for (const s of split(p)) {
      let c = n.entries.get(s);
      if (!c) { c = dirNode(); c.ino = this.ino++; n.entries.set(s, c); }
      if (c.type !== 'dir') throw new Error(p + ': not a directory');   // i18n-ignore: a programming error (the vendored files are checked)
      n = c;
    }
    return n;
  }
  writeFile(p, bytes) {
    const parts = split(p), name = parts.pop(), dir = this.mkdirp('/' + parts.join('/'));
    const f = { type: 'file', data: bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes)), size: 0, ino: this.ino++ };
    f.size = f.data.length;
    dir.entries.set(name, f);
    return f;
  }
  readFile(p) { const n = this.lookup(p); return n && n.type === 'file' ? n.data.subarray(0, n.size) : null; }
  device(p, { write, read }) {
    const parts = split(p), name = parts.pop(), dir = this.mkdirp('/' + parts.join('/'));
    dir.entries.set(name, { type: 'dev', write, read, ino: this.ino++ });
  }
}
const dirNode = () => ({ type: 'dir', entries: new Map(), ino: 0 });
const split = (p) => String(p).split('/').filter((s) => s && s !== '.');

/** Thrown by proc_exit to leave the program. */
export class WasiExit extends Error { constructor(code) { super('exit ' + code); this.code = code; } }

export class Wasi {
  constructor({ args = [], env = {}, fs = new MemFS(), stdout = () => {}, stderr = () => {}, stdin = null, now = () => Date.now() } = {}) {
    this.args = args.map(String);
    this.env = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    this.fs = fs; this.now = now;
    this.out = { 1: stdout, 2: stderr };
    this.stdin = stdin;   // () => bytes, or null (end of input)
    // fd 0–2 standard streams, 3 = the root directory, opened by the program as "/"
    this.fds = new Map([[0, { std: 0 }], [1, { std: 1 }], [2, { std: 2 }], [3, { node: fs.root, pre: '/', path: '' }]]);
    this.next = 4;
    this.mem = null;
    this.imports = this.makeImports();
  }

  start(instance) {
    this.mem = instance.exports.memory;
    try { instance.exports._start(); return 0; } catch (e) { if (e instanceof WasiExit) return e.code; throw e; }
  }

  makeImports() {
    const w = this;
    const dv = () => new DataView(w.mem.buffer), u8 = () => new Uint8Array(w.mem.buffer);
    const str = (p, n) => new TextDecoder().decode(u8().subarray(p, p + n));
    const fd = (n) => w.fds.get(n);
    const resolve = (dirfd, p, n, { parent = false } = {}) => {
      const d = fd(dirfd);
      if (!d || !d.node || d.node.type !== 'dir') return { err: E.BADF };
      const path = str(p, n);
      const parts = (path.startsWith('/') ? [] : split(d.path)).concat(split(path));
      const stack = [];
      for (const s of parts) { if (s === '..') stack.pop(); else stack.push(s); }
      if (parent) { const name = stack.pop(); return { dir: w.fs.lookup('/' + stack.join('/')), name, path: '/' + [...stack, name].join('/') }; }
      return { node: w.fs.lookup('/' + stack.join('/')), path: '/' + stack.join('/') };
    };
    const iovs = (ptr, n) => { const v = dv(), out = []; for (let i = 0; i < n; i++) out.push([v.getUint32(ptr + i * 8, true), v.getUint32(ptr + i * 8 + 4, true)]); return out; };
    const ftype = (node) => (node.type === 'dir' ? FT.DIR : node.type === 'dev' ? FT.CHAR : FT.FILE);
    const statInto = (node, buf) => {
      const v = dv();
      for (let i = 0; i < 64; i += 8) v.setBigUint64(buf + i, 0n, true);
      v.setBigUint64(buf + 8, BigInt(node.ino || 0), true);
      v.setUint8(buf + 16, ftype(node));
      v.setBigUint64(buf + 24, 1n, true);
      v.setBigUint64(buf + 32, BigInt(node.type === 'file' ? node.size : 0), true);
    };
    const grow = (f, need) => {
      if (need <= f.data.length) return;
      const nd = new Uint8Array(Math.max(need, f.data.length * 2, 64));
      nd.set(f.data.subarray(0, f.size)); f.data = nd;
    };
    const readInto = (o, list, at = null) => {
      let total = 0;
      for (const [p, len] of list) {
        let chunk;
        if (o.std === 0) chunk = w.stdin ? w.stdin(len) : new Uint8Array(0);
        else if (o.node.type === 'dev') chunk = o.node.read(len) || new Uint8Array(0);
        else { const pos = at === null ? o.pos : at; chunk = o.node.data.subarray(pos, Math.min(o.node.size, pos + len)); if (at === null) o.pos += chunk.length; else at += chunk.length; }
        u8().set(chunk.subarray(0, len), p);
        total += Math.min(chunk.length, len);
        if (chunk.length < len) break;
      }
      return total;
    };
    const writeFrom = (o, list, at = null) => {
      let total = 0;
      for (const [p, len] of list) {
        const bytes = u8().slice(p, p + len);
        if (o.std) w.out[o.std](bytes);
        else if (o.node.type === 'dev') o.node.write(bytes);
        else {
          const f = o.node;
          let pos = at !== null ? at : o.append ? f.size : o.pos;
          grow(f, pos + len); f.data.set(bytes, pos); pos += len; f.size = Math.max(f.size, pos);
          if (at !== null) at = pos; else o.pos = pos;
        }
        total += len;
      }
      return total;
    };
    const fdOf = (n) => { const o = fd(n); return o ? o : null; };
    return {
      args_sizes_get(argc, size) { const v = dv(); v.setUint32(argc, w.args.length, true); v.setUint32(size, w.args.reduce((s, a) => s + new TextEncoder().encode(a).length + 1, 0), true); return E.SUCCESS; },
      args_get(argv, buf) { return putStrings(w.args, argv, buf); },
      environ_sizes_get(cnt, size) { const v = dv(); v.setUint32(cnt, w.env.length, true); v.setUint32(size, w.env.reduce((s, a) => s + new TextEncoder().encode(a).length + 1, 0), true); return E.SUCCESS; },
      environ_get(env, buf) { return putStrings(w.env, env, buf); },
      clock_res_get(id, out) { dv().setBigUint64(out, 1000n, true); return E.SUCCESS; },
      clock_time_get(id, prec, out) {
        const ns = id === 0 ? BigInt(Math.round(w.now() * 1e6)) : BigInt(Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) * 1e6));
        dv().setBigUint64(out, ns, true); return E.SUCCESS;
      },
      random_get(p, n) { const b = u8().subarray(p, p + n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536))); return E.SUCCESS; },
      proc_exit(code) { throw new WasiExit(code); },
      sched_yield() { return E.SUCCESS; },
      poll_oneoff(inp, out, nsubs, nevents) {
        // every subscription happens at once (a sleep does not wait; reads never block here)
        const v = dv();
        for (let i = 0; i < nsubs; i++) {
          const s = inp + i * 48, o = out + i * 32;
          v.setBigUint64(o, v.getBigUint64(s, true), true);
          v.setUint16(o + 8, 0, true);
          v.setUint8(o + 10, v.getUint8(s + 8));
          for (let k = 16; k < 32; k += 8) v.setBigUint64(o + k, 0n, true);
        }
        v.setUint32(nevents, nsubs, true);
        return E.SUCCESS;
      },
      fd_advise() { return E.SUCCESS; },
      fd_allocate() { return E.SUCCESS; },
      fd_datasync() { return E.SUCCESS; },
      fd_sync() { return E.SUCCESS; },
      fd_close(n) { if (!w.fds.has(n) || n < 3) return n < 3 ? E.SUCCESS : E.BADF; w.fds.delete(n); return E.SUCCESS; },
      fd_fdstat_get(n, buf) {
        const o = fdOf(n); if (!o) return E.BADF;
        const v = dv();
        v.setUint8(buf, o.std !== undefined ? FT.CHAR : ftype(o.node)); v.setUint16(buf + 2, o.append ? 1 : 0, true);
        v.setBigUint64(buf + 8, RIGHTS_ALL, true); v.setBigUint64(buf + 16, RIGHTS_ALL, true);
        return E.SUCCESS;
      },
      fd_fdstat_set_flags(n, flags) { const o = fdOf(n); if (!o) return E.BADF; o.append = !!(flags & 1); return E.SUCCESS; },
      fd_filestat_get(n, buf) { const o = fdOf(n); if (!o) return E.BADF; statInto(o.std !== undefined ? { type: 'dev', ino: 0 } : o.node, buf); return E.SUCCESS; },
      fd_filestat_set_size(n, size) { const o = fdOf(n); if (!o || !o.node || o.node.type !== 'file') return E.BADF; const s = Number(size); grow(o.node, s); if (s > o.node.size) o.node.data.fill(0, o.node.size, s); o.node.size = s; return E.SUCCESS; },
      fd_filestat_set_times() { return E.SUCCESS; },
      fd_pread(n, iov, cnt, off, nread) { const o = fdOf(n); if (!o || !o.node || o.node.type !== 'file') return E.BADF; dv().setUint32(nread, readInto(o, iovs(iov, cnt), Number(off)), true); return E.SUCCESS; },
      fd_pwrite(n, iov, cnt, off, nw) { const o = fdOf(n); if (!o || !o.node || o.node.type !== 'file') return E.BADF; dv().setUint32(nw, writeFrom(o, iovs(iov, cnt), Number(off)), true); return E.SUCCESS; },
      fd_read(n, iov, cnt, nread) { const o = fdOf(n); if (!o) return E.BADF; if (o.node && o.node.type === 'dir') return E.ISDIR; dv().setUint32(nread, readInto(o, iovs(iov, cnt)), true); return E.SUCCESS; },
      fd_write(n, iov, cnt, nw) { const o = fdOf(n); if (!o) return E.BADF; if (o.node && o.node.type === 'dir') return E.ISDIR; dv().setUint32(nw, writeFrom(o, iovs(iov, cnt)), true); return E.SUCCESS; },
      fd_seek(n, off, whence, out) {
        const o = fdOf(n); if (!o) return E.BADF;
        if (o.std !== undefined || o.node.type !== 'file') return E.SPIPE;
        const base = whence === 0 ? 0 : whence === 1 ? o.pos : o.node.size, p = base + Number(off);
        if (p < 0) return E.INVAL;
        o.pos = p; dv().setBigUint64(out, BigInt(p), true); return E.SUCCESS;
      },
      fd_tell(n, out) { const o = fdOf(n); if (!o || !o.node) return E.BADF; dv().setBigUint64(out, BigInt(o.pos || 0), true); return E.SUCCESS; },
      fd_prestat_get(n, buf) { const o = fdOf(n); if (!o || !o.pre) return E.BADF; const v = dv(); v.setUint8(buf, 0); v.setUint32(buf + 4, new TextEncoder().encode(o.pre).length, true); return E.SUCCESS; },
      fd_prestat_dir_name(n, p, len) { const o = fdOf(n); if (!o || !o.pre) return E.BADF; u8().set(new TextEncoder().encode(o.pre).subarray(0, len), p); return E.SUCCESS; },
      fd_readdir(n, buf, len, cookie, used) {
        const o = fdOf(n); if (!o || !o.node || o.node.type !== 'dir') return E.BADF;
        const list = [['.', o.node], ['..', o.node], ...o.node.entries];
        const v = dv(), mem = u8(), enc = new TextEncoder();
        let p = buf, end = buf + len;
        for (let i = Number(cookie); i < list.length && p < end; i++) {
          const [name, node] = list[i], nb = enc.encode(name), head = new Uint8Array(24), hv = new DataView(head.buffer);
          hv.setBigUint64(0, BigInt(i + 1), true); hv.setBigUint64(8, BigInt(node.ino || 0), true); hv.setUint32(16, nb.length, true); hv.setUint8(20, ftype(node));
          const rec = new Uint8Array(24 + nb.length); rec.set(head); rec.set(nb, 24);
          const take = Math.min(rec.length, end - p);
          mem.set(rec.subarray(0, take), p); p += take;
        }
        v.setUint32(used, p - buf, true);
        return E.SUCCESS;
      },
      fd_renumber(a, b) { const o = fdOf(a); if (!o) return E.BADF; w.fds.set(b, o); w.fds.delete(a); return E.SUCCESS; },
      path_create_directory(dirfd, p, n) {
        const r = resolve(dirfd, p, n, { parent: true });
        if (r.err) return r.err; if (!r.dir || r.dir.type !== 'dir') return E.NOENT; if (r.dir.entries.has(r.name)) return E.EXIST;
        const d = dirNode(); d.ino = w.fs.ino++; r.dir.entries.set(r.name, d); return E.SUCCESS;
      },
      path_filestat_get(dirfd, flags, p, n, buf) { const r = resolve(dirfd, p, n); if (r.err) return r.err; if (!r.node) return E.NOENT; statInto(r.node, buf); return E.SUCCESS; },
      path_filestat_set_times() { return E.SUCCESS; },
      path_link() { return E.NOTSUP; },
      path_symlink() { return E.NOTSUP; },
      path_readlink(dirfd, p, n) { const r = resolve(dirfd, p, n); return r.node ? E.INVAL : E.NOENT; },
      path_open(dirfd, dirflags, p, n, oflags, rb, ri, fdflags, out) {
        const r = resolve(dirfd, p, n, { parent: true });
        if (r.err) return r.err;
        if (!r.dir || r.dir.type !== 'dir') return E.NOENT;
        let node = r.name === undefined ? r.dir : r.dir.entries.get(r.name);
        if (node && (oflags & 4) && (oflags & 1)) return E.EXIST;
        if (!node) {
          if (!(oflags & 1)) return E.NOENT;
          node = { type: 'file', data: new Uint8Array(0), size: 0, ino: w.fs.ino++ };
          r.dir.entries.set(r.name, node);
        }
        if ((oflags & 2) && node.type !== 'dir') return E.NOTDIR;
        if ((oflags & 8) && node.type === 'file') node.size = 0;
        const f = w.next++;
        w.fds.set(f, { node, pos: 0, path: r.path, append: !!(fdflags & 1) });
        dv().setUint32(out, f, true);
        return E.SUCCESS;
      },
      path_remove_directory(dirfd, p, n) {
        const r = resolve(dirfd, p, n, { parent: true }); if (r.err) return r.err;
        const node = r.dir && r.dir.entries.get(r.name); if (!node) return E.NOENT; if (node.type !== 'dir') return E.NOTDIR; if (node.entries.size) return E.NOTEMPTY;
        r.dir.entries.delete(r.name); return E.SUCCESS;
      },
      path_rename(fa, pa, na, fb, pb, nb) {
        const a = resolve(fa, pa, na, { parent: true }), b = resolve(fb, pb, nb, { parent: true });
        if (a.err || b.err) return a.err || b.err;
        const node = a.dir && a.dir.entries.get(a.name); if (!node || !b.dir) return E.NOENT;
        a.dir.entries.delete(a.name); b.dir.entries.set(b.name, node); return E.SUCCESS;
      },
      path_unlink_file(dirfd, p, n) {
        const r = resolve(dirfd, p, n, { parent: true }); if (r.err) return r.err;
        const node = r.dir && r.dir.entries.get(r.name); if (!node) return E.NOENT; if (node.type === 'dir') return E.ISDIR;
        r.dir.entries.delete(r.name); return E.SUCCESS;
      },
      sock_accept() { return E.NOTSUP; },
      sock_recv() { return E.NOTSUP; },
      sock_send() { return E.NOTSUP; },
      sock_shutdown() { return E.NOTSUP; },
    };
    function putStrings(list, ptrs, buf) {
      const v = dv(), mem = u8(), enc = new TextEncoder();
      let p = buf;
      list.forEach((s, i) => { v.setUint32(ptrs + i * 4, p, true); const b = enc.encode(s); mem.set(b, p); mem[p + b.length] = 0; p += b.length + 1; });
      return E.SUCCESS;
    }
  }
}

/** The files of a zip (stored or deflate) → Map(name → Uint8Array), inflated with DecompressionStream (browsers, Node 18+). */
export async function unzip(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = b.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip');   // i18n-ignore: a programming error (the vendored files are checked)
  const n = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const jobs = [], dec = new TextDecoder();
  for (let i = 0; i < n; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip directory');   // i18n-ignore: a programming error (the vendored files are checked)
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true);
    const off = v.getUint32(p + 42, true), name = dec.decode(b.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true), raw = b.subarray(start, start + csize);
    if (method === 0) jobs.push(Promise.resolve([name, raw]));
    else if (method === 8) jobs.push(new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer().then((x) => [name, new Uint8Array(x)]));
    else throw new Error(name + ': zip method ' + method);   // i18n-ignore: a programming error (the vendored files are checked)
  }
  return new Map(await Promise.all(jobs));
}
