import React, { useState, useRef, useEffect } from "react";
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
    // Unique key per document
    const key = rawName.toLowerCase();
    const citationIndex = idx + 1;

    if (!map.has(key)) {
      map.set(key, {
        id: key,
        fileName: rawName,
        url: source.url,
        unit: source.unit,
        citations: [{ index: citationIndex, source }]
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
 * - Deduplicates repeated citations (e.g. [1, 1] or consecutive duplicate badges)
 * - Strips outer parentheses around citations (e.g. "( ① ① )" -> "①")
 * - Sorts clustered citations in ascending numerical order
 * - Cleans up stray spacing before punctuation
 */
export function preprocessCitationMarkdown(
  text: string,
  sources?: SourceChunk[]
): string {
  if (!text) return "";

  let processed = text;

  // 1. If text references filenames directly like ([Source: Expenses Policy.pdf]) or ([Expenses Policy.pdf])
  if (sources && sources.length > 0) {
    sources.forEach((source, idx) => {
      if (source.fileName && source.fileName.trim().length > 3) {
        const escaped = source.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Match parenthesized direct citation: ([Source: filename]) or (Source: filename) or ([filename])
        const regexParen = new RegExp(`\\(\\s*\\[?\\s*(?:Source:\\s*)?${escaped}\\s*\\]?(?:\\([^)]*\\))?\\s*\\)`, 'gi');
        processed = processed.replace(regexParen, `[cite:${idx + 1}](#cite-${idx + 1})`);

        // Match bracketed direct citation: [Source: filename] or [filename]
        const regexBracket = new RegExp(`\\[\\s*(?:Source:\\s*)?${escaped}\\s*\\](?:\\([^)]*\\))?`, 'gi');
        processed = processed.replace(regexBracket, `[cite:${idx + 1}](#cite-${idx + 1})`);
      }
    });
  }

  // 2. Match complex parenthesized groupings like:
  // ([Source 1](...), [Source 2](...)) or ([Source 1] [Source 1]) or ([1], [2]) or ( [Source 1], [Source 2] )
  // Extracts all numbers, deduplicates them, sorts ascending, and removes enclosing parentheses.
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
        return unique.map(n => `[cite:${n}](#cite-${n})`).join(" ");
      }
      return _match;
    }
  );

  // 3. Match any remaining single parenthesized citation:
  // ([Source 2]) or ([2])
  processed = processed.replace(
    /\(\s*\[(?:Source\s*)?(\d+)\](?:\([^)]*\))?\s*\)/gi,
    '[cite:$1](#cite-$1)'
  );

  // 4. Match bracketed citation with link:
  // [Source 2](Expenses Policy - August 2026.pdf) or [2](Expenses Policy - August 2026.pdf)
  processed = processed.replace(
    /\[(?:Source\s*)?(\d+)\]\([^)]+\)/gi,
    '[cite:$1](#cite-$1)'
  );

  // 5. Match standalone [Source X]:
  // [Source 1], [Source 2]
  processed = processed.replace(
    /\[Source\s*(\d+)\]/gi,
    '[cite:$1](#cite-$1)'
  );

  // 6. Match standalone [1], [2] ONLY if sources exist and number is <= sources.length
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

  // 7. Strip any remaining parentheses wrapping citation links:
  // e.g. ( [cite:1](#cite-1) ) or ( [cite:1](#cite-1) [cite:2](#cite-2) )
  processed = processed.replace(
    /\(\s*(\[cite:\d+\]\(#cite-\d+\)(?:[\s,;&/\-]*\[cite:\d+\]\(#cite-\d+\))*)\s*\)/gi,
    '$1'
  );

  // 8. CLUSTER & DEDUPLICATE: Merge all consecutive/adjacent citation links!
  // Matches any sequence of one or more [cite:N](#cite-N) separated by spaces, commas, semicolons, or slashes
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
      return unique.map(n => `[cite:${n}](#cite-${n})`).join(" ");
    }
  );

  // 9. Clean up any weird spacing before punctuation caused by stripping parentheses:
  // e.g. "Department [cite:1](#cite-1) ." -> "Department [cite:1](#cite-1)."
  processed = processed.replace(
    /(\[cite:\d+\]\(#cite-\d+\))\s+([.,;:!?])/g,
    '$1$2'
  );

  // 10. Clean up any multiple spaces
  processed = processed.replace(/[ \t]{2,}/g, ' ');

  return processed;
}

/**
 * Interactive Citation Dot:
 * - Subtle filled dark circle with white number (no distracting bright orange)
 * - In-text dot (inline=true):
 *     - No tooltip popover on hover
 *     - Clicking scrolls smoothly down to the corresponding badge in the Sources list and pulses it
 * - Sources list dot (inline=false):
 *     - Hover or focus opens the tooltip-style speech panel popover showing excerpt & link
 */
export function CitationDot({
  number,
  source,
  inline = false,
  className = ""
}: {
  number: number;
  source?: SourceChunk;
  inline?: boolean;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);

  // Close on outside click for mobile popover
  useEffect(() => {
    if (!isOpen || inline) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, inline]);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    // If inline, clicking scrolls down to the citation in the sources list
    if (inline) {
      // Look within parent message container first for accuracy
      const parentMsg =
        containerRef.current?.closest(".chat-message-bubble") ||
        containerRef.current?.closest(".prose")?.parentElement ||
        document;

      const targetBadge = parentMsg.querySelector(`[data-citation-badge-index="${number}"]`) as HTMLElement | null;

      if (targetBadge) {
        targetBadge.scrollIntoView({ behavior: "smooth", block: "nearest" });
        targetBadge.classList.add("ring-4", "ring-indigo-400", "ring-offset-2", "scale-125");
        setTimeout(() => {
          targetBadge.classList.remove("ring-4", "ring-indigo-400", "ring-offset-2", "scale-125");
        }, 1600);
      } else {
        // Fallback: search globally
        const fallbackBadge = document.querySelector(`[data-citation-badge-index="${number}"]`) as HTMLElement | null;
        if (fallbackBadge) {
          fallbackBadge.scrollIntoView({ behavior: "smooth", block: "nearest" });
          fallbackBadge.classList.add("ring-4", "ring-indigo-400", "ring-offset-2", "scale-125");
          setTimeout(() => {
            fallbackBadge.classList.remove("ring-4", "ring-indigo-400", "ring-offset-2", "scale-125");
          }, 1600);
        }
      }
      return;
    }

    // If in footer, click toggles the popover
    setIsOpen(prev => !prev);
  };

  // Inline dot: subtle filled circle without popover
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

  // Footer dot: subtle filled circle WITH tooltip-style speech panel popover on hover/focus
  return (
    <span
      ref={containerRef}
      className={`relative inline-flex items-center justify-center align-middle ${className}`}
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
    >
      <button
        type="button"
        data-citation-badge-index={number}
        onClick={handleClick}
        onFocus={() => setIsOpen(true)}
        onBlur={() => setIsOpen(false)}
        aria-label={`Source citation ${number}: ${source?.fileName || "Document reference"}`}
        title={source?.fileName ? `Source ${number}: ${source.fileName}` : `Source ${number}`}
        className="w-[20px] h-[20px] min-w-[20px] rounded-full bg-slate-600 hover:bg-slate-800 active:bg-slate-900 text-white text-[10px] font-semibold leading-none flex items-center justify-center transition-all shadow-xs focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-1 select-none cursor-pointer"
      >
        {number}
      </button>

      {/* Tooltip-style speech panel popover */}
      {isOpen && (
        <div
          role="tooltip"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 max-w-[85vw] p-3 bg-gray-900 text-white text-xs rounded-xl shadow-2xl z-50 border border-gray-800 leading-relaxed text-left pointer-events-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-2 border-b border-gray-800 pb-1.5 mb-2">
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

          {/* Body snippet */}
          <div className="text-[11px] text-gray-300 max-h-40 overflow-y-auto pr-1 leading-relaxed scrollbar-thin">
            {source?.text ? source.text.trim() : "No excerpt available for this citation."}
          </div>

          {/* Footer URL link */}
          {source?.url && (
            <div className="mt-2 pt-1.5 border-t border-gray-800/80 flex items-center justify-between">
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

          {/* Speech bubble down arrow */}
          <div className="absolute bottom-[-5px] left-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-gray-900 rotate-45 border-r border-b border-gray-800"></div>
        </div>
      )}
    </span>
  );
}

/**
 * Sources footer section at the bottom of assistant message.
 * Groups duplicate documents so each source document is listed once,
 * followed by its subtle numbered citation circle badges.
 */
export function SourcesFooter({
  sources
}: {
  sources?: SourceChunk[];
}) {
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
              {/* Document details */}
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <BookOpen size={13} className="text-slate-600 flex-shrink-0" />
                <span
                  className="text-xs font-semibold text-slate-800 truncate"
                  title={group.fileName}
                >
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

              {/* Numbered citation dots for this document */}
              <div className="flex items-center gap-1.5 flex-shrink-0 pl-1">
                {group.citations.map(({ index, source }) => (
                  <CitationDot
                    key={index}
                    number={index}
                    source={source}
                    inline={false}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
