/**
 * Connect persistent workspace panels using the automatic-activation tabs pattern
 *  Only visibility changes: uploads, unsaved forms and worker state stay mounted
 * 
 * @param {HTMLElement} tablist   The workspace's tablist
 * @returns {void}
 */
export function initWorkspaceTabs(tablist) {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];

  // The tab to show
  function activate(selected) {
    for (const tab of tabs) {
      const active = tab === selected;

      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;

      document.getElementById(tab.getAttribute("aria-controls")).hidden = !active;
    }
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (event) => {
      let index = tabs.indexOf(tab);

      if (event.key === "ArrowRight") {
        index = (index + 1) % tabs.length;

      } else if (event.key === "ArrowLeft") {
        index = (index + tabs.length - 1) % tabs.length;

      } else if (event.key === "Home") {
        index = 0;

      } else if (event.key === "End") {
        index = tabs.length - 1;
      } else {
        return;
      }

      event.preventDefault();
      activate(tabs[index]);

      tabs[index].focus();
    });
  }

  activate(tabs[0]);
}
