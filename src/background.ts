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
interface VideoEntry {
  url: string;
  referer: string;
  fileName: string;
  suggested_filename: string;
  size: number;
  sizeEstimated?: boolean;
  type: string;      // นามสกุลไฟล์จริงที่จะได้ เช่น MP4, TS, WEBM
  stream?: "HLS";
  quality?: string;  // เช่น 720p
  bandwidth?: number;
}

const MEDIA_EXTS = ['.mp4', '.mkv', '.webm', '.mov', '.flv', '.mp3', '.m4a'];
const JUNK_EXTS = ['ts', 'm4s', 'jpeg', 'jpg'];
const MIME_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/quicktime": "mov",
  "video/x-flv": "flv",
  "video/ogg": "ogv",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
  "audio/wav": "wav",
};

const urlExt = (url: string) => {
  try {
    return new URL(url).pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  } catch {
    return "";
  }
};

const mediaExt = (url: string, contentType?: string) => {
  const ext = urlExt(url);
  if (MEDIA_EXTS.includes(`.${ext}`) || Object.values(MIME_EXT).includes(ext)) return ext;
  const mime = contentType?.split(';')[0].trim();
  return (mime && MIME_EXT[mime]) || "mp4";
};

// URL ที่จัดการไปแล้วต่อแท็บ: กันไม่ให้ playlist ที่เรา fetch เองวนกลับมาเข้า listener ซ้ำ
const handledUrls = new Map<number, Set<string>>();
const markHandled = (tabId: number, url: string) => {
  let set = handledUrls.get(tabId);
  if (!set) handledUrls.set(tabId, set = new Set());
  if (set.has(url)) return false;
  set.add(url);
  return true;
};

// อ่าน/เขียน storage ทีละคิว: ถ้า request หลายตัวมาพร้อมกัน (เช่น master + variant playlist)
// ต่างคนต่าง get แล้ว set ทับกัน ทำให้เหลือแค่รายการเดียว
let storageQueue: Promise<unknown> = Promise.resolve();
function updateVideos(mutate: (videos: Record<number, VideoEntry[]>) => void) {
  const run = storageQueue.then(async () => {
    const data = await chrome.storage.session.get('videos');
    const videos = (data.videos || {}) as Record<number, VideoEntry[]>;
    mutate(videos);
    await chrome.storage.session.set({ videos });
  });
  storageQueue = run.catch(() => {});
  return run;
}

async function addVideos(tabId: number, entries: VideoEntry[]) {
  if (entries.length === 0) return;
  let count = 0;
  await updateVideos((videos) => {
    const list = videos[tabId] ||= [];
    for (const entry of entries) {
      const existing = list.find(v => v.url === entry.url);
      if (!existing) list.push(entry);
      else if (entry.quality) Object.assign(existing, entry); // ข้อมูลจาก master playlist ละเอียดกว่า
    }
    count = list.length;
  });
  chrome.action.setBadgeText({ text: count.toString(), tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#f26b5b", tabId });
}

async function getPageTitle(tabId: number, fallback: string) {
  let cleanTitle = fallback;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
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
  return cleanTitle.replace(/[\\/:*?"<>|]/g, "").trim() || "Video";
}

// โหลด playlist จากในเฟรมของหน้าเว็บก่อน (ได้ Referer/Origin เดียวกับ player ที่ CDN มักเช็ค)
// ถ้าไม่ได้ค่อย fetch จาก service worker (host_permissions ข้าม CORS ได้)
async function fetchText(url: string, tabId: number, frameId: number) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: async (u: string) => {
        try {
          const r = await fetch(u);
          return r.ok ? await r.text() : null;
        } catch {
          return null;
        }
      },
      args: [url],
    });
    if (res?.result) return res.result as string;
  } catch (e) {
    // Frame gone or not scriptable
  }
  try {
    const r = await fetch(url);
    if (r.ok) return await r.text();
  } catch (e) {
    // Network/CORS failure
  }
  return null;
}

const parseAttrs = (line: string) => {
  const attrs: Record<string, string> = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    attrs[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return attrs;
};

function parseMasterPlaylist(text: string, baseUrl: string) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const variants: { url: string; bandwidth: number; quality?: string }[] = [];
  lines.forEach((line, i) => {
    if (!line.startsWith("#EXT-X-STREAM-INF:")) return;
    const uri = lines.slice(i + 1).find(l => l && !l.startsWith("#"));
    if (!uri) return;
    const attrs = parseAttrs(line.slice("#EXT-X-STREAM-INF:".length));
    const height = attrs.RESOLUTION?.split("x")[1];
    variants.push({
      url: new URL(uri, baseUrl).href,
      bandwidth: Number(attrs["AVERAGE-BANDWIDTH"] || attrs.BANDWIDTH) || 0,
      quality: height ? `${height}p` : undefined,
    });
  });
  return variants.sort((a, b) => b.bandwidth - a.bandwidth);
}

function parseMediaPlaylist(text: string) {
  let duration = 0;
  let bytes = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#EXTINF:")) duration += parseFloat(line.slice(8)) || 0;
    else if (line.startsWith("#EXT-X-BYTERANGE:")) bytes += parseInt(line.slice(17), 10) || 0;
  }
  return {
    duration,
    bytes,
    isLive: !text.includes("#EXT-X-ENDLIST"),
    // ตามสเปก HLS: ถ้าไม่มี EXT-X-MAP (init segment) segment เป็น MPEG-TS, ถ้ามีคือ fMP4
    // ใช้ตรงนี้แทนนามสกุล segment เพราะบางเว็บปลอมเป็น .jpeg/.png
    container: text.includes("#EXT-X-MAP") ? "mp4" : "ts",
  };
}

function makeHlsEntry(
  url: string, referer: string, title: string,
  playlist: string | null, variant?: { bandwidth: number; quality?: string },
): VideoEntry {
  const info = playlist ? parseMediaPlaylist(playlist) : null;
  const ext = info?.container || "ts";
  let size = 0;
  let sizeEstimated = false;
  if (info && !info.isLive) {
    if (info.bytes) size = info.bytes;
    else if (variant?.bandwidth && info.duration) {
      size = Math.round(variant.bandwidth * info.duration / 8);
      sizeEstimated = true;
    }
  }
  const fileName = `${title}.${ext}`;
  return {
    url, referer, fileName, suggested_filename: fileName,
    size, sizeEstimated,
    type: ext.toUpperCase(),
    stream: "HLS",
    quality: variant?.quality,
    bandwidth: variant?.bandwidth,
  };
}

async function handleHls(tabId: number, frameId: number, url: string, referer: string, title: string) {
  const text = await fetchText(url, tabId, frameId);
  if (!text || !text.includes("#EXT-X-STREAM-INF")) {
    // Media playlist ตัวเดียว (หรือโหลดไม่ได้)
    await addVideos(tabId, [makeHlsEntry(url, referer, title, text)]);
    return;
  }
  // Master playlist: แตกเป็นทุกความละเอียดแบบที่ IDM แสดง
  const variants = parseMasterPlaylist(text, url);
  variants.forEach(v => markHandled(tabId, v.url));
  const entries = await Promise.all(variants.map(async v =>
    makeHlsEntry(v.url, referer, title, await fetchText(v.url, tabId, frameId), v)
  ));
  await addVideos(tabId, entries);
}

chrome.webRequest.onHeadersReceived.addListener(
  ((details: any) => {
    (async () => {
    if (details.tabId < 0) return;

    const url = details.url.toLowerCase();
    const ext = urlExt(details.url);
    const contentTypeHeader = details.responseHeaders?.find((h: any) => h.name.toLowerCase() === 'content-type')?.value?.toLowerCase();

    const isM3u8 = url.includes('.m3u8') ||
      !!contentTypeHeader && (contentTypeHeader.includes('application/vnd.apple.mpegurl') || contentTypeHeader.includes('application/x-mpegurl'));

    // Ignore junk (HLS/DASH segments, images)
    if (!isM3u8 && (JUNK_EXTS.includes(ext) || contentTypeHeader?.startsWith('video/mp2t') || contentTypeHeader?.startsWith('video/iso.segment'))) {
      return;
    }

    let isVideo = !isM3u8 && MEDIA_EXTS.some(e => url.includes(e));
    if (!isM3u8 && !isVideo) {
        if (contentTypeHeader && (contentTypeHeader.startsWith('video/') || contentTypeHeader.startsWith('audio/'))) {
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

    if (!markHandled(details.tabId, details.url)) return;

    let tab;
    try {
      tab = await chrome.tabs.get(details.tabId);
    } catch(e) {
      return; // Tab closed
    }

    if (!tab) return;

    const referer = tab.url || "";
    const cleanTitle = await getPageTitle(details.tabId, tab.title || "Video");

    if (isM3u8) {
      await handleHls(details.tabId, details.frameId, details.url, referer, cleanTitle);
      return;
    }

    const fileExt = mediaExt(details.url, contentTypeHeader);
    const fileName = `${cleanTitle}.${fileExt}`;
    await addVideos(details.tabId, [{
      url: details.url,
      referer,
      fileName,
      suggested_filename: fileName,
      size,
      type: fileExt.toUpperCase(),
    }]);
    })();
  }) as any,
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Clear on tab change
chrome.tabs.onRemoved.addListener((tabId: any) => {
    handledUrls.delete(tabId);
    updateVideos((videos) => { delete videos[tabId]; });
});

chrome.tabs.onUpdated.addListener((tabId: any, changeInfo: any) => {
    if (changeInfo.status === 'loading' && changeInfo.url) {
        handledUrls.delete(tabId);
        updateVideos((videos) => { delete videos[tabId]; });
        chrome.action.setBadgeText({ text: "", tabId: tabId });
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
