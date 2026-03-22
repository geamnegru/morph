import { useState, useRef, useEffect } from 'react';
import type { ChangeEvent } from 'react';
import { encode } from '@jsquash/avif';
import type { ImageFormat } from '../types';
import { imageInputFormats, imageOutputFormats } from '../constants';

export const ImageConverter = () => {
  const [result, setResult] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [inputType, setInputType] = useState<ImageFormat>(imageInputFormats[0]);
  const [outputType, setOutputType] = useState<ImageFormat>(imageOutputFormats[2]);
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [avifReady, setAvifReady] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  const convertImage = async () => {
    const fileInput = document.getElementById('imageFile') as HTMLInputElement;
    const file = fileInput?.files?.[0];
    if (!file) return;
    setConverting(true); setProgress(0); setResult(null); setPreview(null);
    try {
      setProgress(10);
      const dataUrl = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      setProgress(30);
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('Invalid image'));
        i.src = dataUrl;
      });
      setProgress(50);
      if (previewCanvasRef.current) {
        const pCtx = previewCanvasRef.current.getContext('2d');
        if (pCtx) {
          const scale = Math.min(300 / img.width, 1);
          previewCanvasRef.current.width = img.width * scale;
          previewCanvasRef.current.height = img.height * scale;
          pCtx.drawImage(img, 0, 0, previewCanvasRef.current.width, previewCanvasRef.current.height);
          setPreview(previewCanvasRef.current.toDataURL());
        }
      }
      setProgress(70);
      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
          const scale = 0.85;
          canvasRef.current.width = img.width * scale;
          canvasRef.current.height = img.height * scale;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, canvasRef.current.width, canvasRef.current.height);
          let out: string;
          switch (outputType.id) {
            case 'png': out = canvasRef.current.toDataURL('image/png', 0.95); break;
            case 'jpg': out = canvasRef.current.toDataURL('image/jpeg', 0.88); break;
            case 'webp':
              out = canvasRef.current.toDataURL('image/webp', 0.90);
              if (!out.startsWith('data:image/webp')) out = canvasRef.current.toDataURL('image/jpeg', 0.85);
              break;
            case 'avif':
              if (avifReady) {
                setProgress(85);
                try {
                  const imgData = ctx.getImageData(0, 0, canvasRef.current.width, canvasRef.current.height);
                  const buf = await encode(imgData, { quality: 85, speed: 6 });
                  const u8 = new Uint8Array(buf as ArrayBuffer);
                  let bin = ''; for (let i = 0; i < u8.byteLength; i++) bin += String.fromCharCode(u8[i]);
                  out = `data:image/avif;base64,${btoa(bin)}`;
                } catch { out = canvasRef.current.toDataURL('image/webp', 0.88); }
              } else {
                out = canvasRef.current.toDataURL('image/avif', 0.85);
                if (!out.startsWith('data:image/avif')) out = canvasRef.current.toDataURL('image/webp', 0.88);
              }
              break;
            default: out = canvasRef.current.toDataURL('image/jpeg', 0.85);
          }
          setResult(out);
          setProgress(100);
        }
      }
    } catch (e) { console.error(e); }
    finally { setConverting(false); setProgress(0); }
  };

  const download = () => {
    if (!result) return;
    const a = document.createElement('a');
    a.href = result;
    let ext = outputType.ext;
    if (outputType.id === 'webp' && !result.includes('webp')) ext = 'jpg';
    if (outputType.id === 'avif' && !result.includes('avif')) ext = 'webp';
    a.download = `image-${Date.now()}.${ext}`;
    a.click();
  };

  const clear = () => {
    setResult(null); setPreview(null);
    const fi = document.getElementById('imageFile') as HTMLInputElement;
    if (fi) fi.value = '';
  };

  useEffect(() => {
    (async () => {
      try {
        const c = document.createElement('canvas'); c.width = 1; c.height = 1;
        const ctx = c.getContext('2d');
        if (ctx) {
          ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 1, 1);
          await encode(ctx.getImageData(0, 0, 1, 1), { quality: 50, speed: 10 });
          setAvifReady(true);
        }
      } catch { setAvifReady(false); }
    })();
  }, []);

  return (
    <div className="card">
      <div className="format-row">
        <div>
          <label className="label">From</label>
          <select className="select" value={inputType.id}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              setInputType(imageInputFormats.find(f => f.id === e.target.value)!);
              setResult(null); setPreview(null);
            }} disabled={converting}>
            {imageInputFormats.map(f => <option key={f.id} value={f.id}>{f.name.toUpperCase()}</option>)}
          </select>
        </div>
        <div className="format-arrow">→</div>
        <div>
          <label className="label">To</label>
          <select className="select" value={outputType.id}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              setOutputType(imageOutputFormats.find(f => f.id === e.target.value)!);
              setResult(null);
            }} disabled={converting}>
            {imageOutputFormats.map(f => <option key={f.id} value={f.id}>{f.name.toUpperCase()}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="label">File</label>
        <input id="imageFile" type="file" className="file-input"
          accept={inputType.accept} disabled={converting} />
      </div>

      <button className="btn-primary" onClick={convertImage} disabled={converting}>
        {converting ? `Converting… ${progress}%` : 'Convert'}
      </button>

      {converting && (
        <div className="progress-wrap">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
      )}

      {preview && (
        <div>
          <span className="preview-label">Preview</span>
          <canvas ref={previewCanvasRef} className="preview-canvas" />
        </div>
      )}

      {result && (
        <div className="result-section">
          <div className="badge badge--success">Conversion complete</div>
          <img src={result} alt="Result" className="result-image" />
          <div className="btn-row">
            <button onClick={download} className="btn-download">Download</button>
            <button onClick={clear} className="btn-ghost">Convert another</button>
          </div>
        </div>
      )}

      <canvas ref={canvasRef} style={{ display: 'none' }} width={1024} height={768} />
    </div>
  );
};
