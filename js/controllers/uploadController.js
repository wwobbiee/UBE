// Folder drops keep webkitRelativePath, including each song's immediate folder
export async function droppedFiles(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);

  if (!entries.length) {
    return [...dataTransfer.files];
  }

  const files = [];

  /**
   * @param {FileSystemEntry} entry   Dropped file or directory
   * @param {string} [parent]         Relative directory prefix, ending in "/"
   * @throws {Error}                  If the drop exceeds 10,000 files
   */
  async function walk(entry, parent = "") {
    if (files.length >= 10000) {
      throw new Error("Folder drop exceeds 10,000 files.");
    }

    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      Object.defineProperty(file, "webkitRelativePath", {
        value: parent + file.name,
      });

      files.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();

      while (true) {
        const children = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));

        if (!children.length) {
          break;
        }

        for (const child of children) {
          await walk(child, parent + entry.name + "/");
        }
      }
    }
  }

  for (const entry of entries) {
    await walk(entry);
  }

  return files;
}
