# OCA Digital Design System

## Creative Neobrutalism UI Package

This design system and UI package regulates the digital estate of the **Open College of the Arts (OCA)**. Engineered explicitly for creative higher education, it departs from generic corporate designs to adopt a **"Creative Neobrutalism"** aesthetic—pairing high-contrast geometric layouts, robust outlining (thick strokes), solid drop shadows (no blurs), and delightful pastel tints over deep slate/navy backdrops.

Use this package and documentation to build responsive, consistent, and visually rewarding apps that feel like a natural extension of the OCA brand.

---

## 🎨 1. Palette & Color Token System

The color system is organized into a primary structure and a utility tint structure. It is maintained inside Tailwind CSS using custom variables.

```css
/* Color variables defined in index.css (Tailwind CSS v4 custom theme) */
@theme {
  --color-oca-blue: #060645;
  --color-oca-yellow: #edc84e;
  --color-oca-scarlet: #f17864;
  --color-oca-verdigris: #069170;
  --color-oca-cerulean: #5998d2;
  
  --color-oca-yellow-tint: #fff488;
  --color-oca-pink-tint: #ffcdfe;
  --color-oca-blue-tint: #8cebfe;
  --color-oca-green-tint: #8affd7;
}
```

### Color Specification Chart

| Token Name | HEX | Tailwind Class Name | Primary Usage / Psychological Mapping |
| :--- | :--- | :--- | :--- |
| **OCA Blue** | `#060645` | `bg-oca-blue` / `text-oca-blue` | The master layout container, main text, and high-impact borders. High contrast contrast-check companion. |
| **OCA Yellow** | `#edc84e` | `bg-oca-yellow` | Primary focal point highlighting, special CTA buttons, and interactive tags. |
| **OCA Scarlet** | `#f17864` | `bg-oca-scarlet` | Warning accents, visual breaks, and secondary geometry shapes. |
| **OCA Verdigris** | `#069170` | `bg-oca-verdigris` | Active status tags, successful submissions, and secondary buttons. Includes superb dark readability. |
| **OCA Cerulean** | `#5998d2` | `bg-oca-cerulean` | Calm informative backgrounds, system indicators, and helper tags. |

### Pastel Accent Tints
Tints are used for modular backgrounds ("Bento components"), pill tags, and message bubbles. They provide an injection of warmth and artistic style without causing eye fatigue.

- **OCA Yellow Tint** (`#fff488` | `bg-oca-yellow-tint`): Warm summary panels, planner logs.
- **OCA Pink Tint** (`#ffcdfe` | `bg-oca-pink-tint`): Helpful prompt hints, feedback modules.
- **OCA Blue Tint** (`#8cebfe` | `bg-oca-blue-tint`): User message bubbles, focus controls.
- **OCA Green Tint** (`#8affd7` | `bg-oca-green-tint`): Successful status, companion responses.

---

## ✍️ 2. Typography

The default typography family is **Poppins** (Google Fonts). Poppins provides friendly geometric tracking, thick black uppercase headers with absolute legibility, and balanced spacing.

### Configuration Standard
Ensure other environments import and define Poppins as the primary sans-serif:

```html
<!-- Include Google Font -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;900&display=swap" rel="stylesheet">
```

### Style Hierarchy
- **Master Display Headers**:
  - CSS Classes: `font-black text-6xl md:text-8xl leading-[0.9] tracking-tighter uppercase text-oca-blue`
  - Rule: Pair display headlines with a solid colored keyword block (e.g. `Meet <span class="text-oca-yellow">Lumen</span>`).
- **Section Headers (Bento Cards)**:
  - CSS Classes: `font-black text-2xl lg:text-3xl uppercase tracking-tight text-oca-blue`
- **Body Text**:
  - CSS Classes: `text-sm font-medium leading-relaxed text-oca-blue/80`
- **Data/Pill Tags**:
  - CSS Classes: `text-[10px] font-black uppercase tracking-widest`

---

## 🧱 3. Visual Components Archetypes

To achieve consistent styling across other applications, developers must use standard Neobrutalist layouts:

### A. The Master "Neobrutalist Bento Card"
Containers use thick black borders, generous border radii (`2rem` to `3rem`), and **rigid solid flat drop shadows** (offsets with zero-blur opacity-100 values to represent brutalist depth).

```tsx
// React / Tailwind CSS Blueprint
export const NeobrutalistCard = ({ children, title }) => {
  return (
    <div className="relative bg-white border-2 border-oca-blue rounded-[3rem] shadow-[24px_24px_0px_0px_rgba(6,6,69,0.1)] p-10 overflow-hidden group hover:translate-x-1 hover:translate-y-1 transition-all">
      {title && (
        <h3 className="text-2xl font-black uppercase text-oca-blue tracking-tight mb-4">
          {title}
        </h3>
      )}
      <div className="relative z-10 text-oca-blue">
        {children}
      </div>
    </div>
  );
};
```

### B. High-Contrast Primary CTA Button
Interactive buttons use black borders and a slight **depth translation** animation (`active:scale-95 translate-y-...`) to feel tangible.

```html
<!-- HTML & Tailwind CSS Blueprint -->
<button class="px-8 py-5 bg-oca-verdigris hover:bg-oca-blue text-white rounded-2xl font-black text-lg transition-all border-2 border-oca-blue cursor-pointer shadow-lg active:scale-95">
  GET STARTED
</button>
```

Secondary variant:
```html
<button class="px-8 py-5 bg-oca-yellow text-oca-blue hover:bg-white rounded-2xl font-black text-lg transition-all border-2 border-oca-blue cursor-pointer shadow-md active:scale-95">
  EXPLORE PROJECTS
</button>
```

### C. Standard Form Input Field
Inputs should have clear thick borders instead of modern, hidden-border look-and-feels.

```html
<input 
  type="text" 
  placeholder="Type a creative prompt..." 
  class="w-full px-5 py-4 bg-white border-2 border-oca-blue rounded-2xl text-oca-blue placeholder-oca-blue/40 font-medium focus:outline-none focus:bg-oca-blue-tint/20 transition-all shadow-sm"
/>
```

---

## 🧬 4. Brand Asset: The "Lumen Morphing Gem"

At the heart of the Lumen interface is a custom-animated, vector morphing avatar. It is generated server or client-side dynamically by animating 8 basic geometric form structures over an 8-second continuous sequence with CSS rotations, scales, and colour morphing.

Developers can copy this exact component into other React applications to replicate the official interactive avatar:

```tsx
import React from 'react';
import { Bot } from 'lucide-react'; // Master fallback icon

// 1. Core Color System Mappings
export const OCA_COLORS = {
  cadmium: '#edc84e',
  tintPink: '#ffcdfe',
  scarlet: '#f17864',
  tintGreen: '#8affd7',
  cerulean: '#5998d2',
  tintYellow: '#fff488',
  verdigris: '#069170',
  coreBlue: '#060645',
} as const;

// 2. The Eight SVG Form Configurations
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

// 3. Morphing Avatar Component with CSS Spin Animation
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
```
