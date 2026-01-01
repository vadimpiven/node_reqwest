const message = await window.electronAPI
  .hello()
  .then((text) => text)
  .catch((err) => `Error: ${err.message}`);
document.getElementById('output').textContent = message;
