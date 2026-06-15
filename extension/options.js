const form = document.getElementById('settingsForm');
const serverUrl = document.getElementById('serverUrl');
const adminApiKey = document.getElementById('adminApiKey');
const status = document.getElementById('status');

async function load() {
  const stored = await chrome.storage.sync.get(['serverUrl', 'adminApiKey']);
  serverUrl.value = stored.serverUrl || '';
  adminApiKey.value = stored.adminApiKey || '';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await chrome.storage.sync.set({
    serverUrl: serverUrl.value.trim().replace(/\/$/, ''),
    adminApiKey: adminApiKey.value.trim()
  });
  status.textContent = 'Saved.';
});

load();
