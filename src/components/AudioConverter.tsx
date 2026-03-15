import React, { useState, useRef } from 'react';
import type { ChangeEvent } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import type { AudioFormat } from '../types';
import { audioInputFormats, audioOutputFormats } from '../constants';

export const AudioConverter = () => {
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [inputType, setInputType] = useState<AudioFormat>(audioInputFormats[0]);
  const [outputType, setOutputType] = useState<AudioFormat>(audioOutputFormats[0]);
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [fileInfo, setFileInfo] = useState('');
  
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const inputFileRef = useRef<HTMLInputElement>(null);

  const loadFFmpeg = async () => {
  const { FFmpeg } = await import('@ffmpeg/ffmpeg');
  
  const ffmpeg = new FFmpeg();
  ffmpeg.on('progress', ({ progress }) => {
    setProgress(progress * 100);
  });
  
  // 🔥 AUTO-LOAD - FFmpeg găsește singur fișierele!
  await ffmpeg.load();
  
  ffmpegRef.current = ffmpeg;
  setReady(true);
  console.log('✅ FFmpeg AUTO-loaded!');
};



  const convertAudio = async () => {
  const file = inputFileRef.current?.files?.[0];
  if (!file || !ffmpegRef.current) {
    alert('❌ Selectează fișier!');
    return;
  }

  setConverting(true);
  setProgress(0);
  setResult(null);
  
  try {
    const inputName = `input.${inputType.ext}`;
    const outputName = `output.ogg`;  // 🔥 ÎNTotdeauna .ogg!
    
    await ffmpegRef.current!.writeFile(inputName, await fetchFile(file));
    
    // 🔥 MP3→OPUS PERFECT - flags stricte!
    const args = [
      '-i', inputName,
      '-vn',                    // 🔥 NO VIDEO!
      '-c:a', 'libopus',        // 🔥 libopus (nu opus!)
      '-ar', '24000',           // 🔥 24kHz SAFE!
      '-b:a', '128k',           // 🔥 128kbps safe
      '-ac', '2',
      '-f', 'ogg',              // 🔥 OGG container!
      '-y',
      outputName
    ];

    console.log('🎵 MP3→OPUS:', args.join(' '));
    await ffmpegRef.current!.exec(args);
    
    const data = await ffmpegRef.current!.readFile(outputName);
    const uint8Array = new Uint8Array((data as unknown) as ArrayBuffer);
    
    // 🔥 MIME 100% corect pentru browser
    const audioBlob = new Blob([uint8Array], { 
      type: 'audio/ogg; codecs=opus' 
    });
    
    const audioUrl = URL.createObjectURL(audioBlob);
    setResult(audioUrl);
    setFileInfo(`${Math.round(audioBlob.size/1024)}KB | Opus 128kbps`);
    
  } catch (error) {
    console.error('🎵 ERROR:', error);
    alert('❌ Eroare MP3→Opus!');
  } finally {
    setConverting(false);
    setProgress(0);
  }
};


  const download = () => {
    if (result) {
      const a = document.createElement('a');
      a.href = result;
      a.download = `audio-${inputType.ext}-to-${outputType.name.toLowerCase()}-${Date.now()}.${outputType.ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  const clear = () => {
    setResult(null);
    if (inputFileRef.current) inputFileRef.current.value = '';
    setFileInfo('');
  };

  React.useEffect(() => {
    loadFFmpeg();
  }, []);

  const handleInputTypeChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const format = audioInputFormats.find(f => f.id === e.target.value)!;
    setInputType(format);
    setResult(null);
  };

  const handleOutputTypeChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const format = audioOutputFormats.find(f => f.id === e.target.value)!;
    setOutputType(format);
    setResult(null);
  };

  return (
    <div style={{ maxWidth: '700px', margin: '0 auto', padding: '20px' }}>
      <h2 style={{ textAlign: 'center', color: '#333', marginBottom: '30px' }}>
        🎵 Universal Audio Converter
      </h2>
      
      <div style={{ 
        padding: '12px', 
        background: ready ? '#d4edda' : '#f8d7da', 
        borderRadius: '8px', 
        marginBottom: '20px', 
        textAlign: 'center',
        borderLeft: `4px solid ${ready ? '#28a745' : '#dc3545'}`
      }}>
        {ready ? '✅ FFmpeg gata!' : '🔄 Încărcare FFmpeg...'}
      </div>

      <div style={{ 
        padding: '12px', background: '#e3f2fd', 
        borderRadius: '8px', marginBottom: '20px',
        fontSize: '16px', color: '#1976d2', textAlign: 'center', fontWeight: 'bold'
      }}>
        📥 {inputType.name}.{inputType.ext} → 📤 {outputType.name}.{outputType.ext}
      </div>

      <div style={{ marginBottom: '15px' }}>
        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Input:</label>
        <select 
          value={inputType.id} 
          onChange={handleInputTypeChange} 
          disabled={converting}
          style={{ width: '100%', padding: '12px', borderRadius: '8px', border: '2px solid #ddd', fontSize: '16px' }}
        >
          {audioInputFormats.map(format => (
            <option key={format.id} value={format.id}>{format.name}</option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: '15px' }}>
        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Output:</label>
        <select 
          value={outputType.id} 
          onChange={handleOutputTypeChange} 
          disabled={converting}
          style={{ width: '100%', padding: '12px', borderRadius: '8px', border: '2px solid #ddd', fontSize: '16px' }}
        >
          {audioOutputFormats.map(format => (
            <option key={format.id} value={format.id}>{format.name}</option>
          ))}
        </select>
      </div>

      <input 
        ref={inputFileRef}
        type="file" 
        accept={audioInputFormats.map(f => `.${f.ext}`).join(',')}
        disabled={converting}
        style={{ 
          width: '100%', padding: '12px', 
          border: `2px dashed ${converting ? '#ccc' : '#1976d2'}`,
          borderRadius: '8px', marginBottom: '15px', fontSize: '16px',
          background: converting ? '#f8f9fa' : 'white'
        }} 
      />

      <button 
        onClick={convertAudio} 
        disabled={converting || !ready}
        style={{ 
          width: '100%', padding: '15px', 
          background: converting ? '#ccc' : '#1976d2', 
          color: 'white', border: 'none', borderRadius: '8px', 
          fontSize: '18px', fontWeight: 'bold', marginBottom: '10px',
          cursor: (converting || !ready) ? 'not-allowed' : 'pointer'
        }}
      >
        {converting ? `🔄 Convertesc... ${Math.round(progress)}%` : `🚀 CONVERT ${outputType.name.toUpperCase()}`}
      </button>

      {converting && (
        <div style={{ padding: '20px', background: '#e3f2fd', borderRadius: '12px', marginBottom: '20px', textAlign: 'center' }}>
          <div style={{ width: '100%', height: '25px', background: '#e0e0e0', borderRadius: '12px', overflow: 'hidden', marginBottom: '10px' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: `linear-gradient(90deg, #1976d2, #42a5f5)`, transition: 'width 0.3s ease' }} />
          </div>
          <strong style={{ fontSize: '18px', color: '#1976d2' }}>{Math.round(progress)}%</strong>
        </div>
      )}

      {fileInfo && (
        <div style={{ padding: '12px', background: '#d4edda', borderRadius: '8px', marginBottom: '20px', textAlign: 'center' }}>
          📊 {fileInfo}
        </div>
      )}

      {result && (
        <div style={{ padding: '25px', background: '#e8f5e8', borderRadius: '12px', borderLeft: '5px solid #2e7d32', textAlign: 'center' }}>
          <h3 style={{ marginTop: 0, color: '#2e7d32', fontSize: '24px' }}>✅ Conversie gata!</h3>
          <audio controls src={result} style={{ width: '100%', maxWidth: '500px', margin: '20px 0' }} />
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
    </div>
  );
};
