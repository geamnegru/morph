/// <reference lib="webworker" />

declare const self: DedicatedWorkerGlobalScope;

type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

interface ConvertMsg {
  id: string;
  text: string;
  inFmt: string;
  outFmt: string;
  outMime: string;
}

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : 'Conversion failed';
};

const encodeBase64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const decodeBase64 = (value: string) => {
  const normalized = value.replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const escapeXml = (value: string) => {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

const unescapeXml = (value: string) => {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
};

const stripMarkup = (value: string) => {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

function jsonToYaml(obj: JsonLike, indent = 0): string {
  const sp = '  '.repeat(indent);
  let yaml = '';

  if (Array.isArray(obj)) {
    obj.forEach((item) => {
      yaml += typeof item === 'object'
        ? `${sp}- ${jsonToYaml(item, indent + 1)}\n`
        : `${sp}- ${item}\n`;
    });
  } else if (obj && typeof obj === 'object') {
    Object.entries(obj).forEach(([key, value]) => {
      yaml += `${sp}${key}: `;
      yaml += typeof value === 'object' && value !== null
        ? `\n${jsonToYaml(value, indent + 1)}`
        : `${value}\n`;
    });
  } else {
    yaml += `${obj}\n`;
  }

  return yaml.trim();
}

const parseSimpleYaml = (yaml: string): Record<string, string> => {
  const obj: Record<string, string> = {};

  yaml.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes(':')) {
      const [key, ...value] = trimmed.split(':');
      obj[key.trim()] = value.join(':').trim();
    }
  });

  return obj;
};

const parseSimpleToml = (toml: string): Record<string, string> => {
  const obj: Record<string, string> = {};

  toml.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[') || !trimmed.includes('=')) {
      return;
    }

    const [key, ...value] = trimmed.split('=');
    obj[key.trim()] = value.join('=').trim().replace(/^"|"$/g, '');
  });

  return obj;
};

const objectToToml = (value: Record<string, unknown>) => {
  return Object.entries(value)
    .map(([key, entry]) => `${key} = "${String(entry ?? '').replace(/"/g, '\\"')}"`)
    .join('\n');
};

const parseCsv = (csv: string): string[][] => {
  return csv
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '')));
};

const parseSimpleXml = (xml: string): Record<string, string> => {
  const entries: Record<string, string> = {};
  const matches = xml.matchAll(/<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g);

  for (const match of matches) {
    if (match[1] !== 'document') {
      entries[match[1]] = unescapeXml(match[2].trim());
    }
  }

  if (Object.keys(entries).length === 0) {
    return { content: stripMarkup(xml) };
  }

  return entries;
};

const objectToXml = (value: Record<string, unknown>, rootTag = 'document') => {
  const body = Object.entries(value)
    .map(([key, entry]) => `<${key}>${escapeXml(String(entry ?? ''))}</${key}>`)
    .join('');

  return `<${rootTag}>${body}</${rootTag}>`;
};

const textToHtml = (text: string) => {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Converted Document</title>
</head>
<body>
  <pre>${escapeXml(text)}</pre>
</body>
</html>`;
};

const htmlToText = (html: string) => stripMarkup(html);

const toRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return { content: value };
};

const parseJsonObject = (json: string) => toRecord(JSON.parse(json));

const converters: Record<string, (input: string) => string> = {
  'txt-json': (text) => JSON.stringify({ content: text.trim() }, null, 2),
  'txt-csv': (text) => text.split('\n').filter((line) => line.trim()).map((line) => `"${line.trim()}"`).join('\n'),
  'txt-yaml': (text) => `content: |\n  ${text.trim().split('\n').join('\n  ')}`,
  'txt-md': (text) => text.split('\n').map((line) => line.trim() ? line : '').join('\n'),
  'txt-xml': (text) => objectToXml({ content: text.trim() }),
  'txt-toml': (text) => `content = "${text.trim().replace(/"/g, '\\"')}"`,
  'txt-html': (text) => textToHtml(text.trim()),
  'txt-base64': (text) => encodeBase64(text),

  'json-txt': (json) => {
    try {
      const value = JSON.parse(json) as Record<string, unknown>;
      return typeof value.content === 'string' ? value.content : JSON.stringify(value, null, 2);
    } catch {
      return json;
    }
  },
  'json-yaml': (json) => {
    try {
      return jsonToYaml(JSON.parse(json) as JsonLike);
    } catch {
      return json;
    }
  },
  'json-csv': (json) => {
    try {
      const parsed = JSON.parse(json) as unknown;
      const rows = Array.isArray(parsed) ? parsed.map(toRecord) : [toRecord(parsed)];
      if (!rows.length) return '';
      const keys = Object.keys(rows[0]);
      return [
        keys.join(','),
        ...rows.map((row) => keys.map((key) => `"${String(row[key] ?? '').replace(/"/g, '""')}"`).join(',')),
      ].join('\n');
    } catch {
      return json;
    }
  },
  'json-md': (json) => {
    try {
      const parsed = JSON.parse(json) as unknown;
      const rows = Array.isArray(parsed) ? parsed.map(toRecord) : [toRecord(parsed)];
      if (!rows.length) return '';
      const keys = Object.keys(rows[0]);
      return [
        `| ${keys.join(' | ')} |`,
        `| ${keys.map(() => '---').join(' | ')} |`,
        ...rows.map((row) => `| ${keys.map((key) => String(row[key] ?? '')).join(' | ')} |`),
      ].join('\n');
    } catch {
      return json;
    }
  },
  'json-xml': (json) => {
    try {
      return objectToXml(parseJsonObject(json));
    } catch {
      return json;
    }
  },
  'json-toml': (json) => {
    try {
      return objectToToml(parseJsonObject(json));
    } catch {
      return json;
    }
  },
  'json-html': (json) => {
    try {
      return textToHtml(JSON.stringify(JSON.parse(json), null, 2));
    } catch {
      return textToHtml(json);
    }
  },
  'json-base64': (json) => encodeBase64(json),

  'yaml-txt': (yaml) => Object.values(parseSimpleYaml(yaml)).join('\n'),
  'yaml-json': (yaml) => JSON.stringify(parseSimpleYaml(yaml), null, 2),
  'yaml-csv': (yaml) => Object.entries(parseSimpleYaml(yaml)).map(([key, value]) => `"${key}","${value}"`).join('\n'),
  'yaml-md': (yaml) => {
    const obj = parseSimpleYaml(yaml);
    return [`| Key | Value |`, `| --- | --- |`, ...Object.entries(obj).map(([key, value]) => `| ${key} | ${value} |`)].join('\n');
  },
  'yaml-xml': (yaml) => objectToXml(parseSimpleYaml(yaml)),
  'yaml-toml': (yaml) => objectToToml(parseSimpleYaml(yaml)),
  'yaml-html': (yaml) => textToHtml(yaml),
  'yaml-base64': (yaml) => encodeBase64(yaml),

  'csv-txt': (csv) => parseCsv(csv).map((row) => row.join('\t')).join('\n'),
  'csv-json': (csv) => {
    const rows = parseCsv(csv);
    if (rows.length < 2) return JSON.stringify(rows);
    const [headers, ...data] = rows;
    return JSON.stringify(
      data.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']))),
      null,
      2
    );
  },
  'csv-yaml': (csv) => {
    const rows = parseCsv(csv);
    if (rows.length < 2) return csv;
    const [headers, ...data] = rows;
    return data
      .map((row, index) => `row_${index + 1}:\n${headers.map((header, cellIndex) => `  ${header}: "${row[cellIndex] ?? ''}"`).join('\n')}`)
      .join('\n');
  },
  'csv-md': (csv) => {
    const rows = parseCsv(csv);
    if (!rows.length) return '';
    const [header, ...data] = rows;
    return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...data.map((row) => `| ${row.join(' | ')} |`)].join('\n');
  },
  'csv-xml': (csv) => objectToXml({ content: csv }),
  'csv-toml': (csv) => `content = "${csv.replace(/"/g, '\\"')}"`,
  'csv-html': (csv) => textToHtml(csv),
  'csv-base64': (csv) => encodeBase64(csv),

  'md-txt': (markdown) => markdown.replace(/#{1,6}\s/g, '').replace(/\*\*|__|[*_`]/g, '').replace(/\[(.+?)\]\(.+?\)/g, '$1'),
  'md-json': (markdown) => JSON.stringify({ content: markdown.trim(), lines: markdown.split('\n').length }, null, 2),
  'md-yaml': (markdown) => `content: |\n  ${markdown.trim().split('\n').join('\n  ')}`,
  'md-csv': (markdown) => markdown.split('\n').filter((line) => line.trim()).map((line) => `"${line.replace(/^#{1,6}\s/, '').trim()}"`).join('\n'),
  'md-xml': (markdown) => objectToXml({ content: markdown.trim() }),
  'md-toml': (markdown) => `content = "${markdown.trim().replace(/"/g, '\\"')}"`,
  'md-html': (markdown) => textToHtml(markdown),
  'md-base64': (markdown) => encodeBase64(markdown),

  'xml-txt': (xml) => Object.values(parseSimpleXml(xml)).join('\n'),
  'xml-json': (xml) => JSON.stringify(parseSimpleXml(xml), null, 2),
  'xml-yaml': (xml) => jsonToYaml(parseSimpleXml(xml)),
  'xml-csv': (xml) => Object.entries(parseSimpleXml(xml)).map(([key, value]) => `"${key}","${value}"`).join('\n'),
  'xml-md': (xml) => {
    const obj = parseSimpleXml(xml);
    return [`| Key | Value |`, `| --- | --- |`, ...Object.entries(obj).map(([key, value]) => `| ${key} | ${value} |`)].join('\n');
  },
  'xml-toml': (xml) => objectToToml(parseSimpleXml(xml)),
  'xml-html': (xml) => textToHtml(stripMarkup(xml)),
  'xml-base64': (xml) => encodeBase64(xml),

  'toml-txt': (toml) => Object.values(parseSimpleToml(toml)).join('\n'),
  'toml-json': (toml) => JSON.stringify(parseSimpleToml(toml), null, 2),
  'toml-yaml': (toml) => jsonToYaml(parseSimpleToml(toml)),
  'toml-csv': (toml) => Object.entries(parseSimpleToml(toml)).map(([key, value]) => `"${key}","${value}"`).join('\n'),
  'toml-md': (toml) => {
    const obj = parseSimpleToml(toml);
    return [`| Key | Value |`, `| --- | --- |`, ...Object.entries(obj).map(([key, value]) => `| ${key} | ${value} |`)].join('\n');
  },
  'toml-xml': (toml) => objectToXml(parseSimpleToml(toml)),
  'toml-html': (toml) => textToHtml(toml),
  'toml-base64': (toml) => encodeBase64(toml),

  'html-txt': (html) => htmlToText(html),
  'html-json': (html) => JSON.stringify({ content: htmlToText(html) }, null, 2),
  'html-yaml': (html) => `content: |\n  ${htmlToText(html).split('\n').join('\n  ')}`,
  'html-csv': (html) => htmlToText(html).split('\n').filter((line) => line.trim()).map((line) => `"${line.trim()}"`).join('\n'),
  'html-md': (html) => htmlToText(html),
  'html-xml': (html) => objectToXml({ content: htmlToText(html) }),
  'html-toml': (html) => `content = "${htmlToText(html).replace(/"/g, '\\"')}"`,
  'html-base64': (html) => encodeBase64(html),

  'base64-txt': (base64) => decodeBase64(base64),
  'base64-json': (base64) => {
    const decoded = decodeBase64(base64);
    try {
      return JSON.stringify(JSON.parse(decoded), null, 2);
    } catch {
      return JSON.stringify({ content: decoded }, null, 2);
    }
  },
  'base64-yaml': (base64) => `content: |\n  ${decodeBase64(base64).split('\n').join('\n  ')}`,
  'base64-csv': (base64) => decodeBase64(base64).split('\n').filter((line) => line.trim()).map((line) => `"${line.trim()}"`).join('\n'),
  'base64-md': (base64) => decodeBase64(base64),
  'base64-xml': (base64) => objectToXml({ content: decodeBase64(base64) }),
  'base64-toml': (base64) => `content = "${decodeBase64(base64).replace(/"/g, '\\"')}"`,
  'base64-html': (base64) => textToHtml(decodeBase64(base64)),

  '*-txt': (text) => text,
  '*-json': (text) => JSON.stringify({ content: text.trim() }, null, 2),
  '*-yaml': (text) => `content: |\n  ${text.trim().split('\n').join('\n  ')}`,
  '*-csv': (text) => text.split('\n').filter((line) => line.trim()).map((line) => `"${line.trim()}"`).join('\n'),
  '*-md': (text) => text,
  '*-xml': (text) => objectToXml({ content: text.trim() }),
  '*-toml': (text) => `content = "${text.trim().replace(/"/g, '\\"')}"`,
  '*-html': (text) => textToHtml(text.trim()),
  '*-base64': (text) => encodeBase64(text),
};

self.onmessage = (event: MessageEvent<ConvertMsg>) => {
  const { id, text, inFmt, outFmt, outMime } = event.data;

  try {
    const key = `${inFmt}-${outFmt}`;
    const converted = converters[key]?.(text) ?? converters[`*-${outFmt}`]?.(text) ?? text;
    const buffer = new TextEncoder().encode(converted);
    self.postMessage({ id, buf: buffer, outMime }, [buffer.buffer]);
  } catch (error: unknown) {
    self.postMessage({ id, error: getErrorMessage(error) });
  }
};
