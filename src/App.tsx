import { useState } from 'react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { VideoConverter } from './components/VideoConverter';
import { TextConverter } from './components/TextConverter';
import { ImageConverter } from './components/ImageConverter';
import { AudioConverter } from './components/AudioConverter';
import './styles.css';

type ConverterTab = 'video' | 'text' | 'image' | 'audio';

const tabs = [
  { id: 'video' as const, label: 'Video', icon: '▶' },
  { id: 'audio' as const, label: 'Audio', icon: '♪' },
  { id: 'image' as const, label: 'Image', icon: '◻' },
  { id: 'text'  as const, label: 'Text',  icon: '≡' },
];

const App = () => {
  const [active, setActive] = useState<ConverterTab>('video');

  const components: Record<ConverterTab, React.ReactNode> = {
    video: <VideoConverter />,
    audio: <AudioConverter />,
    image: <ImageConverter />,
    text:  <TextConverter />,
  };

  return (
    <div className="app">
      <div className="app-header">
        <div className="app-logo">
          <div className="app-logo-icon">⇄</div>
          <span className="app-logo-name">morph</span>
        </div>
        <p className="app-tagline">Morph files locally — nothing leaves your browser</p>
      </div>

      <div className="tab-bar-wrap">
        <div className="tab-bar">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={`tab-btn${active === tab.id ? ' tab-btn--active' : ''}`}
            >
              <span className="tab-icon">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="content-wrap">
        {components[active]}
      </div>
      <SpeedInsights />
    </div>
  );
};

export default App;