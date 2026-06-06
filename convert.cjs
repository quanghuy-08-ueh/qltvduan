/*
 * convert.cjs — Trích xuất dữ liệu từ QLTV.txt (script SQL) ra JSON cho 3dhtml.html
 *
 * Đọc các bảng chiều + bảng sự kiện ChiTietMuonTra, join lại thành các bản ghi
 * phẳng (fact records) đúng cấu trúc mà 3dhtml.html cần, đồng thời sinh danh
 * sách thành viên (members) cho từng chiều.
 *
 * Xuất ra:
 *   - qltv-data.json : JSON thuần (dimensions + records)
 *   - qltv-data.js   : window.QLTV_DATA = <JSON>  (để nạp được khi mở bằng file://)
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'QLTV.txt');
const TOP_N = 10; // số thành viên tối đa hiển thị trên mỗi trục (giữ khối 3D nhẹ)

// ---- Tách các field trong 1 tuple, tôn trọng chuỗi 'N'...'' có chứa dấu phẩy ----
function splitTuple(body) {
  const out = [];
  let cur = '', inStr = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'") {
      cur += c;
      if (inStr && body[i + 1] === "'") { cur += "'"; i++; } // '' = dấu nháy escape
      else inStr = !inStr;
    } else if (c === ',' && !inStr) {
      out.push(cur.trim()); cur = '';
    } else cur += c;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}
function val(tok) {
  tok = tok.trim();
  if (tok === 'NULL') return null;
  const m = tok.match(/^N?'([\s\S]*)'$/);
  if (m) return m[1].replace(/''/g, "'");
  return tok; // số dạng chuỗi
}

// ---- Quét file, gom các tuple value theo từng bảng ----
const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
const tables = {}; // tên bảng -> mảng tuple (mỗi tuple là mảng field)
let current = null;
for (let raw of lines) {
  const ins = raw.match(/INSERT\s+INTO\s+(\w+)/i);
  if (ins) { current = ins[1]; if (!tables[current]) tables[current] = []; continue; }
  if (!current) continue;
  const line = raw.trim();
  if (!line.startsWith('(')) continue;       // chỉ dòng tuple
  if (line.indexOf("'") === -1) continue;     // bỏ dòng cột (MaPhieu, ...) — không có nháy
  const body = line.replace(/^\(/, '').replace(/\)\s*[,;]?\s*$/, '');
  tables[current].push(splitTuple(body).map(val));
}

// ---- Dựng các map tra cứu chiều ----
const theLoai = {};   (tables.TheLoai    || []).forEach(r => theLoai[r[0]] = r[1]);          // Ma -> Ten
const nxb = {};       (tables.NhaXuatBan || []).forEach(r => nxb[r[0]] = r[1]);              // Ma -> Ten
const nhanVien = {};  (tables.NhanVien   || []).forEach(r => nhanVien[r[0]] = r[1]);         // Ma -> Ten
const tacGia = {};    (tables.TacGia     || []).forEach(r => tacGia[r[0]] = r[1]);           // Ma -> Ten
const dauSach = {};   (tables.DauSach    || []).forEach(r => dauSach[r[0]] = { tl: r[2], nxb: r[3] });
const quyenSach = {}; (tables.QuyenSach  || []).forEach(r => quyenSach[r[0]] = r[2]);        // MaQS -> MaDauSach
const banDoc = {};    (tables.BanDoc     || []).forEach(r => banDoc[r[0]] = { ns: r[2], gt: r[3] });
const sachTG = {};    (tables.Sach_TacGia|| []).forEach(r => { if (!sachTG[r[0]]) sachTG[r[0]] = r[1]; }); // DauSach -> 1 TacGia

// ---- Tiện ích ngày ----
const dt = s => { const [y, m, d] = s.split('-').map(Number); return { y, m, d, t: Date.UTC(y, m - 1, d) }; };
const dayDiff = (a, b) => Math.round((b.t - a.t) / 86400000);

// ---- Dựng fact records từ ChiTietMuonTra ----
// cột: MaPhieu, MaQuyenSach, MaBanDoc, MaNV, NgayMuon, NgayHenTra, NgayTraThucTe
const records = [];
let skipped = 0;
for (const r of (tables.ChiTietMuonTra || [])) {
  const [maPhieu, maQS, maBD, maNV, ngayMuon, ngayHen, ngayTra] = r;
  if (!ngayMuon || !ngayHen) { skipped++; continue; }
  const dsCode = quyenSach[maQS];
  const book = dsCode ? dauSach[dsCode] : null;
  const tgCode = dsCode ? sachTG[dsCode] : null;
  const reader = banDoc[maBD] || {};
  const dm = dt(ngayMuon);

  let tienPhat = 0;
  if (ngayTra) {
    const tr = dt(ngayTra), hen = dt(ngayHen);
    if (tr.t > hen.t) tienPhat = dayDiff(hen, tr) * 5000; // 5.000đ/ngày trễ (theo trigger)
  }

  records.push({
    pm: maPhieu,
    nam: String(dm.y),
    quy: 'Quý ' + Math.ceil(dm.m / 3),
    thang: 'Tháng ' + dm.m,
    nv: nhanVien[maNV] || 'Không rõ',
    tl: (book && theLoai[book.tl]) || 'Không rõ',
    gt: reader.gt || 'Không rõ',
    ns: reader.ns ? String(reader.ns) : 'Không rõ',
    nxb: (book && nxb[book.nxb]) || 'Không rõ',
    tg: (tgCode && tacGia[tgCode]) || 'Không rõ',
    sachCount: 1,
    ngayMuon: dayDiff(dt(ngayMuon), dt(ngayHen)),
    tienPhat
  });
}

// ---- Sinh members cho từng chiều ----
const topN = (field, n) => {
  const c = {};
  records.forEach(r => { c[r[field]] = (c[r[field]] || 0) + 1; });
  return Object.entries(c).filter(e => e[0] !== 'Không rõ')
    .sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);
};
const years = [...new Set(records.map(r => r.nam))].sort();
const quarters = ['Quý 1', 'Quý 2', 'Quý 3', 'Quý 4'];
const months = Array.from({ length: 12 }, (_, i) => 'Tháng ' + (i + 1));
const genders = ['Nam', 'Nữ'].filter(g => records.some(r => r.gt === g));
const birthYears = topN('ns', TOP_N).sort((a, b) => Number(a) - Number(b));

const dimensions = {
  thoi_gian_nam: years,
  thoi_gian_quy: quarters,
  thoi_gian_thang: months,
  nhan_vien: topN('nv', TOP_N),
  the_loai: topN('tl', TOP_N),
  doc_gia_gt: genders,
  doc_gia_ns: birthYears,
  nha_xuat_ban: topN('nxb', TOP_N),
  tac_gia: topN('tg', TOP_N)
};

const data = {
  meta: { source: 'QLTV.txt', recordCount: records.length, skipped, topN: TOP_N },
  dimensions,
  records
};

fs.writeFileSync(path.join(__dirname, 'qltv-data.json'), JSON.stringify(data));
fs.writeFileSync(path.join(__dirname, 'qltv-data.js'), 'window.QLTV_DATA = ' + JSON.stringify(data) + ';\n');

console.log('Records:', records.length, '| skipped:', skipped);
console.log('Dimensions (số member):');
for (const k in dimensions) console.log('  ', k.padEnd(16), dimensions[k].length, '→', dimensions[k].slice(0, 5).join(', ') + (dimensions[k].length > 5 ? ' …' : ''));
const fs2 = fs.statSync(path.join(__dirname, 'qltv-data.json'));
console.log('qltv-data.json:', (fs2.size / 1024).toFixed(1), 'KB');
