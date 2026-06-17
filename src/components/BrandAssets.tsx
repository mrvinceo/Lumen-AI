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

// --- The Animated Icon Component ---
export const ChatAvatarIcon = ({ size = "base" }: { size?: "sm" | "base" | "lg" }) => {
  const sequence = [
    { Form: F_Circle, color: OCA_COLORS.cadmium },
    { Form: F_CornerBites, color: OCA_COLORS.tintPink },
    { Form: F_C, color: OCA_COLORS.scarlet },
    { Form: F_Slant, color: OCA_COLORS.tintGreen },
    { Form: F_Arch, color: OCA_COLORS.cerulean },
    { Form: F_LeftBite, color: OCA_COLORS.tintYellow },
    { Form: F_A, color: OCA_COLORS.verdigris },
    { Form: F_Bot, color: OCA_COLORS.coreBlue },
  ];

  const sizeClasses = {
    sm: "w-8 h-8 rounded-lg",
    base: "w-10 h-10 rounded-xl",
    lg: "w-14 h-14 rounded-2xl",
  };

  const iconClasses = {
    sm: "w-5 h-5",
    base: "w-6 h-6",
    lg: "w-8 h-8",
  };

  return (
    <div className={`relative ${sizeClasses[size]} bg-white flex items-center justify-center shadow-sm overflow-hidden shrink-0`}>
      <style>{`
        @keyframes chat_spin_strict_8 {
          0% { 
            opacity: 0; 
            transform: rotate(-180deg) scale(0); 
            animation-timing-function: cubic-bezier(0.2, 0.8, 0.2, 1);
          }
          1.25% { 
            opacity: 1; 
            transform: rotate(0deg) scale(1); 
          }
          8.75% { 
            opacity: 1; 
            transform: rotate(0deg) scale(1); 
            animation-timing-function: cubic-bezier(0.8, 0.2, 0.8, 1);
          }
          12.5% { 
            opacity: 0; 
            transform: rotate(180deg) scale(0); 
          }
          100% { 
            opacity: 0; 
            transform: rotate(180deg) scale(0); 
          }
        }
      `}</style>

      {sequence.map((item, i) => (
        <div 
          key={i}
          className="absolute inset-0 flex items-center justify-center" 
          style={{ 
            color: item.color,
            opacity: 0, 
            animation: `chat_spin_strict_8 8s infinite ${i}s` 
          }}
        >
          <item.Form className={`${iconClasses[size]} drop-shadow-sm`} />
        </div>
      ))}
    </div>
  );
};

// --- Bot Avatar Component ---
export const BotAvatar = ({ isThinking = false, size = "base", className = "" }: { isThinking?: boolean, size?: "sm" | "base" | "lg", className?: string }) => {
  const sizeClasses = {
    sm: "w-8 h-8 rounded-lg",
    base: "w-10 h-10 rounded-xl",
    lg: "w-14 h-14 rounded-2xl",
  };

  const iconClasses = {
    sm: "w-5 h-5",
    base: "w-6 h-6",
    lg: "w-8 h-8",
  };

  if (isThinking) {
    return <ChatAvatarIcon size={size} />;
  }

  const defaultStyles = "bg-white shadow-sm border border-gray-100";
  const hasCustomStyles = className.includes('bg-') || className.includes('shadow-') || className.includes('border-');

  return (
    <div className={cn("relative flex items-center justify-center overflow-hidden shrink-0", sizeClasses[size], !hasCustomStyles && defaultStyles, className)}>
      <Bot className={`${iconClasses[size]} text-oca-blue drop-shadow-sm`} strokeWidth={1.5} />
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
