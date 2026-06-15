const setupPanel = document.getElementById('setupPanel');
const clipPanel = document.getElementById('clipPanel');
const statusPanel = document.getElementById('statusPanel');
const errorPanel = document.getElementById('errorPanel');
const thumbnail = document.getElementById('thumbnail');
const titleInput = document.getElementById('titleInput');
const artistInput = document.getElementById('artistInput');
const albumInput = document.getElementById('albumInput');
const uploadButton = document.getElementById('uploadButton');
const cancelButton = document.getElementById('cancelButton');
const closeButton = document.getElementById('closeButton');
const settingsButton = document.getElementById('settingsButton');
const openOptionsButton = document.getElementById('openOptionsButton');
const errorCloseButton = document.getElementById('errorCloseButton');
const statusTitle = document.getElementById('statusTitle');
const statusMessage = document.getElementById('statusMessage');
const errorMessage = document.getElementById('errorMessage');
const progress = document.getElementById('progress');

let settings = null;
let clip = null;

function show(panel) {
  [setupPanel, clipPanel, statusPanel, errorPanel].forEach((item) => item.classList.add('hidden'));
  panel.classList.remove('hidden');
}

function closePopup() {
  window.close();
}

function openOptions() {
  chrome.runtime.openOptionsPage();
}

function getVideoId(url) {
  const parsed = new URL(url);
  if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1);
  return parsed.searchParams.get('v');
}

function pageMetadata() {
  const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
  const title =
    document.querySelector('meta[property="og:title"]')?.content ||
    document.querySelector('h1 yt-formatted-string')?.textContent ||
    document.title.replace(/ - YouTube$/, '');
  const artist =
    document.querySelector('ytd-video-owner-renderer ytd-channel-name a')?.textContent?.trim() ||
    document.querySelector('#owner-name a')?.textContent?.trim() ||
    document.querySelector('meta[name="author"]')?.content ||
    '';
  const thumbnail =
    document.querySelector('meta[property="og:image"]')?.content ||
    document.querySelector('link[itemprop="thumbnailUrl"]')?.href ||
    '';
  return {
    url: canonical,
    title: title?.trim() || '',
    artist: artist?.trim() || '',
    thumbnailUrl: thumbnail
  };
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(['serverUrl', 'adminApiKey']);
  if (!stored.serverUrl || !stored.adminApiKey) return null;
  return {
    serverUrl: stored.serverUrl.replace(/\/$/, ''),
    adminApiKey: stored.adminApiKey
  };
}

async function detectClip() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error('No active tab found.');
  }
  const url = new URL(tab.url);
  if (!['www.youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)) {
    throw new Error('Open a YouTube video page first, then click the extension icon.');
  }
  const videoId = getVideoId(tab.url);
  if (!videoId) {
    throw new Error('This does not look like a YouTube video page.');
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pageMetadata
  });

  const metadata = result?.result || {};
  return {
    sourceUrl: metadata.url || tab.url,
    title: metadata.title || tab.title?.replace(/ - YouTube$/, '') || 'YouTube Track',
    artistName: metadata.artist || 'YouTube',
    albumTitle: metadata.title || tab.title?.replace(/ - YouTube$/, '') || 'YouTube',
    thumbnailUrl: metadata.thumbnailUrl || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
  };
}

function renderClip() {
  thumbnail.src = clip.thumbnailUrl;
  titleInput.value = clip.title;
  artistInput.value = clip.artistName;
  albumInput.value = clip.albumTitle;
  show(clipPanel);
}

function setStatus(status, message, value) {
  statusTitle.textContent = status;
  statusMessage.textContent = message;
  progress.value = value;
}

async function api(path, options = {}) {
  const response = await fetch(`${settings.serverUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${settings.adminApiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }
  return data;
}

function statusProgress(status) {
  return {
    queued: 8,
    metadata: 20,
    extracting: 45,
    uploading: 70,
    saving: 88,
    complete: 100,
    failed: 100
  }[status] ?? 15;
}

async function pollJob(importId) {
  for (;;) {
    const data = await api(`/admin/youtube-import/${importId}`);
    const job = data.job;
    if (job.status === 'complete') {
      setStatus('DONE', 'Uploaded to MyMP3Streamr.', 100);
      closeButton.classList.remove('hidden');
      return;
    }
    if (job.status === 'failed') {
      throw new Error(job.errorMessage || 'YouTube import failed.');
    }
    setStatus('Uploading', `Status: ${job.status}`, statusProgress(job.status));
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

async function uploadClip() {
  uploadButton.disabled = true;
  show(statusPanel);
  closeButton.classList.add('hidden');
  setStatus('Starting', 'Creating import job...', 5);

  const body = {
    sourceUrl: clip.sourceUrl,
    title: titleInput.value.trim() || clip.title,
    artistName: artistInput.value.trim() || clip.artistName,
    albumTitle: albumInput.value.trim() || clip.albumTitle,
    thumbnailUrl: clip.thumbnailUrl
  };
  const data = await api('/admin/youtube-import', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  await pollJob(data.importId);
}

async function init() {
  try {
    settings = await loadSettings();
    if (!settings) {
      show(setupPanel);
      return;
    }
    clip = await detectClip();
    renderClip();
  } catch (error) {
    errorMessage.textContent = error instanceof Error ? error.message : 'Unable to detect YouTube clip.';
    show(errorPanel);
  }
}

settingsButton.addEventListener('click', openOptions);
openOptionsButton.addEventListener('click', openOptions);
cancelButton.addEventListener('click', closePopup);
closeButton.addEventListener('click', closePopup);
errorCloseButton.addEventListener('click', closePopup);
uploadButton.addEventListener('click', () => {
  uploadClip().catch((error) => {
    errorMessage.textContent = error instanceof Error ? error.message : 'Upload failed.';
    show(errorPanel);
  }).finally(() => {
    uploadButton.disabled = false;
  });
});

init();
