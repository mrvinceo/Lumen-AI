import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { FolderPlus, RefreshCw, Trash2, ExternalLink, CheckCircle, AlertCircle, Loader2, LogIn, ArrowLeft, Code, Copy, Palette, Plus, GraduationCap, Eye, X, Bot, ClipboardList, Activity, Check, Search, BookOpen, AlertTriangle } from "lucide-react";
import { db, auth, handleFirestoreError, OperationType } from "../firebase";
import { collection, addDoc, getDocs, deleteDoc, doc, updateDoc, serverTimestamp, query, orderBy, setDoc, where, writeBatch, vector, getDoc, onSnapshot } from "firebase/firestore";
import { signInWithPopup, GoogleAuthProvider } from "firebase/auth";
import { getEmbeddings } from "../lib/gemini";
import { Link } from "react-router-dom";
import { OCALogo } from "./BrandAssets";

interface Folder {
  id: string;
  folderId: string;
  name: string;
  status: "pending" | "indexing" | "completed" | "error";
  indexedAt?: any;
  unit?: string;
  persona?: string;
  citation?: boolean;
}

interface FeedbackTheme {
  id: string;
  name: string;
  prompt: string;
  createdAt: any;
}

interface MoodleUnit {
  id: string;
  unitCode: string;
  courseId: number;
  fullname: string;
  status: "pending" | "cataloguing" | "completed" | "error";
  cataloguedAt?: any;
  stats?: {
    sectionsCount: number;
    modulesCount: number;
    assignmentsCount: number;
    pagesCount: number;
    booksCount: number;
    scormsCount: number;
    labelsCount: number;
  };
  modulesLog?: {
    name: string;
    type: string;
    status: "success" | "warning" | "error";
    chunksCount: number;
    details: string;
  }[];
  logs?: {
    level: "info" | "warning" | "error";
    message: string;
    timestamp: string;
  }[];
  errorDetail?: string;
}

interface Persona {
  id: string;
  persona_id: string;
  display_name: string;
  system_prompt: string;
  greeting_message?: string;
  icon?: string;
}

export default function AdminPanel() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [themes, setThemes] = useState<FeedbackTheme[]>([]);
  const [moodleUnits, setMoodleUnits] = useState<MoodleUnit[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [newFolderId, setNewFolderId] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderUnit, setNewFolderUnit] = useState("");
  const [newFolderPersona, setNewFolderPersona] = useState("");
  const [newThemeName, setNewThemeName] = useState("");
  const [newThemePrompt, setNewThemePrompt] = useState("");
  const [newMoodleUnitCode, setNewMoodleUnitCode] = useState("");
  
  // Persona form state
  const [newPersonaId, setNewPersonaId] = useState("");
  const [newPersonaName, setNewPersonaName] = useState("");
  const [newPersonaPrompt, setNewPersonaPrompt] = useState("");
  const [newPersonaGreeting, setNewPersonaGreeting] = useState("");
  
  // Persona editing state
  const [editingPersona, setEditingPersona] = useState<Persona | null>(null);
  
  const [isLoading, setIsLoading] = useState(false);
  const [notification, setNotification] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [selectedUnitChunks, setSelectedUnitChunks] = useState<any[]>([]);
  const [isChunksModalOpen, setIsChunksModalOpen] = useState(false);
  const [selectedAuditUnit, setSelectedAuditUnit] = useState<MoodleUnit | null>(null);
  const [auditSearchQuery, setAuditSearchQuery] = useState("");
  const [activeAuditTab, setActiveAuditTab] = useState<"checklist" | "logs">("checklist");
  const [viewingUnitCode, setViewingUnitCode] = useState<string | null>(null);
  const [moodleDiagnostic, setMoodleDiagnostic] = useState<{
    auth: boolean | null;
    lookup: boolean | null;
    contents: boolean | null;
    books: boolean | null;
    chapters: boolean | null;
    error?: string;
  } | null>(null);
  const [tokens, setTokens] = useState<any>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [globalRateLimit, setGlobalRateLimit] = useState<number>(150);
  const [dailyUsageCount, setDailyUsageCount] = useState<number>(0);
  const [isUpdatingLimit, setIsUpdatingLimit] = useState(false);
  const [embedTab, setEmbedTab] = useState<"chat" | "planner">("chat");

  useEffect(() => {
    let unsubscribeSettings: (() => void) | null = null;
    let unsubscribeStats: (() => void) | null = null;

    const unsubscribeAuth = auth.onAuthStateChanged(user => {
      setUser(user);
      setAuthChecked(true);
      if (user && user.email?.toLowerCase() === "paulvincent@oca.ac.uk") {
        setIsAdmin(true);
        fetchFolders();
        fetchThemes();
        fetchMoodleUnits();
        fetchPersonas();
        
        // Real-time listeners for global settings and stats
        unsubscribeSettings = onSnapshot(doc(db, "settings", "rate_limit"), (snapshot) => {
          if (snapshot.exists()) {
            setGlobalRateLimit(snapshot.data().value);
          }
        }, (err) => {
          console.warn("Settings listener failed:", err.message);
        });

        unsubscribeStats = onSnapshot(doc(db, "stats", "daily_usage"), (snapshot) => {
          if (snapshot.exists()) {
            const data = snapshot.data();
            const today = new Date().toISOString().split('T')[0];
            if (data.date === today) {
              setDailyUsageCount(data.count || 0);
            } else {
              setDailyUsageCount(0);
            }
          }
        }, (err) => {
          console.warn("Stats listener failed:", err.message);
        });
      } else {
        setIsAdmin(false);
      }
    });

    const handleOAuthMessage = (event: MessageEvent) => {
      // Legacy handler - can be removed later if using Firebase Auth exclusively
      if (event.data?.type === "OAUTH_AUTH_SUCCESS") {
        setTokens(event.data.tokens);
        localStorage.setItem("gdrive_tokens", JSON.stringify(event.data.tokens));
      }
    };

    window.addEventListener("message", handleOAuthMessage);
    const savedTokens = localStorage.getItem("gdrive_tokens");
    if (savedTokens) setTokens(JSON.parse(savedTokens));

    return () => {
      unsubscribeAuth();
      if (unsubscribeSettings) unsubscribeSettings();
      if (unsubscribeStats) unsubscribeStats();
      window.removeEventListener("message", handleOAuthMessage);
    };
  }, []);

  const fetchFolders = async () => {
    const q = query(collection(db, "folders"), orderBy("name"));
    const snapshot = await getDocs(q);
    setFolders(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Folder)));
  };

  const fetchThemes = async () => {
    const q = query(collection(db, "feedbackThemes"), orderBy("createdAt", "desc"));
    const snapshot = await getDocs(q);
    setThemes(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as FeedbackTheme)));
  };

  const fetchMoodleUnits = async () => {
    const q = query(collection(db, "moodleUnits"), orderBy("unitCode"));
    const snapshot = await getDocs(q);
    setMoodleUnits(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MoodleUnit)));
  };

  const fetchPersonas = async () => {
    const q = query(collection(db, "personas"), orderBy("display_name"));
    const snapshot = await getDocs(q);
    setPersonas(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Persona)));
  };

  const handleUpdateRateLimit = async (newLimit: number) => {
    setIsUpdatingLimit(true);
    try {
      await setDoc(doc(db, "settings", "rate_limit"), { value: newLimit }, { merge: true });
      setGlobalRateLimit(newLimit);
      showNotification(`Daily rate limit updated to ${newLimit} messages`, "success");
    } catch (err: any) {
      console.error("Error updating rate limit:", err);
      showNotification("Failed to update rate limit", "error");
    } finally {
      setIsUpdatingLimit(false);
    }
  };

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error: any) {
      console.error("Login error:", error);
      if (error.code === "auth/unauthorized-domain") {
        showNotification("This domain is not authorized for Firebase Authentication.", "error");
      } else {
        showNotification("Login failed: " + error.message, "error");
      }
    }
  };

  const handleConnectDrive = async () => {
    const provider = new GoogleAuthProvider();
    provider.addScope("https://www.googleapis.com/auth/drive.readonly");
    provider.addScope("https://www.googleapis.com/auth/userinfo.email");
    provider.setCustomParameters({ prompt: "consent" }); // Force consent to ensure scopes are granted
    
    setIsLoading(true);
    try {
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      const token = credential?.accessToken;
      
      if (token) {
        const tokens = { access_token: token };
        setTokens(tokens);
        localStorage.setItem("gdrive_tokens", JSON.stringify(tokens));
      } else {
        throw new Error("No access token returned from Google.");
      }
    } catch (error) {
      console.error("Drive connection error:", error);
      showNotification("Failed to connect to Google Drive. Please ensure popups are allowed.", "error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddFolder = async () => {
    if (!newFolderId || !newFolderName) return;
    setIsLoading(true);
    try {
      await addDoc(collection(db, "folders"), {
        folderId: newFolderId,
        name: newFolderName,
        unit: newFolderUnit || null,
        persona: newFolderPersona || null,
        status: "pending",
        createdAt: serverTimestamp(),
        citation: true,
      });
      setNewFolderId("");
      setNewFolderName("");
      setNewFolderUnit("");
      setNewFolderPersona("");
      fetchFolders();
    } catch (error) {
      console.error("Error adding folder:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggleCitation = async (folder: Folder) => {
    const nextValue = folder.citation !== false ? false : true;
    try {
      await updateDoc(doc(db, "folders", folder.id), { citation: nextValue });
      showNotification(`Citations ${nextValue ? "enabled" : "disabled"} for ${folder.name}`, "success");
      fetchFolders();
    } catch (error) {
      console.error("Error updating citation field:", error);
      showNotification("Failed to update citation setting", "error");
    }
  };

  const handleDeleteFolder = async (folder: Folder) => {
    setIsLoading(true);
    try {
      // Delete chunks first
      const q = query(collection(db, "chunks"), where("folderId", "==", folder.folderId));
      const snapshot = await getDocs(q);
      
      if (!snapshot.empty) {
        let batch = writeBatch(db);
        let count = 0;
        for (const d of snapshot.docs) {
          batch.delete(doc(db, "chunks", d.id));
          count++;
          if (count === 500) {
            await batch.commit();
            batch = writeBatch(db);
            count = 0;
          }
        }
        if (count > 0) await batch.commit();
      }

      await deleteDoc(doc(db, "folders", folder.id));
      fetchFolders();
      showNotification("Folder and associated chunks removed successfully", "success");
    } catch (error: any) {
      console.error("Error deleting folder:", error);
      try {
        handleFirestoreError(error, OperationType.DELETE, `folders/${folder.id}`);
      } catch (e: any) {
        showNotification(e.message, "error");
      }
    } finally {
      setIsLoading(false);
      setConfirmDeleteId(null);
    }
  };

  const handleAddTheme = async () => {
    if (!newThemeName || !newThemePrompt) return;
    setIsLoading(true);
    try {
      await addDoc(collection(db, "feedbackThemes"), {
        name: newThemeName,
        prompt: newThemePrompt,
        createdAt: serverTimestamp(),
      });
      setNewThemeName("");
      setNewThemePrompt("");
      fetchThemes();
    } catch (error) {
      console.error("Error adding theme:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteTheme = async (id: string) => {
    setIsLoading(true);
    try {
      await deleteDoc(doc(db, "feedbackThemes", id));
      fetchThemes();
      showNotification("Theme deleted successfully", "success");
    } catch (error: any) {
      console.error("Error deleting theme:", error);
      try {
        handleFirestoreError(error, OperationType.DELETE, `feedbackThemes/${id}`);
      } catch (e: any) {
        showNotification(e.message, "error");
      }
    } finally {
      setIsLoading(false);
      setConfirmDeleteId(null);
    }
  };

  const handleAddPersona = async () => {
    console.log("handleAddPersona called", { newPersonaId, newPersonaName, newPersonaPrompt });
    if (!newPersonaId || !newPersonaName || !newPersonaPrompt) {
      showNotification("Please fill in all required fields", "error");
      return;
    }
    setIsLoading(true);
    try {
      console.log("Setting doc in personas collection for ID:", newPersonaId);
      await setDoc(doc(db, "personas", newPersonaId), {
        persona_id: newPersonaId,
        display_name: newPersonaName,
        system_prompt: newPersonaPrompt,
        greeting_message: newPersonaGreeting || null,
        createdAt: serverTimestamp(),
      });
      console.log("setDoc successful");
      setNewPersonaId("");
      setNewPersonaName("");
      setNewPersonaPrompt("");
      setNewPersonaGreeting("");
      await fetchPersonas();
      showNotification("Persona created successfully", "success");
    } catch (error: any) {
      console.error("Error adding persona:", error);
      showNotification("Failed to add persona: " + error.message, "error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeletePersona = async (id: string) => {
    setIsLoading(true);
    try {
      await deleteDoc(doc(db, "personas", id));
      fetchPersonas();
      showNotification("Persona deleted successfully", "success");
    } catch (error) {
      console.error("Error deleting persona:", error);
      showNotification("Failed to delete persona", "error");
    } finally {
      setIsLoading(false);
      setConfirmDeleteId(null);
    }
  };

  const handleStartEditPersona = (persona: Persona) => {
    setEditingPersona(persona);
    setNewPersonaId(persona.persona_id);
    setNewPersonaName(persona.display_name);
    setNewPersonaPrompt(persona.system_prompt);
    setNewPersonaGreeting(persona.greeting_message || "");
    
    // Scroll to form
    window.scrollTo({ top: document.getElementById('persona-form-container')?.offsetTop || 0, behavior: 'smooth' });
  };

  const handleCancelEditPersona = () => {
    setEditingPersona(null);
    setNewPersonaId("");
    setNewPersonaName("");
    setNewPersonaPrompt("");
    setNewPersonaGreeting("");
  };

  const handleUpdatePersona = async () => {
    if (!editingPersona || !newPersonaName || !newPersonaPrompt) return;
    setIsLoading(true);
    try {
      await updateDoc(doc(db, "personas", editingPersona.id), {
        display_name: newPersonaName,
        system_prompt: newPersonaPrompt,
        greeting_message: newPersonaGreeting || null,
        updatedAt: serverTimestamp(),
      });
      
      handleCancelEditPersona();
      await fetchPersonas();
      showNotification("Persona updated successfully", "success");
    } catch (error: any) {
      console.error("Error updating persona:", error);
      showNotification("Failed to update persona: " + error.message, "error");
    } finally {
      setIsLoading(false);
    }
  };

  const showNotification = (message: string, type: "success" | "error" | "info" = "info") => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 5000);
  };

  const handleViewChunks = async (unitCode: string | null, personaId?: string | null) => {
    setIsLoading(true);
    setViewingUnitCode(unitCode || personaId || "Global");
    try {
      let q;
      if (personaId) {
        q = query(collection(db, "chunks"), where("persona", "==", personaId));
      } else {
        q = query(collection(db, "chunks"), where("unit", "==", unitCode));
      }
      const snapshot = await getDocs(q);
      let docs = snapshot.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) }));
      if (!personaId) {
        // Filter out chunk documents that are assigned specifically to a persona
        docs = docs.filter(chunk => !chunk.persona);
      }
      setSelectedUnitChunks(docs);
      setIsChunksModalOpen(true);
    } catch (error) {
      console.error("Error fetching chunks:", error);
      showNotification("Failed to fetch chunks", "error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleCatalogueMoodleUnit = async () => {
    if (!newMoodleUnitCode) return;
    setIsLoading(true);
    
    // Create or locate the document first
    const existingQ = query(collection(db, "moodleUnits"), where("unitCode", "==", newMoodleUnitCode));
    const existingSnap = await getDocs(existingQ);
    let unitRef;
    
    if (!existingSnap.empty) {
      unitRef = doc(db, "moodleUnits", existingSnap.docs[0].id);
    } else {
      unitRef = doc(collection(db, "moodleUnits"));
    }

    let logsAccumulator: any[] = [];
    const pushLocalLog = (level: "info" | "warning" | "error", message: string) => {
      const timestamp = new Date().toISOString();
      logsAccumulator.push({ level, message, timestamp });
    };

    try {
      pushLocalLog("info", "Starting catalogue request to backend...");
      
      // Update unit to indexing-progress
      await setDoc(unitRef, {
        unitCode: newMoodleUnitCode,
        status: "cataloguing",
        cataloguedAt: serverTimestamp(),
        logs: [{ level: "info", message: "Dispatched catalogue job to API proxy server.", timestamp: new Date().toISOString() }]
      }, { merge: true });

      // 1. Call backend to catalogue
      const res = await fetch("/api/moodle/catalogue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unitCode: newMoodleUnitCode }),
      });
      const data = await res.json();

      if (!res.ok) {
        // Backend failure
        const backendError = data.error || "Failed to catalogue unit";
        const backendLogs = data.logs || [];
        
        await setDoc(unitRef, {
          status: "error",
          errorDetail: backendError,
          logs: [...backendLogs, { level: "error", message: `Backend error: ${backendError}`, timestamp: new Date().toISOString() }]
        }, { merge: true });
        
        throw new Error(backendError);
      }

      // Merge backend logs and local logs
      const combinedLogs = [...(data.logs || []), ...logsAccumulator];
      
      await setDoc(unitRef, {
        unitCode: newMoodleUnitCode,
        courseId: data.courseId,
        fullname: data.fullname,
        status: "cataloguing",
        cataloguedAt: serverTimestamp(),
        stats: data.stats || null,
        modulesLog: data.modulesLog || [],
        logs: combinedLogs
      }, { merge: true });

      // 3. Store chunks in Firestore (with embeddings generated on frontend)
      // First, delete old chunks if re-cataloguing
      pushLocalLog("info", "Purging existing indexed chunks for this unit from vector database...");
      const oldChunksQ = query(collection(db, "chunks"), where("unit", "==", newMoodleUnitCode));
      const oldChunksSnap = await getDocs(oldChunksQ);
      
      if (!oldChunksSnap.empty) {
        let batch = writeBatch(db);
        let count = 0;
        for (const d of oldChunksSnap.docs) {
          batch.delete(doc(db, "chunks", d.id));
          count++;
          if (count === 500) {
            await batch.commit();
            batch = writeBatch(db);
            count = 0;
          }
        }
        if (count > 0) await batch.commit();
        pushLocalLog("info", `Successfully purged ${oldChunksSnap.size} outdated chunks.`);
      }

      // Generate embeddings in batches of concurrent requests (concurrency limit = 10)
      const CONCURRENCY_LIMIT = 10;
      const chunksWithEmbeddings: any[] = [];
      const chunkList = data.chunks || [];
      
      pushLocalLog("info", `Starting embeddings generation for ${chunkList.length} text chunks using Gemini Proxy...`);
      // Update intermediate logs
      await setDoc(unitRef, {
        logs: [...combinedLogs, ...logsAccumulator]
      }, { merge: true });

      let embeddingFailures = 0;

      for (let i = 0; i < chunkList.length; i += CONCURRENCY_LIMIT) {
        const batchSlice = chunkList.slice(i, i + CONCURRENCY_LIMIT);
        pushLocalLog("info", `Generating embeddings: processing chunks ${i + 1} to ${Math.min(i + CONCURRENCY_LIMIT, chunkList.length)}...`);
        
        const promises = batchSlice.map(async (chunk: any) => {
          try {
            const embedding = await getEmbeddings(chunk.text);
            return { ...chunk, embedding };
          } catch (error: any) {
            embeddingFailures++;
            pushLocalLog("warning", `Failed to generate embedding for chunk in file "${chunk.fileName}": ${error.message || error}`);
            console.error("Failed to generate embedding for chunk:", chunk, error);
            return null;
          }
        });
        
        // Wait for this slice
        const results = await Promise.all(promises);
        for (const r of results) {
          if (r) chunksWithEmbeddings.push(r);
        }

        // Periodically update progress in Firestore so the user can see realtime progress of embedding generation!
        await setDoc(unitRef, {
          logs: [...combinedLogs, ...logsAccumulator]
        }, { merge: true });
      }

      pushLocalLog("info", `Embeddings complete. Succeeded: ${chunksWithEmbeddings.length}, Failed: ${embeddingFailures}. Initiating bulk upload...`);

      let addBatch = writeBatch(db);
      let addCount = 0;
      for (const chunk of chunksWithEmbeddings) {
        const newDocRef = doc(collection(db, "chunks"));
        addBatch.set(newDocRef, {
          unit: chunk.unit,
          fileName: chunk.fileName,
          text: chunk.text,
          url: chunk.url,
          persona: null,
          embedding: vector(chunk.embedding),
          indexedAt: serverTimestamp(),
        });
        addCount++;
        
        if (addCount === 500) {
          try {
            await addBatch.commit();
          } catch (e) {
            handleFirestoreError(e, OperationType.WRITE, "chunks (batch)");
          }
          addBatch = writeBatch(db);
          addCount = 0;
        }
      }
      if (addCount > 0) {
        try {
          await addBatch.commit();
        } catch (e) {
          handleFirestoreError(e, OperationType.WRITE, "chunks (batch)");
        }
      }

      pushLocalLog("info", `Bulk upload finished. Successfully saved ${chunksWithEmbeddings.length} active chunks into vectors database.`);

      try {
        await updateDoc(unitRef, { 
          status: "completed",
          logs: [...combinedLogs, ...logsAccumulator],
          errorDetail: embeddingFailures > 0 ? `Completed but with ${embeddingFailures} embedding generation failures.` : null
        });
      } catch (e) {
        handleFirestoreError(e, OperationType.UPDATE, "moodleUnits");
      }
      
      showNotification(`Successfully catalogued ${newMoodleUnitCode}`, "success");
      setNewMoodleUnitCode("");
      fetchMoodleUnits();
    } catch (error: any) {
      console.error("Moodle cataloguing error:", error);
      pushLocalLog("error", `Process terminated due to error: ${error.message || error}`);
      
      // Update unit status to error
      try {
        await setDoc(unitRef, {
          status: "error",
          errorDetail: error.message || "Failed during indexing step.",
          logs: [...logsAccumulator]
        }, { merge: true });
      } catch (e) {
        console.error("Error setting error status on unit:", e);
      }

      showNotification(error.message, "error");
      fetchMoodleUnits();
    } finally {
      setIsLoading(false);
    }
  };

  const runMoodleDiagnostic = async () => {
    if (!newMoodleUnitCode) {
      showNotification("Please enter a Unit Code to test against.", "info");
      return;
    }
    setIsLoading(true);
    setMoodleDiagnostic({ auth: null, lookup: null, contents: null, books: null, chapters: null });
    
    try {
      const res = await fetch("/api/moodle/diagnostic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unitCode: newMoodleUnitCode }),
      });
      const data = await res.json();
      setMoodleDiagnostic(data);
    } catch (error: any) {
      setMoodleDiagnostic({ auth: false, lookup: false, contents: false, books: false, chapters: false, error: error.message });
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteMoodleUnit = async (unit: MoodleUnit) => {
    setIsLoading(true);
    try {
      // Delete chunks first
      const q = query(collection(db, "chunks"), where("unit", "==", unit.unitCode));
      const snapshot = await getDocs(q);
      
      // Batch deletion
      if (!snapshot.empty) {
        let batch = writeBatch(db);
        let count = 0;
        for (const d of snapshot.docs) {
          batch.delete(doc(db, "chunks", d.id));
          count++;
          if (count === 500) {
            await batch.commit();
            batch = writeBatch(db);
            count = 0;
          }
        }
        if (count > 0) await batch.commit();
      }
      
      // Delete unit record
      await deleteDoc(doc(db, "moodleUnits", unit.id));
      fetchMoodleUnits();
      showNotification(`Successfully removed ${unit.unitCode}`, "success");
    } catch (error: any) {
      console.error("Error deleting unit:", error);
      try {
        handleFirestoreError(error, OperationType.DELETE, `moodleUnits/${unit.id}`);
      } catch (e: any) {
        showNotification(e.message, "error");
      }
    } finally {
      setIsLoading(false);
      setConfirmDeleteId(null);
    }
  };

  const handleIndexFolder = async (folder: Folder) => {
    if (!tokens) {
      showNotification("Please connect to Google Drive first.", "info");
      return;
    }

    setIsLoading(true);
    await updateDoc(doc(db, "folders", folder.id), { status: "indexing" });
    fetchFolders();

    try {
      console.log("Indexing folder:", folder.folderId, "with tokens:", tokens ? "Present" : "Missing");
      // 1. List files
      const listRes = await fetch("/api/drive/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokens, folderId: folder.folderId }),
      });
      
      const listData = await listRes.json();

      if (!listRes.ok) {
        if (listRes.status === 401) {
          throw new Error("Google Drive session expired. Please click 'Connect Drive' again.");
        }
        throw new Error(listData.details || listData.error || "Failed to list files");
      }

      const files = listData;
      if (!Array.isArray(files)) throw new Error("API returned invalid file list format");

      const allowedMimeTypes = [
        "text/plain",
        "application/pdf",
        "application/vnd.google-apps.document",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ];

      for (const file of files) {
        if (allowedMimeTypes.includes(file.mimeType)) {
          try {
            const contentRes = await fetch("/api/drive/content", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tokens, fileId: file.id }),
            });
            
            if (!contentRes.ok) {
              const errorData = await contentRes.json();
              console.error(`Failed to get content for ${file.name}:`, errorData);
              continue;
            }

            const text = await contentRes.text();
            if (!text || text.trim().length === 0) continue;

            // Chunking
            const chunks = text.match(/[\s\S]{1,1500}/g) || [];
            
            // Generate embeddings in batches of concurrent requests (concurrency limit = 10)
            const CONCURRENCY_LIMIT = 10;
            const chunksWithEmbeddings: any[] = [];
            
            for (let i = 0; i < chunks.length; i += CONCURRENCY_LIMIT) {
              const batchSlice = chunks.slice(i, i + CONCURRENCY_LIMIT);
              const promises = batchSlice.map(async (chunkText: string) => {
                try {
                  const embedding = await getEmbeddings(chunkText);
                  return { text: chunkText, embedding };
                } catch (error) {
                  console.error("Failed to generate embedding for manual chunk:", error);
                  return null;
                }
              });
              
              const results = await Promise.all(promises);
              for (const res of results) {
                if (res) chunksWithEmbeddings.push(res);
              }
            }

            let batch = writeBatch(db);
            let count = 0;
            
            for (const chunk of chunksWithEmbeddings) {
              const newDocRef = doc(collection(db, "chunks"));
              batch.set(newDocRef, {
                folderId: (folder as any).folderId,
                fileId: file.id,
                fileName: file.name,
                text: chunk.text,
                embedding: vector(chunk.embedding),
                unit: (folder as any).unit || null,
                persona: (folder as any).persona || null,
                indexedAt: serverTimestamp(),
              });
              count++;
              
              if (count === 500) {
                await batch.commit();
                batch = writeBatch(db);
                count = 0;
              }
            }
            if (count > 0) await batch.commit();
          } catch (e) {
            console.error(`Error processing file ${file.name}:`, e);
          }
        }
      }

      await updateDoc(doc(db, "folders", folder.id), { 
        status: "completed", 
        indexedAt: serverTimestamp() 
      });
    } catch (error) {
      console.error("Indexing error:", error);
      await updateDoc(doc(db, "folders", folder.id), { status: "error" });
    } finally {
      setIsLoading(false);
      fetchFolders();
    }
  };

  const handleSignOut = async () => {
    await auth.signOut();
    setIsAdmin(false);
    setUser(null);
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-6">
        <Loader2 size={48} className="animate-spin text-oca-verdigris" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-6 text-oca-blue">
        <div className="max-w-md w-full bg-white p-12 rounded-[2.5rem] shadow-2xl border-2 border-oca-blue text-center">
          <div className="flex justify-center mb-8">
            <OCALogo />
          </div>
          <h1 className="text-3xl font-black uppercase tracking-tight mb-4">Admin Portal</h1>
          {user ? (
            <p className="text-gray-500 mb-6 font-medium">Logged in as <span className="text-oca-blue font-bold">{user.email}</span>. Not authorized.</p>
          ) : (
            <p className="text-gray-500 mb-10 font-medium">Access is restricted to authorized OCA administrators only.</p>
          )}
          <button 
            onClick={handleLogin}
            className="w-full py-4 bg-oca-blue text-white rounded-2xl font-black uppercase tracking-widest hover:bg-oca-verdigris transition-all flex items-center justify-center gap-3 active:scale-95 border-2 border-oca-blue-tint"
          >
            <LogIn size={20} />
            {user ? "Try Different Account" : "Sign in with Google"}
          </button>
          <div className="mt-8">
            <Link to="/" className="text-sm font-bold text-oca-verdigris hover:underline uppercase tracking-wide">Back to Landing Page</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 text-oca-blue font-sans">
      <nav className="bg-white border-b-2 border-oca-blue px-6 py-4 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-8">
            <OCALogo />
            <div className="h-8 w-px bg-gray-200 hidden md:block"></div>
            <h1 className="text-sm font-black uppercase tracking-[0.2em] text-oca-verdigris hidden md:block">Portal Admin</h1>
          </div>
          <div className="flex items-center gap-4">
            <Link to="/" className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-gray-600 hover:text-oca-blue transition-colors">
              <ArrowLeft size={16} />
              Exit
            </Link>
            <div className="flex items-center gap-4 pl-4 border-l border-gray-100">
              <div className="flex items-center gap-2 px-4 py-2 bg-oca-blue-tint text-oca-blue rounded-full text-xs font-black uppercase tracking-wider border border-oca-blue">
                <GraduationCap size={16} />
                {user?.email?.split('@')[0]}
              </div>
              <button 
                onClick={handleSignOut}
                className="text-xs font-black uppercase tracking-widest text-gray-400 hover:text-red-600 transition-colors"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-6 py-12">
        <header className="mb-12 flex items-center justify-between">
          <div>
            <Link to="/" className="text-oca-verdigris hover:text-oca-blue flex items-center gap-2 text-xs font-black uppercase tracking-widest mb-4">
              <ArrowLeft size={14} />
              Back to Site
            </Link>
            <h1 className="text-4xl font-black uppercase tracking-tight text-oca-blue mb-2">Knowledge Base</h1>
            <p className="text-gray-500 font-medium">Manage Google Drive folders and index documents for the OCA chatbot.</p>
          </div>
          <button 
            onClick={handleConnectDrive}
            className={cn("px-8 py-4 rounded-2xl font-black uppercase tracking-widest flex items-center gap-3 transition-all shadow-lg active:scale-95 border-2", 
              tokens ? "bg-white text-oca-verdigris border-oca-verdigris" : "bg-oca-blue text-white border-oca-blue-tint hover:bg-oca-verdigris")}
          >
            {tokens ? <CheckCircle size={20} /> : <ExternalLink size={20} />}
            {tokens ? "Drive Connected" : "Connect Drive"}
          </button>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Add Folder Form */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-[2rem] shadow-sm border-2 border-oca-blue p-8">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-oca-blue-tint flex items-center justify-center text-oca-blue border border-oca-blue">
                  <FolderPlus size={20} />
                </div>
                <div>
                  <h2 className="text-xl font-black uppercase tracking-tight">Add Folder</h2>
                  <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">Knowledge Base</p>
                </div>
              </div>
              <div className="space-y-6">
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2 ml-1">Folder Name</label>
                  <input 
                    type="text" 
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    placeholder="e.g. Policies & Guidance"
                    className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:ring-2 focus:ring-oca-blue focus:border-oca-blue outline-none transition-all font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2 ml-1">GDrive Folder ID</label>
                  <input 
                    type="text" 
                    value={newFolderId}
                    onChange={(e) => setNewFolderId(e.target.value)}
                    placeholder="1abc123..."
                    className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:ring-2 focus:ring-oca-blue focus:border-oca-blue outline-none transition-all font-mono text-sm"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2 ml-1">Unit Context (Optional)</label>
                  <input 
                    type="text" 
                    value={newFolderUnit}
                    onChange={(e) => setNewFolderUnit(e.target.value)}
                    placeholder="e.g. GD101"
                    className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:ring-2 focus:ring-oca-blue focus:border-oca-blue outline-none transition-all font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2 ml-1">Persona Scope (Optional)</label>
                  <select 
                    value={newFolderPersona}
                    onChange={(e) => setNewFolderPersona(e.target.value)}
                    className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:ring-2 focus:ring-oca-blue focus:border-oca-blue outline-none transition-all font-bold"
                  >
                    <option value="">Global / No Persona</option>
                    {personas.map(p => (
                      <option key={p.id} value={p.persona_id}>{p.display_name}</option>
                    ))}
                  </select>
                </div>
                <button 
                  onClick={handleAddFolder}
                  disabled={isLoading || !newFolderId || !newFolderName}
                  className="w-full py-4 bg-oca-blue text-white rounded-2xl font-black uppercase tracking-widest hover:bg-oca-verdigris disabled:opacity-50 transition-all mt-4 shadow-lg active:scale-95 border-2 border-oca-blue-tint"
                >
                  Add to Index List
                </button>
              </div>
            </div>
          </div>

          {/* Folder List */}
          <div className="lg:col-span-2 overflow-x-auto">
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 min-w-[700px]">
              <table className="w-full text-left">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-4 text-sm font-semibold text-gray-700">Folder</th>
                    <th className="px-6 py-4 text-sm font-semibold text-gray-700">Unit</th>
                    <th className="px-6 py-4 text-sm font-semibold text-gray-700">Persona</th>
                    <th className="px-6 py-4 text-sm font-semibold text-gray-700">Citation</th>
                    <th className="px-6 py-4 text-sm font-semibold text-gray-700">Status</th>
                    <th className="px-6 py-4 text-sm font-semibold text-gray-700 min-w-[140px] text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {folders.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                        No folders added yet. Add your first GDrive folder to start indexing.
                      </td>
                    </tr>
                  )}
                  {folders.map((folder) => (
                    <tr key={folder.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4">
                        <div className="font-medium text-gray-900">{folder.name}</div>
                        <div className="text-xs text-gray-400 font-mono truncate max-w-[150px]" title={folder.folderId}>{folder.folderId}</div>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-sm text-gray-600">{folder.unit || "Global"}</span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-sm font-bold text-oca-blue">{(folder as any).persona || "None"}</span>
                      </td>
                      <td className="px-6 py-4">
                        <button
                          onClick={() => handleToggleCitation(folder)}
                          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                            folder.citation !== false ? "bg-oca-verdigris" : "bg-gray-200"
                          }`}
                          title={`Click to ${folder.citation !== false ? "disable" : "enable"} citations of sources from this folder.`}
                        >
                          <span
                            aria-hidden="true"
                            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                              folder.citation !== false ? "translate-x-5" : "translate-x-0"
                            }`}
                          />
                        </button>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <StatusBadge status={folder.status} />
                          {folder.indexedAt && (
                            <span className="text-[10px] text-gray-400">
                              {new Date(folder.indexedAt.seconds * 1000).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center justify-end gap-2">
                          <button 
                            onClick={() => handleViewChunks(folder.unit || null, (folder as any).persona || null)}
                            title="View Chunks"
                            className="p-2 text-oca-blue hover:bg-oca-blue-tint rounded-lg transition-colors border border-transparent hover:border-oca-blue"
                          >
                            <Eye size={18} />
                          </button>
                          <button 
                            onClick={() => handleIndexFolder(folder)}
                            disabled={isLoading || !tokens}
                            title="Index Folder"
                            className="p-2 text-oca-blue hover:bg-oca-blue-tint rounded-lg transition-colors disabled:opacity-30 border border-transparent hover:border-oca-blue"
                          >
                            {isLoading && folder.status === "indexing" ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
                          </button>
                          
                          {confirmDeleteId === folder.id ? (
                            <div className="flex items-center gap-2">
                              <button 
                                onClick={() => handleDeleteFolder(folder)}
                                className="px-2 py-1 bg-red-600 text-white text-[10px] font-bold rounded hover:bg-red-700 transition-colors"
                              >
                                Confirm
                              </button>
                              <button 
                                onClick={() => setConfirmDeleteId(null)}
                                className="px-2 py-1 bg-gray-200 text-gray-600 text-[10px] font-bold rounded hover:bg-gray-300 transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button 
                              onClick={() => setConfirmDeleteId(folder.id)}
                              disabled={isLoading}
                              title="Delete Folder"
                              className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-30"
                            >
                              <Trash2 size={18} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Persona Management Section */}
        <div className="mt-20">
          <div className="flex items-center gap-4 mb-8">
            <div className="w-12 h-12 rounded-2xl bg-oca-blue text-white flex items-center justify-center shadow-lg border-2 border-oca-blue-tint">
              <Bot size={24} />
            </div>
            <div>
              <h2 className="text-2xl font-black uppercase tracking-tight">AI Personas</h2>
              <p className="text-sm text-gray-500 font-medium">Define specific characters, tones, or industry roles for Lumen.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 text-oca-blue">
            {/* Add Persona Form */}
            <div className="lg:col-span-1 space-y-6" id="persona-form-container">
              <div className="bg-white rounded-[2rem] shadow-sm border-2 border-oca-blue p-8">
                <h3 className="text-lg font-black uppercase tracking-tight mb-6 flex items-center gap-2">
                  {editingPersona ? (
                    <Palette size={20} className="text-oca-verdigris" />
                  ) : (
                    <Plus size={20} className="text-oca-verdigris" />
                  )}
                  {editingPersona ? "Edit Persona" : "Create Persona"}
                </h3>
                <div className="space-y-6">
                  <div>
                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2 ml-1">Persona ID (URL Friendly)</label>
                    <input 
                      type="text" 
                      value={newPersonaId}
                      onChange={(e) => setNewPersonaId(e.target.value)}
                      disabled={!!editingPersona} // Handle ID as immutable once created
                      placeholder="e.g. van_gogh"
                      className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:ring-2 focus:ring-oca-blue focus:border-oca-blue outline-none transition-all font-mono disabled:opacity-50"
                    />
                    {editingPersona && (
                      <p className="text-[9px] text-gray-400 mt-1 ml-1">ID cannot be changed after creation.</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2 ml-1">Display Name</label>
                    <input 
                      type="text" 
                      value={newPersonaName}
                      onChange={(e) => setNewPersonaName(e.target.value)}
                      placeholder="e.g. Vincent van Gogh"
                      className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:ring-2 focus:ring-oca-blue focus:border-oca-blue outline-none transition-all font-bold"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2 ml-1">System Prompt / Instructions</label>
                    <textarea 
                      value={newPersonaPrompt}
                      onChange={(e) => setNewPersonaPrompt(e.target.value)}
                      placeholder="Define the persona's tone, focus, and personality..."
                      className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:ring-2 focus:ring-oca-blue focus:border-oca-blue outline-none transition-all font-medium h-32"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2 ml-1">Greeting Message (Optional)</label>
                    <input 
                      type="text" 
                      value={newPersonaGreeting}
                      onChange={(e) => setNewPersonaGreeting(e.target.value)}
                      placeholder="e.g. Welcome to my studio."
                      className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:ring-2 focus:ring-oca-blue focus:border-oca-blue outline-none transition-all font-medium"
                    />
                  </div>
                  <div className="flex gap-3">
                    {editingPersona && (
                      <button 
                        onClick={handleCancelEditPersona}
                        className="flex-1 py-4 bg-gray-100 text-gray-600 rounded-2xl font-black uppercase tracking-widest hover:bg-gray-200 transition-all border-2 border-transparent"
                      >
                        Cancel
                      </button>
                    )}
                    <button 
                      onClick={editingPersona ? handleUpdatePersona : handleAddPersona}
                      disabled={isLoading || !newPersonaId || !newPersonaName || !newPersonaPrompt}
                      className="flex-[2] py-4 bg-oca-blue text-white rounded-2xl font-black uppercase tracking-widest hover:bg-oca-verdigris disabled:opacity-50 transition-all shadow-lg border-2 border-oca-blue-tint flex items-center justify-center gap-2"
                    >
                      {isLoading && <Loader2 size={20} className="animate-spin" />}
                      {isLoading ? "Processing..." : (editingPersona ? "Update Persona" : "Add Persona")}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Persona List */}
            <div className="lg:col-span-2">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                <table className="w-full text-left">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-6 py-4 text-sm font-semibold text-gray-700">Display Name</th>
                      <th className="px-6 py-4 text-sm font-semibold text-gray-700">ID</th>
                      <th className="px-6 py-4 text-sm font-semibold text-gray-700 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {personas.length === 0 && (
                      <tr>
                        <td colSpan={3} className="px-6 py-12 text-center text-gray-500">
                          No personas created yet.
                        </td>
                      </tr>
                    )}
                    {personas.map((persona) => (
                      <tr key={persona.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <div className="font-bold text-oca-blue">{persona.display_name}</div>
                        </td>
                        <td className="px-6 py-4 font-mono text-xs text-gray-400">
                          {persona.persona_id}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex justify-end gap-2">
                            <button 
                              onClick={() => handleStartEditPersona(persona)}
                              className="p-2 text-oca-blue hover:bg-oca-blue-tint rounded-lg transition-colors border border-transparent hover:border-oca-blue"
                              title="Edit Persona"
                            >
                              <Palette size={18} />
                            </button>
                            
                            {confirmDeleteId === persona.id ? (
                              <div className="flex items-center gap-2">
                                <button 
                                  onClick={() => handleDeletePersona(persona.id)}
                                  className="px-2 py-1 bg-red-600 text-white text-[10px] font-bold rounded"
                                >
                                  Confirm
                                </button>
                                <button 
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="px-2 py-1 bg-gray-200 text-gray-600 text-[10px] font-bold rounded"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button 
                                onClick={() => setConfirmDeleteId(persona.id)}
                                className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors border border-transparent hover:border-red-200"
                              >
                                <Trash2 size={18} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        {/* Moodle Cataloguing Section */}
        <div className="mt-20">
          <div className="flex items-center gap-4 mb-8">
            <div className="w-12 h-12 rounded-2xl bg-oca-blue text-white flex items-center justify-center shadow-lg border-2 border-oca-blue-tint">
              <GraduationCap size={24} />
            </div>
            <div>
              <h2 className="text-2xl font-black uppercase tracking-tight">Moodle Course Cataloguing</h2>
              <p className="text-sm text-gray-500 font-medium">Catalogue OCA Learn course units for unit-specific AI knowledge.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 text-oca-blue">
            {/* Add Unit Form */}
            <div className="lg:col-span-1 space-y-6">
              <div className="bg-white rounded-[2rem] shadow-sm border-2 border-oca-blue p-8">
                <h3 className="text-lg font-black uppercase tracking-tight mb-6 flex items-center gap-2">
                  <Plus size={20} className="text-oca-verdigris" />
                  Catalogue Unit
                </h3>
                <div className="space-y-6">
                  <div>
                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2 ml-1">Unit Code</label>
                    <input 
                      type="text" 
                      value={newMoodleUnitCode}
                      onChange={(e) => setNewMoodleUnitCode(e.target.value)}
                      placeholder="e.g. PH4APH0925"
                      className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:ring-2 focus:ring-oca-blue focus:border-oca-blue outline-none transition-all font-bold"
                    />
                  </div>
                  <div className="flex gap-3">
                    <button 
                      onClick={handleCatalogueMoodleUnit}
                      disabled={isLoading || !newMoodleUnitCode}
                      className="flex-1 py-4 bg-oca-blue text-white rounded-2xl font-black uppercase tracking-widest hover:bg-oca-verdigris disabled:opacity-50 transition-all flex items-center justify-center gap-2 shadow-lg active:scale-95 border-2 border-oca-blue-tint"
                    >
                      {isLoading ? <Loader2 size={20} className="animate-spin" /> : <RefreshCw size={20} />}
                      Catalogue
                    </button>
                    <button 
                      onClick={runMoodleDiagnostic}
                      disabled={isLoading || !newMoodleUnitCode}
                      title="Run Diagnostic"
                      className="p-4 bg-gray-100 text-gray-600 rounded-2xl hover:bg-oca-blue-tint hover:text-oca-blue disabled:opacity-50 transition-all border-2 border-transparent hover:border-oca-blue"
                    >
                      <RefreshCw size={20} className={isLoading ? "animate-spin" : ""} />
                    </button>
                  </div>
                </div>
              </div>

              {moodleDiagnostic && (
                <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                  <h3 className="text-sm font-bold mb-4 uppercase tracking-wider text-gray-400">Connection Diagnostic</h3>
                  <div className="space-y-3">
                    <DiagnosticItem label="Token Authentication" status={moodleDiagnostic.auth} />
                    <DiagnosticItem label="Course Lookup" status={moodleDiagnostic.lookup} />
                    <DiagnosticItem label="Content Access" status={moodleDiagnostic.contents} />
                    <DiagnosticItem label="Book Module Detection" status={moodleDiagnostic.books} />
                    <DiagnosticItem label="Book Content Extraction" status={moodleDiagnostic.chapters} />
                  </div>
                  {moodleDiagnostic.error && (
                    <div className="mt-4 p-3 bg-red-50 text-red-600 text-xs rounded-lg border border-red-100">
                      <strong>Error:</strong> {moodleDiagnostic.error}
                    </div>
                  )}
                  {moodleDiagnostic.contents === false && (
                    <div className="mt-4 p-3 bg-amber-50 text-amber-700 text-[10px] rounded-lg border border-amber-100 leading-relaxed">
                      <strong>Fix:</strong> Ask your Moodle Admin to add <code>core_course_get_contents</code> to the Web Service functions.
                    </div>
                  )}
                  {moodleDiagnostic.chapters === false && (
                    <div className="mt-4 p-3 bg-amber-50 text-amber-700 text-[10px] rounded-lg border border-amber-100 leading-relaxed">
                      <strong>Note:</strong> No downloadable HTML content found for books in this course. Lumen will fall back to indexing book descriptions.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Units List */}
            <div className="lg:col-span-2 overflow-x-auto">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 min-w-[700px]">
                <table className="w-full text-left">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-6 py-4 text-sm font-semibold text-gray-700">Unit Code</th>
                      <th className="px-6 py-4 text-sm font-semibold text-gray-700">Course Name</th>
                      <th className="px-6 py-4 text-sm font-semibold text-gray-700">Status</th>
                      <th className="px-6 py-4 text-sm font-semibold text-gray-700 min-w-[140px] text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {moodleUnits.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-6 py-12 text-center text-gray-500">
                          No Moodle units catalogued yet.
                        </td>
                      </tr>
                    )}
                    {moodleUnits.map((unit) => (
                      <tr key={unit.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <div className="font-black text-oca-verdigris uppercase tracking-tight">{unit.unitCode}</div>
                          <div className="text-[10px] text-gray-400 font-mono italic">ID: {unit.courseId}</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="text-sm text-gray-700 line-clamp-1">{unit.fullname}</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <StatusBadge status={unit.status} />
                            {unit.cataloguedAt && (
                              <span className="text-[10px] text-gray-400">
                                {new Date(unit.cataloguedAt.seconds * 1000).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center justify-end gap-2">
                            <button 
                              onClick={() => setSelectedAuditUnit(unit)}
                              title="Indexing Audit Report"
                              className="p-2 text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors border border-transparent hover:border-indigo-200"
                            >
                              <ClipboardList size={18} />
                            </button>
                            <button 
                              onClick={() => handleViewChunks(unit.unitCode)}
                              title="View Chunks"
                              className="p-2 text-oca-blue hover:bg-oca-blue-tint rounded-lg transition-colors border border-transparent hover:border-oca-blue"
                            >
                              <Eye size={18} />
                            </button>
                            {confirmDeleteId === unit.id ? (
                            <div className="flex items-center gap-2">
                              <button 
                                onClick={() => handleDeleteMoodleUnit(unit)}
                                className="px-3 py-1 bg-red-600 text-white text-xs font-bold rounded-lg hover:bg-red-700 transition-colors"
                              >
                                Confirm
                              </button>
                              <button 
                                onClick={() => setConfirmDeleteId(null)}
                                className="px-3 py-1 bg-gray-200 text-gray-600 text-xs font-bold rounded-lg hover:bg-gray-300 transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button 
                              onClick={() => setConfirmDeleteId(unit.id)}
                              disabled={isLoading}
                              className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-30"
                            >
                              <Trash2 size={18} />
                            </button>
                          )}
                        </div>
                      </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        {/* Feedback Themes Section */}
        <div className="mt-12">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center text-indigo-600">
              <Palette size={20} />
            </div>
            <div>
              <h2 className="text-xl font-bold">Creative Feedback Themes</h2>
              <p className="text-sm text-gray-500">Configure custom prompts for different artistic disciplines.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Add Theme Form */}
            <div className="lg:col-span-1">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                  <Plus size={18} className="text-indigo-600" />
                  Add Theme
                </h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Theme Name</label>
                    <input 
                      type="text" 
                      value={newThemeName}
                      onChange={(e) => setNewThemeName(e.target.value)}
                      placeholder="e.g. Photography"
                      className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">System Prompt</label>
                    <textarea 
                      value={newThemePrompt}
                      onChange={(e) => setNewThemePrompt(e.target.value)}
                      placeholder="You are an expert tutor in..."
                      rows={6}
                      className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none text-xs"
                    />
                  </div>
                  <button 
                    onClick={handleAddTheme}
                    disabled={isLoading || !newThemeName || !newThemePrompt}
                    className="w-full py-3 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                  >
                    Save Theme
                  </button>
                </div>
              </div>
            </div>

            {/* Themes List */}
            <div className="lg:col-span-2">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="p-6 border-b border-gray-100">
                  <h3 className="font-bold">Existing Themes</h3>
                </div>
                <div className="divide-y divide-gray-100 max-h-[400px] overflow-y-auto">
                  {themes.length === 0 && (
                    <div className="p-12 text-center text-gray-500">
                      No themes configured yet.
                    </div>
                  )}
                  {themes.map((theme) => (
                    <div key={theme.id} className="p-6 hover:bg-gray-50 transition-colors group">
                      <div className="flex justify-between items-start mb-2">
                        <h4 className="font-bold text-indigo-600">{theme.name}</h4>
                        {confirmDeleteId === theme.id ? (
                          <div className="flex items-center gap-2">
                            <button 
                              onClick={() => handleDeleteTheme(theme.id)}
                              className="px-2 py-1 bg-red-600 text-white text-[10px] font-bold rounded hover:bg-red-700 transition-colors"
                            >
                              Confirm
                            </button>
                            <button 
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-2 py-1 bg-gray-200 text-gray-600 text-[10px] font-bold rounded hover:bg-gray-300 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button 
                            onClick={() => setConfirmDeleteId(theme.id)}
                            disabled={isLoading}
                            className="p-2 text-red-600 opacity-0 group-hover:opacity-100 hover:bg-red-50 rounded-lg transition-all disabled:opacity-30"
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-gray-600 line-clamp-3 leading-relaxed italic">
                        "{theme.prompt}"
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Chunks Modal */}
        <AnimatePresence>
          {isChunksModalOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[80vh] flex flex-col overflow-hidden"
              >
                <div className="p-6 border-b-2 border-oca-blue flex items-center justify-between bg-white text-oca-blue">
                  <div>
                    <h3 className="text-xl font-black uppercase tracking-tight">Knowledge Base Chunks</h3>
                    <p className="text-oca-verdigris text-xs font-black uppercase tracking-widest mt-1">Viewing data for: <span className="font-mono">{viewingUnitCode}</span></p>
                  </div>
                  <button 
                    onClick={() => setIsChunksModalOpen(false)}
                    className="p-2 hover:bg-oca-blue-tint rounded-full transition-colors border-2 border-transparent hover:border-oca-blue"
                  >
                    <X size={24} />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-gray-50">
                  {selectedUnitChunks.length === 0 ? (
                    <div className="text-center py-12 text-gray-500">
                      No chunks found for this unit.
                    </div>
                  ) : (
                    selectedUnitChunks.map((chunk, i) => (
                      <div key={chunk.id} className="bg-white p-5 rounded-3xl border-2 border-oca-blue shadow-sm hover:translate-x-1 transition-transform">
                        <div className="flex items-center justify-between mb-3 pb-3 border-b border-gray-100">
                          <span className="text-[10px] font-black text-oca-verdigris uppercase tracking-widest">Chunk #{i + 1}</span>
                          <div className="flex items-center gap-2">
                            {chunk.url && (
                              <a 
                                href={chunk.url} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="text-[10px] text-oca-blue font-black uppercase tracking-widest hover:underline flex items-center gap-1"
                              >
                                <ExternalLink size={10} />
                                View Source
                              </a>
                            )}
                            <span className="text-[10px] text-gray-400 font-mono italic">{chunk.fileName || "Moodle Content"}</span>
                          </div>
                        </div>
                        <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{chunk.text}</p>
                        {chunk.indexedAt && (
                          <div className="mt-2 pt-2 border-t border-gray-50 text-[9px] text-gray-400 text-right">
                            Indexed: {new Date(chunk.indexedAt.seconds * 1000).toLocaleString()}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
                <div className="p-4 border-t border-gray-100 bg-white flex justify-end">
                  <button 
                    onClick={() => setIsChunksModalOpen(false)}
                    className="px-6 py-2 bg-gray-100 text-gray-600 rounded-xl font-bold hover:bg-gray-200 transition-colors"
                  >
                    Close
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Indexing Audit Report Modal */}
        <AnimatePresence>
          {selectedAuditUnit && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
              <motion.div 
                initial={{ opacity: 0, scale: 0.95, y: 15 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 15 }}
                className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden border-2 border-oca-blue"
              >
                {/* Modal Header */}
                <div className="p-8 border-b-2 border-gray-100 flex items-center justify-between bg-white text-oca-blue">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 shadow-md">
                      <ClipboardList size={24} />
                    </div>
                    <div>
                      <div className="flex items-center gap-3">
                        <h3 className="text-2xl font-black uppercase tracking-tight">Indexing Audit Report</h3>
                        <StatusBadge status={selectedAuditUnit.status} />
                      </div>
                      <p className="text-oca-verdigris text-xs font-black uppercase tracking-widest mt-1">
                        <span className="font-mono bg-gray-50 px-2 py-0.5 rounded border text-gray-700">{selectedAuditUnit.unitCode}</span>
                        <span className="mx-2 text-gray-300">|</span>
                        <span>{selectedAuditUnit.fullname} (ID: {selectedAuditUnit.courseId})</span>
                      </p>
                    </div>
                  </div>
                  <button 
                    onClick={() => { setSelectedAuditUnit(null); setAuditSearchQuery(""); }}
                    className="p-2.5 hover:bg-oca-blue-tint rounded-xl transition-colors border-2 border-transparent hover:border-oca-blue text-oca-blue"
                  >
                    <X size={22} />
                  </button>
                </div>

                {/* Performance & Content Core Statistics Cards */}
                <div className="px-8 pt-6 pb-2 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-4 bg-gray-50/50 border-b border-gray-100">
                  <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm text-center">
                    <div className="text-[10px] font-black uppercase tracking-wider text-gray-400 mb-1">Sections</div>
                    <div className="text-xl font-bold text-gray-700">{selectedAuditUnit.stats?.sectionsCount ?? "N/A"}</div>
                  </div>
                  <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm text-center">
                    <div className="text-[10px] font-black uppercase tracking-wider text-gray-400 mb-1">Total Mods</div>
                    <div className="text-xl font-bold text-gray-700">{selectedAuditUnit.stats?.modulesCount ?? "N/A"}</div>
                  </div>
                  <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm text-center">
                    <div className="text-[10px] font-black uppercase tracking-wider text-gray-400 mb-1">Assignments</div>
                    <div className="text-xl font-bold text-oca-blue font-mono">{selectedAuditUnit.stats?.assignmentsCount ?? "N/A"}</div>
                  </div>
                  <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm text-center">
                    <div className="text-[10px] font-black uppercase tracking-wider text-gray-400 mb-1">Pages</div>
                    <div className="text-xl font-bold text-teal-600 font-mono">{selectedAuditUnit.stats?.pagesCount ?? "N/A"}</div>
                  </div>
                  <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm text-center">
                    <div className="text-[10px] font-black uppercase tracking-wider text-gray-400 mb-1">Books</div>
                    <div className="text-xl font-bold text-amber-600 font-mono">{selectedAuditUnit.stats?.booksCount ?? "N/A"}</div>
                  </div>
                  <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm text-center">
                    <div className="text-[10px] font-black uppercase tracking-wider text-gray-400 mb-1">SCORMs</div>
                    <div className="text-xl font-bold text-pink-600 font-mono">{selectedAuditUnit.stats?.scormsCount ?? "N/A"}</div>
                  </div>
                  <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm text-center col-span-2 sm:col-span-1">
                    <div className="text-[10px] font-black uppercase tracking-wider text-gray-400 mb-1">Labels</div>
                    <div className="text-xl font-bold text-purple-600 font-mono">{selectedAuditUnit.stats?.labelsCount ?? "N/A"}</div>
                  </div>
                </div>

                {/* Tabs & Search controls */}
                <div className="px-8 py-4 border-b border-gray-100 bg-white flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div className="flex bg-gray-100 p-1 rounded-xl w-full sm:w-auto">
                    <button 
                      onClick={() => setActiveAuditTab("checklist")}
                      className={`flex-1 sm:flex-none px-5 py-2 text-xs font-black uppercase tracking-wider rounded-lg transition-all flex items-center justify-center gap-2 ${activeAuditTab === "checklist" ? "bg-white text-indigo-600 shadow-sm border border-gray-200" : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"}`}
                    >
                      <CheckCircle size={14} />
                      Content Checklist
                    </button>
                    <button 
                      onClick={() => setActiveAuditTab("logs")}
                      className={`flex-1 sm:flex-none px-5 py-2 text-xs font-black uppercase tracking-wider rounded-lg transition-all flex items-center justify-center gap-2 ${activeAuditTab === "logs" ? "bg-white text-indigo-600 shadow-sm border border-gray-200" : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"}`}
                    >
                      <Activity size={14} />
                      Trace Logging Console
                    </button>
                  </div>

                  {activeAuditTab === "checklist" && (
                    <div className="relative w-full sm:w-72">
                      <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
                      <input 
                        type="text" 
                        value={auditSearchQuery}
                        onChange={(e) => setAuditSearchQuery(e.target.value)}
                        placeholder="Search modules..."
                        className="w-full pl-10 pr-4 py-2.5 bg-gray-50 hover:bg-gray-100/70 border border-gray-200 focus:border-oca-blue focus:bg-white rounded-xl text-xs font-semibold outline-none transition-all text-gray-700"
                      />
                    </div>
                  )}
                </div>

                {/* Tab Material Window */}
                <div className="flex-1 overflow-y-auto p-8 bg-gray-50/50">
                  {selectedAuditUnit.status === "error" && selectedAuditUnit.errorDetail && (
                    <div className="mb-6 p-4 bg-red-50 border-2 border-red-100 rounded-2xl flex items-start gap-3 text-red-700">
                      <AlertTriangle size={20} className="shrink-0 mt-0.5 text-red-500" />
                      <div>
                        <h4 className="text-sm font-black uppercase tracking-wider">Fatal Indexing Error Encountered</h4>
                        <p className="text-xs mt-1 font-mono leading-relaxed">{selectedAuditUnit.errorDetail}</p>
                      </div>
                    </div>
                  )}

                  {activeAuditTab === "checklist" ? (
                    <div className="space-y-3">
                      {!selectedAuditUnit.modulesLog || selectedAuditUnit.modulesLog.length === 0 ? (
                        <div className="text-center py-16 bg-white rounded-3xl border border-gray-200/60 p-6">
                          <BookOpen size={40} className="mx-auto text-gray-300 mb-2.5" />
                          <h4 className="text-sm font-black uppercase tracking-wide text-gray-400">No Checklist Metadata Available</h4>
                          <p className="text-xs text-gray-400 mt-2 max-w-md mx-auto leading-relaxed">
                            This unit was either catalogued in an older version, or the index process crashed before completing metadata check-ins. Re-run indexing to view individual elements.
                          </p>
                        </div>
                      ) : (
                        (() => {
                          const filtered = selectedAuditUnit.modulesLog.filter(m => 
                            m.name.toLowerCase().includes(auditSearchQuery.toLowerCase()) ||
                            m.type.toLowerCase().includes(auditSearchQuery.toLowerCase()) ||
                            m.details.toLowerCase().includes(auditSearchQuery.toLowerCase())
                          );

                          if (filtered.length === 0) {
                            return (
                              <div className="text-center py-12 text-xs text-gray-400 font-bold">
                                No modules matched your search filter "{auditSearchQuery}".
                              </div>
                            );
                          }

                          return filtered.map((moduleItem, i) => (
                            <div key={i} className="bg-white p-5 rounded-2xl border border-gray-100 shadow-sm flex items-start justify-between gap-4 hover:translate-x-1 transition-all">
                              <div className="flex items-start gap-4">
                                <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                                  moduleItem.status === "success" ? "bg-emerald-50 text-emerald-600 border border-emerald-100" :
                                  moduleItem.status === "warning" ? "bg-amber-50 text-amber-600 border border-amber-100" :
                                  "bg-red-50 text-red-600 border border-red-100"
                                }`}>
                                  {moduleItem.status === "success" ? <CheckCircle size={16} /> :
                                   moduleItem.status === "warning" ? <AlertTriangle size={16} /> :
                                   <AlertCircle size={16} />}
                                </div>
                                <div className="text-left">
                                  <div className="flex items-center gap-2.5 flex-wrap">
                                    <h4 className="text-sm font-bold text-gray-800 leading-tight">{moduleItem.name}</h4>
                                    <span className="px-2 py-0.5 bg-gray-100 border border-gray-200 text-[9px] font-black uppercase tracking-widest text-gray-500 rounded-md font-mono shrink-0">
                                      {moduleItem.type}
                                    </span>
                                  </div>
                                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">{moduleItem.details}</p>
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <div className="text-xs font-black text-indigo-600 font-mono tracking-tight">
                                  {moduleItem.chunksCount} {moduleItem.chunksCount === 1 ? "chunk" : "chunks"}
                                </div>
                                <div className="text-[10px] text-gray-400 mt-1 font-bold">Generated</div>
                              </div>
                            </div>
                          ));
                        })()
                      )}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {!selectedAuditUnit.logs || selectedAuditUnit.logs.length === 0 ? (
                        <div className="text-center py-16 bg-white rounded-3xl border border-gray-200/60 p-6">
                          <Activity size={40} className="mx-auto text-gray-300 mb-2.5" />
                          <h4 className="text-sm font-black uppercase tracking-wide text-gray-400">No Trace Logs Available</h4>
                          <p className="text-xs text-gray-400 mt-2 max-w-md mx-auto leading-relaxed">
                            This unit has no system logging traces saved. Re-run indexing to generate detailed diagnostics logs.
                          </p>
                        </div>
                      ) : (
                        <div className="bg-slate-900 text-slate-100 p-6 rounded-2xl border-2 border-slate-800 shadow-inner font-mono text-xs overflow-x-auto select-text">
                          <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-800">
                            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
                              System Diagnostics Trace Console
                            </span>
                            <button 
                              onClick={() => {
                                const output = selectedAuditUnit.logs?.map(l => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`).join("\n") || "";
                                navigator.clipboard.writeText(output);
                                showNotification("Trace logs copied to clipboard!", "success");
                              }}
                              className="px-2.5 py-1 bg-slate-800 border border-slate-700 text-slate-300 hover:text-white rounded-md text-[10px] font-black uppercase tracking-wider transition-colors hover:bg-slate-700"
                            >
                              Copy Trace
                            </button>
                          </div>
                          <div className="max-h-[35vh] overflow-y-auto space-y-2 pr-2 text-left">
                            {selectedAuditUnit.logs.map((logItem, logIndex) => (
                              <div key={logIndex} className="flex gap-4 items-start py-0.5 hover:bg-slate-800/40 rounded transition-colors px-1">
                                <span className="text-slate-500 select-none text-[10px] font-mono whitespace-nowrap mt-0.5">
                                  {new Date(logItem.timestamp).toLocaleTimeString()}
                                </span>
                                <span className={`font-black select-none text-[10px] uppercase w-16 text-center rounded text-white shrink-0 py-0.5 ${
                                  logItem.level === "error" ? "bg-red-500/80" :
                                  logItem.level === "warning" ? "bg-amber-500/80 text-slate-950" :
                                  "bg-slate-700/80 text-slate-300"
                                }`}>
                                  {logItem.level}
                                </span>
                                <span className={`leading-relaxed break-all ${
                                  logItem.level === "error" ? "text-red-400 font-bold" :
                                  logItem.level === "warning" ? "text-amber-400" :
                                  "text-slate-300"
                                }`}>
                                  {logItem.message}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Modal Footer */}
                <div className="p-6 border-t border-gray-100 bg-white flex justify-between items-center bg-gray-50/50">
                  <div className="text-[10px] font-bold text-gray-400 flex items-center gap-2 text-left">
                    <CheckCircle size={12} className="text-gray-400" />
                    <span>Double-check that all Assignments, Books, Pages and Labels are processed cleanly.</span>
                  </div>
                  <button 
                    onClick={() => { setSelectedAuditUnit(null); setAuditSearchQuery(""); }}
                    className="px-6 py-2 bg-gray-100 text-gray-600 rounded-xl font-bold hover:bg-gray-200 transition-colors"
                  >
                    Close Report
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Global Settings Section */}
        <div className="mt-12 bg-white rounded-[2.5rem] shadow-sm border-2 border-oca-blue p-8">
          <div className="flex items-center gap-4 mb-8">
            <div className="w-12 h-12 rounded-2xl bg-oca-verdigris text-white flex items-center justify-center shadow-lg border-2 border-white/20">
              <AlertCircle size={24} />
            </div>
            <div>
              <h2 className="text-2xl font-black uppercase tracking-tight">Global Usage Control</h2>
              <p className="text-sm text-gray-500 font-medium">Monitor and restrict the total daily message volume for Lumen.</p>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
            <div className="space-y-6">
              <div className="bg-gray-50 rounded-2xl p-6 border-2 border-gray-100">
                <div className="flex justify-between items-center mb-4">
                  <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">Current Daily Usage</span>
                  <span className="text-xs font-black bg-white px-2 py-1 rounded-lg border border-gray-100">
                    {new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}
                  </span>
                </div>
                <div className="flex items-end gap-3">
                  <span className="text-5xl font-black text-oca-blue tracking-tighter">{dailyUsageCount}</span>
                  <span className="text-lg font-bold text-gray-300 mb-1">/ {globalRateLimit} messages</span>
                </div>
                <div className="mt-6 h-3 bg-white rounded-full overflow-hidden border border-gray-100">
                  <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.min(100, (dailyUsageCount / globalRateLimit) * 100)}%` }}
                    className={cn("h-full transition-all rounded-full", 
                      (dailyUsageCount / globalRateLimit) > 0.9 ? "bg-red-500" : 
                      (dailyUsageCount / globalRateLimit) > 0.7 ? "bg-amber-500" : "bg-oca-verdigris")}
                  />
                </div>
                <div className="mt-2 flex justify-between text-[9px] font-black uppercase tracking-widest">
                  <span className="text-gray-400">0</span>
                  <span className={cn((dailyUsageCount / globalRateLimit) > 0.9 ? "text-red-500" : "text-gray-400")}>{globalRateLimit} (Limit)</span>
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3 ml-1">Daily Cap (Messages)</label>
                <div className="flex items-center gap-4">
                  <div className="flex-1 relative">
                    <input 
                      type="number" 
                      value={globalRateLimit}
                      onChange={(e) => setGlobalRateLimit(parseInt(e.target.value) || 0)}
                      className="w-full px-6 py-4 bg-gray-50 border-2 border-gray-100 rounded-2xl focus:ring-2 focus:ring-oca-blue focus:border-oca-blue outline-none transition-all font-black text-xl text-oca-blue"
                    />
                    <div className="absolute right-4 top-1/2 -translate-y-1/2 text-[10px] font-black uppercase tracking-widest text-gray-300">msgs/day</div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <button 
                      onClick={() => handleUpdateRateLimit(globalRateLimit + 10)}
                      className="p-2 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors shadow-sm"
                    >
                      <Plus size={14} />
                    </button>
                    <button 
                      onClick={() => handleUpdateRateLimit(Math.max(10, globalRateLimit - 10))}
                      className="p-2 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors shadow-sm"
                    >
                      <X size={14} className="rotate-45" />
                    </button>
                  </div>
                </div>
              </div>
              <button 
                onClick={() => handleUpdateRateLimit(globalRateLimit)}
                disabled={isUpdatingLimit}
                className="w-full py-5 bg-oca-blue text-white rounded-2xl font-black uppercase tracking-widest hover:bg-oca-verdigris disabled:opacity-50 transition-all shadow-lg active:scale-95 border-2 border-oca-blue-tint flex items-center justify-center gap-3"
              >
                {isUpdatingLimit ? <Loader2 size={24} className="animate-spin" /> : <RefreshCw size={24} />}
                Update Global Limit
              </button>
              <p className="text-[10px] text-gray-400 font-medium text-center">
                This limit applies globally to all users. It resets automatically every day at midnight.
              </p>
            </div>
          </div>
        </div>

        {/* Embed Section */}
        <div className="mt-12 bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 pb-4 border-b border-gray-150">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center text-indigo-600">
                <Code size={20} />
              </div>
              <div>
                <h2 className="text-xl font-bold">Embed Lumen Widgets</h2>
                <p className="text-sm text-gray-500">Copy code to embed Lumen features onto course context pages.</p>
              </div>
            </div>
            
            <div className="flex bg-gray-100 p-1 rounded-xl">
              <button
                onClick={() => setEmbedTab("chat")}
                className={`px-4 py-2 text-xs font-black uppercase tracking-wider rounded-lg transition-all cursor-pointer ${
                  embedTab === "chat"
                    ? "bg-white text-oca-blue shadow-sm"
                    : "text-gray-400 hover:text-gray-600"
                }`}
              >
                Chat Widget
              </button>
              <button
                onClick={() => setEmbedTab("planner")}
                className={`px-4 py-2 text-xs font-black uppercase tracking-wider rounded-lg transition-all cursor-pointer ${
                  embedTab === "planner"
                    ? "bg-white text-oca-blue shadow-sm"
                    : "text-gray-400 hover:text-gray-600"
                }`}
              >
                Study Planner Form
              </button>
            </div>
          </div>
          
          <div className="relative group">
            {embedTab === "chat" ? (
              <>
                <pre className="bg-gray-900 text-gray-300 p-6 rounded-xl text-xs overflow-x-auto font-mono leading-relaxed">
{`<!-- Lumen Chat Widget Embed -->
<script>
  (function() {
    const APP_URL = "${window.location.origin}";
    const iframe = document.createElement('iframe');
    iframe.src = \`\${APP_URL}/widget\`;
    
    // Anti-stretching styles: No transition initially to prevent "stretching up" animation
    const initialStyles = "display:block !important;position:fixed !important;bottom:20px !important;right:20px !important;left:auto !important;width:60px !important;height:60px !important;min-width:60px !important;max-width:60px !important;min-height:60px !important;max-height:60px !important;border:none !important;z-index:2147483647 !important;border-radius:50% !important;box-shadow:0 4px 12px rgba(0,0,0,0.15) !important;overflow:hidden !important;background:transparent !important;margin:0 !important;padding:0 !important;transition:none !important;";
    iframe.style.cssText = initialStyles;
    iframe.allow = "camera; microphone";
    
    document.documentElement.appendChild(iframe);

    window.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'LUMEN_WIDGET_STATE') {
        // Enable transition only after initial load to avoid stretching animation
        iframe.style.setProperty('transition', 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)', 'important');
        
        if (event.data.isOpen) {
          iframe.style.setProperty('width', '400px', 'important');
          iframe.style.setProperty('height', '600px', 'important');
          iframe.style.setProperty('min-width', '400px', 'important');
          iframe.style.setProperty('max-width', '400px', 'important');
          iframe.style.setProperty('min-height', '600px', 'important');
          iframe.style.setProperty('max-height', '600px', 'important');
          iframe.style.setProperty('border-radius', '20px', 'important');
        } else {
          iframe.style.setProperty('width', '60px', 'important');
          iframe.style.setProperty('height', '60px', 'important');
          iframe.style.setProperty('min-width', '60px', 'important');
          iframe.style.setProperty('max-width', '60px', 'important');
          iframe.style.setProperty('min-height', '60px', 'important');
          iframe.style.setProperty('max-height', '60px', 'important');
          iframe.style.setProperty('border-radius', '50%', 'important');
        }
      }
    });
  })();
</script>`}
                </pre>
                <button 
                  onClick={() => {
                    const code = `<!-- Lumen Chat Widget Embed -->
<script>
  (function() {
    const APP_URL = "${window.location.origin}";
    const iframe = document.createElement('iframe');
    iframe.src = \`\${APP_URL}/widget\`;
    
    const initialStyles = "display:block !important;position:fixed !important;bottom:20px !important;right:20px !important;left:auto !important;width:60px !important;height:60px !important;min-width:60px !important;max-width:60px !important;min-height:60px !important;max-height:60px !important;border:none !important;z-index:2147483647 !important;border-radius:50% !important;box-shadow:0 4px 12px rgba(0,0,0,0.15) !important;transition:none !important;overflow:hidden !important;background:transparent !important;margin:0 !important;padding:0 !important;";
    iframe.style.cssText = initialStyles;
    iframe.allow = "camera; microphone";
    
    document.documentElement.appendChild(iframe);

    window.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'LUMEN_WIDGET_STATE') {
        iframe.style.setProperty('transition', 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)', 'important');
        
        if (event.data.isOpen) {
          iframe.style.setProperty('width', '400px', 'important');
          iframe.style.setProperty('height', '600px', 'important');
          iframe.style.setProperty('min-width', '400px', 'important');
          iframe.style.setProperty('max-width', '400px', 'important');
          iframe.style.setProperty('min-height', '600px', 'important');
          iframe.style.setProperty('max-height', '600px', 'important');
          iframe.style.setProperty('border-radius', '20px', 'important');
        } else {
          iframe.style.setProperty('width', '60px', 'important');
          iframe.style.setProperty('height', '60px', 'important');
          iframe.style.setProperty('min-width', '60px', 'important');
          iframe.style.setProperty('max-width', '60px', 'important');
          iframe.style.setProperty('min-height', '60px', 'important');
          iframe.style.setProperty('max-height', '60px', 'important');
          iframe.style.setProperty('border-radius', '50%', 'important');
        }
      }
    });
  })();
</script>`;
                    navigator.clipboard.writeText(code);
                    showNotification("Chat widget embed code copied to clipboard!", "success");
                  }}
                  className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors cursor-pointer"
                >
                  <Copy size={16} />
                </button>
              </>
            ) : (
              <>
                <pre className="bg-gray-900 text-gray-300 p-6 rounded-xl text-xs overflow-x-auto font-mono leading-relaxed">
{`<!-- Lumen Course Study Planner Form Embed -->
<iframe 
  src="${window.location.origin}/widget/planner" 
  width="100%" 
  height="750" 
  style="border:none; border-radius: 20px; box-shadow: 0 4px 20px rgba(6,6,69,0.15); width: 100%; overflow: hidden; background: #ffffff;" 
  allow="camera; microphone"
></iframe>`}
                </pre>
                <button 
                  onClick={() => {
                    const code = `<!-- Lumen Course Study Planner Form Embed -->
<iframe 
  src="${window.location.origin}/widget/planner" 
  width="100%" 
  height="750" 
  style="border:none; border-radius: 20px; box-shadow: 0 4px 20px rgba(6,6,69,0.15); width: 100%; overflow: hidden; background: #ffffff;" 
  allow="camera; microphone"
></iframe>`;
                    navigator.clipboard.writeText(code);
                    showNotification("Study Planner form embed code copied to clipboard!", "success");
                  }}
                  className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors cursor-pointer"
                >
                  <Copy size={16} />
                </button>
              </>
            )}
          </div>
          
          <div className="mt-6 flex items-start gap-3 p-4 bg-amber-50 rounded-xl border border-amber-100">
            <AlertCircle size={18} className="text-amber-600 mt-0.5" />
            <div className="text-xs text-amber-800 leading-relaxed space-y-1">
              <p>
                <strong>Tip:</strong> You can pass a unit context to either widget by appending <code>?unit=YOUR_UNIT</code> to its URL.
              </p>
              {embedTab === "chat" ? (
                <p>
                  Example Chat context: <code>iframe.src = {'`${'}APP_URL{`}/widget?unit=GD101\``};</code>
                </p>
              ) : (
                <p>
                  Example Planner context: <code>iframe.src = "${window.location.origin}/widget/planner?unit=GD101"</code>
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DiagnosticItem({ label, status }: { label: string, status: boolean | null }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-gray-600">{label}</span>
      {status === null ? (
        <div className="w-4 h-4 rounded-full border-2 border-gray-200 border-t-oca-blue animate-spin" />
      ) : status ? (
        <CheckCircle size={16} className="text-green-500" />
      ) : (
        <AlertCircle size={16} className="text-red-500" />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: Folder["status"] | MoodleUnit["status"] }) {
  const styles = {
    pending: "bg-gray-100 text-gray-400",
    indexing: "bg-oca-blue-tint text-oca-blue animate-pulse",
    cataloguing: "bg-oca-blue-tint text-oca-blue animate-pulse",
    completed: "bg-oca-verdigris-tint text-oca-verdigris",
    error: "bg-red-50 text-red-600",
  };
  return (
    <span className={cn("px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-current", (styles as any)[status])}>
      {status}
    </span>
  );
}

function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(" ");
}
