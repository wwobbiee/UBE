const $ = (e) => document.querySelector(e);
const pending = new Map();


export let worker;
export function status(message, error = false) {
  $("#status").textContent = message;
  $("#status").classList.toggle("error", error);
}

export function startWorker() {
  worker = new Worker(new URL("./worker.js"), import.meta.url, {
    type: "module"
  });

  worker.onmessage = ({ data }) => {
    if (data.progress) {
      status(data.progress);
      return;
    }

    const p = pending.get(data.id);
    if (!p) {
      return;
    }

    pending.delete(data.id);
    data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
  };

  worker.onerror = (event) => {
    const error = new Error(event.message || "Thr processing worker failed. Reload the page to retry.");

    for (const p of pending.values()) {
      p.reject(error);
    }

    pending.clear();
    status(error.messsage, true);
  }
}