import React, { useEffect, useState } from "react";
import { db, auth, handleFirestoreError, OperationType } from "../firebase";
import { collection, query, where, getDocs, Timestamp, addDoc } from "firebase/firestore";
import { motion, AnimatePresence } from "motion/react";
import { Bot, User, Clock, MessageSquare, ChevronRight, Calendar, ArrowLeft, FileText, Download } from "lucide-react";
import { Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BotAvatar } from "./BrandAssets";
import { jsPDF } from "jspdf";
import { getCachedFile, getMsgTimeKey } from "../lib/mediaCache";
import MediaCarousel from "./MediaCarousel";
import { CitationDot, SourcesFooter, preprocessCitationMarkdown } from "./CitationComponents";

interface HistoryMessage {
  id: string;
  parts: { text: string }[];
  role: "user" | "model";
  createdAt: Timestamp;
  unit: string;
  sources?: any[];
  sessionId?: string;
  files?: { name: string; mimeType: string; data?: string }[];
}

interface StudySchedule {
  id: string;
  userId: string;
  unit: string;
  projectNumber: string;
  weeks: number;
  content: string;
  createdAt: Timestamp;
}

function MessageFilesAndCarousel({ msg, previousMsg }: { msg: HistoryMessage; previousMsg?: HistoryMessage }) {
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

export default function HistoryView() {
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [schedules, setSchedules] = useState<StudySchedule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  
  const [activeTab, setActiveTab] = useState<"chats" | "schedules">("chats");
  
  // Chat navigation states
  const [selectedSessionDate, setSelectedSessionDate] = useState<string | null>(null);
  
  // Study Schedule navigation states
  const [selectedSchedule, setSelectedSchedule] = useState<StudySchedule | null>(null);

  useEffect(() => {
    const fetchHistory = async () => {
      setIsLoading(true);
      try {
        // 1. Fetch Chat History from Firestore if authenticated
        let chatData: HistoryMessage[] = [];
        if (auth.currentUser && !auth.currentUser.isAnonymous) {
          console.log("HistoryView: Fetching chat history for user:", auth.currentUser.uid);
          const qChats = query(
            collection(db, "chat_history"),
            where("userId", "==", auth.currentUser.uid)
          );
          let chatSnapshot;
          try {
            chatSnapshot = await getDocs(qChats);
          } catch (error) {
            handleFirestoreError(error, OperationType.LIST, "chat_history");
            throw error;
          }
          chatData = chatSnapshot.docs
            .map(doc => ({
              id: doc.id,
              ...doc.data()
            } as HistoryMessage));
        }

        chatData.sort((a, b) => {
          const timeA = a.createdAt?.seconds || 0;
          const timeB = b.createdAt?.seconds || 0;
          return timeB - timeA; // Descending
        });
        
        setMessages(chatData);

        // Pre-select most recent chat date if any exist
        const grouped = chatData.reduce((acc, msg) => {
          const date = msg.createdAt?.toDate().toLocaleDateString() || "Unknown Date";
          if (!acc[date]) acc[date] = [];
          acc[date].push(msg);
          return acc;
        }, {} as Record<string, HistoryMessage[]>);
        const datesList = Object.keys(grouped);
        if (datesList.length > 0) {
          setSelectedSessionDate(datesList[0]);
        }

        // 2. Fetch Study Schedules from Firestore if authenticated
        let remoteScheds: StudySchedule[] = [];
        if (auth.currentUser && !auth.currentUser.isAnonymous) {
          console.log("HistoryView: Fetching study schedules for user:", auth.currentUser.uid);
          const qSchedules = query(
            collection(db, "study_schedules"),
            where("userId", "==", auth.currentUser.uid)
          );
          let schedSnapshot;
          try {
            schedSnapshot = await getDocs(qSchedules);
          } catch (error) {
            handleFirestoreError(error, OperationType.LIST, "study_schedules");
            throw error;
          }
          remoteScheds = schedSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          } as StudySchedule));
        }

        // 3. Load Local Storage Schedules fallback
        let localScheds: StudySchedule[] = [];
        try {
          const localData = JSON.parse(localStorage.getItem("lumen_local_schedules") || "[]");
          localScheds = localData.map((item: any) => ({
            id: item.id,
            unit: item.unit,
            projectNumber: item.projectNumber,
            weeks: item.weeks,
            content: item.content,
            createdAt: {
              toDate: () => new Date(item.createdAtStr),
              seconds: Math.floor(new Date(item.createdAtStr).getTime() / 1000)
            } as any
          }));
        } catch (err) {
          console.warn("Could not load schedules from localStorage:", err);
        }

        // Combine and de-duplicate (prefer remote copies, sort by creation date)
        const combinedMap = new Map<string, StudySchedule>();
        remoteScheds.forEach(s => {
          combinedMap.set(`${s.unit}_pro_${s.projectNumber}_${s.weeks}`, s);
        });
        localScheds.forEach(s => {
          const key = `${s.unit}_pro_${s.projectNumber}_${s.weeks}`;
          if (!combinedMap.has(key)) {
            combinedMap.set(key, s);
          }
        });

        // Sync local schedules that aren't on the server yet if logged in with Google
        if (auth.currentUser && !auth.currentUser.isAnonymous) {
          for (const localSched of localScheds) {
            const key = `${localSched.unit}_pro_${localSched.projectNumber}_${localSched.weeks}`;
            const existsInRemote = remoteScheds.some(rs => `${rs.unit}_pro_${rs.projectNumber}_${rs.weeks}` === key);
            if (!existsInRemote) {
              console.log("HistoryView: Syncing local schedule to Firestore:", key);
              try {
                let docRef;
                try {
                  docRef = await addDoc(collection(db, "study_schedules"), {
                    userId: auth.currentUser.uid,
                    unit: localSched.unit,
                    projectNumber: localSched.projectNumber,
                    weeks: localSched.weeks,
                    content: localSched.content,
                    createdAt: Timestamp.now()
                  });
                } catch (error) {
                  handleFirestoreError(error, OperationType.CREATE, "study_schedules");
                  throw error;
                }
                // Update map reference with real remote id
                localSched.id = docRef.id;
                combinedMap.set(key, localSched);
              } catch (syncErr) {
                console.error("Failed to sync local schedule to firestore:", syncErr);
              }
            }
          }
        }

        const schedData = Array.from(combinedMap.values()).sort((a, b) => {
          const timeA = a.createdAt?.seconds || 0;
          const timeB = b.createdAt?.seconds || 0;
          return timeB - timeA; // Descending
        });

        setSchedules(schedData);
        if (schedData.length > 0) {
          setSelectedSchedule(schedData[0]);
        }

      } catch (err: any) {
        console.error("HistoryView: Error fetching history:", err);
      } finally {
        setIsLoading(false);
      }
    };

    const unsubscribe = auth.onAuthStateChanged((user) => {
      fetchHistory();
    });

    return () => unsubscribe();
  }, []);

  // Group messages by date to simulate "sessions"
  const groupedHistory = messages.reduce((acc, msg) => {
    const date = msg.createdAt?.toDate().toLocaleDateString() || "Unknown Date";
    if (!acc[date]) acc[date] = [];
    acc[date].push(msg);
    return acc;
  }, {} as Record<string, HistoryMessage[]>);

  // Ensure messages inside each day's session are sorted chronologically (ascending)
  Object.keys(groupedHistory).forEach((date) => {
    groupedHistory[date].sort((a, b) => {
      const timeA = a.createdAt?.seconds || 0;
      const timeB = b.createdAt?.seconds || 0;
      if (timeA !== timeB) return timeA - timeB;
      const nanoA = a.createdAt?.nanoseconds || 0;
      const nanoB = b.createdAt?.nanoseconds || 0;
      return nanoA - nanoB;
    });
  });

  const dates = Object.keys(groupedHistory);

  const handleSelectDate = (date: string) => {
    setSelectedSessionDate(date);
    const msgs = groupedHistory[date];
    if (msgs && msgs.length > 0) {
      const msgsWithSession = msgs.filter((m: any) => m.sessionId && m.sessionId !== "default");
      const sessionId = msgsWithSession.length > 0 ? msgsWithSession[0].sessionId : null;
      const firstMsg = msgs[0];
      const timestamp = firstMsg.createdAt 
        ? { seconds: firstMsg.createdAt.seconds, nanoseconds: firstMsg.createdAt.nanoseconds } 
        : null;
        
      window.dispatchEvent(new CustomEvent("LUMEN_SELECT_SESSION", {
        detail: {
          date,
          sessionId,
          timestamp
        }
      }));
    }
  };

  const downloadScheduleAsPDF = (schedule: StudySchedule) => {
    try {
      const doc = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4"
      });

      const margin = 20;
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const maxLineWidth = pageWidth - (margin * 2);

      let cursorY = 25;

      doc.setFillColor(6, 6, 69); // #060645 (oca-blue)
      doc.rect(0, 0, pageWidth, 40, "F");

      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(22);
      doc.text("LUMEN STUDY PLANNER", margin, 18);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(200, 200, 255);
      doc.text(`Open College of the Arts • Saved Study Schedule`, margin, 26);

      doc.setFillColor(237, 200, 78); // #edc84e (oca-yellow)
      doc.rect(0, 40, pageWidth, 4, "F");

      cursorY = 55;

      doc.setTextColor(6, 6, 69);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(14);
      doc.text(`Course context: ${schedule.unit || "General (Creative Arts)"}`, margin, cursorY);
      doc.setFontSize(11);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100, 100, 100);
      doc.text(`Project or Part Number: ${schedule.projectNumber}  |  Target Timeline: ${schedule.weeks} Weeks`, margin, cursorY + 6);
      
      cursorY += 18;

      // Strips markdown formatting characters from string safely
      const cleanMarkdown = (text: string): string => {
        return text
          .replace(/\*\*(.*?)\*\*/g, "$1") // Remove bolding markers
          .replace(/__(.*?)__/g, "$1")
          .replace(/\*(.*?)\*/g, "$1")     // Remove italics markers
          .replace(/_(.*?)_/g, "$1")
          .replace(/`/g, "");              // Remove accent/code lines
      };

      const lines = schedule.content.split("\n");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(50, 50, 50);

      doc.setDrawColor(220, 220, 220);
      doc.line(margin, cursorY - 4, pageWidth - margin, cursorY - 4);

      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        let trimmed = line.trim();

        if (trimmed === "") {
          cursorY += 4;
          continue;
        }

        if (cursorY > pageHeight - 25) {
          doc.setFontSize(8);
          doc.setTextColor(150, 150, 150);
          doc.text("Generated by Lumen AI on behalf of Open College of the Arts (OCA)", margin, pageHeight - 10);
          
          doc.addPage();
          cursorY = 25;
          doc.setFontSize(10);
          doc.setTextColor(50, 50, 50);
        }

        // Render Markdown Table block if we hit a table row
        if (trimmed.startsWith("|")) {
          const tableLines: string[] = [];
          while (i < lines.length && lines[i].trim().startsWith("|")) {
            tableLines.push(lines[i].trim());
            i++;
          }
          i--; // offset outer index update

          const parsedRows = tableLines
            .map(tRow => {
              const cells = tRow.split("|").map(col => col.trim());
              if (cells[0] === "") cells.shift();
              if (cells[cells.length - 1] === "") cells.pop();
              return cells;
            })
            .filter(cells => {
              if (cells.length === 0) return false;
              const isSeparator = cells.every(cell => cell.includes("---") || cell.includes(":-"));
              return !isSeparator;
            });

          if (parsedRows.length > 0) {
            const headers = parsedRows[0];
            const dataRows = parsedRows.slice(1);
            const numCols = headers.length;
            const colWidth = maxLineWidth / numCols;

            doc.setFillColor(6, 6, 69);
            doc.setFont("helvetica", "bold");
            doc.setFontSize(9);
            doc.setTextColor(255, 255, 255);

            const wrappedHeaders = headers.map(h => doc.splitTextToSize(cleanMarkdown(h), colWidth - 4));
            const maxHeaderLines = Math.max(...wrappedHeaders.map(lh => lh.length));
            const headerRowHeight = (maxHeaderLines * 4.5) + 6;

            if (cursorY + headerRowHeight > pageHeight - 20) {
              doc.addPage();
              cursorY = 25;
            }

            // Draw header rect
            doc.rect(margin, cursorY - 3, maxLineWidth, headerRowHeight, "F");

            wrappedHeaders.forEach((linesArr, colIdx) => {
              const xPos = margin + (colIdx * colWidth) + 2;
              linesArr.forEach((hLine: string, lIdx: number) => {
                doc.text(hLine, xPos, cursorY + (lIdx * 4.5));
              });
            });

            cursorY += headerRowHeight;

            doc.setFont("helvetica", "normal");
            doc.setFontSize(8.5);
            doc.setTextColor(50, 50, 50);

            dataRows.forEach((rowCells, rIdx) => {
              const wrappedCells = rowCells.map(cell => doc.splitTextToSize(cleanMarkdown(cell), colWidth - 4));
              while (wrappedCells.length < numCols) {
                wrappedCells.push([]);
              }
              const maxCellLines = Math.max(...wrappedCells.map(lc => lc.length));
              const rowHeight = (maxCellLines * 4) + 6;

              if (cursorY + rowHeight > pageHeight - 20) {
                // page break
                doc.setFontSize(8);
                doc.setTextColor(150, 150, 150);
                doc.text("Generated by Lumen AI on behalf of Open College of the Arts (OCA)", margin, pageHeight - 10);
                
                doc.addPage();
                cursorY = 25;

                doc.setFillColor(6, 6, 69);
                doc.rect(margin, cursorY - 3, maxLineWidth, headerRowHeight, "F");
                doc.setFont("helvetica", "bold");
                doc.setTextColor(255, 255, 255);
                wrappedHeaders.forEach((linesArr, colIdx) => {
                  const xPos = margin + (colIdx * colWidth) + 2;
                  linesArr.forEach((hLine: string, lIdx: number) => {
                    doc.text(hLine, xPos, cursorY + (lIdx * 4.5));
                  });
                });
                cursorY += headerRowHeight;
                doc.setFont("helvetica", "normal");
                doc.setFontSize(8.5);
                doc.setTextColor(50, 50, 50);
              }

              if (rIdx % 2 === 0) {
                doc.setFillColor(245, 246, 250);
              } else {
                doc.setFillColor(255, 255, 255);
              }
              doc.rect(margin, cursorY - 3, maxLineWidth, rowHeight, "F");

              // Cell dividers
              doc.setDrawColor(220, 220, 220);
              doc.rect(margin, cursorY - 3, maxLineWidth, rowHeight, "S");
              for (let c = 1; c < numCols; c++) {
                doc.line(margin + (c * colWidth), cursorY - 3, margin + (c * colWidth), cursorY - 3 + rowHeight);
              }

              // Text
              wrappedCells.forEach((linesArr, colIdx) => {
                const xPos = margin + (colIdx * colWidth) + 2;
                linesArr.forEach((cellLine: string, lIdx: number) => {
                  doc.text(cellLine, xPos, cursorY + (lIdx * 4));
                });
              });

              cursorY += rowHeight;
            });

            cursorY += 4;
          }
          continue;
        }

        if (trimmed.startsWith("#")) {
          const headingLevel = (trimmed.match(/^#+/) || ["#"])[0].length;
          const headingText = trimmed.replace(/^#+\s*/, "");
          const size = headingLevel === 1 ? 16 : headingLevel === 2 ? 13 : 11;
          
          doc.setFont("helvetica", "bold");
          doc.setFontSize(size);
          doc.setTextColor(6, 6, 69);
          
          const wrapped = doc.splitTextToSize(cleanMarkdown(headingText), maxLineWidth);
          doc.text(wrapped, margin, cursorY);
          cursorY += (wrapped.length * 6) + 4;
          
          doc.setFont("helvetica", "normal");
          doc.setFontSize(10);
          doc.setTextColor(50, 50, 50);
        } else if (trimmed.startsWith("*") || trimmed.startsWith("-") || trimmed.startsWith("•") || /^\d+\.\s/.test(trimmed)) {
          const isNum = /^\d+\.\s/.test(trimmed);
          let numText = "";
          let itemText = trimmed;

          if (isNum) {
            const numMatch = trimmed.match(/^(\d+\.)\s(.*)/);
            if (numMatch) {
              numText = numMatch[1];
              itemText = numMatch[2];
            }
          } else {
            itemText = trimmed.replace(/^[*•-]\s*/, "");
          }

          doc.setFont("helvetica", "normal");
          doc.setFontSize(10);
          doc.setTextColor(50, 50, 50);

          const indent = 6;
          const bulletX = margin + 2;
          const textX = margin + indent;
          const bulletWidth = maxLineWidth - indent;

          if (isNum) {
            doc.text(numText, bulletX, cursorY);
          } else {
            doc.text("•", bulletX, cursorY);
          }

          const wrappedText = doc.splitTextToSize(cleanMarkdown(itemText), bulletWidth);
          doc.text(wrappedText, textX, cursorY);
          cursorY += (wrappedText.length * 5) + 2;
        } else if (trimmed === "---") {
          doc.setDrawColor(220, 220, 220);
          doc.line(margin, cursorY - 1, pageWidth - margin, cursorY - 1);
          cursorY += 6;
        } else {
          const wrappedText = doc.splitTextToSize(cleanMarkdown(trimmed), maxLineWidth);
          doc.text(wrappedText, margin, cursorY);
          cursorY += (wrappedText.length * 5) + 2;
        }
      }

      // Final Footer
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text("Generated by Lumen AI on behalf of Open College of the Arts (OCA)", margin, pageHeight - 10);

      doc.save(`OCR_Study_Plan_${schedule.unit || "General"}_Proj_${schedule.projectNumber}.pdf`);
    } catch (err) {
      console.error("PDF download from history failed:", err);
      alert("Failed to render PDF.");
    }
  };

  const downloadSessionAsText = (date: string) => {
    const msgs = groupedHistory[date];
    if (!msgs || msgs.length === 0) return;

    let content = "";
    content += "=========================================================================\n";
    content += "                       LUMEN CONVERSATION TRANSCRIPT                     \n";
    content += "=========================================================================\n";
    content += `Session Date  : ${date}\n`;
    content += `Export Date   : ${new Date().toLocaleString()}\n`;
    content += `User Email    : ${auth.currentUser?.email || "Anonymous User"}\n`;
    content += `Total Messages: ${msgs.length}\n`;
    content += "=========================================================================\n\n";

    // Sort ascending for chronological order
    const sortedMsgs = [...msgs].sort((a, b) => {
      const timeSnapshotA = a.createdAt?.seconds || 0;
      const timeSnapshotB = b.createdAt?.seconds || 0;
      if (timeSnapshotA !== timeSnapshotB) return timeSnapshotA - timeSnapshotB;
      const nanoSnapshotA = a.createdAt?.nanoseconds || 0;
      const nanoSnapshotB = b.createdAt?.nanoseconds || 0;
      return nanoSnapshotA - nanoSnapshotB;
    });

    sortedMsgs.forEach((msg, index) => {
      const msgNum = index + 1;
      const roleStr = msg.role === "user" ? "USER" : "LUMEN (AI)";
      const timeStr = msg.createdAt ? msg.createdAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "Unknown Time";
      
      content += `[${msgNum}] ${roleStr} - ${timeStr}\n`;
      content += "-".repeat(`[${msgNum}] ${roleStr} - ${timeStr}`.length) + "\n";
      
      const text = msg.parts?.[0]?.text || "";
      content += `${text}\n\n`;

      if (msg.files && msg.files.length > 0) {
        content += "Attached Files:\n";
        msg.files.forEach((file) => {
          content += `  - ${file.name} (${file.mimeType})\n`;
        });
        content += "\n";
      }

      if (msg.sources && msg.sources.length > 0) {
        content += "Sources Cited:\n";
        msg.sources.forEach((source) => {
          content += `  - ${source.fileName || "Unknown Source"}\n`;
          if (source.text) {
            content += `    Snippet: "${source.text.trim().substring(0, 150)}..."\n`;
          }
          if (source.url) {
            content += `    URL: ${source.url}\n`;
          }
        });
        content += "\n";
      }

      content += "=========================================================================\n\n";
    });

    content += "=========================================================================\n";
    content += "                     Generated by Lumen - OCA Companion                 \n";
    content += "=========================================================================\n";

    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    
    const formattedDate = date.replace(/[\/:]/g, "-");
    link.download = `Lumen_Chat_Session_${formattedDate}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <motion.div 
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
        >
          <Clock className="text-oca-blue w-12 h-12" />
        </motion.div>
      </div>
    );
  }

  if (!auth.currentUser || auth.currentUser.isAnonymous) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6 text-center">
        <div className="max-w-md bg-white p-10 rounded-[2.5rem] border-2 border-oca-blue shadow-2xl">
          <MessageSquare size={64} className="text-oca-yellow mx-auto mb-6" />
          <h2 className="text-3xl font-black uppercase mb-4 tracking-tight">Your History</h2>
          <p className="text-gray-600 mb-8 font-medium">Please log in with your student account to view your past conversations with Lumen.</p>
          <Link to="/" className="inline-block px-10 py-4 bg-oca-blue text-white rounded-2xl font-bold hover:bg-oca-verdigris transition-all active:scale-95 shadow-xl">
            Return Home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-12 gap-6">
          <div>
            <Link to="/" className="flex items-center gap-2 text-oca-blue font-bold uppercase tracking-widest text-xs mb-4 hover:translate-x-1 transition-transform inline-flex">
              <ArrowLeft size={14} /> Back to Hub
            </Link>
            <h1 className="text-5xl font-black uppercase tracking-tighter">Your <span className="text-oca-verdigris">Lumen</span> History</h1>
            <p className="text-gray-500 font-medium mt-2">Revisit your past conversations, feedback sessions, and study schedules with Lumen.</p>
          </div>
          <div className="bg-oca-blue-tint px-6 py-4 rounded-3xl border-2 border-oca-blue w-fit">
             <div className="text-xs font-black text-oca-blue uppercase tracking-widest flex items-center gap-2">
                <Clock size={16} />
                {activeTab === "chats" ? `${messages.length} Messages Recorded` : `${schedules.length} Schedules Saved`}
             </div>
          </div>
        </div>

        {/* Tab Selection */}
        <div className="flex border-2 border-oca-blue rounded-2xl overflow-hidden mb-10 w-fit shadow-[4px_4px_0px_0px_rgba(6,6,69,1)]">
          <button
            onClick={() => setActiveTab("chats")}
            className={`px-6 py-3.5 font-black text-xs uppercase tracking-widest flex items-center gap-2 transition-all cursor-pointer ${
              activeTab === "chats"
                ? "bg-oca-blue text-white"
                : "bg-white text-oca-blue hover:bg-gray-50"
            }`}
          >
            <MessageSquare size={16} />
            Chat Sessions
          </button>
          <button
            onClick={() => setActiveTab("schedules")}
            className={`px-6 py-3.5 font-black text-xs uppercase tracking-widest flex items-center gap-2 transition-all cursor-pointer ${
              activeTab === "schedules"
                ? "bg-oca-blue text-white"
                : "bg-white text-oca-blue hover:bg-gray-50"
            }`}
          >
            <Calendar size={16} />
            Study Planners
          </button>
        </div>

        {/* --- CHATS TAB CONTENT --- */}
        {activeTab === "chats" && (
          dates.length === 0 ? (
            <div className="text-center py-32 bg-gray-50 rounded-[3rem] border-2 border-dashed border-gray-200">
              <Bot size={48} className="mx-auto text-gray-300 mb-4" />
              <p className="text-xl text-gray-500 font-bold uppercase tracking-tight">No conversations found yet.</p>
              <p className="text-gray-400 mt-2">Start a chat via the widget to begin your history.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-10">
              {/* Sidebar with Dates */}
              <div className="lg:col-span-1 space-y-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-oca-blue/40 ml-2 mb-4">Chat Sessions</p>
                <div className="max-h-[600px] overflow-y-auto pr-2 space-y-2">
                  {dates.map(date => (
                    <button
                      key={date}
                      onClick={() => handleSelectDate(date)}
                      className={`w-full text-left p-5 rounded-2xl border-2 transition-all flex items-center justify-between group cursor-pointer ${
                        selectedSessionDate === date 
                          ? "bg-oca-yellow border-oca-blue shadow-[4px_4px_0px_0px_rgba(6,6,69,1)] text-oca-blue" 
                          : "bg-white border-transparent hover:border-oca-blue/10 text-gray-500"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <Calendar size={18} className={selectedSessionDate === date ? "text-oca-blue" : "text-gray-350"} />
                        <span className="font-bold text-sm tracking-tight">{date}</span>
                      </div>
                      <ChevronRight size={16} className={`transition-transform ${selectedSessionDate === date ? "rotate-90" : "group-hover:translate-x-1"}`} />
                    </button>
                  ))}
                </div>
              </div>

              {/* Chat Transcript */}
              <div className="lg:col-span-3">
                <AnimatePresence mode="wait">
                  {selectedSessionDate ? (
                    <motion.div
                      key={selectedSessionDate}
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      className="space-y-6"
                    >
                      <div className="flex items-center justify-between border-b pb-4 mb-8 flex-wrap gap-4">
                         <h2 className="text-xl font-black uppercase tracking-tight">{selectedSessionDate} Transcript</h2>
                         <div className="flex items-center gap-3">
                           <button
                             onClick={() => downloadSessionAsText(selectedSessionDate)}
                             className="px-4 py-2 bg-oca-yellow text-oca-blue hover:bg-white rounded-xl font-black text-xs uppercase tracking-wider flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer shadow-md border-2 border-oca-blue"
                             title="Download this session transcript as a formatted text file"
                           >
                             <Download size={14} />
                             Download Text
                           </button>
                           <span className="px-3 py-1.5 bg-gray-100 rounded-lg text-[10px] font-bold text-gray-500 uppercase tracking-widest leading-none border border-gray-200">
                              {groupedHistory[selectedSessionDate].length} Messages
                           </span>
                         </div>
                      </div>
                      {groupedHistory[selectedSessionDate].map((msg, idx, arr) => (
                        <div 
                          key={msg.id} 
                          className={`flex gap-4 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
                        >
                          <div className="flex-shrink-0 mt-1">
                            {msg.role === "user" ? (
                              <div className="w-8 h-8 rounded-full bg-oca-blue text-white flex items-center justify-center text-xs font-bold border-2 border-white shadow-md">
                                 U
                              </div>
                            ) : (
                              <BotAvatar size="sm" isThinking={false} />
                            )}
                          </div>
                          <div className={`chat-message-bubble max-w-[85%] p-6 rounded-3xl ${
                            msg.role === "user" 
                              ? "bg-oca-blue text-white rounded-tr-none shadow-xl" 
                              : "bg-gray-50 text-gray-800 rounded-tl-none border border-gray-100"
                          }`}>
                            <div className={`prose prose-sm max-w-none ${msg.role === "user" ? "prose-invert" : ""}`}>
                              <ReactMarkdown
                                components={{
                                  a: ({ node, href, children, ...props }) => {
                                    if (href && href.startsWith("#cite-")) {
                                      const num = parseInt(href.replace("#cite-", ""), 10);
                                      const source = msg.sources && msg.sources[num - 1];
                                      return <CitationDot number={num} source={source} inline={true} />;
                                    }
                                    return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
                                  }
                                }}
                              >{preprocessCitationMarkdown(msg.parts[0]?.text || "", msg.sources)}</ReactMarkdown>
                            </div>
                            <SourcesFooter sources={msg.sources} />
                            <MessageFilesAndCarousel msg={msg} previousMsg={idx > 0 ? arr[idx - 1] : undefined} />
                            <div className={`mt-3 text-[10px] font-bold uppercase tracking-widest opacity-40 ${msg.role === "user" ? "text-right" : ""}`}>
                              {msg.createdAt?.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </div>
                          </div>
                        </div>
                      ))}
                    </motion.div>
                  ) : (
                    <div className="h-[400px] flex items-center justify-center bg-gray-50 rounded-[3rem] border-2 border-dashed border-gray-200">
                      <p className="text-gray-400 font-bold uppercase tracking-widest text-sm">Select a date to view transcript</p>
                    </div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          )
        )}

        {/* --- SCHEDULES TAB CONTENT --- */}
        {activeTab === "schedules" && (
          schedules.length === 0 ? (
            <div className="text-center py-32 bg-gray-50 rounded-[3rem] border-2 border-dashed border-gray-200">
              <FileText size={48} className="mx-auto text-gray-300 mb-4" />
              <p className="text-xl text-gray-500 font-bold uppercase tracking-tight">No study schedules generated yet.</p>
              <p className="text-gray-400 mt-2">Go to the Study Planner tool to configure and generate your first timetable!</p>
              <Link to="/study-planner" className="inline-block mt-4 px-6 py-3 bg-oca-blue hover:bg-oca-verdigris text-white rounded-xl font-bold text-xs uppercase tracking-wider border-2 border-oca-blue shadow-md transition-all">
                Launch Study Planner
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-10">
              {/* Sidebar with Schedules */}
              <div className="lg:col-span-1 space-y-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-oca-blue/40 ml-2 mb-4 font-bold">Generated Schedules</p>
                <div className="max-h-[600px] overflow-y-auto pr-2 space-y-2">
                  {schedules.map(sched => (
                    <button
                      key={sched.id}
                      onClick={() => setSelectedSchedule(sched)}
                      className={`w-full text-left p-5 rounded-2xl border-2 transition-all flex items-center justify-between group cursor-pointer ${
                        selectedSchedule?.id === sched.id 
                          ? "bg-oca-yellow border-oca-blue shadow-[4px_4px_0px_0px_rgba(6,6,69,1)] text-oca-blue" 
                          : "bg-white border-transparent hover:border-oca-blue/10 text-gray-500"
                      }`}
                    >
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-extrabold text-[10px] uppercase tracking-wider text-oca-verdigris">Project {sched.projectNumber}</span>
                        </div>
                        <span className="font-black text-xs text-oca-blue">{sched.unit}</span>
                        <span className="text-[9px] text-gray-400 font-bold">{sched.createdAt?.toDate().toLocaleDateString()}</span>
                      </div>
                      <ChevronRight size={16} className={`transition-transform ${selectedSchedule?.id === sched.id ? "rotate-90" : "group-hover:translate-x-1"}`} />
                    </button>
                  ))}
                </div>
              </div>

              {/* Selected Schedule View */}
              <div className="lg:col-span-3">
                <AnimatePresence mode="wait">
                  {selectedSchedule ? (
                    <motion.div
                      key={selectedSchedule.id}
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      className="bg-white border-2 border-oca-blue rounded-[2.5rem] shadow-[8px_8px_0px_0px_rgba(6,6,69,1)] overflow-hidden"
                    >
                      <div className="bg-oca-blue text-white p-6 flex justify-between items-center border-b-2 border-oca-blue">
                        <div className="flex items-center gap-2">
                          <FileText size={18} />
                          <span className="font-black uppercase tracking-wider text-xs">Saved Timetable Report</span>
                        </div>
                        <button
                          onClick={() => downloadScheduleAsPDF(selectedSchedule)}
                          className="p-3 bg-oca-yellow text-oca-blue hover:bg-white rounded-xl font-black text-xs uppercase tracking-wider flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer shadow-md"
                        >
                          <Download size={14} />
                          Download PDF
                        </button>
                      </div>

                      <div className="p-8 max-h-[600px] overflow-y-auto prose max-w-none text-gray-750 font-medium">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ node, ...props }) => <a target="_blank" rel="noopener noreferrer" {...props} />
                          }}
                        >{selectedSchedule.content}</ReactMarkdown>
                      </div>
                    </motion.div>
                  ) : (
                    <div className="h-[400px] flex items-center justify-center bg-gray-50 rounded-[3rem] border-2 border-dashed border-gray-200">
                      <p className="text-gray-400 font-bold uppercase tracking-widest text-sm">Select a saved schedule to display</p>
                    </div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
