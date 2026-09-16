/**
 * CSV 读写（无第三方依赖）
 * 支持引号转义、BOM、CRLF
 */
const fs = require('fs');

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

function toCsv(rows) {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const s = v == null ? '' : String(v);
          return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        })
        .join(',')
    )
    .join('\r\n');
}

/** 读成对象数组，返回 { headers, records } */
function readCsv(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => String(h).trim());
  const records = rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => (o[h] = r[i] == null ? '' : String(r[i]).trim()));
    return o;
  });
  return { headers, records };
}

/** 写 CSV，带 BOM 以便 Excel 正确识别 UTF-8 */
function writeCsv(file, headers, records) {
  const rows = [headers, ...records.map((r) => headers.map((h) => r[h] ?? ''))];
  fs.writeFileSync(file, '\ufeff' + toCsv(rows), 'utf8');
}

module.exports = { readCsv, writeCsv, parseCsv, toCsv };
