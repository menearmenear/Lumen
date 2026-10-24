/* Lumen Piano — toolbar launcher */
const PAGE = "visualizer.html";
const TAB_KEY = "lumen.openTab";

async function openVisualizer() {
  const pageUrl = browser.runtime.getURL(PAGE);
  const stored = await browser.storage.local.get(TAB_KEY);
  const tabId = stored[TAB_KEY];

  if (Number.isInteger(tabId)) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (tab.url === pageUrl || tab.url?.startsWith(`${pageUrl}?`) || tab.url?.startsWith(`${pageUrl}#`)) {
        await browser.tabs.update(tab.id, { active: true });
        await browser.windows.update(tab.windowId, { focused: true });
        return;
      }
    } catch {
      // The previous tab was closed; fall through and open a new one.
    }
    await browser.storage.local.remove(TAB_KEY);
  }

  const tab = await browser.tabs.create({ url: pageUrl });
  await browser.storage.local.set({ [TAB_KEY]: tab.id });
}

browser.action.onClicked.addListener(openVisualizer);

browser.tabs.onRemoved.addListener(async (tabId) => {
  const stored = await browser.storage.local.get(TAB_KEY);
  if (stored[TAB_KEY] === tabId) {
    await browser.storage.local.remove(TAB_KEY);
  }
});

browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    browser.storage.local.remove(TAB_KEY);
  }
});

browser.runtime.onStartup.addListener(() => {
  browser.storage.local.remove(TAB_KEY);
});
