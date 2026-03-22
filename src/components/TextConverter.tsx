import { useState, useCallback } from 'react';
import type { ChangeEvent } from 'react';
import type { TextFormat } from '../types';
import { textInputFormats, textOutputFormats } from '../constants';

const converters: Record<string, (input: string, inType: string, outType: string) => string> = {
  'txt-json': (t) => JSON.stringify({ content: t.trim() }, null, 2),
  'txt-csv': (t) => t.split('\n').filter(l => l.trim()).map(l => `"${l.trim()}"`).join('\n'),
  'txt-yaml': (t) => `content: |\n  ${t.trim().split('\n').join('\n  ')}`,
  'txt-html': (t) => `<pre style="white-space:pre-wrap">${t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`,
  'txt-log': (t) => `[${new Date().toISOString()}]\n${t}\n--- END LOG ---\n`,
  'txt-upper': (t) => t.toUpperCase(),
  'txt-base64': (t) => btoa(unescape(encodeURIComponent(t))),
  'json-yaml': (json) => { try { return jsonToYaml(JSON.parse(json)); } catch { return json; } },
  'json-txt': (json) => { try { const o = JSON.parse(json); return o.content || JSON.stringify(o, null, 2); } catch { return json; } },
  'yaml-json': (yaml) => {
    const obj: any = {};
    yaml.split('\n').forEach(line => {
      const t = line.trim();
      if (t && !t.startsWith('#') && t.includes(':')) {
        const [k, ...v] = t.split(':');
        obj[k!.trim()] = v.join(':').trim();
      }
    });
    return JSON.stringify(obj, null, 2);
  },
  'yaml-csv': (yaml) => yaml.split('\n').filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.includes(':') ? `"${l.split(':')[1]?.trim() || ''}"` : `"${l.trim()}"`).join('\n'),
  'yaml-txt': (yaml) => yaml.split('\n').filter(l => l.includes(':')).map(l => l.split(':')[1]?.trim() || l).join('\n'),
  'csv-yaml': (csv) => csv.split('\n').filter(l => l.trim()).map((l, i) => `row_${i+1}: "${l.trim()}"`).join('\n'),
  '*-txt': (t) => t,
  '*-upper': (t) => t.toUpperCase(),
  '*-base64': (t) => btoa(unescape(encodeURIComponent(t))),
};

function jsonToYaml(obj: any, indent = 0): string {
  const sp = '  '.repeat(indent);
  let yaml = '';
  if (Array.isArray(obj)) {
    obj.forEach(item => {
      yaml += typeof item === 'object'
        ? `${sp}- ${jsonToYaml(item, indent + 1)}\n`
        : `${sp}- ${item}\n`;
    });
  } else if (obj && typeof obj === 'object') {
    Object.entries(obj).forEach(([k, v]) => {
      yaml += `${sp}${k}: `;
      yaml += typeof v === 'object' && v !== null ? '\n' + jsonToYaml(v, indent + 1) : `${v}\n`;
    });
  } else { yaml += `${obj}\n`; }
  return yaml.trim();
}

export const TextConverter = () => {
  const [result, setResult] = useState<string | null>(null);
  const [preview, setPreview] = useState('');
  const [inputType, setInputType] = useState<TextFormat>(textInputFormats[0]);
  const [outputType, setOutputType] = useState<TextFormat>(textOutputFormats[1]);
  const [converting, setConverting] = useState(false);

  const getKey = useCallback((a: string, b: string) => `${a}-${b}`, []);

  const convertText = async () => {
    const fi = document.getElementById('textFile') as HTMLInputElement;
    const file = fi?.files?.[0];
    if (!file) return;
    setConverting(true);
    try {
      const text = await file.text();
      const key = getKey(inputType.id, outputType.id);
      const converted = converters[key]?.(text, inputType.id, outputType.id)
        ?? (converters[`*-${outputType.id}`] as any)?.(text, inputType.id, outputType.id)
        ?? text;
      const blob = new Blob([converted], { type: outputType.mime });
      setResult(URL.createObjectURL(blob));
      setPreview(converted.length > 500 ? converted.slice(0, 500) + '…' : converted);
    } catch (e) { console.error(e); }
    finally { setConverting(false); }
  };

  const download = () => {
    if (!result) return;
    const a = document.createElement('a');
    a.href = result;
    a.download = `converted-${Date.now()}.${outputType.ext}`;
    a.click();
    URL.revokeObjectURL(result);
  };

  const clear = () => {
    setResult(null); setPreview('');
    const fi = document.getElementById('textFile') as HTMLInputElement;
    if (fi) fi.value = '';
  };

  return (
    <div className="card">
      <div className="format-row">
        <div>
          <label className="label">From</label>
          <select className="select" value={inputType.id}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              setInputType(textInputFormats.find(f => f.id === e.target.value)!);
              setResult(null); setPreview('');
            }} disabled={converting}>
            {textInputFormats.map(f => <option key={f.id} value={f.id}>{f.name.toUpperCase()}</option>)}
          </select>
        </div>
        <div className="format-arrow">→</div>
        <div>
          <label className="label">To</label>
          <select className="select" value={outputType.id}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              setOutputType(textOutputFormats.find(f => f.id === e.target.value)!);
              setResult(null); setPreview('');
            }} disabled={converting}>
            {textOutputFormats.map(f => <option key={f.id} value={f.id}>{f.name.toUpperCase()}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="label">File</label>
        <input id="textFile" type="file" className="file-input"
          accept={inputType.accept} disabled={converting} />
      </div>

      <button className="btn-primary" onClick={convertText} disabled={converting}>
        {converting ? 'Converting…' : 'Convert'}
      </button>

      {preview && (
        <div className="text-preview">
          <span className="text-preview-label">
            Preview · {outputType.name}.{outputType.ext}
          </span>
          <pre>{preview}</pre>
        </div>
      )}

      {result && (
        <div className="result-section">
          <div className="badge badge--success">
            {inputType.name.toUpperCase()} → {outputType.name.toUpperCase()} · ready
          </div>
          <div className="btn-row">
            <button onClick={download} className="btn-download">Download</button>
            <button onClick={clear} className="btn-ghost">Convert another</button>
          </div>
        </div>
      )}
    </div>
  );
};
