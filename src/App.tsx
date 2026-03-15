import { useState } from 'react';
import { VideoConverter } from './components/VideoConverter';
import { TextConverter } from './components/TextConverter';

type ConverterTab = 'video' | 'audio' | 'text' | 'image';

const App = () => {
  const [activeTab, setActiveTab] = useState<ConverterTab>('video');

  const tabs = [
    { id: 'video' as const, title: '🎬 VIDEO', component: <VideoConverter /> },
    { id: 'text' as const, title: '📄 TEXT', component: <TextConverter /> },
    // audio/image viitoare
  ] as const;

  return (
    <div style={{ maxWidth: '700px', margin: '0 auto', padding: '20px' }}>
      {/* TABS */}
      <div style={{ 
        display: 'flex', gap: '5px', marginBottom: '25px', 
        background: '#f8f9fa', padding: '10px', 
        borderRadius: '12px', border: '2px solid #e9ecef'
      }}>
        {tabs.map(tab => (
          <button 
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1, padding: '12px', 
              background: activeTab === tab.id ? '#9c27b0' : '#e9ecef',
              color: activeTab === tab.id ? 'white' : '#495057',
              border: 'none', borderRadius: '8px', 
              fontWeight: 'bold', cursor: 'pointer'
            }}
          >
            {tab.title}
          </button>
        ))}
      </div>

      {/* CONTENT */}
      <div>
        {activeTab === 'video' && tabs.find(t => t.id === 'video')?.component}
        {activeTab === 'text' && tabs.find(t => t.id === 'text')?.component}
      </div>
    </div>
  );
};

export default App;
