const coordinateFormat = new Intl.NumberFormat("en-US", {
  useGrouping: false,
  maximumFractionDigits: 20,
});

export function googleMapLocationUrl(point: { lat: number; lng: number }): string {
  const url = new URL("https://www.google.com/maps/search/");
  url.searchParams.set("api", "1");
  url.searchParams.set(
    "query",
    `${coordinateFormat.format(point.lat)},${coordinateFormat.format(point.lng)}`,
  );
  return url.href;
}

export function createGoogleMapLink(doc: Document): HTMLAnchorElement {
  const link = doc.createElement("a");
  link.textContent = "Google Map で開く";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}
