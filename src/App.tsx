import { useState } from 'react';
import { VideoConverter } from './components/VideoConverter';
import { TextConverter } from './components/TextConverter';
import { ImageConverter } from './components/ImageConverter';
import { AudioConverter } from './components/AudioConverter';  // 🔥 NOU!

type ConverterTab = 'video' | 'text' | 'image' | 'audio';  // 🔥 + audio

const App = () => {
  const [activeTab, setActiveTab] = useState<ConverterTab>('video');

  const tabs = [
    { id: 'video' as const, title: '🎬 VIDEO', component: <VideoConverter /> },
    { id: 'text' as const, title: '📄 TEXT', component: <TextConverter /> },
    { id: 'image' as const, title: '🖼️ IMAGE', component: <ImageConverter /> },
    { id: 'audio' as const, title: '🎵 AUDIO', component: <AudioConverter /> }  // 🔥 NOU!
  ] as const;

  return (
    <div style={{ 
      maxWidth: '900px',
      margin: '0 auto', 
      padding: '20px', 
      minHeight: '100vh',
      background: '#f5f5f5'
    }}>
      <div style={{ 
        display: 'flex', 
        gap: '4px',
        marginBottom: '30px', 
        background: 'white',
        padding: '12px', 
        borderRadius: '16px', 
        boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
        border: '2px solid #e9ecef',
        flexWrap: 'wrap'
      }}>
        {tabs.map(tab => (
          <button 
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1, 
              minWidth: '120px',
              padding: '16px 12px', 
              background: activeTab === tab.id ? '#667eea' : '#f8f9fa',
              color: activeTab === tab.id ? 'white' : '#495057',
              border: 'none', 
              borderRadius: '12px', 
              fontWeight: 'bold', 
              fontSize: '15px',
              cursor: 'pointer',
              transition: 'all 0.3s ease',
              boxShadow: activeTab === tab.id ? '0 4px 12px rgba(102,126,234,0.4)' : 'none'
            }}
            onMouseEnter={(e) => {
              if (activeTab !== tab.id) {
                e.currentTarget.style.background = '#e9ecef';
              }
            }}
            onMouseLeave={(e) => {
              if (activeTab !== tab.id) {
                e.currentTarget.style.background = '#f8f9fa';
              }
            }}
          >
            {tab.title}
          </button>
        ))}
      </div>
      <div style={{ 
        background: 'white', 
        borderRadius: '20px', 
        padding: '30px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.1)',
        minHeight: '600px'
      }}>
        {tabs.find(t => t.id === activeTab)?.component}
      </div>
      <div style={{ 
        textAlign: 'center', 
        marginTop: '30px', 
        padding: '20px',
        color: '#6c757d',
        fontSize: '14px'
      }}>
      </div>
    </div>
  );
};

export default App;
