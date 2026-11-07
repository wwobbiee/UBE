/**
 * Connect a native top layer popover as an accessible group selection menu
 *  The top layer prevents clipping by collapsed cards and the bounded file list
 * 
 * @param {HTMLButtonElement} trigger     Heading's menu button
 * @param {HTMLElement} menu              Popover containing native menuitem buttons
 * @returns {function(boolean=): void}    Close function, optionally restoring focus
 */
export function initSelectionMenu(trigger, menu) {
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-controls", menu.id);
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("popovertarget", menu.id);

  // Currently available menu commands
  function enabledItems() {
    return [...menu.querySelectorAll('[role="menuitem"]')].filter((item) => !item.disabled);
  }

  // Whether dismissal should return to the trigger
  function close(restoreFocus = false) {
    if (menu.matches(":popover-open")) {
      menu.hidePopover();
    }

    if (restoreFocus && !trigger.disabled && trigger.isConnected) {
      trigger.focus({ preventScroll: true });
    }
  }

  // Keep the small popup within the viewport, independent of archive scrolling
  function position() {
    const anchor = trigger.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    const left   = Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8));
    const below  = anchor.bottom + 4;
    const top    = below + bounds.height <= window.innerHeight - 8 ? below : anchor.top - bounds.height - 4;
    menu.style.left = `${left}px`;
    menu.style.top  = `${Math.max(8, top)}px`;
  }

  // Whether ArrowUp should focus the last enabled command
  function open(last = false) {
    if (trigger.disabled) {
      return;
    }

    if (!menu.matches(":popover-open")) {
      menu.showPopover();
    }

    position();

    const items = enabledItems();
    ((last ? items.at(-1) : items[0]) || menu).focus({ preventScroll: true });
  }

  // Close when its anchor moves, not on scrolling the menu itself
  function anchorMoved(event) {
    if (event.target === window || !menu.contains(event.target)) {
      close();
    }
  }

  menu.addEventListener("beforetoggle", (event) => {
    const opened = event.newState === "open";
    trigger.setAttribute("aria-expanded", String(opened));

    if (opened) {
      window.addEventListener("scroll", anchorMoved, true);
      window.addEventListener("resize", anchorMoved);

    } else {
      window.removeEventListener("scroll", anchorMoved, true);
      window.removeEventListener("resize", anchorMoved);
    }
  });

  trigger.addEventListener("click", (event) => {
    // Prevent the popovertarget default from toggling it a second time
    event.preventDefault();

    if (menu.matches(":popover-open")) {
      close();
    } else {
      open();
    }
  });

  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }

    event.preventDefault();

    open(event.key === "ArrowUp");
  });

  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "Tab") {
      close(true);

      if (event.key === "Escape") {
        event.preventDefault();
      }

      return;
    }

    const items = enabledItems();
    let index = items.indexOf(document.activeElement);

    if (event.key === "ArrowDown") {
      index = (index + 1) % items.length;

    } else if (event.key === "ArrowUp") {
      index = (index + items.length - 1) % items.length;

    } else if (event.key === "Home") {
      index = 0;

    } else if (event.key === "End") {
      index = items.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    items[index]?.focus({ preventScroll: true });
  });

  menu.addEventListener("focusout", (event) => {
    if (!menu.contains(event.relatedTarget) && event.relatedTarget !== trigger) {
      close();
    }
  });

  return close;
}

/**
 * Dismiss top layer menus before replacing their package nodes, cleaning listeners
 * 
 * @param {HTMLElement} container Existing file list
 */
export function closeSelectionMenus(container) {
  for (const menu of container.querySelectorAll(".selection-menu:popover-open")) {
    menu.hidePopover();
  }
}
