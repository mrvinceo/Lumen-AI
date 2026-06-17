import React, { useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { auth, db, handleFirestoreError, OperationType } from "../firebase";
import { collection, addDoc, Timestamp, query, where, getDocs } from "firebase/firestore";
import { GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { searchChunks } from "../lib/vector";
import { motion, AnimatePresence } from "motion/react";
import { Calendar, FileText, Download, ArrowLeft, Loader2, Sparkles, AlertCircle, CheckCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { jsPDF } from "jspdf";

export default function StudyPlanner({ isWidget = false }: { isWidget?: boolean }) {
  const [searchParams] = useSearchParams();
  const unitFromUrl = searchParams.get("unit") || "";
  
  const [unit, setUnit] = useState(unitFromUrl);
  const [projectNumber, setProjectNumber] = useState("1");
  const [weeks, setWeeks] = useState(6);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedReport, setGeneratedReport] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      setIsAuthenticated(!!user && !user.isAnonymous);
    });
    return () => unsubscribe();
  }, []);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsGenerating(true);
    setGeneratedReport(null);
    setStatusMessage(null);

    try {
      let contextText = "";
      const formattedUnit = unit.trim();
      if (formattedUnit) {
        setStatusMessage({ type: "success", text: `Checking if course ${formattedUnit} has been indexed...` });
        
        // Check if the unit is already indexed
        const moodleUnitsRef = collection(db, "moodleUnits");
        const q = query(moodleUnitsRef, where("unitCode", "==", formattedUnit));
        let unitSnapshot;
        try {
          unitSnapshot = await getDocs(q);
        } catch (error) {
          handleFirestoreError(error, OperationType.LIST, "moodleUnits");
          throw error;
        }
        
        let isIndexed = false;
        if (!unitSnapshot.empty) {
          const unitDoc = unitSnapshot.docs[0].data();
          if (unitDoc.status === "completed") {
            isIndexed = true;
          }
        }
        
        if (!isIndexed) {
          setStatusMessage({
            type: "success",
            text: `Course unit ${formattedUnit} has not yet been indexed. Initiating Moodle indexing process, please wait...`
          });
          
          const indexRes = await fetch("/api/moodle/index", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ unitCode: formattedUnit })
          });
          
          if (!indexRes.ok) {
            const indexErr = await indexRes.json();
            throw new Error(`Moodle course indexing failed: ${indexErr.error || "Unknown server error"}`);
          }
          
          const indexData = await indexRes.json();
          console.log("Successfully indexed course on the fly:", indexData);
        }

        setStatusMessage({ type: "success", text: `Gathering information about course unit: ${formattedUnit}...` });
        // Perform vector search for context
        const chunks = await searchChunks(`Project ${projectNumber} outline exercises instructions assignments syllabus`, formattedUnit, 8);
        if (chunks && chunks.length > 0) {
          contextText = chunks.map(c => `Source Document: ${c.fileName}\nContent: ${c.text}`).join("\n\n");
        }
      }

      setStatusMessage({ type: "success", text: "Creating personalized Study Planner report using AI..." });

      const prompt = `You are a helpful and friendly Learner Support assistant for students at the Open College of the Arts. Your job is to create study schedules for students based upon the course content, project number and the amount of time the student has to complete the project in.

Create a study schedule to complete Project ${projectNumber} in ${weeks} weeks. Include all exercises and tasks with word counts and study hours where the information exists. Present as a bulleted list  (Note: where a 'Learning Log' or 'Listening Log' is mentioned, ALWAYS make sure this item is the first in all lists you create).  

In addition, below this, present a table with these exact column headings for: Reading Tasks, Creative Exercises and Research Tasks.

---
Course Unit Code: ${unit || "Not specified"}
Project Target: Project ${projectNumber}
Weeks to Complete: ${weeks} Weeks

${contextText ? `We have located the following official course specifications in our repository to ground your planner:\n\n${contextText}` : "No specific course syllabus files were located. Please generate a highly standard, high-quality, recommended OCA project timeline with typical creative research and exercises at this stage."}
---

The resulting document should be in the form of a report rather than conversational, but should use simple and easy to understand language, explaining any jargon in simple relatable terms. Start with a solid main header '# Study Schedule Report: Project ${projectNumber} (${unit || "General"})' of the report.`;

      // Call server proxy for Gemini
      const res = await fetch("/api/gemini/generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gemini-3.5-flash",
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ]
        })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Generation endpoint failed");
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        throw new Error("Lumen returned an empty report.");
      }

      setGeneratedReport(text);

      // Always save to localStorage as a fallback backup
      try {
        const localSchedules = JSON.parse(localStorage.getItem("lumen_local_schedules") || "[]");
        const newLocalSched = {
          id: "local_" + Date.now(),
          unit: unit || "General",
          projectNumber,
          weeks,
          content: text,
          createdAtStr: new Date().toISOString()
        };
        localSchedules.unshift(newLocalSched);
        localStorage.setItem("lumen_local_schedules", JSON.stringify(localSchedules));
      } catch (err) {
        console.warn("Could not save copy to localStorage:", err);
      }

      // Save to Firebase history if logged in
      if (auth.currentUser && !auth.currentUser.isAnonymous) {
        setStatusMessage({ type: "success", text: "Saving Study Planner to your OCA history..." });
        try {
          await addDoc(collection(db, "study_schedules"), {
            userId: auth.currentUser.uid,
            unit: unit || "General",
            projectNumber,
            weeks,
            content: text,
            createdAt: Timestamp.now()
          });
        } catch (error) {
          handleFirestoreError(error, OperationType.CREATE, "study_schedules");
          throw error;
        }
        setStatusMessage({ type: "success", text: "Generated successfully! Report has been saved to your 'My History' section." });
      } else {
        setStatusMessage({ type: "success", text: "Generated successfully! Report has been saved to this browser's local view (Sign in to back up on server)." });
      }

    } catch (err: any) {
      console.error("Study planner generation failed:", err);
      setStatusMessage({
        type: "error",
        text: `Error generating planner: ${err.message || "Please check network connection and try again."}`
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const downloadPDF = () => {
    if (!generatedReport) return;
    
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

      // Draw beautiful header banner
      doc.setFillColor(6, 6, 69); // #060645 (oca-blue)
      doc.rect(0, 0, pageWidth, 40, "F");

      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(22);
      doc.text("LUMEN STUDY PLANNER", margin, 18);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(200, 200, 255);
      doc.text(`Open College of the Arts • Personal Study Schedule`, margin, 26);

      // Yellow accent strip
      doc.setFillColor(237, 200, 78); // #edc84e (oca-yellow)
      doc.rect(0, 40, pageWidth, 4, "F");

      cursorY = 55;

      doc.setTextColor(6, 6, 69);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(14);
      doc.text(`Course context: ${unit || "General (Creative Arts)"}`, margin, cursorY);
      doc.setFontSize(11);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100, 100, 100);
      doc.text(`Project or Part Number: ${projectNumber}  |  Target Timeline: ${weeks} Weeks`, margin, cursorY + 6);
      
      cursorY += 18;

      // Strips markdown formatting characters from string safely
      const cleanMarkdown = (text: string): string => {
        return text
          .replace(/\*\*(.*?)\*\*/g, "$1") // Remove bolding bold markers
          .replace(/__(.*?)__/g, "$1")
          .replace(/\*(.*?)\*/g, "$1")     // Remove italics markers
          .replace(/_(.*?)_/g, "$1")
          .replace(/`/g, "");              // Remove accent/code lines
      };

      const lines = generatedReport.split("\n");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(50, 50, 50);

      // Add a thin rule
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
          // footer
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

      doc.save(`OCR_Study_Plan_${unit || "General"}_Proj_${projectNumber}.pdf`);
    } catch (err) {
      console.error("PDF generation failed:", err);
      alert("Failed to render PDF. Please copy the text directly or try again.");
    }
  };

  const isFormReadOnly = !!unitFromUrl;

  return (
    <div className={`min-h-screen bg-gray-50/50 ${isWidget ? "py-4 px-4" : "py-12 px-6"}`}>
      <div className="max-w-4xl mx-auto">
        {!isWidget ? (
          <div className="mb-8">
            <Link to="/" className="flex items-center gap-2 text-oca-blue font-bold uppercase tracking-widest text-xs mb-4 hover:translate-x-1 transition-transform inline-flex">
              <ArrowLeft size={14} /> Back to Hub
            </Link>
            <div className="flex items-baseline gap-3">
              <h1 className="text-4xl md:text-5xl font-black uppercase tracking-tighter text-oca-blue">
                Study <span className="text-oca-verdigris">Planner</span>
              </h1>
              <span className="text-[10px] bg-oca-yellow text-oca-blue font-bold py-1 px-2.5 rounded-full uppercase tracking-widest leading-none">
                Lumen Tool
              </span>
            </div>
            <p className="text-gray-500 font-medium mt-1">Get custom day-by-day or week-by-week study timetables for your specific project syllabus.</p>
          </div>
        ) : (
          <div className="mb-6 flex items-baseline gap-3">
            <h1 className="text-2xl md:text-3xl font-black uppercase tracking-tighter text-oca-blue">
              Study <span className="text-oca-verdigris">Planner</span>
            </h1>
            <span className="text-[9px] bg-oca-yellow text-oca-blue font-bold py-1 px-2 rounded-full uppercase tracking-widest leading-none">
              Lumen Widget
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Form Side */}
          <div className="lg:col-span-5 bg-white border-2 border-oca-blue rounded-[2.5rem] p-8 shadow-[8px_8px_0px_0px_rgba(6,6,69,1)]">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-oca-yellow-tint border border-oca-blue flex items-center justify-center">
                <Calendar className="text-oca-blue" size={20} />
              </div>
              <h2 className="text-xl font-black uppercase tracking-tight text-oca-blue">Planner Specs</h2>
            </div>

            <form onSubmit={handleGenerate} className="space-y-6">
              <div>
                <label className="block text-xs font-black uppercase tracking-wider text-oca-blue mb-2">
                  Course Unit Code
                </label>
                <input
                  type="text"
                  placeholder="e.g. PH4APH0925"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  disabled={isFormReadOnly}
                  className={`w-full p-4 rounded-xl border-2 border-oca-blue font-bold text-sm bg-gray-50 focus:outline-none focus:ring-2 focus:ring-oca-verdigris/25 disabled:opacity-75 disabled:cursor-not-allowed`}
                />
                {isFormReadOnly && (
                  <p className="text-[10px] text-gray-400 mt-1.5 font-medium">Locked to current course embedding page.</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-black uppercase tracking-wider text-oca-blue mb-2">
                  Project or Part Number (1-10)
                </label>
                <select
                  value={projectNumber}
                  onChange={(e) => setProjectNumber(e.target.value)}
                  className="w-full p-4 rounded-xl border-2 border-oca-blue font-bold text-sm bg-white focus:outline-none focus:ring-2 focus:ring-oca-verdigris/25"
                >
                  {[...Array(10)].map((_, i) => (
                    <option key={i + 1} value={i + 1}>
                      Project or Part {i + 1}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="flex justify-between items-center mb-2">
                  <label className="text-xs font-black uppercase tracking-wider text-oca-blue">
                    Weeks to Complete
                  </label>
                  <span className="text-xs font-black text-oca-verdigris">{weeks} Weeks</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="20"
                  value={weeks}
                  onChange={(e) => setWeeks(Number(e.target.value))}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-oca-verdigris"
                />
                <div className="flex justify-between text-[10px] text-gray-400 font-bold mt-1">
                  <span>1 Wk</span>
                  <span>10 Wks</span>
                  <span>20 Wks</span>
                </div>
              </div>

              <button
                type="submit"
                disabled={isGenerating}
                className="w-full py-4 bg-oca-blue hover:bg-oca-verdigris text-white font-black text-sm uppercase tracking-wider rounded-2xl border-2 border-oca-blue transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2 shadow-[2px_2px_0px_0px_rgba(6,6,69,1)]"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="animate-spin" size={16} />
                    Generating Report...
                  </>
                ) : (
                  <>
                    <Sparkles size={16} />
                    Build Study Schedule
                  </>
                )}
              </button>
            </form>

            {statusMessage && (
              <div className={`mt-6 p-4 rounded-2xl flex items-start gap-2.5 border-2 text-xs font-semibold ${
                statusMessage.type === "error" 
                  ? "bg-red-50 text-red-700 border-red-200" 
                  : "bg-oca-blue-tint/20 text-oca-blue border-oca-blue/10"
              }`}>
                {statusMessage.type === "error" ? <AlertCircle size={16} className="mt-0.5 flex-shrink-0" /> : <Loader2 size={16} className="mt-0.5 animate-spin text-oca-verdigris flex-shrink-0" />}
                <div>{statusMessage.text}</div>
              </div>
            )}
            
            {!isAuthenticated && !isGenerating && (
              <div className="mt-6 p-5 rounded-2xl bg-oca-yellow-tint border-2 border-oca-blue/20 text-[11px] font-bold text-oca-blue flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <AlertCircle size={16} className="text-oca-blue" />
                  <span>Log in with Google to auto-sync this planner's history across all OCA devices!</span>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const provider = new GoogleAuthProvider();
                      await signInWithPopup(auth, provider);
                    } catch (err) {
                      console.error("Iframe Google SSO failed in Study Planner:", err);
                    }
                  }}
                  className="self-start px-4 py-2 bg-oca-blue hover:bg-oca-verdigris text-white rounded-xl shadow-md font-black uppercase text-[10px] tracking-wider transition-all duration-200 active:scale-95 cursor-pointer border-2 border-oca-blue-tint"
                >
                  Sign In with Google
                </button>
              </div>
            )}
          </div>

          {/* Results Side */}
          <div className="lg:col-span-7 space-y-6">
            <AnimatePresence mode="wait">
              {generatedReport ? (
                <motion.div
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -15 }}
                  className="bg-white border-2 border-oca-blue rounded-[2.5rem] shadow-[8px_8px_0px_0px_rgba(6,6,69,1)] overflow-hidden"
                >
                  <div className="bg-oca-blue text-white p-6 flex justify-between items-center border-b-2 border-oca-blue">
                    <div className="flex items-center gap-2">
                      <FileText size={18} />
                      <span className="font-black uppercase tracking-wider text-xs">Generated Schedule Report</span>
                    </div>
                    <button
                      onClick={downloadPDF}
                      className="p-2.5 bg-oca-yellow text-oca-blue hover:bg-white rounded-xl font-bold text-xs uppercase tracking-wider flex items-center gap-1.5 transition-all active:scale-95"
                      title="Download PDF version"
                    >
                      <Download size={14} />
                      PDF
                    </button>
                  </div>

                  <div className="p-8 max-h-[500px] overflow-y-auto prose max-w-none text-gray-700 font-medium">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ node, ...props }) => <a target="_blank" rel="noopener noreferrer" {...props} />
                      }}
                    >{generatedReport}</ReactMarkdown>
                  </div>
                </motion.div>
              ) : (
                <div className="bg-gray-100/50 border-2 border-dashed border-gray-200 rounded-[2.5rem] py-24 text-center">
                  <FileText className="mx-auto text-gray-300 mb-4" size={48} />
                  <p className="text-sm text-gray-500 font-bold uppercase tracking-wide">Ready to Generate Plan</p>
                  <p className="text-xs text-gray-400 mt-1">Specify your project and timeline to build a report.</p>
                </div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
