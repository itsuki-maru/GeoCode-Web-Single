export function resetMapSearchStatus(): void {
  const element = document.getElementById("mode-description");
  if (!element || element.dataset.searchOriginalHtml === undefined) return;
  element.innerHTML = element.dataset.searchOriginalHtml;
  element.style.color = element.dataset.searchOriginalColor ?? "";
  delete element.dataset.searchOriginalHtml;
  delete element.dataset.searchOriginalColor;
}

export function showMapSearchStatus(message: string, error = false): void {
  let element = document.getElementById("mode-description");
  if (!element) {
    element = document.createElement("div");
    element.id = "mode-description";
    element.className = "mode-desc-container";
    Object.assign(element.style, {
      position: "absolute",
      bottom: "10px",
      left: "10px",
      zIndex: "1000",
      backgroundColor: "white",
      padding: "5px",
      borderRadius: "5px",
    });
    document.body.append(element);
  }
  if (element.dataset.searchOriginalHtml === undefined) {
    element.dataset.searchOriginalHtml = element.innerHTML;
    element.dataset.searchOriginalColor = element.style.color;
  }
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");
  element.textContent = message;
  element.style.color = error ? "red" : "";
}
