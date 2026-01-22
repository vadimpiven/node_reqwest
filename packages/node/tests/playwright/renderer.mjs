const message = await window.electronAPI
  .hello()
  .then((text) => text.toString())
  .catch((err) => `Error: ${err.message}`);
document.getElementById("output").textContent = message;

const undiciAgent = await window.electronAPI
  .undici_agent()
  .then((text) => text.toString())
  .catch((err) => `Error: ${err.message}`);
document.getElementById("undici_agent").textContent = undiciAgent;

const reqwestAgent = await window.electronAPI
  .reqwest_agent()
  .then((text) => text.toString())
  .catch((err) => `Error: ${err.message}`);
document.getElementById("reqwest_agent").textContent = reqwestAgent;
