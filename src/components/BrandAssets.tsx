import React from 'react';
import { Bot } from 'lucide-react';

export const OCA_COLORS = {
  cadmium: '#edc84e',
  tintPink: '#ffcdfe',
  scarlet: '#f17864',
  tintGreen: '#8affd7',
  cerulean: '#5998d2',
  tintYellow: '#fff488',
  yellow: '#edc84e',
  verdigris: '#069170',
  coreBlue: '#060645',
} as const;

// --- SVG Form Components from guidelines ---
const F_Circle = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 100 100" className={className} fill="currentColor">
    <circle cx="50" cy="50" r="50" />
  </svg>
);

const F_CornerBites = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 100 100" className={className} fill="currentColor">
    <path d="M 25 0 H 75 A 25 25 0 0 1 100 25 V 75 A 25 25 0 0 1 75 100 H 25 A 25 25 0 0 1 0 75 V 25 A 25 25 0 0 1 25 0 Z" />
  </svg>
);

const F_C = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 100 100" className={className} fill="currentColor">
    <path d="M 100,0 H 50 A 50,50 0 0,0 50,100 H 100 Z" />
  </svg>
);

const F_Slant = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 100 100" className={className} fill="currentColor">
    <polygon points="20,0 100,0 100,100 0,100" />
  </svg>
);

const F_Arch = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 100 100" className={className} fill="currentColor">
    <path d="M 0,100 V 50 A 50,50 0 0,1 100,50 V 100 Z" />
  </svg>
);

const F_LeftBite = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 100 100" className={className} fill="currentColor">
    <path d="M 100,0 V 100 H 0 A 50,50 0 0,1 0,0 Z" />
  </svg>
);

const F_A = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 100 100" className={className} fill="currentColor">
    <polygon points="50,0 100,100 0,100" />
  </svg>
);

const F_Bot = ({ className }: { className?: string }) => (
  <Bot className={className} strokeWidth={1.5} />
);

// --- The Custom SVG Avatar Icon ---
export const LumenAvatarIcon = ({ 
  className = "w-full h-full", 
  isThinking = false 
}: { 
  className?: string; 
  isThinking?: boolean;
}) => {
  return (
    <svg 
      className={className}
      viewBox="0 0 100 100" 
      version="1.1" 
      xmlns="http://www.w3.org/2000/svg" 
      xmlnsXlink="http://www.w3.org/1999/xlink" 
      xmlSpace="preserve" 
      style={{
        fillRule: "evenodd",
        clipRule: "evenodd",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }}
    >
      <style>{`
        @keyframes lumen_thinking_pulse {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-4px) scale(1.02); }
        }
        @keyframes lumen_antenna_wiggle {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(8deg); }
        }
      `}</style>
      <g style={isThinking ? { transformOrigin: "50% 50%", animation: "lumen_thinking_pulse 1.5s infinite ease-in-out" } : undefined}>
        {/* Antenna */}
        <path 
          d="M50,33.333l0,-16.667l-16.667,0" 
          fill="none" 
          fillRule="nonzero" 
          stroke="#060645" 
          strokeWidth="6.25"
          style={isThinking ? { transformOrigin: "50% 33px", animation: "lumen_antenna_wiggle 1s infinite ease-in-out" } : undefined}
        />
        {/* Main Head/Body */}
        <path d="M83.333,41.667l0,33.333c0,4.599 -3.734,8.333 -8.333,8.333l-50,0c-4.599,0 -8.333,-3.734 -8.333,-8.333l0,-33.333c0,-4.599 3.734,-8.333 8.333,-8.333l50,0c4.599,0 8.333,3.734 8.333,8.333Z" fill="#edc84e" stroke="#060645" strokeWidth="6.25" />
        {/* Left Ear/Connector */}
        <path d="M8.333,58.333l8.333,0" fill="none" fillRule="nonzero" stroke="#060645" strokeWidth="6.25" />
        {/* Right Ear/Connector */}
        <path d="M83.333,58.333l8.333,0" fill="none" fillRule="nonzero" stroke="#060645" strokeWidth="6.25" />
        {/* Right Eye */}
        <path d="M62.5,54.167l0,8.333" fill="none" fillRule="nonzero" stroke="#060645" strokeWidth="6.25" />
        {/* Left Eye */}
        <path d="M37.5,54.167l0,8.333" fill="none" fillRule="nonzero" stroke="#060645" strokeWidth="6.25" />
      </g>
    </svg>
  );
};

// --- Legacy wrapper for any direct uses of ChatAvatarIcon ---
export const ChatAvatarIcon = ({ size = "base" }: { size?: "sm" | "base" | "lg" }) => {
  return <BotAvatar isThinking={true} size={size} />;
};

// --- Bot Avatar Component ---
export const BotAvatar = ({ isThinking = false, size = "base", className = "" }: { isThinking?: boolean, size?: "sm" | "base" | "lg", className?: string }) => {
  const sizeClasses = {
    sm: "w-8 h-8 rounded-lg",
    base: "w-10 h-10 rounded-xl",
    lg: "w-14 h-14 rounded-2xl",
  };

  const iconClasses = {
    sm: "w-6 h-6",
    base: "w-8 h-8",
    lg: "w-11 h-11",
  };

  const defaultStyles = "bg-white shadow-sm border border-gray-100";
  const hasCustomStyles = className.includes('bg-') || className.includes('shadow-') || className.includes('border-');

  return (
    <div className={cn("relative flex items-center justify-center overflow-hidden shrink-0", sizeClasses[size], !hasCustomStyles && defaultStyles, className)}>
      <LumenAvatarIcon className={`${iconClasses[size]} text-oca-blue`} isThinking={isThinking} />
    </div>
  );
};

// --- Helper for class merging ---
function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(" ");
}

// --- Logo Component ---
export const OCALogo = ({ className, white = false }: { className?: string, white?: boolean }) => {
  return (
    <div className={`flex items-center gap-2 md:gap-3 ${className}`}>
      <img 
        src="https://www.oca.ac.uk/wp-content/uploads/2025/05/OCA_logo3_circ.png" 
        alt="OCA" 
        className="h-8 md:h-12 w-auto" 
        referrerPolicy="no-referrer"
      />
      <div className={`flex flex-col ${white ? 'text-white' : 'text-oca-blue'}`}>
        <span className="text-lg md:text-xl font-black leading-none uppercase tracking-tight">LUMEN</span>
        <span className="text-[8px] md:text-[10px] font-black uppercase tracking-widest mt-0.5 md:mt-1 opacity-70">by The Open College of the Arts</span>
      </div>
    </div>
  );
};

export const OCALogoCircle = ({ className, size = "base" }: { className?: string, size?: "sm" | "base" | "lg" }) => {
  const sizeClasses = {
    sm: "w-8 h-8",
    base: "w-10 h-10",
    lg: "w-14 h-14",
  };

  return (
    <div className={`${sizeClasses[size]} ${className} shrink-0`}>
      <img 
        src="https://www.oca.ac.uk/wp-content/uploads/2025/05/OCA_logo3_circ.png" 
        alt="OCA Logo" 
        className="w-full h-full object-contain rounded-full bg-oca-blue" 
        referrerPolicy="no-referrer"
      />
    </div>
  );
};
