import { useState } from 'react';
import { AudioConverter } from './components/AudioConverter';
import { ImageConverter } from './components/ImageConverter';
import { TextConverter } from './components/TextConverter';
import { VideoConverter } from './components/VideoConverter';
import { APP_TABS } from './constants';
import type { ConverterTab } from './types';
import './styles.css';

const App = () => {
  const [active, setActive] = useState<ConverterTab>('video');

  const components: Record<ConverterTab, React.ReactNode> = {
    video: <VideoConverter />,
    audio: <AudioConverter />,
    image: <ImageConverter />,
    text: <TextConverter />,
  };

  return (
    <div className="app">
      <div className="app-header">
        <div className="app-logo">
          <div className="app-logo-icon">{'\u21C4'}</div>
          <span className="app-logo-name">morph</span>
        </div>
        <p className="app-tagline">Morph files locally - nothing leaves your browser</p>
      </div>

      <div className="tab-bar-wrap">
        <div className="tab-bar">
          {APP_TABS.map((tab) => (
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

      <div className="content-wrap">{components[active]}</div>
    </div>
  );
};

export default App;
