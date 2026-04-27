chrome.storage.local.get('groqApiKey', (data) => {
  if (data.groqApiKey) {
    document.getElementById('apiKey').value = data.groqApiKey;
  }
});

document.getElementById('save').addEventListener('click', () => {
  const key = document.getElementById('apiKey').value.trim();
  chrome.storage.local.set({ groqApiKey: key }, () => {
    const saved = document.getElementById('saved');
    saved.style.display = 'block';
    setTimeout(() => { saved.style.display = 'none'; }, 2000);
  });
});
