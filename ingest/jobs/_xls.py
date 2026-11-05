"""Minimal pure-Python reader for legacy Excel .xls (BIFF8, plus BIFF5 labels) — stdlib only.

OLE2 compound document -> 'Workbook'/'Book' stream -> BIFF records.  Supports: BOUNDSHEET (sheet names), SST (+CONTINUE),
LABELSST, LABEL, RSTRING, NUMBER, RK, MULRK, FORMULA (cached numeric/string result via STRING), BOOLERR (ignored).
API mirrors the xlsx Book in orcamento.py: `.sheets` = [(name, idx)], `.rows(name)` -> {row(1-based): {col(0-based): value}}.
"""
import struct

ENDOFCHAIN = 0xFFFFFFFE
FREESECT = 0xFFFFFFFF


class OLE:
    def __init__(self, data):
        if data[:8] != b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1":
            raise ValueError("not an OLE2 compound document")
        self.d = data
        ss = 1 << struct.unpack_from("<H", data, 30)[0]
        mss = 1 << struct.unpack_from("<H", data, 32)[0]
        n_fat, first_dir, _, mini_cut, first_minifat, n_minifat, first_difat, n_difat = struct.unpack_from("<IIIIIIII", data, 44)
        self.ss, self.mss, self.mini_cut = ss, mss, mini_cut
        difat = list(struct.unpack_from("<109I", data, 76))
        s = first_difat
        for _ in range(n_difat):
            if s in (ENDOFCHAIN, FREESECT):
                break
            vals = struct.unpack_from(f"<{ss // 4}I", data, self._off(s))
            difat += vals[:-1]
            s = vals[-1]
        fat = []
        for s in difat[:n_fat]:
            if s in (ENDOFCHAIN, FREESECT):
                continue
            fat += struct.unpack_from(f"<{ss // 4}I", data, self._off(s))
        self.fat = fat
        dirdata = self._chain(first_dir)
        self.entries = []
        for i in range(len(dirdata) // 128):
            e = dirdata[i * 128:(i + 1) * 128]
            nlen = struct.unpack_from("<H", e, 64)[0]
            name = e[:max(0, nlen - 2)].decode("utf-16-le", "replace")
            typ = e[66]
            start, size = struct.unpack_from("<II", e, 116)
            self.entries.append((name, typ, start, size))
        root = self.entries[0]
        self.ministream = self._chain(root[2])[:root[3]] if root[2] not in (ENDOFCHAIN, FREESECT) else b""
        self.minifat = []
        if n_minifat and first_minifat not in (ENDOFCHAIN, FREESECT):
            mf = self._chain(first_minifat)
            self.minifat = list(struct.unpack_from(f"<{len(mf) // 4}I", mf))

    def _off(self, s):
        return (s + 1) * self.ss

    def _chain(self, s):
        out, seen = [], set()
        while s not in (ENDOFCHAIN, FREESECT) and s < len(self.fat) and s not in seen:
            seen.add(s)
            out.append(self.d[self._off(s):self._off(s) + self.ss])
            s = self.fat[s]
        return b"".join(out)

    def stream(self, name):
        for n, typ, start, size in self.entries:
            if typ == 2 and n.lower() == name.lower():
                if size < self.mini_cut:
                    out, s = [], start
                    while s not in (ENDOFCHAIN, FREESECT) and s < len(self.minifat):
                        out.append(self.ministream[s * self.mss:(s + 1) * self.mss])
                        s = self.minifat[s]
                    return b"".join(out)[:size]
                return self._chain(start)[:size]
        return None


def _rk(v):
    if v & 2:
        x = float(v >> 2) if not (v >> 31) else float((v >> 2) - (1 << 30))
    else:
        x = struct.unpack("<d", struct.pack("<Q", (v & 0xFFFFFFFC) << 32))[0]
    return x / 100.0 if v & 1 else x


class _Seg:
    """Concatenated SST+CONTINUE payload; character reads re-read the option byte at record boundaries."""
    def __init__(self, parts):
        self.buf = b"".join(parts)
        self.bounds = set()
        o = 0
        for p in parts[:-1]:
            o += len(p)
            self.bounds.add(o)
        self.pos = 0

    def u8(self):
        v = self.buf[self.pos]
        self.pos += 1
        return v

    def u16(self):
        v = struct.unpack_from("<H", self.buf, self.pos)[0]
        self.pos += 2
        return v

    def u32(self):
        v = struct.unpack_from("<I", self.buf, self.pos)[0]
        self.pos += 4
        return v

    def chars(self, n, wide):
        out = []
        while n > 0 and self.pos < len(self.buf):
            if out and self.pos in self.bounds:
                wide = bool(self.u8() & 1)          # continuation record: new option byte
            nxt = min([b for b in self.bounds if b > self.pos] or [len(self.buf)])
            per = 2 if wide else 1
            take = min(n, max(1, (nxt - self.pos) // per))
            raw = self.buf[self.pos:self.pos + take * per]
            out.append(raw.decode("utf-16-le", "replace") if wide else raw.decode("latin-1"))
            self.pos += take * per
            n -= take
        return "".join(out)


def _xlstr(data, off, lenbytes=2, biff8=True):
    """XLUnicodeString inside one record -> (text, new_offset)."""
    n = data[off] if lenbytes == 1 else struct.unpack_from("<H", data, off)[0]
    off += lenbytes
    if not biff8:
        return data[off:off + n].decode("cp1252", "replace"), off + n
    flags = data[off]
    off += 1
    rich = ext = 0
    if flags & 8:
        rich = struct.unpack_from("<H", data, off)[0]
        off += 2
    if flags & 4:
        ext = struct.unpack_from("<I", data, off)[0]
        off += 4
    if flags & 1:
        s = data[off:off + 2 * n].decode("utf-16-le", "replace")
        off += 2 * n
    else:
        s = data[off:off + n].decode("latin-1")
        off += n
    return s, off + 4 * rich + ext


class XlsBook:
    def __init__(self, path):
        ole = OLE(open(path, "rb").read())
        wb = ole.stream("Workbook") or ole.stream("Book")
        if wb is None:
            raise ValueError("no Workbook stream")
        self.wb = wb
        self.biff8 = True
        self.sst = []
        self._sheets = []          # (name, bof_offset)
        pos, sst_parts, in_sst = 0, [], False
        first = True
        while pos + 4 <= len(wb):
            rid, ln = struct.unpack_from("<HH", wb, pos)
            data = wb[pos + 4:pos + 4 + ln]
            if first and rid == 0x0809:
                self.biff8 = struct.unpack_from("<H", data, 0)[0] == 0x0600
                first = False
            if rid == 0x0085:          # BOUNDSHEET
                off = struct.unpack_from("<I", data, 0)[0]
                name, _ = _xlstr(data, 6, 1, self.biff8)
                self._sheets.append((name, off))
            elif rid == 0x00FC:        # SST
                sst_parts, in_sst = [data], True
            elif rid == 0x003C and in_sst:
                sst_parts.append(data)
            else:
                if in_sst:
                    self._parse_sst(sst_parts)
                    in_sst = False
                if rid == 0x000A and self._sheets and pos > 0:
                    break                  # end of workbook globals
            pos += 4 + ln
        if in_sst:
            self._parse_sst(sst_parts)
        self.sheets = [(n, i) for i, (n, _) in enumerate(self._sheets)]

    def _parse_sst(self, parts):
        s = _Seg(parts)
        s.pos = 4
        n = s.u32()
        for _ in range(n):
            if s.pos >= len(s.buf):
                break
            cch = s.u16()
            flags = s.u8()
            rich = s.u16() if flags & 8 else 0
            ext = s.u32() if flags & 4 else 0
            self.sst.append(s.chars(cch, bool(flags & 1)))
            s.pos += 4 * rich + ext

    def rows(self, name):
        off = dict(self._sheets)[name]
        wb, out = self.wb, {}
        pos = off
        pending = None                 # FORMULA with string result waiting for STRING record

        def put(r, c, v):
            if isinstance(v, str):
                v = " ".join(v.split())
                if not v:
                    return
            out.setdefault(r + 1, {})[c] = v
        while pos + 4 <= len(wb):
            rid, ln = struct.unpack_from("<HH", wb, pos)
            d = wb[pos + 4:pos + 4 + ln]
            pos += 4 + ln
            if rid == 0x000A:
                break
            if rid == 0x00FD and ln >= 10:
                r, c, _, i = struct.unpack_from("<HHHI", d)
                if i < len(self.sst):
                    put(r, c, self.sst[i])
            elif rid == 0x0203 and ln >= 14:
                r, c, _, v = struct.unpack_from("<HHHd", d)
                put(r, c, v)
            elif rid == 0x027E and ln >= 10:
                r, c, _, v = struct.unpack_from("<HHHI", d)
                put(r, c, _rk(v))
            elif rid == 0x00BD and ln >= 6:
                r, c0 = struct.unpack_from("<HH", d)
                k = (ln - 6) // 6
                for j in range(k):
                    _, v = struct.unpack_from("<HI", d, 4 + 6 * j)
                    put(r, c0 + j, _rk(v))
            elif rid in (0x0204, 0x00D6) and ln >= 8:     # LABEL, RSTRING
                r, c, _ = struct.unpack_from("<HHH", d)
                s, _ = _xlstr(d, 6, 2, self.biff8)
                put(r, c, s)
            elif rid in (0x0006, 0x0406) and ln >= 14:    # FORMULA
                r, c, _ = struct.unpack_from("<HHH", d)
                res = d[6:14]
                if res[6:8] == b"\xff\xff":
                    pending = (r, c) if res[0] == 0 else None
                else:
                    put(r, c, struct.unpack("<d", res)[0])
            elif rid == 0x0207 and pending:               # STRING (formula result)
                s, _ = _xlstr(d, 0, 2, self.biff8)
                put(pending[0], pending[1], s)
                pending = None
        return out
