import React from 'react';
import { createRoot } from 'react-dom/client';

const BUTTON_STYLE = `
  .warper-btn-container {
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    pointer-events: auto;
    background: rgba(20, 18, 16, 0.85);
    color: #f5f0eb;
    border: 1px solid #2e2925;
    border-radius: 9999px;
    padding: 6px 12px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    font-weight: 500;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    backdrop-filter: blur(4px);
    gap: 8px;
    transition: all 0.2s ease;
  }
  .warper-btn-container:hover {
    background: rgba(20, 18, 16, 0.95);
  }
  .warper-download-btn {
    background: #f26b5b;
    color: white;
    border: none;
    border-radius: 9999px;
    padding: 4px 10px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s ease;
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
  }
  .warper-download-btn:hover {
    background: #e0533f;
  }
  .warper-close-btn {
    background: transparent;
    color: #7a7269;
    border: none;
    cursor: pointer;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    border-radius: 50%;
    width: 20px;
    height: 20px;
    transition: color 0.2s ease, background 0.2s ease;
  }
  .warper-close-btn:hover {
    color: #f5f0eb;
    background: rgba(255, 255, 255, 0.1);
  }
`;

function FloatingButton({ video, onClose }: { video: any, onClose: () => void }) {
  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const res = await fetch("http://127.0.0.1:45678/api/add-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: video.url,
          referer: video.referer,
          fileName: video.fileName,
          suggested_filename: video.suggested_filename || video.fileName,
          startImmediately: false
        })
      });
      if (!res.ok) alert("Warper App is not running or failed to connect!");
    } catch (e) {
      alert("Warper App is not running!");
    }
  };

  return (
    <div className="warper-btn-container" onMouseDown={e => e.stopPropagation()}>
      <span style={{ fontSize: '12px' }}>Warper</span>
      <button className="warper-download-btn" onClick={handleDownload}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        Download
      </button>
      <button className="warper-close-btn" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}>&times;</button>
    </div>
  );
}

class VideoObserver {
  private injectedVideos = new WeakSet<HTMLVideoElement>();
  private videosFound: any[] = [];
  
  constructor() {
    this.pollVideos();
    setInterval(() => this.pollVideos(), 2000);
  }

  async pollVideos() {
    // Ask background script if we have videos
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_VIDEOS" });
      if (response && response.videos && response.videos.length > 0) {
        this.videosFound = response.videos;
        this.injectButtons();
      }
    } catch (e) {
      // Ignore
    }
  }

  injectButtons() {
    if (this.videosFound.length === 0) return;
    
    const videoElements = document.querySelectorAll('video');
    videoElements.forEach(video => {
      if (this.injectedVideos.has(video)) return;
      
      const rect = video.getBoundingClientRect();
      if ((rect.width > 280 && rect.height > 160) || video.readyState > 0) {
        this.injectButtonToVideo(video);
      }
    });
  }

  injectButtonToVideo(video: HTMLVideoElement) {
    this.injectedVideos.add(video);

    // Create wrapper over video
    const wrapper = document.createElement('div');
    wrapper.style.position = 'absolute';
    wrapper.style.top = '0';
    wrapper.style.left = '0';
    wrapper.style.width = '100%';
    wrapper.style.height = '100%';
    wrapper.style.pointerEvents = 'none'; // let clicks pass through
    wrapper.style.zIndex = '2147483647';
    
    // We must find a way to place wrapper on top of video. 
    // Usually video is inside a container. We can insert adjacent.
    if (!video.parentElement) return;
    
    const container = document.createElement('div');
    container.style.position = 'relative';
    container.style.display = 'inline-block';
    
    // Some sites break if we wrap the video, so instead, let's put our div absolutely positioned inside the video's parent.
    // If video parent is position static, we might need to change it, but it's safer to just append to parent and sync position.
    
    const shadowHost = document.createElement('div');
    shadowHost.style.position = 'absolute';
    shadowHost.style.zIndex = '2147483647';
    shadowHost.style.pointerEvents = 'none'; // let clicks pass through to video
    
    // Try to append to parent
    const parent = video.parentElement;
    if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
    }
    parent.appendChild(shadowHost);
    
    const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = BUTTON_STYLE;
    shadowRoot.appendChild(style);
    
    const rootEl = document.createElement('div');
    shadowRoot.appendChild(rootEl);
    
    const root = createRoot(rootEl);
    
    const updatePosition = () => {
        const pRect = parent.getBoundingClientRect();
        const vRect = video.getBoundingClientRect();
        shadowHost.style.top = (vRect.top - pRect.top) + 'px';
        shadowHost.style.left = (vRect.left - pRect.left) + 'px';
        shadowHost.style.width = vRect.width + 'px';
        shadowHost.style.height = vRect.height + 'px';
    };
    
    updatePosition();
    window.addEventListener('resize', updatePosition);
    
    const handleClose = () => {
      root.unmount();
      shadowHost.remove();
      window.removeEventListener('resize', updatePosition);
    };

    // Give the best video link (first one usually is the m3u8 or main video)
    const bestVideo = this.videosFound[0];

    root.render(<FloatingButton video={bestVideo} onClose={handleClose} />);
  }
}

new VideoObserver();
