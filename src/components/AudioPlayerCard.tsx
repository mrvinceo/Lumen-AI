import React, { useState, useRef, useEffect } from "react";
import { Play, Pause, Download, Volume2, VolumeX, FileAudio, RotateCcw } from "lucide-react";

export interface AudioPlayerProps {
  title: string;
  audioUrl: string;
  durationSeconds?: number;
  wordCount?: number;
  voiceName?: string;
  className?: string;
  compact?: boolean;
}

export function AudioPlayerCard({
  title,
  audioUrl,
  durationSeconds = 0,
  wordCount,
  voiceName,
  className = "",
  compact = false
}: AudioPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationSeconds);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleLoadedMetadata = () => {
      if (audio.duration && !isNaN(audio.duration)) {
        setDuration(Math.round(audio.duration));
      }
      setIsLoaded(true);
    };
    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [audioUrl]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().catch(e => console.warn("Audio play blocked:", e));
      setIsPlaying(true);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = parseFloat(e.target.value);
    setCurrentTime(newTime);
    if (audioRef.current) {
      audioRef.current.currentTime = newTime;
    }
  };

  const toggleSpeed = () => {
    const speeds = [1, 1.25, 1.5, 2];
    const nextIdx = (speeds.indexOf(playbackRate) + 1) % speeds.length;
    const nextSpeed = speeds[nextIdx];
    setPlaybackRate(nextSpeed);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextSpeed;
    }
  };

  const toggleMute = () => {
    if (!audioRef.current) return;
    audioRef.current.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  const restartAudio = () => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = 0;
    setCurrentTime(0);
  };

  const formatTime = (secs: number) => {
    if (isNaN(secs) || secs < 0) return "0:00";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div
      className={`rounded-2xl border border-slate-200 bg-white shadow-xs p-4 transition-all ${className}`}
    >
      <audio ref={audioRef} src={audioUrl} preload="metadata" />

      {/* Header Info */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="w-9 h-9 rounded-xl bg-oca-blue-tint text-oca-blue flex items-center justify-center flex-shrink-0 shadow-xs border border-oca-blue/15">
            <FileAudio size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="text-xs font-bold text-slate-900 truncate" title={title}>
              {title}
            </h4>
            <div className="flex items-center gap-2 text-[10px] text-slate-500 font-medium mt-0.5">
              {voiceName && <span>{voiceName}</span>}
              {voiceName && wordCount && <span aria-hidden="true">·</span>}
              {wordCount && <span>{wordCount.toLocaleString()} words</span>}
              {(voiceName || wordCount) && <span aria-hidden="true">·</span>}
              <span className="font-mono tabular-nums">{formatTime(duration)}</span>
            </div>
          </div>
        </div>

        {/* Download action */}
        <a
          href={audioUrl}
          download={title.replace(/[^a-zA-Z0-9_-]/g, "_") + ".mp3"}
          className="p-1.5 text-slate-500 hover:text-oca-blue hover:bg-slate-50 rounded-lg transition-colors flex items-center gap-1 text-[11px] font-semibold flex-shrink-0 border border-slate-100"
          title="Download MP3"
        >
          <Download size={13} />
          <span className="hidden sm:inline">MP3</span>
        </a>
      </div>

      {/* Controls and Track */}
      <div className="space-y-2">
        {/* Scrubber slider */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tabular-nums text-slate-500 min-w-[28px] text-right">
            {formatTime(currentTime)}
          </span>
          <input
            type="range"
            min={0}
            max={duration || 100}
            value={currentTime}
            onChange={handleSeek}
            className="flex-1 h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-oca-blue focus:outline-none"
            aria-label="Audio progress slider"
          />
          <span className="text-[10px] font-mono tabular-nums text-slate-500 min-w-[28px]">
            {formatTime(duration)}
          </span>
        </div>

        {/* Buttons Bar */}
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-1.5">
            {/* Play / Pause button */}
            <button
              type="button"
              onClick={togglePlay}
              className="w-8 h-8 rounded-full bg-oca-blue text-white flex items-center justify-center hover:bg-oca-blue/90 active:scale-95 shadow-xs transition-all cursor-pointer"
              title={isPlaying ? "Pause" : "Play"}
              aria-label={isPlaying ? "Pause audio" : "Play audio"}
            >
              {isPlaying ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
            </button>

            {/* Restart */}
            <button
              type="button"
              onClick={restartAudio}
              className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-50 rounded-lg transition-colors"
              title="Restart from beginning"
              aria-label="Restart audio from beginning"
            >
              <RotateCcw size={13} />
            </button>

            {/* Mute toggle */}
            <button
              type="button"
              onClick={toggleMute}
              className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-50 rounded-lg transition-colors"
              title={isMuted ? "Unmute" : "Mute"}
              aria-label={isMuted ? "Unmute audio" : "Mute audio"}
            >
              {isMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </button>
          </div>

          {/* Speed switcher */}
          <button
            type="button"
            onClick={toggleSpeed}
            className="px-2 py-0.5 rounded-md text-[10px] font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors tabular-nums border border-slate-200/60"
            title="Change playback speed"
          >
            {playbackRate}x
          </button>
        </div>
      </div>
    </div>
  );
}
