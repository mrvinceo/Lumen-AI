import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { BookOpen, ExternalLink } from "lucide-react";

export interface SourceChunk {
  fileName: string;
  text: string;
  unit?: string;
  url?: string;
  folderId?: string;
}

export interface GroupedSource {
  id: string;
  fileName: string;
  url?: string;
  unit?: string;
  citations: {
    index: number;
    source: SourceChunk;
  }[];
}

/**
 * Group raw source chunks by distinct fileName (or fileName + url).
 * Keeps original 1-based citation indices intact.
 */
export function groupSources(sources?: SourceChunk[]): GroupedSource[] {
  if (!sources || sources.length === 0) return [];

  const map = new Map<string, GroupedSource>();

  sources.forEach((source, idx) => {
    const rawName = (source.fileName || "Source Document").trim();
    const key = rawName.toLowerCase();
    const citationIndex = idx + 1;

    if (!map.has(key)) {
      map.set(key, {
        id: key,
        fileName: rawName,
        url: source.url,
        unit: source.unit,
        citations: [{ index: citationIndex, source }],
      });
    } else {
      const existing = map.get(key)!;
      if (!existing.url && source.url) existing.url = source.url;
      if (!existing.unit && source.unit) existing.unit = source.unit;
      existing.citations.push({ index: citationIndex, source });
    }
  });

  return Array.from(map.values());
}

/**
 * Preprocess markdown response text:
 * - Converts raw filename or [Source N] or [N] citations into "[cite:N](#cite-N)"
 * - Deduplicates repeated citations
 * - Strips outer parentheses around citations
 * - Sorts clustered citations in ascending numerical order
 */
export function preprocessCitationMarkdown(
  text: string,
  sources?: SourceChunk[]
): string {
  if (!text) return "";

  let processed = text;

  if (sources && sources.length > 0) {
    sources.forEach((source, idx) => {
      if (source.fileName && source.fileName.trim().length > 3) {
        const escaped = source.fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regexParen = new RegExp(
          `\\(\\s*\\[?\\s*(?:Source:\\s*)?${escaped}\\s*\\]?(?:\\([^)]*\\))?\\s*\\)`,
          "gi"
        );
        processed = processed.replace(regexParen, `[cite:${idx + 1}](#cite-${idx + 1})`);

        const regexBracket = new RegExp(
          `\\[\\s*(?:Source:\\s*)?${escaped}\\s*\\](?:\\([^)]*\\))?`,
          "gi"
        );
        processed = processed.replace(regexBracket, `[cite:${idx + 1}](#cite-${idx + 1})`);
      }
    });
  }

  processed = processed.replace(
    /\(\s*([^)]*?\[(?:Source\s*)?\d+\][^)]*?)\s*\)/gi,
    (_match, inner) => {
      const numbers: number[] = [];
      const numRegex = /\[(?:Source\s*)?(\d+)\](?:\([^)]*\))?/gi;
      let numMatch;
      while ((numMatch = numRegex.exec(inner)) !== null) {
        numbers.push(parseInt(numMatch[1], 10));
      }
      if (numbers.length > 0) {
        const unique = Array.from(new Set(numbers)).sort((a, b) => a - b);
        return unique.map((n) => `[cite:${n}](#cite-${n})`).join(" ");
      }
      return _match;
    }
  );

  processed = processed.replace(
    /\(\s*\[(?:Source\s*)?(\d+)\](?:\([^)]*\))?\s*\)/gi,
    "[cite:$1](#cite-$1)"
  );

  processed = processed.replace(
    /\[(?:Source\s*)?(\d+)\]\([^)]+\)/gi,
    "[cite:$1](#cite-$1)"
  );

  processed = processed.replace(/\[Source\s*(\d+)\]/gi, "[cite:$1](#cite-$1)");

  if (sources && sources.length > 0) {
    const maxSourceNum = sources.length;
    processed = processed.replace(/\[(\d+)\](?!\()/g, (match, numStr) => {
      const n = parseInt(numStr, 10);
      if (n >= 1 && n <= maxSourceNum) {
        return `[cite:${n}](#cite-${n})`;
      }
      return match;
    });
  }

  processed = processed.replace(
    /\(\s*(\[cite:\d+\]\(#cite-\d+\)(?:[\s,;&/\-]*\[cite:\d+\]\(#cite-\d+\))*)\s*\)/gi,
    "$1"
  );

  processed = processed.replace(
    /(?:\[cite:(\d+)\]\(#cite-\d+\)(?:[\s,;&/\-]*))+/gi,
    (cluster) => {
      const nums: number[] = [];
      const linkRegex = /\[cite:(\d+)\]\(#cite-\d+\)/gi;
      let m;
      while ((m = linkRegex.exec(cluster)) !== null) {
        nums.push(parseInt(m[1], 10));
      }
      if (nums.length === 0) return cluster;
      const unique = Array.from(new Set(nums)).sort((a, b) => a - b);
      return unique.map((n) => `[cite:${n}](#cite-${n})`).join(" ");
    }
  );

  processed = processed.replace(
    /(\[cite:\d+\]\(#cite-\d+\))\s+([.,;:!?])/g,
    "$1$2"
  );

  processed = processed.replace(/[ \t]{2,}/g, " ");

  return processed;
}

const TOOLTIP_PAD = 8;
const TOOLTIP_GAP = 8;
const TOOLTIP_WIDTH = 288;

function clampTooltipToViewport(anchor: DOMRect, tooltip: HTMLElement) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(TOOLTIP_WIDTH, vw - TOOLTIP_PAD * 2);
  const maxHeight = Math.min(280, vh - TOOLTIP_PAD * 2);
  tooltip.style.width = `${width}px`;
  tooltip.style.maxHeight = `${maxHeight}px`;

  const height = Math.min(tooltip.offsetHeight, maxHeight);
  const spaceAbove = anchor.top - TOOLTIP_PAD;
  const spaceBelow = vh - anchor.bottom - TOOLTIP_PAD;
  const placeAbove = spaceAbove >= height + TOOLTIP_GAP || spaceAbove >= spaceBelow;

  let top = placeAbove ? anchor.top - TOOLTIP_GAP - height : anchor.bottom + TOOLTIP_GAP;
  top = Math.max(TOOLTIP_PAD, Math.min(top, vh - height - TOOLTIP_PAD));

  let left = anchor.left + anchor.width / 2 - width / 2;
  left = Math.max(TOOLTIP_PAD, Math.min(left, vw - width - TOOLTIP_PAD));

  const arrowLeft = Math.max(12, Math.min(anchor.left + anchor.width / 2 - left, width - 12));

  return { top, left, width, maxHeight, placeAbove, arrowLeft };
}

export function CitationDot({
  number,
  source,
  inline = false,
  className = "",
}: {
  number: number;
  source?: SourceChunk;
  inline?: boolean;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({
    position: "fixed",
    top: 0,
    left: 0,
    visibility: "hidden",
  });
  const [placeAbove, setPlaceAbove] = useState(true);
  const [arrowLeft, setArrowLeft] = useState(TOOLTIP_WIDTH / 2);

  const openTooltip = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setIsOpen(true);
  };

  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setIsOpen(false), 120);
  };

  useLayoutEffect(() => {
    if (!isOpen || inline) return;
    const anchor = containerRef.current?.getBoundingClientRect();
    const tooltip = tooltipRef.current;
    if (!anchor || !tooltip) return;
    const pos = clampTooltipToViewport(anchor, tooltip);
    setPlaceAbove(pos.placeAbove);
    setArrowLeft(pos.arrowLeft);
    setTooltipStyle({
      position: "fixed",
      top: pos.top,
      left: pos.left,
      width: pos.width,
      maxHeight: pos.maxHeight,
      zIndex: 9999,
      visibility: "visible",
    });
  }, [isOpen, inline, source?.text]);

  useEffect(() => {
    if (!isOpen || inline) return;
    const reposition = () => {
      const anchor = containerRef.current?.getBoundingClientRect();
      const tooltip = tooltipRef.current;
      if (!anchor || !tooltip) return;
      const pos = clampTooltipToViewport(anchor, tooltip);
      setPlaceAbove(pos.placeAbove);
      setArrowLeft(pos.arrowLeft);
      setTooltipStyle({
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: pos.width,
        maxHeight: pos.maxHeight,
        zIndex: 9999,
        visibility: "visible",
      });
    };
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target) || tooltipRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, inline]);

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    if (inline) {
      const parentMsg =
        containerRef.current?.closest(".chat-message-bubble") ||
        containerRef.current?.closest(".prose")?.parentElement ||
        document;

      const targetBadge = parentMsg.querySelector(
        `[data-citation-badge-index="${number}"]`
      ) as HTMLElement | null;

      if (targetBadge) {
        targetBadge.scrollIntoView({ behavior: "smooth", block: "nearest" });
        targetBadge.classList.add("ring-4", "ring-indigo-400", "ring-offset-2", "scale-125");
        setTimeout(() => {
          targetBadge.classList.remove("ring-4", "ring-indigo-400", "ring-offset-2", "scale-125");
        }, 1600);
      } else {
        const fallbackBadge = document.querySelector(
          `[data-citation-badge-index="${number}"]`
        ) as HTMLElement | null;
        if (fallbackBadge) {
          fallbackBadge.scrollIntoView({ behavior: "smooth", block: "nearest" });
          fallbackBadge.classList.add("ring-4", "ring-indigo-400", "ring-offset-2", "scale-125");
          setTimeout(() => {
            fallbackBadge.classList.remove(
              "ring-4",
              "ring-indigo-400",
              "ring-offset-2",
              "scale-125"
            );
          }, 1600);
        }
      }
      return;
    }

    setIsOpen((prev) => !prev);
  };

  const tooltip = isOpen ? (
    <div
      ref={tooltipRef}
      role="tooltip"
      style={tooltipStyle}
      className="w-72 max-w-[calc(100vw-16px)] p-3 bg-gray-900 text-white text-xs rounded-xl shadow-2xl border border-gray-800 leading-relaxed text-left pointer-events-auto overflow-hidden flex flex-col"
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={openTooltip}
      onMouseLeave={scheduleClose}
    >
      <div className="flex items-start justify-between gap-2 border-b border-gray-800 pb-1.5 mb-2 shrink-0">
        <div className="min-w-0 flex-1">
          <span className="font-bold text-gray-100 text-[11px] block truncate" title={source?.fileName}>
            {source?.fileName || `Source ${number}`}
          </span>
          {source?.unit && (
            <span className="text-[9px] bg-indigo-900 text-indigo-200 px-1.5 py-0.2 rounded font-medium mt-0.5 inline-block">
              {source.unit}
            </span>
          )}
        </div>
        <span className="flex-shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-200 border border-slate-600">
          #{number}
        </span>
      </div>

      <div className="text-[11px] text-gray-300 overflow-y-auto pr-1 leading-relaxed min-h-0">
        {source?.text ? source.text.trim() : "No excerpt available for this citation."}
      </div>

      {source?.url && (
        <div className="mt-2 pt-1.5 border-t border-gray-800/80 flex items-center justify-between shrink-0">
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] font-semibold text-sky-400 hover:text-white flex items-center gap-1 transition-colors"
          >
            <span>Open Document</span>
            <ExternalLink size={10} />
          </a>
        </div>
      )}

      <div
        className={`absolute w-2.5 h-2.5 bg-gray-900 rotate-45 border-gray-800 ${
          placeAbove ? "bottom-[-5px] border-r border-b" : "top-[-5px] border-l border-t"
        }`}
        style={{ left: arrowLeft, transform: "translateX(-50%) rotate(45deg)" }}
      />
    </div>
  ) : null;

  if (inline) {
    return (
      <span
        ref={containerRef}
        className={`relative inline-flex items-center justify-center align-middle mx-0.5 ${className}`}
      >
        <button
          type="button"
          onClick={handleClick}
          aria-label={`Citation ${number}. Click to jump to source in list.`}
          title={`Source ${number}${source?.fileName ? `: ${source.fileName}` : ""} (click to jump to Sources list)`}
          className="w-[18px] h-[18px] min-w-[18px] rounded-full bg-slate-600 hover:bg-slate-800 active:bg-slate-900 text-white text-[10px] font-semibold leading-none inline-flex items-center justify-center transition-all shadow-xs cursor-pointer select-none -translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-1"
        >
          {number}
        </button>
      </span>
    );
  }

  return (
    <span
      ref={containerRef}
      className={`relative inline-flex items-center justify-center align-middle ${className}`}
      onMouseEnter={openTooltip}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        data-citation-badge-index={number}
        onClick={handleClick}
        aria-label={`Source citation ${number}: ${source?.fileName || "Document reference"}`}
        title={source?.fileName ? `Source ${number}: ${source.fileName}` : `Source ${number}`}
        className="w-[20px] h-[20px] min-w-[20px] rounded-full bg-slate-600 hover:bg-slate-800 active:bg-slate-900 text-white text-[10px] font-semibold leading-none flex items-center justify-center transition-all shadow-xs focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-1 select-none cursor-pointer"
      >
        {number}
      </button>
      {typeof document !== "undefined" && tooltip ? createPortal(tooltip, document.body) : null}
    </span>
  );
}

export function SourcesFooter({ sources }: { sources?: SourceChunk[] }) {
  const grouped = groupSources(sources);
  if (grouped.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Sources</p>
      <div className="space-y-2">
        {grouped.map((group) => {
          const cardId = `source-doc-${encodeURIComponent(group.fileName.trim().toLowerCase())}`;
          return (
            <div
              key={group.id}
              id={cardId}
              className="flex items-center justify-between gap-2 p-2 bg-slate-50/80 hover:bg-slate-50 border border-slate-200/80 rounded-xl transition-all"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <BookOpen size={13} className="text-slate-600 flex-shrink-0" />
                <span className="text-xs font-semibold text-slate-800 truncate" title={group.fileName}>
                  {group.fileName}
                </span>
                {group.unit && (
                  <span className="text-[9px] font-bold bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded flex-shrink-0">
                    {group.unit}
                  </span>
                )}
                {group.url && (
                  <a
                    href={group.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-slate-500 hover:text-slate-800 p-0.5 rounded transition-colors flex-shrink-0"
                    title="Open source document"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink size={11} />
                  </a>
                )}
              </div>

              <div className="flex items-center gap-1.5 flex-shrink-0 pl-1">
                {group.citations.map(({ index, source }) => (
                  <CitationDot key={index} number={index} source={source} inline={false} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
