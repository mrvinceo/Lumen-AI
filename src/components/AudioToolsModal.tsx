import React, { useState, useEffect, useRef } from "react";
import {
  X,
  FileAudio,
  Upload,
  Volume2,
  Square,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Sparkles,
  Trash2,
  Download,
  Info
} from "lucide-react";
import { AudioPlayerCard } from "./AudioPlayerCard";
import { db } from "../firebase";
import { collection, query, where, getDocs, doc, setDoc, deleteDoc } from "firebase/firestore";

export interface VoiceOption {
  id: string;
  name: string;
  displayName: string;
  gender: "MALE" | "FEMALE";
  style: "Neural2" | "Journey";
  accent: string;
  tone: string;
  sampleText: string;
}

export interface AudioQuotaInfo {
  allowed: boolean;
  isStaff: boolean;
  dailyUsed: number;
  dailyLimit: number;
  monthlyUsed: number;
  monthlyLimit: number;
  dailyRemaining: number;
  monthlyRemaining: number;
  reason?: string;
}

export interface AudioDocumentItem {
  id: string;
  userId: string;
  fileName: string;
  fileType: string;
  wordCount: number;
  voiceId: string;
  voiceName: string;
  audioUrl: string;
  durationSeconds: number;
  createdAt: string;
}

interface AudioToolsModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  userEmail?: string;
  isStaff?: boolean;
  onAudioGeneratedForChat?: (audioDoc: AudioDocumentItem) => void;
}

const DEFAULT_VOICES: VoiceOption[] = [
  {
    id: "en-GB-Neural2-B",
    name: "Oliver",
    displayName: "Oliver (UK Male · Neural2)",
    gender: "MALE",
    style: "Neural2",
    accent: "British (UK)",
    tone: "Clear, academic, and well-paced",
    sampleText: "Hello! I am Oliver, one of the UK voices available for converting your course documents into speech."
  },
  {
    id: "en-GB-Neural2-A",
    name: "Charlotte",
    displayName: "Charlotte (UK Female · Neural2)",
    gender: "FEMALE",
    style: "Neural2",
    accent: "British (UK)",
    tone: "Articulate, natural, and engaging RP",
    sampleText: "Welcome. I am Charlotte. I can read your study materials, lecture summaries, and essays clearly."
  },
  {
    id: "en-GB-Journey-D",
    name: "George",
    displayName: "George (UK Male · Journey)",
    gender: "MALE",
    style: "Journey",
    accent: "British (UK)",
    tone: "Warm, conversational, and natural pacing",
    sampleText: "Hi there, I am George. My voice is designed to sound natural and conversational for long listening sessions."
  },
  {
    id: "en-GB-Journey-F",
    name: "Eleanor",
    displayName: "Eleanor (UK Female · Journey)",
    gender: "FEMALE",
    style: "Journey",
    accent: "British (UK)",
    tone: "Warm, empathetic, and expressive",
    sampleText: "Good day. I am Eleanor. I bring an expressive, warm tone to readings, articles, and research papers."
  },
  {
    id: "en-GB-Neural2-D",
    name: "Arthur",
    displayName: "Arthur (UK Male · Deep Tone)",
    gender: "MALE",
    style: "Neural2",
    accent: "British (UK)",
    tone: "Deep, resonant, and authoritative",
    sampleText: "Greetings. I am Arthur. I provide a calm, deep, and measured reading of formal texts and policies."
  }
];

export function AudioToolsModal({
  isOpen,
  onClose,
  userId,
  userEmail,
  isStaff = false,
  onAudioGeneratedForChat
}: AudioToolsModalProps) {
  const [activeTab, setActiveTab] = useState<"convert" | "history">("convert");
  const [voices, setVoices] = useState<VoiceOption[]>(DEFAULT_VOICES);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>("en-GB-Neural2-B");
  const [quota, setQuota] = useState<AudioQuotaInfo | null>(null);
  const [history, setHistory] = useState<AudioDocumentItem[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // File and conversion states
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileBase64, setFileBase64] = useState<string | null>(null);
  const [wordCount, setWordCount] = useState<number | null>(null);
  const [isCountingWords, setIsCountingWords] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [convertProgress, setConvertProgress] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [completedDoc, setCompletedDoc] = useState<AudioDocumentItem | null>(null);

  // Sample voice preview player state
  const [playingSampleId, setPlayingSampleId] = useState<string | null>(null);
  const sampleAudioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Fetch voices and quota on open
  useEffect(() => {
    if (!isOpen) {
      stopSampleAudio();
      return;
    }

    fetchQuota();
    fetchVoices();
    fetchHistory();
  }, [isOpen, userId, userEmail, isStaff]);

  const fetchVoices = async () => {
    try {
      const res = await fetch("/api/audio-tools/voices");
      const data = await res.json();
      if (data.success && Array.isArray(data.voices) && data.voices.length > 0) {
        setVoices(data.voices);
      }
    } catch (e) {
      console.warn("Could not load dynamic voices, using defaults:", e);
    }
  };

  const fetchQuota = async () => {
    if (!userId) return;
    try {
      const params = new URLSearchParams({
        userId,
        email: userEmail || "",
        isStaff: isStaff ? "true" : "false"
      });
      const res = await fetch(`/api/audio-tools/quota?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setQuota(data);
      }
    } catch (e) {
      console.warn("Could not load audio quota:", e);
    }
  };

  const fetchHistory = async () => {
    if (!userId) return;
    setLoadingHistory(true);
    try {
      const itemsMap = new Map<string, AudioDocumentItem>();

      // 1. Fetch from server endpoint (backed by local persistent store)
      try {
        const res = await fetch(`/api/audio-tools/history?userId=${encodeURIComponent(userId)}`);
        const data = await res.json();
        if (data.success && Array.isArray(data.history)) {
          data.history.forEach((d: AudioDocumentItem) => itemsMap.set(d.id, d));
        }
      } catch (e) {
        console.warn("Could not load server audio history:", e);
      }

      // 2. Fetch from client Firestore if authenticated
      try {
        const q = query(collection(db, "audio_documents"), where("userId", "==", userId));
        const snap = await getDocs(q);
        snap.forEach(d => {
          itemsMap.set(d.id, { id: d.id, ...d.data() } as AudioDocumentItem);
        });
      } catch (fe) {
        // Safe to ignore client firestore errors
      }

      const combined = Array.from(itemsMap.values()).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setHistory(combined);
    } finally {
      setLoadingHistory(false);
    }
  };

  const stopSampleAudio = () => {
    if (sampleAudioRef.current) {
      sampleAudioRef.current.pause();
      sampleAudioRef.current.currentTime = 0;
    }
    setPlayingSampleId(null);
  };

  const handleTogglePlaySample = (voiceId: string) => {
    if (playingSampleId === voiceId) {
      stopSampleAudio();
      return;
    }

    stopSampleAudio();
    setPlayingSampleId(voiceId);

    const audioUrl = `/api/audio-tools/sample/${voiceId}`;
    const audio = new Audio(audioUrl);
    sampleAudioRef.current = audio;

    audio.onended = () => {
      setPlayingSampleId(null);
    };

    audio.onerror = () => {
      console.warn("Failed to play voice sample audio");
      setPlayingSampleId(null);
    };

    audio.play().catch(err => {
      console.warn("Sample audio play blocked:", err);
      setPlayingSampleId(null);
    });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    processSelectedFile(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    processSelectedFile(file);
  };

  const processSelectedFile = (file: File) => {
    setErrorMsg(null);
    setCompletedDoc(null);

    const validExtensions = [".pdf", ".docx", ".txt", ".md"];
    const ext = "." + (file.name.split(".").pop() || "").toLowerCase();

    if (!validExtensions.includes(ext)) {
      setErrorMsg("Please upload a PDF, DOCX, or TXT document.");
      return;
    }

    setSelectedFile(file);
    setIsCountingWords(true);

    const reader = new FileReader();
    reader.onload = async () => {
      const base64Str = reader.result as string;
      setFileBase64(base64Str);

      // For plain text, count in browser immediately
      if (ext === ".txt" || ext === ".md") {
        try {
          const text = atob(base64Str.split(",")[1]);
          const words = text.trim().split(/\s+/).filter(Boolean).length;
          setWordCount(words);
          setIsCountingWords(false);
          return;
        } catch {
          // fallback to server inspection
        }
      }

      // For PDF and DOCX, call server inspection to parse actual text and count real words
      try {
        const inspectRes = await fetch("/api/audio-tools/inspect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileBase64: base64Str,
            fileName: file.name,
            mimeType: file.type
          })
        });

        const inspectData = await inspectRes.json().catch(() => ({}));
        if (inspectRes.ok && inspectData.success && typeof inspectData.wordCount === "number") {
          setWordCount(inspectData.wordCount);
          if (inspectData.wordCount > 30000) {
            setErrorMsg(`Document has ~${inspectData.wordCount.toLocaleString()} words (exceeds the 30,000 maximum limit).`);
          }
        } else {
          console.warn("Inspect failed:", inspectData);
          if (inspectData.error) {
            setErrorMsg(inspectData.error);
          }
        }
      } catch (inspectErr: any) {
        console.warn("Could not inspect document on server:", inspectErr);
        setErrorMsg("Failed to analyze document words: " + (inspectErr?.message || "Network error"));
      } finally {
        setIsCountingWords(false);
      }
    };

    reader.onerror = () => {
      setErrorMsg("Could not read file. Please try again.");
      setIsCountingWords(false);
    };

    reader.readAsDataURL(file);
  };

  const handleStartConversion = async () => {
    if (!selectedFile || !fileBase64 || !userId) {
      setErrorMsg("Please select a document file first.");
      return;
    }

    if (quota && !quota.allowed) {
      setErrorMsg(quota.reason || "Quota limit reached for today.");
      return;
    }

    if (wordCount && wordCount > 30000) {
      setErrorMsg("Document exceeds the maximum limit of 30,000 words.");
      return;
    }

    setIsConverting(true);
    setErrorMsg(null);
    setConvertProgress("Extracting text from document...");

    try {
      const selectedVoice = voices.find(v => v.id === selectedVoiceId) || voices[0];

      // Simulated step notification while server runs chunking & TTS
      const progressTimer = setTimeout(() => {
        setConvertProgress(`Synthesizing with ${selectedVoice.name} (Google Cloud TTS)...`);
      }, 1500);

      const progressTimer2 = setTimeout(() => {
        setConvertProgress("Processing chunks and compiling final audio stream...");
      }, 5000);

      const res = await fetch("/api/audio-tools/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileBase64,
          fileName: selectedFile.name,
          mimeType: selectedFile.type,
          voiceId: selectedVoiceId,
          userId,
          userEmail: userEmail || "",
          isStaff
        })
      });

      clearTimeout(progressTimer);
      clearTimeout(progressTimer2);

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to convert document to audio");
      }

      const newDoc: AudioDocumentItem = {
        id: data.id,
        userId,
        fileName: data.fileName,
        fileType: data.fileName.split(".").pop() || "doc",
        wordCount: data.wordCount,
        voiceId: selectedVoiceId,
        voiceName: data.voiceName,
        audioUrl: data.audioUrl,
        durationSeconds: data.durationSeconds,
        createdAt: new Date().toISOString()
      };

      setCompletedDoc(newDoc);

      // Save to client Firestore in background if authenticated
      try {
        await setDoc(doc(db, "audio_documents", newDoc.id), newDoc);
      } catch (fe) {
        // Safe to ignore if offline or guest
      }

      // Refresh quota and history
      fetchQuota();
      fetchHistory();

      // Automatically notify parent chat if callback provided
      if (onAudioGeneratedForChat) {
        onAudioGeneratedForChat(newDoc);
      }
    } catch (err: any) {
      setErrorMsg(err.message || "An error occurred during audio generation.");
    } finally {
      setIsConverting(false);
      setConvertProgress("");
    }
  };

  const handleDeleteHistoryItem = async (docId: string) => {
    if (!confirm("Are you sure you want to delete this audio document?")) return;

    try {
      // 1. Delete on server (removes local file and local store record)
      const res = await fetch(`/api/audio-tools/history/${docId}?userId=${encodeURIComponent(userId)}`, {
        method: "DELETE"
      });

      // 2. Delete on client Firestore
      try {
        await deleteDoc(doc(db, "audio_documents", docId));
      } catch (fe) {
        // Safe
      }

      setHistory(prev => prev.filter(item => item.id !== docId));
    } catch (e) {
      console.warn("Failed to delete audio document:", e);
    }
  };

  const handleResetForm = () => {
    setSelectedFile(null);
    setFileBase64(null);
    setWordCount(null);
    setCompletedDoc(null);
    setErrorMsg(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/60 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-oca-blue text-white flex items-center justify-center shadow-xs">
              <Sparkles size={18} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-slate-900">Document to Audio Converter</h3>
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-100/70 text-emerald-800">
                  Google TTS
                </span>
              </div>
              <p className="text-xs text-slate-500">
                Transform PDF or DOCX materials into natural UK speech
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full transition-colors"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="px-6 pt-3 flex items-center justify-between border-b border-slate-100 flex-shrink-0 bg-white">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setActiveTab("convert")}
              className={`pb-2.5 text-xs font-bold transition-all relative ${
                activeTab === "convert"
                  ? "text-oca-blue border-b-2 border-oca-blue"
                  : "text-slate-400 hover:text-slate-600"
              }`}
            >
              Convert Document
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("history")}
              className={`pb-2.5 text-xs font-bold transition-all relative flex items-center gap-1.5 ${
                activeTab === "history"
                  ? "text-oca-blue border-b-2 border-oca-blue"
                  : "text-slate-400 hover:text-slate-600"
              }`}
            >
              <span>My Audio Files</span>
              {history.length > 0 && (
                <span className="text-[10px] bg-slate-100 text-slate-600 font-mono px-1.5 py-0.2 rounded-full">
                  {history.length}
                </span>
              )}
            </button>
          </div>

          {/* Quota Status Pill */}
          <div className="pb-2">
            {quota?.isStaff ? (
              <span className="text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-200/80 px-2 py-0.5 rounded-full">
                Staff Access · Unlimited
              </span>
            ) : quota ? (
              <div className="text-[10px] text-slate-500 font-medium flex items-center gap-1.5">
                <span>
                  Today:{" "}
                  <strong className="text-slate-700">
                    {quota.dailyUsed} / {quota.dailyLimit}
                  </strong>
                </span>
                <span>·</span>
                <span>
                  Month:{" "}
                  <strong className="text-slate-700">
                    {quota.monthlyUsed} / {quota.monthlyLimit}
                  </strong>
                </span>
              </div>
            ) : null}
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-5">
          {activeTab === "convert" ? (
            <>
              {/* Completed State Display */}
              {completedDoc ? (
                <div className="space-y-4 animate-in fade-in duration-300">
                  <div className="p-4 bg-emerald-50/70 border border-emerald-200/80 rounded-2xl flex items-start gap-3">
                    <CheckCircle2 size={20} className="text-emerald-600 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <h4 className="text-xs font-bold text-emerald-950">Audio Ready!</h4>
                      <p className="text-xs text-emerald-800 mt-0.5">
                        Your document was synthesized using Google Cloud TTS and is ready to stream or download.
                      </p>
                    </div>
                  </div>

                  {/* Playable Card */}
                  <AudioPlayerCard
                    title={completedDoc.fileName}
                    audioUrl={completedDoc.audioUrl}
                    durationSeconds={completedDoc.durationSeconds}
                    wordCount={completedDoc.wordCount}
                    voiceName={completedDoc.voiceName}
                  />

                  {/* Action buttons */}
                  <div className="flex items-center gap-3 pt-2">
                    <button
                      type="button"
                      onClick={handleResetForm}
                      className="flex-1 py-2.5 px-4 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 hover:bg-slate-50 transition-all text-center"
                    >
                      Convert Another Document
                    </button>
                    <button
                      type="button"
                      onClick={onClose}
                      className="flex-1 py-2.5 px-4 rounded-xl bg-oca-blue text-white text-xs font-bold hover:bg-oca-blue/90 transition-all text-center shadow-xs"
                    >
                      Return to Chat
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Error Notification */}
                  {errorMsg && (
                    <div className="p-3 bg-red-50 border border-red-200/80 rounded-xl flex items-start gap-2.5 text-xs text-red-800">
                      <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
                      <div className="flex-1">{errorMsg}</div>
                    </div>
                  )}

                  {/* File Upload Box */}
                  <div>
                    <label className="block text-xs font-bold text-slate-800 mb-1.5">
                      1. Select Document (PDF, DOCX, TXT)
                    </label>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.docx,.txt,.md"
                      onChange={handleFileChange}
                      className="hidden"
                    />

                    {!selectedFile ? (
                      <div
                        onDragOver={e => e.preventDefault()}
                        onDrop={handleDrop}
                        onClick={() => fileInputRef.current?.click()}
                        className="border-2 border-dashed border-slate-200 hover:border-oca-blue/50 bg-slate-50/50 hover:bg-slate-50 rounded-2xl p-6 text-center cursor-pointer transition-all flex flex-col items-center justify-center gap-2 group"
                      >
                        <div className="w-10 h-10 rounded-full bg-white shadow-xs border border-slate-200/80 flex items-center justify-center text-slate-400 group-hover:text-oca-blue transition-colors">
                          <Upload size={18} />
                        </div>
                        <div>
                          <p className="text-xs font-bold text-slate-700">
                            Click to upload or drag & drop document
                          </p>
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            Supports PDF, Word (.docx), and Plain Text up to 30,000 words
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-2xl flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className="w-9 h-9 rounded-xl bg-white text-oca-blue flex items-center justify-center border border-slate-200 flex-shrink-0">
                            <FileAudio size={18} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-bold text-slate-900 truncate" title={selectedFile.name}>
                              {selectedFile.name}
                            </p>
                            <div className="flex items-center gap-2 text-[11px] text-slate-500 font-medium mt-0.5">
                              <span>{(selectedFile.size / 1024).toFixed(0)} KB</span>
                              <span>·</span>
                              {isCountingWords ? (
                                <span className="flex items-center gap-1 text-slate-400">
                                  <Loader2 size={10} className="animate-spin" /> Counting words...
                                </span>
                              ) : (
                                <span>{wordCount !== null ? `${wordCount.toLocaleString()} words` : "Document ready"}</span>
                              )}
                              <span>·</span>
                              <span className="flex items-center gap-0.5 text-slate-600">
                                <Clock size={11} /> ~{Math.round((wordCount || 0) / 140)} min audio
                              </span>
                            </div>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={handleResetForm}
                          className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-white rounded-lg transition-colors flex-shrink-0"
                          title="Remove file"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    )}

                    {/* Word limit warning if > 30,000 */}
                    {wordCount && wordCount > 30000 && (
                      <div className="mt-2 text-[11px] text-amber-700 bg-amber-50 p-2.5 rounded-xl border border-amber-200 flex items-center gap-2">
                        <AlertCircle size={14} className="text-amber-600 flex-shrink-0" />
                        <span>
                          Document has ~{wordCount.toLocaleString()} words (exceeds the 30,000 maximum limit).
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Voice Selection */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="block text-xs font-bold text-slate-800">
                        2. Choose UK Voice (5 Accents)
                      </label>
                      <span className="text-[10px] text-slate-400 flex items-center gap-1">
                        <Info size={11} /> Click sample to hear preview
                      </span>
                    </div>

                    <div className="space-y-2">
                      {voices.map(voice => {
                        const isSelected = selectedVoiceId === voice.id;
                        const isPlayingThisSample = playingSampleId === voice.id;

                        return (
                          <div
                            key={voice.id}
                            onClick={() => setSelectedVoiceId(voice.id)}
                            className={`p-3 rounded-2xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                              isSelected
                                ? "border-oca-blue bg-oca-blue-tint/30 shadow-xs"
                                : "border-slate-200 hover:border-slate-300 bg-white"
                            }`}
                          >
                            <div className="flex items-center gap-3 min-w-0 flex-1">
                              {/* Custom Radio check */}
                              <div
                                className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                                  isSelected
                                    ? "border-oca-blue bg-oca-blue"
                                    : "border-slate-300 bg-white"
                                }`}
                              >
                                {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                              </div>

                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-bold text-slate-900">
                                    {voice.name}
                                  </span>
                                  <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.2 rounded-full bg-slate-100 text-slate-600">
                                    {voice.gender === "MALE" ? "Male" : "Female"}
                                  </span>
                                  <span className="text-[9px] font-medium text-slate-500">
                                    {voice.style}
                                  </span>
                                </div>
                                <p className="text-[11px] text-slate-500 truncate mt-0.5">
                                  {voice.tone}
                                </p>
                              </div>
                            </div>

                            {/* Listen Sample Button */}
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation();
                                handleTogglePlaySample(voice.id);
                              }}
                              className={`px-2.5 py-1.5 rounded-xl text-[11px] font-semibold flex items-center gap-1.5 transition-all flex-shrink-0 ${
                                isPlayingThisSample
                                  ? "bg-oca-blue text-white shadow-xs"
                                  : "bg-slate-100 hover:bg-slate-200 text-slate-700"
                              }`}
                              title={isPlayingThisSample ? "Stop preview" : "Listen to voice preview"}
                            >
                              {isPlayingThisSample ? (
                                <>
                                  <Square size={11} className="fill-current" />
                                  <span>Stop</span>
                                </>
                              ) : (
                                <>
                                  <Volume2 size={12} />
                                  <span>Sample</span>
                                </>
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Convert Button */}
                  <div className="pt-2">
                    <button
                      type="button"
                      disabled={
                        !selectedFile ||
                        isConverting ||
                        (quota !== null && !quota.allowed) ||
                        Boolean(wordCount && wordCount > 30000)
                      }
                      onClick={handleStartConversion}
                      className="w-full py-3 px-4 rounded-2xl bg-oca-blue hover:bg-oca-blue/95 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-xs shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer"
                    >
                      {isConverting ? (
                        <>
                          <Loader2 size={15} className="animate-spin" />
                          <span>{convertProgress || "Generating Audio..."}</span>
                        </>
                      ) : (
                        <>
                          <Sparkles size={15} />
                          <span>Generate Audio Document</span>
                        </>
                      )}
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            /* History / My Audio Files Tab */
            <div className="space-y-3">
              {loadingHistory ? (
                <div className="py-12 text-center text-slate-400">
                  <Loader2 size={24} className="animate-spin mx-auto mb-2 text-oca-blue" />
                  <p className="text-xs">Loading your audio files...</p>
                </div>
              ) : history.length === 0 ? (
                <div className="py-12 text-center text-slate-400 border-2 border-dashed border-slate-200 rounded-3xl">
                  <FileAudio size={32} className="mx-auto mb-2 text-slate-300" />
                  <p className="text-xs font-bold text-slate-600">No Audio Documents Yet</p>
                  <p className="text-[11px] text-slate-400 mt-1 max-w-xs mx-auto">
                    Upload a PDF or Word document in the Convert tab to generate your first spoken audio file.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {history.map(item => (
                    <div
                      key={item.id}
                      className="p-3 bg-slate-50 border border-slate-200/80 rounded-2xl space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-bold text-slate-900 truncate" title={item.fileName}>
                            {item.fileName}
                          </p>
                          <p className="text-[10px] text-slate-500 font-medium">
                            {item.voiceName} · {item.wordCount.toLocaleString()} words ·{" "}
                            {new Date(item.createdAt).toLocaleDateString([], {
                              day: "numeric",
                              month: "short"
                            })}
                          </p>
                        </div>

                        <div className="flex items-center gap-1 flex-shrink-0">
                          <a
                            href={item.audioUrl}
                            download={item.fileName.replace(/[^a-zA-Z0-9_-]/g, "_") + ".mp3"}
                            className="p-1.5 text-slate-500 hover:text-oca-blue hover:bg-white rounded-lg transition-colors"
                            title="Download MP3"
                          >
                            <Download size={14} />
                          </a>
                          <button
                            type="button"
                            onClick={() => handleDeleteHistoryItem(item.id)}
                            className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-white rounded-lg transition-colors"
                            title="Delete file"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>

                      {/* Compact embedded player */}
                      <AudioPlayerCard
                        title={item.fileName}
                        audioUrl={item.audioUrl}
                        durationSeconds={item.durationSeconds}
                        wordCount={item.wordCount}
                        compact={true}
                        className="bg-white border-slate-100 shadow-none p-2.5"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
