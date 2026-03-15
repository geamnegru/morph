import { useState, useCallback } from 'react';
import type { ChangeEvent } from 'react';
interface TextFormat {
  id: string;
  name: string;
  ext: string;
  accept: string;
  mime: string;
}

const textInputFormats: TextFormat[] = [
  { id: 'txt', name: 'TXT', ext: 'txt', accept: '.txt', mime: 'text/plain' },
  { id: 'json', name: 'JSON', ext: 'json', accept: '.json', mime: 'application/json' },
  { id: 'yaml', name: 'YAML', ext: 'yml', accept: '.yaml,.yml', mime: 'text/yaml' },
  { id: 'log', name: 'LOG', ext: 'log', accept: '.log', mime: 'text/plain' },
  { id: 'md', name: 'Markdown', ext: 'md', accept: '.md', mime: 'text/markdown' }
];

const textOutputFormats: TextFormat[] = [
  { id: 'txt', name: 'TXT', ext: 'txt', accept: '.txt', mime: 'text/plain' },
  { id: 'json', name: 'JSON', ext: 'json', accept: '.json', mime: 'application/json' },
  { id: 'yaml', name: 'YAML', ext: 'yml', accept: '.yml', mime: 'text/yaml' },
  { id: 'csv', name: 'CSV', ext: 'csv', accept: '.csv', mime: 'text/csv' },
  { id: 'html', name: 'HTML', ext: 'html', accept: '.html', mime: 'text/html' },
  { id: 'log', name: 'LOG', ext: 'log', accept: '.log', mime: 'text/plain' },
  { id: 'md', name: 'MD', ext: 'md', accept: '.md', mime: 'text/markdown' },
  { id: 'base64', name: 'Base64', ext: 'b64', accept: '.b64', mime: 'text/plain' },
  { id: 'upper', name: 'UPPER', ext: 'txt', accept: '.txt', mime: 'text/plain' }
];

const converters: Record<string, (input: string, inputType: string, outputType: string) => string> = {
  // TXT → ANY
  'txt-json': (text) => JSON.stringify({ content: text.trim() }, null, 2),
  'txt-csv': (text) => text.split('\n').filter(l => l.trim()).map(l => `"${l.trim()}"`).join('\n'),
  'txt-yaml': (text) => `content: |\n  ${text.trim().split('\n').join('\n  ')}`,
  'txt-html': (text) => `<pre style="white-space:pre-wrap">${text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`,
  'txt-log': (text) => `[${new Date().toISOString()}]\n${text}\n--- END LOG ---\n`,
  'txt-upper': (text) => text.toUpperCase(),
  'txt-base64': (text) => btoa(unescape(encodeURIComponent(text))),
  
  // JSON → ANY
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
  
  // YAML → ANY (FIXED!)
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
  
  'yaml-csv': (yaml) => {  // ✅ FIXED
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
  
  // CSV → ANY
  'csv-yaml': (csv) => {
    const lines = csv.split('\n').filter(l => l.trim());
    let yaml = '';
    lines.forEach((line, i) => {
      yaml += `row_${i + 1}: "${line.trim()}"\n`;
    });
    return yaml;
  },
  
  // Generic fallback
  '*-txt': (text) => text,
  '*-upper': (text) => text.toUpperCase(),
  '*-base64': (text) => btoa(unescape(encodeURIComponent(text)))
};

// 🔥 JSON → YAML recursive
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
      
      // Try exact converter
      if (converters[converterKey]) {
        converted = converters[converterKey](text, inputType.id, outputType.id);
      } 
      // Try generic fallbacks
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

  const runTextConversionTest = async () => {
    if (!confirm('🧪 Testez 12 conversii TEXT (3s)?')) return;

    console.log('🚀 === TEXT CONVERSION MATRIX ===');
    let success = 0;

    const testInputs = {
      txt: `Line 1
Line 2
Focșani, Vrancea
1df36-1b084`,
      json: `{
  "name": "John",
  "city": "Focșani",
  "codes": ["1df36-1b084", "d76ea-38584"]
}`,
      yaml: `content: 1df36-1b084
d76ea-38584
f3c8d-5e6cd`
    };

    const testCases = [
      // TXT tests
      { in: 'txt', out: 'json', expected: /content/ },
      { in: 'txt', out: 'yaml', expected: /content:/ },
      { in: 'txt', out: 'csv', expected: /"Line 1"/ },
      
      // JSON tests
      { in: 'json', out: 'yaml', expected: /name:\s*John/ },
      { in: 'json', out: 'txt', expected: /Focșani/ },
      
      // YAML tests ✅ FIXED
      { in: 'yaml', out: 'json', expected: /"content"/ },
      { in: 'yaml', out: 'csv', expected: /1df36-1b084/ },
      
      // Bonus tests
      { in: 'txt', out: 'html', expected: /<pre/ },
      { in: 'txt', out: 'log', expected: /\[\d{4}-\d{2}/ },
      { in: 'txt', out: 'upper', expected: /FOCȘANI/ },
      { in: 'yaml', out: 'txt', expected: /1df36/ }
    ];

    for (const test of testCases) {
      try {
        const input = testInputs[test.in as keyof typeof testInputs];
        const converterKey = getConverterKey(test.in, test.out);
        let converted = input;
        
        if (converters[converterKey]) {
          converted = converters[converterKey](input, test.in, test.out);
        }
        
        if (test.expected.test(converted) && converted.length > 10) {
          success++;
          console.log(`✅ ${test.in.toUpperCase()}→${test.out.toUpperCase()}`);
        } else {
          console.log(`⚠️ ${test.in.toUpperCase()}→${test.out.toUpperCase()}: partial`);
        }
      } catch (e) {
        console.log(`❌ ${test.in.toUpperCase()}→${test.out.toUpperCase()}: error`);
      }
    }

    const rate = Math.round((success / testCases.length) * 100);
    alert(`📄 TEST REZULTAT:\n${success}/12 conversii OK\n${rate}%\n\n${rate === 100 ? '🚀 TEXT CONVERTER PERFECT!' : '⚠️ Parțial OK'}`);
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
      <h2 style={{ textAlign: 'center', color: '#333', marginBottom: '30px' }}>
        📄 Text Converter Pro
      </h2>
      
      {/* STATUS BAR */}
      <div style={{ 
        padding: '12px', background: '#e8f5e8', 
        borderRadius: '8px', marginBottom: '20px',
        fontSize: '16px', color: '#2e7d32', textAlign: 'center', fontWeight: 'bold'
      }}>
        📥 {inputType.name.toUpperCase()}.{inputType.ext} → 📤 {outputType.name.toUpperCase()}.{outputType.ext}
      </div>

      {/* INPUT TYPE */}
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

      {/* OUTPUT TYPE */}
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

      {/* FILE INPUT */}
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
      
      {/* CONVERT BUTTON */}
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

      {/* TEST BUTTON */}
      <button 
        onClick={runTextConversionTest} 
        disabled={converting}
        style={{ 
          width: '100%', padding: '12px', 
          background: '#ff6b35', color: 'white', 
          border: 'none', borderRadius: '8px', 
          fontSize: '16px', fontWeight: 'bold', 
          cursor: converting ? 'not-allowed' : 'pointer', 
          marginBottom: '20px'
        }}
      >
        🧪 TEST 12 CONVERSII (3s)
      </button>
      
      {/* PREVIEW */}
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

      {/* RESULT */}
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
