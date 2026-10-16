import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { MessageCircle, X, Send, Paperclip, Loader2, User, Image as ImageIcon, FileAudio, Palette, BookOpen, ExternalLink, Bot, Edit2, Check, History, Plus } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { chatWithLumen, getMultimodalFeedback, generateSessionTitle } from "../lib/gemini";
import { searchChunks } from "../lib/vector";
import { compressImage } from "../lib/imageProcessing";
import { db, auth } from "../firebase";
import { collection, addDoc, query, where, orderBy, onSnapshot, serverTimestamp, getDocs, limit, doc, updateDoc, getDoc, Timestamp } from "firebase/firestore";
import { signInAnonymously, GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";
import ReactMarkdown from "react-markdown";
import { BotAvatar, OCALogoCircle } from "./BrandAssets";
import { LogIn, LogOut } from "lucide-react";
import { saveCachedFile, getCachedFile, getMsgTimeKey } from "../lib/mediaCache";
import MediaCarousel from "./MediaCarousel";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface Message {
  id?: string;
  role: "user" | "model";
  parts: { text: string }[];
  createdAt?: any;
  files?: { data: string; mimeType: string; name: string }[];
  themeName?: string;
  sources?: { fileName: string; text: string; unit?: string; url?: string }[];
}

interface FeedbackTheme {
  id: string;
  name: string;
  prompt: string;
}

interface Persona {
  id: string;
  persona_id: string;
  display_name: string;
  system_prompt: string;
  greeting_message?: string;
  icon?: string;
}

function MessageFilesAndCarousel({ msg, previousMsg }: { msg: Message; previousMsg?: Message }) {
  const [resolvedFiles, setResolvedFiles] = useState<any[]>([]);

  const filesToLoad = msg.files && msg.files.length > 0 
    ? msg.files 
    : (msg.role === "model" && previousMsg && previousMsg.files && previousMsg.files.length > 0)
      ? previousMsg.files
      : null;

  const targetMsgForTimeKey = msg.files && msg.files.length > 0 
    ? msg 
    : (msg.role === "model" && previousMsg && previousMsg.files && previousMsg.files.length > 0)
      ? previousMsg
      : null;

  useEffect(() => {
    if (!filesToLoad || !targetMsgForTimeKey) {
      setResolvedFiles([]);
      return;
    }

    const loadFiles = async () => {
      const timeKey = getMsgTimeKey(targetMsgForTimeKey);
      const msgId = targetMsgForTimeKey.id;

      const loaded = await Promise.all(
        filesToLoad.map(async (file, idx) => {
          if (file.data) return file;

          // Attempt loading by unique Firebase document ID first
          if (msgId) {
            const cachedById = await getCachedFile(`${msgId}_${idx}`);
            if (cachedById && cachedById.data) {
              return { ...file, data: cachedById.data };
            }
          }

          // Fallback to checking the timeKey if the ID lookup didn't succeed
          if (timeKey) {
            const cached = await getCachedFile(`${timeKey}_${idx}`);
            if (cached && cached.data) {
              return { ...file, data: cached.data };
            }
          }

          return file;
        })
      );
      setResolvedFiles(loaded);
    };

    loadFiles();
  }, [filesToLoad, targetMsgForTimeKey]);

  if (resolvedFiles.length === 0) return null;

  const isModelFeedback = msg.role === "model";
  const title = isModelFeedback ? "Critiqued Media" : "Uploaded Artwork / Media";

  return (
    <div className="mt-3">
      <MediaCarousel files={resolvedFiles} title={title} />
    </div>
  );
}

export default function ChatWidget({ forceOpen = false, isWidget = false }: { forceOpen?: boolean; isWidget?: boolean }) {
  const [isOpen, setIsOpen] = useState(forceOpen);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isProcessingFiles, setIsProcessingFiles] = useState(false);
  const [unit, setUnit] = useState<string | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(null);
  const [activePersona, setActivePersona] = useState<Persona | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [files, setFiles] = useState<{ data: string; mimeType: string; name: string }[]>([]);
  const [themes, setThemes] = useState<FeedbackTheme[]>([]);
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [mediaEnabled, setMediaEnabled] = useState(true);
  const [personasEnabled, setPersonasEnabled] = useState(true);
  
  // Session management states
  const [sessions, setSessions] = useState<any[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [currentSession, setCurrentSession] = useState<any | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState("");
  const [isSessionHistoryOpen, setIsSessionHistoryOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const getTodayDateKey = () => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  const loadSessionMessages = async (uid: string, sessionId: string) => {
    try {
      let targetDateKey: string | null = null;
      if (sessionId.startsWith("legacy-")) {
        targetDateKey = sessionId.replace("legacy-", "");
      } else {
        const sess = sessions.find(s => s.id === sessionId) || currentSession;
        if (sess?.dateKey) {
          targetDateKey = sess.dateKey;
        }
      }

      // 1. Fetch by sessionId
      const qSession = query(
        collection(db, "chat_history"),
        where("userId", "==", uid),
        where("sessionId", "==", sessionId)
      );
      const snapshotSession = await getDocs(qSession);
      let msgs = snapshotSession.docs.map(doc => ({ id: doc.id, ...doc.data() } as any));

      // 2. Fallback to date matching or legacy messages belonging to targetDateKey
      if (msgs.length === 0 || sessionId.startsWith("legacy-") || sessionId === "default") {
        const qRecent = query(
          collection(db, "chat_history"),
          where("userId", "==", uid),
          orderBy("createdAt", "desc"),
          limit(150)
        );
        const snapshotRecent = await getDocs(qRecent);
        const recentMsgs = snapshotRecent.docs.map(doc => ({ id: doc.id, ...doc.data() } as any));
        
        const extraMsgs = recentMsgs.filter(msg => {
          if (msg.sessionId === sessionId) return false;
          
          if (targetDateKey && (!msg.sessionId || msg.sessionId === "default")) {
            const msgDate = msg.createdAt?.toDate ? msg.createdAt.toDate() : new Date();
            const yyyy = msgDate.getFullYear();
            const mm = String(msgDate.getMonth() + 1).padStart(2, '0');
            const dd = String(msgDate.getDate()).padStart(2, '0');
            const msgDateKey = `${yyyy}-${mm}-${dd}`;
            return msgDateKey === targetDateKey;
          }
          return false;
        });
        
        const existingIds = new Set(msgs.map(m => m.id));
        extraMsgs.forEach(m => {
          if (!existingIds.has(m.id)) {
            msgs.push(m);
            existingIds.add(m.id);
          }
        });
      }

      msgs.sort((a, b) => {
        const timeA = a.createdAt?.seconds || 0;
        const timeB = b.createdAt?.seconds || 0;
        if (timeA !== timeB) return timeA - timeB;
        const nanoA = a.createdAt?.nanoseconds || 0;
        const nanoB = b.createdAt?.nanoseconds || 0;
        if (nanoA !== nanoB) return nanoA - nanoB;
        const fallbackA = a.createdAt?.getTime?.() || 0;
        const fallbackB = b.createdAt?.getTime?.() || 0;
        return fallbackA - fallbackB;
      });

      setMessages(msgs);
    } catch (err) {
      console.error("Error loading session messages:", err);
    }
  };

  const handleCreateOrFetchTodaySession = async (uid: string) => {
    try {
      const todayKey = getTodayDateKey();
      const sessionsRef = collection(db, "chat_sessions");
      
      const q = query(
        sessionsRef, 
        where("userId", "==", uid),
        where("dateKey", "==", todayKey)
      );
      
      const querySnapshot = await getDocs(q);
      
      if (!querySnapshot.empty) {
        const docSnap = querySnapshot.docs[0];
        const sessData = { id: docSnap.id, ...docSnap.data() };
        setCurrentSessionId(docSnap.id);
        setCurrentSession(sessData);
        await loadSessionMessages(uid, docSnap.id);
      } else {
        const formattedDate = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        const newSessionData = {
          userId: uid,
          title: `Session of ${formattedDate}`,
          dateKey: todayKey,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        };
        const docRef = await addDoc(sessionsRef, newSessionData);
        const sessData = { id: docRef.id, ...newSessionData };
        setCurrentSessionId(docRef.id);
        setCurrentSession(sessData);
        setMessages([]);
      }
    } catch (err) {
      console.error("Error creating/fetching today's session:", err);
    }
  };

  const handleCreateNewSessionExplicitly = async () => {
    if (!auth.currentUser) return;
    const uid = auth.currentUser.uid;
    const todayKey = getTodayDateKey();
    const sessionsRef = collection(db, "chat_sessions");
    
    const formattedDate = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const todaySessionsQuery = query(
      sessionsRef,
      where("userId", "==", uid),
      where("dateKey", "==", todayKey)
    );
    const snapshot = await getDocs(todaySessionsQuery);
    const count = snapshot.size;
    const sessionTitle = count > 0 ? `Session of ${formattedDate} (${count + 1})` : `Session of ${formattedDate}`;
    
    const newSessionData = {
      userId: uid,
      title: sessionTitle,
      dateKey: todayKey,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
    
    const docRef = await addDoc(sessionsRef, newSessionData);
    const sessData = { id: docRef.id, ...newSessionData };
    setCurrentSessionId(docRef.id);
    setCurrentSession(sessData);
    setMessages([]);
    setIsSessionHistoryOpen(false);
  };

  const handleSelectSession = async (sess: any) => {
    if (!auth.currentUser) return;
    setCurrentSessionId(sess.id);
    setCurrentSession(sess);
    await loadSessionMessages(auth.currentUser.uid, sess.id);
    setIsSessionHistoryOpen(false);
  };

  const handleSaveTitle = async () => {
    if (!currentSessionId || !editTitleValue.trim()) return;
    // Don't save real updates if it's virtual/legacy
    if (currentSessionId.startsWith("legacy-")) {
      setIsEditingTitle(false);
      return;
    }
    try {
      const sessionRef = doc(db, "chat_sessions", currentSessionId);
      await updateDoc(sessionRef, {
        title: editTitleValue.trim(),
        updatedAt: serverTimestamp()
      });
      setIsEditingTitle(false);
    } catch (err) {
      console.error("Error updating session title:", err);
    }
  };

  useEffect(() => {
    if (!auth.currentUser) return;
    
    let dbSessions: any[] = [];
    let dbLegacySessions: any[] = [];

    const rebuildSessions = () => {
      const combined = [...dbSessions];
      
      dbLegacySessions.forEach((legSess) => {
        const alreadyExists = combined.some(s => s.dateKey === legSess.dateKey);
        if (!alreadyExists) {
          combined.push(legSess);
        }
      });
      
      combined.sort((a: any, b: any) => {
        const t1 = a.createdAt?.seconds || a.createdAt?.getTime?.() || 0;
        const t2 = b.createdAt?.seconds || b.createdAt?.getTime?.() || 0;
        return t2 - t1; // Descending order
      });
      
      setSessions(combined);
    };

    const q = query(
      collection(db, "chat_sessions"),
      where("userId", "==", auth.currentUser.uid)
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      dbSessions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      rebuildSessions();
    }, (err) => {
      console.error("Error syncing sessions list:", err);
    });

    const fetchLegacyHistory = async () => {
      if (!auth.currentUser) return;
      try {
        const histQuery = query(
          collection(db, "chat_history"),
          where("userId", "==", auth.currentUser.uid),
          orderBy("createdAt", "desc"),
          limit(100)
        );
        const snapshot = await getDocs(histQuery);
        
        const grouped: Record<string, any> = {};
        snapshot.docs.forEach((doc) => {
          const data = doc.data();
          if (!data.sessionId || data.sessionId === "default") {
            const date = data.createdAt ? data.createdAt.toDate() : new Date();
            const yyyy = date.getFullYear();
            const mm = String(date.getMonth() + 1).padStart(2, '0');
            const dd = String(date.getDate()).padStart(2, '0');
            const dateKey = `${yyyy}-${mm}-${dd}`;
            
            if (!grouped[dateKey] || (data.createdAt?.seconds > (grouped[dateKey].createdAt?.seconds || 0))) {
              const formattedDate = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
              grouped[dateKey] = {
                id: `legacy-${dateKey}`,
                title: `Session of ${formattedDate}`,
                dateKey: dateKey,
                createdAt: data.createdAt || Timestamp.now(),
                isLegacy: true
              };
            }
          }
        });
        
        dbLegacySessions = Object.values(grouped);
        rebuildSessions();
      } catch (err) {
        console.error("Error loading legacy dates for ChatWidget:", err);
      }
    };
    fetchLegacyHistory();

    return () => unsubscribe();
  }, [auth.currentUser?.uid]);

  // Keep active session synchronized with updated sessions list
  useEffect(() => {
    if (currentSessionId && sessions.length > 0) {
      const updated = sessions.find(s => s.id === currentSessionId);
      if (updated) {
        setCurrentSession(updated);
      }
    }
  }, [currentSessionId, sessions]);

  useEffect(() => {
    const handleOpen = () => {
      if (!isWidget) {
        setIsOpen(true);
      }
    };
    window.addEventListener('LUMEN_OPEN', handleOpen);
    return () => window.removeEventListener('LUMEN_OPEN', handleOpen);
  }, [isWidget]);

  useEffect(() => {
    const handleSelectSessionFromEvent = async (e: Event) => {
      const customEvent = e as CustomEvent;
      const { sessionId, timestamp } = customEvent.detail;
      
      if (!isWidget) {
        setIsOpen(true);
      }
      
      if (!auth.currentUser) return;
      const uid = auth.currentUser.uid;
      
      if (sessionId && sessionId !== "default") {
        if (sessionId.startsWith("legacy-")) {
          const legacySessionObj = sessions.find(s => s.id === sessionId);
          if (legacySessionObj) {
            setCurrentSessionId(sessionId);
            setCurrentSession(legacySessionObj);
            await loadSessionMessages(uid, sessionId);
          } else {
            const dateKey = sessionId.replace("legacy-", "");
            const dateObj = new Date(dateKey + "T12:00:00");
            const formattedDate = dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
            const sessData = {
              id: sessionId,
              title: `Session of ${formattedDate}`,
              dateKey: dateKey,
              createdAt: Timestamp.fromDate(dateObj),
              isLegacy: true
            };
            setCurrentSessionId(sessionId);
            setCurrentSession(sessData);
            await loadSessionMessages(uid, sessionId);
          }
          return;
        }

        const sessionObj = sessions.find(s => s.id === sessionId);
        if (sessionObj) {
          setCurrentSessionId(sessionId);
          setCurrentSession(sessionObj);
          await loadSessionMessages(uid, sessionId);
        } else {
          try {
            const docRef = doc(db, "chat_sessions", sessionId);
            const docSnap = await getDoc(docRef);
            if (docSnap.exists()) {
              const sessData = { id: docSnap.id, ...docSnap.data() };
              setCurrentSessionId(sessionId);
              setCurrentSession(sessData);
              await loadSessionMessages(uid, sessionId);
            }
          } catch(err) {
            console.error("Failed to fetch session:", err);
          }
        }
      } else if (timestamp) {
        try {
          const dateObj = new Date((timestamp.seconds || timestamp) * 1000);
          const yyyy = dateObj.getFullYear();
          const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
          const dd = String(dateObj.getDate()).padStart(2, '0');
          const dateKey = `${yyyy}-${mm}-${dd}`;
          const virtualId = `legacy-${dateKey}`;
          
          const matchedSession = sessions.find(s => s.dateKey === dateKey);
          if (matchedSession) {
            setCurrentSessionId(matchedSession.id);
            setCurrentSession(matchedSession);
            await loadSessionMessages(uid, matchedSession.id);
          } else {
            const sessionsRef = collection(db, "chat_sessions");
            const q = query(
              sessionsRef,
              where("userId", "==", uid),
              where("dateKey", "==", dateKey)
            );
            const querySnapshot = await getDocs(q);
            if (!querySnapshot.empty) {
              const docSnap = querySnapshot.docs[0];
              const sessData = { id: docSnap.id, ...docSnap.data() };
              setCurrentSessionId(docSnap.id);
              setCurrentSession(sessData);
              await loadSessionMessages(uid, docSnap.id);
            } else {
              const formattedDate = dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
              const newSessionData = {
                id: virtualId,
                title: `Session of ${formattedDate}`,
                dateKey: dateKey,
                createdAt: Timestamp.fromMillis(dateObj.getTime()),
                isLegacy: true
              };
              setCurrentSessionId(virtualId);
              setCurrentSession(newSessionData);
              await loadSessionMessages(uid, virtualId);
            }
          }
        } catch (err) {
          console.error("Error matching legacy session in select event:", err);
        }
      }
    };

    window.addEventListener('LUMEN_SELECT_SESSION', handleSelectSessionFromEvent as EventListener);
    return () => window.removeEventListener('LUMEN_SELECT_SESSION', handleSelectSessionFromEvent as EventListener);
  }, [isWidget, sessions]);

  useEffect(() => {
    if (isWidget) {
      window.parent.postMessage({ type: "LUMEN_WIDGET_STATE", isOpen }, "*");
    }
  }, [isOpen, isWidget]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const unitParam = params.get("unit");
    const personaParam = params.get("persona");
    const mediaParam = params.get("media");
    const personasParam = params.get("personas");
    
    const isMedia = mediaParam !== "false";
    const isPersonas = personasParam !== "false";
    setMediaEnabled(isMedia);
    setPersonasEnabled(isPersonas);

    console.log("ChatWidget initialized with unit:", unitParam, "persona:", personaParam, "media:", isMedia, "personas:", isPersonas);
    if (unitParam) setUnit(unitParam);
    if (isPersonas && personaParam) setSelectedPersonaId(personaParam);

    // Auth and Session Sync
    const unsubscribe = auth.onAuthStateChanged(async (user) => {
      if (user) {
        console.log("ChatWidget authenticated as:", user.uid, "Anonymous:", user.isAnonymous);
        setIsAuthReady(true);
        setAuthError(null);

        // Fetch Feedback Themes once authenticated
        const fetchThemes = async () => {
          if (!isMedia) {
            setThemes([]);
            setSelectedThemeId(null);
            return;
          }
          try {
            const q = query(collection(db, "feedbackThemes"), orderBy("createdAt", "desc"));
            const snapshot = await getDocs(q);
            const fetchedThemes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as FeedbackTheme));
            setThemes(fetchedThemes);
            if (fetchedThemes.length > 0) {
              setSelectedThemeId(fetchedThemes[0].id);
            }
          } catch (err) {
            console.error("Error fetching themes:", err);
          }
        };
        fetchThemes();

        // Fetch Personas
        const fetchPersonas = async () => {
          if (!isPersonas) {
            setPersonas([]);
            setActivePersona(null);
            setSelectedPersonaId(null);
            return;
          }
          try {
            const snapshot = await getDocs(collection(db, "personas"));
            const fetchedPersonas = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Persona));
            setPersonas(fetchedPersonas);
            
            // Set active persona based on URL param or default
            const activePersonaIdFromUrl = new URLSearchParams(window.location.search).get("persona");
            if (activePersonaIdFromUrl) {
              const p = fetchedPersonas.find(p => p.persona_id === activePersonaIdFromUrl);
              if (p) {
                setActivePersona(p);
                setSelectedPersonaId(p.persona_id);
              }
            }
          } catch (err) {
            console.error("Error fetching personas:", err);
          }
        };
        fetchPersonas();

        // Sync session only if signed in officially (ID token)
        if (!user.isAnonymous) {
          console.log("User is logged in officially. Syncing session...");
          const idToken = await user.getIdToken();
          await fetch("/api/auth/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idToken })
          });
        }

        // Initialize today's session or load active
        console.log("Fetching session for user uid:", user.uid);
        await handleCreateOrFetchTodaySession(user.uid);
      } else {
        signInAnonymously(auth).catch(err => {
          console.error("Anonymous sign-in failed:", err);
          if (err.code === 'auth/admin-restricted-operation') {
            setAuthError("Anonymous Auth is disabled in Firebase Console.");
          } else {
            setAuthError("Connection failed. Please refresh.");
          }
        });
      }
    });
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("Login failed:", err);
    }
  };

  // Update active persona when selection changes
  useEffect(() => {
    if (selectedPersonaId) {
      const p = personas.find(p => p.persona_id === selectedPersonaId);
      if (p) {
        setActivePersona(p);
      }
    } else {
      setActivePersona(null);
    }
  }, [selectedPersonaId, personas]);

  // Handle persona greeting
  useEffect(() => {
    if (isAuthReady && personas.length > 0 && messages.length === 0) {
      const p = personas.find(p => p.persona_id === selectedPersonaId);
      if (p && p.greeting_message) {
        setMessages([{
          role: "model",
          parts: [{ text: p.greeting_message }],
          createdAt: new Date()
        }]);
      }
    }
  }, [selectedPersonaId, personas, isAuthReady, messages.length]);

  const handleLogout = async () => {
    try {
      await signOut(auth);
      await fetch("/api/auth/logout", { method: "POST" });
      setMessages([]);
    } catch (err) {
      console.error("Logout failed:", err);
    }
  };

  // Scroll management:
  // - When a user message is sent, scroll to bottom to show prompt and thinking indicator.
  // - When a model response arrives, scroll to the START of the response so the user reads from the beginning.
  const prevMessagesCountRef = useRef(messages.length);
  const isInitialMountRef = useRef(true);

  useEffect(() => {
    if (!scrollRef.current) return;
    
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      prevMessagesCountRef.current = messages.length;
      if (messages.length > 0) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
      return;
    }

    prevMessagesCountRef.current = messages.length;
    if (messages.length === 0) return;

    const lastMsg = messages[messages.length - 1];
    const lastIndex = messages.length - 1;

    if (lastMsg.role === "user") {
      // User sent a message -> scroll to bottom to show user message & thinking indicator
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth"
      });
    } else if (lastMsg.role === "model") {
      // Model responded -> scroll so that the top/beginning of this response is visible at the top of the chat area
      const scrollToModelStart = () => {
        if (!scrollRef.current) return;
        const msgElement = document.getElementById(`chat-msg-${lastIndex}`);
        if (msgElement) {
          const containerRect = scrollRef.current.getBoundingClientRect();
          const elementRect = msgElement.getBoundingClientRect();
          const targetScrollTop = scrollRef.current.scrollTop + (elementRect.top - containerRect.top) - 12;
          scrollRef.current.scrollTo({
            top: Math.max(0, targetScrollTop),
            behavior: "smooth"
          });
        } else {
          scrollRef.current.scrollTo({
            top: scrollRef.current.scrollHeight,
            behavior: "smooth"
          });
        }
      };

      // Perform immediately on next frame and after brief ticks for markdown/media layout rendering
      requestAnimationFrame(scrollToModelStart);
      const timer1 = setTimeout(scrollToModelStart, 60);
      const timer2 = setTimeout(scrollToModelStart, 200);
      return () => {
        clearTimeout(timer1);
        clearTimeout(timer2);
      };
    }
  }, [messages]);

  const handleSend = async () => {
    if ((!input.trim() && files.length === 0) || isLoading) return;

    const userMessage: Message = {
      role: "user",
      parts: [{ text: input }],
      createdAt: new Date(),
      files: files.length > 0 ? files : undefined,
      themeName: files.length > 0 ? themes.find(t => t.id === selectedThemeId)?.name : undefined,
    };

    // Cache files to IndexedDB right away for long term viewing in history
    if (userMessage.files && userMessage.files.length > 0) {
      const timeKey = getMsgTimeKey(userMessage);
      if (timeKey) {
        userMessage.files.forEach((file, idx) => {
          saveCachedFile(`${timeKey}_${idx}`, file.data, file.mimeType, file.name);
        });
      }
    }

    setMessages(prev => [...prev, userMessage]);
    setInput("");
    setFiles([]);
    setIsLoading(true);

    try {
      let responseText = "";
      let retrievedSources: any[] = [];
      const newDebugLog: string[] = [];
      const addLog = (msg: string) => {
        console.log(msg);
        newDebugLog.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
      };

      // Fetch GDrive folders with citations disabled (student-visible audience only —
      // listing all folders would fail rules once staff folders exist)
      let disabledFolderIds: string[] = [];
      try {
        const foldersSnap = await getDocs(
          query(collection(db, "folders"), where("audience", "==", "all"))
        );
        disabledFolderIds = foldersSnap.docs
          .map(doc => doc.data())
          .filter(data => data.citation === false && data.folderId)
          .map(data => data.folderId as string);
        if (disabledFolderIds.length > 0) {
          addLog(`Citations disabled for folder IDs: ${disabledFolderIds.join(", ")}`);
        }
      } catch (err) {
        console.error("Error fetching folders for citation check:", err);
      }

      if (userMessage.files && userMessage.files.length > 0) {
        const theme = themes.find(t => t.id === selectedThemeId);
        addLog(`Processing ${userMessage.files.length} files with theme: ${theme?.name || 'Default'}`);
        setIsProcessingFiles(true);

        let contextFromKnowledgeBase = "";
        if (selectedPersonaId) {
          addLog(`Performing background knowledge search for persona: ${selectedPersonaId}`);
          try {
            const results = await searchChunks(input || "feedback and critique", undefined, 3, selectedPersonaId);
            if (results.length > 0) {
              // Hide sources from folders where citation is disabled
              retrievedSources = results.filter(r => !r.folderId || !disabledFolderIds.includes(r.folderId));
              addLog(`Found ${results.length} relevant persona context chunks (${retrievedSources.length} cited)`);
              const context = results.map(r => `Source: ${r.fileName}\nContent: ${r.text}`).join("\n\n");
              contextFromKnowledgeBase = `\n\nKNOWLEDGE BASE CONTEXT FOR CRITIQUE:\n${context}`;
            }
          } catch (err) {
            console.error("Failed to perform background search for multimodal context:", err);
          }
        }

        try {
          responseText = await getMultimodalFeedback(
            input || "Provide feedback on these files.", 
            userMessage.files,
            (theme?.prompt || "") + contextFromKnowledgeBase,
            selectedPersonaId || undefined
          );
        } finally {
          setIsProcessingFiles(false);
        }
      } else {
        const chatHistory = messages.map(m => ({ role: m.role, parts: m.parts }));
        chatHistory.push({ role: "user", parts: [{ text: input }] });

        addLog(`Sending message to Lumen. Unit: ${unit || 'Global'}, Persona: ${selectedPersonaId || 'Default'}`);
        const response = await chatWithLumen(chatHistory, unit || undefined, selectedPersonaId || undefined);
        
        const functionCalls = response.functionCalls;

        if (functionCalls) {
          addLog(`Gemini requested ${functionCalls.length} function calls`);
          for (const call of functionCalls) {
            if (call.name === "searchKnowledgeBase") {
              const { query: searchQuery, unit: searchUnit } = call.args as any;
              const effectiveUnit = searchUnit || unit || undefined;
              addLog(`Searching knowledge base: "${searchQuery}" (Unit: ${effectiveUnit || 'Global'}, Persona: ${selectedPersonaId || 'None'})`);
              
              const results = await searchChunks(searchQuery, effectiveUnit, 5, selectedPersonaId || undefined);
              // Hide sources from folders where citation is disabled
              retrievedSources = results.filter(r => !r.folderId || !disabledFolderIds.includes(r.folderId));
              addLog(`Found ${results.length} relevant chunks (${retrievedSources.length} cited)`);
              
              let contextMessage = "";
              if (results.length > 0) {
                const context = results.map(r => `Source: ${r.fileName}${r.url ? ` (URL: ${r.url})` : ""}\nContent: ${r.text}`).join("\n\n");
                contextMessage = `I have found the following information in the OCA knowledge base for you:
                
${context}

Using ONLY the information above, please provide a concise, succinct, and accurate answer to my question: "${input}". 
Summarize the key points clearly with sufficient detail to answer the question, avoiding unnecessary verbosity or filler.
If the information doesn't directly answer the question, briefly explain what was found and how it relates.`;
              } else {
                addLog("WARNING: No results found in knowledge base.");
                contextMessage = `I searched the OCA knowledge base for "${searchQuery}" but found NO relevant information. 
                Please inform the user succinctly that you couldn't find specific details about this in the course materials and suggest they contact student services or their tutor for clarification. 
                DO NOT make up information or use your internal knowledge to answer specific course structure questions if the search returned nothing.`;
              }

              addLog("Sending context back to Gemini for final answer...");
              // Small delay to prevent hitting burst rate limits
              await new Promise(r => setTimeout(r, 800));
              
              const secondResponse = await chatWithLumen([
                ...chatHistory,
                { role: "model", parts: [{ text: "Searching knowledge base..." }] },
                { role: "user", parts: [{ text: contextMessage }] }
              ], unit || undefined, selectedPersonaId || undefined);
              
              responseText = secondResponse.text || "I found some information but couldn't formulate a specific answer. Please try rephrasing.";
              if (results.length > 0 && !secondResponse.text) {
                addLog("ERROR: Gemini failed to generate text from provided context.");
              }
            }
          }
        } else {
          addLog("Gemini responded directly without searching.");
          responseText = response.text || "I'm not sure how to respond to that.";
        }

      }

      setDebugLog(prev => [...prev, ...newDebugLog]);

      const lumenMessage: Message = {
        role: "model",
        parts: [{ text: responseText }],
        createdAt: new Date(),
        sources: retrievedSources.length > 0 ? retrievedSources.map(s => ({
          fileName: s.fileName,
          text: s.text,
          unit: s.unit,
          url: s.url
        })) : undefined
      };

      setMessages(prev => [...prev, lumenMessage]);

      // Persistent History Storage
      if (auth.currentUser) {
        console.log("Attempting to save message to chat_history for user:", auth.currentUser.uid);
        try {
          const userDocData: any = {
            userId: auth.currentUser.uid,
            sessionId: currentSessionId || "default",
            role: "user",
            parts: userMessage.parts,
            createdAt: serverTimestamp(),
            unit: unit || "global"
          };
          if (userMessage.files) {
            userDocData.files = userMessage.files.map(f => ({ name: f.name, mimeType: f.mimeType }));
          }

          const userDoc = await addDoc(collection(db, "chat_history"), userDocData);
          console.log("User message saved with ID:", userDoc.id);

          // Save copy in IndexedDB mapped to the precise unique Firestore message document ID
          if (userMessage.files && userDoc.id) {
            userMessage.files.forEach((file, idx) => {
              saveCachedFile(`${userDoc.id}_${idx}`, file.data, file.mimeType, file.name);
            });
          }

          const modelDocData: any = {
            userId: auth.currentUser.uid,
            sessionId: currentSessionId || "default",
            role: "model",
            parts: lumenMessage.parts,
            createdAt: serverTimestamp(),
            unit: unit || "global"
          };
          if (lumenMessage.sources) {
            // Clean sources to remove undefined values which Firestore rejects
            modelDocData.sources = lumenMessage.sources.map(s => {
              const cleaned: any = {
                fileName: s.fileName,
                text: s.text
              };
              if (s.unit) cleaned.unit = s.unit;
              if (s.url) cleaned.url = s.url;
              return cleaned;
            });
          }

          const modelDoc = await addDoc(collection(db, "chat_history"), modelDocData);
          console.log("Lumen message saved with ID:", modelDoc.id);

          // Auto-generate session title if current session has the default name format
          const isSessionTitleDefault = currentSession && currentSession.title && currentSession.title.startsWith("Session of");
          if (currentSessionId && isSessionTitleDefault) {
            const promptText = userMessage.parts[0].text;
            generateSessionTitle(promptText, responseText).then((generatedTitle) => {
              if (generatedTitle && generatedTitle.trim()) {
                const sessionRef = doc(db, "chat_sessions", currentSessionId);
                updateDoc(sessionRef, {
                  title: generatedTitle.trim(),
                  updatedAt: serverTimestamp()
                }).catch(e => console.error("Could not update auto generated title:", e));
              }
            });
          }
        } catch (err) {
          console.error("Failed to save history:", err);
          setDebugLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ERROR: Failed to save history: ${err}`]);
        }
      } else {
        console.log("Skipping history save: no current user.");
      }
    } catch (error: any) {
      console.error("Chat error:", error);
      
      let errorMessage = "Sorry, I encountered an error. Please try again.";
      
      // Handle the custom daily rate limit error from our server
      if (error.message?.includes("DAILY_RATE_LIMIT_EXCEEDED") || (error.response && error.response.error === "DAILY_RATE_LIMIT_EXCEEDED")) {
        errorMessage = "Lumen's global daily message limit has been reached. The limit resets at midnight every day.";
      } else if (error.message?.includes("Resource exhausted") || error.message?.includes("429")) {
        // Handle generic Google AI rate limits (burst limits)
        errorMessage = "Lumen is currently experiencing high demand. Please wait a moment and try again.";
      }
      
      setMessages(prev => [...prev, { role: "model", parts: [{ text: errorMessage }] }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (selectedFiles) {
      Array.from(selectedFiles).forEach(selectedFile => {
        const reader = new FileReader();
        reader.onload = async (event) => {
          const base64 = event.target?.result as string;
          
          if (selectedFile.type.startsWith("image/")) {
            try {
              const compressed = await compressImage(base64);
              setFiles(prev => [...prev, { 
                data: compressed.data, 
                mimeType: compressed.mimeType, 
                name: selectedFile.name 
              }]);
            } catch (err) {
              console.error("Compression error:", err);
              // Fallback to original if compression fails
              const data = base64.split(",")[1];
              setFiles(prev => [...prev, { data, mimeType: selectedFile.type, name: selectedFile.name }]);
            }
          } else {
            const data = base64.split(",")[1];
            setFiles(prev => [...prev, { data, mimeType: selectedFile.type, name: selectedFile.name }]);
          }
        };
        reader.readAsDataURL(selectedFile);
      });
    }
  };

  const ChatContent = (
    <div className={cn(
      "bg-white flex flex-col overflow-hidden",
      forceOpen 
        ? "w-full h-screen" 
        : isWidget 
          ? "w-full h-full rounded-[20px] shadow-none border-0" 
          : "w-[380px] sm:w-[400px] h-[520px] max-h-[calc(100vh-100px)] rounded-2xl shadow-2xl border border-gray-200"
    )}>
      {/* Header */}
      <div className="p-3.5 bg-oca-blue text-white flex items-center justify-between shadow-lg z-10">
        <div className="flex items-center gap-2.5 min-w-0">
          {!forceOpen && (
            <button 
              onClick={() => setIsOpen(false)} 
              className="p-1.5 bg-white/10 hover:bg-white/20 text-white rounded-full transition-colors flex-shrink-0"
              title="Close Chat"
            >
              <X size={18} />
            </button>
          )}
          <div 
            className="cursor-help transition-transform hover:scale-110 active:scale-95 flex-shrink-0"
            onClick={() => setShowDebug(!showDebug)}
            title="Click for debug logs"
          >
            <BotAvatar size="base" isThinking={false} />
          </div>
          <div className="flex flex-col min-w-0">
            <h3 className="font-black text-lg leading-none uppercase tracking-tight truncate">
              {activePersona ? activePersona.display_name : "Lumen"}
            </h3>
            <p className="text-[10px] text-oca-blue-tint font-bold uppercase tracking-widest mt-0.5 whitespace-nowrap opacity-80 truncate">
              {activePersona ? "Specialist Persona" : "OCA Creative Arts Tutor"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          {auth.currentUser && !auth.currentUser.isAnonymous && (
            <button 
              onClick={handleLogout}
              className="p-1.5 hover:bg-white/10 rounded-full transition-colors"
              title="Logout"
            >
              <LogOut size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Session Title and Controls Bar */}
      <div className="bg-oca-blue-tint/25 border-b border-gray-100 px-4 py-2 flex items-center justify-between text-xs text-oca-blue font-medium shadow-sm z-10 flex-shrink-0">
        <div className="flex items-center gap-2 overflow-hidden flex-1 mr-2">
          {isEditingTitle ? (
            <div className="flex items-center gap-1.5 w-full">
              <input
                type="text"
                value={editTitleValue}
                onChange={(e) => setEditTitleValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveTitle();
                  if (e.key === "Escape") setIsEditingTitle(false);
                }}
                className="px-2 py-0.5 bg-white border border-oca-blue/30 rounded text-xs text-gray-800 outline-none focus:ring-1 focus:ring-oca-blue w-full font-medium"
                autoFocus
              />
              <button 
                onClick={handleSaveTitle} 
                className="text-emerald-600 hover:text-emerald-700 p-0.5 flex-shrink-0"
                title="Save Title"
              >
                <Check size={14} className="stroke-[2.5]" />
              </button>
              <button 
                onClick={() => setIsEditingTitle(false)} 
                className="text-red-500 hover:text-red-600 p-0.5 flex-shrink-0"
                title="Cancel"
              >
                <X size={14} className="stroke-[2.5]" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 truncate w-full group">
              <span className="font-bold text-[10px] uppercase tracking-wider text-oca-blue/60 flex-shrink-0">Topic:</span>
              <span className="truncate text-gray-700 font-bold text-xs" title={currentSession?.title}>
                {currentSession ? currentSession.title : "New Session"}
              </span>
              {currentSession && (
                <button
                  onClick={() => {
                    setEditTitleValue(currentSession.title || "");
                    setIsEditingTitle(true);
                  }}
                  className="p-1 hover:bg-white rounded text-oca-blue opacity-50 hover:opacity-100 transition-opacity flex-shrink-0"
                  title="Rename session"
                >
                  <Edit2 size={11} />
                </button>
              )}
            </div>
          )}
        </div>
        
        {/* Session switcher toggle button */}
        <button
          onClick={() => setIsSessionHistoryOpen(!isSessionHistoryOpen)}
          className={cn(
            "flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all flex-shrink-0",
            isSessionHistoryOpen 
              ? "bg-oca-blue text-white shadow-sm" 
              : "bg-white hover:bg-oca-blue-tint/50 text-oca-blue border border-oca-blue/20"
          )}
          title="Past Sessions"
        >
          <History size={11} className="flex-shrink-0" />
          <span>Sessions</span>
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50 relative">
        {isSessionHistoryOpen && (
          <div className="absolute inset-0 z-20 bg-white/95 backdrop-blur-sm p-4 flex flex-col">
            <div className="flex justify-between items-center mb-3 pb-2 border-b border-gray-100">
              <span className="text-xs font-black uppercase tracking-widest text-oca-blue flex items-center gap-1.5">
                <History size={14} className="text-oca-verdigris animate-pulse" />
                Select a Session
              </span>
              <button 
                onClick={() => setIsSessionHistoryOpen(false)} 
                className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors"
                title="Close"
              >
                <X size={16} />
              </button>
            </div>
            
            {/* Action to start a new session explicitly */}
            <button
              onClick={handleCreateNewSessionExplicitly}
              className="mb-3 w-full py-2.5 bg-oca-verdigris text-white rounded-xl font-black text-[10px] uppercase tracking-wider hover:bg-oca-blue transition-all shadow-md flex items-center justify-center gap-1.5 border-2 border-oca-blue"
              title="Start a brand new chat session"
            >
              <Plus size={14} className="stroke-[2.5]" />
              Start New Chat Session
            </button>
            
            {/* List of active/historic sessions */}
            <div className="flex-1 overflow-y-auto space-y-2 pr-1 scrollbar-thin">
              {sessions.length === 0 ? (
                <div className="text-center py-8 text-xs text-gray-400">No previous sessions found.</div>
              ) : (
                sessions.map((sess) => {
                  const isCurrent = sess.id === currentSessionId;
                  const dateDisplay = sess.createdAt?.toDate 
                    ? sess.createdAt.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                    : new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
                  return (
                    <div 
                      key={sess.id}
                      className={cn(
                        "w-full text-left p-3 rounded-xl transition-all border flex items-center justify-between gap-2.5 cursor-pointer hover:shadow-xs",
                        isCurrent 
                          ? "bg-oca-blue-tint/40 border-oca-blue text-oca-blue shadow-xs" 
                          : "bg-gray-50 border-gray-100 hover:bg-white hover:border-gray-200 text-gray-700"
                      )}
                      onClick={() => handleSelectSession(sess)}
                    >
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-xs font-bold truncate">{sess.title}</span>
                        <span className="text-[9px] text-gray-400 font-bold uppercase tracking-wider mt-0.5">{dateDisplay}</span>
                      </div>
                      
                      {isCurrent && (
                        <span className="text-[9px] font-black uppercase tracking-wider bg-oca-blue/15 text-oca-blue px-2 py-0.5 rounded-full">
                          Active
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
        {auth.currentUser?.isAnonymous && messages.length > 0 && (
          <div className="bg-amber-50 border border-amber-100 rounded-lg p-3 text-sm text-amber-800 flex items-start gap-3">
            <User className="w-4 h-4 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium">Guest Session</p>
              <p className="opacity-80">Log in with your OCA Google account to save your chat history and access it across all devices.</p>
              <button 
                onClick={handleLogin}
                className="mt-2 text-amber-900 font-semibold underline hover:text-amber-950 flex items-center gap-1"
              >
                Log in now <ExternalLink className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}
        {showDebug && (
          <div className="absolute inset-0 z-10 bg-black/80 text-green-400 p-4 font-mono text-[10px] overflow-y-auto">
            <div className="flex justify-between items-center mb-2 border-b border-green-900 pb-1">
              <span>DEBUG LOG</span>
              <button onClick={() => setShowDebug(false)} className="text-white hover:text-red-400">CLOSE</button>
            </div>
            {debugLog.length === 0 ? "No logs yet..." : debugLog.map((log, i) => (
              <div key={i} className="mb-1">{log}</div>
            ))}
          </div>
        )}
        {messages.length === 0 && (
          <div className="text-center py-10 px-6">
            <div className="flex justify-center mb-6">
               <BotAvatar size="lg" isThinking={isLoading} />
            </div>
            {activePersona ? (
              <>
                <p className="text-lg font-black text-oca-blue uppercase tracking-widest leading-relaxed mb-2">
                  {activePersona.display_name}
                </p>
                <p className="text-xs text-gray-500 italic px-8">Activated via persona settings</p>
              </>
            ) : (
              <p className="text-sm font-black text-oca-blue uppercase tracking-widest leading-relaxed opacity-60">How can I help you today?</p>
            )}
          </div>
        )}
        {messages.map((msg, i) => (
          <div 
            key={msg.id || `msg-${i}`} 
            id={`chat-msg-${i}`}
            className={cn("flex gap-3 scroll-mt-3", msg.role === "user" ? "flex-row-reverse" : "flex-row")}
          >
            <div className={cn("flex-shrink-0")}>
              {msg.role === "user" ? (
                <div className="w-8 h-8 rounded-full flex items-center justify-center bg-oca-blue-tint text-oca-blue border border-oca-blue">
                   <User size={16} />
                </div>
              ) : (
                <BotAvatar size="sm" isThinking={false} />
              )}
            </div>
            <div className={cn("max-w-[85%] p-4 rounded-2xl text-sm shadow-sm leading-relaxed", msg.role === "user" ? "bg-oca-blue text-white rounded-tr-none" : "bg-white text-gray-800 rounded-tl-none border border-gray-100")}>
              {msg.files && msg.files.length > 0 && (
                <div className="mb-2 space-y-1">
                  {msg.files.map((f, idx) => (
                    <div key={idx} className="p-2 bg-black/10 rounded-lg flex items-center gap-2">
                      {f.mimeType.startsWith("image/") ? <ImageIcon size={16} /> : <FileAudio size={16} />}
                      <span className="text-xs truncate font-medium">{f.name}</span>
                    </div>
                  ))}
                  {msg.themeName && (
                    <div className="flex items-center gap-1 text-[10px] opacity-70 px-1">
                      <Palette size={10} />
                      <span>Theme: {msg.themeName}</span>
                    </div>
                  )}
                </div>
              )}
              <div className={cn("prose prose-sm max-w-none", msg.role === "user" ? "prose-invert" : "text-gray-800")}>
                <ReactMarkdown
                  components={{
                    a: ({ node, ...props }) => <a target="_blank" rel="noopener noreferrer" {...props} />
                  }}
                >{msg.parts[0].text}</ReactMarkdown>
              </div>
              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Sources</p>
                  <div className="space-y-2">
                    {msg.sources.map((source, idx) => (
                      <div key={idx} className="group/source relative">
                        <div className="flex items-center gap-1.5 text-[10px] text-indigo-600 font-medium bg-indigo-50 px-2 py-1 rounded-md cursor-help">
                          <BookOpen size={10} />
                          <span className="truncate">{source.fileName}</span>
                          {source.unit && <span className="text-[8px] bg-indigo-200 px-1 rounded">{source.unit}</span>}
                          {source.url && (
                            <a 
                              href={source.url} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="ml-1 p-0.5 hover:bg-indigo-100 rounded transition-colors"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <ExternalLink size={8} />
                            </a>
                          )}
                        </div>
                        <div className="hidden group-hover/source:block absolute bottom-full left-0 mb-2 w-64 p-3 bg-gray-900 text-white text-[10px] rounded-xl shadow-2xl z-50 leading-relaxed border border-gray-800">
                          <div className="font-bold text-indigo-400 mb-1 border-b border-gray-800 pb-1">{source.fileName}</div>
                          {source.text}
                          <div className="absolute bottom-[-6px] left-4 w-3 h-3 bg-gray-900 rotate-45 border-r border-b border-gray-800"></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <MessageFilesAndCarousel msg={msg} previousMsg={i > 0 ? messages[i - 1] : undefined} />
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex gap-3">
            <BotAvatar size="sm" isThinking={false} />
            <div className="bg-white p-4 rounded-2xl rounded-tl-none shadow-sm flex items-center gap-3 border border-gray-100">
              <BotAvatar size="sm" isThinking={true} />
              {isProcessingFiles && <span className="text-xs text-oca-blue font-black uppercase tracking-widest">Processing...</span>}
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="p-4 bg-white border-t border-gray-200">
        {personasEnabled && personas.length > 0 && (
          <div className="mb-3 flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
            <div className="flex flex-shrink-0 items-center gap-1 p-1 bg-gray-50 rounded-lg border border-gray-100">
              <Bot size={14} className="text-gray-400 ml-1" />
              <select 
                value={selectedPersonaId || ""} 
                onChange={(e) => setSelectedPersonaId(e.target.value || null)}
                className="bg-transparent border-none text-[10px] font-bold text-gray-600 focus:ring-0 outline-none pr-6 py-0.5"
              >
                <option value="">Standard Lumen</option>
                {personas.map(p => (
                  <option key={p.id} value={p.persona_id}>{p.display_name}</option>
                ))}
              </select>
            </div>
            {activePersona && (
              <div className="flex-shrink-0 px-2 py-1 bg-oca-blue-tint text-oca-blue rounded-full text-[10px] font-bold border border-oca-blue/20">
                Persona Active
              </div>
            )}
          </div>
        )}
        {mediaEnabled && files.length > 0 && (
          <div className="mb-3 space-y-2">
            <div className="flex flex-wrap gap-2">
              {files.map((f, idx) => (
                <div key={idx} className="p-2 bg-indigo-50 text-indigo-700 rounded-lg flex items-center gap-2 text-xs">
                  {f.mimeType.startsWith("image/") ? <ImageIcon size={14} /> : <FileAudio size={14} />}
                  <span className="truncate max-w-[120px] font-medium">{f.name}</span>
                  <button onClick={() => setFiles(prev => prev.filter((_, i) => i !== idx))} className="p-0.5 hover:bg-indigo-100 rounded-full">
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
            
            {themes.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider ml-1">Select Feedback Theme</label>
                <div className="flex flex-wrap gap-1">
                  {themes.map(theme => (
                    <button
                      key={theme.id}
                      onClick={() => setSelectedThemeId(theme.id)}
                      className={cn(
                        "px-2.5 py-1 rounded-full text-[10px] font-medium transition-all border",
                        selectedThemeId === theme.id 
                          ? "bg-indigo-600 text-white border-indigo-600 shadow-sm" 
                          : "bg-white text-gray-600 border-gray-200 hover:border-indigo-300"
                      )}
                    >
                      {theme.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          {mediaEnabled && (
            <>
              <button 
                onClick={() => fileInputRef.current?.click()}
                className="p-2 text-gray-400 hover:text-oca-blue hover:bg-oca-blue-tint rounded-full transition-colors"
              >
                <Paperclip size={20} />
              </button>
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                className="hidden" 
                accept="image/*,audio/*,video/*"
                multiple
              />
            </>
          )}
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === "Enter" && handleSend()}
            placeholder={authError ? authError : (isAuthReady ? "Ask Lumen anything..." : "Connecting...")}
            disabled={!isAuthReady}
            className={cn(
              "flex-1 bg-gray-100 border-none rounded-full px-5 py-3 text-sm focus:ring-2 focus:ring-oca-blue outline-none disabled:opacity-50 transition-all",
              authError && "text-red-500 placeholder:text-red-400"
            )}
          />
          <button
            onClick={handleSend}
            disabled={isLoading || (!input.trim() && files.length === 0)}
            className="p-3 bg-oca-verdigris text-white rounded-full hover:bg-oca-blue shadow-lg active:scale-95 transition-all disabled:opacity-50 border-2 border-oca-blue"
          >
            <Send size={20} />
          </button>
        </div>
      </div>
    </div>
  );

  if (forceOpen) return ChatContent;

  if (isWidget) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-transparent overflow-hidden m-0 p-0">
        <AnimatePresence mode="wait">
          {isOpen ? (
            <motion.div
              key="chat-content"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.15 }}
              className="w-full h-full flex flex-col overflow-hidden"
            >
              {ChatContent}
            </motion.div>
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <motion.button
                key="chat-button"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setIsOpen(true)}
                className="w-14 h-14 bg-white text-oca-blue rounded-full shadow-xl flex items-center justify-center hover:bg-oca-blue-tint transition-all flex-shrink-0 m-0 border-2 border-oca-blue group cursor-pointer"
              >
                <div className="group-hover:scale-110 transition-transform">
                  <BotAvatar size="base" isThinking={false} className="bg-transparent border-none shadow-none" />
                </div>
              </motion.button>
            </div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-[9999]">
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="mb-4"
          >
            {ChatContent}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setIsOpen(!isOpen)}
        className="w-16 h-16 bg-white text-oca-blue rounded-full shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center justify-center hover:shadow-oca-blue/20 transition-all flex-shrink-0 border-2 border-oca-blue group"
      >
        <div className="group-hover:scale-110 transition-transform">
          {isOpen ? <X size={28} /> : <BotAvatar size="base" isThinking={false} className="bg-transparent border-none shadow-none" />}
        </div>
      </motion.button>
    </div>
  );
}
