import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  ChevronLeft, 
  ChevronRight, 
  Play, 
  Pause, 
  FileAudio, 
  Video, 
  Image as ImageIcon, 
  Maximize2, 
  X, 
  ZoomIn, 
  ZoomOut,
  Download
} from "lucide-react";

interface MediaFile {
  name: string;
  mimeType: string;
  data?: string;
}

interface MediaCarouselProps {
  files: MediaFile[];
  title?: string;
}

export default function MediaCarousel({ files, title }: MediaCarouselProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [activeImage, setActiveImage] = useState<{ src: string; name: string } | null>(null);
  const [zoomScale, setZoomScale] = useState(1);

  if (!files || files.length === 0) return null;

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentIndex((prev) => (prev === 0 ? files.length - 1 : prev - 1));
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentIndex((prev) => (prev === files.length - 1 ? 0 : prev + 1));
  };

  const currentFile = files[currentIndex];
  const isImage = currentFile.mimeType.startsWith("image/");
  const isAudio = currentFile.mimeType.startsWith("audio/");
  const isVideo = currentFile.mimeType.startsWith("video/");

  const mediaSrc = currentFile.data 
    ? `data:${currentFile.mimeType};base64,${currentFile.data}` 
    : "";

  const handleDownload = (src: string, name: string) => {
    const link = document.createElement("a");
    link.href = src;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="mt-4 p-3 bg-gray-50/80 rounded-xl border border-gray-100 shadow-xs">
      {title && (
        <div className="flex items-center gap-1.5 mb-2.5 px-1">
          <span className="w-1.5 h-1.5 rounded-full bg-oca-verdigris animate-pulse" />
          <span className="text-[10px] font-extrabold uppercase tracking-widest text-gray-500">
            {title} ({currentIndex + 1}/{files.length})
          </span>
        </div>
      )}

      {/* Main Display Box */}
      <div className="relative w-full aspect-video md:aspect-[16/10] bg-gray-900 rounded-lg overflow-hidden flex items-center justify-center group shadow-inner">
        {files.length > 1 && (
          <>
            <button
              onClick={handlePrev}
              className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 bg-black/50 hover:bg-black/75 text-white rounded-full transition-all opacity-0 group-hover:opacity-100 z-10 hover:scale-105 active:scale-95"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={handleNext}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-black/50 hover:bg-black/75 text-white rounded-full transition-all opacity-0 group-hover:opacity-100 z-10 hover:scale-105 active:scale-95"
            >
              <ChevronRight size={16} />
            </button>
          </>
        )}

        {/* Media Renderers */}
        <div className="w-full h-full flex items-center justify-center p-3">
          {currentFile.data ? (
            <AnimatePresence mode="wait">
              <motion.div
                key={currentIndex}
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.2 }}
                className="w-full h-full flex flex-col items-center justify-center"
              >
                {isImage && (
                  <div className="relative group/img cursor-zoom-in w-full h-full flex items-center justify-center">
                    <img
                      src={mediaSrc}
                      alt={currentFile.name}
                      referrerPolicy="no-referrer"
                      className="max-w-full max-h-full object-contain rounded-md"
                      onClick={() => {
                        setActiveImage({ src: mediaSrc, name: currentFile.name });
                        setZoomScale(1);
                      }}
                    />
                    <div className="absolute bottom-2 right-2 bg-black/60 backdrop-blur-xs text-white p-1.5 rounded-md opacity-0 group-hover/img:opacity-100 transition-opacity">
                      <Maximize2 size={12} />
                    </div>
                  </div>
                )}

                {isAudio && (
                  <div className="w-full max-w-xs p-4 bg-white/10 backdrop-blur-xs rounded-xl border border-white/10 flex flex-col items-center gap-3 shadow-md">
                    <div className="w-12 h-12 rounded-full bg-oca-blue-tint/20 flex items-center justify-center text-oca-verdigris">
                      <FileAudio size={24} className="animate-pulse" />
                    </div>
                    <div className="text-center w-full min-w-0">
                      <p className="text-xs font-bold text-white truncate px-2">{currentFile.name}</p>
                      <p className="text-[10px] text-white/55 font-semibold mt-0.5 uppercase tracking-widest">Audio Playback</p>
                    </div>
                    <audio
                      src={mediaSrc}
                      controls
                      className="w-full h-8 mt-2 accent-oca-verdigris"
                    />
                  </div>
                )}

                {isVideo && (
                  <div className="w-full h-full flex flex-col items-center justify-center relative">
                    <video
                      src={mediaSrc}
                      controls
                      className="max-w-full max-h-full rounded-md object-contain"
                      poster=""
                    />
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          ) : (
            <div className="flex flex-col items-center gap-2 text-white/40">
              <span className="w-2.5 h-2.5 rounded-full border-t-2 border-r-2 border-white animate-spin" />
              <span className="text-[10px] font-bold uppercase tracking-wider">Loading critique attachment...</span>
            </div>
          )}
        </div>

        {/* Floating Indicator banner */}
        <div className="absolute bottom-2 left-2 bg-black/65 backdrop-blur-xs text-white/90 text-[10px] font-bold px-2 py-1 rounded-md opacity-70 truncate max-w-[70%]">
          {currentFile.name}
        </div>
      </div>

      {/* Thumbnails list at bottom (if files count > 1) */}
      {files.length > 1 && (
        <div className="flex items-center gap-1.5 mt-2 overflow-x-auto pb-1 scrollbar-none">
          {files.map((file, idx) => {
            const isSel = idx === currentIndex;
            const itemSrc = file.data ? `data:${file.mimeType};base64,${file.data}` : "";
            const isImg = file.mimeType.startsWith("image/");
            const isAud = file.mimeType.startsWith("audio/");
            const isVid = file.mimeType.startsWith("video/");

            return (
              <button
                key={idx}
                onClick={() => setCurrentIndex(idx)}
                className={`relative flex-shrink-0 w-10 h-10 rounded-md border-2 overflow-hidden bg-gray-900 transition-all ${
                  isSel ? "border-oca-verdigris scale-95 shadow-sm" : "border-transparent hover:border-gray-300 opacity-60 hover:opacity-100"
                }`}
              >
                {file.data ? (
                  isImg ? (
                    <img src={itemSrc} alt="" className="w-full h-full object-cover" />
                  ) : isAud ? (
                    <div className="w-full h-full flex items-center justify-center bg-gray-800 text-amber-500">
                      <FileAudio size={14} />
                    </div>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-gray-800 text-blue-400">
                      <Video size={14} />
                    </div>
                  )
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-gray-850">
                    <div className="w-2 h-2 rounded-full border border-t-transparent border-white animate-spin" />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Fullscreen Image Lightbox Modal */}
      <AnimatePresence>
        {activeImage && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999] bg-black/95 flex flex-col justify-between p-4"
            onClick={() => setActiveImage(null)}
          >
            {/* Top Toolbar */}
            <div className="flex items-center justify-between text-white bg-black/40 backdrop-blur-xs p-3 rounded-xl max-w-4xl mx-auto w-full" onClick={(e) => e.stopPropagation()}>
              <span className="text-xs font-bold truncate max-w-[60%]">{activeImage.name}</span>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setZoomScale((prev) => Math.max(1, prev - 0.25))}
                  className="p-1.5 hover:bg-white/10 rounded-lg transition-colors"
                  title="Zoom Out"
                >
                  <ZoomOut size={16} />
                </button>
                <span className="text-[10px] font-mono font-bold w-10 text-center">
                  {Math.round(zoomScale * 100)}%
                </span>
                <button
                  onClick={() => setZoomScale((prev) => Math.min(3, prev + 0.25))}
                  className="p-1.5 hover:bg-white/10 rounded-lg transition-colors"
                  title="Zoom In"
                >
                  <ZoomIn size={16} />
                </button>
                <div className="w-px h-5 bg-white/10 mx-1" />
                <button
                  onClick={() => handleDownload(activeImage.src, activeImage.name)}
                  className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-oca-verdigris"
                  title="Download Image"
                >
                  <Download size={16} />
                </button>
                <button
                  onClick={() => setActiveImage(null)}
                  className="p-1.5 hover:bg-white/10 rounded-lg text-red-400 transition-colors"
                  title="Close Lightbox"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Img Box */}
            <div className="flex-1 flex items-center justify-center p-2 relative overflow-hidden" onClick={() => setActiveImage(null)}>
              <motion.img
                src={activeImage.src}
                alt=""
                style={{ scale: zoomScale }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="max-w-full max-h-full object-contain rounded shadow-2xl cursor-grab active:cursor-grabbing"
                onClick={(e) => e.stopPropagation()}
              />
            </div>

            {/* Empty Footer for alignment */}
            <div className="h-10" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
