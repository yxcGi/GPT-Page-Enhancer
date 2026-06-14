const DEFAULT_PERCENT = 72;
const STORAGE_KEY = "chatgptContentWidthPercent";

const range = document.getElementById("width-range");
const value = document.getElementById("width-value");
const storage = chrome.storage && chrome.storage.sync ? chrome.storage.sync : chrome.storage.local;

function updateDisplay(percent) {
  range.value = String(percent);
  value.textContent = `${percent}%`;
}

function sendToActiveTab(percent) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, {
      type: "CGPT_SET_WIDTH",
      value: percent
    }, () => {
      void chrome.runtime.lastError;
    });
  });
}

storage.get({ [STORAGE_KEY]: DEFAULT_PERCENT }, (items) => {
  updateDisplay(items[STORAGE_KEY]);
});

range.addEventListener("input", () => {
  const percent = Number(range.value);
  updateDisplay(percent);
  storage.set({ [STORAGE_KEY]: percent });
  sendToActiveTab(percent);
});
