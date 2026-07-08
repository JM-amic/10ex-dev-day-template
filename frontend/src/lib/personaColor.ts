/**
 * Deterministic persona -> color assignment shared by EnginePersonaPicker and
 * EngineDebateTranscript, so the same debater reads as the same color in both
 * the picker and the live transcript. Tailwind's class scanner needs full
 * literal class strings at build time, so this is a fixed lookup table rather
 * than a template-built class name.
 */

interface PersonaColor {
  avatarBg: string;
  ring: string;
  cardBorder: string;
  cardBg: string;
}

const PALETTE: PersonaColor[] = [
  { avatarBg: 'bg-sky-100', ring: 'ring-sky-400', cardBorder: 'border-sky-300', cardBg: 'bg-sky-50/60' },
  { avatarBg: 'bg-violet-100', ring: 'ring-violet-400', cardBorder: 'border-violet-300', cardBg: 'bg-violet-50/60' },
  { avatarBg: 'bg-rose-100', ring: 'ring-rose-400', cardBorder: 'border-rose-300', cardBg: 'bg-rose-50/60' },
  { avatarBg: 'bg-emerald-100', ring: 'ring-emerald-400', cardBorder: 'border-emerald-300', cardBg: 'bg-emerald-50/60' },
  { avatarBg: 'bg-orange-100', ring: 'ring-orange-400', cardBorder: 'border-orange-300', cardBg: 'bg-orange-50/60' },
  { avatarBg: 'bg-fuchsia-100', ring: 'ring-fuchsia-400', cardBorder: 'border-fuchsia-300', cardBg: 'bg-fuchsia-50/60' },
  { avatarBg: 'bg-teal-100', ring: 'ring-teal-400', cardBorder: 'border-teal-300', cardBg: 'bg-teal-50/60' },
  { avatarBg: 'bg-indigo-100', ring: 'ring-indigo-400', cardBorder: 'border-indigo-300', cardBg: 'bg-indigo-50/60' },
];

export const JUDGE_COLOR: PersonaColor = {
  avatarBg: 'bg-amber-100',
  ring: 'ring-amber-400',
  cardBorder: 'border-amber-300',
  cardBg: 'bg-amber-50/60',
};

export function getPersonaColor(key: string): PersonaColor {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
