/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

function jsonToYaml(obj: any, indent = 0): string {
  const sp = '  '.repeat(indent);
  let yaml = '';
  if (Array.isArray(obj)) {
    obj.forEach(item => {
      yaml += typeof item === 'object' ? `${sp}- ${jsonToYaml(item, indent + 1)}\n` : `${sp}- ${item}\n`;
    });
  } else if (obj && typeof obj === 'object') {
    Object.entries(obj).forEach(([k, v]) => {
      yaml += `${sp}${k}: `;
      yaml += typeof v === 'object' && v !== null ? '\n' + jsonToYaml(v, indent + 1) : `${v}\n`;
    });
  } else { yaml += `${obj}\n`; }
  return yaml.trim();
}

function parseSimpleYaml(yaml: string): Record<string, string> {
  const obj: Record<string, string> = {};
  yaml.split('\n').forEach(line => {
    const t = line.trim();
    if (t && !t.startsWith('#') && t.includes(':')) {
      const [k, ...v] = t.split(':');
      obj[k!.trim()] = v.join(':').trim();
    }
  });
  return obj;
}

function parseCsv(csv: string): string[][] {
  return csv.split('\n').filter(l => l.trim())
    .map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
}

const converters: Record<string, (input: string) => string> = {
  'txt-json': t => JSON.stringify({ content: t.trim() }, null, 2),
  'txt-csv':  t => t.split('\n').filter(l => l.trim()).map(l => `"${l.trim()}"`).join('\n'),
  'txt-yaml': t => `content: |\n  ${t.trim().split('\n').join('\n  ')}`,
  'txt-md':   t => t.split('\n').map(l => l.trim() ? l : '').join('\n'),

  'json-txt':  json => { try { const o = JSON.parse(json); return o.content ?? JSON.stringify(o, null, 2); } catch { return json; } },
  'json-yaml': json => { try { return jsonToYaml(JSON.parse(json)); } catch { return json; } },
  'json-csv':  json => {
    try {
      const arr = Array.isArray(JSON.parse(json)) ? JSON.parse(json) : [JSON.parse(json)];
      if (!arr.length) return '';
      const keys = Object.keys(arr[0]);
      return [keys.join(','), ...arr.map((r: any) => keys.map(k => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
    } catch { return json; }
  },
  'json-md': json => {
    try {
      const arr = Array.isArray(JSON.parse(json)) ? JSON.parse(json) : [JSON.parse(json)];
      if (!arr.length) return '';
      const keys = Object.keys(arr[0]);
      return [`| ${keys.join(' | ')} |`, `| ${keys.map(() => '---').join(' | ')} |`,
        ...arr.map((r: any) => `| ${keys.map(k => String(r[k] ?? '')).join(' | ')} |`)].join('\n');
    } catch { return json; }
  },

  'yaml-txt':  yaml => Object.values(parseSimpleYaml(yaml)).join('\n'),
  'yaml-json': yaml => JSON.stringify(parseSimpleYaml(yaml), null, 2),
  'yaml-csv':  yaml => Object.entries(parseSimpleYaml(yaml)).map(([k, v]) => `"${k}","${v}"`).join('\n'),
  'yaml-md':   yaml => {
    const obj = parseSimpleYaml(yaml);
    return [`| Key | Value |`, `| --- | --- |`, ...Object.entries(obj).map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
  },

  'csv-txt':  csv => parseCsv(csv).map(r => r.join('\t')).join('\n'),
  'csv-json': csv => {
    const rows = parseCsv(csv);
    if (rows.length < 2) return JSON.stringify(rows);
    const [headers, ...data] = rows;
    return JSON.stringify(data.map(r => Object.fromEntries(headers!.map((h, i) => [h, r[i] ?? '']))), null, 2);
  },
  'csv-yaml': csv => {
    const rows = parseCsv(csv);
    if (rows.length < 2) return csv;
    const [headers, ...data] = rows;
    return data.map((r, i) => `row_${i + 1}:\n${headers!.map((h, j) => `  ${h}: "${r[j] ?? ''}"`).join('\n')}`).join('\n');
  },
  'csv-md': csv => {
    const rows = parseCsv(csv);
    if (!rows.length) return '';
    const [header, ...data] = rows;
    return [`| ${header!.join(' | ')} |`, `| ${header!.map(() => '---').join(' | ')} |`,
      ...data.map(r => `| ${r.join(' | ')} |`)].join('\n');
  },

  'md-txt':  md => md.replace(/#{1,6}\s/g, '').replace(/\*\*|__|[*_`]/g, '').replace(/\[(.+?)\]\(.+?\)/g, '$1'),
  'md-json': md => JSON.stringify({ content: md.trim(), lines: md.split('\n').length }, null, 2),
  'md-yaml': md => `content: |\n  ${md.trim().split('\n').join('\n  ')}`,
  'md-csv':  md => md.split('\n').filter(l => l.trim()).map(l => `"${l.replace(/^#{1,6}\s/, '').trim()}"`).join('\n'),

  '*-txt':  t => t,
  '*-json': t => JSON.stringify({ content: t.trim() }, null, 2),
  '*-yaml': t => `content: |\n  ${t.trim().split('\n').join('\n  ')}`,
  '*-csv':  t => t.split('\n').filter(l => l.trim()).map(l => `"${l.trim()}"`).join('\n'),
  '*-md':   t => t,
};

interface ConvertMsg { id: string; text: string; inFmt: string; outFmt: string; outMime: string; }

self.onmessage = (e: MessageEvent<ConvertMsg>) => {
  const { id, text, inFmt, outFmt, outMime } = e.data;
  try {
    const key = `${inFmt}-${outFmt}`;
    const converted = converters[key]?.(text) ?? converters[`*-${outFmt}`]?.(text) ?? text;
    const buf = new TextEncoder().encode(converted);
    self.postMessage({ id, buf, outMime }, [buf.buffer]);
  } catch (err: any) {
    self.postMessage({ id, error: err?.message ?? 'Conversion failed' });
  }
};