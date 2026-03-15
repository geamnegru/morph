import { useState, useCallback } from 'react';
import type { ChangeEvent } from 'react';
import type { TextFormat } from '../types';
import { textInputFormats, textOutputFormats } from '../constants';

const converters: Record<string, (input: string, inputType: string, outputType: string) => string> = {
  'txt-json': (text) => JSON.stringify({ content: text.trim() }, null, 2),
  'txt-csv': (text) => text.split('\n').filter(l => l.trim()).map(l => `"${l.trim()}"`).join('\n'),
  'txt-yaml': (text) => `content: |\n  ${text.trim().split('\n').join('\n  ')}`,
  'txt-html': (text) => `<pre style="white-space:pre-wrap">${text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`,
  'txt-log': (text) => `[${new Date().toISOString()}]\n${text}\n--- END LOG ---\n`,
  'txt-upper': (text) => text.toUpperCase(),
  'txt-base64': (text) => btoa(unescape(encodeURIComponent(text))),
  
  'json-yaml': (json) => {
    try {
      const obj = JSON.parse(json);
      return jsonToYaml(obj);
    } catch { return json; }
  },
  'json-txt': (json) => {
    try { 
      const obj = JSON.parse(json);
      return obj.content || JSON.stringify(obj, null, 2);
    } catch { return json; }
  },
  
  'yaml-json': (yaml) => {
    const obj: any = {};
    yaml.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes(':')) {
        const [key, ...value] = trimmed.split(':');
        obj[key!.trim()] = value.join(':').trim();
      }
    });
    return JSON.stringify(obj, null, 2);
  },
  
  'yaml-csv': (yaml) => {
    return yaml.split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .map(l => {
        if (l.includes(':')) {
          return `"${l.split(':')[1]?.trim() || ''}"`;
        }
        return `"${l.trim()}"`;
      })
      .join('\n');
  },
  
  'yaml-txt': (yaml) => yaml.split('\n').filter(l => l.includes(':')).map(l => l.split(':')[1]?.trim() || l).join('\n'),
  
  'csv-yaml': (csv) => {
    const lines = csv.split('\n').filter(l => l.trim());
    let yaml = '';
    lines.forEach((line, i) => {
      yaml += `row_${i + 1}: "${line.trim()}"\n`;
    });
    return yaml;
  },
  
  '*-txt': (text) => text,
  '*-upper': (text) => text.toUpperCase(),
  '*-base64': (text) => btoa(unescape(encodeURIComponent(text)))
};

function jsonToYaml(obj: any, indent = 0): string {
  const spaces = '  '.repeat(indent);
  let yaml = '';
  
  if (Array.isArray(obj)) {
    obj.forEach(item => {
      if (typeof item === 'object') {
        yaml += `${spaces}- ${jsonToYaml(item, indent + 1)}\n`;
      } else {
        yaml += `${spaces}- ${item}\n`;
      }
    });
  } else if (obj && typeof obj === 'object') {
    Object.entries(obj).forEach(([key, value]) => {
      yaml += `${spaces}${key}: `;
      if (typeof value === 'object' && value !== null) {
        yaml += '\n' + jsonToYaml(value, indent + 1);
      } else {
        yaml += `${value}\n`;
      }
    });
  } else {
    yaml += `${obj}\n`;
  }
  return yaml.trim();
}

export const TextConverter = () => {
  const [result, setResult] = useState<string | null>(null);
  const [preview, setPreview] = useState('');
  const [inputType, setInputType] = useState<TextFormat>(textInputFormats[0]);
  const [outputType, setOutputType] = useState<TextFormat>(textOutputFormats[1]); // JSON default
  const [converting, setConverting] = useState(false);

  const getConverterKey = useCallback((inType: string, outType: string): string => {
    return `${inType}-${outType}` as const;
  }, []);

  const convertText = async () => {
    const fileInput = document.getElementById('textFile') as HTMLInputElement;
    const file = fileInput?.files?.[0];
    if (!file) {
      alert('❌ Selectează fișier!');
      return;
    }

    setConverting(true);
    try {
      const text = await file.text();
      const converterKey = getConverterKey(inputType.id, outputType.id);
      
      let converted = text;
      
      if (converters[converterKey]) {
        converted = converters[converterKey](text, inputType.id, outputType.id);
      } 
      else if (converters[`*-${outputType.id}` as keyof typeof converters]) {
        converted = (converters[`*-${outputType.id}` as keyof typeof converters] as any)(text, inputType.id, outputType.id);
      }
      
      const blob = new Blob([converted], { type: outputType.mime });
      const url = URL.createObjectURL(blob);
      
      setResult(url);
      setPreview(converted.length > 500 ? converted.slice(0, 500) + '...' : converted);
      
      console.log(`✅ ${inputType.name} → ${outputType.name}: ${Math.round(converted.length/1024)}KB`);
      
    } catch (error) {
      console.error('❌ Eroare:', error);
      alert('❌ Eroare conversie!');
    } finally {
      setConverting(false);
    }
  };

  const handleInputTypeChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const format = textInputFormats.find(f => f.id === e.target.value)!;
    setInputType(format);
    setResult(null);
    setPreview('');
  };

  const handleOutputTypeChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const format = textOutputFormats.find(f => f.id === e.target.value)!;
    setOutputType(format);
    setResult(null);
    setPreview('');
  };

  const download = () => {
    if (result) {
      const a = document.createElement('a');
      a.href = result;
      a.download = `converted-${inputType.name.toLowerCase()}-to-${outputType.name.toLowerCase()}-${Date.now()}.${outputType.ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(result);
    }
  };

  const clear = () => {
    setResult(null);
    setPreview('');
    const fileInput = document.getElementById('textFile') as HTMLInputElement;
    if (fileInput) fileInput.value = '';
  };

  return (
    <div style={{ maxWidth: '700px', margin: '0 auto', padding: '20px' }}>
      <div style={{ marginBottom: '15px' }}>
        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
          Input Format:
        </label>
        <select 
          value={inputType.id} 
          onChange={handleInputTypeChange} 
          disabled={converting}
          style={{ 
            width: '100%', padding: '12px', borderRadius: '8px', 
            border: '2px solid #ddd', fontSize: '16px' 
          }}
        >
          {textInputFormats.map(format => (
            <option key={format.id} value={format.id}>
              {format.name.toUpperCase()}
            </option>
          ))}
        </select>
      </div>
      <div style={{ marginBottom: '15px' }}>
        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
          Output Format:
        </label>
        <select 
          value={outputType.id} 
          onChange={handleOutputTypeChange} 
          disabled={converting}
          style={{ 
            width: '100%', padding: '12px', borderRadius: '8px', 
            border: '2px solid #ddd', fontSize: '16px' 
          }}
        >
          {textOutputFormats.map(format => (
            <option key={format.id} value={format.id}>
              {format.name.toUpperCase()}
            </option>
          ))}
        </select>
      </div>
      <input 
        id="textFile"
        type="file" 
        accept={inputType.accept} 
        disabled={converting}
        style={{ 
          width: '100%', padding: '12px', 
          border: `2px dashed ${converting ? '#ccc' : '#007bff'}`,
          borderRadius: '8px', marginBottom: '15px', 
          fontSize: '16px', background: converting ? '#f8f9fa' : 'white'
        }} 
      />
      
      <button 
        onClick={convertText} 
        disabled={converting}
        style={{ 
          width: '100%', padding: '15px', 
          background: converting ? '#ccc' : '#007bff', 
          color: 'white', border: 'none', borderRadius: '8px', 
          fontSize: '18px', fontWeight: 'bold', 
          cursor: converting ? 'not-allowed' : 'pointer', 
          marginBottom: '10px'
        }}
      >
        {converting ? `🔄 Convertesc...` : '🚀 CONVERT TEXT'}
      </button>
      {preview && (
        <div style={{ 
          background: '#f8f9fa', padding: '20px', 
          borderRadius: '12px', marginBottom: '20px', 
          maxHeight: '300px', overflow: 'auto',
          fontFamily: 'monospace', fontSize: '14px',
          borderLeft: '4px solid #007bff'
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: '10px', color: '#007bff', fontSize: '16px' }}>
            👀 Preview {outputType.name}.{outputType.ext} ({Math.round(preview.length/1024)}KB):
          </div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {preview}
          </pre>
        </div>
      )}
      {result && (
        <div style={{ 
          padding: '25px', background: '#d4edda', 
          borderRadius: '12px', borderLeft: '5px solid #28a745', 
          textAlign: 'center'
        }}>
          <h3 style={{ marginTop: 0, color: '#155724', fontSize: '24px' }}>
            ✅ Conversie gata!
          </h3>
          <div style={{ marginBottom: '20px', color: '#155724', fontSize: '16px' }}>
            <strong>{inputType.name.toUpperCase()}.{inputType.ext} → {outputType.name.toUpperCase()}.{outputType.ext}</strong>
          </div>
          <button 
            onClick={download}
            style={{ 
              padding: '15px 30px', background: '#28a745', 
              color: 'white', border: 'none', borderRadius: '8px', 
              fontWeight: 'bold', fontSize: '18px', marginRight: '15px', cursor: 'pointer'
            }}
          >
            💾 Descarcă fișierul
          </button>
          <button 
            onClick={clear}
            style={{ 
              padding: '15px 25px', background: '#6c757d', 
              color: 'white', border: 'none', borderRadius: '8px', 
              fontWeight: 'bold', fontSize: '16px', cursor: 'pointer'
            }}
          >
            🔄 Nouă conversie
          </button>
        </div>
      )}

      <style>{`
        pre { margin: 0; }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};
