import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import * as d3 from 'd3';
import { motion, AnimatePresence } from 'motion/react';
import { ZoomIn, ZoomOut, Plus, Pencil, Trash2, RotateCcw, ChevronUp, ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MindMapNode } from '../types';

interface MindMapProps {
  data: MindMapNode;
  onChange?: (data: MindMapNode) => void;
  isReadOnly?: boolean;
  theme?: 'light' | 'dark';
  onThemeChange?: (theme: 'light' | 'dark') => void;
}

type FocusTarget = {
  id: string;
  scope: 'node' | 'branch';
};

const DEFAULT_ROOT_COLOR = '#6366f1';
const EXPAND_BUTTON_SIZE = 20;
const EXPAND_BUTTON_RIGHT_OFFSET = 30;
const COLLAPSED_IDS_STORAGE_KEY = 'mindflow-collapsed-ids';

// ─── Performance Helpers ───────────────────────────────────────────────────────

const PERF_THRESHOLD = 500; // Se > 500 nós, ativa modo performance

const debounce = <T extends (...args: any[]) => any>(fn: T, delay: number) => {
  let timeoutId: ReturnType<typeof setTimeout>;
  return ((...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  }) as T;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const generateId = () => `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

const findNode = (root: MindMapNode, id: string): MindMapNode | null => {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
};

const findNodeDepth = (root: MindMapNode, id: string, depth = 0): number | null => {
  if (root.id === id) return depth;
  for (const child of root.children ?? []) {
    const childDepth = findNodeDepth(child, id, depth + 1);
    if (childDepth != null) return childDepth;
  }
  return null;
};

const removeNode = (root: MindMapNode, id: string, parentDepth = 0): boolean => {
  if (!root.children) return false;
  const idx = root.children.findIndex(c => c.id === id);
  if (idx !== -1) {
    const removedNode = root.children[idx];
    const promotedChildren = removedNode.children ?? [];

    if (parentDepth === 0 && removedNode.color) {
      promotedChildren.forEach(child => {
        if (!child.color) {
          child.color = removedNode.color;
        }
      });
    }

    root.children.splice(idx, 1, ...promotedChildren);
    if (root.children.length === 0) delete root.children;
    return true;
  }
  for (const child of root.children) {
    if (removeNode(child, id, parentDepth + 1)) return true;
  }
  return false;
};

const moveNodeWithinSiblings = (root: MindMapNode, id: string, direction: 'up' | 'down'): boolean => {
  if (!root.children?.length) return false;

  const currentIndex = root.children.findIndex(child => child.id === id);
  if (currentIndex !== -1) {
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= root.children.length) return false;

    const [movedNode] = root.children.splice(currentIndex, 1);
    root.children.splice(targetIndex, 0, movedNode);
    return true;
  }

  for (const child of root.children) {
    if (moveNodeWithinSiblings(child, id, direction)) return true;
  }

  return false;
};

const countNodes = (node: MindMapNode): number => {
  return 1 + (node.children?.reduce((sum, child) => sum + countNodes(child), 0) ?? 0);
};

const collectCollapsedNodeIds = (node: MindMapNode, collapsed = new Set<string>()): Set<string> => {
  if (node.children?.length) {
    if (node.id) {
      collapsed.add(node.id);
    }
    node.children.forEach(child => collectCollapsedNodeIds(child, collapsed));
  }
  return collapsed;
};

const filterCollapsedNodeIds = (collapsedIds: Iterable<string>, node: MindMapNode): Set<string> => {
  const expandableNodeIds = collectCollapsedNodeIds(node);
  const next = new Set<string>();
  for (const id of collapsedIds) {
    if (expandableNodeIds.has(id)) {
      next.add(id);
    }
  }
  return next;
};

let textMeasureCanvas: HTMLCanvasElement | null = null;
let textMeasureContext: CanvasRenderingContext2D | null = null;

const getTextMeasureContext = (): CanvasRenderingContext2D | null => {
  if (typeof document === 'undefined') return null;
  if (textMeasureContext) return textMeasureContext;

  textMeasureCanvas = document.createElement('canvas');
  textMeasureContext = textMeasureCanvas.getContext('2d');
  return textMeasureContext;
};

const measureTextWidth = (text: string, font: string, fallbackFactor: number): number => {
  if (!text) return 0;
  const ctx = getTextMeasureContext();
  if (!ctx) return text.length * fallbackFactor;
  ctx.font = font;
  return Math.ceil(ctx.measureText(text).width);
};

const getCardPaddingX = (depth: number): number => {
  if (depth === 0) return 18;
  if (depth === 1) return 16;
  return 14;
};

const getCardPaddingY = (depth: number): number => {
  if (depth === 0) return 11;
  return 8;
};

const getContentInsetX = (depth: number): number => {
  if (depth === 0) return 4;
  return 3;
};

const getContentInsetRight = (depth: number): number => {
  if (depth === 0) return 10;
  return 8;
};

const getCardWidth = (depth: number): number => {
  if (depth === 0) return 220;
  if (depth === 1) return 196;
  return 196;
};

const estimateWrappedLineCount = (
  text: string,
  font: string,
  maxWidth: number,
  fallbackFactor: number
): number => {
  const normalizedText = text.trim();
  if (!normalizedText) return 1;

  const segments = normalizedText.split('\n');
  let lines = 0;

  const measureChunk = (chunk: string) => measureTextWidth(chunk, font, fallbackFactor);

  const countWordLines = (segment: string): number => {
    const words = segment.split(/\s+/).filter(Boolean);
    if (words.length === 0) return 1;

    let lineCount = 1;
    let currentLine = '';

    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (measureChunk(candidate) <= maxWidth) {
        currentLine = candidate;
        continue;
      }

      if (!currentLine) {
        let chunk = '';
        for (const char of word) {
          const candidateChunk = `${chunk}${char}`;
          if (chunk && measureChunk(candidateChunk) > maxWidth) {
            lineCount += 1;
            chunk = char;
            continue;
          }
          chunk = candidateChunk;
        }
        currentLine = chunk;
        continue;
      }

      lineCount += 1;
      currentLine = word;
      if (measureChunk(currentLine) <= maxWidth) continue;

      let chunk = '';
      for (const char of word) {
        const candidateChunk = `${chunk}${char}`;
        if (chunk && measureChunk(candidateChunk) > maxWidth) {
          lineCount += 1;
          chunk = char;
          continue;
        }
        chunk = candidateChunk;
      }
      currentLine = chunk;
    }

    return lineCount;
  };

  for (const segment of segments) {
    lines += countWordLines(segment);
  }

  return lines;
};

const getMarkdownTextForLayout = (markdown: string): string => (
  markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, '').trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
);

const estimateCardWidth = (node: MindMapNode, depth: number): number => {
  return getCardWidth(depth);
};

const getExpandButtonAnchorY = (node: { y: number; depth: number; data: MindMapNode }): number => {
  const cardWidth = estimateCardWidth(node.data, node.depth);
  return node.y + cardWidth - (EXPAND_BUTTON_RIGHT_OFFSET - EXPAND_BUTTON_SIZE / 2);
};

const getExpandButtonLinkStartY = (node: { y: number; depth: number; data: MindMapNode }): number => {
  return getExpandButtonAnchorY(node) + EXPAND_BUTTON_SIZE / 2;
};

const estimateCardHeight = (node: MindMapNode, depth: number): number => {
  const cardWidth = estimateCardWidth(node, depth);
  const px = getCardPaddingX(depth);
  const contentInsetX = getContentInsetX(depth);
  const contentInsetRight = getContentInsetRight(depth);
  const contentMaxWidth = Math.max(cardWidth - px * 2 - contentInsetX - contentInsetRight, 80);
  const hasContent = Boolean(node.content?.trim());
  const titleFont = depth === 0
    ? '700 14px system-ui, sans-serif'
    : '600 13px system-ui, sans-serif';
  const titleLines = estimateWrappedLineCount(
    node.title ?? '',
    titleFont,
    contentMaxWidth,
    depth === 0 ? 8.4 : 7.2
  );
  const titleLineHeight = depth === 0 ? 18 : 17;
  const titleHeight = Math.max(titleLines, 1) * titleLineHeight;
  const plainContent = hasContent ? getMarkdownTextForLayout(node.content ?? '') : '';
  const contentLines = hasContent
    ? estimateWrappedLineCount(plainContent, '400 11px system-ui, sans-serif', contentMaxWidth, 6.4)
    : 0;
  const contentHeight = hasContent ? Math.min(contentLines, 6) * 18 + 12 : 0;
  const verticalPadding = depth === 0 ? 28 : 20;
  return titleHeight + contentHeight + verticalPadding;
};

const createMarkdownComponents = (textColor: string, subtleColor: string) => ({
  p: ({ children }: any) => <p style={{ margin: 0 }}>{children}</p>,
  strong: ({ children }: any) => <strong style={{ fontWeight: 700 }}>{children}</strong>,
  em: ({ children }: any) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
  del: ({ children }: any) => <del style={{ opacity: 0.85 }}>{children}</del>,
  a: ({ href, children }: any) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      style={{ color: textColor, textDecoration: 'underline', textUnderlineOffset: 2, fontWeight: 600 }}
    >
      {children}
    </a>
  ),
  ul: ({ children }: any) => (
    <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
      {children}
    </ul>
  ),
  ol: ({ children }: any) => (
    <ol style={{ margin: '4px 0 0', paddingLeft: 16 }}>
      {children}
    </ol>
  ),
  li: ({ children }: any) => (
    <li style={{ margin: '2px 0' }}>
      {children}
    </li>
  ),
  blockquote: ({ children }: any) => (
    <blockquote
      style={{
        margin: '4px 0 0',
        paddingLeft: 8,
        borderLeft: `2px solid ${subtleColor}`,
        opacity: 0.92,
      }}
    >
      {children}
    </blockquote>
  ),
  code: ({ inline, children }: any) => (
    inline ? (
      <code
        style={{
          background: 'rgba(0,0,0,0.12)',
          borderRadius: 4,
          padding: '0 4px',
          fontSize: '0.95em',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        }}
      >
        {children}
      </code>
    ) : (
      <code
        style={{
          display: 'block',
          whiteSpace: 'pre-wrap',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        }}
      >
        {children}
      </code>
    )
  ),
  pre: ({ children }: any) => (
    <pre
      style={{
        margin: '4px 0 0',
        padding: '6px 8px',
        borderRadius: 8,
        background: 'rgba(0,0,0,0.12)',
        overflowX: 'auto',
      }}
    >
      {children}
    </pre>
  ),
  h1: ({ children }: any) => <p style={{ margin: 0, fontWeight: 700, fontSize: '1.05em' }}>{children}</p>,
  h2: ({ children }: any) => <p style={{ margin: 0, fontWeight: 700 }}>{children}</p>,
  h3: ({ children }: any) => <p style={{ margin: 0, fontWeight: 700 }}>{children}</p>,
  hr: () => <hr style={{ margin: '6px 0', border: 0, borderTop: `1px solid ${subtleColor}` }} />,
  table: ({ children }: any) => (
    <table
      style={{
        width: '100%',
        marginTop: 4,
        borderCollapse: 'collapse',
        fontSize: '0.95em',
      }}
    >
      {children}
    </table>
  ),
  th: ({ children }: any) => (
    <th style={{ textAlign: 'left', borderBottom: `1px solid ${subtleColor}`, padding: '2px 4px' }}>
      {children}
    </th>
  ),
  td: ({ children }: any) => (
    <td style={{ borderBottom: `1px solid ${subtleColor}`, padding: '2px 4px', verticalAlign: 'top' }}>
      {children}
    </td>
  ),
});

const estimateSubtreeWeight = (node: MindMapNode): number => {
  const children = node.children ?? [];
  if (children.length === 0) return 1;
  return children.reduce((sum, child) => sum + estimateSubtreeWeight(child), 0);
};

const getCubicBezierPoint = (
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  t: number
): [number, number] => {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  const x = mt2 * mt * p0[0]
    + 3 * mt2 * t * p1[0]
    + 3 * mt * t2 * p2[0]
    + t2 * t * p3[0];
  const y = mt2 * mt * p0[1]
    + 3 * mt2 * t * p1[1]
    + 3 * mt * t2 * p2[1]
    + t2 * t * p3[1];
  return [x, y];
};

const getInheritedBranchColor = (
  node: d3.HierarchyPointNode<MindMapNode>,
  rootColor: string
): string => {
  if (node.depth === 0) return rootColor;

  let current = node;
  while (current.depth > 1 && current.parent) {
    current = current.parent;
  }

  return current.depth === 1 ? (current.data.color ?? rootColor) : rootColor;
};

const estimateCardBounds = (node: { data: MindMapNode; depth: number; x: number; y: number }) => {
  const width = estimateCardWidth(node.data, node.depth);
  const height = estimateCardHeight(node.data, node.depth);
  return {
    left: node.y,
    right: getExpandButtonAnchorY(node) + 20,
    top: node.x - height / 2,
    bottom: node.x + height / 2,
    width,
    height,
  };
};

const getContrastColor = (hexColor: string): string => {
  const hex = hexColor.replace('#', '');
  if (hex.length !== 6 && hex.length !== 3) return '#000000';
  const fullHex = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
  const r = parseInt(fullHex.substr(0, 2), 16);
  const g = parseInt(fullHex.substr(2, 2), 16);
  const b = parseInt(fullHex.substr(4, 2), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1f2937' : '#ffffff';
};

// ─── Palette ──────────────────────────────────────────────────────────────────

// ─── Theme tokens ─────────────────────────────────────────────────────────────

const THEMES = {
  light: {
    canvasBg: '#F7F6F3', dotColor: '#C9C5BE',
    rootBg: '#1C1917', rootText: '#FFFFFF', rootShadow: '0 6px 24px rgba(0,0,0,0.28)',
    leafBg: '#FFFFFF', leafText: '#1C1917', leafShadow: '0 2px 8px rgba(0,0,0,0.09)',
    leafContentColor: '#6B6863',
    editTitleColor: '#1C1917', editContentColor: '#6B6863', editPlaceholder: '#B0ACA6',
    inputBorderColored: 'rgba(255,255,255,0.35)', inputBorderLeaf: 'rgba(0,0,0,0.15)',
    cancelBg: 'rgba(0,0,0,0.07)', cancelColor: '#1C1917',
    hexLabelColor: 'rgba(0,0,0,0.35)',
    collapseBg: '#FFFFFF', collapseShadow: '0 1px 5px rgba(0,0,0,0.14)', collapseNeutralBorder: '#B8B4AD', collapseNeutralDot: '#B8B4AD',
    linkNeutral: '#D1CEC7',
    chromeBg: '#FFFFFF', chromeBorder: 'rgba(0,0,0,0.10)', chromeShadow: '0 2px 10px rgba(0,0,0,0.10)', chromeColor: '#6B6863', chromeHover: '#F0EDE8', chromeDivider: 'rgba(0,0,0,0.07)',
  },
  dark: {
    canvasBg: '#141416', dotColor: '#252529',
    rootBg: '#FFFFFF', rootText: '#1C1917', rootShadow: '0 6px 28px rgba(0,0,0,0.60)',
    leafBg: '#1E1E22', leafText: '#ECEAE4', leafShadow: '0 2px 10px rgba(0,0,0,0.40)',
    leafContentColor: '#A09D98',
    editTitleColor: '#ECEAE4', editContentColor: '#A09D98', editPlaceholder: '#4A4A52',
    inputBorderColored: 'rgba(255,255,255,0.30)', inputBorderLeaf: 'rgba(255,255,255,0.18)',
    cancelBg: 'rgba(255,255,255,0.08)', cancelColor: '#ECEAE4',
    hexLabelColor: 'rgba(255,255,255,0.35)',
    collapseBg: '#1E1E22', collapseShadow: '0 1px 6px rgba(0,0,0,0.45)', collapseNeutralBorder: '#3E3E45', collapseNeutralDot: '#4A4A52',
    linkNeutral: '#2E2E36',
    chromeBg: '#252528', chromeBorder: 'rgba(255,255,255,0.10)', chromeShadow: '0 2px 14px rgba(0,0,0,0.50)', chromeColor: '#9A9895', chromeHover: '#2E2E33', chromeDivider: 'rgba(255,255,255,0.07)',
  },
} as const;

type ThemeKey = keyof typeof THEMES;

// ─── Toolbar button ───────────────────────────────────────────────────────────

const ToolbarBtn: React.FC<{
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
  label?: string;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ onClick, danger, label, disabled, children }) => (
  <button
    onMouseDown={e => { e.stopPropagation(); e.preventDefault(); }}
    onClick={e => {
      e.stopPropagation();
      if (disabled) return;
      onClick(e);
    }}
    title={label}
    disabled={disabled}
    style={{
      display: 'flex', alignItems: 'center', gap: 4,
      padding: label ? '4px 8px' : '4px 6px',
      borderRadius: 6, border: 'none',
      background: 'transparent', color: 'white',
      cursor: disabled ? 'default' : 'pointer', fontSize: 12, fontWeight: 500,
      transition: 'background 0.1s',
      opacity: disabled ? 0.35 : 1,
    }}
    onMouseEnter={e => {
      if (disabled) return;
      e.currentTarget.style.background = danger ? 'rgba(220,38,38,0.55)' : 'rgba(255,255,255,0.14)';
    }}
    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
  >
    {children}
    {label && <span>{label}</span>}
  </button>
);

// ─── Color utilities ──────────────────────────────────────────────────────────

function hexToHsv(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = h / 6;
  }
  return [h, max ? d / max : 0, max];
}

function hsvToHex(h: number, s: number, v: number): string {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: r=v; g=t; b=p; break; case 1: r=q; g=v; b=p; break;
    case 2: r=p; g=v; b=t; break; case 3: r=p; g=q; b=v; break;
    case 4: r=t; g=p; b=v; break; case 5: r=v; g=p; b=q; break;
  }
  return '#' + [r, g, b].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

// ─── ColorPrism ───────────────────────────────────────────────────────────────

const ColorPrism: React.FC<{
  value: string | null;
  defaultColor: string;
  onChange: (hex: string | null) => void;
  hasLightText: boolean;
  inputBorder: string;
  editTitleClr: string;
  hexLabelClr: string;
}> = ({ value, defaultColor, onChange, hasLightText, inputBorder, editTitleClr, hexLabelClr }) => {
  const active = value ?? defaultColor;
  const [hsv, setHsv] = React.useState<[number, number, number]>(() => hexToHsv(active));
  const [hexInput, setHexInput] = React.useState((active).replace('#', ''));
  const sbRef = useRef<HTMLCanvasElement>(null);
  const hueRef = useRef<HTMLCanvasElement>(null);
  const draggingSb = useRef(false);
  const draggingHue = useRef(false);

  React.useEffect(() => {
    const h = hexToHsv(active);
    setHsv(h);
    setHexInput(active.replace('#', ''));
  }, [active]);

  React.useEffect(() => {
    const cv = sbRef.current; if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const W = cv.width, H = cv.height;
    const gH = ctx.createLinearGradient(0, 0, W, 0);
    gH.addColorStop(0, 'white');
    gH.addColorStop(1, hsvToHex(hsv[0], 1, 1));
    ctx.fillStyle = gH; ctx.fillRect(0, 0, W, H);
    const gV = ctx.createLinearGradient(0, 0, 0, H);
    gV.addColorStop(0, 'rgba(0,0,0,0)');
    gV.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = gV; ctx.fillRect(0, 0, W, H);
  }, [hsv[0]]);

  React.useEffect(() => {
    const cv = hueRef.current; if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, cv.width, 0);
    [0,1/6,2/6,3/6,4/6,5/6,1].forEach((s, i) => g.addColorStop(s, `hsl(${i*60},100%,50%)`));
    ctx.fillStyle = g; ctx.fillRect(0, 0, cv.width, cv.height);
  }, []);

  const commit = (h: number, s: number, v: number) => {
    setHsv([h, s, v]);
    const hex = hsvToHex(h, s, v);
    setHexInput(hex.replace('#', ''));
    onChange(hex);
  };

  const handleSbPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!draggingSb.current) return;
    const cv = sbRef.current!;
    const rect = cv.getBoundingClientRect();
    const s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    commit(hsv[0], s, v);
  };

  const handleHuePointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!draggingHue.current) return;
    const cv = hueRef.current!;
    const rect = cv.getBoundingClientRect();
    const h = Math.max(0, Math.min(0.9999, (e.clientX - rect.left) / rect.width));
    commit(h, hsv[1], hsv[2]);
  };

  const sbCursorX = hsv[1] * 100;
  const sbCursorY = (1 - hsv[2]) * 100;
  const hueCursorX = hsv[0] * 100;
  const borderAlpha = hasLightText ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.12)';

  return (
    <div
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4, width: '100%' }}
    >
      <div style={{ position: 'relative', width: '100%', height: 110, borderRadius: 6, overflow: 'hidden', border: `1px solid ${borderAlpha}` }}>
        <canvas
          ref={sbRef}
          width={200} height={110}
          style={{ width: '100%', height: '100%', display: 'block', cursor: 'crosshair' }}
          onPointerDown={e => { draggingSb.current = true; e.currentTarget.setPointerCapture(e.pointerId); handleSbPointer(e); }}
          onPointerMove={handleSbPointer}
          onPointerUp={() => { draggingSb.current = false; }}
        />
        <div style={{
          position: 'absolute',
          left: `${sbCursorX}%`, top: `${sbCursorY}%`,
          transform: 'translate(-50%, -50%)',
          width: 12, height: 12, borderRadius: '50%',
          border: '2px solid white',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.3)',
          pointerEvents: 'none',
          background: hsvToHex(hsv[0], hsv[1], hsv[2]),
        }} />
      </div>

      <div style={{ position: 'relative', width: '100%', height: 12, borderRadius: 6, overflow: 'hidden', border: `1px solid ${borderAlpha}` }}>
        <canvas
          ref={hueRef}
          width={200} height={12}
          style={{ width: '100%', height: '100%', display: 'block', cursor: 'ew-resize' }}
          onPointerDown={e => { draggingHue.current = true; e.currentTarget.setPointerCapture(e.pointerId); handleHuePointer(e); }}
          onPointerMove={handleHuePointer}
          onPointerUp={() => { draggingHue.current = false; }}
        />
        <div style={{
          position: 'absolute',
          left: `${hueCursorX}%`, top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 14, height: 14, borderRadius: '50%',
          border: '2px solid white',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.25)',
          pointerEvents: 'none',
          background: hsvToHex(hsv[0], 1, 1),
        }} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{
          width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
          background: active,
          border: `1.5px solid ${hasLightText ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.15)'}`,
        }} />
        <span style={{ fontSize: 10, color: hexLabelClr, userSelect: 'none' }}>#</span>
        <input
          value={hexInput}
          onChange={e => {
            const raw = e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
            setHexInput(raw);
            if (raw.length === 6) {
              const hex = '#' + raw;
              onChange(hex);
              setHsv(hexToHsv(hex));
            } else if (raw.length === 0) {
              onChange(null);
            }
          }}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          placeholder="ex: 7B61FF"
          maxLength={6}
          spellCheck={false}
          style={{
            background: 'transparent', border: 'none', outline: 'none',
            borderBottom: `1px solid ${inputBorder}`,
            color: editTitleClr, fontSize: 11, fontFamily: 'monospace',
            width: 72, letterSpacing: '0.05em', paddingBottom: 1,
          }}
        />
        {value && (
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onChange(null); }}
            title="Cor padrão"
            style={{
              marginLeft: 'auto', padding: '2px 4px', borderRadius: 4, cursor: 'pointer',
              background: 'transparent', border: `1px solid ${borderAlpha}`,
              color: editTitleClr, display: 'flex', alignItems: 'center',
            }}
          >
            <RotateCcw size={10} />
          </button>
        )}
      </div>
    </div>
  );
};

// ─── Memoized Node Component ───────────────────────────────────────────────────

interface NodeProps {
  node: any;
  isRoot: boolean;
  isSelected: boolean;
  isEditing: boolean;
  isReadOnly: boolean;
  isCollapsed: boolean;
  childCount: number;
  selectedId: string | null;
  editingId: string | null;
  resolvedAccent: string | null;
  baseBranchColor: string | null;
  customColor: string | null;
  bIdx: number | null;
  isDark: boolean;
  t: any;
  textColor: string;
  bg: string;
  nodeBorder: string;
  nodeShadow: string;
  onSelect: (id: string) => void;
  onEdit: (node: any, accent?: { hasLightText: boolean; branchColor: string }) => void;
  onDelete: (id: string) => void;
  onAddChild: (id: string) => void;
  onMoveNode: (id: string, direction: 'up' | 'down') => void;
  onToggleCollapse: (id: string) => void;
  hasLightText: boolean;
  animationEnabled: boolean;
}

const NodeComponent = React.memo<NodeProps>(({
  node, isRoot, isSelected, isEditing, isReadOnly, childCount,
  onSelect, onEdit, onDelete, onAddChild, onMoveNode, onToggleCollapse,
  baseBranchColor, customColor, isDark, t, textColor, bg, nodeBorder, nodeShadow,
  isCollapsed, hasLightText, animationEnabled, resolvedAccent,
}) => {
  const borderRadius = isRoot ? 14 : 10;
  const px = getCardPaddingX(node.depth);
  const py = getCardPaddingY(node.depth);
  const contentInsetX = getContentInsetX(node.depth);
  const contentInsetRight = getContentInsetRight(node.depth);
  const cardWidth = estimateCardWidth(node.data, node.depth);
  const contentMaxWidth = Math.max(cardWidth - px * 2 - contentInsetX - contentInsetRight, 80);
  const siblingIndex = node.parent?.children?.findIndex((child: any) => child.data.id === node.data.id) ?? -1;
  const siblingCount = node.parent?.children?.length ?? 0;
  const canMoveUp = !isRoot && siblingIndex > 0;
  const canMoveDown = !isRoot && siblingIndex >= 0 && siblingIndex < siblingCount - 1;

  const initialProps = animationEnabled
    ? { opacity: 0, scale: 0.55, x: node.parent?.y ?? node.y, y: node.parent?.x ?? node.x }
    : { opacity: 1, scale: 1, x: node.y, y: node.x };

  const animateProps = { opacity: 1, scale: 1, x: node.y, y: node.x };
  const exitProps = animationEnabled ? { opacity: 0, scale: 0.4 } : { opacity: 1, scale: 1 };

  return (
    <motion.g
      key={node.data.id}
      initial={initialProps}
      animate={animateProps}
      exit={exitProps}
      transition={animationEnabled ? { type: 'spring', damping: 28, stiffness: 240, mass: 0.7 } : { duration: 0 }}
    >
      <foreignObject
        width="380" height="360" x="-10" y="-180"
        style={{ overflow: 'visible' }}
      >
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', paddingLeft: 10, position: 'relative', pointerEvents: 'none' }}>

          {isSelected && !isEditing && !isReadOnly && (
            <div
              data-interactive="true"
              onMouseDown={e => e.stopPropagation()}
              style={{
                position: 'absolute', bottom: 'calc(50% + 32px)', left: 10,
                display: 'flex', alignItems: 'center', gap: 1,
                background: '#1C1917', border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 10, padding: '3px 5px', zIndex: 999,
                boxShadow: 'none',
                pointerEvents: 'auto', whiteSpace: 'nowrap',
              }}
            >
              <ToolbarBtn onClick={() => onAddChild(node.data.id!)} label="Adicionar">
                <Plus size={12} />
              </ToolbarBtn>
              <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.14)', margin: '0 3px' }} />
              {!isRoot && (
                <>
                  <ToolbarBtn onClick={() => onMoveNode(node.data.id!, 'up')} label="Subir" disabled={!canMoveUp}>
                    <ChevronUp size={13} />
                  </ToolbarBtn>
                  <ToolbarBtn onClick={() => onMoveNode(node.data.id!, 'down')} label="Descer" disabled={!canMoveDown}>
                    <ChevronDown size={13} />
                  </ToolbarBtn>
                  <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.14)', margin: '0 3px' }} />
                </>
              )}
              <ToolbarBtn onClick={() => onEdit(node.data, { hasLightText, branchColor: baseBranchColor ?? DEFAULT_ROOT_COLOR })}>
                <Pencil size={13} />
              </ToolbarBtn>
              {!isRoot && (
                <ToolbarBtn onClick={() => onDelete(node.data.id!)} danger>
                  <Trash2 size={13} />
                </ToolbarBtn>
              )}
            </div>
          )}

          <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', pointerEvents: 'auto' }} data-interactive="true">
            <div
              data-card="true"
              style={{
                background: bg, color: textColor, border: nodeBorder, boxShadow: nodeShadow,
                borderRadius, padding: `${py}px ${px}px`,
                cursor: 'pointer',
                transition: 'background 0.25s, box-shadow 0.15s',
                transform: isRoot ? 'scale(1.06)' : undefined,
                width: cardWidth,
                maxWidth: cardWidth, minWidth: cardWidth,
                outline: isEditing ? `2px solid ${resolvedAccent ?? '#0090FF'}` : 'none',
                outlineOffset: 2,
              }}
              onClick={e => {
                e.stopPropagation();
                onSelect(node.data.id!);
              }}
              onDoubleClick={e => {
                e.stopPropagation();
                if (isReadOnly) return;
                onEdit(node.data, { hasLightText, branchColor: baseBranchColor ?? DEFAULT_ROOT_COLOR });
              }}
            >
              <div style={{
                width: '100%',
                boxSizing: 'border-box',
                paddingLeft: contentInsetX,
                paddingRight: contentInsetRight,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                textAlign: 'left',
              }}>
                <div style={{
                  fontSize: isRoot ? 14 : 13,
                  fontWeight: isRoot ? 700 : 600,
                  whiteSpace: 'normal',
                  overflowWrap: 'anywhere',
                  lineHeight: 1.3,
                  width: '100%',
                  maxWidth: '100%',
                  textAlign: 'left',
                }}>
                  {node.data.title}
                </div>
                {node.data.content && (
                  <div style={{
                    marginTop: 4,
                    fontSize: 11,
                    lineHeight: 1.55,
                    color: hasLightText ? 'rgba(255,255,255,0.82)' : t.leafContentColor,
                    maxWidth: contentMaxWidth,
                    whiteSpace: 'normal',
                    width: '100%',
                    textAlign: 'left',
                  }}>
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={createMarkdownComponents(
                        textColor,
                        hasLightText ? 'rgba(255,255,255,0.28)' : 'rgba(24,24,27,0.16)'
                      )}
                    >
                      {node.data.content}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            </div>

            {childCount > 0 && !isEditing && (
              <button
                onMouseDown={e => { e.stopPropagation(); e.preventDefault(); }}
                onClick={e => { e.stopPropagation(); onToggleCollapse(node.data.id!); }}
                title={isCollapsed ? 'Expandir' : 'Recolher'}
                style={{
                  position: 'absolute', right: -EXPAND_BUTTON_RIGHT_OFFSET, top: '50%',
                  transform: 'translateY(-50%)',
                  width: EXPAND_BUTTON_SIZE, height: EXPAND_BUTTON_SIZE, borderRadius: '50%',
                  border: `2.5px solid ${resolvedAccent ?? t.collapseNeutralBorder}`,
                  background: isCollapsed ? (resolvedAccent ?? baseBranchColor ?? DEFAULT_ROOT_COLOR) : t.collapseBg,
                  color: isCollapsed ? 'white' : (resolvedAccent ?? t.collapseNeutralDot),
                  fontSize: 8, fontWeight: 800,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', boxShadow: 'none',
                  transition: 'all 0.18s ease', zIndex: 10,
                }}
              >
                {isCollapsed
                  ? <span style={{ fontSize: 8, fontWeight: 800, lineHeight: 1 }}>{childCount}</span>
                  : <div style={{ width: 6, height: 6, borderRadius: '50%', background: resolvedAccent ?? t.collapseNeutralDot }} />
                }
              </button>
            )}
          </div>
        </div>
      </foreignObject>
    </motion.g>
  );
}, (prev, next) => {
  // Shallow comparison para evitar re-render
  return (
    prev.isSelected === next.isSelected &&
    prev.isEditing === next.isEditing &&
    prev.isReadOnly === next.isReadOnly &&
    prev.isCollapsed === next.isCollapsed &&
    prev.node.data.id === next.node.data.id &&
    prev.node.x === next.node.x &&
    prev.node.y === next.node.y &&
    prev.node.data.title === next.node.data.title &&
    prev.node.data.content === next.node.data.content &&
    prev.customColor === next.customColor &&
    prev.bg === next.bg &&
    prev.textColor === next.textColor &&
    prev.nodeBorder === next.nodeBorder &&
    prev.nodeShadow === next.nodeShadow &&
    prev.resolvedAccent === next.resolvedAccent &&
    prev.childCount === next.childCount &&
    prev.isDark === next.isDark
  );
});

NodeComponent.displayName = 'NodeComponent';

// ─── Main component ───────────────────────────────────────────────────────────

const MindMap: React.FC<MindMapProps> = ({
  data, onChange, isReadOnly = false,
  theme: themeProp, onThemeChange,
}) => {
  const totalNodes = useMemo(() => countNodes(data), [data]);
  const performanceMode = totalNodes > PERF_THRESHOLD;

  const [internalTheme, setInternalTheme] = useState<ThemeKey>(themeProp ?? 'light');

  useEffect(() => {
    if (themeProp) {
      setInternalTheme(themeProp);
      return;
    }
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const syncTheme = () => {
      const nextTheme: ThemeKey =
        document.documentElement.classList.contains('dark') || mediaQuery.matches ? 'dark' : 'light';
      setInternalTheme(nextTheme);
    };
    syncTheme();
    const mediaListener = () => syncTheme();
    const observer = new MutationObserver(() => syncTheme());
    mediaQuery.addEventListener('change', mediaListener);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      mediaQuery.removeEventListener('change', mediaListener);
      observer.disconnect();
    };
  }, [themeProp]);

  const activeTheme: ThemeKey = themeProp ?? internalTheme;
  const t = THEMES[activeTheme];
  const isDark = activeTheme === 'dark';
  const rootColor = data.color ?? DEFAULT_ROOT_COLOR;

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => {
    const defaultCollapsedIds = collectCollapsedNodeIds(data);
    if (typeof window === 'undefined') return defaultCollapsedIds;

    try {
      const savedCollapsedIds = localStorage.getItem(COLLAPSED_IDS_STORAGE_KEY);
      if (!savedCollapsedIds) return defaultCollapsedIds;

      const parsedCollapsedIds = JSON.parse(savedCollapsedIds);
      if (!Array.isArray(parsedCollapsedIds)) return defaultCollapsedIds;

      return filterCollapsedNodeIds(parsedCollapsedIds, data);
    } catch {
      return defaultCollapsedIds;
    }
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const pendingFocusTargetRef = useRef<FocusTarget | null>(null);
  const [hoveredLinkId, setHoveredLinkId] = useState<string | null>(null);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editColor, setEditColor] = useState<string | null>(null);
  const [editNodeAccent, setEditNodeAccent] = useState<{ branchColor: string }>({ branchColor: rootColor });
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isReadOnly) return;
    setSelectedId(null);
    setEditingId(null);
  }, [isReadOnly]);

  useEffect(() => {
    setCollapsedIds(prev => {
      const next = filterCollapsedNodeIds(prev, data);
      if (next.size === prev.size && [...next].every(id => prev.has(id))) {
        return prev;
      }
      return next;
    });
  }, [data]);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_IDS_STORAGE_KEY, JSON.stringify([...collapsedIds]));
  }, [collapsedIds]);

  // ── CRUD ────────────────────────────────────────────────────────────────────

  const handleAddChild = useCallback((parentId: string) => {
    if (isReadOnly) return;
    const newData = JSON.parse(JSON.stringify(data));
    const parent = findNode(newData, parentId);
    if (!parent) return;
    if (!parent.children) parent.children = [];
    const newId = generateId();
    parent.children.push({ id: newId, title: 'Nova ideia' });
    pendingFocusTargetRef.current = { id: newId, scope: 'node' };
    onChange?.(newData);
    setCollapsedIds(prev => { const n = new Set(prev); n.delete(parentId); return n; });
    setSelectedId(null);
    setTimeout(() => {
      setEditingId(newId);
      setEditTitle('Nova ideia');
      setEditContent('');
      setEditColor(null);
      setTimeout(() => { editInputRef.current?.focus(); editInputRef.current?.select(); }, 80);
    }, 120);
  }, [data, isReadOnly, onChange]);

  const handleInsertNodeBetween = useCallback((sourceId: string, targetId: string, targetDepth: number) => {
    if (isReadOnly) return;
    const newData = JSON.parse(JSON.stringify(data));
    const source = findNode(newData, sourceId);
    if (!source?.children?.length) return;

    const targetIndex = source.children.findIndex(child => child.id === targetId);
    if (targetIndex === -1) return;

    const originalTarget = source.children[targetIndex];
    const transferredColor = targetDepth === 1 ? (originalTarget.color ?? null) : null;
    const newId = generateId();
    const insertedNode: MindMapNode = {
      id: newId,
      title: 'Nova ideia',
      children: [originalTarget],
    };

    if (transferredColor) {
      insertedNode.color = transferredColor;
      delete originalTarget.color;
    }

    source.children.splice(targetIndex, 1, insertedNode);
    pendingFocusTargetRef.current = { id: newId, scope: 'node' };
    onChange?.(newData);
    setCollapsedIds(prev => {
      const next = new Set(prev);
      next.delete(sourceId);
      next.delete(newId);
      return next;
    });
    setHoveredLinkId(null);
    setSelectedId(null);
    setTimeout(() => {
      setEditingId(newId);
      setEditTitle('Nova ideia');
      setEditContent('');
      setEditColor(transferredColor);
      setTimeout(() => { editInputRef.current?.focus(); editInputRef.current?.select(); }, 80);
    }, 120);
  }, [data, isReadOnly, onChange]);

  const handleDelete = useCallback((id: string) => {
    if (isReadOnly || id === data.id) return;
    const newData = JSON.parse(JSON.stringify(data));
    removeNode(newData, id);
    onChange?.(newData);
    setCollapsedIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setSelectedId(null);
  }, [data, isReadOnly, onChange]);

  const handleMoveNode = useCallback((id: string, direction: 'up' | 'down') => {
    if (isReadOnly || id === data.id) return;
    const newData = JSON.parse(JSON.stringify(data));
    const moved = moveNodeWithinSiblings(newData, id, direction);
    if (!moved) return;

    pendingFocusTargetRef.current = { id, scope: 'node' };
    onChange?.(newData);
    setSelectedId(id);
  }, [data, isReadOnly, onChange]);

  const startEdit = useCallback((node: MindMapNode, accent?: { hasLightText: boolean; branchColor: string }) => {
    if (isReadOnly) return;
    const isRootNode = node.id === data.id;
    setEditingId(node.id!);
    setEditTitle(node.title);
    setEditContent(node.content || '');
    setEditColor(isRootNode ? (node.color ?? rootColor) : (node.color ?? null));
    setEditNodeAccent({ branchColor: accent?.branchColor ?? rootColor });
    setTimeout(() => { editInputRef.current?.focus(); editInputRef.current?.select(); }, 60);
  }, [data.id, isReadOnly, rootColor]);

  const saveEdit = useCallback(() => {
    if (!editingId) return;
    const editingNodeDepth = findNodeDepth(data, editingId);
    pendingFocusTargetRef.current = { id: editingId, scope: 'node' };
    const newData = JSON.parse(JSON.stringify(data));
    const node = findNode(newData, editingId);
    if (node) {
      node.title = editTitle.trim() || 'Sem título';
      if (editContent.trim()) node.content = editContent; else delete node.content;
      if (editingNodeDepth === 0) {
        const nextRootColor = editColor ?? DEFAULT_ROOT_COLOR;
        node.color = nextRootColor;
        if (nextRootColor.toLowerCase() !== rootColor.toLowerCase()) {
          for (const child of newData.children ?? []) {
            if (child.color?.toLowerCase() === rootColor.toLowerCase()) {
              delete child.color;
            }
          }
        }
      } else if (editingNodeDepth === 1 && editColor && editColor.toLowerCase() !== rootColor.toLowerCase()) {
        node.color = editColor;
      } else {
        if (editingId !== data.id) {
          delete node.color;
        }
      }
    }
    onChange?.(newData);
    setEditingId(null);
  }, [editingId, editTitle, editContent, editColor, data, onChange, rootColor]);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  const toggleCollapse = useCallback((id: string) => {
    pendingFocusTargetRef.current = { id, scope: 'branch' };
    setCollapsedIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);

  // ── D3 layout (otimizado com cache) ────────────────────────────────────────

  const { nodes, links, branchIndexMap } = useMemo(() => {
    const root = d3.hierarchy(data, d => collapsedIds.has(d.id!) ? null : d.children);
    const visibleNodes = root.descendants();
    const maxCardHeight = visibleNodes.reduce(
      (max, node) => Math.max(max, estimateCardHeight(node.data, node.depth)),
      72
    );
    const maxCardWidth = visibleNodes.reduce(
      (max, node) => Math.max(max, estimateCardWidth(node.data, node.depth)),
      140
    );
    const verticalNodeSpacing = Math.max(104, maxCardHeight + 28);
    const horizontalNodeSpacing = Math.max(350, maxCardWidth + 110);
    const tree = d3.tree<MindMapNode>()
      .nodeSize([verticalNodeSpacing, horizontalNodeSpacing])
      .separation((a, b) => {
        const aHeight = estimateCardHeight(a.data, a.depth);
        const bHeight = estimateCardHeight(b.data, b.depth);
        const siblingWeight = a.parent === b.parent
          ? 1 + (estimateSubtreeWeight(a.data) + estimateSubtreeWeight(b.data)) * 0.12
          : 1.65;
        const heightFactor = (aHeight + bHeight) / verticalNodeSpacing;
        return Math.max(siblingWeight, heightFactor);
      });
    const treeData = tree(root);

    const indexMap = new Map<string, number | null>();
    treeData.descendants().forEach(node => {
      if (node.depth === 0) { indexMap.set(node.data.id!, null); return; }
      let anc = node;
      while (anc.depth > 1 && anc.parent) anc = anc.parent;
      const idx = anc.parent?.children?.indexOf(anc) ?? 0;
      indexMap.set(node.data.id!, idx);
    });

    return { nodes: treeData.descendants(), links: treeData.links(), branchIndexMap: indexMap };
  }, [data, collapsedIds]);

  const cx = (containerRef.current?.clientWidth ?? window.innerWidth) / 3;
  const cy = (containerRef.current?.clientHeight ?? window.innerHeight) / 2;
  const editingNode = editingId ? (nodes.find(node => node.data.id === editingId) ?? null) : null;
  const isEditingRoot = editingNode?.depth === 0;
  const isEditingBranchRoot = editingNode?.depth === 1;
  const editingBaseColor = editingNode ? getInheritedBranchColor(editingNode, rootColor) : rootColor;

  const focusTargetInView = useCallback((focusTarget: FocusTarget) => {
    const container = containerRef.current;
    if (!container || nodes.length === 0) return;

    const focusNode = nodes.find(node => node.data.id === focusTarget.id);
    if (!focusNode) return;

    const targetNodes = focusTarget.scope === 'branch'
      ? focusNode.descendants()
      : [focusNode];
    const bounds = targetNodes.reduce((acc, node) => {
      const nodeBounds = estimateCardBounds(node);
      return {
        left: Math.min(acc.left, nodeBounds.left),
        right: Math.max(acc.right, nodeBounds.right),
        top: Math.min(acc.top, nodeBounds.top),
        bottom: Math.max(acc.bottom, nodeBounds.bottom),
      };
    }, {
      left: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
      top: Number.POSITIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY,
    });

    const viewLeft = -translate.x / zoom - cx;
    const viewTop = -translate.y / zoom - cy;
    const viewWidth = container.clientWidth / zoom;
    const viewHeight = container.clientHeight / zoom;
    const marginX = 80;
    const marginY = 56;

    let nextTranslateX = translate.x;
    let nextTranslateY = translate.y;

    if (bounds.left < viewLeft + marginX) {
      nextTranslateX += ((viewLeft + marginX) - bounds.left) * zoom;
    } else if (bounds.right > viewLeft + viewWidth - marginX) {
      nextTranslateX -= (bounds.right - (viewLeft + viewWidth - marginX)) * zoom;
    }

    if (bounds.top < viewTop + marginY) {
      nextTranslateY += ((viewTop + marginY) - bounds.top) * zoom;
    } else if (bounds.bottom > viewTop + viewHeight - marginY) {
      nextTranslateY -= (bounds.bottom - (viewTop + viewHeight - marginY)) * zoom;
    }

    if (nextTranslateX !== translate.x || nextTranslateY !== translate.y) {
      setTranslate({ x: nextTranslateX, y: nextTranslateY });
    }
  }, [cx, cy, nodes, translate, zoom]);

  useEffect(() => {
    const focusTarget = pendingFocusTargetRef.current;
    if (!focusTarget || nodes.length === 0) return;

    const frame = window.requestAnimationFrame(() => {
      focusTargetInView(focusTarget);
      pendingFocusTargetRef.current = null;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [focusTargetInView, nodes.length, translate.x, translate.y, zoom]);

  // ── Canvas interaction (debounced) ────────────────────────────────────────

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-interactive]')) return;
    setIsDragging(true);
    if (selectedId) setSelectedId(null);
    setDragStart({ x: e.clientX - translate.x, y: e.clientY - translate.y });
  }, [translate, selectedId]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    setTranslate({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  }, [isDragging, dragStart]);

  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    const f = e.deltaY > 0 ? 0.91 : 1.1;
    setZoom(z => Math.min(Math.max(z * f, 0.08), 5));
  }, []);

  const debouncedHandleWheel = useMemo(() => debounce(handleWheel, 16), [handleWheel]);

  const refitView = useCallback(() => {
    const targetId = selectedId ?? data.id!;
    pendingFocusTargetRef.current = { id: targetId, scope: 'branch' };
    setZoom(1);
    setTranslate({ x: 0, y: 0 });
  }, [data.id, selectedId]);

  // ── Chrome style ──────────────────────────────────────────────────────────

  const chrome = { background: t.chromeBg, border: `1px solid ${t.chromeBorder}` };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: t.canvasBg, cursor: isDragging ? 'grabbing' : 'grab', userSelect: 'none', transition: 'background 0.3s' }}
      onMouseDown={handleCanvasMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={(e) => {
        e.preventDefault();
        debouncedHandleWheel(e);
      }}
    >
      {/* Dot grid */}
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <defs>
          <pattern id="mm-grid" x="0" y="0" width="22" height="22" patternUnits="userSpaceOnUse">
            <circle cx="1.1" cy="1.1" r="1.1" fill={t.dotColor} />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#mm-grid)" />
      </svg>

      {/* Performance indicator */}
      {performanceMode && (
        <div style={{
          position: 'absolute', top: 12, left: 12, zIndex: 30,
          background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
          border: `1px solid ${t.chromeBorder}`,
          borderRadius: 6, padding: '6px 12px',
          fontSize: 11, color: t.chromeColor,
        }}>
          🚀 Modo Performance ({totalNodes} nós)
        </div>
      )}

      {/* Canvas */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        transform: `translate(${translate.x}px, ${translate.y}px) scale(${zoom})`,
        transformOrigin: 'center', willChange: 'transform',
        transition: isDragging ? 'none' : 'transform 0.06s ease-out',
      }}>
        <svg style={{ width: '100%', height: '100%', overflow: 'visible' }}>
          <g transform={`translate(${cx}, ${cy})`}>

            {/* Links */}
            <AnimatePresence>
              {links.map(link => {
                const linkId = `${link.source.data.id}-${link.target.data.id}`;
                const stroke = getInheritedBranchColor(link.target, rootColor);
                const sw = link.target.depth === 1 ? 2.2 : 1.4;
                const sy = getExpandButtonLinkStartY(link.source), sx = link.source.x;
                const ty = link.target.y, tx = link.target.x;
                const mx = (sy + ty) / 2;
                const handleInsertFromLink = (e: React.MouseEvent<SVGElement>) => {
                  e.stopPropagation();
                  e.preventDefault();
                  handleInsertNodeBetween(link.source.data.id!, link.target.data.id!, link.target.depth);
                };
                const [buttonX, buttonY] = getCubicBezierPoint(
                  [sy, sx],
                  [mx, sx],
                  [mx, tx],
                  [ty, tx],
                  0.5
                );
                const isLinkActive = hoveredLinkId === linkId;
                return (
                  <g key={linkId}>
                    <motion.path
                      initial={{ pathLength: 0, opacity: 0 }}
                      animate={{ pathLength: 1, opacity: 1 }}
                      exit={{ pathLength: 0, opacity: 0 }}
                      transition={performanceMode ? { duration: 0 } : { duration: 0.26, ease: 'easeOut' }}
                      d={`M ${sy} ${sx} C ${mx} ${sx}, ${mx} ${tx}, ${ty} ${tx}`}
                      fill="none" stroke={stroke} strokeWidth={sw} strokeLinecap="round"
                    />
                    {!isReadOnly && (
                      <path
                        data-interactive="true"
                        d={`M ${sy} ${sx} C ${mx} ${sx}, ${mx} ${tx}, ${ty} ${tx}`}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={20}
                        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                        onMouseDown={e => { e.stopPropagation(); e.preventDefault(); }}
                        onClick={handleInsertFromLink}
                        onMouseEnter={() => setHoveredLinkId(linkId)}
                        onMouseLeave={() => setHoveredLinkId(prev => prev === linkId ? null : prev)}
                      />
                    )}
                    {!isReadOnly && isLinkActive && (
                      <g
                        data-interactive="true"
                        transform={`translate(${buttonX}, ${buttonY})`}
                        style={{ cursor: 'pointer', pointerEvents: 'all' }}
                        onMouseEnter={() => setHoveredLinkId(linkId)}
                        onMouseLeave={() => setHoveredLinkId(prev => prev === linkId ? null : prev)}
                        onMouseDown={e => { e.stopPropagation(); e.preventDefault(); }}
                        onClick={handleInsertFromLink}
                      >
                        <circle
                          r={16}
                          fill="transparent"
                          style={{ pointerEvents: 'all' }}
                        />
                        <circle
                          r={11}
                          fill={t.chromeBg}
                          stroke={stroke}
                          strokeWidth={1.8}
                        />
                        <path
                          d="M -4 0 L 4 0 M 0 -4 L 0 4"
                          stroke={stroke}
                          strokeWidth={1.8}
                          strokeLinecap="round"
                        />
                      </g>
                    )}
                  </g>
                );
              })}
            </AnimatePresence>

            {/* Nodes */}
            <AnimatePresence>
              {nodes.map(node => {
                const bIdx = branchIndexMap.get(node.data.id!) ?? null;
                const baseBranchColor = getInheritedBranchColor(node, rootColor);
                const customColor = node.depth === 1 ? (node.data.color ?? null) : null;
                const resolvedAccent = customColor ?? baseBranchColor;

                const isRoot = node.depth === 0;
                const isSelected = selectedId === node.data.id;
                const isEditing = editingId === node.data.id;
                const isCollapsed = collapsedIds.has(node.data.id!);
                const childCount = node.data.children?.length ?? 0;

                let bg: string, textColor: string, nodeBorder: string, nodeShadow: string;

                if (isRoot) {
                  bg = rootColor;
                  textColor = getContrastColor(rootColor);
                  nodeBorder = 'none';
                  nodeShadow = 'none';
                } else if (node.depth === 1) {
                  bg = customColor ?? baseBranchColor ?? DEFAULT_ROOT_COLOR;
                  textColor = getContrastColor(bg);
                  nodeBorder = 'none';
                  nodeShadow = 'none';
                } else {
                  bg = customColor ?? t.leafBg; 
                  textColor = customColor ? getContrastColor(customColor) : t.leafText;
                  const borderColor = isDark
                    ? (resolvedAccent ? resolvedAccent + 'AA' : '#3A3A42')
                    : (resolvedAccent ?? '#D1CEC7');
                  nodeBorder = customColor ? 'none' : `2px solid ${borderColor}`;
                  nodeShadow = 'none';
                }

                const hasLightText = textColor === '#ffffff' || textColor.toLowerCase() === '#fff';

                return (
                  <NodeComponent
                    key={node.data.id}
                    node={node}
                    isRoot={isRoot}
                    isSelected={isSelected}
                    isEditing={isEditing}
                    isReadOnly={isReadOnly}
                    isCollapsed={isCollapsed}
                    childCount={childCount}
                    selectedId={selectedId}
                    editingId={editingId}
                    resolvedAccent={resolvedAccent}
                    baseBranchColor={baseBranchColor}
                    customColor={customColor}
                    bIdx={bIdx}
                    isDark={isDark}
                    t={t}
                    textColor={textColor}
                    bg={bg}
                    nodeBorder={nodeBorder}
                    nodeShadow={nodeShadow}
                    onSelect={(id) => setSelectedId(prev => prev === id ? null : id)}
                    onEdit={startEdit}
                    onDelete={handleDelete}
                    onAddChild={handleAddChild}
                    onMoveNode={handleMoveNode}
                    onToggleCollapse={toggleCollapse}
                    hasLightText={hasLightText}
                    animationEnabled={!performanceMode}
                  />
                );
              })}
            </AnimatePresence>
          </g>
        </svg>
      </div>

      {/* ── Edit popup ── */}
      <AnimatePresence>
        {editingId && (() => {
          const accentColor = (isEditingBranchRoot || isEditingRoot) ? (editColor ?? editingBaseColor) : editingBaseColor;
          return (
            <>
              <motion.div
                key="edit-backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                onMouseDown={cancelEdit}
                style={{
                  position: 'fixed', inset: 0, zIndex: 1000,
                  background: isDark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.25)',
                  backdropFilter: 'blur(2px)',
                }}
              />

              <motion.div
                key="edit-popup"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                onMouseDown={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
                style={{
                  position: 'fixed',
                  top: '50%', left: '50%',
                  x: '-50%', y: '-50%',
                  width: 'min(520px, calc(100vw - 48px))',
                  zIndex: 1001,
                  background: t.chromeBg,
                  border: `1px solid ${t.chromeBorder}`,
                  borderRadius: 20,
                  boxShadow: 'none',
                  padding: '24px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 16,
                  maxHeight: 'calc(100vh - 48px)',
                  overflowY: 'auto',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: t.chromeColor, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Editar nó
                  </span>
                  <button
                    onClick={cancelEdit}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: t.chromeColor, padding: 4, display: 'flex', borderRadius: 6 }}
                    onMouseEnter={e => { e.currentTarget.style.background = t.chromeHover; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                    </svg>
                  </button>
                </div>

                <div style={{ height: 1, background: t.chromeDivider, margin: '0 -24px' }} />

                <div>
                  <label style={{ fontSize: 10, fontWeight: 600, color: t.chromeColor, letterSpacing: '0.05em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
                    Título
                  </label>
                  <input
                    ref={editInputRef}
                    value={editTitle}
                    onChange={e => setEditTitle(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
                      if (e.key === 'Escape') cancelEdit();
                    }}
                    placeholder="Título do nó"
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                      border: `1.5px solid ${t.chromeBorder}`,
                      borderRadius: 10, padding: '10px 14px',
                      fontSize: 15, fontWeight: 600,
                      color: t.editTitleColor, outline: 'none',
                      transition: 'border-color 0.15s',
                    }}
                    onFocus={e => { e.currentTarget.style.borderColor = accentColor; }}
                    onBlur={e => { e.currentTarget.style.borderColor = t.chromeBorder; }}
                  />
                </div>

                <div>
                  <label style={{ fontSize: 10, fontWeight: 600, color: t.chromeColor, letterSpacing: '0.05em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
                    Descricao em Markdown
                  </label>
                  <textarea
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') cancelEdit(); }}
                    placeholder="Escreva a descricao com Markdown completo..."
                    rows={5}
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                      border: `1.5px solid ${t.chromeBorder}`,
                      borderRadius: 10, padding: '10px 14px',
                      fontSize: 13, color: t.editContentColor,
                      outline: 'none', resize: 'vertical', lineHeight: 1.6,
                      fontFamily: 'inherit',
                      transition: 'border-color 0.15s',
                    }}
                    onFocus={e => { e.currentTarget.style.borderColor = accentColor; }}
                    onBlur={e => { e.currentTarget.style.borderColor = t.chromeBorder; }}
                  />
                </div>

                {(isEditingBranchRoot || isEditingRoot) ? (
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 600, color: t.chromeColor, letterSpacing: '0.05em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
                      Cor
                    </label>
                    <ColorPrism
                      value={editColor}
                      defaultColor={isEditingRoot ? DEFAULT_ROOT_COLOR : rootColor}
                      onChange={setEditColor}
                      hasLightText={false}
                      inputBorder={t.inputBorderLeaf}
                      editTitleClr={t.editTitleColor}
                      hexLabelClr={t.hexLabelColor}
                    />
                  </div>
                ) : null}

                <div style={{ height: 1, background: t.chromeDivider, margin: '0 -24px' }} />

                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button
                    onClick={cancelEdit}
                    style={{
                      padding: '9px 20px', fontSize: 13, fontWeight: 500,
                      borderRadius: 10, cursor: 'pointer',
                      background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                      border: `1px solid ${t.chromeBorder}`,
                      color: t.editTitleColor, transition: 'background 0.12s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = t.chromeHover; }}
                    onMouseLeave={e => { e.currentTarget.style.background = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'; }}
                  >Cancelar</button>
                  <button
                    onClick={saveEdit}
                    style={{
                      padding: '9px 28px', fontSize: 13, fontWeight: 600,
                      borderRadius: 10, cursor: 'pointer',
                      background: accentColor,
                      border: 'none', color: 'white',
                      transition: 'opacity 0.12s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.opacity = '0.85'; }}
                    onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
                  >Salvar</button>
                </div>
              </motion.div>
            </>
          );
        })()}
      </AnimatePresence>

      {/* Controls */}
      <div data-interactive="true" style={{ position: 'absolute', bottom: 20, right: 20, display: 'flex', flexDirection: 'column', gap: 6, zIndex: 20 }}>
        <div style={{ ...chrome, borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <button
            onClick={() => setZoom(z => Math.min(z * 1.2, 5))}
            style={{ padding: 8, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.chromeColor, transition: 'background 0.12s' }}
            onMouseEnter={e => { e.currentTarget.style.background = t.chromeHover; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          ><ZoomIn size={15} /></button>
          <div style={{ height: 1, background: t.chromeDivider }} />
          <button
            onClick={() => setZoom(z => Math.max(z * 0.83, 0.08))}
            style={{ padding: 8, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.chromeColor, transition: 'background 0.12s' }}
            onMouseEnter={e => { e.currentTarget.style.background = t.chromeHover; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          ><ZoomOut size={15} /></button>
        </div>

        <button
          onClick={refitView}
          title="Recentralizar fluxo"
          style={{ ...chrome, borderRadius: 10, padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: t.chromeColor, transition: 'background 0.12s', fontSize: 12, fontWeight: 600 }}
          onMouseEnter={e => { e.currentTarget.style.background = t.chromeHover; }}
          onMouseLeave={e => { e.currentTarget.style.background = t.chromeBg; }}
        >
          <RotateCcw size={15} />
        </button>

        <div style={{ ...chrome, borderRadius: 8, padding: '4px 8px', textAlign: 'center', fontSize: 11, color: t.chromeColor, fontWeight: 600, fontFamily: 'monospace', minWidth: 46 }}>
          {Math.round(zoom * 100)}%
        </div>
      </div>
    </div>
  );
};

export default MindMap;
