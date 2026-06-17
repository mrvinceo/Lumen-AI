/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter as Router, Routes, Route, Link } from "react-router-dom";
import AdminPanel from "./components/AdminPanel";
import ChatWidget from "./components/ChatWidget";
import HistoryView from "./components/HistoryView";
import StudyPlanner from "./components/StudyPlanner";
import { GraduationCap, BookOpen, ShieldCheck, AlertTriangle, Menu, X, History, LogIn, LogOut, User, Calendar } from "lucide-react";
import React, { useState, useEffect } from "react";
import { OCALogo, BotAvatar } from "./components/BrandAssets";
import { motion, AnimatePresence } from "motion/react";
import { auth } from "./firebase";
import { signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, User as FirebaseUser, signInWithCustomToken } from "firebase/auth";

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Lumen Error Boundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-red-50 flex items-center justify-center p-6 text-center">
          <div className="max-w-md bg-white p-8 rounded-2xl shadow-xl border border-red-100">
            <AlertTriangle size={48} className="text-red-500 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Something went wrong</h1>
            <p className="text-gray-600 mb-4">Lumen encountered an unexpected error during startup.</p>
            <pre className="text-xs bg-gray-100 p-4 rounded-lg overflow-auto text-left mb-4 max-h-40">
              {this.state.error?.message}
            </pre>
            <button 
              onClick={() => window.location.reload()}
              className="px-6 py-2 bg-red-600 text-white rounded-xl hover:bg-red-700 transition-colors"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function LandingPage() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [user, setUser] = useState<FirebaseUser | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u && !u.isAnonymous ? u : null);
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

  const handleLogout = async () => {
    try {
      await signOut(auth);
      await fetch("/api/auth/logout", { method: "POST" });
    } catch (err) {
      console.error("Logout failed:", err);
    }
  };

  const navLinks = [
    { name: "Features", href: "#features" },
    { name: "The OCA Website", href: "https://www.oca.ac.uk", external: true },
  ];

  return (
    <div className="min-h-screen bg-white text-oca-blue font-sans selection:bg-oca-blue-tint selection:text-oca-blue">
      <nav className="max-w-7xl mx-auto px-6 py-4 md:py-8 flex items-center justify-between border-b border-gray-100 relative z-[60]">
        <OCALogo />
        
        {/* Desktop Links */}
        <div className="hidden md:flex items-center gap-8 text-sm font-bold uppercase tracking-wider">
          {navLinks.map((link) => (
            <a 
              key={link.name}
              href={link.href} 
              target={link.external ? "_blank" : undefined}
              rel={link.external ? "noopener noreferrer" : undefined}
              className="hover:text-oca-verdigris transition-colors"
            >
              {link.name}
            </a>
          ))}
          
          <div className="flex items-center gap-6 border-l pl-8 border-gray-100">
            <Link to="/study-planner" className="flex items-center gap-2 hover:text-oca-verdigris transition-colors">
              <Calendar size={18} />
              Study Planner
            </Link>

            {user ? (
              <div className="flex items-center gap-6">
                <Link to="/history" className="flex items-center gap-2 hover:text-oca-verdigris transition-colors">
                  <History size={18} />
                  My History
                </Link>
                <div className="flex items-center gap-3 bg-oca-blue-tint px-4 py-2 rounded-full border border-oca-blue/10">
                   <div className="w-6 h-6 rounded-full bg-oca-blue text-white flex items-center justify-center text-[10px] font-black">
                     {user.displayName?.charAt(0) || "U"}
                   </div>
                   <button onClick={handleLogout} className="text-[10px] hover:text-oca-verdigris transition-colors">LOGOUT</button>
                </div>
              </div>
            ) : (
              <button 
                onClick={handleLogin}
                className="flex items-center gap-2 hover:text-oca-verdigris transition-colors"
              >
                <LogIn size={18} />
                Sign In
              </button>
            )}
            
            <Link to="/admin" className="px-6 py-3 bg-oca-blue text-white rounded-full hover:bg-oca-verdigris transition-all shadow-lg hover:shadow-xl active:scale-95 border-2 border-oca-blue-tint">
              Admin Portal
            </Link>
          </div>
        </div>

        {/* Mobile Menu Toggle */}
        <button 
          onClick={() => setIsMenuOpen(!isMenuOpen)}
          className="md:hidden p-2 text-oca-blue hover:bg-gray-100 rounded-lg transition-colors"
          aria-label="Toggle menu"
        >
          {isMenuOpen ? <X size={28} /> : <Menu size={28} />}
        </button>

        {/* Mobile Menu Overlay */}
        <AnimatePresence>
          {isMenuOpen && (
            <motion.div
              initial={{ opacity: 0, y: -20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -20, scale: 0.95 }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="absolute top-full left-6 right-6 mt-4 bg-oca-yellow rounded-3xl shadow-2xl overflow-hidden md:hidden z-50 border-2 border-oca-blue"
            >
              <div className="flex flex-col p-8 gap-6">
                {navLinks.map((link) => (
                  <a 
                    key={link.name}
                    href={link.href} 
                    onClick={() => setIsMenuOpen(false)}
                    target={link.external ? "_blank" : undefined}
                    rel={link.external ? "noopener noreferrer" : undefined}
                    className="text-2xl font-black uppercase tracking-tight text-oca-blue hover:translate-x-2 transition-transform"
                  >
                    {link.name}
                  </a>
                ))}
                
                <Link 
                  to="/study-planner" 
                  onClick={() => setIsMenuOpen(false)}
                  className="flex items-center justify-between group"
                >
                  <span className="text-2xl font-black uppercase tracking-tight text-oca-blue group-hover:translate-x-2 transition-transform">Study Planner</span>
                  <Calendar size={24} />
                </Link>

                {user && (
                   <Link 
                    to="/history" 
                    onClick={() => setIsMenuOpen(false)}
                    className="flex items-center justify-between group"
                  >
                    <span className="text-2xl font-black uppercase tracking-tight text-oca-blue group-hover:translate-x-2 transition-transform">My History</span>
                    <History size={24} />
                  </Link>
                )}

                <div className="h-px bg-oca-blue/10 my-2" />
                
                {user ? (
                   <button 
                    onClick={() => { handleLogout(); setIsMenuOpen(false); }}
                    className="flex items-center justify-between group text-left"
                  >
                    <span className="text-2xl font-black uppercase tracking-tight text-oca-blue group-hover:translate-x-2 transition-transform">Logout</span>
                    <LogOut size={24} />
                  </button>
                ) : (
                  <button 
                    onClick={() => { handleLogin(); setIsMenuOpen(false); }}
                    className="flex items-center justify-between group text-left"
                  >
                    <span className="text-2xl font-black uppercase tracking-tight text-oca-blue group-hover:translate-x-2 transition-transform">Sign In</span>
                    <LogIn size={24} />
                  </button>
                )}

                <Link 
                  to="/admin" 
                  onClick={() => setIsMenuOpen(false)}
                  className="flex items-center justify-between group"
                >
                  <span className="text-2xl font-black uppercase tracking-tight text-oca-blue group-hover:translate-x-2 transition-transform">Admin Portal</span>
                  <div className="p-3 bg-oca-blue text-white rounded-full group-hover:rotate-12 transition-transform">
                    <GraduationCap size={24} />
                  </div>
                </Link>
              </div>
              <div className="bg-oca-blue p-4 text-center">
                <p className="text-[10px] text-white/60 font-black uppercase tracking-[0.2em]">Lumen • Assistant to OCA</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>

      <main className="max-w-7xl mx-auto px-6 pt-20 pb-32">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
          <div className="relative">
            <span className="inline-block px-4 py-1.5 bg-oca-green-tint text-oca-verdigris rounded-full text-xs font-black tracking-widest uppercase mb-6 border border-oca-verdigris">
              Creative Arts AI Assistant
            </span>
            <h1 className="text-6xl lg:text-8xl font-black leading-[0.9] tracking-tighter mb-8 uppercase text-oca-blue">
              Meet <span className="text-oca-yellow">Lumen</span>, <br />your <span className="text-oca-verdigris">creative</span> <br />companion.
            </h1>
            <p className="text-xl text-gray-600 leading-relaxed mb-10 max-w-xl font-medium">
              Lumen is a multimodal AI designed specifically for students of the Open College of the Arts. 
              Built for artistic growth through intelligent feedback and guidance.
            </p>
            <div className="flex items-center gap-4 flex-wrap">
              <button 
                onClick={() => window.dispatchEvent(new CustomEvent('LUMEN_OPEN'))}
                className="px-8 py-5 bg-oca-verdigris text-white rounded-2xl font-black text-lg hover:bg-oca-blue transition-all shadow-2xl hover:shadow-oca-verdigris/20 active:scale-95 border-2 border-oca-blue cursor-pointer"
              >
                Launch Lumen
              </button>
              <Link 
                to="/study-planner" 
                className="px-8 py-5 bg-oca-yellow text-oca-blue border-2 border-oca-blue rounded-2xl font-black text-lg hover:bg-white transition-all active:scale-95 flex items-center justify-center text-center shadow-lg"
              >
                Study Planner
              </Link>
              <a 
                href="https://share.articulate.com/jPJp8dO3WjMsMVVBlx6Xv" 
                target="_blank" 
                rel="noopener noreferrer"
                className="px-8 py-5 bg-white text-oca-blue border-2 border-oca-blue rounded-2xl font-black text-lg hover:bg-oca-blue-tint transition-all active:scale-95 flex items-center justify-center text-center"
              >
                AI Guide
              </a>
            </div>
          </div>
          <div className="relative">
             {/* Decorative brand forms */}
            <div className="absolute -top-12 -right-12 w-32 h-32 bg-oca-scarlet rounded-full opacity-20 blur-2xl"></div>
            <div className="absolute -bottom-12 -left-12 w-48 h-48 bg-oca-yellow rounded-full opacity-20 blur-3xl"></div>
            
            <div className="relative bg-white border-2 border-oca-blue rounded-[3rem] shadow-[24px_24px_0px_0px_rgba(6,6,69,0.1)] p-10 overflow-hidden group">
              <div className="flex items-center gap-5 mb-10">
                <BotAvatar size="lg" isThinking={false} />
                <div>
                  <h3 className="font-black text-2xl uppercase tracking-tight">Lumen Chat</h3>
                  <p className="text-sm text-oca-verdigris font-bold uppercase tracking-widest">Online & Ready</p>
                </div>
              </div>
              <div className="space-y-8">
                <div className="flex gap-4">
                  <BotAvatar size="sm" isThinking={false} />
                  <div className="bg-gray-50 p-5 rounded-3xl rounded-tl-none text-sm font-medium text-gray-700 max-w-[85%] border border-gray-100">
                    Hi! I'm Lumen. I can help you find OCA policies or provide feedback on your latest artwork. What's on your mind?
                  </div>
                </div>
                <div className="flex gap-4 flex-row-reverse">
                  <div className="w-10 h-10 rounded-2xl bg-oca-pink-tint flex items-center justify-center text-oca-blue border-2 border-oca-blue">
                    <GraduationCap size={20} />
                  </div>
                  <div className="bg-oca-blue p-5 rounded-3xl rounded-tr-none text-sm font-medium text-white max-w-[85%] shadow-xl">
                    Can you explain the assessment criteria for Graphic Design 1?
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div id="features" className="mt-48 grid grid-cols-1 md:grid-cols-3 gap-12">
          <FeatureCard 
            icon={<BookOpen size={28} className="text-oca-blue" />}
            title="Knowledge Base"
            description="Lumen indexes your Google Drive folders to provide instant answers from official OCA documents."
            color="oca-yellow-tint"
          />
          <FeatureCard 
            icon={<ShieldCheck size={28} className="text-oca-blue" />}
            title="Policy Expert"
            description="Get accurate information on student guidance, assessment criteria, and college policies."
            color="oca-pink-tint"
          />
          <FeatureCard 
            icon={<BotAvatar size="base" isThinking={false} />}
            title="Creative Tutor"
            description="Upload images or audio files to receive critical, constructive feedback from an AI creative tutor."
            color="oca-green-tint"
          />
        </div>
      </main>

      <footer className="bg-gray-50 py-20 border-t border-gray-100">
        <div className="max-w-7xl mx-auto px-6 text-center">
          <p className="text-gray-500 text-sm">© 2026 Open College of the Arts. Powered by Lumen AI.</p>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, description, color }: { icon: React.ReactNode, title: string, description: string, color: string }) {
  return (
    <div className="p-10 bg-white border-2 border-oca-blue rounded-[2.5rem] shadow-[8px_8px_0px_0px_rgba(6,6,69,0.1)] hover:shadow-[12px_12px_0px_0px_rgba(6,6,69,0.1)] hover:-translate-y-1 transition-all group">
      <div className={`w-16 h-16 rounded-2xl bg-${color} flex items-center justify-center mb-8 border-2 border-oca-blue group-hover:rotate-6 transition-transform`}>
        {icon}
      </div>
      <h3 className="text-2xl font-black uppercase mb-4 tracking-tight">{title}</h3>
      <p className="text-gray-600 leading-relaxed font-medium">{description}</p>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <Router>
        <AppContent />
      </Router>
    </ErrorBoundary>
  );
}

function AppContent() {
  const queryParams = new URLSearchParams(window.location.search);
  const isWidgetRoute = window.location.pathname.startsWith("/widget");
  const isWidgetPlanner = window.location.pathname === "/widget/planner" || 
                          window.location.pathname === "/widget-planner" ||
                          (window.location.pathname === "/widget" && queryParams.get("view") === "planner");
  const isPlannerRoute = window.location.pathname === "/study-planner" || isWidgetPlanner;

  useEffect(() => {
    const syncSession = async () => {
      if (auth.currentUser && !auth.currentUser.isAnonymous) return;
      try {
        const res = await fetch("/api/auth/me");
        if (res.ok) {
          const data = await res.json();
          if (data.customToken) {
            console.log("Embedded sync: Synchronizing Firebase user via Custom Token...");
            await signInWithCustomToken(auth, data.customToken);
            console.log("Embedded sync: Firebase credentials successfully synchronized!");
          }
        }
      } catch (err) {
        console.warn("Auto sign-in synchronization bypassed or skipped:", err);
      }
    };

    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (!user || user.isAnonymous) {
        syncSession();
      }
    });

    return () => unsubscribe();
  }, []);

  return (
    <>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/admin" element={<AdminPanel />} />
        <Route path="/history" element={<HistoryView />} />
        <Route path="/study-planner" element={<StudyPlanner />} />
        <Route path="/widget" element={
          isWidgetPlanner 
            ? <StudyPlanner isWidget={true} /> 
            : <ChatWidget isWidget={true} />
        } />
        <Route path="/widget/planner" element={<StudyPlanner isWidget={true} />} />
        <Route path="/widget-planner" element={<StudyPlanner isWidget={true} />} />
      </Routes>
      {!isWidgetRoute && !isPlannerRoute && <ChatWidget />}
    </>
  );
}
