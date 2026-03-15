import { useState, useRef, useEffect } from 'react';
import type { ChangeEvent } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';

interface FormatConfig {
  accept: string;
  mimeType: string;
  category: 'video';
}

export const VideoConverter = () => {
  const [loading, setLoading] = useState<boolean>(true);
  const [converting, setConverting] = useState<boolean>(false);
  const [result, setResult] = useState<string | null>(null);
  const [inputType, setInputType] = useState<string>('mp4');
  const [outputType, setOutputType] = useState<string>('webm');
  const [ffmpegReady, setFfmpegReady] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  
  const ffmpegRef = useRef<FFmpeg | null>(null);

  const formats: Record<string, FormatConfig> = {
    mp4: { accept: '.mp4', mimeType: 'video/mp4', category: 'video' },
    webm: { accept: '.webm', mimeType: 'video/webm', category: 'video' },
    avi: { accept: '.avi', mimeType: 'video/x-msvideo', category: 'video' },
    mov: { accept: '.mov', mimeType: 'video/quicktime', category: 'video' },
    mkv: { accept: '.mkv', mimeType: 'video/x-matroska', category: 'video' },
  };

  const ffmpegDataToBlob = (data: string | Uint8Array, mimeType: string): Blob => {
    if (typeof data === 'string') {
      return new Blob([data], { type: mimeType });
    }
    return new Blob([data as unknown as BlobPart], { type: mimeType });
  };

  const getFileDataSize = (data: string | Uint8Array): number => {
    return typeof data === 'string' ? data.length : data.byteLength;
  };

  useEffect(() => {
    const initFFmpeg = async () => {
      try {
        const ffmpeg = new FFmpeg();
        ffmpeg.on('log', ({ message }) => {
          console.log(`📝 FFmpeg: ${message}`);
        });
        await ffmpeg.load();
        ffmpegRef.current = ffmpeg;
        setFfmpegReady(true);
        setLoading(false);
        console.log('✅ FFmpeg gata!');
      } catch (error) {
        console.error('❌ FFmpeg eroare:', error);
        setLoading(false);
      }
    };
    initFFmpeg();
  }, []);

  const convertFile = async (): Promise<void> => {
    const fileInput = document.getElementById('fileInput') as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file || !ffmpegRef.current || loading) return;

    setConverting(true);
    setProgress(0);
    setResult(null);
    
    try {
      const inputExt = file.name.split('.').pop()?.toLowerCase() || 'mp4';
      const inputName = `input.${inputExt}`;
      const outputName = `output.${outputType}`;
      
      console.log(`📥 Încărc: ${file.name} (${(file.size/1024/1024).toFixed(1)}MB)`);
      
      const arrayBuffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      await ffmpegRef.current!.writeFile(inputName, uint8Array);
      setProgress(10);
      
      console.log(`🎬 ${inputExt} → ${outputType}`);

      if (['mkv', 'mp4', 'mov', 'avi'].includes(outputType)) {
        console.log('⚡ LOSSLESS copy');
        setProgress(20);
        await ffmpegRef.current!.exec(['-i', inputName, '-c', 'copy', outputName]);
        setProgress(90);
      } 
      else if (outputType === 'webm') {
        console.log('🎥 WebM VP8');
        setProgress(20);
        await ffmpegRef.current!.exec([
          '-i', inputName, 
          '-c:v', 'libvpx', 
          '-c:a', 'libvorbis',
          '-crf', '10', 
          '-cpu-used', '5', 
          '-threads', '0',
          outputName
        ]);
        setProgress(90);
      }
      else {
        setProgress(20);
        await ffmpegRef.current!.exec(['-i', inputName, outputName]);
        setProgress(90);
      }
      const data = await ffmpegRef.current!.readFile(outputName);
      const mime = formats[outputType]?.mimeType || 'video/mp4';
      const blob = ffmpegDataToBlob(data, mime);
      setResult(URL.createObjectURL(blob));
      
      setProgress(100);
      const sizeKB = getFileDataSize(data);
      console.log(`✅ GATA! ${outputType.toUpperCase()} (${Math.round(sizeKB/1024)}KB)`);
      
      alert(`✅ Conversie gata! ${Math.round(sizeKB/1024)}KB`);
    } catch (error) {
      console.error('❌ Eroare:', error);
      alert('❌ Eroare conversie! Verifică F12.');
    } finally {
      setConverting(false);
      setProgress(0);
    }
  };

  const handleInputTypeChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    setInputType(e.target.value);
    setOutputType(e.target.value);
    setResult(null);
  };

  const handleOutputTypeChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    setOutputType(e.target.value);
    setResult(null);
  };

  const videoInputs = Object.keys(formats);

  return (
    <div style={{ maxWidth: '600px', margin: '0 auto', padding: '20px' }}>
      <h2 style={{ textAlign: 'center', color: '#333', marginBottom: '30px' }}>🎬 Video Converter Pro</h2>
      <div style={{ marginBottom: '15px' }}>
        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Input:</label>
        <select onChange={handleInputTypeChange} value={inputType} disabled={loading || converting}
          style={{ width: '100%', padding: '12px', borderRadius: '8px', border: '2px solid #ddd', fontSize: '16px' }}>
          {videoInputs.map(key => (
            <option key={key} value={key}>{key.toUpperCase()}</option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: '15px' }}>
        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Output:</label>
        <select value={outputType} onChange={handleOutputTypeChange} disabled={loading || converting}
          style={{ width: '100%', padding: '12px', borderRadius: '8px', border: '2px solid #ddd', fontSize: '16px' }}>
          {videoInputs.map(fmt => (
            <option key={fmt} value={fmt}>{fmt.toUpperCase()}</option>
          ))}
        </select>
      </div>

      <input 
        id="fileInput" 
        type="file" 
        accept={formats[inputType]?.accept} 
        disabled={converting || loading}
        style={{ 
          width: '100%', 
          padding: '12px', 
          border: '2px dashed #007bff', 
          borderRadius: '8px', 
          marginBottom: '15px', 
          fontSize: '16px' 
        }} 
      />
      
      <button 
        onClick={convertFile} 
        disabled={converting || loading || !ffmpegReady}
        style={{ 
          width: '100%', 
          padding: '15px', 
          background: converting || loading || !ffmpegReady ? '#ccc' : '#007bff', 
          color: 'white', 
          border: 'none', 
          borderRadius: '8px', 
          fontSize: '18px', 
          fontWeight: 'bold', 
          cursor: converting || loading || !ffmpegReady ? 'not-allowed' : 'pointer', 
          marginBottom: '10px' 
        }}
      >
        {converting ? `🔄 Convertesc... ${progress}%` : '🚀 CONVERT VIDEO'}
      </button>
      {converting && (
        <div style={{ marginBottom: '20px', padding: '20px', background: '#f8f9fa', borderRadius: '12px', borderLeft: '5px solid #28a745' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '15px', fontSize: '18px', fontWeight: 'bold' }}>
            <div style={{ width: '24px', height: '24px', border: '3px solid #28a745', borderTop: '3px solid transparent', borderRadius: '50%', animation: 'spin 1s linear infinite', marginRight: '12px' }} />
            {inputType.toUpperCase()} → {outputType.toUpperCase()}
            <span style={{ marginLeft: '15px', color: '#666', fontSize: '16px' }}>{progress}%</span>
          </div>
          <div style={{ width: '100%', height: '25px', background: '#e9ecef', borderRadius: '12px', overflow: 'hidden' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: `linear-gradient(90deg, #28a745, #20c997)`, transition: 'width 0.4s ease' }} />
          </div>
        </div>
      )}

      {result && (
        <div style={{ padding: '20px', background: '#d4edda', borderRadius: '12px', borderLeft: '5px solid #28a745', marginTop: '20px' }}>
          <h3 style={{ marginTop: 0, color: '#155724' }}>✅ Conversie gata!</h3>
          <video controls style={{ width: '100%', maxHeight: '400px', borderRadius: '8px' }}>
            <source src={result} type={formats[outputType]?.mimeType || 'video/mp4'} />
          </video>
          <div style={{ marginTop: '15px' }}>
            <a href={result} download={`video-${Date.now()}.${outputType}`} 
              style={{ display: 'inline-block', padding: '12px 24px', background: '#28a745', color: 'white', textDecoration: 'none', borderRadius: '8px', fontWeight: 'bold' }}>
              💾 Descarcă
            </a>
            <button onClick={() => { 
              setResult(null); 
              const fileInput = document.getElementById('fileInput') as HTMLInputElement;
              if (fileInput) fileInput.value = '';
            }}
            style={{ marginLeft: '10px', padding: '12px 20px', background: '#6c757d', color: 'white', border: 'none', borderRadius: '8px' }}>
              🔄 Nouă conversie
            </button>  
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};