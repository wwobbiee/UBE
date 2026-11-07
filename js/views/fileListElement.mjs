import { packageGroup } from "./packageGroups.mjs";
import { initSelectionMenu, closeSelectionMenus } from "../controllers/selectionMenuController.js";


let groupSequence = 0;

/**
 * Build a view element
 * Uploaded strings are always textContent/value, never HTML
 * 
 * @param {string} tag      Element name
 * @param {string} [cls]    CSS classes
 * @param {string} [text]   Visible text
 * @returns {HTMLElement}   The new element
 */
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) {
    node.className = cls;
  }

  if (text !== undefined) {
    node.textContent = text;
  }

  return node;
};

/**
 * Build the metadata editor and its save/inspect handlers for one difficulty
 * 
 * @param {Object} c            Difficulty summary
 * @param {Object} actions      Controller callbacks
 * @returns {HTMLFormElement}   The editor form
 */
function createChartEditor(c, { edit, inspect, onError }) {
  const form = el("form", "chart-editor");

  /**
   * Append a labelled editor input; values are assigned as text, never markup
   * 
   * @param {string} label          Visible field label
   * @param {string} name           Form key
   * @param {string|number} value   Current value
   * @param {string} type           Input type
   * @param {Object} attrs          Supported numeric input constraints
   */
  const input = (label, name, value, type = "text", attrs = {}) => {
    const wrapper = el("label", "field");
    const control = el("input");

    control.name  = name;
    control.type  = type;
    control.value = value ?? "";

    Object.assign(control, attrs);
    wrapper.append(el("span", "", label), control);

    form.append(wrapper);
  };

  input("Title",           "title",   c.title);
  input("Artist",          "artist",  c.artist);
  input("Creator",         "creator", c.creator);
  input("Difficulty name", "version", c.version);
  input("SM / BMS meter",  "rating",  c.rating, "number", {
    min: "1",
    max: "999",
    step: "1"
  });
  input(
    "osu! overall difficulty",
    "overallDifficulty",
    c.overallDifficulty,
    "number",
    {
      min:   "0",
      max:  "10",
      step: ".1"
    }
  );
  input("Preview time (ms)", "previewTime", c.previewTime, "number", {
    min: "-1",
    step: "1"
  });
  input("Shift timing by (ms)", "offset", 0, "number", {
    min:  "-600000",
    max:  "600000",
    step: ".001"
  });
  input("Audio file (relative path)", "audioFile", c.audioFile);
  input("Background (relative path)", "background", c.background);

  const mirror      = el("label", "mirror-option");
  const mirrorCheck = el("input");
  mirrorCheck.type  = "checkbox";
  mirrorCheck.name  = "mirror";
  mirror.append(
    mirrorCheck,
    document.createTextNode(" Mirror lanes on save")
  );

  form.append(mirror);

  const actions = el("div", "editor-actions");
  const save    = el("button", "small", "Save changes");
  const json    = el("button", "quiet small", "Inspect UBE JSON");
  save.type = "submit";
  json.type = "button";
  json.onclick = () => inspect(c.id);

  actions.append(save, json);

  form.append(actions);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const values  = Object.fromEntries(new FormData(form));
      values.mirror = mirrorCheck.checked;

      await edit(c.id, values);
    } catch (err) {
      onError(err.message);
    }
  };

  return form;
}

/**
 * Build a selectable difficulty with expandable details and warnings
 * 
 * @param {Object} c              Difficulty summary
 * @param {Set<string>} opened    IDs of details that were open before a data refresh
 * @param {Object} actions        Controller callbacks
 * @returns {HTMLElement}         The chart row
 */
function createChartRow(c, opened, actions) {
  const { edit, inspect, onError } = actions;
  const row   = el("div", "chart-row");
  const check = el("input");

  check.type    = "checkbox";
  check.checked = c.selected;
  check.setAttribute("aria-label", `Include ${c.path} ${c.version}`);
  check.dataset.chartId = c.id;
  check.onchange = () => actions.select([c.id], check.checked ? "all" : "none");

  const details = el("details", "chart-details");
  details.dataset.id = c.id;
  details.open       = opened.has(c.id);

  const summary = el("summary");
  const heading = el("span", "chart-title", c.title || c.path);
  const version = el(
    "span",
    "chart-version",
    c.version || "Untitled difficulty"
  );

  summary.append(
    heading,
    version,
    el("span", "chart-stats", `${c.keyCount}K · ${c.notes.toLocaleString()} notes · ${c.holds} holds · ${Number(c.bpm.toFixed(3))} BPM`),
    el("span", "format-tag", c.format)
  );

  details.append(summary, el("p", "source-path", c.path));
  details.append(createChartEditor(c, {
    edit,
    inspect,
    onError
  }));

  if (c.warnings.length) {
    const list = el("ul", "warning-list");
    for (const message of c.warnings) {
      list.append(el("li", "", message));
    }

    details.append(list);
  }

  row.append(check, details);

  return row;
}

/**
 * Toggle visibility only: even hidden editors remain mounted with unsaved values
 * 
 * @param {HTMLElement} group     Group card
 * @param {boolean} expanded      Whether to show descendants
 */
function expandGroup(group, expanded) {
  group.dataset.expanded = String(expanded);

  group.querySelector(":scope > .package-heading .group-toggle").setAttribute("aria-expanded", String(expanded));
  group.querySelector(":scope > .group-content").hidden = !expanded;
}

/**
 * Expand or collapse every archive and visual song group without rerendering
 * 
 * @param {HTMLElement} container     File list
 * @param {boolean} expanded          Desired visibility
 */
export function expandPackageGroups(container, expanded) {
  for (const group of container.querySelectorAll("[data-group-key]")) {
    expandGroup(group, expanded);
  }
}

/**
 * Build heading actions that stay accessible while descendants are hidden
 * Uses the same explicit IDs and atomic selection callback as the expanded tools
 * 
 * @param {Object} group      View descriptor with descendant IDs and display name
 * @param {string} id         Unique popover ID
 * @param {Object} actions    Existing selection/error callbacks
 * @returns {HTMLElement}     Compact menu trigger and top-layer popover
 */
function createSelectionMenu(group, id, actions) {
  const wrapper = el("div", "group-selection-menu");
  const trigger = el("button", "quiet small selection-menu-trigger", "...");
  const menu    = el("div", "selection-menu");

  trigger.type = "button";
  trigger.setAttribute("aria-label", `Selection actions for ${group.name}`);
  trigger.title = `Selection actions for ${group.name}`;

  menu.id = id;
  menu.setAttribute("popover", "auto");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `Difficulty selection for ${group.name}`);
  menu.tabIndex = -1;

  const close = initSelectionMenu(trigger, menu);
  for (const [mode, label] of [["all", "Select all"], ["none", "Deselect all"], ["invert", "Invert selection"]]) {
    const item = el("button", "quiet small", label);

    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    item.dataset.empty = String(!group.chartIds.length);
    item.disabled = !group.chartIds.length;

    item.onclick = async () => {
      if (item.disabled || trigger.disabled) {
        return;
      }

      close(true);

      try {
        await actions.select(group.chartIds, mode);
      } catch (error) {
        actions.onError(error.message);
      }

      // Busy-state locking may temporarily blur the trigger. Never scroll back
      // to it or steal focus if a tab switch/removal has hidden it in the meantime
      if (trigger.isConnected && !trigger.disabled && trigger.getClientRects().length) {
        trigger.focus({ preventScroll: true });
      }
    };

    menu.append(item);
  }
  wrapper.append(trigger, menu);

  return wrapper;
}

/**
 * Build one visual archive/folder card; selection targets include all descendants
 * 
 * @param {Object} group                    View-only group descriptor
 * @param {Set<string>} opened              Expanded difficulty IDs
 * @param {Map<string, boolean>} expanded   Prior archive/folder expansion states
 * @param {Object} actions                  Controller callbacks
 * @param {boolean} nested                  Whether removal belongs to an ancestor package
 * @returns {HTMLElement}                   Mounted card and its persistent descendant content
 */
function createPackageGroup(group, opened, expanded, actions, nested = false) {
  const root    = el("div", "package");
  const heading = el("div", "package-heading");

  // const toggle       = el("button", "quiet group-toggle", group.name);
  const toggle       = document.createElement("button");
  toggle.classList = "quiet group-toggle";
  toggle.innerHTML = `<span>${group.name}</span>`;

  const count        = el("span", "group-count");
  const content      = el("div", "group-content");

  root.dataset.groupKey = group.key;
  root.dataset.chartIds = JSON.stringify(group.chartIds);

  content.id = `group-content-${++groupSequence}`;
  toggle.type = "button";
  toggle.setAttribute("aria-controls", content.id);
  toggle.onclick = () => expandGroup(root, root.dataset.expanded !== "true");

  heading.append(toggle, count);

  const selectionMenu = createSelectionMenu(group, `${content.id}-selection`, actions);

  if (!nested) {
    const remove = el("button", "quiet small remove-btn", "Remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${group.name}`);
    remove.onclick = () => actions.remove(group.packageId);

    const removeMenuItem = el("button", "quiet small sub-m-remove", "Remove");
    removeMenuItem.type = "button";
    removeMenuItem.setAttribute("role", "menuitem");
    removeMenuItem.tabIndex = -1;
    removeMenuItem.onclick = () => remove.click();

    selectionMenu.querySelector(".selection-menu").append(removeMenuItem);
    heading.append(remove);
  }

  heading.append(selectionMenu);

  const tools = el("div", "group-actions");
  tools.setAttribute("role", "group");
  tools.setAttribute("aria-label", `Difficulty selection for ${group.name}`);

  for (const [mode, label] of [["all", "Select all"], ["none", "Deselect all"], ["invert", "Invert selection"]]) {
    const button = el("button", "quiet small", label);
    button.type = "button";
    button.dataset.empty = String(!group.chartIds.length);
    button.disabled = !group.chartIds.length;
    button.onclick = () => actions.select(group.chartIds, mode);

    tools.append(button);
  }

  content.append(tools);

  for (const message of group.errors) {
    content.append(el("p", "error inline-message", message));
  }

  for (const chart of group.charts) {
    content.append(createChartRow(chart, opened, actions));
  }

  for (const child of group.children) {
    content.append(createPackageGroup(child, opened, expanded, actions, true));
  }

  if (!group.chartIds.length && !group.errors.length) {
    content.append(el("p", "inline-message", "Assets ready. Add a chart to convert them together."));
  }

  root.append(heading, content);

  // Small groups stay browsable
  // Large imports start compact; user choices win on refresh
  expandGroup(root, expanded.get(group.key) ?? group.chartIds.length <= 20)

  return root;
}

/**
 * Synchronize only checkboxes and counts from authoritative package summaries
 * Editors, expansion, focus and the file-list scroll position remain untouched
 * 
 * @param {HTMLElement} container     File list
 * @param {Object[]} packages         Current summaries with worker-confirmed selection
 */
export function updatePackageSelection(container, packages) {
  const selection = new Map();

  /**
   * @param {Object} p Package summary
   */
  function visit(p) {
    for (const chart of p.charts) {
      selection.set(chart.id, chart.selected);
    }

    for (const child of p.archives) {
      visit(child);
    }
  }

  for (const p of packages) {
    visit(p);
  }

  for (const checkbox of container.querySelectorAll("input[data-chart-id]")) {
    checkbox.checked = selection.get(checkbox.dataset.chartId) ?? false;
  }

  for (const group of container.querySelectorAll("[data-group-key]")) {
    const ids = JSON.parse(group.dataset.chartIds);
    const selected = ids.filter((id) => selection.get(id)).length;
    const mixed = selected > 0 && selected < ids.length;

    group.dataset.selectionState = mixed
      ? "mixed"
      : selected ? "all" : "none";
    group.querySelector(":scope > .package-heading .group-count").innerHTML = `${selected} / ${ids.length} <span class="gc-text">selected${mixed ? " · mixed" : ""}</span>`;
  }
}

/**
 * Refresh package views on structural/metadata changes, retaining group expansion
 * Selection-only operations use updatePackageSelection instead of rebuilding forms
 * 
 * @param {HTMLElement} container     File list
 * @param {Object[]} packages         Package tree
 * @param {Object} actions            Selection, edit, remove, inspect and error callbacks
 */
export function renderPackages(container, packages, actions) {
  const opened = new Set([...container.querySelectorAll("details[open]")].map((details) => details.dataset.id));
  const expanded = new Map([...container.querySelectorAll("[data-group-key]")].map((group) => [group.dataset.groupKey, group.dataset.expanded === "true"]));

  closeSelectionMenus(container);
  container.replaceChildren();

  for (const p of packages) {
    container.append(createPackageGroup(packageGroup(p), opened, expanded, actions));
  }

  updatePackageSelection(container, packages);
}
