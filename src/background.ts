const WARPER_API = "http://127.0.0.1:45678/api";

export async function sendToWarper(payload: any) {
  try {
    const res = await fetch(`${WARPER_API}/add-download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

const bypassList = new Set<string>();
let interceptDownloadsCached = true;

// Keep settings updated
chrome.storage.local.get("interceptDownloads").then((res: any) => {
  if (res.interceptDownloads !== undefined) {
    interceptDownloadsCached = res.interceptDownloads;
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.interceptDownloads) {
    interceptDownloadsCached = changes.interceptDownloads.newValue as boolean;
  }
});

// 1. Download Interceptor
chrome.downloads.onCreated.addListener((item) => {
  if (!interceptDownloadsCached) return;

  // หากอยู่ในบัญชีดำ (Bypass) แปลว่าเราสั่งโหลดเองเพราะแอปปิดอยู่ ให้ปล่อยผ่านได้เลย
  if (bypassList.has(item.url)) {
    bypassList.delete(item.url); // ลบออกเพื่อให้ครั้งหน้าดักจับใหม่
    return;
  }

  const exts = ['.zip', '.rar', '.7z', '.iso', '.exe', '.msi', '.dmg', '.pkg', '.mp4', '.mkv', '.pdf'];
  const extMatch = exts.some(e => item.url.toLowerCase().includes(e) || item.filename.toLowerCase().endsWith(e));
  const isLarge = item.fileSize > 50 * 1024 * 1024; // > 50MB
  
  if (extMatch || isLarge) {
    // 1. ยกเลิกทันที (Cancel Synchronously) เพื่อบล็อกหน้าต่าง "Save As" ของเบราว์เซอร์
    chrome.downloads.cancel(item.id);
    chrome.downloads.erase({ id: item.id });
    
    // 2. ค่อยไปเช็คว่าแอป Warper เปิดอยู่ไหม แบบเบื้องหลัง
    (async () => {
      let isWarperOnline = false;
      try {
        const res = await fetch(`${WARPER_API}/ping`);
        isWarperOnline = res.ok;
      } catch (e) {
        isWarperOnline = false;
      }

      if (isWarperOnline) {
        // แอปเปิดอยู่ ส่งไปให้แอปจัดการ
        let referer = item.referrer || "";
        if (!referer) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs.length > 0 && tabs[0].url) {
              referer = tabs[0].url;
          }
        }

        await sendToWarper({
          url: item.url,
          referer,
          fileName: item.filename,
          suggested_filename: item.filename,
          startImmediately: false // เด้งหน้าต่างให้ผู้ใช้กดยืนยันอีกที
        });
      } else {
        // แอปปิดอยู่! ให้ปล่อยผ่านให้เบราว์เซอร์โหลดเอง
        bypassList.add(item.url);
        chrome.downloads.download({
          url: item.url,
          filename: item.filename,
          conflictAction: 'uniquify'
        });
      }
    })();
  }
});

// 2. Video Sniffer
chrome.webRequest.onHeadersReceived.addListener(
  ((details: any) => {
    (async () => {
    if (details.tabId < 0) return;

    const url = details.url.toLowerCase();
    
    // Ignore junk
    if (url.includes('.ts') || url.includes('.m4s') || url.includes('.jpeg') || url.includes('.jpg')) {
      return;
    }

    let isM3u8 = url.includes('.m3u8');
    let isVideo = ['.mp4', '.mkv', '.webm', '.mov', '.flv', '.mp3', '.m4a'].some(ext => url.includes(ext));
    
    const contentTypeHeader = details.responseHeaders?.find((h: any) => h.name.toLowerCase() === 'content-type')?.value?.toLowerCase();
    
    if (!isM3u8 && !isVideo) {
        if (contentTypeHeader && (contentTypeHeader.includes('application/vnd.apple.mpegurl') || contentTypeHeader.includes('application/x-mpegurl'))) {
           isM3u8 = true;
        } else if (contentTypeHeader && (contentTypeHeader.startsWith('video/') || contentTypeHeader.startsWith('audio/'))) {
           isVideo = true;
        } else {
           return;
        }
    }
    
    const clHeader = details.responseHeaders?.find((h: any) => h.name.toLowerCase() === 'content-length')?.value;
    const size = clHeader ? parseInt(clHeader, 10) : 0;
    
    // Ignore small files unless it's m3u8
    if (!isM3u8 && size < 300 * 1024) {
      return;
    }
    
    let tab;
    try {
      tab = await chrome.tabs.get(details.tabId);
    } catch(e) {
      return; // Tab closed
    }
    
    if (!tab) return;

    const referer = tab.url || "";
    let cleanTitle = tab.title || "Video";
    
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: details.tabId },
        func: () => {
          let title = "";
          const ogTitle = document.querySelector('meta[property="og:title"]');
          if (ogTitle && ogTitle.getAttribute("content")) {
            title = ogTitle.getAttribute("content") as string;
          }
          if (!title) {
            title = document.title;
            // Remove common suffixes like " - Watch Online", " | SiteName", etc.
            title = title.replace(/\s*[-|]\s*(Watch Online|HD|Free|Ep\.|Episode).*/i, '').trim();
            // Also trim standard domain pipe
            title = title.split(' | ')[0].trim();
          }
          if (!title || title.trim() === "") {
            const h1 = document.querySelector('h1');
            if (h1 && h1.innerText) {
              title = h1.innerText;
            } else {
               const video = document.querySelector('video[title]');
               if (video) title = video.getAttribute("title") as string;
            }
          }
          return title;
        }
      });
      if (results && results[0] && results[0].result) {
        cleanTitle = results[0].result;
      }
    } catch (e) {
      // Ignore scripting errors (e.g., chrome:// URLs)
    }

    cleanTitle = cleanTitle.replace(/[\\/:*?"<>|]/g, "").trim() || "Video";
    const type = isM3u8 ? "HLS (.m3u8)" : "Media";
    const ext = isM3u8 ? ".ts" : (isVideo && contentTypeHeader ? (contentTypeHeader.split('/')[1]?.split(';')[0] || "mp4") : "mp4");
    const fileName = `${cleanTitle}.${ext}`;
    
    const data = await chrome.storage.session.get('videos');
    const videos = data.videos || {};
    if (!videos[details.tabId]) videos[details.tabId] = [];
    
    if (!videos[details.tabId].find((v: any) => v.url === details.url)) {
        videos[details.tabId].push({
            url: details.url,
            referer,
            fileName,
            suggested_filename: fileName,
            size,
            type
        });
        await chrome.storage.session.set({ videos });
        
        chrome.action.setBadgeText({ text: videos[details.tabId].length.toString(), tabId: details.tabId });
        chrome.action.setBadgeBackgroundColor({ color: "#f26b5b", tabId: details.tabId });
    }
    })();
  }) as any,
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Clear on tab change
chrome.tabs.onRemoved.addListener(async (tabId: any) => {
    const data = await chrome.storage.session.get('videos');
    const videos = data.videos || {};
    if (videos[tabId]) {
        delete videos[tabId];
        await chrome.storage.session.set({ videos });
    }
});

chrome.tabs.onUpdated.addListener(async (tabId: any, changeInfo: any) => {
    if (changeInfo.status === 'loading' && changeInfo.url) {
        const data = await chrome.storage.session.get('videos');
        const videos = data.videos || {};
        if (videos[tabId]) {
            delete videos[tabId];
            await chrome.storage.session.set({ videos });
            chrome.action.setBadgeText({ text: "", tabId: tabId });
        }
    }
});

// 3. Context Menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "download_warper",
    title: "Download with Warper",
    contexts: ["link", "video", "audio"]
  });
  
  // Set default intercept settings
  chrome.storage.local.get("interceptDownloads").then((res: any) => {
     if (res.interceptDownloads === undefined) {
         chrome.storage.local.set({ interceptDownloads: true });
     }
  });
});

chrome.contextMenus.onClicked.addListener((info: any, tab: any) => {
  if (info.menuItemId === "download_warper") {
    const url = info.linkUrl || info.srcUrl || info.pageUrl || "";
    let cleanTitle = tab?.title ? tab.title.replace(/[\\/:*?"<>|]/g, "").trim() : "Download";
    sendToWarper({
      url,
      referer: tab?.url || "",
      fileName: `${cleanTitle}.mp4`,
      suggested_filename: `${cleanTitle}.mp4`,
      startImmediately: false
    });
  }
});

chrome.runtime.onMessage.addListener((message: any, sender: any, sendResponse: any) => {
  if (message.type === "GET_VIDEOS") {
    const tabId = message.tabId || sender.tab?.id;
    if (tabId) {
      chrome.storage.session.get('videos').then((data: any) => {
        const videos = data.videos || {};
        sendResponse({ videos: videos[tabId] || [] });
      });
      return true;
    } else {
      sendResponse({ videos: [] });
    }
  }
});
