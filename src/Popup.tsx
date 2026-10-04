import { useEffect, useState } from 'react';
import { Send, Download, Copy, Power, PowerOff, ShieldCheck, Video, FileVideo } from 'lucide-react';

interface VideoItem {
  url: string;
  referer: string;
  fileName: string;
  suggested_filename?: string;
  size: number;
  type: string;
}

export default function Popup() {
  const [isOnline, setIsOnline] = useState<boolean>(false);
  const [interceptDownloads, setInterceptDownloads] = useState<boolean>(true);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);

  const WARPER_API = "http://127.0.0.1:45678/api";

  const checkConnection = async () => {
    try {
      const res = await fetch(`${WARPER_API}/ping`);
      setIsOnline(res.ok);
    } catch {
      setIsOnline(false);
    }
  };

  const loadData = async () => {
    setLoading(true);
    await checkConnection();
    
    // Load intercept state
    const { interceptDownloads: storedIntercept } = await chrome.storage.local.get("interceptDownloads");
    if (storedIntercept !== undefined) {
      setInterceptDownloads(storedIntercept as boolean);
    } else {
      chrome.storage.local.set({ interceptDownloads: true });
    }

    // Load videos for current tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0 && tabs[0].id) {
      const tabId = tabs[0].id;
      const data = await chrome.storage.session.get('videos');
      const vids = data.videos || {};
      setVideos(vids[tabId] || []);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(checkConnection, 3000);
    return () => clearInterval(interval);
  }, []);

  const toggleIntercept = async () => {
    const newVal = !interceptDownloads;
    setInterceptDownloads(newVal);
    await chrome.storage.local.set({ interceptDownloads: newVal });
  };

  const sendToWarper = async (video: VideoItem, startImmediately: boolean) => {
    try {
      const res = await fetch(`${WARPER_API}/add-download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: video.url,
          referer: video.referer,
          fileName: video.fileName,
          suggested_filename: video.suggested_filename || video.fileName,
          startImmediately
        })
      });
      if (!res.ok) alert("Failed to send to Warper. App might be offline.");
    } catch (e) {
      alert("Warper App is not running!");
    }
  };

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url);
  };

  const formatSize = (bytes: number) => {
    if (!bytes) return 'Unknown Size';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(2)} MB`;
  };

  return (
    <div className="flex flex-col h-full bg-warm-alabaster dark:bg-warm-obsidian text-text-light dark:text-text-dark p-4 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-gray-200 dark:border-border-dark">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center shadow-lg shadow-primary/20">
            <Video className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="font-bold text-lg leading-tight tracking-tight">Warper</h1>
            <p className="text-xs text-warm-taupe font-medium">Download Manager</p>
          </div>
        </div>
        <div className="flex flex-col items-end">
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${isOnline ? 'bg-emerald-500/10 text-emerald-600 border-emerald-200 dark:border-emerald-900/50 dark:text-emerald-400' : 'bg-orange-500/10 text-orange-600 border-orange-200 dark:border-orange-900/50 dark:text-orange-400'}`}>
            {isOnline ? <Power className="w-3 h-3" /> : <PowerOff className="w-3 h-3" />}
            {isOnline ? 'Connected' : 'App Offline'}
          </div>
        </div>
      </div>

      {/* Settings */}
      <div className="bg-white dark:bg-card-dark rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-border-dark mb-6 flex items-center justify-between transition-colors">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gray-50 dark:bg-black/20 rounded-full">
            <ShieldCheck className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-sm">Intercept Downloads</h3>
            <p className="text-xs text-warm-taupe mt-0.5">Route native downloads to Warper</p>
          </div>
        </div>
        <button 
          onClick={toggleIntercept}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${interceptDownloads ? 'bg-primary' : 'bg-gray-200 dark:bg-gray-700'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${interceptDownloads ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      {/* Videos List */}
      <div className="flex-1 overflow-y-auto pr-1 -mr-1">
        <h3 className="text-xs font-bold text-warm-taupe uppercase tracking-wider mb-3">
          Media Found on Page ({videos.length})
        </h3>
        
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : videos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center opacity-60">
            <FileVideo className="w-12 h-12 mb-3 text-warm-taupe" />
            <p className="text-sm font-medium">No media detected</p>
            <p className="text-xs mt-1">Play a video to sniff its URL</p>
          </div>
        ) : (
          <div className="space-y-3">
            {videos.map((vid, idx) => (
              <div key={idx} className="bg-white dark:bg-card-dark rounded-xl p-3.5 shadow-sm border border-gray-100 dark:border-border-dark group transition-all hover:border-primary/30">
                <div className="flex items-start gap-3 mb-3">
                  <div className="p-2 bg-primary/10 rounded-lg text-primary mt-0.5">
                    <Video className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate" title={vid.fileName}>{vid.fileName}</p>
                    <div className="flex items-center gap-2 mt-1 text-xs text-warm-taupe">
                      <span className="bg-gray-100 dark:bg-black/30 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide">
                        {vid.type}
                      </span>
                      <span>•</span>
                      <span>{formatSize(vid.size)}</span>
                    </div>
                  </div>
                </div>
                
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-50 dark:border-border-dark/50">
                  {isOnline ? (
                    <>
                      <button 
                        onClick={() => sendToWarper(vid, false)}
                        className="flex-1 flex justify-center items-center gap-1.5 bg-gray-100 dark:bg-black/30 hover:bg-gray-200 dark:hover:bg-black/50 text-text-light dark:text-text-dark text-xs font-medium py-2 px-3 rounded-lg transition-colors"
                      >
                        <Send className="w-3.5 h-3.5" />
                        <span>Send</span>
                      </button>
                      <button 
                        onClick={() => sendToWarper(vid, true)}
                        className="flex-1 flex justify-center items-center gap-1.5 bg-primary hover:bg-primary-hover text-white text-xs font-medium py-2 px-3 rounded-lg transition-colors shadow-sm shadow-primary/20"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Download</span>
                      </button>
                    </>
                  ) : (
                    <button 
                      onClick={() => copyUrl(vid.url)}
                      className="flex-1 flex justify-center items-center gap-1.5 bg-gray-100 dark:bg-black/30 hover:bg-gray-200 dark:hover:bg-black/50 text-text-light dark:text-text-dark text-xs font-medium py-2 px-3 rounded-lg transition-colors"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy URL</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
