const DEFAULT_PERCENT = 72;
const STORAGE_KEY = "chatgptContentWidthPercent";
const BACKGROUND_KEY = "chatgptPageBackground";
const DEFAULT_BACKGROUND = "default";

const range = document.getElementById("width-range");
const value = document.getElementById("width-value");
const swatches = Array.from(document.querySelectorAll(".swatch"));
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

function sendBackgroundToActiveTab(background) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, {
      type: "CGPT_SET_BACKGROUND",
      value: background
    }, () => {
      void chrome.runtime.lastError;
    });
  });
}

function updateBackgroundDisplay(background) {
  for (const swatch of swatches) {
    const selected = swatch.dataset.background === background;
    swatch.setAttribute("aria-checked", String(selected));
  }
}

storage.get({ [STORAGE_KEY]: DEFAULT_PERCENT, [BACKGROUND_KEY]: DEFAULT_BACKGROUND }, (items) => {
  updateDisplay(items[STORAGE_KEY]);
  updateBackgroundDisplay(items[BACKGROUND_KEY] || DEFAULT_BACKGROUND);
});

range.addEventListener("input", () => {
  const percent = Number(range.value);
  updateDisplay(percent);
  storage.set({ [STORAGE_KEY]: percent });
  sendToActiveTab(percent);
});

for (const swatch of swatches) {
  swatch.addEventListener("click", () => {
    const background = swatch.dataset.background || DEFAULT_BACKGROUND;
    updateBackgroundDisplay(background);
    storage.set({ [BACKGROUND_KEY]: background });
    sendBackgroundToActiveTab(background);
  });
}
