import { useState, useRef, useEffect } from 'react';
import type { ChangeEvent } from 'react';
import { encode } from '@jsquash/avif';

interface ImageFormat {
  id: string;
  name: string;
  ext: string;
  accept: string;
  mime: string;
}

const imageInputFormats: ImageFormat[] = [
  { id: 'png', name: 'PNG', ext: 'png', accept: '.png', mime: 'image/png' },
  { id: 'jpg', name: 'JPG', ext: 'jpg', accept: '.jpg,.jpeg', mime: 'image/jpeg' },
  { id: 'webp', name: 'WEBP', ext: 'webp', accept: '.webp', mime: 'image/webp' },
  { id: 'avif', name: 'AVIF', ext: 'avif', accept: '.avif', mime: 'image/avif' }
];

const imageOutputFormats: ImageFormat[] = [
  { id: 'png', name: 'PNG', ext: 'png', accept: '.png', mime: 'image/png' },
  { id: 'jpg', name: 'JPG', ext: 'jpg', accept: '.jpg', mime: 'image/jpeg' },
  { id: 'webp', name: 'WEBP', ext: 'webp', accept: '.webp', mime: 'image/webp' },
  { id: 'avif', name: 'AVIF', ext: 'avif', accept: '.avif', mime: 'image/avif' }
];

export const ImageConverter = () => {
  const [result, setResult] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [inputType, setInputType] = useState<ImageFormat>(imageInputFormats[0]);
  const [outputType, setOutputType] = useState<ImageFormat>(imageOutputFormats[2]);
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [, setFormatStatus] = useState('Loading...');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  
  const [avifReady, setAvifReady] = useState(false);

  const detectFormats = (): { webp: boolean; avif: boolean } => {
    const testCanvas = document.createElement('canvas');
    testCanvas.width = 1;
    testCanvas.height = 1;
    const ctx = testCanvas.getContext('2d');
    
    if (!ctx) {
      setFormatStatus('WEBP:❌ AVIF:❌');
      return { webp: false, avif: false };
    }

    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 1, 1);

    const supports = {
      webp: testCanvas.toDataURL('image/webp').startsWith('data:image/webp'),
      avif: avifReady
    };

    const status = `WEBP:${supports.webp ? '✅' : '❌'} AVIF:${supports.avif ? '✅' : '❌'}`;
    setFormatStatus(status);
    return supports;
  };

  const convertImage = async () => {
    const fileInput = document.getElementById('imageFile') as HTMLInputElement;
    const file = fileInput?.files?.[0];
    if (!file) return alert('❌ Selectează imagine!');

    setConverting(true);
    setProgress(0);
    setResult(null);
    setPreview(null);

    try {
      setProgress(10);
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      setProgress(30);
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Imagine invalidă'));
        image.src = dataUrl;
      });

      setProgress(50);
      if (previewCanvasRef.current) {
        const previewCtx = previewCanvasRef.current.getContext('2d');
        if (previewCtx) {
          const maxWidth = 300;
          const scale = Math.min(maxWidth / img.width, 1);
          previewCanvasRef.current.width = img.width * scale;
          previewCanvasRef.current.height = img.height * scale;
          previewCtx.drawImage(img, 0, 0, previewCanvasRef.current.width, previewCanvasRef.current.height);
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
          
          let convertedDataUrl: string;
          let finalExt = outputType.ext;

          switch (outputType.id) {
            case 'png':
              convertedDataUrl = canvasRef.current.toDataURL('image/png', 0.95);
              break;
              
            case 'jpg':
              convertedDataUrl = canvasRef.current.toDataURL('image/jpeg', 0.88);
              break;
              
            case 'webp':
              try {
                convertedDataUrl = canvasRef.current.toDataURL('image/webp', 0.90);
                if (!convertedDataUrl.startsWith('data:image/webp')) {
                  convertedDataUrl = canvasRef.current.toDataURL('image/jpeg', 0.85);
                  finalExt = 'jpg';
                }
              } catch {
                convertedDataUrl = canvasRef.current.toDataURL('image/jpeg', 0.85);
                finalExt = 'jpg';
              }
              break;
              
            case 'avif':
              if (avifReady) {
                setProgress(85);
                try {
                  const imageData = ctx.getImageData(0, 0, canvasRef.current.width, canvasRef.current.height);
                  const avifBuffer = await encode(imageData, {
                    quality: 85,
                    speed: 6
                  });
                  
                  // ArrayBuffer → base64
                  const uint8Array = new Uint8Array(avifBuffer as ArrayBuffer);
                  let binary = '';
                  for (let i = 0; i < uint8Array.byteLength; i++) {
                    binary += String.fromCharCode(uint8Array[i]);
                  }
                  convertedDataUrl = `data:image/avif;base64,${btoa(binary)}`;
                  finalExt = 'avif';
                } catch (wasmError) {
                  console.error('WASM AVIF failed:', wasmError);
                  convertedDataUrl = canvasRef.current.toDataURL('image/webp', 0.88);
                  finalExt = 'webp';
                }
              } else {
                try {
                  convertedDataUrl = canvasRef.current.toDataURL('image/avif', 0.85);
                  if (convertedDataUrl.startsWith('data:image/avif')) {
                    finalExt = 'avif';
                  } else {
                    convertedDataUrl = canvasRef.current.toDataURL('image/webp', 0.88);
                    finalExt = convertedDataUrl.includes('webp') ? 'webp' : 'jpg';
                  }
                } catch {
                  convertedDataUrl = canvasRef.current.toDataURL('image/webp', 0.88);
                  finalExt = 'jpg';
                }
              }
              break;
              
            default:
              convertedDataUrl = canvasRef.current.toDataURL('image/jpeg', 0.85);
          }
          
          setResult(convertedDataUrl);
          setProgress(100);
          
          const sizeKB = Math.round(convertedDataUrl.length / 1024);
          console.log(`✅ ${inputType.name}→${outputType.name}: ${sizeKB}KB (${finalExt})`);
        }
      }

    } catch (error) {
      console.error('❌ Eroare:', error);
      alert('❌ Eroare conversie!');
    } finally {
      setConverting(false);
      setProgress(0);
    }
  };

  const handleInputTypeChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const format = imageInputFormats.find(f => f.id === e.target.value)!;
    setInputType(format);
    setResult(null);
    setPreview(null);
  };

  const handleOutputTypeChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const format = imageOutputFormats.find(f => f.id === e.target.value)!;
    setOutputType(format);
    setResult(null);
  };

  const download = () => {
    if (result) {
      const a = document.createElement('a');
      a.href = result;
      let ext = outputType.ext;
      if (outputType.id === 'webp' && !result.includes('webp')) ext = 'jpg';
      if (outputType.id === 'avif' && !result.includes('avif')) ext = 'webp';
      a.download = `image-${inputType.ext}-to-${outputType.name.toLowerCase()}-${Date.now()}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  const clear = () => {
    setResult(null);
    setPreview(null);
    const fileInput = document.getElementById('imageFile') as HTMLInputElement;
    if (fileInput) fileInput.value = '';
  };

  useEffect(() => {
    (async () => {
      try {
        const testCanvas = document.createElement('canvas');
        testCanvas.width = 1;
        testCanvas.height = 1;
        const ctx = testCanvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = 'red';
          ctx.fillRect(0, 0, 1, 1);
          const imageData = ctx.getImageData(0, 0, 1, 1);
          await encode(imageData, { quality: 50, speed: 10 });
          setAvifReady(true);
        }
      } catch {
        setAvifReady(false);
      } finally {
        detectFormats();
      }
    })();
  }, []);
  return (
    <div style={{ maxWidth: '700px', margin: '0 auto', padding: '20px' }}>
      <div style={{ marginBottom: '15px' }}>
        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Input:</label>
        <select value={inputType.id} onChange={handleInputTypeChange} disabled={converting}
          style={{ width: '100%', padding: '12px', borderRadius: '8px', border: '2px solid #ddd', fontSize: '16px' }}>
          {imageInputFormats.map(format => (
            <option key={format.id} value={format.id}>{format.name.toUpperCase()}</option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: '15px' }}>
        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Output:</label>
        <select value={outputType.id} onChange={handleOutputTypeChange} disabled={converting}
          style={{ width: '100%', padding: '12px', borderRadius: '8px', border: '2px solid #ddd', fontSize: '16px' }}>
          {imageOutputFormats.map(format => (
            <option key={format.id} value={format.id}>{format.name.toUpperCase()}</option>
          ))}
        </select>
      </div>

      <input 
        id="imageFile"
        type="file" 
        accept={inputType.accept} 
        disabled={converting}
        style={{ 
          width: '100%', padding: '12px', 
          border: `2px dashed ${converting ? '#ccc' : '#1976d2'}`,
          borderRadius: '8px', marginBottom: '15px', fontSize: '16px',
          background: converting ? '#f8f9fa' : 'white'
        }} 
      />

      <button 
        onClick={convertImage} 
        disabled={converting}
        style={{ 
          width: '100%', padding: '15px', 
          background: converting ? '#ccc' : '#1976d2', 
          color: 'white', border: 'none', borderRadius: '8px', 
          fontSize: '18px', fontWeight: 'bold', marginBottom: '10px',
          cursor: converting ? 'not-allowed' : 'pointer'
        }}
      >
        {converting ? `🔄 Convertesc... ${progress}%` : `🚀 CONVERT ${outputType.name.toUpperCase()}`}
      </button>
      {converting && (
        <div style={{ padding: '20px', background: '#e3f2fd', borderRadius: '12px', marginBottom: '20px', textAlign: 'center' }}>
          <div style={{ width: '100%', height: '25px', background: '#e0e0e0', borderRadius: '12px', overflow: 'hidden', marginBottom: '10px' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: `linear-gradient(90deg, #1976d2, #42a5f5)`, transition: 'width 0.3s ease' }} />
          </div>
          <strong style={{ fontSize: '18px', color: '#1976d2' }}>{progress}%</strong>
        </div>
      )}

      {preview && (
        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
          <strong style={{ fontSize: '16px', marginBottom: '10px', display: 'block' }}>👀 Preview:</strong>
          <canvas ref={previewCanvasRef} style={{ maxWidth: '100%', maxHeight: '200px', borderRadius: '8px', border: '2px solid #ddd', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }} />
        </div>
      )}

      {result && (
        <div style={{ padding: '25px', background: '#e8f5e8', borderRadius: '12px', borderLeft: '5px solid #2e7d32', textAlign: 'center' }}>
          <h3 style={{ marginTop: 0, color: '#2e7d32', fontSize: '24px' }}>✅ Conversie gata!</h3>
          <img src={result} alt="Rezultat" style={{ maxWidth: '100%', maxHeight: '400px', borderRadius: '8px', border: '2px solid #28a745', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }} />
          <div style={{ marginTop: '20px' }}>
            <button onClick={download} style={{ padding: '15px 30px', background: '#2e7d32', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', fontSize: '18px', marginRight: '15px', cursor: 'pointer' }}>
              💾 Descarcă
            </button>
            <button onClick={clear} style={{ padding: '15px 25px', background: '#6c757d', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>
              🔄 Nouă conversie
            </button>
          </div>
        </div>
      )}

      <canvas ref={canvasRef} style={{ display: 'none' }} width={1024} height={768} />
    </div>
  );
};
