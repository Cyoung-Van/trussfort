// 内联 SVG 线性图标（1.75px 描边，currentColor），不用图标字体、不用 emoji。

const svg = (body, cls = 'ic', vb = '0 0 24 24') =>
  `<svg class="${cls}" viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON = {
  play: svg('<path d="M8 5.6v12.8a.6.6 0 0 0 .9.5l10.2-6.4a.6.6 0 0 0 0-1L8.9 5.1a.6.6 0 0 0-.9.5z" fill="currentColor"/>'),
  pause: svg('<path d="M9 6v12M15 6v12" stroke-width="2.4"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  trash: svg('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>'),
  truss: svg('<path d="M3 19h18"/><path d="M4 19l4.5-9 4.5 9 4.5-9L21 19"/><path d="M8.5 10h9"/>'),
  move: svg('<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>'),
  erase: svg('<path d="M14 4.5l5.5 5.5-8.5 8.5H6.5l-3-3a1.4 1.4 0 0 1 0-2z"/><path d="M9 9.5l5.5 5.5"/><path d="M12 18.5h8"/>'),
  cannon: svg('<path d="M6.5 12.2l11.3-6.6 1.8 3.1-10.6 7.4"/><circle cx="9" cy="16" r="3.4"/><path d="M3 20.5h12"/>'),
  sound: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  mute: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6"/><path d="M12 17.2v.1" stroke-width="2.4"/>'),
  back: svg('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
  replay: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4v4.5H9"/>'),
  close: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  field: svg('<path d="M3 18h6l1.5-4h3L15 18h6"/><path d="M3 18V8M21 18V8"/>'),
};

// 材料色样：模仿蓝图里的线型，用深色墨水画
export const SWATCH = {
  wood: svg('<path d="M3 6h24" stroke-width="4"/>', 'sw', '0 0 30 12'),
  steel: svg('<path d="M3 3.8h24M3 8.2h24" stroke-width="1.6"/>', 'sw', '0 0 30 12'),
  rope: svg('<path d="M3 6h24" stroke-width="1.3" stroke-dasharray="3 2.6"/>', 'sw', '0 0 30 12'),
  spring: svg('<path d="M2 6h4l2-3.6 3 7.2 3-7.2 3 7.2 3-7.2 2 3.6h6" stroke-width="1.6"/>', 'sw', '0 0 30 12'),
  cannon: svg('<path d="M9 7.4l13-5 1.3 2.8-12.4 5.6"/><circle cx="10.5" cy="8.4" r="2.6"/>', 'sw', '0 0 30 12'),
};
