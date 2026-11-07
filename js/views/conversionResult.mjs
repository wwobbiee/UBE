/**
 * Present worker output without interpolating filenames or report text into HTML
 * Blob URL ownership remains with the controller, which invalidates stale links
 * 
 * @param {Object} result                                                     Export result, including optional error and report entries
 * @param {function(string, Blob, string=): HTMLAnchorElement} downloadLink   Tracked link builder
 * @returns {void}
 */
export function renderConversionResult(result, downloadLink) {
  const report   = document.querySelector("#report");
  const messages = result.report || [];
  const links    = document.querySelector("#download-links");

  document.querySelector("#results").hidden = false;
  report.replaceChildren();

  for (const message of messages) {
    const item = document.createElement("li");
    item.textContent = `${message.file}: ${message.message}`;

    report.append(item);
  }

  document.querySelector("#report-details").hidden    = !messages.length;
  document.querySelector("#report-count").textContent = `${messages.length} conversion messages`;

  const summary = document.querySelector("#result-summary");
  if (result.error) {
    summary.textContent = result.error;

    return;
  }

  summary.textContent = `${result.count} ${result.count === 1 ? "difficulty" : "difficulties"} converted. ${messages.length ? "Review the conversion messages below." : "Ready to download."}`;

  const chart = downloadLink(result.name, new Blob([result.bytes], { type: result.mime }));
  links.append(chart);
  
  if (messages.length) {
    const text = messages.map((message) => `${message.file}\n  ${message.message}`).join("\n\n");
    links.append(downloadLink(
      "UBE-conversion-report.txt",
      new Blob([text], { type: "text/plain" }),
      "Download report"
    ));
  }

  chart.click();
}
