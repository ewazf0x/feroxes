/** 20×20 line icons (1.6 px stroke), drawn for this app. */
const PATHS: Record<string, string> = {
  today: 'M10 3.5v1.6M10 14.9v1.6M3.5 10h1.6M14.9 10h1.6M5.4 5.4l1.1 1.1M13.5 13.5l1.1 1.1M5.4 14.6l1.1-1.1M13.5 6.5l1.1-1.1M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  chat: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H9l-3.5 3v-3A2.5 2.5 0 0 1 4 10.5v-5Z',
  mind: 'M7.5 15.5V17h5v-1.5M10 3a5 5 0 0 0-3 9c.6.5 1 1.2 1 2v.5h4V14c0-.8.4-1.5 1-2a5 5 0 0 0-3-9ZM10 7v3m0 0 2-1.5M10 10 8 8.5',
  memory: 'M4 5.5C4 4.1 6.7 3 10 3s6 1.1 6 2.5S13.3 8 10 8 4 6.9 4 5.5Zm0 0v4.5C4 11.4 6.7 12.5 10 12.5s6-1.1 6-2.5V5.5M4 10v4.5C4 15.9 6.7 17 10 17s6-1.1 6-2.5V10',
  goals: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm0-3.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0-2.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  devices: 'M3 5.5A1.5 1.5 0 0 1 4.5 4h8A1.5 1.5 0 0 1 14 5.5V11H3V5.5ZM2 13h13M15.5 7h1A1.5 1.5 0 0 1 18 8.5v6a1.5 1.5 0 0 1-1.5 1.5h-1A1.5 1.5 0 0 1 14 14.5v-6A1.5 1.5 0 0 1 15.5 7Z',
  activity: 'M3 10h3l2-5 4 10 2-5h3',
  settings: 'M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm6-2.5-1.6.5a4.6 4.6 0 0 1-.5 1.2l.8 1.5-1.3 1.3-1.5-.8c-.4.2-.8.4-1.2.5L10.2 16H8.4l-.5-1.6a4.6 4.6 0 0 1-1.2-.5l-1.5.8-1.3-1.3.8-1.5a4.6 4.6 0 0 1-.5-1.2L2.6 10V8.2l1.6-.5c.1-.4.3-.8.5-1.2l-.8-1.5 1.3-1.3 1.5.8c.4-.2.8-.4 1.2-.5L8.4 2.4h1.8l.5 1.6c.4.1.8.3 1.2.5l1.5-.8 1.3 1.3-.8 1.5c.2.4.4.8.5 1.2l1.6.5V10Z',
  search: 'M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm7.5 1.5L13.3 13.3',
  stop: 'M6.5 5h7A1.5 1.5 0 0 1 15 6.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 5 13.5v-7A1.5 1.5 0 0 1 6.5 5Z',
  play: 'M7 5.2v9.6a.7.7 0 0 0 1.05.6l7.4-4.8a.7.7 0 0 0 0-1.2L8.05 4.6A.7.7 0 0 0 7 5.2Z',
  send: 'M4 10h11M10.5 4.5 16 10l-5.5 5.5',
  mic: 'M10 12.5a2.5 2.5 0 0 0 2.5-2.5V5.5a2.5 2.5 0 0 0-5 0V10a2.5 2.5 0 0 0 2.5 2.5Zm-5-2.5a5 5 0 0 0 10 0M10 15v2',
  plus: 'M10 4v12M4 10h12',
  check: 'M4.5 10.5 8 14l7.5-8',
  x: 'M5.5 5.5l9 9m0-9-9 9',
  shield: 'M10 2.8 4 5v4.6c0 3.6 2.6 6.4 6 7.6 3.4-1.2 6-4 6-7.6V5l-6-2.2Z',
  bolt: 'M11 2.5 4.5 11H10l-1 6.5L15.5 9H10l1-6.5Z',
  pc: 'M3 4.5h14v9H3zM7 16.5h6M10 13.5v3',
  phone: 'M6.5 2.5h7A1.5 1.5 0 0 1 15 4v12a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 5 16V4a1.5 1.5 0 0 1 1.5-1.5ZM9 15h2',
  sun: 'M10 13.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM10 2v1.5M10 16.5V18M2 10h1.5M16.5 10H18M4.3 4.3l1 1M14.7 14.7l1 1M4.3 15.7l1-1M14.7 5.3l1-1',
  moon: 'M15.5 12.4A6.5 6.5 0 0 1 7.6 4.5 6.5 6.5 0 1 0 15.5 12.4Z',
  spark: 'M10 2.5l1.6 4.4 4.4 1.6-4.4 1.6L10 14.5l-1.6-4.4L4 8.5l4.4-1.6L10 2.5ZM15.5 13l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4Z',
  eye: 'M2.5 10S5 4.5 10 4.5 17.5 10 17.5 10 15 15.5 10 15.5 2.5 10 2.5 10Zm7.5 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  chevron: 'M8 5.5l4.5 4.5L8 14.5',
  refresh: 'M15.5 8A6 6 0 0 0 4.6 6.5M4.5 12a6 6 0 0 0 10.9 1.5M15.5 3.5V8H11M4.5 16.5V12H9',
  lock: 'M6 9V6.5a4 4 0 0 1 8 0V9M5.5 9h9A1.5 1.5 0 0 1 16 10.5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 15.5v-5A1.5 1.5 0 0 1 5.5 9Z',
  plug: 'M7.5 3v3.5M12.5 3v3.5M5.5 6.5h9V9a4.5 4.5 0 0 1-9 0V6.5ZM10 13.5V17',
};

export function icon(name: keyof typeof PATHS | string, size = 18): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS.spark!);
  svg.appendChild(path);
  return svg;
}
